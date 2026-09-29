const db = require('./db');
const { knownEventNames, sanitizeEventMetadata } = require('./analytics');

const KNOWN_EVENTS = knownEventNames();

// Core flow: recording a class (transcribe + structure into a draft). This is the thing the
// product exists to do, so it gets the main daily budget (DAILY_AI_LIMIT).
const CORE_QUOTA_EVENTS = ['ai_process_success', 'ai_process_fail', 'asr_success', 'asr_fail'];

// Secondary: optional, exploratory features (ask-your-archive, the gated pre-class multi-agent
// experiment). Separate, smaller budget (DAILY_SECONDARY_AI_LIMIT) so poking around in these can
// never crowd out the quota a user needs to actually record and save a real class.
const SECONDARY_QUOTA_EVENTS = [
  'ask_success', 'ask_fail',
  'experiment_issue_brief_success', 'experiment_issue_brief_fail',
];

const QUOTA_EVENTS = [...CORE_QUOTA_EVENTS, ...SECONDARY_QUOTA_EVENTS];

// The daily free-tier business quota (as opposed to DAILY_AI_LIMIT, which is
// just an anti-abuse safety cap) counts actual 复盘 units, not every ASR
// call a multi-segment recording makes -- one voice recap that took 2
// segments to record still only costs one generate() call.
const RECAP_QUOTA_EVENTS = ['ai_process_success', 'ai_process_fail'];

function startOfLocalDayMs() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

async function logEvent(userId, eventName, metadata) {
  if (!KNOWN_EVENTS.has(eventName)) return false;
  const clean = sanitizeEventMetadata(metadata);
  await db.run(
    'INSERT INTO events (user_id, event_name, metadata, created_at) VALUES (?, ?, ?, ?)',
    [userId || null, eventName, clean ? JSON.stringify(clean) : null, Date.now()]
  );
  return true;
}

async function countEventsSince(userId, eventNames, sinceMs) {
  const placeholders = eventNames.map(() => '?').join(', ');
  const row = await db.get(
    `SELECT COUNT(*) AS c FROM events
     WHERE user_id = ? AND event_name IN (${placeholders}) AND created_at >= ?`,
    [userId, ...eventNames, sinceMs]
  );
  return row.c;
}

function countAiCallsToday(userId) {
  return countEventsSince(userId, CORE_QUOTA_EVENTS, startOfLocalDayMs());
}

function countSecondaryAiCallsToday(userId) {
  return countEventsSince(userId, SECONDARY_QUOTA_EVENTS, startOfLocalDayMs());
}

// Calendar day, same boundary as countAiCallsToday/countSecondaryAiCallsToday.
//
// Counts distinct 复盘 attempts (by sessionId), not raw generate() calls --
// tapping "重新生成" to fix a mis-heard word calls /api/generate again for
// the SAME recap, and that shouldn't burn a second daily slot. Raw AI call
// volume (for cost tracking) is a separate concern -- every call is still
// logged with its own event and token/cost metadata regardless of this
// count; this function only answers "how many recaps has the user done".
async function countAiRecapsToday(userId) {
  const placeholders = RECAP_QUOTA_EVENTS.map(() => '?').join(', ');
  const rows = await db.all(
    `SELECT id, metadata FROM events
     WHERE user_id = ? AND event_name IN (${placeholders}) AND created_at >= ?`,
    [userId, ...RECAP_QUOTA_EVENTS, startOfLocalDayMs()]
  );
  const units = new Set();
  for (const row of rows) {
    let sessionId = '';
    try { sessionId = JSON.parse(row.metadata || '{}').sessionId || ''; } catch (e) {}
    // No sessionId (shouldn't normally happen) -- fall back to counting it
    // as its own unit rather than silently merging unrelated attempts.
    units.add(sessionId ? `s:${sessionId}` : `e:${row.id}`);
  }
  return units.size;
}

module.exports = {
  logEvent, KNOWN_EVENTS, countAiCallsToday, countSecondaryAiCallsToday, countAiRecapsToday,
};
