for (const k of [
  'AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY', 'AI_FALLBACK_PROVIDER', 'AI_FALLBACK_MODEL', 'AI_FORCED_TOOL_CHOICE',
  'DAILY_AI_LIMIT_OVERRIDE', 'DAILY_AI_LIMIT_OVERRIDE_USER_IDS', 'ASR_FALLBACK_PROVIDER',
]) process.env[k] = '';
process.env.AI_PROVIDER = 'anthropic';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.TURSO_DATABASE_URL = 'file::memory:';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.ANTHROPIC_API_KEY = 'test-key-unused-fetch-is-mocked';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.GUEST_RECAPS_PER_DAY = '2';
process.env.GUEST_ASR_PER_DAY = '2';
process.env.GUEST_SITE_AI_CALLS_PER_DAY = '50';
process.env.GUEST_MAX_TRANSCRIPT_LENGTH = '200';

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app.js');
const db = require('../db');

let server;
let base;
let realFetch;
test.before(async () => {
  await db.ready;
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
  realFetch = global.fetch;
  global.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('api.anthropic.com')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'tool_use', name: 'submit_review', input: {
            good_points: ['手臂更舒展'], improve_points: ['重心偏后'], next_time_reminder: [], session_tips: [], confidence_level: '高', note: '',
          } }],
          usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }),
      });
    }
    if (u.includes('api.openai.com') && u.includes('/audio/transcriptions')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ text: '今天练了 plié' }) });
    }
    return realFetch(url, opts);
  };
});

test.after(() => {
  global.fetch = realFetch;
  server.close();
});

const VID_A = 'guestvid-aaaaaaaaaaaa';
const VID_B = 'guestvid-bbbbbbbbbbbb';

function guestGenerate(vid, transcript, sessionId) {
  return fetch(`${base}/api/generate/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(vid ? { 'X-Guest-Vid': vid } : {}) },
    body: JSON.stringify({ transcript, sessionId }),
  });
}

function guestTranscribe(vid, bytes = 100) {
  return fetch(`${base}/api/transcribe/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/webm', 'X-Guest-Vid': vid },
    body: Buffer.alloc(bytes, 1),
  });
}

async function register(email) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123', privacyAccepted: true }),
  });
  return (await res.json()).token;
}

function authed(token, method, path, body) {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---------- guest trial ----------

test('guest generate needs a valid anonymous browser id', async () => {
  assert.equal((await guestGenerate(null, '今天练了')).status, 400);
  assert.equal((await guestGenerate('BAD id!', '今天练了')).status, 400);
});

test('guest generate returns a recap and logs it with no user, tagged with the browser id', async () => {
  const res = await guestGenerate(VID_A, '今天练了 plié 和 tendu', 'sess-guest-1');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.good_points, '手臂更舒展');
  const ev = await db.get(
    "SELECT * FROM events WHERE event_name = 'ai_process_success' AND user_id IS NULL ORDER BY id DESC LIMIT 1"
  );
  const meta = JSON.parse(ev.metadata);
  assert.equal(meta.source, 'guest');
  assert.equal(meta.vid, VID_A);
  assert.equal(meta.sessionId, 'sess-guest-1');
});

test('guest recap cap counts sessions, so 重新生成 on the same draft is not a second try', async () => {
  assert.equal((await guestGenerate(VID_A, '再生成一次', 'sess-guest-1')).status, 200);
  assert.equal((await guestGenerate(VID_A, '第二节', 'sess-guest-2')).status, 200);
  const blocked = await guestGenerate(VID_A, '第三节', 'sess-guest-3');
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).code, 'guest_quota');
  // A different browser is unaffected.
  assert.equal((await guestGenerate(VID_B, '另一个人', 'sess-guest-b1')).status, 200);
});

test('guest transcript length cap is smaller than the signed-in one', async () => {
  const res = await guestGenerate('guestvid-long-text-0001', 'a'.repeat(201), 'sess-long');
  assert.equal(res.status, 400);
});

test('guest transcribe works without a token and is capped per browser', async () => {
  const vid = 'guestvid-asr-00000001';
  const ok = await guestTranscribe(vid);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).text, '今天练了 plié');
  assert.equal((await guestTranscribe(vid)).status, 200);
  const blocked = await guestTranscribe(vid);
  assert.equal(blocked.status, 429);
  const ev = await db.get(
    "SELECT * FROM events WHERE event_name = 'asr_success' AND user_id IS NULL ORDER BY id DESC LIMIT 1"
  );
  assert.equal(JSON.parse(ev.metadata).vid, vid);
});

test('signed-in transcribe still requires a token', async () => {
  const res = await fetch(`${base}/api/transcribe`, { method: 'POST', body: Buffer.alloc(10, 1) });
  assert.equal(res.status, 401);
});

test('site-wide guest budget blocks every browser once reached', async () => {
  const { countAllGuestAiCallsToday } = require('../events');
  const used = await countAllGuestAiCallsToday();
  const fill = 50 - used;
  for (let i = 0; i < fill; i++) {
    await db.run(
      'INSERT INTO events (user_id, event_name, metadata, created_at) VALUES (NULL, ?, ?, ?)',
      ['ai_process_success', JSON.stringify({ source: 'guest', vid: `guestvid-fill-${String(i).padStart(8, '0')}` }), Date.now()]
    );
  }
  const res = await guestGenerate('guestvid-fresh-000001', '新的人', 'sess-fresh');
  assert.equal(res.status, 429);
  await db.run("DELETE FROM events WHERE metadata LIKE '%guestvid-fill-%'");
});

test('guest funnel telemetry accepts known steps only', async () => {
  const ok = await fetch(`${base}/api/telemetry/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vid: VID_A, kind: 'save_gate' }),
  });
  assert.equal(ok.status, 200);
  const bad = await fetch(`${base}/api/telemetry/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vid: VID_A, kind: 'whatever' }),
  });
  assert.equal(bad.status, 400);
});

// ---------- class cards ----------

test('cards: create validates count vs period cards', async () => {
  const token = await register('cards_validate@example.com');
  assert.equal((await authed(token, 'POST', '/api/cards', { name: '', kind: 'count', totalCount: 10 })).status, 400);
  assert.equal((await authed(token, 'POST', '/api/cards', { name: '次卡', kind: 'count' })).status, 400);
  assert.equal((await authed(token, 'POST', '/api/cards', { name: '月卡', kind: 'period' })).status, 400);
  assert.equal((await authed(token, 'POST', '/api/cards', { name: '月卡', kind: 'period', expireDate: '2026-02-30' })).status, 400);
  const res = await authed(token, 'POST', '/api/cards', {
    name: '月卡', kind: 'period', startDate: '2026-10-01', expireDate: '2026-10-31', price: 899,
  });
  assert.equal(res.status, 200);
  const card = await res.json();
  assert.equal(card.kind, 'period');
  assert.equal(card.totalCount, null);
  assert.equal(card.remaining, null);
});

test('cards: deduct manually, run out, undo, and only the owner can touch a card', async () => {
  const token = await register('cards_flow@example.com');
  const other = await register('cards_other@example.com');
  const card = await (await authed(token, 'POST', '/api/cards', { name: '芭蕾 2 次卡', kind: 'count', totalCount: 2, price: 360 })).json();
  assert.equal(card.remaining, 2);

  const first = await (await authed(token, 'POST', `/api/cards/${card.id}/use`)).json();
  assert.equal(first.card.remaining, 1);
  assert.equal((await authed(token, 'POST', `/api/cards/${card.id}/use`)).status, 200);
  const usedUp = await authed(token, 'POST', `/api/cards/${card.id}/use`);
  assert.equal(usedUp.status, 409);
  assert.equal((await usedUp.json()).code, 'card_used_up');

  assert.equal((await authed(other, 'POST', `/api/cards/${card.id}/use`)).status, 404);
  assert.equal((await authed(other, 'DELETE', `/api/cards/usages/${first.usageId}`)).status, 404);

  const undo = await (await authed(token, 'DELETE', `/api/cards/usages/${first.usageId}`)).json();
  assert.equal(undo.card.remaining, 1);

  const list = await (await authed(other, 'GET', '/api/cards')).json();
  assert.deepEqual(list, []);
});

test('cards: saving a 课记 or 打卡 with cardId deducts, and deleting the record gives the class back', async () => {
  const token = await register('cards_records@example.com');
  const card = await (await authed(token, 'POST', '/api/cards', { name: '舞蹈 10 次卡', kind: 'count', totalCount: 10 })).json();

  const saved = await (await authed(token, 'POST', '/api/records', {
    className: '芭蕾基训', good_points: '手臂', improve_points: '重心', cardId: card.id,
  })).json();
  assert.equal(saved.cardUsage.card.remaining, 9);
  assert.equal(saved.cardUsage.card.lastClassName, '芭蕾基训');

  const checkin = await (await authed(token, 'POST', '/api/records/checkin', { className: '芭蕾基训', cardId: card.id })).json();
  assert.equal(checkin.cardUsage.card.remaining, 8);

  const del = await (await authed(token, 'DELETE', `/api/records/${saved.id}`)).json();
  assert.equal(del.cardClassesReturned, 1);
  const [after] = await (await authed(token, 'GET', '/api/cards')).json();
  assert.equal(after.remaining, 9);
});

test('cards: a half-used card can be entered with the classes already taken', async () => {
  const token = await register('cards_usedbefore@example.com');
  const card = await (await authed(token, 'POST', '/api/cards', { name: '老卡', kind: 'count', totalCount: 10, usedBefore: 4 })).json();
  assert.equal(card.remaining, 6);
  assert.equal(card.lastUsedAt, null);
  assert.deepEqual(card.recentUsages, []);
  const tooMany = await authed(token, 'POST', '/api/cards', { name: '老卡2', kind: 'count', totalCount: 3, usedBefore: 4 });
  assert.equal(tooMany.status, 400);
});

test('cards: a card problem on save does not lose the record', async () => {
  const token = await register('cards_saveerr@example.com');
  const card = await (await authed(token, 'POST', '/api/cards', { name: '1 次卡', kind: 'count', totalCount: 1 })).json();
  await authed(token, 'POST', `/api/cards/${card.id}/use`);
  const res = await authed(token, 'POST', '/api/records/checkin', { className: '现代舞', cardId: card.id });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.id);
  assert.match(body.cardError, /用完/);
  const missing = await (await authed(token, 'POST', '/api/records/checkin', { className: '现代舞', cardId: 999999 })).json();
  assert.ok(missing.id);
  assert.ok(missing.cardError);
});

test('cards: edit, archive blocks deduction, delete removes usages, account export includes cards', async () => {
  const token = await register('cards_edit@example.com');
  const card = await (await authed(token, 'POST', '/api/cards', { name: '旧名字', kind: 'count', totalCount: 5 })).json();
  const edited = await (await authed(token, 'PATCH', `/api/cards/${card.id}`, { name: '新名字', totalCount: 8 })).json();
  assert.equal(edited.name, '新名字');
  assert.equal(edited.remaining, 8);
  await authed(token, 'POST', `/api/cards/${card.id}/use`);

  const exported = await (await authed(token, 'GET', '/api/auth/export')).json();
  assert.equal(exported.classCards.length, 1);
  assert.equal(exported.cardUsages.length, 1);

  await authed(token, 'PATCH', `/api/cards/${card.id}`, { archived: true });
  const archivedUse = await authed(token, 'POST', `/api/cards/${card.id}/use`);
  assert.equal(archivedUse.status, 400);

  await authed(token, 'DELETE', `/api/cards/${card.id}`);
  assert.deepEqual(await (await authed(token, 'GET', '/api/cards')).json(), []);
  const left = await db.get('SELECT COUNT(*) AS c FROM card_usages WHERE card_id = ?', [card.id]);
  assert.equal(Number(left.c), 0);
});
