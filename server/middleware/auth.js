const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');

const TOKEN_TTL = '30d';
const RENEW_WHEN_LEFT_MS = 7 * 24 * 60 * 60 * 1000;

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    // Sliding renewal: an active user is never logged out by the 30-day expiry.
    if (payload.exp && payload.exp * 1000 - Date.now() < RENEW_WHEN_LEFT_MS) {
      res.set('X-New-Token', signToken(payload.userId));
    }
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

module.exports = { requireAuth, signToken };
