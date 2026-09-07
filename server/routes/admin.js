const express = require('express');
const db = require('../db');
const { ADMIN_KEY } = require('../config');

const router = express.Router();

// Gated by a separate admin key (not a user account) — the events table spans
// every user, so a regular logged-in user must never be able to read it.
function requireAdminKey(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: '管理统计功能未配置 ADMIN_KEY' });
  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) return res.status(401).json({ error: '管理密钥不对' });
  next();
}

router.get('/stats', requireAdminKey, async (req, res) => {
  const eventCounts = await db.all(`
    SELECT event_name, COUNT(*) AS count FROM events GROUP BY event_name
  `);
  const countOf = (name) => eventCounts.find((e) => e.event_name === name)?.count || 0;

  const aiSuccess = countOf('ai_process_success');
  const aiFail = countOf('ai_process_fail');
  const aiTotal = aiSuccess + aiFail;

  const editEvents = await db.all(`
    SELECT metadata FROM events WHERE event_name = 'user_edit_ai_result'
  `);
  const editedCount = editEvents.filter((r) => {
    try { return JSON.parse(r.metadata || '{}').edited === true; } catch (e) { return false; }
  }).length;

  // Token/latency numbers come straight from ai_process_success metadata
  // (routes/generate.js logs Anthropic's own usage.input_tokens/output_tokens
  // and the call's wall-clock time on every successful call) — this is the
  // only place actual AI cost/speed is visible instead of an unknown bill.
  const successEvents = await db.all(
    "SELECT metadata FROM events WHERE event_name = 'ai_process_success'"
  );
  const usage = successEvents.reduce((acc, r) => {
    try {
      const m = JSON.parse(r.metadata || '{}');
      if (typeof m.inputTokens === 'number') acc.inputTokens += m.inputTokens;
      if (typeof m.outputTokens === 'number') acc.outputTokens += m.outputTokens;
      if (typeof m.latencyMs === 'number') acc.latencies.push(m.latencyMs);
    } catch (e) {}
    return acc;
  }, { inputTokens: 0, outputTokens: 0, latencies: [] });
  const avgLatencyMs = usage.latencies.length
    ? Math.round(usage.latencies.reduce((a, b) => a + b, 0) / usage.latencies.length)
    : null;

  const [usersCount, recordsCount, eventsCount] = await Promise.all([
    db.get('SELECT COUNT(*) AS c FROM users'),
    db.get('SELECT COUNT(*) AS c FROM records'),
    db.get('SELECT COUNT(*) AS c FROM events'),
  ]);
  const totals = { users: usersCount.c, records: recordsCount.c, events: eventsCount.c };

  const recentEvents = await db.all(`
    SELECT event_name, metadata, created_at FROM events ORDER BY id DESC LIMIT 30
  `);

  res.json({
    totals,
    eventCounts: Object.fromEntries(eventCounts.map((e) => [e.event_name, e.count])),
    metrics: {
      aiProcessSuccessRate: aiTotal ? Math.round((aiSuccess / aiTotal) * 1000) / 10 : null,
      editRate: editEvents.length ? Math.round((editedCount / editEvents.length) * 1000) / 10 : null,
      recordCompletionRate: countOf('record_voice_start')
        ? Math.round((countOf('save_record') / countOf('record_voice_start')) * 1000) / 10
        : null,
    },
    aiUsage: {
      totalInputTokens: usage.inputTokens,
      totalOutputTokens: usage.outputTokens,
      avgLatencyMs,
      callCount: usage.latencies.length,
    },
    recentEvents,
  });
});

module.exports = router;
