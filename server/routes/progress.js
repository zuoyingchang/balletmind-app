const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { listIssuesWithOccurrences } = require('../issues');
const { splitLines, sessionIdFromReq, withSession } = require('../lib/text');
const { logEvent, countSecondaryAiCallsToday } = require('../events');
const { aiConfigured, missingConfigHint } = require('../ai/provider');
const { dailySecondaryAiLimitFor } = require('../config');
const { callAskRound1WithRetry, callAskRound2WithRetry, findToolUse, answerFromToolInput } = require('../ai/anthropic');
const { llmUsageMeta } = require('../lib/llm-event-meta');
const { retrieveAskRecords, KEYWORD_SPARSE_MAX } = require('../ai/ask-retrieve');
const { isIssueBriefExperimentOn } = require('../experiments/issue-brief-gate');
const { runIssueBriefExperiment } = require('../ai/issue-brief-experiment');

const router = express.Router();
router.use(requireAuth);

const DAY_MS = 24 * 60 * 60 * 1000;
// Year included on purpose — the model has no ground truth for "what year
// is it" otherwise. Verified live: without a year anchor it guessed 2024
// against real 2026 data, and a date-ranged search silently found nothing.
const dateLabel = (ts) => { const d = new Date(ts); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; };

function parseDateInput(input) {
  if (!input || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
  const ms = new Date(`${input}T00:00:00Z`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// The model can ask for a date window (search_records' before/after), but
// it never gets to invent one outside what this user actually has. Each
// bound is clamped into [earliestTs, latestTs] independently — not just
// capped in the one direction that seemed obvious — because a wrong-year
// guess like "2024-08-31" undershoots the *lower* bound just as easily as
// a bad guess could overshoot the upper one; clamping only one direction
// left the other free to invert the range into an empty window (afterTs
// ended up later than beforeTs, so the filter matched nothing). If the
// range still comes out inverted after clamping both ends, fall back to
// the user's full history rather than searching an empty window.
function clampDateRange(after, before, earliestTs, latestTs) {
  const parsedAfter = parseDateInput(after);
  const parsedBefore = parseDateInput(before);
  let afterTs = parsedAfter === null ? earliestTs : Math.min(Math.max(parsedAfter, earliestTs), latestTs);
  let beforeTs = parsedBefore === null ? latestTs : Math.max(Math.min(parsedBefore + DAY_MS - 1, latestTs), earliestTs);
  if (afterTs > beforeTs) { afterTs = earliestTs; beforeTs = latestTs; }
  return { afterTs, beforeTs };
}

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
    `SELECT class_name, next_time_reminder, improve_points, session_tips, good_points, created_at
     FROM records
     WHERE user_id = ? AND COALESCE(is_checkin_only, 0) = 0
     ORDER BY created_at DESC LIMIT 1`,
    [req.userId]
  );

  const lastRecordPayload = lastRecord
    ? {
        className: lastRecord.class_name,
        nextTimeReminder: lastRecord.next_time_reminder,
        improvePoints: lastRecord.improve_points,
        sessionTips: lastRecord.session_tips,
        goodPoints: lastRecord.good_points,
        createdAt: lastRecord.created_at,
      }
    : null;

  const payload = {
    topIssues,
    // improvePoints rides along so the frontend can always show *something*
    // useful even when there's no repeat issue yet — falls back to the
    // user's own last "could improve" note. Default path is still zero LLM.
    lastRecord: lastRecordPayload,
  };

  // Dual gate default-off: no user hits this unless both env vars are set.
  if (isIssueBriefExperimentOn(req.userId) && topIssues.length > 0) {
    const overQuota = (await countSecondaryAiCallsToday(req.userId)) >= dailySecondaryAiLimitFor(req.userId);
    if (!overQuota) {
      const startedAt = Date.now();
      try {
        const result = await runIssueBriefExperiment(topIssues);
        const usedFallback = !result || result.usedFallback || !result.lines || !result.lines.length;
        await logEvent(req.userId, usedFallback ? 'experiment_issue_brief_fail' : 'experiment_issue_brief_success', {
          reason: usedFallback ? 'fallback' : undefined,
          attempts: result && result.attempts,
          latencyMs: Date.now() - startedAt,
        });
        if (!usedFallback) {
          payload.experimentBrief = { lines: result.lines, usedFallback: false };
        }
      } catch (e) {
        await logEvent(req.userId, 'experiment_issue_brief_fail', {
          reason: 'error',
          error: String(e.message || e).slice(0, 200),
          latencyMs: Date.now() - startedAt,
        });
      }
    }
  }

  res.json(payload);
});

// GET /api/progress/ask?q=... — "问问你的档案" (ask-your-archive).
// Retrieval is keyword-first. Embedding runs only when keyword hits are
// 0 or 1 (KEYWORD_SPARSE_MAX) — enough signal (>=2) skips the extra cost.
// Claude is only called after retrieval found something. The one place any
// model autonomy lives: after seeing round 1's matches, the model can ask
// for a second, differently-scoped search (typically a second time window)
// instead of answering immediately. That hop is hard-capped at one.
router.get('/ask', async (req, res) => {
  const question = (req.query.q || '').trim();
  if (!question) return res.status(400).json({ error: '请输入问题' });
  if (question.length > 200) return res.status(400).json({ error: '问题太长了，精简一下' });

  const rows = await db.all(
    'SELECT id, class_name, good_points, improve_points, next_time_reminder, created_at FROM records WHERE user_id = ? ORDER BY created_at DESC',
    [req.userId]
  );
  const keywordRound = await retrieveAskRecords(rows, question, { mode: 'keyword' });
  const sessionId = sessionIdFromReq(req);
  const overQuota = (await countSecondaryAiCallsToday(req.userId)) >= dailySecondaryAiLimitFor(req.userId);

  let round1 = keywordRound;
  if (keywordRound.keywordCount <= KEYWORD_SPARSE_MAX) {
    if (overQuota) {
      if (keywordRound.matches.length === 0) {
        return res.json({
          answered: false,
          answerPoints: ['档案里还没有找到相关记录。'],
          citedRecordIds: [],
          matchedRecords: [],
          retrievalPath: 'none',
        });
      }
      await logEvent(req.userId, 'ask_fail', withSession({ reason: 'quota_exceeded' }, sessionId));
      return res.status(429).json({ error: '今天的AI调用次数已经用完了，明天再问吧' });
    }
    round1 = await retrieveAskRecords(rows, question);
  }

  const round1Matches = round1.matches;
  if (round1Matches.length === 0) {
    return res.json({
      answered: false,
      answerPoints: ['档案里还没有找到相关记录。'],
      citedRecordIds: [],
      matchedRecords: [],
      retrievalPath: round1.retrievalPath,
    });
  }

  if (overQuota) {
    await logEvent(req.userId, 'ask_fail', withSession({ reason: 'quota_exceeded' }, sessionId));
    return res.status(429).json({ error: '今天的AI调用次数已经用完了，明天再问吧' });
  }
  if (!aiConfigured()) {
    console.error(`[ALERT][config] ${missingConfigHint()}`);
    return res.status(500).json({ error: 'AI服务暂时不可用，请稍后再试' });
  }

  const earliestTs = rows.length ? rows[rows.length - 1].created_at : Date.now();
  const latestTs = rows.length ? rows[0].created_at : Date.now();
  const dateRangeLabel = rows.length ? `${dateLabel(earliestTs)} ~ ${dateLabel(latestTs)}` : '（还没有记录）';
  const todayLabel = dateLabel(Date.now());
  const withDateLabel = (r) => ({ ...r, dateLabel: dateLabel(r.created_at) });

  async function fail(reason, extra) {
    console.error('[ask] fail', reason, JSON.stringify(extra || {}));
    if (extra && (extra.status === 401 || extra.status === 402 || extra.status === 403)) console.error('[ALERT][billing-or-key] anthropic/ask HTTP', extra.status);
    await logEvent(req.userId, 'ask_fail', withSession({ reason, ...extra }, sessionId));
  }

  const startedAt = Date.now();
  try {
    const round1Call = await callAskRound1WithRetry(question, round1Matches.map(withDateLabel), dateRangeLabel, todayLabel);
    if (round1Call.error) {
      const reason = round1Call.error.message === 'timeout' ? 'timeout' : 'network_error';
      await fail(reason, { round: 1, attempt: round1Call.attempt, latencyMs: Date.now() - startedAt });
      return res.status(504).json({ error: reason === 'timeout' ? 'AI处理超时，请重新尝试' : 'AI服务连接失败，请重新尝试' });
    }
    if (!round1Call.response.ok) {
      await fail('api_error', { round: 1, status: round1Call.response.status, attempt: round1Call.attempt, latencyMs: Date.now() - startedAt });
      return res.status(502).json({ error: 'AI服务调用失败，请重新尝试' });
    }
    const data1 = await round1Call.response.json();
    const toolUse1 = findToolUse(data1);
    if (!toolUse1) {
      await fail('no_tool_use', { round: 1, attempt: round1Call.attempt, latencyMs: Date.now() - startedAt });
      return res.status(502).json({ error: 'AI未返回有效内容' });
    }

    let lastLlmCall = round1Call;
    let finalData = data1;
    let allMatches = round1Matches;
    let rounds = 1;
    let retrievalPath = round1.retrievalPath;
    let keywordCount = round1.keywordCount;
    let embeddingCount = round1.embeddingCount;

    if (toolUse1.name === 'search_records') {
      const { keywords, before, after } = toolUse1.input || {};
      const { afterTs, beforeTs } = clampDateRange(after, before, earliestTs, latestTs);
      const scoped = rows.filter((r) => r.created_at >= afterTs && r.created_at <= beforeTs);
      const round2Retrieve = await retrieveAskRecords(scoped, keywords || question);
      const round2Matches = round2Retrieve.matches;
      allMatches = [...round1Matches, ...round2Matches.filter((r) => !round1Matches.some((m) => m.id === r.id))];
      keywordCount += round2Retrieve.keywordCount;
      embeddingCount += round2Retrieve.embeddingCount;
      if (round2Retrieve.retrievalPath === 'embedding' || round2Retrieve.retrievalPath === 'hybrid') {
        retrievalPath = retrievalPath === 'keyword' ? 'hybrid' : round2Retrieve.retrievalPath;
      }

      const round2 = await callAskRound2WithRetry(round1Call.messages, toolUse1, round2Matches.map(withDateLabel));
      rounds = 2;
      if (round2.error) {
        const reason = round2.error.message === 'timeout' ? 'timeout' : 'network_error';
        await fail(reason, { round: 2, attempt: round2.attempt, latencyMs: Date.now() - startedAt });
        return res.status(504).json({ error: reason === 'timeout' ? 'AI处理超时，请重新尝试' : 'AI服务连接失败，请重新尝试' });
      }
      if (!round2.response.ok) {
        await fail('api_error', { round: 2, status: round2.response.status, attempt: round2.attempt, latencyMs: Date.now() - startedAt });
        return res.status(502).json({ error: 'AI服务调用失败，请重新尝试' });
      }
      finalData = await round2.response.json();
      lastLlmCall = round2;
    }

    const finalToolUse = findToolUse(finalData, 'submit_answer');
    if (!finalToolUse) {
      await fail('no_submit_answer', { round: rounds, latencyMs: Date.now() - startedAt });
      return res.status(502).json({ error: 'AI未返回有效内容' });
    }

    const answer = answerFromToolInput(finalToolUse.input);
    await logEvent(req.userId, 'ask_success', withSession(llmUsageMeta({
      data: finalData,
      attempt: lastLlmCall.attempt,
      fellBack: lastLlmCall.fellBack,
      extra: {
        rounds,
        latencyMs: Date.now() - startedAt,
        answered: answer.answered,
        matchCount: allMatches.length,
        retrievalPath,
        keywordCount,
        embeddingCount,
      },
    }), sessionId));

    const citedIds = new Set(answer.citedRecordIds);
    res.json({
      ...answer,
      rounds,
      retrievalPath,
      matchedRecords: allMatches
        .filter((r) => citedIds.has(r.id))
        .map((r) => ({ id: r.id, className: r.class_name, createdAt: r.created_at })),
    });
  } catch (e) {
    await fail('exception', { latencyMs: Date.now() - startedAt });
    console.error('[ask] exception', e);
    res.status(500).json({ error: '服务器错误，请稍后重试' });
  }
});

module.exports = router;
