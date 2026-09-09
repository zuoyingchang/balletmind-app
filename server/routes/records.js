const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logEvent } = require('../events');
const { sessionIdFromReq, withSession } = require('../lib/text');
const { processRecordForIssues } = require('../issues');
const { checkMilestone } = require('../milestones');

const router = express.Router();
router.use(requireAuth);

router.post('/', async (req, res) => {
  const {
    className, transcript, good_points, improve_points,
    next_time_reminder, session_tips, confidence_level, note, durationSec, edited, editedFields,
    trainingDurationMin, mood,
  } = req.body || {};
  const sessionId = sessionIdFromReq(req);
  const fields = Array.isArray(editedFields)
    ? editedFields.filter((f) => ['good_points', 'improve_points', 'next_time_reminder', 'session_tips'].includes(f))
    : [];
  // User-provided real training duration (minutes), always optional — not to
  // be confused with duration_sec, which is just the voice memo's length.
  const trainingMin = Number.isFinite(trainingDurationMin) && trainingDurationMin > 0
    ? Math.round(trainingDurationMin)
    : null;
  // Self-reported mood, always optional, always the user's own pick — never
  // inferred by AI from the transcript.
  const MOOD_VALUES = new Set(['low', 'meh', 'good', 'great']);
  const moodValue = MOOD_VALUES.has(mood) ? mood : null;
  const info = await db.run(
    `INSERT INTO records
      (user_id, class_name, transcript, good_points, improve_points, next_time_reminder, session_tips, confidence_level, note, duration_sec, created_at, training_duration_min, mood)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.userId, className || '训练记录', transcript || '', good_points || '', improve_points || '',
      next_time_reminder || '', session_tips || '', confidence_level || '', note || '', durationSec || 0, Date.now(), trainingMin, moodValue,
    ]
  );
  await logEvent(req.userId, 'save_record', withSession({ recordId: info.lastInsertRowid }, sessionId));
  await logEvent(req.userId, 'session_confirmed', withSession({ recordId: info.lastInsertRowid }, sessionId));
  await logEvent(req.userId, 'user_edit_ai_result', withSession({
    edited: !!edited,
    editedFields: fields,
  }, sessionId));
  for (const field_name of fields) {
    await logEvent(req.userId, 'field_edited', withSession({ field_name }, sessionId));
  }
  await processRecordForIssues(req.userId, info.lastInsertRowid, improve_points);
  const milestone = await checkMilestone(req.userId);
  res.json({ id: info.lastInsertRowid, milestone });
});

router.get('/', async (req, res) => {
  const rows = await db.all('SELECT * FROM records WHERE user_id = ? ORDER BY created_at DESC', [req.userId]);
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const row = await db.get('SELECT * FROM records WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (!row) return res.status(404).json({ error: '未找到记录' });
  res.json(row);
});

router.delete('/:id', async (req, res) => {
  await db.run('DELETE FROM records WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  res.json({ ok: true });
});

module.exports = router;
