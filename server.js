require('dotenv').config();
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const authRoutes = require('./src/routes/authRoutes');
const itemRoutes = require('./src/routes/itemRoutes');
const scanRoutes = require('./src/routes/scanRoutes');
const chatRoutes = require('./src/routes/chatRoutes');
const subscriptionRoutes = require('./src/routes/subscriptionRoutes');
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

// Attach io to app for access in routes
app.set('io', io);
setupSocket(io);

// Security Headers (Helmet)
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

// CORS & Parsing
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Global Rate Limiter to protect from DDoS & brute force
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 400,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'تم تجاوز الحد المسموح من الطلبات، يرجى المحاولة لاحقاً.' }
});

const scanLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 40,
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

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    platform: 'Waged (منصة واجد)',
    version: '2.0.0',
    timestamp: new Date().toISOString()
  });
});

// Serve frontend static assets
app.use(express.static(path.join(__dirname, 'public')));

// Fallback to index.html for non-API client navigation
app.use((req, res) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  res.status(404).json({ error: 'المسار غير موجود' });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`🚀 منصة واجد (Waged Platform v2.0) تعمل الآن بنجاح!`);
  console.log(`🌐 الرابط المحلي: http://localhost:${PORT}`);
  console.log(`===============================================`);
});
