const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');

const router = express.Router();

const MAX_MESSAGE = 1000;
const MAX_CONTACT = 100;

const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_FEEDBACK_MAX) || 5,
  keyFn: (req) => `u${req.userId}`,
  message: '反馈发得太频繁了，请稍后再试',
});

router.post('/', requireAuth, feedbackLimiter, async (req, res) => {
  const message = String((req.body || {}).message || '').trim();
  const contact = String((req.body || {}).contact || '').trim().slice(0, MAX_CONTACT);
  if (!message) return res.status(400).json({ error: '请先写点内容再发送' });
  if (message.length > MAX_MESSAGE) return res.status(400).json({ error: `内容太长了（最多${MAX_MESSAGE}字）` });
  const ua = String(req.headers['user-agent'] || '').slice(0, 200);
  await db.run(
    'INSERT INTO feedback (user_id, message, contact, user_agent, created_at) VALUES (?, ?, ?, ?, ?)',
    [req.userId, message, contact || null, ua, Date.now()]
  );
  console.log(`[feedback] new user=${req.userId} chars=${message.length}`);
  res.json({ ok: true });
});

module.exports = router;
