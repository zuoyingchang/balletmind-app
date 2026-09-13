const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { listIssuesWithOccurrences } = require('../issues');
const { splitLines, sessionIdFromReq, withSession } = require('../lib/text');
const { logEvent, countAiCallsToday } = require('../events');
const { DAILY_AI_LIMIT } = require('../config');
const { callAskWithRetry, findToolUse, answerFromToolInput } = require('../ai/anthropic');
const { searchRecordsByQuestion } = require('../../public/js/ballet-terms');

const router = express.Router();
router.use(requireAuth);

const DAY_MS = 24 * 60 * 60 * 1000;
const dateLabel = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}月${d.getDate()}日`; };

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
    'SELECT class_name, next_time_reminder, improve_points, created_at FROM records WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
    [req.userId]
  );

  res.json({
    topIssues,
    // improvePoints rides along so the frontend can always show *something*
    // useful even when there's no repeat issue yet — falls back to the
    // user's own last "could improve" note. Still zero LLM calls.
    lastRecord: lastRecord
      ? {
          className: lastRecord.class_name,
          nextTimeReminder: lastRecord.next_time_reminder,
          improvePoints: lastRecord.improve_points,
          createdAt: lastRecord.created_at,
        }
      : null,
  });
});

// GET /api/progress/ask?q=... — "问问你的档案" (ask-your-archive).
// Retrieval is pure keyword overlap over the user's own confirmed records —
// zero AI, zero cost. Claude is only called when retrieval actually found
// something to answer from, and only ever sees those matched records, never
// the full archive. Shares the same DAILY_AI_LIMIT as review generation
// (see events.js QUOTA_EVENTS) — its per-call cost is small enough that a
// second quota wasn't worth the extra config surface.
router.get('/ask', async (req, res) => {
  const question = (req.query.q || '').trim();
  if (!question) return res.status(400).json({ error: '请输入问题' });
  if (question.length > 200) return res.status(400).json({ error: '问题太长了，精简一下' });

  const rows = await db.all(
    'SELECT id, class_name, good_points, improve_points, next_time_reminder, created_at FROM records WHERE user_id = ? ORDER BY created_at DESC',
    [req.userId]
  );
  const matches = searchRecordsByQuestion(rows, question, 3);
  if (matches.length === 0) {
    return res.json({ answered: false, answer: '档案里还没有找到相关记录。', citedRecordIds: [], matchedRecords: [] });
  }

  const sessionId = sessionIdFromReq(req);
  if ((await countAiCallsToday(req.userId)) >= DAILY_AI_LIMIT) {
    await logEvent(req.userId, 'ask_fail', withSession({ reason: 'quota_exceeded' }, sessionId));
    return res.status(429).json({ error: '今天的AI调用次数已经用完了，明天再问吧' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: '服务器未配置 ANTHROPIC_API_KEY，请检查 .env 文件' });
  }

  const recordsForPrompt = matches.map((r) => ({ ...r, dateLabel: dateLabel(r.created_at) }));
  const startedAt = Date.now();
  try {
    const { response, error, attempt } = await callAskWithRetry(question, recordsForPrompt);
    const latencyMs = Date.now() - startedAt;

    if (error) {
      const reason = error.message === 'timeout' ? 'timeout' : 'network_error';
      await logEvent(req.userId, 'ask_fail', withSession({ reason, attempt, latencyMs }, sessionId));
      return res.status(504).json({ error: reason === 'timeout' ? 'AI处理超时，请重新尝试' : 'AI服务连接失败，请重新尝试' });
    }
    if (!response.ok) {
      await logEvent(req.userId, 'ask_fail', withSession({ reason: 'api_error', status: response.status, attempt, latencyMs }, sessionId));
      return res.status(502).json({ error: 'AI服务调用失败，请重新尝试' });
    }

    const data = await response.json();
    const toolUse = findToolUse(data);
    if (!toolUse) {
      await logEvent(req.userId, 'ask_fail', withSession({ reason: 'no_tool_use', attempt, latencyMs }, sessionId));
      return res.status(502).json({ error: 'AI未返回有效内容' });
    }

    const answer = answerFromToolInput(toolUse.input);
    await logEvent(req.userId, 'ask_success', withSession({
      attempt, latencyMs,
      answered: answer.answered,
      matchCount: matches.length,
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
    }, sessionId));

    const citedIds = new Set(answer.citedRecordIds);
    res.json({
      ...answer,
      matchedRecords: matches
        .filter((r) => citedIds.has(r.id))
        .map((r) => ({ id: r.id, className: r.class_name, createdAt: r.created_at })),
    });
  } catch (e) {
    await logEvent(req.userId, 'ask_fail', withSession({ reason: 'exception', latencyMs: Date.now() - startedAt }, sessionId));
    res.status(500).json({ error: '服务器错误', detail: e.message });
  }
});

module.exports = router;
