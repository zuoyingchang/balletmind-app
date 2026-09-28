// Tests must not depend on the developer's local .env (dotenv never overrides a variable that is already set).
for (const k of ['AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY', 'AI_FALLBACK_PROVIDER', 'AI_FALLBACK_MODEL', 'AI_FORCED_TOOL_CHOICE']) process.env[k] = '';
process.env.AI_PROVIDER = 'anthropic';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.TURSO_DATABASE_URL = 'file::memory:';
process.env.ADMIN_KEY = 'test-admin-key';
process.env.DAILY_AI_LIMIT = '5';
process.env.RATE_LIMIT_DISABLED = '1'; // this suite registers many users from one IP; limiter has its own test file
process.env.AI_TIMEOUT_MS = '200'; // short, so the timeout test doesn't take 25s
process.env.ANTHROPIC_API_KEY = 'test-key-unused-fetch-is-mocked'; // real calls are always mocked in this file
process.env.OPENAI_API_KEY = 'test-openai-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app.js');
const { ASR_MODEL } = require('../config');
const db = require('../db');
const { countAiCallsToday } = require('../events');

let server;
let base;
let originalFetch;

test.before(async () => {
  await db.ready;
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
  originalFetch = global.fetch;
  global.fetch = (url, opts) => {
    if (String(url).includes('api.openai.com') && String(url).includes('/embeddings')) {
      return fakeOrthogonalEmbeddings(opts);
    }
    return originalFetch(url, opts);
  };
});

test.after(() => {
  global.fetch = originalFetch;
  server.close();
});

async function registerUser(email, password = 'secret123', displayName) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName, privacyAccepted: true }),
  });
  return { status: res.status, body: await res.json() };
}

test('register creates a user and returns a token', async () => {
  const { status, body } = await registerUser('alice@example.com', 'secret123', 'Alice');
  assert.equal(status, 200);
  assert.ok(body.token);
  assert.equal(body.user.email, 'alice@example.com');
  assert.equal(body.user.displayName, 'Alice');
});

test('register rejects a duplicate email', async () => {
  await registerUser('dupe@example.com');
  const { status, body } = await registerUser('dupe@example.com');
  assert.equal(status, 409);
  assert.ok(body.error);
});

test('register rejects a short password', async () => {
  const { status } = await registerUser('shortpw@example.com', '123');
  assert.equal(status, 400);
});

test('register and login reject a malformed email', async () => {
  const bad = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'not-an-email', password: 'secret123', privacyAccepted: true }),
  });
  assert.equal(bad.status, 400);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'abc', password: 'secret123' }),
  });
  assert.equal(login.status, 400);
});

test('register rejects missing privacy acceptance', async () => {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'noprivacy@example.com', password: 'secret123' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /隐私/);
});

test('login succeeds with correct credentials and fails with wrong password', async () => {
  await registerUser('bob@example.com', 'correcthorse');

  const ok = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'bob@example.com', password: 'correcthorse' }),
  });
  assert.equal(ok.status, 200);

  const bad = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'bob@example.com', password: 'wrongpassword' }),
  });
  assert.equal(bad.status, 401);
});

test('protected routes reject requests with no token', async () => {
  const res = await fetch(`${base}/api/records`);
  assert.equal(res.status, 401);
});

test('protected routes reject an invalid token', async () => {
  const res = await fetch(`${base}/api/records`, {
    headers: { Authorization: 'Bearer not-a-real-token' },
  });
  assert.equal(res.status, 401);
});

test('a user can create and list their own records', async () => {
  const { body: { token } } = await registerUser('carol@example.com');

  const create = await fetch(`${base}/api/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ className: '基训', transcript: '今天练了tendu', durationSec: 90 }),
  });
  assert.equal(create.status, 200);
  const { id } = await create.json();
  assert.ok(id);

  const list = await fetch(`${base}/api/records`, { headers: { Authorization: `Bearer ${token}` } });
  const rows = await list.json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].class_name, '基训');
  assert.equal(rows[0].transcript, '今天练了tendu');
});

test('check-in works without a recap, stores optional mood/duration/class, skips the capture funnel, and allows several sessions in one day', async () => {
  const { body: { token, user } } = await registerUser('checkin-flow@example.com');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const tzOffsetMin = new Date().getTimezoneOffset();

  const checkin = await fetch(`${base}/api/records/checkin`, {
    method: 'POST', headers,
    body: JSON.stringify({ tzOffsetMin, className: '基训', trainingDurationMin: 60, mood: 'good' }),
  });
  assert.equal(checkin.status, 200);
  const created = await checkin.json();
  assert.ok(created.id);

  const again = await fetch(`${base}/api/records/checkin`, {
    method: 'POST', headers, body: JSON.stringify({ tzOffsetMin, className: '基训' }),
  });
  assert.equal(again.status, 200);

  const barre = await fetch(`${base}/api/records/checkin`, {
    method: 'POST', headers, body: JSON.stringify({ tzOffsetMin, className: '把杆' }),
  });
  assert.equal(barre.status, 200);

  const list = await (await fetch(`${base}/api/records`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const checkins = list.filter((r) => Number(r.is_checkin_only) === 1);
  assert.equal(checkins.length, 3);
  assert.equal(checkins.filter((r) => r.class_name === '基训').length, 2);
  assert.equal(checkins.filter((r) => r.class_name === '把杆').length, 1);
  const row = list.find((r) => r.id === created.id);
  assert.equal(row.mood, 'good');
  assert.equal(Number(row.training_duration_min), 60);

  const events = await db.all('SELECT event_name FROM events WHERE user_id = ? ORDER BY id', [user.id]);
  const names = events.map((e) => e.event_name);
  assert.ok(names.includes('checkin_saved'));
  assert.equal(names.filter((n) => n === 'checkin_saved').length, 3);
  assert.equal(names.filter((n) => n === 'save_record').length, 0);
  assert.equal(names.filter((n) => n === 'session_confirmed').length, 0);
});

test('check-in does not re-fire recap-count milestones', async () => {
  const { body: { token } } = await registerUser('checkin-no-count-ms@example.com');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  for (let i = 0; i < 3; i++) await saveRecord(token, { className: '基训' });
  const res = await fetch(`${base}/api/records/checkin`, {
    method: 'POST', headers, body: JSON.stringify({ tzOffsetMin: new Date().getTimezoneOffset() }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.milestone, null);
});

test('first visit of a second week can celebrate a 来过 streak on check-in', async () => {
  const { body: { token, user } } = await registerUser('checkin-week-ms@example.com');
  const d = new Date();
  const day = d.getDay() || 7;
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - day + 1 - 7);
  await db.run(
    `INSERT INTO records
      (user_id, class_name, transcript, good_points, improve_points, next_time_reminder, session_tips, confidence_level, note, duration_sec, created_at, is_checkin_only)
    VALUES (?, '基训', '', '', '', '', '', '', '', 0, ?, 1)`,
    [user.id, d.getTime()]
  );
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const first = await fetch(`${base}/api/records/checkin`, {
    method: 'POST', headers, body: JSON.stringify({ tzOffsetMin: new Date().getTimezoneOffset() }),
  });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json().then((b) => b.milestone), { type: 'streak', value: 2 });
  const second = await fetch(`${base}/api/records/checkin`, {
    method: 'POST', headers, body: JSON.stringify({ tzOffsetMin: new Date().getTimezoneOffset() }),
  });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).milestone, null);
});

test('training_duration_min is optional and distinct from the voice memo length (duration_sec)', async () => {
  const { body: { token } } = await registerUser('trainedhours@example.com');

  const withDuration = await fetch(`${base}/api/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ className: '基训', transcript: 'x', durationSec: 12, trainingDurationMin: 90 }),
  });
  assert.equal(withDuration.status, 200);

  const withoutDuration = await fetch(`${base}/api/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ className: '基训', transcript: 'y', durationSec: 8 }),
  });
  assert.equal(withoutDuration.status, 200);

  const list = await fetch(`${base}/api/records`, { headers: { Authorization: `Bearer ${token}` } });
  const rows = await list.json();
  const tagged = rows.find((r) => r.transcript === 'x');
  const untagged = rows.find((r) => r.transcript === 'y');
  assert.equal(tagged.training_duration_min, 90);
  assert.equal(tagged.duration_sec, 12); // the two fields never get mixed up
  assert.equal(untagged.training_duration_min, null);
});

test('one user cannot see, fetch, or delete another user\'s records', async () => {
  const { body: { token: tokenA } } = await registerUser('dave@example.com');
  const { body: { token: tokenB } } = await registerUser('erin@example.com');

  const create = await fetch(`${base}/api/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ className: '私密记录', transcript: '只属于dave' }),
  });
  const { id } = await create.json();

  const listAsB = await fetch(`${base}/api/records`, { headers: { Authorization: `Bearer ${tokenB}` } });
  assert.deepEqual(await listAsB.json(), []);

  const getAsB = await fetch(`${base}/api/records/${id}`, { headers: { Authorization: `Bearer ${tokenB}` } });
  assert.equal(getAsB.status, 404);

  const deleteAsB = await fetch(`${base}/api/records/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tokenB}` } });
  assert.equal(deleteAsB.status, 200); // no-op: WHERE user_id=B matches nothing

  const getAsA = await fetch(`${base}/api/records/${id}`, { headers: { Authorization: `Bearer ${tokenA}` } });
  assert.equal(getAsA.status, 200); // dave's record survived erin's delete attempt
});

test('one user cannot see, or update, another user\'s recurring issues', async () => {
  const { body: { token: tokenA } } = await registerUser('gina@example.com');
  const { body: { token: tokenB } } = await registerUser('hank@example.com');

  // Save the same improve_points line twice so processRecordForIssues opens
  // a real "issues" row for A (isSimilar() needs a repeated line, not a
  // one-off — a single save never creates an issue).
  for (let i = 0; i < 2; i++) {
    await fetch(`${base}/api/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ className: '基训', improve_points: '转圈时骨盆晃动明显' }),
    });
  }
  const issuesAsA = await (await fetch(`${base}/api/issues`, { headers: { Authorization: `Bearer ${tokenA}` } })).json();
  assert.equal(issuesAsA.length, 1, 'saving the same improve_points twice should open exactly one issue');
  const issueId = issuesAsA[0].id;

  const issuesAsB = await fetch(`${base}/api/issues`, { headers: { Authorization: `Bearer ${tokenB}` } });
  assert.deepEqual(await issuesAsB.json(), []); // B sees none of A's issues

  const patchAsB = await fetch(`${base}/api/issues/${issueId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenB}` },
    body: JSON.stringify({ status: 'resolved' }),
  });
  assert.equal(patchAsB.status, 404); // B cannot resolve A's issue by guessing its id

  const issuesAsAAfter = await (await fetch(`${base}/api/issues`, { headers: { Authorization: `Bearer ${tokenA}` } })).json();
  assert.equal(issuesAsAAfter[0].status, 'open'); // A's issue is untouched by B's attempt
});

test('one user cannot see another user\'s term corrections, and corrections don\'t leak into the other user\'s AI prompt hint', async () => {
  const { body: { token: tokenA } } = await registerUser('iris@example.com');
  const { body: { token: tokenB, user: userB } } = await registerUser('jack@example.com');

  const addAsA = await fetch(`${base}/api/terms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ wrongTerm: '拍赛', correctTerm: 'passé' }),
  });
  assert.equal(addAsA.status, 200);

  const termsAsB = await fetch(`${base}/api/terms`, { headers: { Authorization: `Bearer ${tokenB}` } });
  assert.deepEqual(await termsAsB.json(), []);

  const { correctionsAsPromptHint } = require('../terms');
  const hintForB = await correctionsAsPromptHint(userB.id);
  assert.equal(hintForB, ''); // A's correction never reaches B's AI prompt
});

test('a user can delete their own record', async () => {
  const { body: { token } } = await registerUser('frank@example.com');
  const create = await fetch(`${base}/api/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ className: '待删除' }),
  });
  const { id } = await create.json();

  const del = await fetch(`${base}/api/records/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(del.status, 200);

  const get = await fetch(`${base}/api/records/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(get.status, 404);
});

test('/api/generate requires auth', async () => {
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript: '测试' }),
  });
  assert.equal(res.status, 401);
});

test('/api/generate rejects a transcript over the length cap', async () => {
  const { body: { token } } = await registerUser('toolong@example.com');
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ transcript: '啊'.repeat(4001) }),
  });
  assert.equal(res.status, 400);
});

test('/api/generate enforces the daily per-user quota', async () => {
  const { body: { token, user } } = await registerUser('quota@example.com');
  const { logEvent } = require('../events');
  for (let i = 0; i < 5; i++) await logEvent(user.id, 'ai_process_success', {});

  const res = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ transcript: '今天练了tendu' }),
  });
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.match(body.error, /今天的AI/);
});

// ---------- events ----------
test('/api/events requires auth', async () => {
  const res = await fetch(`${base}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'history_open' }),
  });
  assert.equal(res.status, 401);
});

test('/api/events rejects an unknown event name', async () => {
  const { body: { token } } = await registerUser('events_unknown@example.com');
  const res = await fetch(`${base}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ event: 'not_a_real_event' }),
  });
  assert.equal(res.status, 400);
});

test('/api/events logs a known event for the calling user', async () => {
  const { body: { token, user } } = await registerUser('events_known@example.com');
  const res = await fetch(`${base}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ event: 'history_open', metadata: { from: 'home' } }),
  });
  assert.equal(res.status, 200);

  const row = await db.get('SELECT * FROM events WHERE user_id = ? AND event_name = ?', [user.id, 'history_open']);
  assert.ok(row, 'expected an events row to be written');
  assert.deepEqual(JSON.parse(row.metadata), { from: 'home' });
});

test('session funnel counts one capture that starts and saves with the same sessionId', async () => {
  const { body: { user } } = await registerUser('session_funnel@example.com');
  const { logEvent } = require('../events');
  const { buildAdminStats } = require('../admin-stats');
  const sid = 'test-session-funnel-1';
  await logEvent(user.id, 'record_voice_start', { sessionId: sid });
  await logEvent(user.id, 'record_voice_complete', { sessionId: sid });
  await logEvent(user.id, 'asr_success', { sessionId: sid, latencyMs: 10 });
  await logEvent(user.id, 'ai_process_success', { sessionId: sid, latencyMs: 120 });
  await logEvent(user.id, 'review_opened', { sessionId: sid });
  await logEvent(user.id, 'save_record', { sessionId: sid, recordId: 1 });
  const stats = await buildAdminStats();
  assert.ok(stats.sessionFunnel.withSessionId >= 1);
  assert.ok(stats.sessionFunnel.voiceCaptures >= 1);
  assert.equal(stats.sessionFunnel.completionRate, 100);
  assert.ok(Array.isArray(stats.sessionFunnel.steps));
  assert.equal(stats.sessionFunnel.steps[stats.sessionFunnel.steps.length - 1].sessions >= 1, true);
  assert.equal(stats.metrics.doNotUseUniqueUserCompletion, true);
});

test('analytics metadata drops transcript and keeps field_name only', async () => {
  const { body: { user } } = await registerUser('sanitize_meta@example.com');
  const { logEvent } = require('../events');
  await logEvent(user.id, 'field_edited', {
    field_name: 'good_points',
    transcript: 'SECRET TEXT',
    good_points: 'also secret',
    sessionId: 'sid-sanitize',
  });
  const row = await db.get(
    "SELECT * FROM events WHERE user_id = ? AND event_name = 'field_edited'",
    [user.id]
  );
  const meta = JSON.parse(row.metadata);
  assert.equal(meta.field_name, 'good_points');
  assert.equal(meta.sessionId, 'sid-sanitize');
  assert.equal(meta.transcript, undefined);
  assert.equal(meta.good_points, undefined);
});

test('saving a record logs save_record and user_edit_ai_result events', async () => {
  const { body: { token, user } } = await registerUser('events_save@example.com');
  const create = await fetch(`${base}/api/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      className: '测试',
      good_points: '进步',
      edited: true,
      editedFields: ['good_points'],
      transcript: 'should-not-be-in-analytics',
    }),
  });
  assert.equal(create.status, 200);

  const saveEvent = await db.get('SELECT * FROM events WHERE user_id = ? AND event_name = ?', [user.id, 'save_record']);
  assert.ok(saveEvent);
  const saveMeta = JSON.parse(saveEvent.metadata);
  assert.equal(saveMeta.slotsFilled, 1);
  assert.equal(saveMeta.from, 'typed');
  assert.equal(saveMeta.transcript, undefined);
  const confirmed = await db.get('SELECT * FROM events WHERE user_id = ? AND event_name = ?', [user.id, 'session_confirmed']);
  assert.ok(confirmed);
  const editEvent = await db.get('SELECT * FROM events WHERE user_id = ? AND event_name = ?', [user.id, 'user_edit_ai_result']);
  assert.ok(editEvent);
  assert.equal(JSON.parse(editEvent.metadata).edited, true);
  const fieldEvent = await db.get('SELECT * FROM events WHERE user_id = ? AND event_name = ?', [user.id, 'field_edited']);
  assert.ok(fieldEvent);
  assert.equal(JSON.parse(fieldEvent.metadata).field_name, 'good_points');
  assert.equal(JSON.parse(fieldEvent.metadata).transcript, undefined);
});

// ---------- admin stats ----------
test('/api/admin/stats rejects requests with no admin key', async () => {
  const res = await fetch(`${base}/api/admin/stats`);
  assert.equal(res.status, 401);
});

test('/api/admin/stats rejects the wrong admin key', async () => {
  const res = await fetch(`${base}/api/admin/stats`, { headers: { 'X-Admin-Key': 'wrong-key' } });
  assert.equal(res.status, 401);
});

test('/api/admin/stats returns aggregate metrics with the correct key', async () => {
  const res = await fetch(`${base}/api/admin/stats`, { headers: { 'X-Admin-Key': 'test-admin-key' } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(typeof body.totals.users === 'number');
  assert.ok(typeof body.totals.records === 'number');
  assert.ok(typeof body.totals.events === 'number');
  assert.ok(body.eventCounts.save_record >= 1, 'expected at least the save_record events logged earlier in this run');
  assert.ok(Array.isArray(body.recentEvents));
  assert.ok(typeof body.totals.activatedUsers === 'number');
  assert.ok(body.funnel && body.funnel.byUniqueUsers);
  assert.ok(Array.isArray(body.funnel.steps));
  assert.ok(body.sessionFunnel);
  assert.ok(body.retention);
  assert.ok('p95LatencyMs' in body.aiUsage);
  assert.ok(Array.isArray(body.eventBreakdown));
});

test('/api/admin/events requires the admin key and never returns email', async () => {
  const denied = await fetch(`${base}/api/admin/events`);
  assert.equal(denied.status, 401);
  const { body: { user } } = await registerUser('admin_events@example.com');
  const { logEvent } = require('../events');
  await logEvent(user.id, 'ai_process_fail', { reason: 'timeout', chars: 12 });
  const res = await fetch(`${base}/api/admin/events?event=ai_process_fail&limit=20`, {
    headers: { 'X-Admin-Key': 'test-admin-key' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.events));
  const row = body.events.find((e) => e.user_id === user.id);
  assert.ok(row);
  assert.equal(row.event_name, 'ai_process_fail');
  assert.equal(row.email, undefined);
  const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
  assert.equal(meta.reason, 'timeout');
  assert.equal(meta.chars, 12);
  assert.equal(meta.transcript, undefined);
});

test('/api/admin/events rejects an unknown event name', async () => {
  const res = await fetch(`${base}/api/admin/events?event=not_a_real_event`, {
    headers: { 'X-Admin-Key': 'test-admin-key' },
  });
  assert.equal(res.status, 400);
});

// ---------- response caching ----------
test('all /api responses carry Cache-Control: no-store (never cache per-user data)', async () => {
  const { body: { token } } = await registerUser('nostore@example.com');
  const res = await fetch(`${base}/api/records`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

// ---------- recurring issue tracking ----------
async function saveRecord(token, body) {
  const res = await fetch(`${base}/api/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return res.json();
}

test('/api/issues requires auth', async () => {
  const res = await fetch(`${base}/api/issues`);
  assert.equal(res.status, 401);
});

test('saving a record with improve_points opens a new issue', async () => {
  const { body: { token } } = await registerUser('issue_new@example.com');
  await saveRecord(token, { className: '基训', improve_points: '左侧转圈重心不稳' });

  const res = await fetch(`${base}/api/issues`, { headers: { Authorization: `Bearer ${token}` } });
  const issues = await res.json();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].text, '左侧转圈重心不稳');
  assert.equal(issues[0].occurrence_count, 1);
  assert.equal(issues[0].status, 'open');
  assert.equal(issues[0].occurrences.length, 1);
});

test('a similar improve_points line on a later record bumps the existing issue instead of creating a new one', async () => {
  const { body: { token } } = await registerUser('issue_repeat@example.com');
  await saveRecord(token, { className: '基训1', improve_points: '重心不稳' });
  await saveRecord(token, { className: '基训2', improve_points: '转圈的时候重心不稳，需要多加练习' });

  const res = await fetch(`${base}/api/issues`, { headers: { Authorization: `Bearer ${token}` } });
  const issues = await res.json();
  assert.equal(issues.length, 1, 'the two similar lines should collapse into one issue');
  assert.equal(issues[0].occurrence_count, 2);
  assert.equal(issues[0].occurrences.length, 2);
});

test('an unrelated improve_points line creates a separate issue', async () => {
  const { body: { token } } = await registerUser('issue_separate@example.com');
  await saveRecord(token, { className: '基训1', improve_points: '重心不稳' });
  await saveRecord(token, { className: '基训2', improve_points: '手臂线条不够舒展' });

  const res = await fetch(`${base}/api/issues`, { headers: { Authorization: `Bearer ${token}` } });
  const issues = await res.json();
  assert.equal(issues.length, 2);
});

test('PATCH /api/issues/:id updates status and only the owner can update it', async () => {
  const { body: { token: tokenA } } = await registerUser('issue_owner@example.com');
  const { body: { token: tokenB } } = await registerUser('issue_notowner@example.com');
  await saveRecord(tokenA, { className: '基训', improve_points: '脚踝发力不够' });
  const [issue] = await (await fetch(`${base}/api/issues`, { headers: { Authorization: `Bearer ${tokenA}` } })).json();

  const wrongUser = await fetch(`${base}/api/issues/${issue.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenB}` },
    body: JSON.stringify({ status: 'resolved' }),
  });
  assert.equal(wrongUser.status, 404);

  const invalidStatus = await fetch(`${base}/api/issues/${issue.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ status: 'not_a_real_status' }),
  });
  assert.equal(invalidStatus.status, 400);

  const ok = await fetch(`${base}/api/issues/${issue.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ status: 'resolved' }),
  });
  assert.equal(ok.status, 200);
  const listed = await (await fetch(`${base}/api/issues`, { headers: { Authorization: `Bearer ${tokenA}` } })).json();
  assert.equal(listed.length, 0, 'resolved issues leave the tracking list');

  const review = await (await fetch(`${base}/api/progress/review`, { headers: { Authorization: `Bearer ${tokenA}` } })).json();
  assert.equal(review.openIssues.length, 0);
  assert.equal(review.resolvedInPeriod.length, 1);
  assert.equal(review.resolvedInPeriod[0].text, '脚踝发力不够');
});

// ---------- progress: training review + pre-class brief ----------
test('/api/progress/review and /api/progress/brief require auth', async () => {
  assert.equal((await fetch(`${base}/api/progress/review`)).status, 401);
  assert.equal((await fetch(`${base}/api/progress/brief`)).status, 401);
});

test('/api/progress/review aggregates records and open issues with zero AI calls', async () => {
  const { body: { token, user } } = await registerUser('review@example.com');
  await saveRecord(token, { className: '基训', good_points: '高位更稳定', improve_points: '重心不稳' });

  const before = await countAiCallsToday(user.id);
  const res = await fetch(`${base}/api/progress/review`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'days');
  assert.equal(body.recordCount, 1);
  assert.equal(body.openIssues.length, 1);
  assert.ok(body.goodPointsRecap.includes('高位更稳定'));
  const after = await countAiCallsToday(user.id);
  assert.equal(after, before, 'training review must not consume the AI quota');
});

test('/api/progress/review?last=5 returns the most recent N records, not a calendar window', async () => {
  const { body: { token, user } } = await registerUser('review_last@example.com');
  for (let i = 1; i <= 6; i++) {
    await saveRecord(token, { className: `课${i}`, good_points: `优点${i}` });
  }

  const before = await countAiCallsToday(user.id);
  const res = await fetch(`${base}/api/progress/review?last=5`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'last');
  assert.equal(body.lastCount, 5);
  assert.equal(body.recordCount, 5);
  assert.deepEqual(body.records.map((r) => r.className), ['课2', '课3', '课4', '课5', '课6']);
  assert.ok(body.goodPointsRecap.includes('优点6'));
  assert.equal(body.goodPointsRecap.includes('优点1'), false);
  const week = await (await fetch(`${base}/api/progress/review?days=7`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(week.recordCount, 6);
  const after = await countAiCallsToday(user.id);
  assert.equal(after, before, 'last-N review must not consume the AI quota');
});

test('/api/progress/brief returns top open issues and the last record, zero AI calls', async () => {
  const { body: { token, user } } = await registerUser('brief@example.com');
  await saveRecord(token, { className: '基训', improve_points: '重心不稳', next_time_reminder: '多练习passé' });

  const before = await countAiCallsToday(user.id);
  const res = await fetch(`${base}/api/progress/brief`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.topIssues.length, 1);
  assert.equal(body.lastRecord.nextTimeReminder, '多练习passé');
  assert.equal(body.experimentBrief, undefined, 'experiment gate default-off must not attach LLM copy');
  const after = await countAiCallsToday(user.id);
  assert.equal(after, before, 'pre-class brief must not consume the AI quota');
});

test('/api/progress/brief lastRecord skips a later check-in and keeps the recap reminder', async () => {
  const { body: { token } } = await registerUser('brief-skip-checkin@example.com');
  await saveRecord(token, { className: '基训', improve_points: '胯不要掉', next_time_reminder: '上课先对一下 alignment' });
  const checkin = await fetch(`${base}/api/records/checkin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tzOffsetMin: new Date().getTimezoneOffset(), className: '基训' }),
  });
  assert.equal(checkin.status, 200);

  const body = await (await fetch(`${base}/api/progress/brief`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(body.lastRecord.nextTimeReminder, '上课先对一下 alignment');
  assert.equal(body.lastRecord.improvePoints, '胯不要掉');
});

// ---------- milestone celebration ----------
test('count milestones fire at 1/3/5, then every 5th from the 10th record on', async () => {
  const { body: { token } } = await registerUser('milestone@example.com');
  const milestoneCounts = new Set([1, 3, 5, 10, 15]);

  let lastResult;
  for (let i = 1; i <= 15; i++) {
    lastResult = await saveRecord(token, { className: '基训' + i });
    if (milestoneCounts.has(i)) assert.deepEqual(lastResult.milestone, { type: 'count', value: i }, `record #${i} should be a milestone`);
    else assert.equal(lastResult.milestone, null, `record #${i} should not be a milestone`);
  }
});

// ---------- terminology correction memory ----------
test('/api/terms requires auth', async () => {
  const res = await fetch(`${base}/api/terms`);
  assert.equal(res.status, 401);
});

test('/api/terms rejects a correction missing either term', async () => {
  const { body: { token } } = await registerUser('terms_invalid@example.com');
  const res = await fetch(`${base}/api/terms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ wrongTerm: '拍赛' }),
  });
  assert.equal(res.status, 400);
});

test('a saved term correction shows up in the list and in the AI prompt hint', async () => {
  const { body: { token, user } } = await registerUser('terms_valid@example.com');
  const res = await fetch(`${base}/api/terms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ wrongTerm: '拍赛', correctTerm: 'passé' }),
  });
  assert.equal(res.status, 200);

  const list = await (await fetch(`${base}/api/terms`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].correct_term, 'passé');

  const { correctionsAsPromptHint } = require('../terms');
  const hint = await correctionsAsPromptHint(user.id);
  assert.match(hint, /拍赛/);
  assert.match(hint, /passé/);
});

test('correctionsAsPromptHint returns an empty string when the user has no corrections', async () => {
  const { body: { user } } = await registerUser('terms_none@example.com');
  const { correctionsAsPromptHint } = require('../terms');
  assert.equal(await correctionsAsPromptHint(user.id), '');
});

// ---------- retry / timeout / cost & latency logging ----------
// generate.js calls the global fetch for the Anthropic request specifically —
// swap it out for the duration of one test, delegating anything that isn't
// an api.anthropic.com call (i.e. this file's own HTTP calls to our test
// server) through to the real fetch, then always restore it.
async function withMockAnthropicFetch(mockFn, run, embeddingsFn) {
  const realFetch = global.fetch;
  global.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('api.anthropic.com')) return mockFn(url, opts);
    if (u.includes('api.openai.com') && u.includes('/embeddings')) {
      const fn = embeddingsFn || fakeOrthogonalEmbeddings;
      return fn(opts);
    }
    return realFetch(url, opts);
  };
  try {
    await run();
  } finally {
    global.fetch = realFetch;
  }
}

function fakeOrthogonalEmbeddings(opts) {
  const parsed = opts && opts.body ? JSON.parse(opts.body) : {};
  const input = Array.isArray(parsed.input) ? parsed.input : [parsed.input || ''];
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: input.map((_, i) => ({
        index: i,
        embedding: i === 0 ? [1, 0] : [0, 1],
      })),
    }),
  };
}

function fakeAnthropicResponse({ good = [], improve = [], next = [], tips = [], confidence = '高', note = '', inputTokens = 120, outputTokens = 60 } = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: 'tool_use', name: 'submit_review', input: {
        good_points: good, improve_points: improve, next_time_reminder: next, session_tips: tips, confidence_level: confidence, note,
      } }],
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }),
  };
}

test('a transient network failure is retried once and succeeds, and success is logged with attempt/latency/token usage', async () => {
  const { body: { token, user } } = await registerUser('retry_success@example.com');
  let calls = 0;

  await withMockAnthropicFetch(
    async () => {
      calls++;
      if (calls === 1) throw new Error('simulated network failure');
      return fakeAnthropicResponse({ good: ['高位更稳定'] });
    },
    async () => {
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transcript: '今天练了基本功' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.good_points, '高位更稳定');
    }
  );

  assert.equal(calls, 2, 'expected exactly one retry (two total attempts)');
  const event = await db.get(
    "SELECT * FROM events WHERE user_id = ? AND event_name = 'ai_process_success' ORDER BY id DESC LIMIT 1",
    [user.id]
  );
  const meta = JSON.parse(event.metadata);
  assert.equal(meta.attempt, 2);
  assert.equal(meta.inputTokens, 120);
  assert.equal(meta.outputTokens, 60);
  assert.equal(meta.cacheReadTokens, 0);
  assert.equal(meta.cacheCreationTokens, 0);
  assert.ok(meta.model);
  assert.ok(typeof meta.latencyMs === 'number' && meta.latencyMs >= 0);
});

test('/api/generate returns session_tips from the tool payload', async () => {
  const { body: { token } } = await registerUser('session_tips_generate@example.com');
  await withMockAnthropicFetch(
    async () => fakeAnthropicResponse({ good: ['passé 尚可'], tips: ['转的时候留意骨盆'] }),
    async () => {
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transcript: '今天pirouette骨盆晃' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.session_tips, '转的时候留意骨盆');
    }
  );
});

test('saving a record stores session_tips without opening an issue from it', async () => {
  const { body: { token } } = await registerUser('session_tips_save@example.com');
  await saveRecord(token, {
    className: '基训',
    improve_points: '重心不稳',
    session_tips: '转的时候留意重心',
  });
  const recRes = await fetch(`${base}/api/records`, { headers: { Authorization: `Bearer ${token}` } });
  const records = await recRes.json();
  assert.equal(records[0].session_tips, '转的时候留意重心');
  const issueRes = await fetch(`${base}/api/issues`, { headers: { Authorization: `Bearer ${token}` } });
  const issues = await issueRes.json();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].text, '重心不稳');
});

test('Sonnet 5 Anthropic body omits temperature; Sonnet 4.6 still sends it', async () => {
  const { body: { token } } = await registerUser('sonnet5_no_temp@example.com');
  const prev = process.env.AI_MODEL;
  try {
    process.env.AI_MODEL = 'claude-sonnet-5';
    let body5;
    await withMockAnthropicFetch(
      async (_url, opts) => {
        body5 = JSON.parse(opts.body);
        return fakeAnthropicResponse({ good: ['ok'] });
      },
      async () => {
        const res = await fetch(`${base}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ transcript: '今天练了基本功' }),
        });
        assert.equal(res.status, 200);
      }
    );
    assert.equal(body5.model, 'claude-sonnet-5');
    assert.equal(body5.temperature, undefined);
    assert.ok(body5.tools[0].input_schema.properties.session_tips);
    assert.ok(body5.tool_choice && body5.tools);

    process.env.AI_MODEL = 'claude-sonnet-4-6';
    let body46;
    await withMockAnthropicFetch(
      async (_url, opts) => {
        body46 = JSON.parse(opts.body);
        return fakeAnthropicResponse({ good: ['ok'] });
      },
      async () => {
        const res = await fetch(`${base}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ transcript: '今天练了基本功' }),
        });
        assert.equal(res.status, 200);
      }
    );
    assert.equal(body46.model, 'claude-sonnet-4-6');
    assert.equal(body46.temperature, 0.2);
  } finally {
    if (prev === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = prev;
  }
});

test('a persistent 5xx from Anthropic is retried once, then surfaced as a 502 (not silently retried forever)', async () => {
  const { body: { token, user } } = await registerUser('retry_persistent_5xx@example.com');
  let calls = 0;

  await withMockAnthropicFetch(
    async () => { calls++; return { ok: false, status: 503, text: async () => 'upstream overloaded' }; },
    async () => {
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transcript: '今天练了基本功' }),
      });
      assert.equal(res.status, 502);
    }
  );

  assert.equal(calls, 2, 'expected exactly two attempts total, not an unbounded retry loop');
  const event = await db.get(
    "SELECT * FROM events WHERE user_id = ? AND event_name = 'ai_process_fail' ORDER BY id DESC LIMIT 1",
    [user.id]
  );
  assert.equal(JSON.parse(event.metadata).reason, 'api_error');
});

test('a 4xx from Anthropic is NOT retried — the request itself is wrong, retrying would not help', async () => {
  const { body: { token } } = await registerUser('no_retry_4xx@example.com');
  let calls = 0;

  await withMockAnthropicFetch(
    async () => { calls++; return { ok: false, status: 400, text: async () => 'bad request' }; },
    async () => {
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transcript: '今天练了基本功' }),
      });
      assert.equal(res.status, 502);
    }
  );

  assert.equal(calls, 1, 'a 4xx should fail fast, not be retried');
});

test('a request that never resolves times out and is reported as a timeout, not a generic error', async () => {
  const { body: { token, user } } = await registerUser('timeout@example.com');
  let calls = 0;

  await withMockAnthropicFetch(
    (url, opts) => {
      calls++;
      return new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    },
    async () => {
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transcript: '今天练了基本功' }),
      });
      assert.equal(res.status, 504);
      const body = await res.json();
      assert.match(body.error, /超时/);
    }
  );

  assert.equal(calls, 2, 'a timeout is transient, so it should still get one retry');
  const event = await db.get(
    "SELECT * FROM events WHERE user_id = ? AND event_name = 'ai_process_fail' ORDER BY id DESC LIMIT 1",
    [user.id]
  );
  assert.equal(JSON.parse(event.metadata).reason, 'timeout');
});

test('/api/admin/stats aggregates real token usage and latency from ai_process_success events', async () => {
  const { body: { token } } = await registerUser('usage_stats@example.com');

  await withMockAnthropicFetch(
    async () => fakeAnthropicResponse({ good: ['测试'], inputTokens: 200, outputTokens: 80 }),
    async () => {
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transcript: '今天练了基本功' }),
      });
      assert.equal(res.status, 200);
    }
  );

  const stats = await (await fetch(`${base}/api/admin/stats`, { headers: { 'X-Admin-Key': 'test-admin-key' } })).json();
  assert.ok(stats.aiUsage.totalInputTokens >= 200);
  assert.ok(stats.aiUsage.totalOutputTokens >= 80);
  assert.ok(stats.aiUsage.callCount >= 1);
  assert.ok(stats.aiUsage.p95LatencyMs === null || typeof stats.aiUsage.p95LatencyMs === 'number');
  assert.ok(typeof stats.aiUsage.estimatedUsd === 'number');
  assert.ok(stats.aiUsage.byProvider);
  assert.ok(stats.asrUsage.whisper);
  assert.equal(stats.asrUsage.whisper.estimatedTokens, null);
  assert.ok(stats.metrics.progressOpenCount === 0 || typeof stats.metrics.progressOpenCount === 'number');
});

test('admin stats splits DeepSeek / Anthropic tokens and Whisper minutes', async () => {
  const { body: { user } } = await registerUser('cost-split@example.com');
  const { logEvent } = require('../events');
  const { buildAdminStats } = require('../admin-stats');
  await logEvent(user.id, 'ai_process_success', {
    provider: 'deepseek', model: 'deepseek-chat', inputTokens: 1000000, outputTokens: 0, latencyMs: 10,
  });
  await logEvent(user.id, 'ask_success', {
    provider: 'anthropic', model: 'claude-sonnet-5', fellBack: true, inputTokens: 0, outputTokens: 1000000, latencyMs: 12,
  });
  await logEvent(user.id, 'asr_success', { model: 'whisper-1', durationSec: 60, latencyMs: 8 });
  const stats = await buildAdminStats();
  assert.ok(stats.aiUsage.byProvider.deepseek.callCount >= 1);
  assert.ok(stats.aiUsage.byProvider.anthropic.callCount >= 1);
  assert.ok(stats.aiUsage.byProvider.deepseek.inputTokens >= 1000000);
  assert.ok(stats.aiUsage.byProvider.anthropic.outputTokens >= 1000000);
  assert.ok(stats.asrUsage.whisper.callCount >= 1);
  assert.ok(stats.asrUsage.whisper.estimatedMinutes >= 1);
  assert.equal(stats.asrUsage.whisper.estimatedTokens, null);
  assert.ok(stats.asrUsage.whisper.estimatedUsd != null);
});

// ---------- password reset ----------
test('forgot-password does not leak whether an email is registered', async () => {
  const missing = await fetch(`${base}/api/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody-here@example.com' }),
  });
  assert.equal(missing.status, 200);
  const missingBody = await missing.json();
  assert.equal(missingBody.resetUrl, undefined);

  await registerUser('resetme@example.com', 'oldpassword');
  const found = await fetch(`${base}/api/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'resetme@example.com' }),
  });
  assert.equal(found.status, 200);
  const foundBody = await found.json();
  assert.ok(foundBody.resetUrl, 'non-production should return a resetUrl for local testing');
  const token = new URL(foundBody.resetUrl).searchParams.get('token');
  assert.ok(token);

  const reset = await fetch(`${base}/api/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password: 'newpassword' }),
  });
  assert.equal(reset.status, 200);

  const oldPw = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'resetme@example.com', password: 'oldpassword' }),
  });
  assert.equal(oldPw.status, 401);

  const newPw = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'resetme@example.com', password: 'newpassword' }),
  });
  assert.equal(newPw.status, 200);

  const reused = await fetch(`${base}/api/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password: 'anotherpassword' }),
  });
  assert.equal(reused.status, 400);
});

// ---------- Whisper ASR ----------
async function withMockOpenAIFetch(mockFn, run) {
  const realFetch = global.fetch;
  global.fetch = (url, opts) => {
    if (String(url).includes('api.openai.com')) return mockFn(url, opts);
    return realFetch(url, opts);
  };
  try {
    await run();
  } finally {
    global.fetch = realFetch;
  }
}

test('/api/transcribe requires auth', async () => {
  const res = await fetch(`${base}/api/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/webm' },
    body: Buffer.from('fake-audio'),
  });
  assert.equal(res.status, 401);
});

test('/api/transcribe/status reports that Whisper is configured in tests', async () => {
  const { body: { token } } = await registerUser('asr-status@example.com');
  const res = await fetch(`${base}/api/transcribe/status`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.configured, true);
  assert.equal(body.model, ASR_MODEL);
});

test('/api/transcribe returns transcribed text and logs asr_success with model/latency', async () => {
  const { body: { token, user } } = await registerUser('asr-ok@example.com');
  await withMockOpenAIFetch(
    async () => ({
      ok: true,
      json: async () => ({ text: '今天 pirouette 单圈，passé 位置还行' }),
    }),
    async () => {
      const res = await fetch(`${base}/api/transcribe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'audio/webm',
          Authorization: `Bearer ${token}`,
          'X-Audio-Duration-Sec': '12.5',
        },
        body: Buffer.from('fake-audio-bytes-that-are-long-enough'),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.match(body.text, /pirouette/);
      assert.equal(body.model, ASR_MODEL);
    }
  );
  const event = await db.get(
    "SELECT * FROM events WHERE user_id = ? AND event_name = 'asr_success' ORDER BY id DESC LIMIT 1",
    [user.id]
  );
  const meta = JSON.parse(event.metadata);
  assert.equal(meta.model, ASR_MODEL);
  assert.equal(meta.durationSec, 12.5);
  assert.ok(typeof meta.latencyMs === 'number');
});

test('eval golden set is a 30–50 case offline pack with rubric and types', () => {
  const { CASES } = require('../eval/cases');
  assert.ok(CASES.length >= 30, `expected >= 30 cases, got ${CASES.length}`);
  assert.ok(CASES.length <= 50, `keep the set small enough to rerun, got ${CASES.length}`);
  for (const c of CASES) {
    assert.ok(c.name && c.transcript !== undefined && c.rubric && c.type && Array.isArray(c.dimensions) && typeof c.check === 'function', c.name);
  }
});

test('/api/transcribe enforces the shared daily AI quota', async () => {
  const { body: { token, user } } = await registerUser('asr-quota@example.com');
  const { logEvent } = require('../events');
  for (let i = 0; i < 5; i++) await logEvent(user.id, 'asr_success', {});

  const res = await fetch(`${base}/api/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/webm', Authorization: `Bearer ${token}` },
    body: Buffer.from('fake-audio'),
  });
  assert.equal(res.status, 429);
});

// ---------- ask-your-archive ----------
function fakeAskResponse({ answered = true, answer = '', citedRecordIds = [], inputTokens = 90, outputTokens = 40 } = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: 'tool_use', name: 'submit_answer', input: {
        answered, answer_points: answer ? [answer] : [], cited_record_ids: citedRecordIds,
      } }],
      usage: {
        input_tokens: inputTokens, output_tokens: outputTokens,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      },
    }),
  };
}

test('/api/progress/ask requires auth', async () => {
  const res = await fetch(`${base}/api/progress/ask?q=转圈`);
  assert.equal(res.status, 401);
});

test('/api/progress/ask with no matching records answers "not found" without calling the AI', async () => {
  const { body: { token } } = await registerUser('ask_nomatch@example.com');
  await saveRecord(token, { className: '基训', improve_points: '手臂位置不对' });

  let calls = 0;
  await withMockAnthropicFetch(
    async () => { calls++; return fakeAskResponse(); },
    async () => {
      const res = await fetch(`${base}/api/progress/ask?q=完全无关的问题xyz`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.answered, false);
      assert.deepEqual(body.matchedRecords, []);
      assert.equal(body.retrievalPath, 'none');
    }
  );
  assert.equal(calls, 0, 'no AI call should happen when retrieval finds nothing');
});

test('/api/progress/ask retrieves the matching record and returns a cited answer', async () => {
  const { body: { token } } = await registerUser('ask_match@example.com');
  const saved = await saveRecord(token, {
    className: '基训', improve_points: '转圈的时候重心不稳', next_time_reminder: '多练习定点',
  });

  let seenQuestion = null;
  await withMockAnthropicFetch(
    async (url, opts) => {
      seenQuestion = JSON.parse(opts.body).messages[0].content;
      return fakeAskResponse({ answered: true, answer: '你在转圈时提到过重心不稳。', citedRecordIds: [saved.id] });
    },
    async () => {
      const res = await fetch(`${base}/api/progress/ask?q=${encodeURIComponent('我转圈的时候有什么问题')}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.answered, true);
      assert.match(body.answerPoints.join(' '), /重心不稳/);
      assert.equal(body.matchedRecords.length, 1);
      assert.equal(body.matchedRecords[0].id, saved.id);
    }
  );
  assert.match(seenQuestion, /转圈的时候重心不稳/, 'the matched record content should have been sent to the model');
});

test('/api/progress/ask only searches the caller\'s own records, not another user\'s', async () => {
  const { body: { token: tokenA } } = await registerUser('ask_owner@example.com');
  const { body: { token: tokenB } } = await registerUser('ask_notowner@example.com');
  await saveRecord(tokenB, { className: '基训', improve_points: '转圈时膝盖没绷直' });

  const res = await fetch(`${base}/api/progress/ask?q=转圈`, { headers: { Authorization: `Bearer ${tokenA}` } });
  const body = await res.json();
  assert.equal(body.answered, false, "user A must not get an answer built from user B's records");
});

test('/api/progress/ask enforces the secondary daily AI quota once a match is found', async () => {
  const { body: { token, user } } = await registerUser('ask_quota@example.com');
  await saveRecord(token, { className: '基训', improve_points: '转圈时重心不稳' });
  const { logEvent } = require('../events');
  // Fills the secondary pool (ask + issue-brief), not the core one -- recording/saving a class
  // should never be blocked by this, which is the whole point of the two pools being separate.
  for (let i = 0; i < 5; i++) await logEvent(user.id, 'ask_success', {});

  const res = await fetch(`${base}/api/progress/ask?q=转圈`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 429);
});

test('core and secondary daily AI quotas are isolated from each other', async () => {
  const { logEvent } = require('../events');

  // Maxing out the core pool (asr + generate) must not block ask-your-archive.
  const { body: { token: coreMaxed, user: coreUser } } = await registerUser('quota_core_maxed@example.com');
  await saveRecord(coreMaxed, { className: '基训', improve_points: '转圈时重心不稳' });
  for (let i = 0; i < 5; i++) await logEvent(coreUser.id, 'ai_process_success', {});
  await withMockAnthropicFetch(
    async () => fakeAskResponse({ answered: true, answer: '重心不稳。', citedRecordIds: [] }),
    async () => {
      const res = await fetch(`${base}/api/progress/ask?q=转圈`, { headers: { Authorization: `Bearer ${coreMaxed}` } });
      assert.equal(res.status, 200, 'a maxed-out core pool must not block the secondary pool');
    }
  );

  // Maxing out the secondary pool (ask + issue-brief) must not block /api/generate.
  const { body: { token: secondaryMaxed, user: secondaryUser } } = await registerUser('quota_secondary_maxed@example.com');
  for (let i = 0; i < 5; i++) await logEvent(secondaryUser.id, 'ask_success', {});
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secondaryMaxed}` },
    body: JSON.stringify({ transcript: '今天练了tendu' }),
  });
  assert.notEqual(res.status, 429, 'a maxed-out secondary pool must not block the core pool');
});

// ---------- ask-your-archive: the one-hop agent (optional 2nd search) ----------
test('/api/progress/ask costs exactly one Claude call when the model answers from round 1', async () => {
  const { body: { token } } = await registerUser('ask_oneround@example.com');
  await saveRecord(token, { className: '基训', improve_points: '转圈时重心不稳' });

  let calls = 0;
  await withMockAnthropicFetch(
    async () => { calls++; return fakeAskResponse({ answered: true, answer: '重心不稳。', citedRecordIds: [] }); },
    async () => {
      const res = await fetch(`${base}/api/progress/ask?q=转圈`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.rounds, 1);
    }
  );
  assert.equal(calls, 1, 'a question the first batch already answers must not trigger a second hop');
});

test('/api/progress/ask makes exactly one extra search when the model asks for one, then is forced to answer', async () => {
  const { body: { token } } = await registerUser('ask_tworound@example.com');
  const saved = await saveRecord(token, { className: '基训', improve_points: '转圈时重心不稳' });

  let calls = 0;
  const seenToolChoiceTypes = [];
  await withMockAnthropicFetch(
    async (url, opts) => {
      calls++;
      seenToolChoiceTypes.push(JSON.parse(opts.body).tool_choice.type);
      if (calls === 1) {
        return {
          ok: true, status: 200,
          json: async () => ({
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'search_records', input: { keywords: '转圈', after: '2000-01-01' } }],
            usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          }),
        };
      }
      return fakeAskResponse({ answered: true, answer: '两段时间都提到重心不稳。', citedRecordIds: [saved.id] });
    },
    async () => {
      const res = await fetch(`${base}/api/progress/ask?q=${encodeURIComponent('这个月和上个月转圈有什么不同')}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.rounds, 2);
      assert.equal(body.answered, true);
      assert.equal(body.matchedRecords.length, 1);
    }
  );
  assert.equal(calls, 2, 'expected exactly 2 Claude calls: one where the model chooses, one forced answer');
  assert.deepEqual(seenToolChoiceTypes, ['auto', 'tool'], 'round 1 must let the model choose; round 2 must be forced to submit_answer so the loop cannot run a 3rd time');
});

test('/api/progress/ask clamps a search_records date range to the user\'s own record history', async () => {
  const { body: { token } } = await registerUser('ask_dateclamp@example.com');
  await saveRecord(token, { className: '基训', improve_points: '转圈时重心不稳' });

  let secondCallQuestionText = null;
  let calls = 0;
  await withMockAnthropicFetch(
    async (url, opts) => {
      calls++;
      if (calls === 1) {
        return {
          ok: true, status: 200,
          json: async () => ({
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'search_records', input: { keywords: '转圈', after: '1999-01-01', before: '2999-01-01' } }],
            usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          }),
        };
      }
      const body = JSON.parse(opts.body);
      secondCallQuestionText = body.messages[body.messages.length - 1].content[0].content;
      return fakeAskResponse({ answered: true, answer: 'ok', citedRecordIds: [] });
    },
    async () => {
      const res = await fetch(`${base}/api/progress/ask?q=${encodeURIComponent('转圈这个月和上个月有什么不同')}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
    }
  );
  // Out-of-range 1999/2999 dates must not have blown up the search into an
  // error or an empty/unbounded result — it should have found the one real
  // record, clamped to this user's actual history.
  assert.match(secondCallQuestionText, /重心不稳/, 'the out-of-range request should still clamp to and return the real record');
});

test('/api/progress/ask uses embedding when keywords miss a paraphrase of the record', async () => {
  const { body: { token } } = await registerUser('ask_embed@example.com');
  const saved = await saveRecord(token, {
    className: '基训', improve_points: '转圈的时候重心不稳', next_time_reminder: '多练习定点',
  });

  let embedCalls = 0;
  let claudeCalls = 0;
  await withMockAnthropicFetch(
    async () => {
      claudeCalls++;
      return fakeAskResponse({ answered: true, answer: '记录里写过重心不稳。', citedRecordIds: [saved.id] });
    },
    async () => {
      const res = await fetch(`${base}/api/progress/ask?q=${encodeURIComponent('感觉站不太住')}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.answered, true);
      assert.equal(body.retrievalPath, 'embedding');
      assert.equal(body.matchedRecords[0].id, saved.id);
    },
    (opts) => {
      embedCalls++;
      const input = JSON.parse(opts.body).input;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: input.map((text, i) => ({
            index: i,
            embedding: (i === 0 || String(text).includes('重心不稳')) ? [1, 0] : [0, 1],
          })),
        }),
      };
    }
  );
  assert.equal(embedCalls, 1, 'sparse keyword must trigger one embedding call');
  assert.equal(claudeCalls, 1);
});

test('/api/progress/ask skips embedding when keyword already returned 2+ records', async () => {
  const { body: { token } } = await registerUser('ask_dense@example.com');
  await saveRecord(token, { className: '基训', improve_points: '转圈重心不稳' });
  await saveRecord(token, { className: '基训', improve_points: '转圈骨盆晃' });

  let embedCalls = 0;
  await withMockAnthropicFetch(
    async () => fakeAskResponse({ answered: true, answer: '两条都写了转圈。', citedRecordIds: [] }),
    async () => {
      const res = await fetch(`${base}/api/progress/ask?q=转圈`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.retrievalPath, 'keyword');
    },
    () => {
      embedCalls++;
      return fakeOrthogonalEmbeddings({ body: JSON.stringify({ input: ['x'] }) });
    }
  );
  assert.equal(embedCalls, 0);
});

test('/api/transcribe retries Whisper once on a 5xx and succeeds', async () => {
  const { body: { token } } = await registerUser('asr-retry@example.com');
  let calls = 0;
  await withMockOpenAIFetch(
    async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 503, text: async () => 'upstream busy' };
      return { ok: true, status: 200, json: async () => ({ text: '重试之后成功了' }) };
    },
    async () => {
      const res = await fetch(`${base}/api/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/webm', Authorization: `Bearer ${token}` },
        body: Buffer.from('fake-audio-bytes-that-are-long-enough'),
      });
      assert.equal(res.status, 200);
      assert.match((await res.json()).text, /重试/);
    }
  );
  assert.equal(calls, 2);
});

test('/api/transcribe does not retry a 4xx from Whisper (e.g. bad audio / no credit)', async () => {
  const { body: { token } } = await registerUser('asr-noretry@example.com');
  let calls = 0;
  await withMockOpenAIFetch(
    async () => { calls += 1; return { ok: false, status: 400, text: async () => 'bad audio' }; },
    async () => {
      const res = await fetch(`${base}/api/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/webm', Authorization: `Bearer ${token}` },
        body: Buffer.from('fake-audio-bytes-that-are-long-enough'),
      });
      assert.equal(res.status, 502);
    }
  );
  assert.equal(calls, 1);
});

test('Anthropic 429 is retried once, honouring the retry-after header', async () => {
  const { callAnthropicWithRetry } = require('../ai/anthropic');
  let calls = 0;
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (!String(url).includes('api.anthropic.com')) return realFetch(url);
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, headers: { get: () => '0' } };
    return { ok: true, status: 200, headers: { get: () => null } };
  };
  try {
    const { response, attempt } = await callAnthropicWithRetry('', 'transcript');
    assert.equal(response.status, 200);
    assert.equal(attempt, 2);
  } finally {
    global.fetch = realFetch;
  }
});

test('upstream error text (e.g. "credit balance too low") is logged with an ALERT tag but never sent to the user', async () => {
  const { body: { token } } = await registerUser('no_leak@example.com');
  const logged = [];
  const realErr = console.error;
  console.error = (...args) => { logged.push(args.join(' ')); };
  try {
    await withMockAnthropicFetch(
      async () => ({ ok: false, status: 400, text: async () => 'Your credit balance is too low to access the Anthropic API' }),
      async () => {
        const res = await fetch(`${base}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ transcript: '今天练了基本功' }),
        });
        assert.equal(res.status, 502);
        const raw = await res.text();
        assert.ok(!/credit|balance|anthropic/i.test(raw), `response leaked upstream text: ${raw}`);
      }
    );
  } finally {
    console.error = realErr;
  }
  assert.ok(logged.some((l) => l.includes('[ALERT][billing-or-key]') && /credit balance/.test(l)), 'expected an ALERT log line');
});

test('Whisper failure body is not sent to the user', async () => {
  const { body: { token } } = await registerUser('asr_no_leak@example.com');
  const realErr = console.error;
  console.error = () => {};
  try {
    await withMockOpenAIFetch(
      async () => ({ ok: false, status: 429, text: async () => 'You exceeded your current quota, please check your plan and billing details' }),
      async () => {
        const res = await fetch(`${base}/api/transcribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'audio/webm', Authorization: `Bearer ${token}` },
          body: Buffer.from('fake-audio-bytes-that-are-long-enough'),
        });
        assert.equal(res.status, 502);
        assert.ok(!/quota|billing/i.test(await res.text()));
      }
    );
  } finally {
    console.error = realErr;
  }
});

test('deleting a record takes it out of the recurring-issue counts (and removes an issue that had no other evidence)', async () => {
  const { body: { token, user } } = await registerUser('issue_delete_record@example.com');
  const r1 = await saveRecord(token, { className: '基训1', improve_points: '重心不稳' });
  const r2 = await saveRecord(token, { className: '基训2', improve_points: '转圈的时候重心不稳，需要多加练习' });
  await saveRecord(token, { className: '基训3', improve_points: '后腿高度不够' });
  const auth = { Authorization: `Bearer ${token}` };
  const listIssues = async () => (await fetch(`${base}/api/issues`, { headers: auth })).json();

  let issues = await listIssues();
  const balance = issues.find((i) => i.text.includes('重心'));
  assert.equal(balance.occurrence_count, 2);
  assert.equal(issues.length, 2);

  // delete the FIRST record: the issue survives with one occurrence, pointing only at the remaining record
  const del1 = await fetch(`${base}/api/records/${r1.id}`, { method: 'DELETE', headers: auth });
  assert.equal(del1.status, 200);
  issues = await listIssues();
  const after1 = issues.find((i) => i.text.includes('重心'));
  assert.equal(after1.occurrence_count, 1);
  assert.equal(after1.occurrences.length, 1);
  assert.equal(after1.occurrences[0].recordId, r2.id);
  assert.equal(after1.first_record_id, r2.id);
  assert.equal(after1.last_record_id, r2.id);

  // delete the LAST record backing that issue: with no evidence left, the issue goes away entirely
  await fetch(`${base}/api/records/${r2.id}`, { method: 'DELETE', headers: auth });
  issues = await listIssues();
  assert.equal(issues.length, 1);
  assert.match(issues[0].text, /后腿/);

  const leftovers = await db.get(
    'SELECT COUNT(*) AS c FROM issue_occurrences WHERE record_id IN (?, ?)', [r1.id, r2.id]
  );
  assert.equal(leftovers.c, 0, 'no occurrence rows may point at deleted records');
});

test("deleting someone else's record does not touch my issues", async () => {
  const a = await registerUser('issue_del_a@example.com');
  const b = await registerUser('issue_del_b@example.com');
  const recA = await saveRecord(a.body.token, { className: '基训', improve_points: '重心不稳' });
  await fetch(`${base}/api/records/${recA.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${b.body.token}` } });
  const issues = await (await fetch(`${base}/api/issues`, { headers: { Authorization: `Bearer ${a.body.token}` } })).json();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].occurrence_count, 1);
});
