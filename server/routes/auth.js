const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { JWT_SECRET } = require('../config');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/register', async (req, res) => {
  const { email, password, displayName } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '请填写邮箱和密码' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  const existing = await db.get('SELECT id FROM users WHERE email = ?', [email.trim().toLowerCase()]);
  if (existing) return res.status(409).json({ error: '这个邮箱已经注册过了' });
  const passwordHash = await bcrypt.hash(password, 10);
  const info = await db.run(
    'INSERT INTO users (email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?)',
    [email.trim().toLowerCase(), passwordHash, displayName || email.split('@')[0], Date.now()]
  );
  const token = jwt.sign({ userId: info.lastInsertRowid }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: info.lastInsertRowid, email, displayName: displayName || email.split('@')[0] } });
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
  res.json({ id: user.id, email: user.email, displayName: user.display_name, createdAt: user.created_at });
});

module.exports = router;
