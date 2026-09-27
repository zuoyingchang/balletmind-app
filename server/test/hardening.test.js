process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.TURSO_DATABASE_URL = 'file::memory:';
process.env.ADMIN_KEY = 'test-admin-key';
process.env.RATE_LIMIT_LOGIN_MAX = '3';
process.env.RATE_LIMIT_REGISTER_MAX = '50';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const app = require('../app.js');
const db = require('../db');

let server;
let base;

test.before(async () => {
  await db.ready;
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(() => server.close());

const post = (path, body, headers = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function register(email) {
  const res = await post('/api/auth/register', { email, password: 'secret123', privacyAccepted: true });
  return res.json();
}

test('health endpoint reports ok without auth', async () => {
  const res = await fetch(base + '/api/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.experimentIssueBrief, false);
});

test('login is rate limited per IP + email after repeated attempts', async () => {
  await register('brute@example.com');
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    const res = await post('/api/auth/login', { email: 'brute@example.com', password: 'wrong-pass' });
    statuses.push(res.status);
  }
  assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
});

test('a token close to expiry is silently renewed via X-New-Token', async () => {
  const { user } = await register('renew@example.com');
  const nearExpiry = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '2d' });
  const res = await fetch(base + '/api/auth/me', { headers: { Authorization: `Bearer ${nearExpiry}` } });
  assert.equal(res.status, 200);
  const renewed = res.headers.get('x-new-token');
  assert.ok(renewed, 'expected a renewed token');
  assert.equal(jwt.verify(renewed, process.env.JWT_SECRET).userId, user.id);

  const fresh = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
  const res2 = await fetch(base + '/api/auth/me', { headers: { Authorization: `Bearer ${fresh}` } });
  assert.equal(res2.headers.get('x-new-token'), null);
});

test('DELETE /api/auth/account requires password and removes only that user', async () => {
  const { token, user } = await register('gone@example.com');
  const other = await register('stays-delete@example.com');
  await db.run('INSERT INTO records (user_id, good_points, created_at) VALUES (?, ?, ?)', [user.id, 'wipe me', Date.now()]);
  await db.run('INSERT INTO records (user_id, good_points, created_at) VALUES (?, ?, ?)', [other.user.id, 'keep other', Date.now()]);
  const issue = await db.run(
    "INSERT INTO issues (user_id, text, status, occurrence_count, created_at, updated_at) VALUES (?, ?, 'open', 1, ?, ?)",
    [user.id, '膝盖发软', Date.now(), Date.now()]
  );
  await db.run('INSERT INTO issue_occurrences (issue_id, record_id, created_at) VALUES (?, ?, ?)', [issue.lastInsertRowid, 1, Date.now()]);

  const noPw = await fetch(base + '/api/auth/account', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(noPw.status, 400);

  const badPw = await fetch(base + '/api/auth/account', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-pass' }),
  });
  assert.equal(badPw.status, 403);
  assert.ok(await db.get('SELECT id FROM users WHERE id = ?', [user.id]));

  const ok = await fetch(base + '/api/auth/account', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'secret123' }),
  });
  assert.equal(ok.status, 200);
  assert.equal(await db.get('SELECT id FROM users WHERE id = ?', [user.id]), undefined);
  assert.equal(await db.get('SELECT id FROM records WHERE user_id = ?', [user.id]), undefined);
  assert.equal(await db.get('SELECT id FROM issues WHERE user_id = ?', [user.id]), undefined);
  assert.ok(await db.get('SELECT id FROM users WHERE id = ?', [other.user.id]));
  const kept = await db.get('SELECT good_points FROM records WHERE user_id = ?', [other.user.id]);
  assert.equal(kept.good_points, 'keep other');
});

test('export returns only my own data and never the password hash', async () => {
  const { token, user } = await register('exporter@example.com');
  const other = await register('stays@example.com');
  await db.run('INSERT INTO records (user_id, good_points, created_at) VALUES (?, ?, ?)', [user.id, 'mine', Date.now()]);
  await db.run('INSERT INTO records (user_id, good_points, created_at) VALUES (?, ?, ?)', [other.user.id, 'theirs', Date.now()]);

  const exp = await (await fetch(base + '/api/auth/export', { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(exp.records.length, 1);
  assert.equal(exp.records[0].good_points, 'mine');
  assert.equal(exp.user.password_hash, undefined);
});

test('an unexpected error inside an async route returns a clean 500 instead of crashing the process', async () => {
  const { token } = await register('boom@example.com');
  const realGet = db.get;
  const realErr = console.error;
  db.get = async () => { throw new Error('simulated db failure'); };
  console.error = () => {};
  try {
    const res = await fetch(base + '/api/auth/me', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: '服务器出错了，请稍后再试' });
  } finally {
    db.get = realGet;
    console.error = realErr;
  }
  const after = await fetch(base + '/api/health');
  assert.equal(after.status, 200);
});

test('feedback: saved with limits, visible to admin only, never joins account email', async () => {
  const { token, user } = await register('fb@example.com');
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const empty = await fetch(base + '/api/feedback', { method: 'POST', headers: auth, body: JSON.stringify({ message: '   ' }) });
  assert.equal(empty.status, 400);
  const tooLong = await fetch(base + '/api/feedback', { method: 'POST', headers: auth, body: JSON.stringify({ message: 'a'.repeat(1001) }) });
  assert.equal(tooLong.status, 400);
  const noAuth = await fetch(base + '/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'hi' }) });
  assert.equal(noAuth.status, 401);

  const ok = await fetch(base + '/api/feedback', { method: 'POST', headers: auth, body: JSON.stringify({ message: '录音按钮点了没反应', contact: 'wx:abc' }) });
  assert.equal(ok.status, 200);
  const row = await db.get('SELECT * FROM feedback WHERE user_id = ?', [user.id]);
  assert.equal(row.message, '录音按钮点了没反应');
  assert.equal(row.contact, 'wx:abc');

  const cfg = require('../config');
  const denied = await fetch(base + '/api/admin/feedback');
  assert.equal(denied.status, 401);
  {
    const list = await (await fetch(base + '/api/admin/feedback', { headers: { 'X-Admin-Key': cfg.ADMIN_KEY } })).json();
    assert.ok(list.feedback.some((f) => f.message.includes('没反应')));
    assert.equal(list.feedback[0].email, undefined);
  }
});

test('backup then restore into an empty database brings every row back, and refuses a non-empty one', async () => {
  const { dumpAll, restoreAll, TABLES } = require('../lib/backup');
  const { user } = await register('restore-me@example.com');
  await db.run('INSERT INTO records (user_id, good_points, created_at) VALUES (?, ?, ?)', [user.id, 'keep me', Date.now()]);
  const dump = await dumpAll(db);
  assert.ok(dump.tables.users.length > 0 && dump.tables.records.length > 0);

  await assert.rejects(() => restoreAll(db, dump), /already has/);

  for (const t of [...TABLES].reverse()) await db.run(`DELETE FROM ${t}`);
  const restored = await restoreAll(db, dump);
  assert.equal(restored.users, dump.tables.users.length);
  const back = await db.get('SELECT good_points FROM records WHERE user_id = ?', [user.id]);
  assert.equal(back.good_points, 'keep me');
});

test('forgot-password says plainly that email is unavailable (instead of pretending it was sent) when no provider is configured', async () => {
  await register('noemail@example.com');
  const savedCtx = process.env.NODE_TEST_CONTEXT;
  const savedEnv = process.env.NODE_ENV;
  const realErr = console.error;
  delete process.env.NODE_TEST_CONTEXT;
  process.env.NODE_ENV = 'production';
  console.error = () => {};
  try {
    for (const email of ['noemail@example.com', 'nobody-here@example.com']) {
      const res = await post('/api/auth/forgot-password', { email });
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.resetUrl, undefined);
    }
  } finally {
    process.env.NODE_TEST_CONTEXT = savedCtx;
    if (savedEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedEnv;
    console.error = realErr;
  }
});

test('/api/health/ai: idle and healthy with no traffic; 503 only when a provider has repeated upstream failures and no successes', async () => {
  const { logEvent } = require('../events');
  const realErr = console.error;
  console.error = () => {};
  try {
    await db.run('DELETE FROM events');
    let res = await fetch(base + '/api/health/ai');
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.whisper, 'idle');

    // two failures are not enough to call it an outage
    await logEvent(1, 'asr_fail', { reason: 'api_error', status: 429 });
    await logEvent(1, 'asr_fail', { reason: 'api_error', status: 429 });
    assert.equal((await fetch(base + '/api/health/ai')).status, 200);

    // users hitting their own daily cap never count
    for (let i = 0; i < 10; i++) await logEvent(1, 'asr_fail', { reason: 'quota_exceeded' });
    assert.equal((await fetch(base + '/api/health/ai')).status, 200);

    // a third real upstream failure with no success in the window: whisper is failing
    await logEvent(2, 'asr_fail', { reason: 'api_error', status: 402 });
    res = await fetch(base + '/api/health/ai');
    assert.equal(res.status, 503);
    body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.whisper, 'failing');
    assert.notEqual(body.anthropic, 'failing');
    assert.equal(JSON.stringify(body).includes('402'), false, 'must not leak upstream details');

    // one success in the window means it is working again
    await logEvent(2, 'asr_success', { latencyMs: 900 });
    res = await fetch(base + '/api/health/ai');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).whisper, 'ok');

    // failures older than the window are ignored
    await db.run('DELETE FROM events');
    const old = Date.now() - 60 * 60 * 1000;
    for (let i = 0; i < 5; i++) {
      await db.run("INSERT INTO events (user_id, event_name, metadata, created_at) VALUES (1, 'ai_process_fail', ?, ?)", [JSON.stringify({ reason: 'api_error', status: 500 }), old]);
    }
    assert.equal((await fetch(base + '/api/health/ai')).status, 200);

    // and the plain liveness endpoint is unaffected by any of this
    for (let i = 0; i < 4; i++) await logEvent(1, 'ai_process_fail', { reason: 'api_error', status: 500 });
    assert.equal((await fetch(base + '/api/health/ai')).status, 503);
    assert.equal((await fetch(base + '/api/health')).status, 200);
  } finally {
    console.error = realErr;
  }
});
