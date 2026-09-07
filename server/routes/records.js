const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.post('/', (req, res) => {
  const {
    className, transcript, good_points, improve_points,
    next_time_reminder, confidence_level, note, durationSec,
  } = req.body || {};
  const stmt = db.prepare(`
    INSERT INTO records
      (user_id, class_name, transcript, good_points, improve_points, next_time_reminder, confidence_level, note, duration_sec, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    req.userId, className || '训练记录', transcript || '', good_points || '', improve_points || '',
    next_time_reminder || '', confidence_level || '', note || '', durationSec || 0, Date.now()
  );
  res.json({ id: info.lastInsertRowid });
});

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM records WHERE user_id = ? ORDER BY created_at DESC').all(req.userId);
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM records WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!row) return res.status(404).json({ error: '未找到记录' });
  res.json(row);
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM records WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

module.exports = router;
