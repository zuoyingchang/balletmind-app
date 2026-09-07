const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logEvent } = require('../events');
const { processRecordForIssues } = require('../issues');
const { checkMilestone } = require('../milestones');

const router = express.Router();
router.use(requireAuth);

router.post('/', async (req, res) => {
  const {
    className, transcript, good_points, improve_points,
    next_time_reminder, confidence_level, note, durationSec, edited,
  } = req.body || {};
  const info = await db.run(
    `INSERT INTO records
      (user_id, class_name, transcript, good_points, improve_points, next_time_reminder, confidence_level, note, duration_sec, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.userId, className || '训练记录', transcript || '', good_points || '', improve_points || '',
      next_time_reminder || '', confidence_level || '', note || '', durationSec || 0, Date.now(),
    ]
  );
  await logEvent(req.userId, 'save_record', { recordId: info.lastInsertRowid });
  await logEvent(req.userId, 'user_edit_ai_result', { edited: !!edited });
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
