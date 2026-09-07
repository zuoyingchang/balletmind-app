const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const {
  JWT_SECRET, RESEND_API_KEY, EMAIL_FROM, APP_PUBLIC_URL, RESET_TOKEN_TTL_MS,
} = require('../config');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function publicBase(req) {
  if (APP_PUBLIC_URL) return APP_PUBLIC_URL;
  const host = req.get('x-forwarded-host') || req.get('host');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${proto}://${host}`;
}

async function sendResetEmail(to, resetUrl) {
  if (!RESEND_API_KEY) return false;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [to],
      subject: '重置你的 BalletMind 密码',
      html: `<p>你正在重置 BalletMind 密码。</p><p><a href="${resetUrl}">点击这里设置新密码</a></p><p>链接 1 小时内有效。如果不是你本人操作，请忽略这封邮件。</p>`,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`reset email failed: ${response.status} ${detail}`);
  }
  return true;
}

router.post('/register', async (req, res) => {
  const { email, password, displayName, privacyAccepted } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '请填写邮箱和密码' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  if (!privacyAccepted) return res.status(400).json({ error: '请先阅读并同意隐私政策' });
  const existing = await db.get('SELECT id FROM users WHERE email = ?', [email.trim().toLowerCase()]);
  if (existing) return res.status(409).json({ error: '这个邮箱已经注册过了' });
  const passwordHash = await bcrypt.hash(password, 10);
  const info = await db.run(
    'INSERT INTO users (email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?)',
    [email.trim().toLowerCase(), passwordHash, displayName || email.split('@')[0], Date.now()]
  );
  const token = jwt.sign({ userId: info.lastInsertRowid }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: info.lastInsertRowid, email: email.trim().toLowerCase(), displayName: displayName || email.split('@')[0] } });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '请填写邮箱和密码' });
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()]);
  if (!user) return res.status(401).json({ error: '邮箱或密码不对' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: '邮箱或密码不对' });
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, email: user.email, displayName: user.display_name } });
});

router.get('/me', requireAuth, async (req, res) => {
  const user = await db.get('SELECT id, email, display_name, created_at FROM users WHERE id = ?', [req.userId]);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ id: user.id, email: user.email, display_name: user.display_name, displayName: user.display_name, createdAt: user.created_at });
});

// Always 200 with the same message so we don't leak whether an email is registered.
router.post('/forgot-password', async (req, res) => {
  const email = (req.body || {}).email;
  const generic = { ok: true, message: '如果这个邮箱已经注册，我们会发送重置链接' };
  if (!email || !String(email).trim()) return res.status(400).json({ error: '请填写邮箱' });

  const user = await db.get('SELECT id, email FROM users WHERE email = ?', [String(email).trim().toLowerCase()]);
  if (!user) return res.json(generic);

  const rawToken = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  await db.run(
    'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)',
    [user.id, hashToken(rawToken), now + RESET_TOKEN_TTL_MS, now]
  );
  const resetUrl = `${publicBase(req)}/reset.html?token=${rawToken}`;

  try {
    const emailed = await sendResetEmail(user.email, resetUrl);
    if (emailed) return res.json(generic);
  } catch (e) {
    return res.status(502).json({ error: '重置邮件发送失败，请稍后再试' });
  }

  // No email provider: expose the URL only in non-production so local/tests work.
  if (process.env.NODE_ENV !== 'production') {
    return res.json({ ...generic, resetUrl });
  }
  res.json(generic);
});

router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: '缺少重置信息' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });

  const row = await db.get(
    'SELECT * FROM password_reset_tokens WHERE token_hash = ?',
    [hashToken(String(token))]
  );
  if (!row || row.used_at || row.expires_at < Date.now()) {
    return res.status(400).json({ error: '重置链接无效或已过期，请重新申请' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, row.user_id]);
  await db.run('UPDATE password_reset_tokens SET used_at = ? WHERE id = ?', [Date.now(), row.id]);
  res.json({ ok: true });
});

module.exports = router;
