// "Are the AI providers failing right now?" — answered only from our own events
// table, so checking it costs nothing and never calls Anthropic or OpenAI.
//
// A provider counts as failing when, inside the window, it had at least
// MIN_FAILURES upstream failures and zero successes. Failures caused by the user
// hitting their daily cap (quota_exceeded) or by model output shape are ignored.
// With no recent traffic it is "idle", which is healthy: silence is not an outage.
const WINDOW_MS = 30 * 60 * 1000;
const MIN_FAILURES = 3;
const UPSTREAM_REASONS = new Set(['api_error', 'timeout', 'network_error', 'exception']);

const SERVICES = {
  anthropic: { ok: ['ai_process_success', 'ask_success'], fail: ['ai_process_fail', 'ask_fail'] },
  whisper: { ok: ['asr_success'], fail: ['asr_fail'] },
};

function reasonOf(metadata) {
  try { return (JSON.parse(metadata || '{}') || {}).reason; } catch (e) { return undefined; }
}

async function assessAiHealth(db, now = Date.now()) {
  const since = now - WINDOW_MS;
  const result = {};
  for (const [name, ev] of Object.entries(SERVICES)) {
    const okMarks = ev.ok.map(() => '?').join(', ');
    const failMarks = ev.fail.map(() => '?').join(', ');
    const successes = (await db.get(
      `SELECT COUNT(*) AS c FROM events WHERE event_name IN (${okMarks}) AND created_at >= ?`,
      [...ev.ok, since]
    )).c;
    const failRows = await db.all(
      `SELECT metadata FROM events WHERE event_name IN (${failMarks}) AND created_at >= ? ORDER BY id DESC LIMIT 200`,
      [...ev.fail, since]
    );
    const upstreamFailures = failRows.filter((r) => UPSTREAM_REASONS.has(reasonOf(r.metadata))).length;
    if (successes === 0 && upstreamFailures >= MIN_FAILURES) result[name] = 'failing';
    else if (successes === 0 && upstreamFailures === 0) result[name] = 'idle';
    else result[name] = 'ok';
  }
  return { ok: Object.values(result).every((s) => s !== 'failing'), windowMinutes: WINDOW_MS / 60000, ...result };
}

module.exports = { assessAiHealth, WINDOW_MS, MIN_FAILURES };
