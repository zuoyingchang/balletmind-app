const db = require('./db');
const { knownEventNames, sanitizeEventMetadata } = require('./analytics');

const KNOWN_EVENTS = knownEventNames();

const QUOTA_EVENTS = ['ai_process_success', 'ai_process_fail', 'asr_success', 'asr_fail'];

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

async function countAiCallsToday(userId) {
  const placeholders = QUOTA_EVENTS.map(() => '?').join(', ');
  const row = await db.get(
    `SELECT COUNT(*) AS c FROM events
     WHERE user_id = ? AND event_name IN (${placeholders}) AND created_at >= ?`,
    [userId, ...QUOTA_EVENTS, startOfLocalDayMs()]
  );
  return row.c;
}

module.exports = { logEvent, KNOWN_EVENTS, countAiCallsToday };
