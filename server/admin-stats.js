const db = require('./db');
const { parseJson, averageInt } = require('./lib/text');
const { ANTHROPIC_INPUT_USD_PER_MTOK, ANTHROPIC_OUTPUT_USD_PER_MTOK } = require('./config');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function pct(num, den) {
  if (!den) return null;
  return Math.round((num / den) * 1000) / 10;
}

function num(v) {
  return Number(v || 0);
}

function countOf(eventCounts, name) {
  return num(eventCounts.find((e) => e.event_name === name)?.count);
}

function uniqueOf(eventCounts, name) {
  return num(eventCounts.find((e) => e.event_name === name)?.unique_users);
}

function metas(rows) {
  return rows.map((r) => parseJson(r.metadata));
}

function collectAiUsage(successEvents) {
  const usage = { inputTokens: 0, outputTokens: 0, latencies: [] };
  for (const m of metas(successEvents)) {
    if (typeof m.inputTokens === 'number') usage.inputTokens += m.inputTokens;
    if (typeof m.outputTokens === 'number') usage.outputTokens += m.outputTokens;
    if (typeof m.latencyMs === 'number') usage.latencies.push(m.latencyMs);
  }
  const estimatedUsd = (usage.inputTokens / 1e6) * ANTHROPIC_INPUT_USD_PER_MTOK
    + (usage.outputTokens / 1e6) * ANTHROPIC_OUTPUT_USD_PER_MTOK;
  return {
    totalInputTokens: usage.inputTokens,
    totalOutputTokens: usage.outputTokens,
    avgLatencyMs: averageInt(usage.latencies),
    callCount: usage.latencies.length,
    estimatedUsd: Math.round(estimatedUsd * 10000) / 10000,
    estimateNote: '按环境变量里的 Anthropic 单价估算，请以 Anthropic 控制台账单为准',
    _estimatedUsd: estimatedUsd,
  };
}

async function loadTotals(weekAgo) {
  const [
    usersCount,
    recordsCount,
    eventsCount,
    activatedRow,
    weekRecordsRow,
    weekRecordUsersRow,
    weekEventUsersRow,
    weekEventsRow,
  ] = await Promise.all([
    db.get('SELECT COUNT(*) AS c FROM users'),
    db.get('SELECT COUNT(*) AS c FROM records'),
    db.get('SELECT COUNT(*) AS c FROM events'),
    db.get('SELECT COUNT(DISTINCT user_id) AS c FROM records'),
    db.get('SELECT COUNT(*) AS c FROM records WHERE created_at >= ?', [weekAgo]),
    db.get('SELECT COUNT(DISTINCT user_id) AS c FROM records WHERE created_at >= ?', [weekAgo]),
    db.get('SELECT COUNT(DISTINCT user_id) AS c FROM events WHERE created_at >= ?', [weekAgo]),
    db.get('SELECT COUNT(*) AS c FROM events WHERE created_at >= ?', [weekAgo]),
  ]);

  const registeredUsers = num(usersCount.c);
  const records = num(recordsCount.c);
  const activatedUsers = num(activatedRow.c);

  return {
    registeredUsers,
    records,
    activatedUsers,
    neverSavedUsers: Math.max(0, registeredUsers - activatedUsers),
    totals: {
      users: registeredUsers,
      records,
      events: num(eventsCount.c),
      activatedUsers,
      neverSavedUsers: Math.max(0, registeredUsers - activatedUsers),
      recordsLast7Days: num(weekRecordsRow.c),
      activeUsersLast7Days: num(weekEventUsersRow.c),
      usersWhoSavedLast7Days: num(weekRecordUsersRow.c),
      eventsLast7Days: num(weekEventsRow.c),
    },
  };
}

async function buildAdminStats() {
  const weekAgo = Date.now() - WEEK_MS;

  const eventCounts = await db.all(`
    SELECT event_name,
           COUNT(*) AS count,
           COUNT(DISTINCT user_id) AS unique_users
    FROM events
    GROUP BY event_name
  `);

  const click = (name) => countOf(eventCounts, name);
  const unique = (name) => uniqueOf(eventCounts, name);

  const aiSuccess = click('ai_process_success');
  const aiFail = click('ai_process_fail');
  const saveCount = click('save_record');
  const voiceStarts = click('record_voice_start');
  const retries = click('retry_ai');

  const [editEvents, successEvents, asrSuccessEvents, totalsBundle, recentEvents] = await Promise.all([
    db.all("SELECT metadata FROM events WHERE event_name = 'user_edit_ai_result'"),
    db.all("SELECT metadata FROM events WHERE event_name = 'ai_process_success'"),
    db.all("SELECT metadata FROM events WHERE event_name = 'asr_success'"),
    loadTotals(weekAgo),
    db.all(`
      SELECT user_id, event_name, metadata, created_at
      FROM events
      ORDER BY id DESC
      LIMIT 30
    `),
  ]);

  const editedCount = metas(editEvents).filter((m) => m.edited === true).length;
  const aiUsage = collectAiUsage(successEvents);
  const asrLatencies = metas(asrSuccessEvents)
    .map((m) => m.latencyMs)
    .filter((n) => typeof n === 'number');

  const { registeredUsers, records, activatedUsers, totals } = totalsBundle;
  const uniqueStarted = unique('record_voice_start');
  const uniqueSaved = unique('save_record') || activatedUsers;

  return {
    readMe: '次数含重试和自测；看「独立账号」和近7天，才接近真实使用。费用是按默认单价估算，不是账单。',
    totals,
    eventCounts: Object.fromEntries(eventCounts.map((e) => [e.event_name, num(e.count)])),
    eventBreakdown: eventCounts.map((e) => ({
      name: e.event_name,
      count: num(e.count),
      uniqueUsers: num(e.unique_users),
    })),
    funnel: {
      byClicks: {
        voiceStart: voiceStarts,
        asrSuccess: click('asr_success'),
        aiSuccess,
        saved: saveCount,
      },
      byUniqueUsers: {
        voiceStart: uniqueStarted,
        asrSuccess: unique('asr_success'),
        aiSuccess: unique('ai_process_success'),
        saved: uniqueSaved,
      },
    },
    metrics: {
      recordCompletionRate: pct(saveCount, voiceStarts),
      uniqueUserCompletionRate: pct(uniqueSaved, uniqueStarted),
      activationRate: pct(activatedUsers, registeredUsers),
      aiProcessSuccessRate: pct(aiSuccess, aiSuccess + aiFail),
      asrSuccessRate: pct(click('asr_success'), click('asr_success') + click('asr_fail')),
      editRate: pct(editedCount, editEvents.length),
      retryRate: pct(retries, aiSuccess + retries),
      avgRecordsPerActivatedUser: activatedUsers
        ? Math.round((records / activatedUsers) * 10) / 10
        : null,
      aiSuccessesPerSave: saveCount
        ? Math.round((aiSuccess / saveCount) * 10) / 10
        : null,
      progressOpenCount: click('progress_open'),
      progressOpenUniqueUsers: unique('progress_open'),
    },
    aiUsage: {
      totalInputTokens: aiUsage.totalInputTokens,
      totalOutputTokens: aiUsage.totalOutputTokens,
      avgLatencyMs: aiUsage.avgLatencyMs,
      callCount: aiUsage.callCount,
      estimatedUsd: aiUsage.estimatedUsd,
      usdPerSave: saveCount ? Math.round((aiUsage._estimatedUsd / saveCount) * 10000) / 10000 : null,
      estimateNote: aiUsage.estimateNote,
    },
    asrUsage: {
      success: click('asr_success'),
      fail: click('asr_fail'),
      uniqueUsers: unique('asr_success'),
      avgLatencyMs: averageInt(asrLatencies),
    },
    recentEvents,
  };
}

module.exports = { buildAdminStats, pct, num };
