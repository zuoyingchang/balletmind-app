const db = require('./db');

// The events defined in the PRD 埋点 section, plus asr_success for Whisper.
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

async function logEvent(userId, eventName, metadata) {
  if (!KNOWN_EVENTS.has(eventName)) return false;
  await db.run(
    'INSERT INTO events (user_id, event_name, metadata, created_at) VALUES (?, ?, ?, ?)',
    [userId || null, eventName, metadata ? JSON.stringify(metadata) : null, Date.now()]
  );
  return true;
}

// Count of ai_process_success/fail events for this user since local midnight —
// used to enforce the daily AI call quota.
async function countAiCallsToday(userId) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const row = await db.get(
    `SELECT COUNT(*) AS c FROM events
     WHERE user_id = ? AND event_name IN ('ai_process_success', 'ai_process_fail', 'asr_success', 'asr_fail') AND created_at >= ?`,
    [userId, startOfDay.getTime()]
  );
  return row.c;
}

module.exports = { logEvent, KNOWN_EVENTS, countAiCallsToday };
