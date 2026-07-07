require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const sessionManager = require('./sessionManager');
const apiRoutes = require('./routes/api');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Configure Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve Static Front-end Dashboard
app.use(express.static(path.join(__dirname, 'public')));

// Save Socket.io reference in express app instance
app.set('socketio', io);

// Mount API routes
app.use('/api/v1', apiRoutes);

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey';

// Socket.io Authentication Middleware
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) {
    return next(new Error('Authentication error: Token is required'));
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    socket.userEmail = decoded.email;
    next();
  } catch (err) {
    return next(new Error('Authentication error: Invalid or expired token'));
  }
});

// Socket.io Real-time Event Handling
io.on('connection', (socket) => {
  console.log(`[Socket] Client connected & authenticated: ${socket.id} (User: ${socket.userId})`);
  
  // Join the user-specific room for isolated events
  socket.join(`user_${socket.userId}`);

  // Broadcast user-scoped active sessions list
  const userSessions = sessionManager.getAllSessionsStatus()
    .filter(s => s.id.startsWith(`${socket.userId}_`))
    .map(s => ({
      id: s.id.replace(`${socket.userId}_`, ''),
      status: s.status,
      qr: s.qr
    }));
  socket.emit('all-sessions', userSessions);

  // Broadcast user-scoped campaigns list
  db.getCampaigns(socket.userId).then(campaigns => {
    const cleanCampaigns = campaigns.map(c => ({
      ...c,
      session_id: c.session_id.replace(`${socket.userId}_`, '')
    }));
    socket.emit('all-campaigns', cleanCampaigns);
  }).catch(err => {
    console.error(`[Socket: User ${socket.userId}] Failed to fetch campaigns for client:`, err.message);
  });

  // Handle client joining a session room
  socket.on('join-session', ({ sessionId }) => {
    if (!sessionId) return;
    const prefixedSessionId = `${socket.userId}_${sessionId}`;
    socket.join(prefixedSessionId);
    console.log(`[Socket] Client ${socket.id} joined session room: ${prefixedSessionId}`);

    // Instantly report status back to client
    const session = sessionManager.sessions.get(prefixedSessionId);
    if (session) {
      socket.emit('status', {
        sessionId: sessionId,
        status: session.status,
        qr: session.qr
      });
    } else {
      socket.emit('status', {
        sessionId: sessionId,
        status: 'disconnected',
        qr: null
      });
    }
  });

  // Handle manual session initialization from dashboard
  socket.on('init-session', async ({ sessionId }) => {
    if (!sessionId) return;
    const cleanSessionId = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '');
    const prefixedSessionId = `${socket.userId}_${cleanSessionId}`;
    try {
      await sessionManager.initSession(prefixedSessionId, io, true);
    } catch (err) {
      console.error(`[Socket] Init error for ${prefixedSessionId}:`, err.message);
      socket.emit('session-error', { sessionId: cleanSessionId, message: err.message });
    }
  });

  // Handle session termination/logout from dashboard
  socket.on('delete-session', async ({ sessionId }) => {
    if (!sessionId) return;
    const cleanSessionId = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '');
    const prefixedSessionId = `${socket.userId}_${cleanSessionId}`;
    try {
      await sessionManager.deleteSession(prefixedSessionId, io);
    } catch (err) {
      console.error(`[Socket] Delete error for ${prefixedSessionId}:`, err.message);
      socket.emit('session-error', { sessionId: cleanSessionId, message: err.message });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
  });
});

// Start the HTTP and WebSocket Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`  HANDCAP WhatsApp API Gateway listening on port ${PORT}`);
  console.log(`  Dashboard URL: http://localhost:${PORT}`);
  console.log(`===================================================`);

  // Auto-load pre-existing WhatsApp sessions on startup (non-blocking)
  sessionManager.autoLoadSessions(io);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Process terminated.');
  });
});
