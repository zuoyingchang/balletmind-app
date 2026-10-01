const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logEvent } = require('../events');
const { sessionIdFromReq, withSession } = require('../lib/text');
const { processRecordForIssues, removeRecordFromIssues } = require('../issues');
const { checkMilestone } = require('../milestones');
const { embedTextsOpenAI, recordCorpus } = require('../ai/ask-retrieve');

const router = express.Router();
router.use(requireAuth);

// Best-effort, fire-and-forget: cache this record's embedding at save time so
// 问问我的档案's embedding fallback (ai/ask-retrieve.js embeddingHits) never
// has to re-embed it live. Never awaited by a caller -- a slow or failed
// OpenAI call must not delay "save my class" or fail the save; a record
// without a cached embedding just falls back to being embedded live, same as
// every record did before this existed.
// Skipped under the test runner (NODE_TEST_CONTEXT, same signal
// routes/auth.js already uses): it's an unawaited background call, so it
// would race every other test's assertions against the shared OpenAI-fetch
// mock. The caching mechanism itself has its own dedicated tests instead.
function cacheRecordEmbedding(recordId, record) {
  if (process.env.NODE_TEST_CONTEXT) return;
  const corpus = recordCorpus(record);
  if (!corpus) return;
  embedTextsOpenAI([corpus])
    .then(([vector]) => db.run('UPDATE records SET embedding = ? WHERE id = ?', [JSON.stringify(vector), recordId]))
    .catch(() => {});
}

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
  const slotsFilled = [good_points, improve_points, next_time_reminder, session_tips]
    .filter((s) => String(s || '').trim()).length;
  const fromClient = req.body && req.body.from;
  // 'manual' = 手动记: typed straight into structured good/improve fields,
  // no AI call at all -- distinct from 'typed' (typed into the free-text box
  // that still gets AI-structured via /api/generate).
  const from = (fromClient === 'voice' || fromClient === 'typed' || fromClient === 'mixed' || fromClient === 'manual')
    ? fromClient
    : (Number(durationSec) > 0 ? 'voice' : 'typed');
  const good = String(good_points || '').trim();
  const improve = String(improve_points || '').trim();
  if (!good) return res.status(400).json({ error: '「做得好的」是必选，先写一句' });
  if (!improve) return res.status(400).json({ error: '「还要改的」是必选，先写一句' });
  const info = await db.run(
    `INSERT INTO records
      (user_id, class_name, transcript, good_points, improve_points, next_time_reminder, session_tips, confidence_level, note, duration_sec, created_at, training_duration_min, mood, is_checkin_only)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      req.userId, className || '训练记录', transcript || '', good, improve,
      next_time_reminder || '', session_tips || '', confidence_level || '', note || '', durationSec || 0, Date.now(), trainingMin, moodValue,
    ]
  );
  await logEvent(req.userId, 'save_record', withSession({
    recordId: info.lastInsertRowid,
    from,
    slotsFilled,
    durationSec: Number(durationSec) || 0,
  }, sessionId));
  await logEvent(req.userId, 'session_confirmed', withSession({
    recordId: info.lastInsertRowid,
    from,
    slotsFilled,
  }, sessionId));
  await logEvent(req.userId, 'user_edit_ai_result', withSession({
    edited: !!edited,
    editedFields: fields,
  }, sessionId));
  for (const field_name of fields) {
    await logEvent(req.userId, 'field_edited', withSession({ field_name }, sessionId));
  }
  await processRecordForIssues(req.userId, info.lastInsertRowid, improve);
  const milestone = await checkMilestone(req.userId, { source: 'recap' });
  res.json({ id: info.lastInsertRowid, milestone });
  cacheRecordEmbedding(info.lastInsertRowid, {
    class_name: className || '训练记录', good_points: good, improve_points: improve, next_time_reminder: next_time_reminder || '',
  });
});

// Lightweight check-in: trained today, no recording, no AI, no Layer 3 completion.
// Multiple sessions per local day are allowed (different classes, or the same class twice).
router.post('/checkin', async (req, res) => {
  const { className, trainingDurationMin, mood } = req.body || {};
  const trainingMin = Number.isFinite(trainingDurationMin) && trainingDurationMin > 0
    ? Math.round(trainingDurationMin)
    : null;
  const MOOD_VALUES = new Set(['low', 'meh', 'good', 'great']);
  const moodValue = MOOD_VALUES.has(mood) ? mood : null;
  const name = String(className || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: '「课程/组合」是必选，先填一下' });
  const info = await db.run(
    `INSERT INTO records
      (user_id, class_name, transcript, good_points, improve_points, next_time_reminder, session_tips, confidence_level, note, duration_sec, created_at, training_duration_min, mood, is_checkin_only)
    VALUES (?, ?, '', '', '', '', '', '', '', 0, ?, ?, ?, 1)`,
    [req.userId, name, Date.now(), trainingMin, moodValue]
  );
  await logEvent(req.userId, 'checkin_saved', withSession({
    recordId: info.lastInsertRowid, from: 'checkin', slotsFilled: 0,
  }, sessionIdFromReq(req)));
  const milestone = await checkMilestone(req.userId, { source: 'checkin' });
  res.json({ id: info.lastInsertRowid, milestone });
  cacheRecordEmbedding(info.lastInsertRowid, { class_name: name });
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
  const mine = await db.get('SELECT id FROM records WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (mine) {
    await removeRecordFromIssues(req.userId, mine.id);
    await db.run('DELETE FROM records WHERE id = ? AND user_id = ?', [mine.id, req.userId]);
  }
  res.json({ ok: true });
});

module.exports = router;
