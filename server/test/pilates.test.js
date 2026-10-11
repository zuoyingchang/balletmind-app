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
  assert.equal(meta.practice, undefined);
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
