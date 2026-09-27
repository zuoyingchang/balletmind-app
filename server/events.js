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

async function countEventsToday(userId, eventNames) {
  const placeholders = eventNames.map(() => '?').join(', ');
  const row = await db.get(
    `SELECT COUNT(*) AS c FROM events
     WHERE user_id = ? AND event_name IN (${placeholders}) AND created_at >= ?`,
    [userId, ...eventNames, startOfLocalDayMs()]
  );
  return row.c;
}

function countAiCallsToday(userId) {
  return countEventsToday(userId, CORE_QUOTA_EVENTS);
}

function countSecondaryAiCallsToday(userId) {
  return countEventsToday(userId, SECONDARY_QUOTA_EVENTS);
}

module.exports = { logEvent, KNOWN_EVENTS, countAiCallsToday, countSecondaryAiCallsToday };
