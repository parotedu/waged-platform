const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'waged-super-secure-secret-key-2026-production';

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

// Express middleware
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
  requireAuth
};
