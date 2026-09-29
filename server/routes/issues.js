const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { listIssuesWithOccurrences, isSimilar } = require('../issues');

const router = express.Router();
router.use(requireAuth);

const VALID_STATUSES = new Set(['open', 'improving', 'resolved']);

// GET /api/issues — active recurring issues for this user, each with the
// record dates it traces back to (evidence linking), most-repeated first.
// Resolved items stay in the database for the 7-day recap, but they leave
// this list so the tracking page does not accumulate closed cards.
router.get('/', async (req, res) => {
  const issues = await listIssuesWithOccurrences(req.userId);
  res.json(issues.filter((issue) => issue.status !== 'resolved'));
});

// PATCH /api/issues/:id  { status } — the ONLY way an issue's status changes.
// There is no AI call anywhere in this file; the user is always the one
// deciding whether something is improving, resolved, or still open.
router.patch('/:id', async (req, res) => {
  const { status } = req.body || {};
  if (!VALID_STATUSES.has(status)) return res.status(400).json({ error: '状态不合法' });
  const issue = await db.get('SELECT id, text, status FROM issues WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (!issue) return res.status(404).json({ error: '未找到该问题' });
  const siblings = await db.all(
    "SELECT id, text FROM issues WHERE user_id = ? AND status != 'resolved'",
    [req.userId]
  );
  const ids = siblings
    .filter((row) => row.id === issue.id || isSimilar(issue.text, row.text) || isSimilar(row.text, issue.text))
    .map((row) => row.id);
  if (!ids.includes(issue.id)) ids.push(issue.id);
  await db.run(
    `UPDATE issues SET status = ?, updated_at = ? WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    [status, Date.now(), req.userId, ...ids]
  );
  res.json({ ok: true, ids });
});

module.exports = router;
