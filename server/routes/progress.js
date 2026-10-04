const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { listIssuesWithOccurrences, isSimilar } = require('../issues');
const { splitLines, sessionIdFromReq, withSession, uniqueCompactGoodPoints } = require('../lib/text');
const { logEvent, logEmbeddingUsage, countAiCallsToday, countSecondaryAiCallsThisWeek, countAiRecapsToday } = require('../events');
const { dailyAiLimitFor, weeklyAskLimitFor, dailyRecapLimitFor } = require('../config');
const { retrieveAskRecords, KEYWORD_SPARSE_MAX } = require('../ai/ask-retrieve');
const { buildAskDigest, wantResolvedSection, stripAskFillers } = require('../ai/ask-digest');
const { parseAskDateRange } = require('../ai/ask-daterange');
const { isIssueBriefExperimentOn } = require('../experiments/issue-brief-gate');
const { runIssueBriefExperiment } = require('../ai/issue-brief-experiment');

const router = express.Router();
router.use(requireAuth);
function uniqueSimilarLines(lines) {
  const base = uniqueCompactGoodPoints(lines);
  const out = [];
  for (const line of base) {
    const idx = out.findIndex((existing) => isSimilar(existing, line) || isSimilar(line, existing));
    if (idx < 0) out.push(line);
    else if (String(line).length > String(out[idx]).length) out[idx] = line;
  }
  return out;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// GET /api/progress/review?days=7 | ?last=5 — Training Review (V0.2 #2).
// User-triggered, not a background job — this just aggregates data that's
// already in the database. Zero LLM calls.
router.get('/review', async (req, res) => {
  const useLast = req.query.last !== undefined && req.query.last !== '';
  const lastCount = useLast ? Math.min(20, Math.max(1, Number(req.query.last) || 5)) : null;
  const days = useLast ? null : Math.max(1, Number(req.query.days) || 7);
  // Optional 课程/组合 scope -- when set, "近5次" means the last 5 sessions
  // OF THAT COURSE (filtered in SQL before the LIMIT), not the last 5
  // sessions overall with a near-empty result after filtering.
  const classFilter = String(req.query.class || '').trim().slice(0, 40);

  let records;
  let since;
  if (useLast) {
    const params = [req.userId];
    let sql = 'SELECT id, class_name, good_points, improve_points, next_time_reminder, created_at FROM records WHERE user_id = ?';
    if (classFilter) { sql += ' AND TRIM(class_name) = ?'; params.push(classFilter); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(lastCount);
    records = await db.all(sql, params);
    records.reverse();
    since = records.length ? records[0].created_at : Date.now();
  } else {
    since = Date.now() - days * DAY_MS;
    const params = [req.userId, since];
    let sql = 'SELECT id, class_name, good_points, improve_points, next_time_reminder, created_at FROM records WHERE user_id = ? AND created_at >= ?';
    if (classFilter) { sql += ' AND TRIM(class_name) = ?'; params.push(classFilter); }
    sql += ' ORDER BY created_at ASC';
    records = await db.all(sql, params);
  }

  const issues = await listIssuesWithOccurrences(req.userId);
  const openIssues = issues.filter((i) => i.status !== 'resolved');
  let resolvedInPeriod = issues.filter((i) => i.status === 'resolved' && i.updated_at >= since);
  if (classFilter) {
    resolvedInPeriod = resolvedInPeriod.filter((i) => (
      (i.occurrences || []).some((o) => (o.className || '').trim() === classFilter)
    ));
  }

  const newestFirst = [...records].sort((a, b) => Number(b.created_at) - Number(a.created_at));
  const goodPointsRecap = uniqueCompactGoodPoints(
    newestFirst.flatMap((r) => splitLines(r.good_points))
  );
  const improvePointsRecap = uniqueSimilarLines(
    newestFirst.flatMap((r) => [...splitLines(r.improve_points), ...splitLines(r.next_time_reminder)])
  );

  res.json({
    mode: useLast ? 'last' : 'days',
    periodDays: days,
    lastCount,
    classFilter,
    recordCount: records.length,
    records: records.map((r) => ({ id: r.id, className: r.class_name, createdAt: r.created_at })),
    openIssues,
    resolvedInPeriod,
    goodPointsRecap,
    improvePointsRecap,
  });
});

// GET /api/progress/brief — Pre-Class Brief (V0.2 #3).
// Default view renders entirely from local data (0 LLM calls), per the spec.
router.get('/brief', async (req, res) => {
  // issues (then its own occurrences query) and recaps don't depend on each
  // other -- this used to be 3 sequential DB round-trips when it's really
  // only 2 deep. Running them in parallel is the main latency win here,
  // since listIssuesWithOccurrences itself still does 2 queries in series.
  const [issues, recaps] = await Promise.all([
    listIssuesWithOccurrences(req.userId),
    db.all(
      `SELECT class_name, next_time_reminder, improve_points, session_tips, good_points, created_at
       FROM records
       WHERE user_id = ? AND COALESCE(is_checkin_only, 0) = 0
       ORDER BY created_at DESC LIMIT 12`,
      [req.userId]
    ),
  ]);
  const topIssues = issues
    .filter((i) => i.status !== 'resolved')
    .sort((a, b) => b.occurrence_count - a.occurrence_count)
    .slice(0, 3);
  const latestRecap = recaps[0] || null;
  let glance = null;
    for (const row of recaps) {
    const raw = [...splitLines(row.improve_points), ...splitLines(row.next_time_reminder)];
    const improveLines = uniqueCompactGoodPoints(raw);
    const lines = improveLines.length ? improveLines : raw;
    if (!lines.length) continue;
    glance = { row, improveLines: lines };
    break;
  }

  const lastRecordPayload = glance
    ? {
        className: glance.row.class_name,
        nextTimeReminder: glance.row.next_time_reminder,
        improvePoints: glance.improveLines.join('\n'),
        sessionTips: glance.row.session_tips,
        goodPoints: glance.row.good_points,
        createdAt: glance.row.created_at,
        isLatestRecap: latestRecap ? glance.row.created_at === latestRecap.created_at : true,
      }
    : null;

  const payload = {
    topIssues,
    hasRecap: Boolean(latestRecap),
    // Glance is the newest recap that still has 还要改的 (improve, or an old next note).
    // If the latest class only had 做得好, skip back rather than show an empty note.
    lastRecord: lastRecordPayload,
  };

  // Dual gate default-off: no user hits this unless both env vars are set.
  if (isIssueBriefExperimentOn(req.userId) && topIssues.length > 0) {
    const overQuota = (await countSecondaryAiCallsThisWeek(req.userId)) >= (await weeklyAskLimitFor(req.userId));
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
          payload.experimentBrief = { lines: uniqueCompactGoodPoints(result.lines), usedFallback: false };
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

// GET /api/progress/ask?q=... — "问问你的档案".
// Retrieval is keyword-first. Embedding runs only when keyword hits are
// 0 or 1 (KEYWORD_SPARSE_MAX). The answer is the cited digest of those
// lines (做得好的 / 待改进 / 已解决). A model rewrite of the same lines
// looked almost identical on screen, so it is not called.
router.get('/ask', async (req, res) => {
  const question = (req.query.q || '').trim();
  if (!question) return res.status(400).json({ error: '请输入问题' });
  if (question.length > 200) return res.status(400).json({ error: '问题太长了，精简一下' });

  const allRows = await db.all(
    'SELECT id, class_name, good_points, improve_points, next_time_reminder, created_at, embedding FROM records WHERE user_id = ? ORDER BY created_at DESC',
    [req.userId]
  );
  const dateRange = parseAskDateRange(question);
  const rows = dateRange
    ? allRows.filter((r) => r.created_at >= dateRange.since && r.created_at <= dateRange.until)
    : allRows;
  // Once a time expression is pulled out for the date filter above, it's
  // just noise for keyword/embedding matching -- "最近十天我的进步" scored
  // 0.41 similarity against a real "转圈有进步" record (cutoff is 0.45)
  // because "最近十天" was still in the embedded text, diluting the topic
  // signal. Strip it so retrieval runs on "我的进步" alone.
  const searchQuestion = dateRange ? question.replace(dateRange.matchedText, '').trim() : question;
  const topic = stripAskFillers(searchQuestion);
  const topicless = !!dateRange && !topic;
  const keywordRound = topicless
    ? { matches: [], retrievalPath: 'none', keywordCount: 0, embeddingCount: 0 }
    : await retrieveAskRecords(rows, searchQuestion, { mode: 'keyword', limit: 8 });
  const emptyAnswerPoints = dateRange ? [`${dateRange.label}内还没有找到相关记录。`] : ['档案里还没有找到相关记录。'];
  const sessionId = sessionIdFromReq(req);
  const overQuota = (await countSecondaryAiCallsThisWeek(req.userId)) >= (await weeklyAskLimitFor(req.userId));
  const archiveOverview = wantResolvedSection(question) || topicless;

  let round1 = keywordRound;
  if (archiveOverview) {
    round1 = {
      matches: rows.slice(0, 8),
      retrievalPath: 'recent',
      keywordCount: keywordRound.keywordCount,
      embeddingCount: 0,
    };
  } else if (keywordRound.keywordCount <= KEYWORD_SPARSE_MAX) {
    if (overQuota) {
      if (keywordRound.matches.length === 0) {
        const issuesEmpty = await listIssuesWithOccurrences(req.userId);
        const emptyDigest = buildAskDigest({ records: [], issues: issuesEmpty, question: searchQuestion });
        if (!emptyDigest.answered) {
          return res.json({
            answered: false,
            answerPoints: emptyAnswerPoints,
            citedRecordIds: [],
            matchedRecords: [],
            sections: [],
            retrievalPath: 'none',
          });
        }
      }
      await logEvent(req.userId, 'ask_fail', withSession({ reason: 'quota_exceeded' }, sessionId));
      return res.status(429).json({ error: '这周的问问次数已经用完了，下周再问吧' });
    }
    round1 = await retrieveAskRecords(rows, searchQuestion, { limit: 8, onUsage: (u) => logEmbeddingUsage(req.userId, 'ask', u) });
  }

  const round1Matches = round1.matches;
  const issues = await listIssuesWithOccurrences(req.userId);
  const digest = buildAskDigest({ records: round1Matches, issues, question: searchQuestion });
  if (!digest.answered) {
    return res.json({
      answered: false,
      answerPoints: dateRange ? emptyAnswerPoints : digest.answerPoints,
      citedRecordIds: [],
      matchedRecords: [],
      sections: [],
      retrievalPath: round1.retrievalPath,
    });
  }

  if (overQuota) {
    await logEvent(req.userId, 'ask_fail', withSession({ reason: 'quota_exceeded' }, sessionId));
    return res.status(429).json({ error: '这周的问问次数已经用完了，下周再问吧' });
  }

  const startedAt = Date.now();
  await logEvent(req.userId, 'ask_success', withSession({
    rounds: 1,
    latencyMs: Date.now() - startedAt,
    answered: true,
    matchCount: round1Matches.length,
    retrievalPath: round1.retrievalPath,
    keywordCount: round1.keywordCount,
    embeddingCount: round1.embeddingCount,
    embeddingRan: Boolean(round1.embeddingRan),
    digest: true,
    aiUsed: false,
  }, sessionId));

  const citedIds = new Set(digest.citedRecordIds);
  res.json({
    ...digest,
    aiUsed: false,
    rounds: 1,
    retrievalPath: round1.retrievalPath,
    matchedRecords: round1Matches
      .filter((r) => citedIds.has(r.id))
      .map((r) => ({ id: r.id, className: r.class_name, createdAt: r.created_at })),
  });
});

// GET /api/progress/quota -- today's AI usage, shown near the record/ask
// entry points so a user sees "还能用 X 次" before hitting the limit,
// not only after a 429.
router.get('/quota', async (req, res) => {
  const [core, secondary, recap] = await Promise.all([
    countAiCallsToday(req.userId),
    countSecondaryAiCallsThisWeek(req.userId),
    countAiRecapsToday(req.userId),
  ]);
  const coreLimit = dailyAiLimitFor(req.userId);
  const secondaryLimit = await weeklyAskLimitFor(req.userId);
  const recapLimit = dailyRecapLimitFor(req.userId);
  res.json({
    core: { used: core, limit: coreLimit, remaining: Math.max(0, coreLimit - core) },
    secondary: { used: secondary, limit: secondaryLimit, remaining: Math.max(0, secondaryLimit - secondary), period: 'week' },
    recap: { used: recap, limit: recapLimit, remaining: Math.max(0, recapLimit - recap) },
  });
});

// GET /api/progress/share-badge -- has this user ever downloaded/shared a
// check-in card? Backs the one-off "分享过" badge (V0.1 of a share-reward
// loop -- see product discussion: try the cheapest version first and see if
// sharing even happens before building a real referral-code system).
router.get('/share-badge', async (req, res) => {
  const row = await db.get(
    "SELECT 1 AS ok FROM events WHERE user_id = ? AND event_name = 'share_card_downloaded' LIMIT 1",
    [req.userId]
  );
  res.json({ earned: !!row });
});

module.exports = router;
