const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const SESSION_DIR = process.env.SESSION_DIR || './sessions';

// Ensure the sessions directory exists with secure permissions (chmod 0700)
if (!fs.existsSync(SESSION_DIR)) {
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
    console.log(`Created sessions root directory: ${SESSION_DIR} with secure permissions.`);
  } catch (err) {
    console.error('Error creating sessions root directory:', err.message);
  }
} else {
  try {
    fs.chmodSync(SESSION_DIR, 0o700);
  } catch (err) {
    // Gracefully handle Windows OS where chmod is not supported
  }
}

// Active sessions registry
const sessions = new Map();

/**
 * Trigger webhook notification to ONFIX on logout
 */
function sendWebhookNotification(sessionId, status) {
  const webhookUrl = process.env.ONFIX_WEBHOOK_URL;
  if (!webhookUrl) return;

  const url = require('url');
  let parsedUrl;
  try {
    parsedUrl = new url.URL(webhookUrl);
  } catch (e) {
    console.error(`[Webhook: ${sessionId}] Invalid ONFIX_WEBHOOK_URL:`, webhookUrl);
    return;
  }

  const data = JSON.stringify({
    event: 'session_update',
    sessionId: sessionId.replace(/^\d+_/, ''),
    status: status,
    message: `WhatsApp session '${sessionId.replace(/^\d+_/, '')}' has been logged out and requires scanning QR code.`,
    timestamp: new Date().toISOString()
  });

  const protocol = parsedUrl.protocol === 'https:' ? require('https') : require('http');
  const req = protocol.request({
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  }, (res) => {
    console.log(`[Webhook: ${sessionId}] Notification sent to ONFIX. Status code: ${res.statusCode}`);
  });

  req.on('error', (err) => {
    console.error(`[Webhook: ${sessionId}] Failed to send notification to ONFIX:`, err.message);
  });

  req.write(data);
  req.end();
}

/**
 * Get the status of all active sessions
 * @returns {Array<{id: string, status: string, qr: string|null}>}
 */
function getAllSessionsStatus() {
  const list = [];
  for (const [id, data] of sessions.entries()) {
    list.push({
      id: id,
      status: data.status,
      qr: data.qr
    });
  }
  return list;
}

/**
 * Initializes a WhatsApp session by ID
 * @param {string} sessionId 
 * @param {object} io - Socket.io instance
 * @returns {Promise<object>} session details
 */
async function initSession(sessionId, io = null, forceRestart = false) {
  // If session already exists, manage transition
  if (sessions.has(sessionId) && !forceRestart) {
    const existing = sessions.get(sessionId);
    if (io) existing.io = io; // update io reference
    if (existing.status === 'connected') {
      if (io) io.to(sessionId).emit('status', { status: 'connected', sessionId });
      return existing;
    }
    if (existing.status === 'connecting' || existing.status === 'qr') {
      return existing;
    }
  }

  console.log(`[SessionManager] Initializing session: ${sessionId}`);
  const sessionPath = path.join(SESSION_DIR, sessionId);

  // Secure subfolder permissions
  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true, mode: 0o700 });
  } else {
    try {
      fs.chmodSync(sessionPath, 0o700);
    } catch (e) {}
  }

  // Load auth state from multi-file storage
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  // Fetch the latest WhatsApp Web version to avoid 405 Method Not Allowed error
  let version = [2, 3000, 1017531287]; // Fallback version
  try {
    const { fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
    const latestVersion = await fetchLatestBaileysVersion();
    if (latestVersion && latestVersion.version) {
      version = latestVersion.version;
      console.log(`[SessionManager: ${sessionId}] Fetched latest WA Web version: ${version.join('.')}`);
    }
  } catch (err) {
    console.warn(`[SessionManager: ${sessionId}] Failed to fetch latest WA Web version, using fallback:`, err.message);
  }

  // Configure WASocket with custom settings
  const socket = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['HANDCAP API Gateway', 'Chrome', '1.0.0']
  });

  // Clear any existing ping interval to prevent leaks
  if (sessions.has(sessionId)) {
    const prev = sessions.get(sessionId);
    if (prev.pingInterval) clearInterval(prev.pingInterval);
  }

  const sessionData = {
    id: sessionId,
    socket,
    status: 'connecting',
    qr: null,
    reconnectCount: sessions.get(sessionId)?.reconnectCount || 0,
    queue: [],
    isProcessing: false,
    pingInterval: null,
    io
  };

  sessions.set(sessionId, sessionData);

  // Emit status helper
  const emitStatus = (status, extra = {}) => {
    sessionData.status = status;
    if (io) {
      const userId = sessionId.split('_')[0];
      const userSessionId = sessionId.replace(`${userId}_`, '');
      // Emit to the session-specific channel
      io.to(sessionId).emit('status', { status, sessionId: userSessionId, ...extra });
      // Emit user-scoped active sessions list to user's room
      const userSessions = getAllSessionsStatus()
        .filter(s => s.id.startsWith(`${userId}_`))
        .map(s => ({
          id: s.id.replace(`${userId}_`, ''),
          status: s.status,
          qr: s.qr
        }));
      io.to(`user_${userId}`).emit('all-sessions', userSessions);
    }
  };

  // Listen for credential updates to save to the filesystem
  socket.ev.on('creds.update', saveCreds);

  // Monitor incoming and outgoing chat messages in real-time
  socket.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
    const db = require('./db');
    for (const msg of m.messages) {
      if (!msg.key || !msg.key.remoteJid) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;

      // Resolve LID to PN (Phone Number) if remoteJidAlt is available to prevent thread duplication
      const targetJid = msg.key.remoteJidAlt || msg.key.remoteJid;
      const phone = targetJid.split('@')[0];
      const text = msg.message?.conversation || 
                   msg.message?.extendedTextMessage?.text || 
                   msg.message?.imageMessage?.caption || 
                   '';
      
      if (!text) continue;

      const fromMe = msg.key.fromMe || false;
      const msgId = msg.key.id;

      // Save message
      await db.saveChatMessage(sessionId, msgId, phone, text, fromMe);

      // Broadcast to client dashboard in real-time (user specific room)
      if (io) {
        const userId = sessionId.split('_')[0];
        const userSessionId = sessionId.replace(`${userId}_`, '');
        io.to(`user_${userId}`).emit('new-message', {
          sessionId: userSessionId,
          msgId,
          phone,
          message: text,
          fromMe,
          created_at: new Date()
        });
      }
    }
  });

  // Monitor connection updates
  socket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessionData.qr = qr;
      emitStatus('qr', { qr });
      console.log(`[SessionManager: ${sessionId}] QR Code received. Scan via Web Dashboard.`);
      try {
        const qrcodeTerminal = require('qrcode-terminal');
        qrcodeTerminal.generate(qr, { small: true });
      } catch (err) {
        console.error('Failed to print QR in terminal:', err.message);
      }
    }

    if (connection === 'connecting') {
      emitStatus('connecting');
      console.log(`[SessionManager: ${sessionId}] Connecting...`);
    }

    if (connection === 'open') {
      sessionData.qr = null;
      sessionData.reconnectCount = 0;
      emitStatus('connected');
      console.log(`[SessionManager: ${sessionId}] Connected successfully!`);

      // Start keep-alive ping frame interval
      if (!sessionData.pingInterval) {
        sessionData.pingInterval = setInterval(async () => {
          if (sessionData.status === 'connected') {
            try {
              console.log(`[SessionManager: ${sessionId}] Sending keep-alive ping...`);
              if (typeof socket.sendPing === 'function') {
                await socket.sendPing();
              } else {
                await socket.query({
                  tag: 'iq',
                  attrs: {
                    to: '@s.whatsapp.net',
                    type: 'get',
                    xmlns: 'w:g2',
                  },
                  content: []
                });
              }
            } catch (err) {
              console.warn(`[SessionManager: ${sessionId}] Keep-alive ping failed:`, err.message);
            }
          }
        }, 30000);
      }

      // Process any queued messages
      processQueue(sessionId).catch(err => {
        console.error(`[SessionManager: ${sessionId}] Queue processing error on connection open:`, err.message);
      });
    }

    if (connection === 'close') {
      sessionData.qr = null;
      if (sessionData.pingInterval) {
        clearInterval(sessionData.pingInterval);
        sessionData.pingInterval = null;
      }

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      // Reconnect unless it's explicitly logged out by user or device mismatch
      const isLoggedOut = statusCode === DisconnectReason.loggedOut || 
                         statusCode === 401 || 
                         statusCode === 403 || 
                         statusCode === 419;
      const shouldReconnect = !isLoggedOut;

      console.log(`[SessionManager: ${sessionId}] Connection closed. StatusCode: ${statusCode}. ShouldReconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        emitStatus('connecting');

        // Immediate reconnect if requested by Baileys, otherwise apply back-off delay
        let delay = 1000;
        if (statusCode !== DisconnectReason.restartRequired) {
          // Scale delay: 5s, 10s, 20s, up to 60s
          delay = Math.min(60000, Math.pow(2, sessionData.reconnectCount) * 5000);
          sessionData.reconnectCount++;
        }
        
        console.log(`[SessionManager: ${sessionId}] Reconnecting in ${delay}ms (Attempt #${sessionData.reconnectCount})`);

        setTimeout(async () => {
          try {
            await initSession(sessionId, io, true);
          } catch (err) {
            console.error(`[SessionManager: ${sessionId}] Auto-reconnect failed:`, err.message);
          }
        }, delay);
      } else {
        // Session was logged out/invalidated
        emitStatus('disconnected');
        console.log(`[SessionManager: ${sessionId}] Logged out. Clearing credentials.`);
        
        // Trigger ONFIX webhook alert
        try {
          sendWebhookNotification(sessionId, 'logged_out');
        } catch (webhookErr) {
          console.error(`[SessionManager: ${sessionId}] Webhook trigger failed:`, webhookErr.message);
        }

        sessions.delete(sessionId);
        
        // Securely erase the credentials folder
        try {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        } catch (err) {
          console.error(`[SessionManager: ${sessionId}] Error purging credentials directory:`, err.message);
        }
      }
    }
  });

  return sessionData;
}

/**
 * Format phone number to international standard (default to 62 if Indonesian local format)
 * @param {string} phone 
 * @returns {string} digits-only phone number in international format
 */
function formatPhoneNumber(phone) {
  let cleaned = phone.replace(/[^0-9]/g, '');
  
  if (cleaned.startsWith('0')) {
    cleaned = '62' + cleaned.slice(1);
  } else if (cleaned.startsWith('8')) {
    cleaned = '62' + cleaned;
  }
  
  return cleaned;
}

/**
 * Processes the message queue sequentially for a specific session.
 * Mimics human-like typing states and adds safe cool-down delays to avoid spam bans.
 * @param {string} sessionId 
 */
async function processQueue(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (session.status !== 'connected') {
    console.log(`[SessionManager: ${sessionId}] Cannot process queue because session status is '${session.status}'.`);
    return;
  }

  if (session.isProcessing) return;
  session.isProcessing = true;

  console.log(`[SessionManager: ${sessionId}] Started processing message queue (${session.queue.length} in queue).`);

  while (session.queue.length > 0) {
    if (session.status !== 'connected') {
      console.log(`[SessionManager: ${sessionId}] Pausing queue processing - session disconnected.`);
      break;
    }

    const task = session.queue.shift();
    const { cleanPhone, message, priority, resolve, reject, fakeMsgId } = task;

    try {
      // 1. Simulate human typing (Presence update composing)
      console.log(`[SessionManager: ${sessionId}] Simulating typing presence to ${cleanPhone}...`);
      await session.socket.sendPresenceUpdate('composing', cleanPhone);

      // Random delay for typing: between 1.5s to 3s (but only 500ms - 1000ms for high-priority OTP)
      const typingDelay = priority === 'high'
        ? Math.floor(Math.random() * 500) + 500
        : Math.floor(Math.random() * 1500) + 1500;
      await new Promise(r => setTimeout(r, typingDelay));

      // 2. Send the message
      const sentMessage = await session.socket.sendMessage(cleanPhone, { text: message });
      
      // Pause typing simulation
      await session.socket.sendPresenceUpdate('paused', cleanPhone);
      
      console.log(`[SessionManager: ${sessionId}] Message sent successfully to ${cleanPhone}. MsgId: ${sentMessage.key.id}`);
      
      // Save outgoing message to chat history immediately
      const db = require('./db');
      const phoneOnly = cleanPhone.split('@')[0];
      await db.saveChatMessage(sessionId, sentMessage.key.id, phoneOnly, message, true);

      // Update log database if it was queued during connecting
      if (fakeMsgId) {
        console.log(`[SessionManager: ${sessionId}] Updating database status for queued message: ${fakeMsgId} -> ${sentMessage.key.id}`);
        await db.updateMessageStatus(fakeMsgId, sentMessage.key.id, 'sent');
      }

      // Broadcast outgoing message to update the chat room UI immediately
      if (session.io) {
        const userId = sessionId.split('_')[0];
        const userSessionId = sessionId.replace(`${userId}_`, '');
        session.io.to(`user_${userId}`).emit('new-message', {
          sessionId: userSessionId,
          msgId: sentMessage.key.id,
          phone: phoneOnly,
          message: message,
          fromMe: true,
          created_at: new Date()
        });
      }

      if (!task.resolved) {
        resolve(sentMessage);
      }

    } catch (err) {
      console.error(`[SessionManager: ${sessionId}] Failed to send queued message to ${cleanPhone}:`, err.message);
      // Ensure we clear the typing state in case of failure
      try {
        await session.socket.sendPresenceUpdate('paused', cleanPhone);
      } catch (e) {}

      if (fakeMsgId) {
        const db = require('./db');
        await db.updateMessageStatus(fakeMsgId, 'FAILED_' + Date.now(), 'failed');
      }

      if (!task.resolved) {
        reject(err);
      }
    }

    // 3. Post-send cool-down delay to prevent Meta spam detection (Banned prevention)
    if (session.queue.length > 0) {
      const nextTask = session.queue[0];
      const useShortCooldown = priority === 'high' || (nextTask && nextTask.priority === 'high');

      // Random cool-down delay: short (500ms-1s) for high-priority OTP; normal (3s-6s) for broadcasts
      const cooldownDelay = useShortCooldown
        ? Math.floor(Math.random() * 500) + 500
        : Math.floor(Math.random() * 3000) + 3000;
      console.log(`[SessionManager: ${sessionId}] Waiting ${cooldownDelay}ms cool-down before sending next message...`);
      await new Promise(r => setTimeout(r, cooldownDelay));
    }
  }

  session.isProcessing = false;
  console.log(`[SessionManager: ${sessionId}] Finished processing message queue.`);
}

/**
 * Send text message using specific session (Pushed to anti-ban queue with priority support)
 * @param {string} sessionId 
 * @param {string} phone 
 * @param {string} message 
 * @param {string} priority - 'high' | 'normal'
 * @returns {Promise<object>} Baileys sendMessage response object
 */
async function sendMessage(sessionId, phone, message, priority = 'normal') {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session '${sessionId}' not found. Please connect the session first.`);
  }

  const isConnecting = session.status === 'connecting' || session.status === 'qr';
  if (session.status !== 'connected' && !isConnecting) {
    throw new Error(`Session '${sessionId}' is not connected. Current status: ${session.status}`);
  }

  // Sanitize the phone number and format to WhatsApp JID using international standard
  const formattedPhone = formatPhoneNumber(phone);
  const cleanPhone = `${formattedPhone}@s.whatsapp.net`;

  // Push message to the queue to prevent simultaneous spamming (Anti-Ban strategy)
  return new Promise((resolve, reject) => {
    const fakeMsgId = isConnecting ? 'QUEUED_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7) : null;
    const queueItem = {
      cleanPhone,
      message,
      priority,
      resolve,
      reject,
      fakeMsgId,
      resolved: false
    };

    if (priority === 'high') {
      session.queue.unshift(queueItem);
      console.log(`[SessionManager: ${sessionId}] High-priority message queued at front for ${formattedPhone}`);
    } else {
      session.queue.push(queueItem);
      console.log(`[SessionManager: ${sessionId}] Normal-priority message queued for ${formattedPhone}`);
    }

    if (session.status === 'connected') {
      processQueue(sessionId).catch(err => {
        console.error(`[SessionManager: ${sessionId}] Queue error:`, err.message);
      });
    } else {
      // Resolve immediately for background queued messages so the ONFIX API request doesn't block or timeout
      console.log(`[SessionManager: ${sessionId}] Session is ${session.status}. Resolving API call with queued status.`);
      queueItem.resolved = true;
      resolve({
        key: { id: fakeMsgId },
        status: 'queued'
      });
    }
  });
}

/**
 * Gracefully logout and destroy a session
 * @param {string} sessionId 
 * @param {object} io 
 */
async function deleteSession(sessionId, io = null) {
  const session = sessions.get(sessionId);
  if (session) {
    if (session.pingInterval) {
      clearInterval(session.pingInterval);
      session.pingInterval = null;
    }
    try {
      await session.socket.logout();
    } catch (e) {
      try {
        session.socket.end();
      } catch (err) {}
    }
    sessions.delete(sessionId);
  }

  const sessionPath = path.join(SESSION_DIR, sessionId);
  if (fs.existsSync(sessionPath)) {
    try {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    } catch (err) {
      console.error(`Error deleting session folder for ${sessionId}:`, err.message);
    }
  }

  if (io) {
    const userId = sessionId.split('_')[0];
    const userSessionId = sessionId.replace(`${userId}_`, '');
    io.to(sessionId).emit('status', { status: 'disconnected', sessionId: userSessionId });
    const userSessions = getAllSessionsStatus()
      .filter(s => s.id.startsWith(`${userId}_`))
      .map(s => ({
        id: s.id.replace(`${userId}_`, ''),
        status: s.status,
        qr: s.qr
      }));
    io.to(`user_${userId}`).emit('all-sessions', userSessions);
  }
}

/**
 * Auto-load existing sessions from disk on startup
 * @param {object} io 
 */
async function autoLoadSessions(io = null) {
  if (!fs.existsSync(SESSION_DIR)) return;

  try {
    const files = fs.readdirSync(SESSION_DIR);
    let loadedAny = false;

    for (const file of files) {
      const fullPath = path.join(SESSION_DIR, file);
      if (fs.statSync(fullPath).isDirectory()) {
        const credsExist = fs.existsSync(path.join(fullPath, 'creds.json'));
        if (credsExist) {
          // Ensure folder name follows the user-session naming convention [userId]_[sessionName]
          if (!/^\d+_.+$/.test(file)) {
            console.warn(`[SessionManager] Skipping folder "${file}" as it does not follow the required "userId_sessionName" pattern.`);
            continue;
          }
          loadedAny = true;
          console.log(`[SessionManager] Auto-loading existing session folder: ${file}`);
          initSession(file, io).catch((err) => {
            console.error(`[SessionManager] Auto-load failed for ${file}:`, err.message);
          });
        }
      }
    }

    // Auto-init default session if no folder is found
    if (!loadedAny) {
      console.log('[SessionManager] No saved sessions found. Initializing default session (User 1).');
      initSession('1_default', io).catch((err) => {
        console.error('[SessionManager] Auto-init "1_default" session failed:', err.message);
      });
    }
  } catch (err) {
    console.error('[SessionManager] Error scanning sessions root folder:', err.message);
  }
}

module.exports = {
  initSession,
  deleteSession,
  sendMessage,
  autoLoadSessions,
  getAllSessionsStatus,
  formatPhoneNumber,
  sessions
};
