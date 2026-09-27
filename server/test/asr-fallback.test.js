process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.TURSO_DATABASE_URL = 'file::memory:';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.ANTHROPIC_API_KEY = 'test-key-unused-fetch-is-mocked';
process.env.OPENAI_API_KEY = 'test-openai-key';
for (const k of ['ASR_FALLBACK_PROVIDER', 'ASR_FALLBACK_SECRET_ID', 'ASR_FALLBACK_SECRET_KEY', 'ASR_FALLBACK_REGION', 'ASR_FALLBACK_ENGINE', 'ASR_FALLBACK_HOTWORD_ID']) delete process.env[k];

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app.js');
const db = require('../db');
const { asrFallbackProviderName } = require('../ai/asr-provider');
const { signRequest, buildPayload } = require('../ai/asr-tencent');
const { prepareForTencentAsr, contentTypeToExt, tencentTarget } = require('../lib/audio-convert');
const { execFileSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

let server;
let base;
const realFetch = global.fetch;

test.before(async () => { await db.ready; server = app.listen(0); base = `http://localhost:${server.address().port}`; });
test.after(() => { server.close(); global.fetch = realFetch; });
test.afterEach(() => {
  for (const k of ['ASR_FALLBACK_PROVIDER', 'ASR_FALLBACK_SECRET_ID', 'ASR_FALLBACK_SECRET_KEY']) delete process.env[k];
  global.fetch = realFetch;
});

async function register(email) {
  const res = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123', privacyAccepted: true }),
  });
  return res.json();
}

// ---------- config gating ----------
test('ASR fallback is off unless ASR_FALLBACK_PROVIDER=tencent AND both Tencent credentials are set', () => {
  // require('../app.js') above re-triggers dotenv, which refills these from a real .env
  // (module-load-time delete only runs once) — clear them again right before asserting.
  for (const k of ['ASR_FALLBACK_PROVIDER', 'ASR_FALLBACK_SECRET_ID', 'ASR_FALLBACK_SECRET_KEY']) delete process.env[k];
  assert.equal(asrFallbackProviderName(), null);
  process.env.ASR_FALLBACK_PROVIDER = 'tencent';
  assert.equal(asrFallbackProviderName(), null, 'no credentials yet');
  process.env.ASR_FALLBACK_SECRET_ID = 'id';
  assert.equal(asrFallbackProviderName(), null, 'missing the key half');
  process.env.ASR_FALLBACK_SECRET_KEY = 'key';
  assert.equal(asrFallbackProviderName(), 'tencent');
});

// ---------- audio remuxing (real ffmpeg, no network) ----------
function makeSyntheticWebm(path) {
  execFileSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', '-c:a', 'libopus', '-f', 'webm', path]);
}
function realSyntheticWebmBytes() {
  const os = require('os'), path = require('path'), fs = require('fs');
  const f = path.join(os.tmpdir(), `bm-fallback-src-${process.pid}-${Date.now()}.webm`);
  makeSyntheticWebm(f);
  const buf = fs.readFileSync(f);
  fs.unlinkSync(f);
  return buf;
}

function probe(path) {
  try {
    execFileSync(ffmpegPath, ['-hide_banner', '-i', path], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return e.stderr.toString(); // ffmpeg -i with no output always "fails"; stderr has the stream info
  }
  return '';
}

test('contentTypeToExt / tencentTarget: webm and ogg need remuxing, mp4/mp3/wav pass through', () => {
  assert.equal(contentTypeToExt('audio/webm;codecs=opus'), 'webm');
  assert.equal(contentTypeToExt('audio/mp4'), 'mp4');
  assert.deepEqual(tencentTarget('webm'), { voiceFormat: 'ogg-opus', remuxTo: 'ogg' });
  assert.deepEqual(tencentTarget('mp4'), { voiceFormat: 'm4a', remuxTo: null });
  assert.deepEqual(tencentTarget('wav'), { voiceFormat: 'wav', remuxTo: null });
});

test('prepareForTencentAsr actually remuxes a real webm/opus recording into playable ogg/opus, unchanged audio', async (t) => {
  const os = require('os'), path = require('path'), fs = require('fs');
  const src = path.join(os.tmpdir(), `bm-test-${process.pid}.webm`);
  makeSyntheticWebm(src);
  const buf = fs.readFileSync(src);
  fs.unlinkSync(src);

  const { buffer, voiceFormat } = await prepareForTencentAsr(buf, 'audio/webm;codecs=opus');
  assert.equal(voiceFormat, 'ogg-opus');
  assert.ok(buffer.length > 0);

  const out = path.join(os.tmpdir(), `bm-test-out-${process.pid}.ogg`);
  fs.writeFileSync(out, buffer);
  const info = probe(out);
  fs.unlinkSync(out);
  assert.match(info, /Audio: opus/);
  assert.match(info, /Duration: 00:00:00\.[23]/); // ~0.3s in, remux must not change duration
});

test('prepareForTencentAsr passes wav straight through with no ffmpeg call', async () => {
  const buf = Buffer.from('RIFF....WAVEfmt not-a-real-wav-but-should-not-be-touched');
  const { buffer, voiceFormat } = await prepareForTencentAsr(buf, 'audio/wav');
  assert.equal(voiceFormat, 'wav');
  assert.equal(buffer, buf);
});

// ---------- TC3 signature structure (cannot verify against the real API without live credentials) ----------
test('TC3 signing: correct shape, and changing the secret or timestamp changes the signature', () => {
  const payload = buildPayload('ZmFrZS1hdWRpbw==', 'wav');
  const parsed = JSON.parse(payload);
  assert.equal(parsed.SourceType, 1);
  assert.equal(parsed.VoiceFormat, 'wav');
  assert.equal(parsed.Data, 'ZmFrZS1hdWRpbw==');

  const a = signRequest({ secretId: 'AKIDtest', secretKey: 'secretA', timestamp: 1700000000, payload });
  assert.match(a.authorization, /^TC3-HMAC-SHA256 Credential=AKIDtest\/\d{4}-\d{2}-\d{2}\/asr\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/);
  assert.equal(a.date, '2023-11-14');

  const b = signRequest({ secretId: 'AKIDtest', secretKey: 'secretB', timestamp: 1700000000, payload });
  assert.notEqual(a.authorization, b.authorization, 'a different secret must produce a different signature');

  const c = signRequest({ secretId: 'AKIDtest', secretKey: 'secretA', timestamp: 1700000001, payload });
  assert.notEqual(a.authorization, c.authorization, 'a different timestamp must produce a different signature');

  const d = signRequest({ secretId: 'AKIDtest', secretKey: 'secretA', timestamp: 1700000000, payload });
  assert.equal(a.authorization, d.authorization, 'identical inputs must be deterministic');
});

// ---------- end-to-end through the route, Tencent mocked ----------
async function postAudio(token, body) {
  return fetch(`${base}/api/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/webm', Authorization: `Bearer ${token}` },
    body: body || Buffer.from('fake-audio-bytes-that-are-long-enough-to-pass-the-empty-check'),
  });
}
function quiet(fn) {
  const realErr = console.error;
  console.error = () => {};
  return Promise.resolve(fn()).finally(() => { console.error = realErr; });
}

test('end to end: Whisper fails, ffmpeg remuxes the real audio, Tencent (mocked) returns text, user gets a normal 200', async () => {
  process.env.ASR_FALLBACK_PROVIDER = 'tencent';
  process.env.ASR_FALLBACK_SECRET_ID = 'AKIDtest';
  process.env.ASR_FALLBACK_SECRET_KEY = 'secretA';
  const { token, user } = await register('asr-fb-ok@example.com');
  let tencentCall = null;
  await quiet(async () => {
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('audio/transcriptions')) return { ok: false, status: 503, text: async () => 'whisper down' };
      if (u.includes('asr.tencentcloudapi.com')) {
        tencentCall = { url: u, headers: opts.headers, body: JSON.parse(opts.body) };
        return { ok: true, status: 200, json: async () => ({ Response: { RequestId: 'r1', Result: '普利耶 稳一点' } }) };
      }
      return realFetch(url, opts);
    };
    const res = await postAudio(token, realSyntheticWebmBytes());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.text, '普利耶 稳一点');
    assert.equal(body.model, 'tencent-sentence-recognition');
  });
  assert.ok(tencentCall, 'Tencent must have been called');
  assert.equal(tencentCall.headers['X-TC-Action'], 'SentenceRecognition');
  assert.match(tencentCall.headers.Authorization, /^TC3-HMAC-SHA256/);
  assert.equal(tencentCall.body.VoiceFormat, 'ogg-opus');
  assert.ok(tencentCall.body.Data.length > 0);

  const ev = await db.get("SELECT metadata FROM events WHERE user_id = ? AND event_name = 'asr_success' ORDER BY id DESC LIMIT 1", [user.id]);
  assert.equal(JSON.parse(ev.metadata).model, 'tencent-sentence-recognition');
});

test('when both Whisper and the Tencent fallback fail, the user gets the same neutral message and neither error text leaks', async () => {
  process.env.ASR_FALLBACK_PROVIDER = 'tencent';
  process.env.ASR_FALLBACK_SECRET_ID = 'AKIDtest';
  process.env.ASR_FALLBACK_SECRET_KEY = 'secretA';
  const { token } = await register('asr-fb-both-fail@example.com');
  await quiet(async () => {
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('audio/transcriptions')) return { ok: false, status: 503, text: async () => 'whisper detail' };
      if (u.includes('asr.tencentcloudapi.com')) return { ok: true, status: 200, json: async () => ({ Response: { Error: { Code: 'AuthFailure.SecretIdNotFound', Message: 'tencent secret detail' } } }) };
      return realFetch(url, opts);
    };
    const res = await postAudio(token);
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.ok(!/whisper detail|tencent secret detail|SecretIdNotFound/.test(text));
  });
});

test('fallback stays off without ASR_FALLBACK_PROVIDER: a Whisper outage never calls Tencent', async () => {
  const { token } = await register('asr-fb-off@example.com');
  let tencentCalled = false;
  await quiet(async () => {
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('audio/transcriptions')) return { ok: false, status: 503, text: async () => 'down' };
      if (u.includes('tencentcloudapi.com')) { tencentCalled = true; return { ok: true, status: 200, json: async () => ({ Response: { Result: 'x' } }) }; }
      return realFetch(url, opts);
    };
    const res = await postAudio(token);
    assert.equal(res.status, 502);
  });
  assert.equal(tencentCalled, false);
});

test('/api/health/ai reports ASR fallback uses separately from LLM fallback uses', async () => {
  process.env.ASR_FALLBACK_PROVIDER = 'tencent';
  process.env.ASR_FALLBACK_SECRET_ID = 'AKIDtest';
  process.env.ASR_FALLBACK_SECRET_KEY = 'secretA';
  const { token } = await register('asr-fb-health@example.com');
  await quiet(async () => {
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('audio/transcriptions')) return { ok: false, status: 503, text: async () => 'down' };
      if (u.includes('tencentcloudapi.com')) return { ok: true, status: 200, json: async () => ({ Response: { Result: 'ok' } }) };
      return realFetch(url, opts);
    };
    await postAudio(token, realSyntheticWebmBytes());
  });
  const res = await fetch(`${base}/api/health/ai`);
  const body = await res.json();
  assert.ok(body.asrFallbackUses >= 1);
});
