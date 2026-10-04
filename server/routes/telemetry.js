const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { logEvent } = require('../events');
const { sanitizeVisit, sanitizeClientError, sanitizeVid } = require('../lib/telemetry');

const router = express.Router();

const visitLimiter = rateLimit({ windowMs: 60 * 1000, max: Number(process.env.RATE_LIMIT_VISIT_MAX) || 60, message: '请求太频繁了' });
const errorLimiter = rateLimit({ windowMs: 60 * 1000, max: Number(process.env.RATE_LIMIT_CLIENT_ERROR_MAX) || 20, message: '请求太频繁了' });

// Public (no login): the point is to see people who never sign up.
router.post('/visit', visitLimiter, async (req, res) => {
  const v = sanitizeVisit(req.body);
  if (!v) return res.status(400).json({ error: '参数不对' });
  const now = Date.now();
  await db.run(
    `INSERT INTO visitors (vid, first_seen, last_seen, visits, platform, browser, in_app, src, signed_in)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, 0)
     ON CONFLICT(vid) DO UPDATE SET last_seen = excluded.last_seen, visits = visits + 1`,
    [v.vid, now, now, v.platform, v.browser, v.inApp ? 1 : 0, v.src]
  );
  res.json({ ok: true });
});

// A browser that has signed in to (or registered) an account. Marks the anonymous id only; it is
// never linked to a user id.
router.post('/signed-in', requireAuth, async (req, res) => {
  const vid = sanitizeVid(req.body && req.body.vid);
  if (!vid) return res.status(400).json({ error: '参数不对' });
  await db.run('UPDATE visitors SET signed_in = 1 WHERE vid = ? AND signed_in = 0', [vid]);
  res.json({ ok: true });
});

// Public: failures before login (register / login on a flaky network) matter most.
router.post('/error', errorLimiter, async (req, res) => {
  const meta = sanitizeClientError(req.body);
  if (!meta) return res.status(400).json({ error: '参数不对' });
  await logEvent(null, 'client_error', meta);
  res.json({ ok: true });
});

module.exports = router;
