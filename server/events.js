const db = require('./db');

const KNOWN_EVENTS = new Set([
  'record_voice_start',
  'record_voice_complete',
  'asr_fail',
  'asr_success',
  'ai_process_success',
  'ai_process_fail',
  'user_edit_ai_result',
  'retry_ai',
  'save_record',
  'history_open',
  'progress_open',
]);

// ASR + generate share one daily budget so a user cannot burn both quotas.
const QUOTA_EVENTS = ['ai_process_success', 'ai_process_fail', 'asr_success', 'asr_fail'];

function startOfLocalDayMs() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

async function logEvent(userId, eventName, metadata) {
  if (!KNOWN_EVENTS.has(eventName)) return false;
  await db.run(
    'INSERT INTO events (user_id, event_name, metadata, created_at) VALUES (?, ?, ?, ?)',
    [userId || null, eventName, metadata ? JSON.stringify(metadata) : null, Date.now()]
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
