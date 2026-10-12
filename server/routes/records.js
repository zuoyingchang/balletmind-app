const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logEvent, logEmbeddingUsage } = require('../events');
const { sessionIdFromReq, withSession } = require('../lib/text');
const { processRecordForIssues, removeRecordFromIssues } = require('../issues');
const { checkMilestone } = require('../milestones');
const { embedTextsOpenAI, recordCorpus } = require('../ai/ask-retrieve');
const { useCard, releaseRecordUsages, CardError } = require('../lib/cards');
const { normalizePractice, DEFAULT_PRACTICE, practiceFromReq, practiceWhere } = require('../lib/practice');

function recordPractice(req) {
  return normalizePractice(req.body && req.body.practice) || DEFAULT_PRACTICE;
}

const router = express.Router();
router.use(requireAuth);

// 补记：client may send classAt (ms) to file the record under an earlier day.
// Missing = now. A few minutes of clock skew into the future is clamped to now.
const DAY_MS = 24 * 60 * 60 * 1000;
const BACKFILL_MAX_DAYS = 30;
const FUTURE_SKEW_MS = 10 * 60 * 1000;
function classAtFromReq(req) {
  const raw = req.body && req.body.classAt;
  const now = Date.now();
  if (raw === undefined || raw === null || raw === '') return { at: now };
  const at = Number(raw);
  if (!Number.isFinite(at) || at <= 0) return { error: '上课日期不对，请重新选一下' };
  if (at > now + FUTURE_SKEW_MS) return { error: '上课日期不能选以后的日子' };
  if (at < now - (BACKFILL_MAX_DAYS + 1) * DAY_MS) return { error: `只能补记最近 ${BACKFILL_MAX_DAYS} 天的课` };
  return { at: Math.min(at, now), backfillDays: Math.floor((now - at) / DAY_MS) };
}

// Optional 扣课卡 on save. The record is already saved by the time this runs, so a
// card problem (used up, deleted meanwhile) is reported next to the id instead of
// failing the save.
async function deductCardWithRecord(req, recordId, from, usedAt) {
  const cardId = req.body && req.body.cardId;
  if (cardId === undefined || cardId === null || cardId === '') return {};
  try {
    const { usageId, card } = await useCard(req.userId, cardId, { recordId: Number(recordId), usedAt, practice: recordPractice(req) });
    await logEvent(req.userId, 'card_used', { from });
    return { cardUsage: { usageId, card } };
  } catch (e) {
    if (e instanceof CardError) return { cardError: e.message };
    throw e;
  }
}

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
function cacheRecordEmbedding(userId, recordId, record) {
  if (process.env.NODE_TEST_CONTEXT) return;
  const corpus = recordCorpus(record);
  if (!corpus) return;
  embedTextsOpenAI([corpus], { onUsage: (u) => logEmbeddingUsage(userId, 'save', u) })
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
  const classAt = classAtFromReq(req);
  if (classAt.error) return res.status(400).json({ error: classAt.error });
  const info = await db.run(
    `INSERT INTO records
      (user_id, class_name, transcript, good_points, improve_points, next_time_reminder, session_tips, confidence_level, note, duration_sec, created_at, training_duration_min, mood, is_checkin_only, practice)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      req.userId, className || '训练记录', transcript || '', good, improve,
      next_time_reminder || '', session_tips || '', confidence_level || '', note || '', durationSec || 0, classAt.at, trainingMin, moodValue,
      recordPractice(req),
    ]
  );
  await logEvent(req.userId, 'save_record', withSession({
    recordId: info.lastInsertRowid,
    from,
    slotsFilled,
    durationSec: Number(durationSec) || 0,
    ...(classAt.backfillDays !== undefined ? { backfillDays: classAt.backfillDays } : {}),
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
  await processRecordForIssues(req.userId, info.lastInsertRowid, improve, recordPractice(req));
  const milestone = await checkMilestone(req.userId, { source: 'recap', practice: recordPractice(req) });
  const card = await deductCardWithRecord(req, info.lastInsertRowid, 'recap', classAt.at);
  res.json({ id: info.lastInsertRowid, milestone, ...card });
  cacheRecordEmbedding(req.userId, info.lastInsertRowid, {
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
  const classAt = classAtFromReq(req);
  if (classAt.error) return res.status(400).json({ error: classAt.error });
  const info = await db.run(
    `INSERT INTO records
      (user_id, class_name, transcript, good_points, improve_points, next_time_reminder, session_tips, confidence_level, note, duration_sec, created_at, training_duration_min, mood, is_checkin_only, practice)
    VALUES (?, ?, '', '', '', '', '', '', '', 0, ?, ?, ?, 1, ?)`,
    [req.userId, name, classAt.at, trainingMin, moodValue, recordPractice(req)]
  );
  await logEvent(req.userId, 'checkin_saved', withSession({
    recordId: info.lastInsertRowid, from: 'checkin', slotsFilled: 0,
    ...(classAt.backfillDays !== undefined ? { backfillDays: classAt.backfillDays } : {}),
  }, sessionIdFromReq(req)));
  const milestone = await checkMilestone(req.userId, { source: 'checkin', practice: recordPractice(req) });
  const card = await deductCardWithRecord(req, info.lastInsertRowid, 'checkin', classAt.at);
  res.json({ id: info.lastInsertRowid, milestone, ...card });
  cacheRecordEmbedding(req.userId, info.lastInsertRowid, { class_name: name });
});

router.get('/', async (req, res) => {
  const rows = await db.all(
    `SELECT * FROM records WHERE user_id = ? AND ${practiceWhere()} ORDER BY created_at DESC`,
    [req.userId, practiceFromReq(req)]
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const row = await db.get('SELECT * FROM records WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (!row) return res.status(404).json({ error: '未找到记录' });
  res.json(row);
});

router.delete('/:id', async (req, res) => {
  const mine = await db.get('SELECT id FROM records WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  let cardClassesReturned = 0;
  if (mine) {
    await removeRecordFromIssues(req.userId, mine.id);
    cardClassesReturned = await releaseRecordUsages(req.userId, mine.id);
    await db.run('DELETE FROM records WHERE id = ? AND user_id = ?', [mine.id, req.userId]);
  }
  res.json({ ok: true, cardClassesReturned });
});

module.exports = router;
