const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { listIssuesWithOccurrences } = require('../issues');

const router = express.Router();
router.use(requireAuth);

const VALID_STATUSES = new Set(['open', 'improving', 'resolved']);

// GET /api/issues — recurring issues for this user, each with the record
// dates it traces back to (evidence linking), most-repeated first.
router.get('/', async (req, res) => {
  const issues = await listIssuesWithOccurrences(req.userId);
  res.json(issues);
});

// PATCH /api/issues/:id  { status } — the ONLY way an issue's status changes.
// There is no AI call anywhere in this file; the user is always the one
// deciding whether something is improving, resolved, or still open.
router.patch('/:id', async (req, res) => {
  const { status } = req.body || {};
  if (!VALID_STATUSES.has(status)) return res.status(400).json({ error: '状态不合法' });
  const issue = await db.get('SELECT id FROM issues WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (!issue) return res.status(404).json({ error: '未找到该问题' });
  await db.run('UPDATE issues SET status = ?, updated_at = ? WHERE id = ?', [status, Date.now(), req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
