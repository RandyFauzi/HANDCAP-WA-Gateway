const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sessionManager = require('../sessionManager');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey';

/**
 * Bearer Token authentication middleware supporting:
 * 1. JWT (Dashboard Client Session)
 * 2. API Key (External Website integrations)
 * 3. Global API Key (Fallback for backward compatibility)
 */
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      status: 'error',
      message: 'Unauthorized: Bearer token is required in the Authorization header.'
    });
  }

  const token = authHeader.split(' ')[1];

  // 1. Try to verify as JWT (Dashboard User)
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = { id: decoded.userId, email: decoded.email };
    return next();
  } catch (err) {
    // Fail silently to try next auth method
  }

  // 2. Try to verify as custom generated API Key
  try {
    const user = await db.verifyApiKey(token);
    if (user) {
      req.user = { id: user.id, email: user.email };
      return next();
    }
  } catch (err) {
    console.error('[Auth Middleware] Custom API Key error:', err.message);
  }

  // 3. Fallback to process.env.API_KEY (for backward compatibility)
  const globalApiKey = process.env.API_KEY || 'supersecretapikey';
  if (token === globalApiKey) {
    req.user = { id: 1, email: 'randyfauzi24@gmail.com' };
    return next();
  }

  return res.status(401).json({
    status: 'error',
    message: 'Unauthorized: Invalid or expired token.'
  });
};

// In-memory rate limiter store (maps userId -> { count, resetTime })
const messageRateLimits = new Map();

/**
 * Message sending rate limiter middleware
 * Limits to 50 messages per minute per user account
 */
const messageRateLimiter = (req, res, next) => {
  if (!req.user || !req.user.id) {
    return next();
  }
  const userId = req.user.id;
  const now = Date.now();
  const limit = 50;
  const windowMs = 60000;

  if (!messageRateLimits.has(userId)) {
    messageRateLimits.set(userId, { count: 1, resetTime: now + windowMs });
    return next();
  }

  const limitData = messageRateLimits.get(userId);
  if (now > limitData.resetTime) {
    // Reset window
    limitData.count = 1;
    limitData.resetTime = now + windowMs;
    return next();
  }

  if (limitData.count >= limit) {
    return res.status(429).json({
      status: 'error',
      message: `Too Many Requests: Rate limit exceeded. Maximum is ${limit} messages per minute per user.`
    });
  }

  limitData.count++;
  next();
};

/**
 * POST /api/v1/send-message
 * Sends a WhatsApp message using user-scoped session.
 */
router.post('/send-message', authenticate, messageRateLimiter, async (req, res) => {
  const { phone, message, session, priority, otp } = req.body;
  const userSessionId = session || 'default';
  const sessionId = `${req.user.id}_${userSessionId}`;

  // Request validation
  if (!phone || typeof phone !== 'string') {
    return res.status(400).json({
      status: 'error',
      message: 'Bad Request: "phone" parameter is required and must be a string.'
    });
  }

  if (!message || typeof message !== 'string') {
    return res.status(400).json({
      status: 'error',
      message: 'Bad Request: "message" parameter is required and must be a string.'
    });
  }

  // Clean & Format phone number (convert local format e.g. 08... to international 628...)
  const cleanPhone = sessionManager.formatPhoneNumber(phone);
  if (cleanPhone.length < 8) {
    return res.status(400).json({
      status: 'error',
      message: 'Bad Request: Invalid phone number format. Must contain at least 8 digits.'
    });
  }

  try {
    const priorityLevel = (priority === 'high' || otp === true) ? 'high' : 'normal';
    // Send message via queue (using user-prefixed sessionId)
    const result = await sessionManager.sendMessage(sessionId, cleanPhone, message, priorityLevel);
    const msgId = result?.key?.id || 'UNKNOWN';
    const isQueued = result?.status === 'queued';

    // Log details to Database
    await db.logMessage(sessionId, msgId, cleanPhone, message, isQueued ? 'queued' : 'sent');

    return res.status(200).json({
      status: 'success',
      message: isQueued ? 'Message queued. Will be sent when connection is open.' : 'Message sent successfully.',
      data: {
        id: msgId,
        recipient: cleanPhone,
        status: isQueued ? 'queued' : 'sent'
      }
    });
  } catch (err) {
    console.error(`[API v1] Failed to send message via session [${sessionId}]:`, err.message);
    
    // Log failure in background
    await db.logMessage(sessionId, 'FAILED', cleanPhone, message, 'failed');

    return res.status(500).json({
      status: 'error',
      message: err.message || 'Failed to send WhatsApp message.'
    });
  }
});

/**
 * GET /api/v1/status
 * Fetches status report of user-scoped sessions.
 */
router.get('/status', authenticate, (req, res) => {
  const dbStatus = db.getStatus();
  const activeSessions = sessionManager.getAllSessionsStatus()
    .filter(s => s.id.startsWith(`${req.user.id}_`))
    .map(s => ({
      id: s.id.replace(`${req.user.id}_`, ''),
      status: s.status,
      qr: s.qr
    }));

  return res.status(200).json({
    status: 'success',
    data: {
      database: dbStatus,
      sessions: activeSessions
    }
  });
});

/**
 * POST /api/v1/sessions
 * Creates or initializes a new WhatsApp session.
 */
router.post('/sessions', authenticate, async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({
      status: 'error',
      message: 'Bad Request: "sessionId" is required and must be a string.'
    });
  }

  // Sanitize sessionId to prevent directory traversal
  const cleanSessionId = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '');
  if (!cleanSessionId || cleanSessionId !== sessionId) {
    return res.status(400).json({
      status: 'error',
      message: 'Bad Request: "sessionId" must be alphanumeric (hyphens/underscores allowed).'
    });
  }

  const prefixedSessionId = `${req.user.id}_${cleanSessionId}`;

  try {
    const io = req.app.get('socketio');
    // Non-blocking initialization
    sessionManager.initSession(prefixedSessionId, io).catch(err => {
      console.error(`[API v1] Lazy session init error for ${prefixedSessionId}:`, err.message);
    });

    return res.status(200).json({
      status: 'success',
      message: `Session '${cleanSessionId}' initialization triggered.`
    });
  } catch (err) {
    return res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * Helper to run the campaign in the background sequentially
 */
async function runCampaignWorker(campaign, io) {
  let successCount = 0;
  let failedCount = 0;
  const campaignId = campaign.id;
  const sessionId = campaign.session_id; // already prefixed
  const userId = sessionId.split('_')[0];

  console.log(`[CampaignWorker: ${campaignId}] Starting background sender for ${campaign.total_recipients} contacts.`);
  
  // Mark campaign processing
  await db.updateCampaignStatus(campaignId, 'processing', 0, 0);
  if (io) {
    const list = await db.getCampaigns(userId);
    // Strip user prefix for front-end safety
    const cleanList = list.map(c => ({
      ...c,
      session_id: c.session_id.replace(`${userId}_`, '')
    }));
    io.to(`user_${userId}`).emit('all-campaigns', cleanList);
  }

  for (const rec of campaign.recipients) {
    try {
      // Call sendMessage (adds task to queue with typing & cool-down)
      await sessionManager.sendMessage(sessionId, rec.phone, campaign.message);
      successCount++;
      await db.updateRecipientStatus(campaignId, rec.phone, 'sent');
    } catch (err) {
      failedCount++;
      await db.updateRecipientStatus(campaignId, rec.phone, 'failed', err.message);
    }

    // Update progress counters in DB
    await db.updateCampaignStatus(campaignId, 'processing', successCount, failedCount);

    // Stream progress update to the dashboard clients
    if (io) {
      io.to(`user_${userId}`).emit('campaign-progress', {
        campaignId,
        sentCount: successCount,
        failedCount,
        totalRecipients: campaign.total_recipients,
        status: 'processing'
      });
    }
  }

  // Mark campaign completed
  console.log(`[CampaignWorker: ${campaignId}] Finished. Success: ${successCount} | Failed: ${failedCount}.`);
  await db.updateCampaignStatus(campaignId, 'completed', successCount, failedCount);
  
  if (io) {
    io.to(`user_${userId}`).emit('campaign-progress', {
      campaignId,
      sentCount: successCount,
      failedCount,
      totalRecipients: campaign.total_recipients,
      status: 'completed'
    });
    const list = await db.getCampaigns(userId);
    const cleanList = list.map(c => ({
      ...c,
      session_id: c.session_id.replace(`${userId}_`, '')
    }));
    io.to(`user_${userId}`).emit('all-campaigns', cleanList);
  }
}

/**
 * POST /api/v1/broadcasts
 * Creates and launches a new broadcast campaign.
 */
router.post('/broadcasts', authenticate, async (req, res) => {
  const { name, sessionId, message, recipients } = req.body;
  const userSessionId = sessionId || 'default';
  const activeSessionId = `${req.user.id}_${userSessionId}`;

  // Basic Validation
  if (!name || typeof name !== 'string') {
    return res.status(400).json({
      status: 'error',
      message: 'Bad Request: "name" parameter is required and must be a string.'
    });
  }

  if (!message || typeof message !== 'string') {
    return res.status(400).json({
      status: 'error',
      message: 'Bad Request: "message" parameter is required and must be a string.'
    });
  }

  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({
      status: 'error',
      message: 'Bad Request: "recipients" parameter is required and must be a non-empty array of phone numbers.'
    });
  }

  // Sanitize and format all phone numbers
  const formattedRecipients = [];
  const seenNumbers = new Set();
  
  for (let num of recipients) {
    if (typeof num !== 'string') continue;
    const clean = sessionManager.formatPhoneNumber(num);
    if (clean && clean.length >= 8 && !seenNumbers.has(clean)) {
      formattedRecipients.push(clean);
      seenNumbers.add(clean);
    }
  }

  if (formattedRecipients.length === 0) {
    return res.status(400).json({
      status: 'error',
      message: 'Bad Request: No valid recipient phone numbers provided (must be at least 8 digits).'
    });
  }

  // Check if session exists and is connected
  const session = sessionManager.sessions.get(activeSessionId);
  if (!session) {
    return res.status(400).json({
      status: 'error',
      message: `Bad Request: WhatsApp Account '${userSessionId}' is not registered.`
    });
  }

  if (session.status !== 'connected') {
    return res.status(400).json({
      status: 'error',
      message: `Bad Request: WhatsApp Account '${userSessionId}' is not connected. Current status: ${session.status}`
    });
  }

  try {
    const io = req.app.get('socketio');
    
    // Save to Database
    const campaign = await db.createCampaign(name, activeSessionId, message, formattedRecipients);

    // Run non-blocking background worker
    runCampaignWorker(campaign, io).catch(err => {
      console.error(`[API v1] Campaign worker initialization error:`, err.message);
    });

    return res.status(200).json({
      status: 'success',
      message: 'Broadcast campaign initialized and running in the background.',
      data: {
        campaignId: campaign.id,
        name: campaign.name,
        totalRecipients: campaign.total_recipients
      }
    });
  } catch (err) {
    console.error('[API v1] Failed to create broadcast campaign:', err.message);
    return res.status(500).json({
      status: 'error',
      message: err.message || 'Failed to create broadcast campaign.'
    });
  }
});

/**
 * GET /api/v1/broadcasts
 * Returns all campaign histories.
 */
router.get('/broadcasts', authenticate, async (req, res) => {
  try {
    const campaigns = await db.getCampaigns(req.user.id);
    const cleanCampaigns = campaigns.map(c => ({
      ...c,
      session_id: c.session_id.replace(`${req.user.id}_`, '')
    }));

    return res.status(200).json({
      status: 'success',
      data: cleanCampaigns
    });
  } catch (err) {
    return res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * GET /api/v1/broadcasts/:id
 * Returns details of a specific campaign including recipient logs.
 */
router.get('/broadcasts/:id', authenticate, async (req, res) => {
  const campaignId = req.params.id;
  try {
    const details = await db.getCampaignDetails(campaignId);
    if (!details || !details.session_id.startsWith(`${req.user.id}_`)) {
      return res.status(404).json({
        status: 'error',
        message: `Campaign with ID ${campaignId} not found.`
      });
    }
    
    const cleanDetails = {
      ...details,
      session_id: details.session_id.replace(`${req.user.id}_`, '')
    };

    return res.status(200).json({
      status: 'success',
      data: cleanDetails
    });
  } catch (err) {
    return res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * GET /api/v1/chats
 * Returns active chat threads list for a session.
 */
router.get('/chats', authenticate, async (req, res) => {
  const userSessionId = req.query.session || 'default';
  const sessionId = `${req.user.id}_${userSessionId}`;
  try {
    const chats = await db.getChats(sessionId);
    return res.status(200).json({
      status: 'success',
      data: chats
    });
  } catch (err) {
    console.error(`[API v1] Failed to fetch chats for session [${userSessionId}]:`, err.message);
    return res.status(500).json({
      status: 'error',
      message: err.message || 'Failed to fetch conversations.'
    });
  }
});

/**
 * GET /api/v1/chats/:phone/messages
 * Returns message history for a specific phone number.
 */
router.get('/chats/:phone/messages', authenticate, async (req, res) => {
  const userSessionId = req.query.session || 'default';
  const sessionId = `${req.user.id}_${userSessionId}`;
  const phone = req.params.phone;

  if (!phone) {
    return res.status(400).json({
      status: 'error',
      message: 'Bad Request: "phone" parameter in path is required.'
    });
  }

  try {
    const messages = await db.getChatMessages(sessionId, phone);
    return res.status(200).json({
      status: 'success',
      data: messages
    });
  } catch (err) {
    console.error(`[API v1] Failed to fetch messages for phone [${phone}] under session [${userSessionId}]:`, err.message);
    return res.status(500).json({
      status: 'error',
      message: err.message || 'Failed to fetch message history.'
    });
  }
});

// =========================================================
// AUTHENTICATION ENDPOINTS
// =========================================================

/**
 * POST /api/v1/auth/register
 * Register new user
 */
router.post('/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({
      status: 'error',
      message: 'Bad Request: "email" and "password" are required.'
    });
  }

  try {
    const passwordHash = bcrypt.hashSync(password, 10);
    const user = await db.createUser(email, passwordHash);

    // Auto-generate a default API Key for this new user
    const crypto = require('crypto');
    const defaultKey = 'key_' + crypto.randomBytes(16).toString('hex');
    const keyHash = crypto.createHash('sha256').update(defaultKey).digest('hex');
    const keyPreview = defaultKey.substring(0, 8) + '...' + defaultKey.substring(defaultKey.length - 4);
    await db.createApiKey(user.id, 'Default API Key', keyHash, keyPreview, defaultKey);

    return res.status(200).json({
      status: 'success',
      message: 'Registration successful.'
    });
  } catch (err) {
    return res.status(400).json({
      status: 'error',
      message: err.message || 'Registration failed.'
    });
  }
});

/**
 * POST /api/v1/auth/login
 * User login
 */
router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({
      status: 'error',
      message: 'Bad Request: "email" and "password" are required.'
    });
  }

  try {
    const user = await db.getUserByEmail(email);
    if (!user) {
      return res.status(401).json({
        status: 'error',
        message: 'Unauthorized: Invalid email or password.'
      });
    }

    const isMatch = bcrypt.compareSync(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({
        status: 'error',
        message: 'Unauthorized: Invalid email or password.'
      });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.status(200).json({
      status: 'success',
      message: 'Login successful.',
      data: {
        token,
        user: {
          id: user.id,
          email: user.email
        }
      }
    });
  } catch (err) {
    return res.status(500).json({
      status: 'error',
      message: err.message || 'Login failed.'
    });
  }
});

/**
 * GET /api/v1/auth/me
 * Retrieves active user details
 */
router.get('/auth/me', authenticate, (req, res) => {
  return res.status(200).json({
    status: 'success',
    data: {
      user: req.user
    }
  });
});

// Admin Authorization Middleware
const isAdmin = (req, res, next) => {
  if (req.user && (req.user.email === 'randyfauzi24@gmail.com' || req.user.id === 1)) {
    return next();
  }
  return res.status(403).json({
    status: 'error',
    message: 'Forbidden: Admin privilege is required to access user management.'
  });
};

/**
 * GET /api/v1/admin/users
 * Returns list of all users (Admin Only)
 */
router.get('/admin/users', authenticate, isAdmin, async (req, res) => {
  try {
    const users = await db.getAllUsers();
    return res.status(200).json({
      status: 'success',
      data: users
    });
  } catch (err) {
    return res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * GET /api/v1/admin/users/:id
 * Get details of a user including their API Keys & total campaigns (Admin Only)
 */
router.get('/admin/users/:id', authenticate, isAdmin, async (req, res) => {
  const userId = req.params.id;
  try {
    const user = await db.getUserById(userId);
    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found.'
      });
    }

    const apiKeys = await db.getApiKeys(userId);
    const campaigns = await db.getCampaigns(userId);
    
    return res.status(200).json({
      status: 'success',
      data: {
        user,
        apiKeysCount: apiKeys.length,
        apiKeys: apiKeys,
        campaignsCount: campaigns.length,
        campaigns: campaigns
      }
    });
  } catch (err) {
    return res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * POST /api/v1/admin/users
 * Create a new user (Admin Only)
 */
router.post('/admin/users', authenticate, isAdmin, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({
      status: 'error',
      message: 'Bad Request: email and password are required.'
    });
  }
  try {
    const passwordHash = bcrypt.hashSync(password, 10);
    const user = await db.createUser(email, passwordHash);

    // Auto-generate a default API Key for this new user
    const crypto = require('crypto');
    const defaultKey = 'key_' + crypto.randomBytes(16).toString('hex');
    const keyHash = crypto.createHash('sha256').update(defaultKey).digest('hex');
    const keyPreview = defaultKey.substring(0, 8) + '...' + defaultKey.substring(defaultKey.length - 4);
    await db.createApiKey(user.id, 'Default API Key', keyHash, keyPreview, defaultKey);

    return res.status(200).json({
      status: 'success',
      message: 'User created successfully.',
      data: user
    });
  } catch (err) {
    return res.status(400).json({
      status: 'error',
      message: err.message || 'Failed to create user.'
    });
  }
});

/**
 * PUT /api/v1/admin/users/:id
 * Update a user (Admin Only)
 */
router.put('/admin/users/:id', authenticate, isAdmin, async (req, res) => {
  const userId = req.params.id;
  const { email, password } = req.body;
  if (!email) {
    return res.status(400).json({
      status: 'error',
      message: 'Bad Request: email is required.'
    });
  }
  try {
    const passwordHash = password ? bcrypt.hashSync(password, 10) : null;
    const user = await db.updateUser(userId, email, passwordHash);
    return res.status(200).json({
      status: 'success',
      message: 'User updated successfully.',
      data: user
    });
  } catch (err) {
    return res.status(400).json({
      status: 'error',
      message: err.message || 'Failed to update user.'
    });
  }
});

/**
 * DELETE /api/v1/admin/users/:id
 * Delete a user (Admin Only)
 */
router.delete('/admin/users/:id', authenticate, isAdmin, async (req, res) => {
  const userId = req.params.id;
  try {
    await db.deleteUser(userId);
    return res.status(200).json({
      status: 'success',
      message: 'User deleted successfully.'
    });
  } catch (err) {
    return res.status(400).json({
      status: 'error',
      message: err.message || 'Failed to delete user.'
    });
  }
});

// =========================================================
// API KEY MANAGEMENT ENDPOINTS
// =========================================================

/**
 * GET /api/v1/api-keys
 * Get all API keys for active user
 */
router.get('/api-keys', authenticate, async (req, res) => {
  try {
    const keys = await db.getApiKeys(req.user.id);
    return res.status(200).json({
      status: 'success',
      data: keys
    });
  } catch (err) {
    return res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * POST /api/v1/api-keys
 * Create a new API key
 */
router.post('/api-keys', authenticate, async (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({
      status: 'error',
      message: 'Bad Request: "name" parameter is required and must be a string.'
    });
  }

  try {
    const crypto = require('crypto');
    const randomKey = 'key_' + crypto.randomBytes(16).toString('hex');
    const keyHash = crypto.createHash('sha256').update(randomKey).digest('hex');
    const keyPreview = randomKey.substring(0, 8) + '...' + randomKey.substring(randomKey.length - 4);
    const newKey = await db.createApiKey(req.user.id, name, keyHash, keyPreview, randomKey);
    return res.status(200).json({
      status: 'success',
      message: 'API Key generated successfully.',
      data: {
        id: newKey.id,
        name: newKey.name,
        key_preview: newKey.key_preview,
        key_value: randomKey, // Plain text returned only once on creation
        created_at: newKey.created_at
      }
    });
  } catch (err) {
    return res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * DELETE /api/v1/api-keys/:id
 * Revokes/deletes an API key
 */
router.delete('/api-keys/:id', authenticate, async (req, res) => {
  const keyId = req.params.id;
  try {
    const success = await db.deleteApiKey(req.user.id, keyId);
    if (success) {
      return res.status(200).json({
        status: 'success',
        message: 'API Key revoked successfully.'
      });
    }
    return res.status(404).json({
      status: 'error',
      message: 'API Key not found or does not belong to active user.'
    });
  } catch (err) {
    return res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

module.exports = router;



