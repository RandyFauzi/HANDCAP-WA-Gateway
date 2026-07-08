const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

let pool = null;
let isConnected = false;

// In-Memory Fallback Registry (When MySQL is not configured/offline)
const memoryCampaigns = [];
const memoryRecipients = [];
const memoryChatMessages = [];
const memoryUsers = [];
const memoryApiKeys = [];
let memoryCampaignIdCounter = 1;
let memoryRecipientIdCounter = 1;

// Seed in-memory database on start
const seedInMemory = () => {
  const email = 'randyfauzi24@gmail.com';
  const passwordHash = bcrypt.hashSync('password', 10);

  // Clean memory arrays first
  memoryUsers.length = 0;
  memoryApiKeys.length = 0;

  const user = {
    id: 1,
    email,
    password_hash: passwordHash,
    created_at: new Date()
  };
  memoryUsers.push(user);

  const defaultHash = crypto.createHash('sha256').update('supersecretapikey').digest('hex');
  memoryApiKeys.push({
    id: 1,
    user_id: 1,
    key_hash: defaultHash,
    key_preview: 'supersecretapikey',
    name: 'Default API Key',
    created_at: new Date()
  });
  console.log(`[Memory Seed] Main user ${email} and default API Key seeded securely.`);
};
seedInMemory();

// Check if database configuration is present
const hasDbConfig = process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME;

if (hasDbConfig) {
  pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4'
  });

  // Test connection and initialize tables
  (async () => {
    try {
      const conn = await pool.getConnection();
      await conn.ping();
      conn.release();
      isConnected = true;
      console.log('Database (MySQL) connected successfully.');

      // Auto-create tables
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          email VARCHAR(100) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          key_hash VARCHAR(100) UNIQUE,
          key_preview VARCHAR(100),
          key_value VARCHAR(100),
          name VARCHAR(100) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      // Migration: Add key_value column if it doesn't exist
      try {
        const [cols] = await pool.query("SHOW COLUMNS FROM api_keys LIKE 'key_value'");
        if (cols.length === 0) {
          await pool.query("ALTER TABLE api_keys ADD COLUMN key_value VARCHAR(100) NULL AFTER key_preview");
          console.log("Migration: Added key_value column to api_keys table.");
        }
      } catch (err) {
        console.warn("Migration warning: failed to check/add key_value column:", err.message);
      }

      await pool.query(`
        CREATE TABLE IF NOT EXISTS sent_messages (
          id INT AUTO_INCREMENT PRIMARY KEY,
          session_id VARCHAR(50) NOT NULL,
          msg_id VARCHAR(100),
          recipient VARCHAR(50) NOT NULL,
          message TEXT NOT NULL,
          status VARCHAR(20) DEFAULT 'sent',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS campaigns (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          session_id VARCHAR(50) NOT NULL,
          message TEXT NOT NULL,
          total_recipients INT NOT NULL,
          sent_count INT DEFAULT 0,
          failed_count INT DEFAULT 0,
          status VARCHAR(20) DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS campaign_recipients (
          id INT AUTO_INCREMENT PRIMARY KEY,
          campaign_id INT NOT NULL,
          phone VARCHAR(20) NOT NULL,
          status VARCHAR(20) DEFAULT 'pending',
          error_message TEXT,
          sent_at TIMESTAMP NULL DEFAULT NULL,
          FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id INT AUTO_INCREMENT PRIMARY KEY,
          session_id VARCHAR(50) NOT NULL,
          msg_id VARCHAR(100) NOT NULL,
          phone VARCHAR(50) NOT NULL,
          message TEXT NOT NULL,
          from_me TINYINT(1) NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_msg_id (msg_id),
          INDEX idx_session_phone (session_id, phone),
          INDEX idx_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      console.log('Database tables initialized (users, api_keys, sent_messages, campaigns, campaign_recipients, chat_messages).');

      // Seed main admin user if not exists
      const email = 'randyfauzi24@gmail.com';
      const [rows] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
      if (rows.length === 0) {
        const passwordHash = bcrypt.hashSync('password', 10);
        await pool.query('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, passwordHash]);
        const [newUser] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
        const userId = newUser[0].id;
        console.log(`[Database Seed] Main user ${email} seeded successfully.`);

        const defaultApiKey = 'supersecretapikey';
        const defaultHash = crypto.createHash('sha256').update(defaultApiKey).digest('hex');
        await pool.query(
          'INSERT INTO api_keys (user_id, key_hash, key_preview, key_value, name) VALUES (?, ?, ?, ?, ?)',
          [userId, defaultHash, defaultApiKey, defaultApiKey, 'Default API Key']
        );
        console.log(`[Database Seed] Default API Key seeded for ${email}.`);
      }

      // Migration: For any existing API Keys where key_value is NULL,
      // generate a new API key so the user can show/hide and copy it.
      const [nullKeys] = await pool.query("SELECT id FROM api_keys WHERE key_value IS NULL OR key_value = '' OR key_value = 'null'");
      if (nullKeys.length > 0) {
        console.log(`[Database Migration] Found ${nullKeys.length} API keys without plain-text values. Regenerating...`);
        for (const k of nullKeys) {
          const randomKey = 'key_' + crypto.randomBytes(16).toString('hex');
          const keyHash = crypto.createHash('sha256').update(randomKey).digest('hex');
          const keyPreview = randomKey.substring(0, 8) + '...' + randomKey.substring(randomKey.length - 4);
          await pool.query(
            "UPDATE api_keys SET key_hash = ?, key_preview = ?, key_value = ? WHERE id = ?",
            [keyHash, keyPreview, randomKey, k.id]
          );
        }
        console.log("[Database Migration] All old API keys upgraded successfully.");
      }

    } catch (err) {
      console.warn('Database connection failed. Continuing in offline/no-db mode. Reason:', err.message);
      pool = null;
      isConnected = false;
    }
  })();
} else {
  console.log('Database configuration not found. Gateway will run in no-db mode.');
}

// =========================================================
// LOGGING
// =========================================================

/**
 * Log message sending status (Single API Send)
 */
async function logMessage(sessionId, msgId, recipient, message, status = 'sent') {
  if (!pool || !isConnected) {
    console.log(`[No-DB Log] Session: ${sessionId} | MsgId: ${msgId} | To: ${recipient} | Msg: ${message} | Status: ${status}`);
    return null;
  }
  try {
    await pool.query(
      'INSERT INTO sent_messages (session_id, msg_id, recipient, message, status) VALUES (?, ?, ?, ?, ?)',
      [sessionId, msgId, recipient, message, status]
    );
    return { sessionId, msgId, recipient, message, status };
  } catch (err) {
    console.error('Failed to log message to database:', err.message);
    return null;
  }
}

// =========================================================
// CAMPAIGNS
// =========================================================

/**
 * Create a new Broadcast Campaign
 */
async function createCampaign(name, sessionId, message, recipients) {
  if (!pool || !isConnected) {
    const campaignId = memoryCampaignIdCounter++;
    const campaign = {
      id: campaignId, name, session_id: sessionId, message,
      total_recipients: recipients.length, sent_count: 0, failed_count: 0,
      status: 'pending', created_at: new Date()
    };
    memoryCampaigns.push(campaign);

    const mappedRecipients = recipients.map(phone => {
      const rec = {
        id: memoryRecipientIdCounter++, campaign_id: campaignId, phone,
        status: 'pending', error_message: null, sent_at: null
      };
      memoryRecipients.push(rec);
      return rec;
    });
    return { ...campaign, recipients: mappedRecipients };
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      'INSERT INTO campaigns (name, session_id, message, total_recipients) VALUES (?, ?, ?, ?)',
      [name, sessionId, message, recipients.length]
    );
    const [idRes] = await conn.query('SELECT LAST_INSERT_ID() as id');
    const campaignId = idRes[0].id;

    const [campaignRows] = await conn.query('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
    const campaign = campaignRows[0];

    const mappedRecipients = [];
    for (const phone of recipients) {
      await conn.query('INSERT INTO campaign_recipients (campaign_id, phone) VALUES (?, ?)', [campaignId, phone]);
      const [recIdRes] = await conn.query('SELECT LAST_INSERT_ID() as id');
      mappedRecipients.push({ id: recIdRes[0].id, campaign_id: campaignId, phone, status: 'pending', error_message: null, sent_at: null });
    }

    await conn.commit();
    return { ...campaign, recipients: mappedRecipients };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Update Campaign Status and counters
 */
async function updateCampaignStatus(campaignId, status, sentCount, failedCount) {
  const id = parseInt(campaignId);

  if (!pool || !isConnected) {
    const c = memoryCampaigns.find(x => x.id === id);
    if (c) {
      if (status) c.status = status;
      if (sentCount !== undefined) c.sent_count = sentCount;
      if (failedCount !== undefined) c.failed_count = failedCount;
    }
    return c;
  }

  try {
    await pool.query(
      'UPDATE campaigns SET status = COALESCE(?, status), sent_count = COALESCE(?, sent_count), failed_count = COALESCE(?, failed_count) WHERE id = ?',
      [status, sentCount, failedCount, id]
    );
    const [rows] = await pool.query('SELECT * FROM campaigns WHERE id = ?', [id]);
    return rows[0];
  } catch (err) {
    console.error(`Failed to update campaign ${id} status:`, err.message);
    return null;
  }
}

/**
 * Update Recipient Status in a Campaign
 */
async function updateRecipientStatus(campaignId, phone, status, errorMessage = null) {
  const cid = parseInt(campaignId);

  if (!pool || !isConnected) {
    const r = memoryRecipients.find(x => x.campaign_id === cid && x.phone === phone);
    if (r) {
      r.status = status;
      r.error_message = errorMessage;
      r.sent_at = status === 'sent' ? new Date() : null;
    }
    return r;
  }

  try {
    await pool.query(
      `UPDATE campaign_recipients
       SET status = ?, error_message = ?,
           sent_at = CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP ELSE NULL END
       WHERE campaign_id = ? AND phone = ?`,
      [status, errorMessage, status, cid, phone]
    );
    const [rows] = await pool.query(
      'SELECT * FROM campaign_recipients WHERE campaign_id = ? AND phone = ?',
      [cid, phone]
    );
    return rows[0];
  } catch (err) {
    console.error(`Failed to update recipient ${phone} status:`, err.message);
    return null;
  }
}

/**
 * Get all Campaigns (Sorted newest first)
 */
async function getCampaigns(userId) {
  if (!pool || !isConnected) {
    return [...memoryCampaigns]
      .filter(c => c.session_id.startsWith(`${userId}_`))
      .sort((a, b) => b.created_at - a.created_at);
  }

  try {
    const [rows] = await pool.query(
      'SELECT * FROM campaigns WHERE session_id LIKE ? ORDER BY created_at DESC',
      [`${userId}_%`]
    );
    return rows;
  } catch (err) {
    console.error('Failed to query campaigns:', err.message);
    return [];
  }
}

/**
 * Get details of a single Campaign including all recipients
 */
async function getCampaignDetails(campaignId) {
  const id = parseInt(campaignId);

  if (!pool || !isConnected) {
    const c = memoryCampaigns.find(x => x.id === id);
    if (!c) return null;
    const recs = memoryRecipients.filter(x => x.campaign_id === id);
    return { ...c, recipients: recs };
  }

  try {
    const [campaignRows] = await pool.query('SELECT * FROM campaigns WHERE id = ?', [id]);
    if (campaignRows.length === 0) return null;
    const campaign = campaignRows[0];

    const [recRows] = await pool.query(
      'SELECT * FROM campaign_recipients WHERE campaign_id = ? ORDER BY id ASC',
      [id]
    );
    return { ...campaign, recipients: recRows };
  } catch (err) {
    console.error(`Failed to fetch details for campaign ${id}:`, err.message);
    return null;
  }
}

/**
 * Returns database connection status
 */
function getStatus() {
  return {
    enabled: !!pool,
    connected: isConnected
  };
}

// =========================================================
// CHAT MESSAGES
// =========================================================

/**
 * Save chat message (incoming or outgoing)
 */
async function saveChatMessage(sessionId, msgId, phone, message, fromMe = false) {
  if (!pool || !isConnected) {
    const exists = memoryChatMessages.some(m => m.msg_id === msgId);
    if (exists) return null;
    const chatMsg = {
      id: memoryChatMessages.length + 1,
      session_id: sessionId, msg_id: msgId, phone, message,
      from_me: fromMe, created_at: new Date()
    };
    memoryChatMessages.push(chatMsg);
    return chatMsg;
  }

  try {
    // MySQL: INSERT IGNORE to silently skip duplicate msg_id
    await pool.query(
      'INSERT IGNORE INTO chat_messages (session_id, msg_id, phone, message, from_me) VALUES (?, ?, ?, ?, ?)',
      [sessionId, msgId, phone, message, fromMe ? 1 : 0]
    );
    const [rows] = await pool.query('SELECT * FROM chat_messages WHERE msg_id = ?', [msgId]);
    return rows[0] || null;
  } catch (err) {
    console.error('Failed to save chat message to database:', err.message);
    return null;
  }
}

/**
 * Get active conversations list (chats)
 * Returns one row per phone with the latest message — MySQL compatible
 */
async function getChats(sessionId) {
  if (!pool || !isConnected) {
    const chatsMap = new Map();
    const sorted = [...memoryChatMessages]
      .filter(m => m.session_id === sessionId)
      .sort((a, b) => a.created_at - b.created_at);
    for (const m of sorted) {
      chatsMap.set(m.phone, {
        phone: m.phone, message: m.message,
        from_me: m.from_me, created_at: m.created_at
      });
    }
    return Array.from(chatsMap.values()).sort((a, b) => b.created_at - a.created_at);
  }

  try {
    // MySQL-compatible latest-per-group query
    const [rows] = await pool.query(`
      SELECT c.phone, c.message, c.from_me, c.created_at
      FROM chat_messages c
      INNER JOIN (
        SELECT phone, MAX(created_at) AS max_ts
        FROM chat_messages
        WHERE session_id = ?
        GROUP BY phone
      ) latest ON c.phone = latest.phone AND c.created_at = latest.max_ts
      WHERE c.session_id = ?
      ORDER BY c.created_at DESC
    `, [sessionId, sessionId]);
    return rows;
  } catch (err) {
    console.error('Failed to query active chats:', err.message);
    return [];
  }
}

/**
 * Get message history for a specific conversation
 */
async function getChatMessages(sessionId, phone) {
  if (!pool || !isConnected) {
    return memoryChatMessages
      .filter(m => m.session_id === sessionId && m.phone === phone)
      .sort((a, b) => a.created_at - b.created_at);
  }

  try {
    const [rows] = await pool.query(
      'SELECT * FROM chat_messages WHERE session_id = ? AND phone = ? ORDER BY created_at ASC',
      [sessionId, phone]
    );
    return rows;
  } catch (err) {
    console.error(`Failed to query messages for phone ${phone}:`, err.message);
    return [];
  }
}

// =========================================================
// USER MANAGEMENT
// =========================================================

async function createUser(email, passwordHash) {
  if (!pool || !isConnected) {
    const exists = memoryUsers.some(u => u.email === email);
    if (exists) throw new Error('Email already registered.');
    const user = {
      id: memoryUsers.length + 1, email,
      password_hash: passwordHash, created_at: new Date()
    };
    memoryUsers.push(user);
    return user;
  }
  try {
    await pool.query(
      'INSERT INTO users (email, password_hash) VALUES (?, ?)',
      [email, passwordHash]
    );
    const [rows] = await pool.query('SELECT id, email, created_at FROM users WHERE email = ?', [email]);
    return rows[0];
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw new Error('Email already registered.');
    }
    throw err;
  }
}

async function getUserByEmail(email) {
  if (!pool || !isConnected) {
    const user = memoryUsers.find(u => u.email === email);
    return user || null;
  }
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    return rows[0] || null;
  } catch (err) {
    console.error('Failed to get user by email:', err.message);
    return null;
  }
}

async function getUserById(id) {
  const uid = parseInt(id);
  if (!pool || !isConnected) {
    const user = memoryUsers.find(u => u.id === uid);
    return user || null;
  }
  try {
    const [rows] = await pool.query('SELECT id, email, created_at FROM users WHERE id = ?', [uid]);
    return rows[0] || null;
  } catch (err) {
    console.error('Failed to get user by id:', err.message);
    return null;
  }
}

async function getAllUsers() {
  if (!pool || !isConnected) {
    return memoryUsers.map(u => ({ id: u.id, email: u.email, created_at: u.created_at }));
  }
  try {
    const [rows] = await pool.query('SELECT id, email, created_at FROM users ORDER BY id ASC');
    return rows;
  } catch (err) {
    console.error('Failed to get all users:', err.message);
    return [];
  }
}

async function updateUser(userId, email, passwordHash = null) {
  const uid = parseInt(userId);
  if (!pool || !isConnected) {
    const user = memoryUsers.find(u => u.id === uid);
    if (!user) throw new Error('User not found.');
    const exists = memoryUsers.some(u => u.email === email && u.id !== uid);
    if (exists) throw new Error('Email already registered.');
    user.email = email;
    if (passwordHash) user.password_hash = passwordHash;
    return { id: user.id, email: user.email, created_at: user.created_at };
  }
  try {
    if (passwordHash) {
      await pool.query('UPDATE users SET email = ?, password_hash = ? WHERE id = ?', [email, passwordHash, uid]);
    } else {
      await pool.query('UPDATE users SET email = ? WHERE id = ?', [email, uid]);
    }
    const [rows] = await pool.query('SELECT id, email, created_at FROM users WHERE id = ?', [uid]);
    if (rows.length === 0) throw new Error('User not found.');
    return rows[0];
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new Error('Email already registered.');
    throw err;
  }
}

async function deleteUser(userId) {
  const uid = parseInt(userId);
  if (uid === 1) {
    throw new Error('Cannot delete the primary admin user.');
  }
  if (!pool || !isConnected) {
    const idx = memoryUsers.findIndex(u => u.id === uid);
    if (idx !== -1) {
      memoryUsers.splice(idx, 1);
      for (let i = memoryApiKeys.length - 1; i >= 0; i--) {
        if (memoryApiKeys[i].user_id === uid) memoryApiKeys.splice(i, 1);
      }
      return true;
    }
    return false;
  }
  try {
    const [res] = await pool.query('DELETE FROM users WHERE id = ?', [uid]);
    return res.affectedRows > 0;
  } catch (err) {
    console.error('Failed to delete user:', err.message);
    throw err;
  }
}

// =========================================================
// API KEY MANAGEMENT
// =========================================================

async function getApiKeys(userId) {
  const uid = parseInt(userId);
  if (!pool || !isConnected) {
    return memoryApiKeys.filter(k => k.user_id === uid).map(k => ({
      id: k.id, user_id: k.user_id, name: k.name,
      key_preview: k.key_preview, key_value: k.key_value, created_at: k.created_at
    }));
  }
  try {
    const [rows] = await pool.query(
      'SELECT id, name, key_preview, key_value, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC',
      [uid]
    );
    return rows;
  } catch (err) {
    console.error('Failed to get API keys:', err.message);
    return [];
  }
}

async function createApiKey(userId, name, keyHash, keyPreview, keyValue = null) {
  const uid = parseInt(userId);
  if (!pool || !isConnected) {
    const key = {
      id: memoryApiKeys.length + 1, user_id: uid,
      key_hash: keyHash, key_preview: keyPreview, key_value: keyValue,
      name, created_at: new Date()
    };
    memoryApiKeys.push(key);
    return key;
  }
  try {
    await pool.query(
      'INSERT INTO api_keys (user_id, name, key_hash, key_preview, key_value) VALUES (?, ?, ?, ?, ?)',
      [uid, name, keyHash, keyPreview, keyValue]
    );
    const [rows] = await pool.query('SELECT id, name, key_preview, key_value, created_at FROM api_keys WHERE key_hash = ?', [keyHash]);
    return rows[0];
  } catch (err) {
    console.error('Failed to create API key:', err.message);
    throw err;
  }
}

async function deleteApiKey(userId, keyId) {
  const uid = parseInt(userId);
  const kid = parseInt(keyId);
  if (!pool || !isConnected) {
    const idx = memoryApiKeys.findIndex(k => k.user_id === uid && k.id === kid);
    if (idx !== -1) { memoryApiKeys.splice(idx, 1); return true; }
    return false;
  }
  try {
    const [res] = await pool.query('DELETE FROM api_keys WHERE id = ? AND user_id = ?', [kid, uid]);
    return res.affectedRows > 0;
  } catch (err) {
    console.error('Failed to delete API key:', err.message);
    return false;
  }
}

async function verifyApiKey(rawKey) {
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  if (!pool || !isConnected) {
    const key = memoryApiKeys.find(k => k.key_hash === keyHash);
    if (!key) return null;
    const user = memoryUsers.find(u => u.id === key.user_id);
    return user || null;
  }
  try {
    const [rows] = await pool.query(
      'SELECT u.id, u.email FROM api_keys ak JOIN users u ON ak.user_id = u.id WHERE ak.key_hash = ?',
      [keyHash]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('Failed to verify API key:', err.message);
    return null;
  }
}

module.exports = {
  logMessage,
  createCampaign,
  updateCampaignStatus,
  updateRecipientStatus,
  getCampaigns,
  getCampaignDetails,
  getStatus,
  saveChatMessage,
  getChats,
  getChatMessages,
  createUser,
  getUserByEmail,
  getUserById,
  getAllUsers,
  updateUser,
  deleteUser,
  getApiKeys,
  createApiKey,
  deleteApiKey,
  verifyApiKey,
  pool
};
