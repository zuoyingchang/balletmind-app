process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.TURSO_DATABASE_URL = 'file::memory:';
process.env.ADMIN_KEY = 'test-admin-key';
process.env.DAILY_AI_LIMIT = '5';

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app.js');
const db = require('../db');
const { countAiCallsToday } = require('../events');

let server;
let base;

test.before(async () => {
  await db.ready;
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});

test.after(() => {
  server.close();
});

async function registerUser(email, password = 'secret123', displayName) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName }),
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

test('saving a record logs save_record and user_edit_ai_result events', async () => {
  const { body: { token, user } } = await registerUser('events_save@example.com');
  const create = await fetch(`${base}/api/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ className: '测试', good_points: '进步', edited: true }),
  });
  assert.equal(create.status, 200);

  const saveEvent = await db.get('SELECT * FROM events WHERE user_id = ? AND event_name = ?', [user.id, 'save_record']);
  assert.ok(saveEvent);
  const editEvent = await db.get('SELECT * FROM events WHERE user_id = ? AND event_name = ?', [user.id, 'user_edit_ai_result']);
  assert.ok(editEvent);
  assert.deepEqual(JSON.parse(editEvent.metadata), { edited: true });
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
  const [updated] = await (await fetch(`${base}/api/issues`, { headers: { Authorization: `Bearer ${tokenA}` } })).json();
  assert.equal(updated.status, 'resolved');
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
  assert.equal(body.recordCount, 1);
  assert.equal(body.openIssues.length, 1);
  assert.ok(body.goodPointsRecap.includes('高位更稳定'));
  const after = await countAiCallsToday(user.id);
  assert.equal(after, before, 'training review must not consume the AI quota');
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
  const after = await countAiCallsToday(user.id);
  assert.equal(after, before, 'pre-class brief must not consume the AI quota');
});
