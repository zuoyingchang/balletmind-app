const db = require('./db');

// The 10 events defined in the PRD's 埋点与核心指标 section.
// progress_open is listed there too but has no corresponding UI yet (Progress
// feature is deferred), so it isn't wired up until that ships.
const KNOWN_EVENTS = new Set([
  'record_voice_start',
  'record_voice_complete',
  'asr_fail',
  'ai_process_success',
  'ai_process_fail',
  'user_edit_ai_result',
  'retry_ai',
  'save_record',
  'history_open',
  'progress_open',
]);

function logEvent(userId, eventName, metadata) {
  if (!KNOWN_EVENTS.has(eventName)) return false;
  db.prepare('INSERT INTO events (user_id, event_name, metadata, created_at) VALUES (?, ?, ?, ?)')
    .run(userId || null, eventName, metadata ? JSON.stringify(metadata) : null, Date.now());
  return true;
}

module.exports = { logEvent, KNOWN_EVENTS };
