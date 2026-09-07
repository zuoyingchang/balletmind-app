const express = require('express');
const db = require('../db');
const { ADMIN_KEY, ANTHROPIC_INPUT_USD_PER_MTOK, ANTHROPIC_OUTPUT_USD_PER_MTOK } = require('../config');

const router = express.Router();

function requireAdminKey(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: '管理统计功能未配置 ADMIN_KEY' });
  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) return res.status(401).json({ error: '管理密钥不对' });
  next();
}

function pct(num, den) {
  if (!den) return null;
  return Math.round((num / den) * 1000) / 10;
}

function num(v) {
  return Number(v || 0);
}

router.get('/stats', requireAdminKey, async (req, res) => {
  try {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const eventCounts = await db.all(`
      SELECT event_name,
             COUNT(*) AS count,
             COUNT(DISTINCT user_id) AS unique_users
      FROM events
      GROUP BY event_name
    `);
    const countOf = (name) => num(eventCounts.find((e) => e.event_name === name)?.count);
    const uniqueOf = (name) => num(eventCounts.find((e) => e.event_name === name)?.unique_users);

    const aiSuccess = countOf('ai_process_success');
    const aiFail = countOf('ai_process_fail');
    const aiTotal = aiSuccess + aiFail;
    const saveCount = countOf('save_record');
    const voiceStarts = countOf('record_voice_start');
    const retries = countOf('retry_ai');

    const editEvents = await db.all(
      "SELECT metadata FROM events WHERE event_name = 'user_edit_ai_result'"
    );
    const editedCount = editEvents.filter((r) => {
      try { return JSON.parse(r.metadata || '{}').edited === true; } catch (e) { return false; }
    }).length;

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
    const estimatedUsd = (usage.inputTokens / 1e6) * ANTHROPIC_INPUT_USD_PER_MTOK
      + (usage.outputTokens / 1e6) * ANTHROPIC_OUTPUT_USD_PER_MTOK;

    const asrSuccessEvents = await db.all(
      "SELECT metadata FROM events WHERE event_name = 'asr_success'"
    );
    const asrLatencies = asrSuccessEvents.map((r) => {
      try { return JSON.parse(r.metadata || '{}').latencyMs; } catch (e) { return null; }
    }).filter((n) => typeof n === 'number');
    const asrAvgLatencyMs = asrLatencies.length
      ? Math.round(asrLatencies.reduce((a, b) => a + b, 0) / asrLatencies.length)
      : null;

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
    const neverSavedUsers = Math.max(0, registeredUsers - activatedUsers);

    const uniqueStarted = uniqueOf('record_voice_start');
    const uniqueAsr = uniqueOf('asr_success');
    const uniqueAi = uniqueOf('ai_process_success');
    const uniqueSaved = uniqueOf('save_record') || activatedUsers;

    const recentEvents = await db.all(`
      SELECT user_id, event_name, metadata, created_at
      FROM events
      ORDER BY id DESC
      LIMIT 30
    `);

    res.json({
      readMe: '次数含重试和自测；看「独立账号」和近7天，才接近真实使用。费用是按默认单价估算，不是账单。',
      totals: {
        users: registeredUsers,
        records,
        events: num(eventsCount.c),
        activatedUsers,
        neverSavedUsers,
        recordsLast7Days: num(weekRecordsRow.c),
        activeUsersLast7Days: num(weekEventUsersRow.c),
        usersWhoSavedLast7Days: num(weekRecordUsersRow.c),
        eventsLast7Days: num(weekEventsRow.c),
      },
      eventCounts: Object.fromEntries(eventCounts.map((e) => [e.event_name, num(e.count)])),
      eventBreakdown: eventCounts.map((e) => ({
        name: e.event_name,
        count: num(e.count),
        uniqueUsers: num(e.unique_users),
      })),
      funnel: {
        byClicks: {
          voiceStart: voiceStarts,
          asrSuccess: countOf('asr_success'),
          aiSuccess: aiSuccess,
          saved: saveCount,
        },
        byUniqueUsers: {
          voiceStart: uniqueStarted,
          asrSuccess: uniqueAsr,
          aiSuccess: uniqueAi,
          saved: uniqueSaved,
        },
      },
      metrics: {
        // 旧口径：按点击，含重试，容易虚高分母
        recordCompletionRate: pct(saveCount, voiceStarts),
        // 更接近「多少人开了录音、多少人最终留下一条」
        uniqueUserCompletionRate: pct(uniqueSaved, uniqueStarted),
        activationRate: pct(activatedUsers, registeredUsers),
        aiProcessSuccessRate: pct(aiSuccess, aiTotal),
        asrSuccessRate: pct(countOf('asr_success'), countOf('asr_success') + countOf('asr_fail')),
        editRate: pct(editedCount, editEvents.length),
        retryRate: pct(retries, aiSuccess + retries),
        avgRecordsPerActivatedUser: activatedUsers
          ? Math.round((records / activatedUsers) * 10) / 10
          : null,
        aiSuccessesPerSave: saveCount
          ? Math.round((aiSuccess / saveCount) * 10) / 10
          : null,
        progressOpenCount: countOf('progress_open'),
        progressOpenUniqueUsers: uniqueOf('progress_open'),
      },
      aiUsage: {
        totalInputTokens: usage.inputTokens,
        totalOutputTokens: usage.outputTokens,
        avgLatencyMs,
        callCount: usage.latencies.length,
        estimatedUsd: Math.round(estimatedUsd * 10000) / 10000,
        usdPerSave: saveCount ? Math.round((estimatedUsd / saveCount) * 10000) / 10000 : null,
        estimateNote: '按环境变量里的 Anthropic 单价估算，请以 Anthropic 控制台账单为准',
      },
      asrUsage: {
        success: countOf('asr_success'),
        fail: countOf('asr_fail'),
        uniqueUsers: uniqueOf('asr_success'),
        avgLatencyMs: asrAvgLatencyMs,
      },
      recentEvents,
    });
  } catch (e) {
    res.status(500).json({ error: '统计查询失败', detail: e.message });
  }
});

module.exports = router;
