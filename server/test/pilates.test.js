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

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app.js');
const db = require('../db');
const { PILATES_PROMPT_VERSION } = require('../ai/pilates-review-prompt');
const { PROMPT_VERSION } = require('../ai/review-prompt');

let server;
let base;
let realFetch;
let lastAnthropicBody = null;
let lastWhisperPrompt = null;
test.before(async () => {
  await db.ready;
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
  realFetch = global.fetch;
  global.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('api.anthropic.com')) {
      lastAnthropicBody = JSON.parse(opts.body);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'tool_use', name: 'submit_review', input: {
            good_points: ['Footwork 两红一蓝'], improve_points: ['Hundred 脖子酸'], next_time_reminder: [], session_tips: [], confidence_level: '高', note: '',
          } }],
          usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }),
      });
    }
    if (u.includes('api.openai.com') && u.includes('/audio/transcriptions')) {
      lastWhisperPrompt = opts.body.get('prompt');
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ text: '今天 Footwork' }) });
    }
    return realFetch(url, opts);
  };
});

test.after(() => {
  global.fetch = realFetch;
  server.close();
});

async function register(email, practices) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123', privacyAccepted: true, ...(practices ? { practices } : {}) }),
  });
  return res.json();
}

function authed(token, method, path, body, headers = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function lastEvent(userId, name) {
  const row = await db.get('SELECT metadata FROM events WHERE user_id = ? AND event_name = ? ORDER BY id DESC LIMIT 1', [userId, name]);
  return row ? JSON.parse(row.metadata) : null;
}

test('register stores several practices; /me returns them; PATCH replaces them and needs at least one valid', async () => {
  const reg = await register('pilates-reg@example.com', ['pilates', 'ballet', 'pilates']);
  assert.deepEqual(reg.user.practices, ['ballet', 'pilates']);
  let me = await (await authed(reg.token, 'GET', '/api/auth/me')).json();
  assert.deepEqual(me.practices, ['ballet', 'pilates']);

  assert.equal((await authed(reg.token, 'PATCH', '/api/auth/practices', { practices: ['yoga'] })).status, 400);
  assert.equal((await authed(reg.token, 'PATCH', '/api/auth/practices', { practices: [] })).status, 400);
  const ok = await authed(reg.token, 'PATCH', '/api/auth/practices', { practices: ['pilates'] });
  assert.equal(ok.status, 200);
  me = await (await authed(reg.token, 'GET', '/api/auth/me')).json();
  assert.deepEqual(me.practices, ['pilates']);

  const plain = await register('ballet-default@example.com');
  assert.deepEqual(plain.user.practices, ['ballet']);
  assert.equal(plain.user.activePractice, 'ballet');
});

test('active practice must be one of the list, survives on /me, and falls back when removed', async () => {
  const { token } = await register('pilates-active@example.com');
  let r = await (await authed(token, 'PATCH', '/api/auth/practices', { practices: ['ballet', 'pilates'], activePractice: 'pilates' })).json();
  assert.deepEqual(r, { practices: ['ballet', 'pilates'], activePractice: 'pilates' });
  let me = await (await authed(token, 'GET', '/api/auth/me')).json();
  assert.equal(me.activePractice, 'pilates');

  r = await (await authed(token, 'PATCH', '/api/auth/practices', { activePractice: 'ballet' })).json();
  assert.equal(r.activePractice, 'ballet');

  r = await (await authed(token, 'PATCH', '/api/auth/practices', { practices: ['pilates'] })).json();
  assert.deepEqual(r, { practices: ['pilates'], activePractice: 'pilates' });
  assert.equal((await authed(token, 'PATCH', '/api/auth/practices', { activePractice: 'ballet' })).status, 400);
  me = await (await authed(token, 'GET', '/api/auth/me')).json();
  assert.equal(me.activePractice, 'pilates');
});

test('records and check-ins are tagged with the practice they were saved under', async () => {
  const { token } = await register('pilates-records@example.com', ['ballet', 'pilates']);
  const saved = await (await authed(token, 'POST', '/api/records', {
    className: 'Reformer 私教', good_points: 'Footwork 稳', improve_points: 'Hundred 脖子酸', practice: 'pilates',
  })).json();
  const plain = await (await authed(token, 'POST', '/api/records', {
    className: '基训', good_points: 'tendu', improve_points: 'plié', practice: 'yoga',
  })).json();
  const checkin = await (await authed(token, 'POST', '/api/records/checkin', { className: '垫上', practice: 'pilates' })).json();
  const row = (id) => db.get('SELECT practice FROM records WHERE id = ?', [id]);
  assert.equal((await row(saved.id)).practice, 'pilates');
  assert.equal((await row(plain.id)).practice, 'ballet');
  assert.equal((await row(checkin.id)).practice, 'pilates');
});

test('首页 / 档案 / 追踪 / milestones are kept apart per practice (X-Practice), missing header = ballet', async () => {
  const { token } = await register('pilates-split@example.com', ['ballet', 'pilates']);
  const P = { 'X-Practice': 'pilates' };
  const b1 = await (await authed(token, 'POST', '/api/records', {
    className: '基训', good_points: 'tendu', improve_points: '重心后坐', practice: 'ballet',
  })).json();
  assert.equal(b1.milestone.value, 1);
  const p1 = await (await authed(token, 'POST', '/api/records', {
    className: 'Reformer', good_points: 'Footwork 稳', improve_points: '重心后坐', practice: 'pilates',
  })).json();
  assert.equal(p1.milestone.value, 1, 'pilates counts its own 第一条课记');
  await authed(token, 'POST', '/api/records/checkin', { className: '垫上', practice: 'pilates' });

  const ballet = await (await authed(token, 'GET', '/api/records')).json();
  const pilates = await (await authed(token, 'GET', '/api/records', undefined, P)).json();
  assert.deepEqual(ballet.map((r) => r.class_name), ['基训']);
  assert.deepEqual(pilates.map((r) => r.class_name).sort(), ['Reformer', '垫上']);

  // Same wording in both practices still makes two separate issues.
  const bIssues = await (await authed(token, 'GET', '/api/issues')).json();
  const pIssues = await (await authed(token, 'GET', '/api/issues', undefined, P)).json();
  assert.equal(bIssues.length, 1);
  assert.equal(pIssues.length, 1);
  assert.notEqual(bIssues[0].id, pIssues[0].id);
  assert.deepEqual(pIssues[0].occurrences.map((o) => o.className), ['Reformer']);
  await authed(token, 'PATCH', `/api/issues/${pIssues[0].id}`, { status: 'resolved' });
  assert.equal((await (await authed(token, 'GET', '/api/issues')).json()).length, 1, 'resolving the pilates one leaves ballet open');

  const brief = await (await authed(token, 'GET', '/api/progress/brief', undefined, P)).json();
  assert.equal(brief.lastRecord.className, 'Reformer');
  const review = await (await authed(token, 'GET', '/api/progress/review?days=7')).json();
  assert.deepEqual(review.records.map((r) => r.className), ['基训']);
  const ask = await (await authed(token, 'GET', `/api/progress/ask?q=${encodeURIComponent('最近做得好的')}`, undefined, P)).json();
  assert.ok(!(ask.matchedRecords || []).some((r) => r.className === '基训'));
});

test('课卡 and the 分享过 badge are per practice too; a card cannot be used from the other practice', async () => {
  const { token } = await register('pilates-split-cards@example.com', ['ballet', 'pilates']);
  const P = { 'X-Practice': 'pilates' };
  const bCard = await (await authed(token, 'POST', '/api/cards', { studio: '天鹅舞蹈', kind: 'count', totalCount: 10 })).json();
  const pCard = await (await authed(token, 'POST', '/api/cards', { studio: '静心普拉提', kind: 'count', totalCount: 10 }, P)).json();
  assert.deepEqual((await (await authed(token, 'GET', '/api/cards')).json()).map((c) => c.studio), ['天鹅舞蹈']);
  assert.deepEqual((await (await authed(token, 'GET', '/api/cards', undefined, P)).json()).map((c) => c.studio), ['静心普拉提']);

  const wrong = await (await authed(token, 'POST', '/api/records/checkin', { className: '垫上', practice: 'pilates', cardId: bCard.id })).json();
  assert.ok(wrong.cardError, 'ballet card is not usable for a pilates 打卡');
  const right = await (await authed(token, 'POST', '/api/records/checkin', { className: '垫上', practice: 'pilates', cardId: pCard.id })).json();
  assert.equal(right.cardUsage.card.remaining, 9);
  assert.equal((await authed(token, 'POST', `/api/cards/${bCard.id}/use`, {}, P)).status, 404);
  assert.equal((await authed(token, 'POST', `/api/cards/${bCard.id}/use`, {})).status, 200);

  await authed(token, 'POST', '/api/events', { event: 'share_card_downloaded' }, P);
  assert.equal((await (await authed(token, 'GET', '/api/progress/share-badge', undefined, P)).json()).earned, true);
  assert.equal((await (await authed(token, 'GET', '/api/progress/share-badge')).json()).earned, false);
});

test('generate with X-Practice: pilates uses the pilates prompt and logs its version', async () => {
  const { token, user } = await register('pilates-gen@example.com', ['pilates']);
  const res = await authed(token, 'POST', '/api/generate', { transcript: 'Footwork 两红一蓝，Hundred 脖子酸' }, { 'X-Practice': 'pilates' });
  assert.equal(res.status, 200);
  assert.match(lastAnthropicBody.system[0].text, /普拉提课后笔记整理助手/);
  assert.equal(lastAnthropicBody.tools[0].description, '提交结构化的普拉提课后复盘结果');
  const meta = await lastEvent(user.id, 'ai_process_success');
  assert.equal(meta.promptVersion, PILATES_PROMPT_VERSION);
  assert.equal(meta.practice, 'pilates');
});

test('generate without the header keeps the ballet prompt', async () => {
  const { token, user } = await register('ballet-gen@example.com');
  const res = await authed(token, 'POST', '/api/generate', { transcript: '今天 plié 膝盖没对脚趾' });
  assert.equal(res.status, 200);
  assert.match(lastAnthropicBody.system[0].text, /芭蕾训练笔记整理助手/);
  const meta = await lastEvent(user.id, 'ai_process_success');
  assert.equal(meta.promptVersion, PROMPT_VERSION);
  assert.equal(meta.practice, 'ballet');
});

test('every event carries the practice, and admin stats split 芭蕾 / 普拉提', async () => {
  const { token, user } = await register('pilates-events@example.com', ['ballet', 'pilates']);
  const P = { 'X-Practice': 'pilates' };
  await authed(token, 'POST', '/api/events', { event: 'screen_view', metadata: { screen: 'home' } }, P);
  assert.equal((await lastEvent(user.id, 'screen_view')).practice, 'pilates');
  await authed(token, 'POST', '/api/events', { event: 'screen_view', metadata: { screen: 'home' } });
  assert.equal((await lastEvent(user.id, 'screen_view')).practice, 'ballet');

  const card = await (await authed(token, 'POST', '/api/cards', { studio: '核心馆', kind: 'count', totalCount: 5 }, P)).json();
  await authed(token, 'POST', '/api/records', {
    className: 'Reformer', good_points: 'Footwork', improve_points: '', practice: 'pilates', from: 'manual', cardId: card.id,
  }, P);
  assert.equal((await lastEvent(user.id, 'save_record')).practice, 'pilates');
  assert.equal((await lastEvent(user.id, 'session_confirmed')).practice, 'pilates');
  assert.equal((await lastEvent(user.id, 'card_used')).practice, 'pilates');
  await authed(token, 'POST', '/api/records/checkin', { className: '基训' });
  assert.equal((await lastEvent(user.id, 'checkin_saved')).practice, 'ballet');

  const { buildAdminStats } = require('../admin-stats');
  const bp = (await buildAdminStats()).byPractice;
  assert.ok(bp.pilates.recaps >= 1);
  assert.ok(bp.pilates.cards >= 1);
  assert.ok(bp.pilates.usersPicked >= 1);
  assert.ok(bp.pilates.events.save_record.count >= 1);
  assert.ok(bp.ballet.events.checkin_saved.count >= 1);
  assert.equal(typeof bp.untagged.save_record, 'number');
});

test('transcribe with X-Practice: pilates sends the pilates vocabulary to Whisper', async () => {
  const { token } = await register('pilates-asr@example.com', ['pilates']);
  const res = await fetch(`${base}/api/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/webm', Authorization: `Bearer ${token}`, 'X-Practice': 'pilates' },
    body: Buffer.alloc(100, 1),
  });
  assert.equal(res.status, 200);
  assert.match(lastWhisperPrompt, /^普拉提课后/);
  assert.match(lastWhisperPrompt, /Reformer/);

  await fetch(`${base}/api/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/webm', Authorization: `Bearer ${token}` },
    body: Buffer.alloc(100, 1),
  });
  assert.match(lastWhisperPrompt, /^芭蕾课后/);
});
