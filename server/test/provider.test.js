// Tests must not depend on the developer's local .env (dotenv never overrides a variable that is already set).
for (const k of ['AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY', 'AI_FALLBACK_PROVIDER', 'AI_FALLBACK_MODEL', 'AI_FORCED_TOOL_CHOICE']) process.env[k] = '';
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
const { providerName, aiConfigured } = require('../ai/provider');
const { toOpenAIMessages, toOpenAITools, toToolChoice, fromOpenAIResponse } = require('../ai/openai-compat');

let server;
let base;
const realFetch = global.fetch;

test.before(async () => {
  await db.ready;
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(() => { server.close(); global.fetch = realFetch; });
test.afterEach(() => {
  for (const k of ['AI_PROVIDER', 'AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY', 'AI_FORCED_TOOL_CHOICE', 'AI_FALLBACK_PROVIDER', 'AI_FALLBACK_MODEL']) delete process.env[k];
  global.fetch = realFetch;
});

function useCompat(model = 'deepseek-chat') {
  process.env.AI_PROVIDER = 'openai-compatible';
  process.env.AI_BASE_URL = 'https://api.example-llm.cn/v1/';
  process.env.AI_MODEL = model;
  process.env.AI_API_KEY = 'sk-test-domestic';
}

async function register(email) {
  const res = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123', privacyAccepted: true }),
  });
  return res.json();
}

test('default provider is Anthropic; compat needs base url, model and key to count as configured', () => {
  assert.equal(providerName(), 'anthropic');
  assert.equal(aiConfigured(), true);
  process.env.AI_PROVIDER = 'openai-compatible';
  assert.equal(providerName(), 'openai-compatible');
  assert.equal(aiConfigured(), false);
  useCompat();
  assert.equal(aiConfigured(), true);
});

test('request translation: tools, forced vs auto choice, and tool round-trip messages', () => {
  const tool = { name: 'submit_answer', description: 'd', input_schema: { type: 'object', properties: { a: { type: 'string' } } } };
  assert.deepEqual(toOpenAITools([tool]), [{ type: 'function', function: { name: 'submit_answer', description: 'd', parameters: tool.input_schema } }]);
  assert.equal(toToolChoice({ type: 'auto' }, [tool]), 'auto');
  assert.deepEqual(toToolChoice({ type: 'tool', name: 'submit_answer' }, [tool]), { type: 'function', function: { name: 'submit_answer' } });
  process.env.AI_FORCED_TOOL_CHOICE = 'required';
  assert.equal(toToolChoice({ type: 'tool', name: 'submit_answer' }, [tool]), 'required');
  assert.deepEqual(toToolChoice({ type: 'tool', name: 'submit_answer' }, [tool, tool]), { type: 'function', function: { name: 'submit_answer' } });

  const msgs = toOpenAIMessages('SYS', [
    { role: 'user', content: '问题' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search_records', input: { keywords: '转圈' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '记录块' }] },
  ]);
  assert.deepEqual(msgs[0], { role: 'system', content: 'SYS' });
  assert.deepEqual(msgs[1], { role: 'user', content: '问题' });
  assert.equal(msgs[2].tool_calls[0].function.arguments, JSON.stringify({ keywords: '转圈' }));
  assert.deepEqual(msgs[3], { role: 'tool', tool_call_id: 't1', content: '记录块' });
});

test('response translation: tool_calls become tool_use blocks, usage maps, cached tokens are split out', () => {
  const out = fromOpenAIResponse({
    id: 'x', model: 'm',
    choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'submit_review', arguments: '{"good_points":["a"]}' } }] } }],
    usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 400 },
  }, 'submit_review');
  assert.deepEqual(out.content, [{ type: 'tool_use', id: 'c1', name: 'submit_review', input: { good_points: ['a'] } }]);
  assert.equal(out.usage.input_tokens, 600);
  assert.equal(out.usage.cache_read_input_tokens, 400);
  assert.equal(out.usage.output_tokens, 50);
  assert.equal(out.stop_reason, 'tool_use');
});

test('a model that ignores the forced tool but returns the right JSON as text is still accepted; garbage is not', () => {
  const fenced = fromOpenAIResponse({ choices: [{ message: { content: '```json\n{"answered":true,"answer":"x","cited_record_ids":[1]}\n```' } }] }, 'submit_answer');
  const tu = fenced.content.find((b) => b.type === 'tool_use');
  assert.equal(tu.name, 'submit_answer');
  assert.equal(tu.input.answered, true);
  const junk = fromOpenAIResponse({ choices: [{ message: { content: '抱歉，我无法回答' } }] }, 'submit_answer');
  assert.equal(junk.content.some((b) => b.type === 'tool_use'), false);
  const notForced = fromOpenAIResponse({ choices: [{ message: { content: '{"a":1}' } }] }, null);
  assert.equal(notForced.content.some((b) => b.type === 'tool_use'), false);
});

test('/api/generate works end to end through an OpenAI-compatible provider, calls the right URL with the right body, and never touches Anthropic', async () => {
  useCompat();
  const { token, user } = await register('compat-generate@example.com');
  const seen = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith(base)) return realFetch(url, opts);
    seen.push({ url: u, headers: opts.headers, body: JSON.parse(opts.body) });
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({
        choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'submit_review', arguments: JSON.stringify({
          good_points: ['passé 尚可'], improve_points: ['骨盆晃'], next_time_reminder: [], session_tips: [], confidence_level: '高', note: '',
        }) } }] } }],
        usage: { prompt_tokens: 800, completion_tokens: 90 },
      }),
    };
  };
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ transcript: '今天pirouette骨盆晃' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.good_points, /passé/);
  assert.match(body.improve_points, /骨盆/);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.example-llm.cn/v1/chat/completions');
  assert.equal(seen[0].headers.Authorization, 'Bearer sk-test-domestic');
  assert.equal(seen[0].body.model, 'deepseek-chat');
  assert.deepEqual(seen[0].body.tool_choice, { type: 'function', function: { name: 'submit_review' } });
  assert.equal(seen[0].body.messages[0].role, 'system');
  assert.equal(seen.some((s) => s.url.includes('anthropic.com')), false);

  const ev = await db.get("SELECT metadata FROM events WHERE user_id = ? AND event_name = 'ai_process_success' ORDER BY id DESC LIMIT 1", [user.id]);
  const meta = JSON.parse(ev.metadata);
  assert.equal(meta.inputTokens, 800);
  assert.equal(meta.outputTokens, 90);
});

test('provider failures behave like Anthropic ones: 5xx retried once, error text never reaches the user', async () => {
  useCompat();
  const { token } = await register('compat-fail@example.com');
  let calls = 0;
  const realErr = console.error;
  console.error = () => {};
  global.fetch = async (url, opts) => {
    if (String(url).startsWith(base)) return realFetch(url, opts);
    calls += 1;
    return { ok: false, status: 503, headers: { get: () => null }, text: async () => 'Insufficient Balance for account sk-secret' };
  };
  try {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ transcript: '今天练了基本功' }),
    });
    assert.equal(res.status, 502);
    assert.ok(!/Balance|sk-secret/.test(await res.text()));
  } finally {
    console.error = realErr;
  }
  assert.equal(calls, 2);
});

test('when the compat provider is selected but not configured, users get a neutral message, not a config leak', async () => {
  process.env.AI_PROVIDER = 'openai-compatible';
  const { token } = await register('compat-unconfigured@example.com');
  const realErr = console.error;
  console.error = () => {};
  try {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ transcript: '今天练了基本功' }),
    });
    assert.equal(res.status, 500);
    assert.ok(!/AI_BASE_URL|AI_API_KEY|ANTHROPIC/.test(await res.text()));
  } finally {
    console.error = realErr;
  }
});

// ---------- primary (DeepSeek-style) with Anthropic as the fallback ----------
function useFallback() {
  useCompat();
  process.env.AI_FALLBACK_PROVIDER = 'anthropic';
  process.env.AI_FALLBACK_MODEL = 'claude-test-fallback';
}

const anthropicOk = () => ({
  ok: true, status: 200, headers: { get: () => null },
  json: async () => ({
    content: [{ type: 'tool_use', name: 'submit_review', input: { good_points: ['来自兜底模型'], improve_points: [], next_time_reminder: [], session_tips: [], confidence_level: '高', note: '' } }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }),
});
const failing = (status, text = 'upstream trouble') => ({ ok: false, status, headers: { get: () => null }, text: async () => text });

function routeFetch({ compat, anthropic }) {
  const calls = { compat: [], anthropic: [] };
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith(base)) return realFetch(url, opts);
    if (u.includes('api.example-llm.cn')) { calls.compat.push(opts); return compat(calls.compat.length); }
    if (u.includes('api.anthropic.com')) { calls.anthropic.push({ headers: opts.headers, body: JSON.parse(opts.body) }); return anthropic(calls.anthropic.length); }
    return realFetch(url, opts);
  };
  return calls;
}

async function generate(token) {
  return fetch(`${base}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ transcript: '今天练了基本功' }),
  });
}

async function quiet(fn) {
  const realErr = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = realErr; }
}

test('fallback: primary 5xx twice, then the same request succeeds on Anthropic with the fallback model and key', async () => {
  useFallback();
  const { token } = await register('fb-5xx@example.com');
  const calls = routeFetch({ compat: () => failing(503), anthropic: () => anthropicOk() });
  const res = await quiet(() => generate(token));
  assert.equal(res.status, 200);
  assert.match((await res.json()).good_points, /兜底/);
  assert.equal(calls.compat.length, 2, 'primary is still retried once before falling back');
  assert.equal(calls.anthropic.length, 1);
  assert.equal(calls.anthropic[0].body.model, 'claude-test-fallback');
  assert.equal(calls.anthropic[0].headers['x-api-key'], 'test-key-unused-fetch-is-mocked');
});

test('fallback: an out-of-balance / bad-key answer (402, 401, 403) goes to Anthropic immediately, no wasted retry', async () => {
  for (const status of [402, 401, 403]) {
    useFallback();
    const { token } = await register(`fb-${status}@example.com`);
    const calls = routeFetch({ compat: () => failing(status, 'Insufficient Balance'), anthropic: () => anthropicOk() });
    const res = await quiet(() => generate(token));
    assert.equal(res.status, 200, `status ${status}`);
    assert.equal(calls.compat.length, 1);
    assert.equal(calls.anthropic.length, 1);
    global.fetch = realFetch;
  }
});

test('fallback: a primary timeout skips the second primary attempt and falls back straight away', async () => {
  useFallback();
  const { token } = await register('fb-timeout@example.com');
  const calls = routeFetch({
    compat: () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
    anthropic: () => anthropicOk(),
  });
  const res = await quiet(() => generate(token));
  assert.equal(res.status, 200);
  assert.equal(calls.compat.length, 1);
  assert.equal(calls.anthropic.length, 1);
});

test('fallback: a 400 is our own bad request, so it is NOT sent to Anthropic', async () => {
  useFallback();
  const { token } = await register('fb-400@example.com');
  const calls = routeFetch({ compat: () => failing(400), anthropic: () => anthropicOk() });
  const res = await quiet(() => generate(token));
  assert.equal(res.status, 502);
  assert.equal(calls.anthropic.length, 0);
});

test('fallback: when both providers fail the user gets the neutral error, and neither error text leaks', async () => {
  useFallback();
  const { token } = await register('fb-both@example.com');
  const calls = routeFetch({ compat: () => failing(503, 'DeepSeek internal detail'), anthropic: () => failing(529, 'Anthropic overloaded detail') });
  const res = await quiet(() => generate(token));
  assert.equal(res.status, 502);
  assert.ok(!/DeepSeek|Anthropic|overloaded|detail/.test(await res.text()));
  assert.equal(calls.anthropic.length, 1);
});

test('fallback is off unless asked for: without AI_FALLBACK_PROVIDER a primary outage never reaches Anthropic', async () => {
  useCompat();
  const { token } = await register('fb-off@example.com');
  const calls = routeFetch({ compat: () => failing(503), anthropic: () => anthropicOk() });
  const res = await quiet(() => generate(token));
  assert.equal(res.status, 502);
  assert.equal(calls.anthropic.length, 0);
  const { fallbackProviderName } = require('../ai/provider');
  assert.equal(fallbackProviderName(), null);
  process.env.AI_PROVIDER = 'anthropic';
  process.env.AI_FALLBACK_PROVIDER = 'anthropic';
  assert.equal(fallbackProviderName(), null, 'fallback only makes sense behind a non-Anthropic primary');
});

test('/api/health/ai reports how many requests fell back recently, without turning red by itself', async () => {
  useFallback();
  const { token } = await register('fb-health@example.com');
  routeFetch({ compat: () => failing(503), anthropic: () => anthropicOk() });
  await quiet(() => generate(token));
  global.fetch = realFetch;
  const res = await fetch(`${base}/api/health/ai`);
  const body = await res.json();
  assert.ok(body.llmFallbackUses >= 1);
  assert.equal(res.status, 200);
});
