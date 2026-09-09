// Layer 3 event taxonomy. Aliases keep old rows joinable; we never backfill.
// Canonical capture funnel (session-scoped, not unique-user division):
// record_started → voice_completed → asr_success → ai_success → review_opened → session_confirmed
// Edit / regenerate / history are side metrics, not funnel steps.

const FIELD_NAMES = ['good_points', 'improve_points', 'next_time_reminder', 'session_tips'];

const ALIASES = {
  record_started: ['record_voice_start'],
  voice_completed: ['record_voice_complete'],
  asr_success: ['asr_success'],
  ai_success: ['ai_process_success'],
  review_opened: ['review_opened'],
  session_confirmed: ['session_confirmed', 'save_record'],
  field_edited: ['field_edited'],
  ai_regenerated: ['ai_regenerated', 'retry_ai'],
  history_opened: ['history_opened', 'history_open'],
  history_session_opened: ['history_session_opened'],
  progress_opened: ['progress_opened', 'progress_open'],
};

const CANONICAL_FUNNEL = [
  { key: 'recordStarted', canonical: 'record_started', label: 'Record started' },
  { key: 'voiceCompleted', canonical: 'voice_completed', label: 'Voice completed' },
  { key: 'asrSuccess', canonical: 'asr_success', label: 'ASR success' },
  { key: 'aiSuccess', canonical: 'ai_success', label: 'AI success' },
  { key: 'reviewOpened', canonical: 'review_opened', label: 'Review opened' },
  { key: 'sessionConfirmed', canonical: 'session_confirmed', label: 'Session confirmed' },
];

const FUNNEL_DEFINITION = 'Canonical capture funnel is session-scoped: Record started → Voice completed → ASR success → AI success → Review opened → Session confirmed. Conversion is (sessions that reached this step) / (sessions that reached the previous step), among captures that have a sessionId. Do not divide unrelated unique-user counts. Edit, regenerate, and History are later/side metrics. Events from before this deploy have no sessionId and are excluded from session conversion (counts stay 0 until live traffic).';

const ALLOWED_META = new Set([
  'sessionId', 'field_name', 'recordId', 'edited', 'editedFields',
  'durationSec', 'asr', 'error', 'reason', 'status', 'latencyMs',
  'attempt', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens',
  'model', 'promptVersion', 'confidence_level', 'chars', 'bytes', 'from',
]);

const BLOCKED_META = new Set([
  'transcript', 'good_points', 'improve_points', 'next_time_reminder',
  'note', 'text', 'className', 'class_name', 'displayName', 'email',
]);

function knownEventNames() {
  return new Set([
    'record_voice_start', 'record_voice_complete',
    'asr_fail', 'asr_success',
    'ai_process_success', 'ai_process_fail',
    'user_edit_ai_result', 'retry_ai', 'ai_regenerated',
    'save_record', 'session_confirmed',
    'review_opened', 'field_edited',
    'history_open', 'history_opened', 'history_session_opened',
    'progress_open', 'progress_opened',
  ]);
}

function sanitizeEventMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const out = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (BLOCKED_META.has(key)) continue;
    if (!ALLOWED_META.has(key)) continue;
    if (key === 'field_name' && !FIELD_NAMES.includes(value)) continue;
    if (key === 'editedFields' && Array.isArray(value)) {
      out.editedFields = value.filter((f) => FIELD_NAMES.includes(f));
      continue;
    }
    if (key === 'recordId' || key === 'latencyMs' || key === 'attempt'
      || key === 'inputTokens' || key === 'outputTokens' || key === 'cacheReadTokens'
      || key === 'cacheCreationTokens' || key === 'chars' || key === 'bytes'
      || key === 'durationSec' || key === 'status') {
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = n;
      continue;
    }
    if (key === 'sessionId') {
      if (typeof value === 'string' && value.trim()) out.sessionId = value.trim().slice(0, 80);
      continue;
    }
    if (typeof value === 'string') out[key] = value.slice(0, 120);
    else if (typeof value === 'boolean' || typeof value === 'number') out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

function eventMatches(name, canonical) {
  return (ALIASES[canonical] || []).includes(name);
}

function sessionHas(nameSet, canonical) {
  return (ALIASES[canonical] || []).some((n) => nameSet.has(n));
}

function pct(num, den) {
  if (!den) return null;
  return Math.round((num / den) * 1000) / 10;
}

function utcDay(ts) {
  return new Date(Number(ts)).toISOString().slice(0, 10);
}

function parseMeta(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch (e) {
    return {};
  }
}

function buildSessionSets(eventRows) {
  const bySid = new Map();
  for (const row of eventRows) {
    const sid = parseMeta(row.metadata).sessionId;
    if (!sid) continue;
    if (!bySid.has(sid)) bySid.set(sid, { names: new Set(), userId: row.user_id });
    bySid.get(sid).names.add(row.event_name);
  }
  return [...bySid.values()];
}

function canonicalSessionFunnel(eventRows) {
  const sessions = buildSessionSets(eventRows);
  const voiceCaptures = sessions.filter((s) => sessionHas(s.names, 'record_started'));
  const steps = [];
  let cohort = voiceCaptures;
  for (let i = 0; i < CANONICAL_FUNNEL.length; i++) {
    const spec = CANONICAL_FUNNEL[i];
    if (i === 0) cohort = voiceCaptures;
    else cohort = cohort.filter((s) => sessionHas(s.names, spec.canonical));
    const prev = i === 0 ? voiceCaptures.length : steps[i - 1].sessions;
    steps.push({
      key: spec.key,
      label: spec.label,
      canonical: spec.canonical,
      sessions: cohort.length,
      fromPreviousRate: pct(cohort.length, prev),
    });
  }
  const started = voiceCaptures.length;
  const confirmed = steps[steps.length - 1].sessions;
  const withAi = voiceCaptures.filter((s) => sessionHas(s.names, 'ai_success'));
  const confirmedAll = sessions.filter((s) => sessionHas(s.names, 'session_confirmed'));
  const editedNew = confirmedAll.filter((s) => sessionHas(s.names, 'field_edited'));
  const regenerated = withAi.filter((s) => sessionHas(s.names, 'ai_regenerated'));
  return {
    definition: FUNNEL_DEFINITION,
    withSessionId: sessions.length,
    voiceCaptures: started,
    typedOrNoVoiceSessions: sessions.filter((s) => !sessionHas(s.names, 'record_started') && sessionHas(s.names, 'session_confirmed')).length,
    steps,
    completionRate: pct(confirmed, started),
    regenerateRate: pct(regenerated.length, withAi.length),
    editRate: pct(editedNew.length, confirmedAll.length),
    note: 'Rows without sessionId are omitted, not backfilled. Completion = confirmed / record-started among voice captures. Unique-user division is not completion.',
  };
}

function productKpis(eventRows, registeredUsers, activatedUsers, now) {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const savesByUser = new Map();
  const historyAfterSave = new Set();
  const firstSave = new Map();
  const timesByUser = new Map();
  const fieldEdits = { good_points: 0, improve_points: 0, next_time_reminder: 0 };
  let fieldEditedEvents = 0;
  let confirmEvents = 0;
  let regenerateEvents = 0;
  let aiSuccessEvents = 0;
  let historyOpenedEvents = 0;
  let historySessionOpenedEvents = 0;
  let progressOpenedEvents = 0;

  for (const e of eventRows) {
    const ts = Number(e.created_at);
    if (e.user_id != null) {
      if (!timesByUser.has(e.user_id)) timesByUser.set(e.user_id, []);
      timesByUser.get(e.user_id).push(ts);
    }
    if (e.event_name === 'save_record') {
      confirmEvents += 1;
      if (e.user_id != null) {
        if (!savesByUser.has(e.user_id)) savesByUser.set(e.user_id, []);
        savesByUser.get(e.user_id).push(ts);
        if (!firstSave.has(e.user_id) || ts < firstSave.get(e.user_id)) firstSave.set(e.user_id, ts);
      }
    }
    if (eventMatches(e.event_name, 'ai_success')) aiSuccessEvents += 1;
    if (eventMatches(e.event_name, 'ai_regenerated')) regenerateEvents += 1;
    if (eventMatches(e.event_name, 'history_opened')) historyOpenedEvents += 1;
    if (eventMatches(e.event_name, 'history_session_opened')) historySessionOpenedEvents += 1;
    if (eventMatches(e.event_name, 'progress_opened')) progressOpenedEvents += 1;
    if (e.event_name === 'field_edited') {
      fieldEditedEvents += 1;
      const name = parseMeta(e.metadata).field_name;
      if (fieldEdits[name] != null) fieldEdits[name] += 1;
    }
  }

  for (const e of eventRows) {
    if (!eventMatches(e.event_name, 'history_opened') && !eventMatches(e.event_name, 'history_session_opened')) continue;
    const first = firstSave.get(e.user_id);
    if (first != null && Number(e.created_at) >= first) historyAfterSave.add(e.user_id);
  }

  const activated = [...savesByUser.keys()];
  let eligible7d = 0;
  let returned7d = 0;
  for (const uid of activated) {
    const first = firstSave.get(uid);
    if (now - first >= WEEK_MS) {
      eligible7d += 1;
      if ((timesByUser.get(uid) || []).some((t) => t >= first + WEEK_MS)) returned7d += 1;
    }
  }

  return {
    activationRate: pct(activatedUsers, registeredUsers),
    historyRevisitRate: pct(historyAfterSave.size, activated.length),
    d7RetentionRate: pct(returned7d, eligible7d),
    d7Eligible: eligible7d,
    d7Returned: returned7d,
    regenerateRateByEvents: pct(regenerateEvents, aiSuccessEvents),
    fieldEditedEvents,
    fieldEdits,
    confirmEvents,
    historyOpenedEvents,
    historySessionOpenedEvents,
    progressOpenedEvents,
    note: 'Activation = users with ≥1 confirmed save / registered. History revisit = opened history or a past record at/after first save. D7 = any event ≥7 days after first save. Sample includes self-test unless ANALYTICS_INTERNAL_EMAILS is set.',
  };
}

function splitInternal(eventRows, internalUserIds) {
  if (!internalUserIds.size) return { all: eventRows, realUsers: eventRows };
  return {
    all: eventRows,
    realUsers: eventRows.filter((e) => e.user_id == null || !internalUserIds.has(e.user_id)),
  };
}

module.exports = {
  FIELD_NAMES,
  ALIASES,
  CANONICAL_FUNNEL,
  FUNNEL_DEFINITION,
  knownEventNames,
  sanitizeEventMetadata,
  sessionHas,
  pct,
  utcDay,
  canonicalSessionFunnel,
  productKpis,
  splitInternal,
};
