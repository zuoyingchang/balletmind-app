for (const k of ['AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY', 'AI_FALLBACK_PROVIDER', 'AI_FALLBACK_MODEL', 'AI_FORCED_TOOL_CHOICE']) process.env[k] = '';
process.env.AI_PROVIDER = 'anthropic';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.TURSO_DATABASE_URL = 'file::memory:';
process.env.ADMIN_KEY = 'test-admin-key';
process.env.RATE_LIMIT_REGISTER_MAX = '50';
process.env.RATE_LIMIT_VISIT_MAX = '1000';
process.env.RATE_LIMIT_CLIENT_ERROR_MAX = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app.js');
const db = require('../db');
const { sanitizeVisit, sanitizeClientError } = require('../lib/telemetry');
const { summarizeClientErrors } = require('../lib/usage-cost');
const { embedTextsOpenAI } = require('../ai/ask-retrieve');

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

const VID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

test('visit payloads are reduced to short enums and anything else is dropped', () => {
  assert.equal(sanitizeVisit({ vid: 'short' }), null);
  assert.equal(sanitizeVisit(null), null);
  const v = sanitizeVisit({ vid: VID.toUpperCase(), platform: 'ios', browser: 'Mozilla/5.0 (iPhone...)', inApp: 'yes', src: 'XHS' });
  assert.deepEqual(v, { vid: VID, platform: 'ios', browser: 'other', inApp: false, src: 'xhs' });
  assert.equal(sanitizeVisit({ vid: VID, src: 'has spaces and <script>' }).src, 'direct');
  const e = sanitizeClientError({ vid: VID, where: 'ai_process', kind: 'network', status: 502, platform: 'android', browser: 'xiaomi', message: 'secret text' });
  assert.deepEqual(e, { where: 'ai_process', kind: 'network', vid: VID, platform: 'android', browser: 'xiaomi', status: 502 });
  assert.equal(sanitizeClientError({ vid: VID, where: 'nope', kind: 'nope', status: 'abc' }).where, 'api');
});

test('POST /api/telemetry/visit counts a browser once and tracks repeat visits without login', async () => {
  const body = { vid: VID, platform: 'android', browser: 'xiaomi', inApp: false, src: 'xhs' };
  assert.equal((await post('/api/telemetry/visit', body)).status, 200);
  assert.equal((await post('/api/telemetry/visit', { ...body, src: 'other' })).status, 200);
  assert.equal((await post('/api/telemetry/visit', { vid: 'bad' })).status, 400);
  const row = await db.get('SELECT * FROM visitors WHERE vid = ?', [VID]);
  assert.equal(row.visits, 2);
  assert.equal(row.src, 'xhs', 'the first-touch source is kept');
  assert.equal(row.signed_in, 0);
});

test('signed-in marking needs a login and only flips the anonymous id', async () => {
  assert.equal((await post('/api/telemetry/signed-in', { vid: VID })).status, 401);
  const reg = await post('/api/auth/register', { email: 'telemetry-user@example.com', password: 'secret123', privacyAccepted: true });
  const { token } = await reg.json();
  const res = await post('/api/telemetry/signed-in', { vid: VID }, { Authorization: `Bearer ${token}` });
  assert.equal(res.status, 200);
  assert.equal((await db.get('SELECT signed_in FROM visitors WHERE vid = ?', [VID])).signed_in, 1);
  const cols = (await db.all('PRAGMA table_info(visitors)')).map((c) => c.name);
  assert.ok(!cols.includes('user_id'), 'visitors must not link to an account');
});

test('client errors are stored as sanitized events with no user id', async () => {
  const res = await post('/api/telemetry/error', { vid: VID, where: 'ai_process', kind: 'network', platform: 'ios', browser: 'chrome', message: 'Load failed: secret' });
  assert.equal(res.status, 200);
  const ev = await db.get("SELECT user_id, metadata FROM events WHERE event_name = 'client_error' ORDER BY id DESC LIMIT 1");
  assert.equal(ev.user_id, null);
  const meta = JSON.parse(ev.metadata);
  assert.equal(meta.where, 'ai_process');
  assert.equal(meta.message, undefined);
  assert.equal((await post('/api/telemetry/error', { where: 'x' })).status, 400);
});

test('admin stats include traffic, screens, client errors and embedding cost', async () => {
  const res = await fetch(`${base}/api/admin/stats`, { headers: { 'x-admin-key': 'test-admin-key' } });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.traffic.all.total, 1);
  assert.equal(j.traffic.all.signedIn, 1);
  assert.ok(j.clientErrors.all.total >= 1);
  assert.ok(Array.isArray(j.screenViews.all));
  assert.equal(typeof j.aiUsage.embedding.estimatedUsd, 'number');
});

test('embedTextsOpenAI reports the real token usage to onUsage', async () => {
  let seen = null;
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [0.1] }], usage: { total_tokens: 42 }, model: 'text-embedding-3-small' }) });
  const out = await embedTextsOpenAI(['x'], { fetchImpl, apiKey: 'k', onUsage: (u) => { seen = u; } });
  assert.deepEqual(out, [[0.1]]);
  assert.deepEqual(seen, { tokens: 42, model: 'text-embedding-3-small' });
});

test('client error location fields keep only code coordinates and drop anything else', () => {
  const good = sanitizeClientError({ vid: VID, where: 'js', kind: 'exception', loc: 'index.html:7812:15', fn: 'speakTerm', errName: 'TypeError', build: '3A7B1BA', message: 'secret' });
  assert.equal(good.loc, 'index.html:7812:15');
  assert.equal(good.fn, 'speakTerm');
  assert.equal(good.errName, 'TypeError');
  assert.equal(good.build, '3a7b1ba');
  assert.equal(good.message, undefined);
  assert.equal(sanitizeClientError({ vid: VID, loc: 'ext' }).loc, 'ext');
  const bad = sanitizeClientError({ vid: VID, loc: '../../etc/passwd:1', fn: 'a b; drop', errName: 'Hacked', build: '__APP_BUILD__' });
  assert.equal(bad.loc, undefined);
  assert.equal(bad.fn, undefined);
  assert.equal(bad.errName, 'other');
  assert.equal(bad.build, undefined);
});

test('summarizeClientErrors groups script errors by location, function, type and build', () => {
  const ev = (meta) => ({ created_at: Date.now(), meta });
  const s = summarizeClientErrors([
    ev({ where: 'js', kind: 'exception', loc: 'index.html:10:2', fn: 'f', errName: 'TypeError', build: 'abc1234' }),
    ev({ where: 'js', kind: 'exception', loc: 'index.html:10:2', fn: 'f', errName: 'TypeError', build: 'abc1234' }),
    ev({ where: 'js', kind: 'exception', loc: 'index.html:99:1', errName: 'RangeError', build: 'def5678' }),
    ev({ where: 'api', kind: 'network' }),
  ]);
  assert.equal(s.total, 4);
  assert.deepEqual(s.byLocation[0], { loc: 'index.html:10:2', fn: 'f', errName: 'TypeError', build: 'abc1234', count: 2 });
  assert.equal(s.byLocation.length, 2);
});

test('the home page is served with a build id and revalidated on every load', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=0');
  const html = await res.text();
  assert.ok(!html.includes('__APP_BUILD__'), 'placeholder must be replaced');
  assert.match(html, /<meta name="app-build" content="(dev|[a-f0-9]{7})">/);
  const alias = await fetch(`${base}/index.html`);
  assert.equal(alias.status, 200);
});

test('ASR failures keep the real microphone reason and the device it happened on', async () => {
  const reg = await post('/api/auth/register', { email: 'mic-user@example.com', password: 'secret123', privacyAccepted: true });
  const { token } = await reg.json();
  const auth = { Authorization: `Bearer ${token}` };
  const send = (meta) => post('/api/events', { event: 'asr_fail', metadata: meta }, auth);
  assert.equal((await send({ error: 'unsupported', platform: 'ios', browser: 'other' })).status, 200);
  assert.equal((await send({ error: 'unsupported', platform: 'ios', browser: 'other' })).status, 200);
  assert.equal((await send({ error: 'not-allowed', platform: 'android', browser: 'chrome' })).status, 200);
  assert.equal((await send({ error: 'not-allowed' })).status, 200);
  const stats = await (await fetch(`${base}/api/admin/stats`, { headers: { 'x-admin-key': 'test-admin-key' } })).json();
  const byDevice = Object.fromEntries(stats.asrUsage.failByDevice.map((r) => [r.name, r.count]));
  assert.equal(byDevice['unsupported \u00b7 ios \u00b7 other'], 2);
  assert.equal(byDevice['not-allowed \u00b7 android \u00b7 chrome'], 1);
  assert.equal(byDevice['not-allowed'], 1, 'older events without a device stay as plain reasons');
});
