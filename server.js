require('dotenv').config();
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const db = require('./src/db');
const authRoutes = require('./src/routes/authRoutes');
const itemRoutes = require('./src/routes/itemRoutes');
const scanRoutes = require('./src/routes/scanRoutes');
const chatRoutes = require('./src/routes/chatRoutes');
const subscriptionRoutes = require('./src/routes/subscriptionRoutes');
const telegramRoutes = require('./src/routes/telegramRoutes');
const adminRoutes = require('./src/routes/adminRoutes');
const { syncExpiredSubscriptions } = require('./src/subscriptionSync');
const { BOT_TOKEN, setupTelegramWebhook, startTelegramPolling, stopTelegramPolling } = require('./src/telegram');
const setupSocket = require('./src/socket');

const app = express();
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGIN || true,
    credentials: true,
    methods: ['GET', 'POST']
  }
});

app.set('io', io);
setupSocket(io);

const isProd = process.env.NODE_ENV === 'production';
app.use(helmet({
  hsts: isProd,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      upgradeInsecureRequests: isProd ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'تم تجاوز الحد المسموح من الطلبات، يرجى المحاولة لاحقاً.' }
});

const scanLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 45,
  message: { error: 'طلبات كثيرة جداً، يرجى الانتظار قليلاً.' }
});

app.use('/api/', apiLimiter);
app.use('/api/scan/', scanLimiter);

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/items', itemRoutes);
app.use('/api/scan', scanRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/telegram', telegramRoutes);
app.use('/api/admin', adminRoutes);

// Health check
app.get('/api/health', async (req, res) => {
  try {
    await db.get('SELECT 1 as ok');
    res.json({
      status: 'ok',
      db: db.isPostgres ? 'postgresql' : 'sqlite',
      platform: 'Waged',
      version: '2.3.0',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

// Serve frontend static assets
app.use(express.static(path.join(__dirname, 'public')));

// Fallback to index.html for non-API GET requests
app.use((req, res) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  res.status(404).json({ error: 'المسار غير موجود' });
});

const PORT = process.env.PORT || 4000;

async function startServer() {
  await db.initDb();
  await syncExpiredSubscriptions(io, true);

  // Periodically check and lock expired paid subscriptions every 5 minutes
  const expiryTimer = setInterval(() => {
    syncExpiredSubscriptions(io, true).catch(console.error);
  }, 5 * 60 * 1000);
  expiryTimer.unref();

  server.listen(PORT, () => {
    const publicUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    console.log(`===============================================`);
    console.log(`منصة واجد (Waged) تعمل الآن بنجاح!`);
    console.log(`الرابط: ${publicUrl}`);
    console.log(`لوحة التفعيل والإدارة: ${publicUrl}/admin.html`);
    console.log(`===============================================`);

    if (BOT_TOKEN) {
      if (publicUrl.startsWith('https://')) {
        setupTelegramWebhook(publicUrl).catch(console.error);
      } else if (process.env.TELEGRAM_POLLING !== 'false') {
        startTelegramPolling();
      }
    }
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

function shutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  stopTelegramPolling();
  server.close(async () => {
    try {
      await db.closeDb();
    } catch (e) {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
