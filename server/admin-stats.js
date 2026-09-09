const db = require('./db');
const { parseJson, latencyStats } = require('./lib/text');
const { ANTHROPIC_INPUT_USD_PER_MTOK, ANTHROPIC_OUTPUT_USD_PER_MTOK, ANALYTICS_INTERNAL_EMAILS } = require('./config');
const { canonicalSessionFunnel, productKpis, splitInternal } = require('./analytics');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const VOLUME_EVENTS = [
  { key: 'voiceStart', event: 'record_voice_start', label: '开始录音（次数，不是 conversion）' },
  { key: 'voiceComplete', event: 'record_voice_complete', label: '录完一段' },
  { key: 'asrSuccess', event: 'asr_success', label: 'ASR 成功' },
  { key: 'aiSuccess', event: 'ai_process_success', label: 'AI 成功' },
  { key: 'reviewOpened', event: 'review_opened', label: '打开 Review' },
  { key: 'saved', event: 'save_record', label: '确认保存' },
  { key: 'historyOpen', event: 'history_open', label: 'History 列表（旧名）' },
];

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

function reasonCounts(rows) {
  const map = {};
  for (const m of metas(rows)) {
    const r = m.reason || m.error || 'unknown';
    map[r] = (map[r] || 0) + 1;
  }
  return map;
}

function utcDay(ts) {
  return new Date(Number(ts)).toISOString().slice(0, 10);
}

function collectAiUsage(successEvents) {
  const usage = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, latencies: [],
  };
  const confidence = { 高: 0, 中: 0, 低: 0, other: 0 };
  for (const m of metas(successEvents)) {
    if (typeof m.inputTokens === 'number') usage.inputTokens += m.inputTokens;
    if (typeof m.outputTokens === 'number') usage.outputTokens += m.outputTokens;
    if (typeof m.cacheReadTokens === 'number') usage.cacheReadTokens += m.cacheReadTokens;
    if (typeof m.cacheCreationTokens === 'number') usage.cacheCreationTokens += m.cacheCreationTokens;
    if (typeof m.latencyMs === 'number') usage.latencies.push(m.latencyMs);
    const c = m.confidence_level;
    if (c === '高' || c === '中' || c === '低') confidence[c] += 1;
    else if (c) confidence.other += 1;
  }
  const lat = latencyStats(usage.latencies);
  const estimatedUsd = (usage.inputTokens / 1e6) * ANTHROPIC_INPUT_USD_PER_MTOK
    + (usage.outputTokens / 1e6) * ANTHROPIC_OUTPUT_USD_PER_MTOK
    + (usage.cacheCreationTokens / 1e6) * ANTHROPIC_INPUT_USD_PER_MTOK * 1.25
    + (usage.cacheReadTokens / 1e6) * ANTHROPIC_INPUT_USD_PER_MTOK * 0.1;
  return {
    totalInputTokens: usage.inputTokens,
    totalOutputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    avgLatencyMs: lat.avgMs,
    p95LatencyMs: lat.p95Ms,
    callCount: lat.count,
    estimatedUsd: Math.round(estimatedUsd * 10000) / 10000,
    estimateNote: '按环境变量里的 Anthropic 单价估算（含 cache 粗算），请以控制台账单为准',
    confidence,
    _estimatedUsd: estimatedUsd,
  };
}

function userSet(rows, eventName) {
  const ids = new Set();
  for (const r of rows) {
    if (r.event_name === eventName && r.user_id != null) ids.add(r.user_id);
  }
  return ids;
}

function buildRetention(eventRows, now) {
  const savesByUser = new Map();
  const timesByUser = new Map();
  for (const e of eventRows) {
    if (e.user_id == null) continue;
    if (!timesByUser.has(e.user_id)) timesByUser.set(e.user_id, []);
    timesByUser.get(e.user_id).push(Number(e.created_at));
    if (e.event_name === 'save_record') {
      if (!savesByUser.has(e.user_id)) savesByUser.set(e.user_id, []);
      savesByUser.get(e.user_id).push(Number(e.created_at));
    }
  }
  const activated = [...savesByUser.keys()];
  let repeatSavers = 0;
  let twoPlusDays = 0;
  let eligible7d = 0;
  let returned7d = 0;
  for (const uid of activated) {
    const times = savesByUser.get(uid).sort((a, b) => a - b);
    if (times.length >= 2) repeatSavers += 1;
    if (new Set(times.map(utcDay)).size >= 2) twoPlusDays += 1;
    const first = times[0];
    if (now - first >= WEEK_MS) {
      eligible7d += 1;
      if ((timesByUser.get(uid) || []).some((t) => t >= first + WEEK_MS)) returned7d += 1;
    }
  }
  return {
    repeatSavers,
    repeatSaverRate: pct(repeatSavers, activated.length),
    savedOnTwoPlusDays: twoPlusDays,
    twoDayRate: pct(twoPlusDays, activated.length),
    weekReturnEligible: eligible7d,
    weekReturnReturned: returned7d,
    weekReturnRate: pct(returned7d, eligible7d),
    note: 'weekReturn：首次保存满 7 天后还有任意事件。不是日历周 cohort，样本小时不要当留存结论。',
  };
}

function editedFieldCounts(editEvents) {
  const fields = { good_points: 0, improve_points: 0, next_time_reminder: 0, session_tips: 0 };
  let editedTrue = 0;
  for (const m of metas(editEvents)) {
    if (m.edited === true) editedTrue += 1;
    for (const f of m.editedFields || []) {
      if (fields[f] != null) fields[f] += 1;
    }
  }
  return { editedTrue, fields };
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

  const [editEvents, successEvents, asrSuccessEvents, failEvents, asrFailEvents, totalsBundle, recentEvents, allEvents, userRows] = await Promise.all([
    db.all("SELECT metadata FROM events WHERE event_name = 'user_edit_ai_result'"),
    db.all("SELECT metadata FROM events WHERE event_name = 'ai_process_success'"),
    db.all("SELECT metadata FROM events WHERE event_name = 'asr_success'"),
    db.all("SELECT metadata FROM events WHERE event_name = 'ai_process_fail'"),
    db.all("SELECT metadata FROM events WHERE event_name = 'asr_fail'"),
    loadTotals(weekAgo),
    db.all(`
      SELECT user_id, event_name, metadata, created_at
      FROM events
      ORDER BY id DESC
      LIMIT 30
    `),
    db.all('SELECT user_id, event_name, metadata, created_at FROM events'),
    db.all('SELECT id, email FROM users'),
  ]);

  const aiUsage = collectAiUsage(successEvents);
  const asrLat = latencyStats(metas(asrSuccessEvents).map((m) => m.latencyMs).filter((n) => typeof n === 'number'));

  const { registeredUsers, records, activatedUsers, totals } = totalsBundle;
  const internalUserIds = new Set(
    (userRows || [])
      .filter((u) => ANALYTICS_INTERNAL_EMAILS.includes(String(u.email || '').toLowerCase()))
      .map((u) => u.id)
  );
  const audiences = splitInternal(allEvents, internalUserIds);
  const layer3All = {
    sessionFunnel: canonicalSessionFunnel(audiences.all),
    kpis: productKpis(audiences.all, registeredUsers, activatedUsers, Date.now()),
  };
  const realRegistered = Math.max(0, registeredUsers - internalUserIds.size);
  let realActivatedCount = 0;
  const saveUsersAll = userSet(allEvents, 'save_record');
  for (const id of saveUsersAll) {
    if (!internalUserIds.has(id)) realActivatedCount += 1;
  }

  const byClicks = {};
  const byUniqueUsers = {};
  const steps = VOLUME_EVENTS.map((s) => {
    const clicks = click(s.event);
    const uniqueUsers = unique(s.event);
    byClicks[s.key] = clicks;
    byUniqueUsers[s.key] = uniqueUsers;
    return { ...s, clicks, uniqueUsers };
  });

  return {
    readMe: 'Layer 3 conversion 只用带 sessionId 的同一条 Capture。没有 sessionId 的历史事件不会被补写。不要用独立账号相除当完成率。费用是估算。Layer 1 只看 npm run eval。',
    totals,
    eventCounts: Object.fromEntries(eventCounts.map((e) => [e.event_name, num(e.count)])),
    eventBreakdown: eventCounts.map((e) => ({
      name: e.event_name,
      count: num(e.count),
      uniqueUsers: num(e.unique_users),
    })),
    funnel: {
      kind: 'volume_not_conversion',
      steps,
      byClicks,
      byUniqueUsers,
    },
    sessionFunnel: layer3All.sessionFunnel,
    layer3: {
      definition: layer3All.sessionFunnel.definition,
      allTraffic: {
        sessionFunnel: layer3All.sessionFunnel,
        kpis: layer3All.kpis,
      },
      excludingInternal: {
        configuredInternalAccounts: internalUserIds.size,
        sessionFunnel: canonicalSessionFunnel(audiences.realUsers),
        kpis: productKpis(audiences.realUsers, realRegistered, realActivatedCount, Date.now()),
      },
    },
    retention: buildRetention(allEvents, Date.now()),
    metrics: {
      doNotUseUniqueUserCompletion: true,
      activationRate: pct(activatedUsers, registeredUsers),
      completionRateSession: layer3All.sessionFunnel.completionRate,
      editRate: layer3All.sessionFunnel.editRate,
      regenerateRate: layer3All.sessionFunnel.regenerateRate,
      historyRevisitRate: layer3All.kpis.historyRevisitRate,
      d7RetentionRate: layer3All.kpis.d7RetentionRate,
      recordCompletionRate: pct(saveCount, voiceStarts),
      typedOrNoVoiceSavers: layer3All.sessionFunnel.typedOrNoVoiceSessions,
      aiProcessSuccessRate: pct(aiSuccess, aiSuccess + aiFail),
      asrSuccessRate: pct(click('asr_success'), click('asr_success') + click('asr_fail')),
      editedFields: editedFieldCounts(editEvents).fields,
      retryRate: pct(retries, aiSuccess + retries),
      avgRecordsPerActivatedUser: activatedUsers
        ? Math.round((records / activatedUsers) * 10) / 10
        : null,
      aiSuccessesPerSave: saveCount
        ? Math.round((aiSuccess / saveCount) * 10) / 10
        : null,
      progressOpenCount: click('progress_open') + click('progress_opened'),
      progressOpenUniqueUsers: unique('progress_open') + unique('progress_opened'),
      historyOpenCount: click('history_open') + click('history_opened'),
      historyOpenUniqueUsers: unique('history_open') + unique('history_opened'),
      reviewOpenedCount: click('review_opened'),
      reviewOpenedUniqueUsers: unique('review_opened'),
    },
    aiUsage: {
      totalInputTokens: aiUsage.totalInputTokens,
      totalOutputTokens: aiUsage.totalOutputTokens,
      cacheReadTokens: aiUsage.cacheReadTokens,
      cacheCreationTokens: aiUsage.cacheCreationTokens,
      avgLatencyMs: aiUsage.avgLatencyMs,
      p95LatencyMs: aiUsage.p95LatencyMs,
      callCount: aiUsage.callCount,
      estimatedUsd: aiUsage.estimatedUsd,
      usdPerSave: saveCount ? Math.round((aiUsage._estimatedUsd / saveCount) * 10000) / 10000 : null,
      estimateNote: aiUsage.estimateNote,
      confidence: aiUsage.confidence,
      failReasons: reasonCounts(failEvents),
    },
    asrUsage: {
      success: click('asr_success'),
      fail: click('asr_fail'),
      uniqueUsers: unique('asr_success'),
      avgLatencyMs: asrLat.avgMs,
      p95LatencyMs: asrLat.p95Ms,
      failReasons: reasonCounts(asrFailEvents),
    },
    onlineQualityProxy: {
      note: '不是 Layer 1。模型自报 confidence，不能代替 Eval 五维。',
      confidence: aiUsage.confidence,
    },
    recentEvents,
  };
}

module.exports = { buildAdminStats, pct, num };
