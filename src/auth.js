const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'waged-dev-secret-change-in-production';

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.warn('[Security Warning] JWT_SECRET environment variable is not set in production!');
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 12);
}

function comparePassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

function getCookieOptions(req) {
  const isHttps = Boolean(req.secure || req.headers['x-forwarded-proto'] === 'https');
  return {
    httpOnly: true,
    secure: isHttps,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  };
}

function getBaseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  if (req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.get('host');
    if (host) return `${proto}://${host}`;
  }
  return `http://localhost:${process.env.PORT || 4000}`;
}

function requireAuth(req, res, next) {
  const token = req.cookies.token || (req.headers.authorization && req.headers.authorization.split(' ')[1]);
  if (!token) {
    return res.status(401).json({ error: 'غير مصرح، يرجى تسجيل الدخول' });
  }

  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'انتهت صلاحية الجلسة، سجل دخولك مجدداً' });
  }

  req.user = payload;
  next();
}

module.exports = {
  hashPassword,
  comparePassword,
  generateToken,
  verifyToken,
  getCookieOptions,
  getBaseUrl,
  requireAuth
};
