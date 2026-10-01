const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

async function seenFor(userId) {
  const rows = await db.all('SELECT step_id FROM guide_progress WHERE user_id = ?', [userId]);
  return rows.map((r) => r.step_id);
}

// Which onboarding-guide steps this ACCOUNT has already seen. Previously
// tracked only in localStorage, which reset on a new browser/device or after
// a password reset (the user never actually sees the server again on that
// flow) -- the whole point of the one-time guide is that it runs exactly
// once per account, not once per browser.
router.get('/seen', async (req, res) => {
  res.json({ seen: await seenFor(req.userId) });
});

// POST /api/guide/seen { id } -- mark one step seen. A single atomic INSERT
// OR IGNORE, not read-modify-write, so concurrent calls (skipGuide() fires
// ~11 of these near-simultaneously) can't clobber each other.
router.post('/seen', async (req, res) => {
  const id = String((req.body || {}).id || '').trim();
  if (!id) return res.status(400).json({ error: 'missing id' });
  await db.run(
    'INSERT OR IGNORE INTO guide_progress (user_id, step_id, created_at) VALUES (?, ?, ?)',
    [req.userId, id, Date.now()]
  );
  res.json({ seen: await seenFor(req.userId) });
});

// POST /api/guide/seen-batch { ids: [...] } -- mark several at once. Used for
// skipGuide() and for the one-time bridge that uploads a browser's existing
// localStorage progress the first time this account is seen server-side, so
// someone who already finished the guide before this shipped doesn't replay it.
router.post('/seen-batch', async (req, res) => {
  const ids = Array.isArray((req.body || {}).ids)
    ? req.body.ids.filter((x) => typeof x === 'string' && x)
    : [];
  const now = Date.now();
  for (const id of ids) {
    await db.run(
      'INSERT OR IGNORE INTO guide_progress (user_id, step_id, created_at) VALUES (?, ?, ?)',
      [req.userId, id, now]
    );
  }
  res.json({ seen: await seenFor(req.userId) });
});

module.exports = router;
