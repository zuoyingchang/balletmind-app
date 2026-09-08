const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { listIssuesWithOccurrences } = require('../issues');
const { splitLines } = require('../lib/text');

const router = express.Router();
router.use(requireAuth);

const DAY_MS = 24 * 60 * 60 * 1000;

// GET /api/progress/review?days=7 | ?last=5 — Training Review (V0.2 #2).
// User-triggered, not a background job — this just aggregates data that's
// already in the database. Zero LLM calls.
router.get('/review', async (req, res) => {
  const useLast = req.query.last !== undefined && req.query.last !== '';
  const lastCount = useLast ? Math.min(20, Math.max(1, Number(req.query.last) || 5)) : null;
  const days = useLast ? null : Math.max(1, Number(req.query.days) || 7);

  let records;
  let since;
  if (useLast) {
    records = await db.all(
      'SELECT id, class_name, good_points, created_at FROM records WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      [req.userId, lastCount]
    );
    records.reverse();
    since = records.length ? records[0].created_at : Date.now();
  } else {
    since = Date.now() - days * DAY_MS;
    records = await db.all(
      'SELECT id, class_name, good_points, created_at FROM records WHERE user_id = ? AND created_at >= ? ORDER BY created_at ASC',
      [req.userId, since]
    );
  }

  const issues = await listIssuesWithOccurrences(req.userId);
  const openIssues = issues.filter((i) => i.status !== 'resolved');
  const resolvedInPeriod = issues.filter((i) => i.status === 'resolved' && i.updated_at >= since);

  const goodPointsRecap = [...new Set(records.flatMap((r) => splitLines(r.good_points)))];

  res.json({
    mode: useLast ? 'last' : 'days',
    periodDays: days,
    lastCount,
    recordCount: records.length,
    records: records.map((r) => ({ id: r.id, className: r.class_name, createdAt: r.created_at })),
    openIssues,
    resolvedInPeriod,
    goodPointsRecap,
  });
});

// GET /api/progress/brief — Pre-Class Brief (V0.2 #3).
// Default view renders entirely from local data (0 LLM calls), per the spec.
router.get('/brief', async (req, res) => {
  const issues = await listIssuesWithOccurrences(req.userId);
  const topIssues = issues
    .filter((i) => i.status !== 'resolved')
    .sort((a, b) => b.occurrence_count - a.occurrence_count)
    .slice(0, 3);

  const lastRecord = await db.get(
    'SELECT class_name, next_time_reminder, created_at FROM records WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
    [req.userId]
  );

  res.json({
    topIssues,
    lastRecord: lastRecord
      ? { className: lastRecord.class_name, nextTimeReminder: lastRecord.next_time_reminder, createdAt: lastRecord.created_at }
      : null,
  });
});

module.exports = router;
