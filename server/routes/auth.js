const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const {
  RESEND_API_KEY, EMAIL_FROM, APP_PUBLIC_URL, RESET_TOKEN_TTL_MS,
} = require('../config');
const { requireAuth, signToken } = require('../middleware/auth');
const { logAuth } = require('../lib/log');
const { loginLimiter, registerLimiter, forgotLimiter, resetLimiter, deleteAccountLimiter } = require('../middleware/rate-limit');
const { normalizeEmail, isValidEmail } = require('../lib/email-format');

const router = express.Router();

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function userPublic(user, email, displayName) {
  return {
    id: user.id,
    email: email ?? user.email,
    displayName: displayName ?? user.display_name,
  };
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

router.post('/register', registerLimiter, async (req, res) => {
  const { email, password, displayName, privacyAccepted } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '请填写邮箱和密码' });
  if (!isValidEmail(email)) return res.status(400).json({ error: '邮箱格式不对' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  if (!privacyAccepted) return res.status(400).json({ error: '请先阅读并同意隐私政策' });
  const normalized = normalizeEmail(email);
  const existing = await db.get('SELECT id FROM users WHERE email = ?', [normalized]);
  if (existing) return res.status(409).json({ error: '这个邮箱已经注册过了' });
  const name = displayName || email.split('@')[0];
  const passwordHash = await bcrypt.hash(password, 10);
  const info = await db.run(
    'INSERT INTO users (email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?)',
    [normalized, passwordHash, name, Date.now()]
  );
  const id = info.lastInsertRowid;
  logAuth('register', { user: id });
  res.json({ token: signToken(id), user: { id, email: normalized, displayName: name } });
});

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '请填写邮箱和密码' });
  if (!isValidEmail(email)) return res.status(400).json({ error: '邮箱格式不对' });
  const user = await db.get('SELECT * FROM users WHERE email = ?', [normalizeEmail(email)]);
  if (!user) { logAuth('login_failed', { reason: 'no_such_user', ip: req.ip }); return res.status(401).json({ error: '邮箱或密码不对' }); }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) { logAuth('login_failed', { reason: 'bad_password', user: user.id, ip: req.ip }); return res.status(401).json({ error: '邮箱或密码不对' }); }
  res.json({ token: signToken(user.id), user: userPublic(user) });
});

router.get('/me', requireAuth, async (req, res) => {
  const user = await db.get('SELECT id, email, display_name, created_at FROM users WHERE id = ?', [req.userId]);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ id: user.id, email: user.email, display_name: user.display_name, displayName: user.display_name, createdAt: user.created_at });
});

// Always 200 with the same message so we don't leak whether an email is registered.
router.post('/forgot-password', forgotLimiter, async (req, res) => {
  const email = (req.body || {}).email;
  const generic = { ok: true, message: '如果这个邮箱已经注册，我们会发送重置链接' };
  if (!email || !String(email).trim()) return res.status(400).json({ error: '请填写邮箱' });
  if (!isValidEmail(email)) return res.status(400).json({ error: '邮箱格式不对' });

  const user = await db.get('SELECT id, email FROM users WHERE email = ?', [normalizeEmail(email)]);
  if (!user) return res.json(generic);

  const rawToken = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  await db.run(
    'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)',
    [user.id, hashToken(rawToken), now + RESET_TOKEN_TTL_MS, now]
  );
  const resetUrl = `${publicBase(req)}/reset.html?token=${rawToken}`;
  logAuth('password_reset_requested', { user: user.id });

  try {
    const emailed = await sendResetEmail(user.email, resetUrl);
    if (emailed) return res.json(generic);
  } catch (e) {
    console.error('[ALERT][email] reset email failed:', String(e.message).slice(0, 300));
    return res.status(502).json({ error: '重置邮件发送失败，请稍后再试' });
  }

  // No email provider: expose the URL only in non-production so local/tests work.
  if (process.env.NODE_ENV !== 'production') {
    return res.json({ ...generic, resetUrl });
  }
  res.json(generic);
});

router.post('/reset-password', resetLimiter, async (req, res) => {
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

// Data portability: everything the user wrote, as one JSON file.
router.get('/export', requireAuth, async (req, res) => {
  const user = await db.get('SELECT id, email, display_name, created_at FROM users WHERE id = ?', [req.userId]);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const [records, issues, occurrences, corrections] = await Promise.all([
    db.all('SELECT * FROM records WHERE user_id = ? ORDER BY created_at ASC', [req.userId]),
    db.all('SELECT * FROM issues WHERE user_id = ? ORDER BY created_at ASC', [req.userId]),
    db.all(
      `SELECT io.* FROM issue_occurrences io
       JOIN issues i ON i.id = io.issue_id WHERE i.user_id = ?`,
      [req.userId]
    ),
    db.all('SELECT * FROM term_corrections WHERE user_id = ?', [req.userId]),
  ]);
  res.set('Content-Disposition', 'attachment; filename="balletmind-export.json"');
  res.json({ exportedAt: Date.now(), user, records, issues, issueOccurrences: occurrences, termCorrections: corrections });
});

router.delete('/account', requireAuth, deleteAccountLimiter, async (req, res) => {
  const password = (req.body || {}).password;
  if (!password) return res.status(400).json({ error: '请输入密码以确认注销' });

  const user = await db.get('SELECT id, password_hash FROM users WHERE id = ?', [req.userId]);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    logAuth('account_delete_failed', { user: req.userId, reason: 'bad_password' });
    return res.status(403).json({ error: '密码不对' });
  }

  const uid = req.userId;
  await db.run(
    'DELETE FROM issue_occurrences WHERE issue_id IN (SELECT id FROM issues WHERE user_id = ?)',
    [uid]
  );
  await db.run('DELETE FROM issues WHERE user_id = ?', [uid]);
  await db.run('DELETE FROM records WHERE user_id = ?', [uid]);
  await db.run('DELETE FROM term_corrections WHERE user_id = ?', [uid]);
  await db.run('DELETE FROM events WHERE user_id = ?', [uid]);
  await db.run('DELETE FROM password_reset_tokens WHERE user_id = ?', [uid]);
  await db.run('DELETE FROM feedback WHERE user_id = ?', [uid]);
  await db.run('DELETE FROM users WHERE id = ?', [uid]);
  logAuth('account_deleted', { user: uid });
  res.json({ ok: true });
});

module.exports = router;
