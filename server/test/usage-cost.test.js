const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyLlmProvider, collectLlmByProvider, collectWhisperUsage, latencySummary, fallbackSummary, summarizeAsk, summarizeEmbedding, summarizeTraffic } = require('../lib/usage-cost');
const { isTestAccountEmail, splitTestUsers } = require('../lib/test-users');

test('classifyLlmProvider uses provider, fallback flag, then model name', () => {
  assert.equal(classifyLlmProvider({ fellBack: true, provider: 'deepseek' }), 'anthropic');
  assert.equal(classifyLlmProvider({ provider: 'deepseek' }), 'deepseek');
  assert.equal(classifyLlmProvider({ provider: 'anthropic' }), 'anthropic');
  assert.equal(classifyLlmProvider({ model: 'deepseek-chat' }), 'deepseek');
  assert.equal(classifyLlmProvider({ model: 'claude-sonnet-5' }), 'anthropic');
  assert.equal(classifyLlmProvider({}), 'unknown');
});

test('collectLlmByProvider splits tokens and applies separate list prices', () => {
  const packed = collectLlmByProvider([
    { provider: 'deepseek', inputTokens: 1e6, outputTokens: 0 },
    { provider: 'anthropic', inputTokens: 0, outputTokens: 1e6 },
  ], {
    deepseek: { input: 0.28, output: 0.42 },
    anthropic: { input: 2, output: 10 },
  });
  assert.equal(packed.deepseek.callCount, 1);
  assert.equal(packed.deepseek.estimatedUsd, 0.28);
  assert.equal(packed.anthropic.callCount, 1);
  assert.equal(packed.anthropic.estimatedUsd, 10);
  assert.equal(packed.totals.estimatedUsd, 10.28);
});

test('collectWhisperUsage estimates minutes and dollars, not tokens', () => {
  const w = collectWhisperUsage([
    { model: 'whisper-1', durationSec: 60 },
    { model: 'whisper-1', durationSec: 30 },
    { model: 'tencent-sentence-recognition', durationSec: 120 },
  ], 0.006);
  assert.equal(w.callCount, 2);
  assert.equal(w.estimatedMinutes, 1.5);
  assert.equal(w.estimatedUsd, 0.009);
  assert.equal(w.estimatedTokens, null);
});

test('latencySummary leads with the median and flags hangs instead of letting them skew the picture', () => {
  const normal = [1200, 1500, 1800, 2000, 2300, 2600, 3000, 3400, 4000];
  const s = latencySummary([...normal, 130000, 804000]);
  assert.equal(s.count, 11);
  assert.equal(s.slowCount, 2);
  assert.equal(s.maxMs, 804000);
  assert.ok(s.p50Ms <= 3000, `median should stay in the normal range, got ${s.p50Ms}`);
  assert.ok(s.avgMs > 60000, 'the average is the number the hangs distort');
  assert.deepEqual(latencySummary([]), { count: 0, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null, slowCount: 0, slowThresholdMs: 60000 });
  assert.equal(latencySummary([59999, 60000]).slowCount, 1);
});

test('fallbackSummary counts only calls the backup provider actually answered', () => {
  const f = fallbackSummary([
    { provider: 'deepseek' },
    { provider: 'deepseek', fellBack: false },
    { provider: 'anthropic', fellBack: true },
    { provider: 'anthropic' },
  ]);
  assert.deepEqual(f, { total: 4, fellBack: 1, rate: 25 });
  assert.deepEqual(fallbackSummary([]), { total: 0, fellBack: 0, rate: null });
});

test('latencySummary ignores 0 ms entries (events that never made a round trip)', () => {
  const s = latencySummary([0, 0, 0, 2000, 4000]);
  assert.equal(s.count, 2);
  assert.equal(s.p50Ms, 2000);
});

test('summarizeAsk counts embedding lookups separately, using the recorded flag when present', () => {
  const s = summarizeAsk([
    { retrievalPath: 'keyword', keywordCount: 5, embeddingRan: false },
    { retrievalPath: 'keyword', keywordCount: 0, embeddingRan: true },
    { retrievalPath: 'keyword', keywordCount: 4 },
    { retrievalPath: 'keyword', keywordCount: 1 },
    { retrievalPath: 'hybrid', keywordCount: 3 },
  ]);
  assert.deepEqual(s, { total: 5, embedding: 3, local: 2, inferred: 3 });
});

test('test accounts are recognised by reserved domains and test-style qq addresses only', () => {
  ['a@test.local', 'x@example.com', 'x@Example.ORG', 'test@qq.com', 'test1@qq.com', 'tes2t@qq.com', 'TEST3@qq.com'].forEach((e) => assert.ok(isTestAccountEmail(e), e));
  ['1123106531@qq.com', 'old_zuo@163.com', 'testing.person@qq.com', 'contest@qq.com', 'teacher@gmail.com', '', null].forEach((e) => assert.ok(!isTestAccountEmail(e), String(e)));
  assert.deepEqual(
    (({ registered, test, real }) => ({ registered, test, real }))(splitTestUsers([{ email: 'a@qq.com' }, { email: 'test@qq.com' }, { email: 'q@example.com' }])),
    { registered: 3, test: 2, real: 1 }
  );
});

test('summarizeEmbedding prices measured tokens and estimates earlier cached vectors separately', () => {
  const e = summarizeEmbedding(
    [{ source: 'save', inputTokens: 500000 }, { source: 'ask', inputTokens: 500000 }, { inputTokens: 0 }],
    0.02,
    { records: 10, chars: 1000000 }
  );
  assert.equal(e.callCount, 3);
  assert.equal(e.tokens, 1000000);
  assert.deepEqual(e.bySource, { save: 2, ask: 1 });
  assert.equal(e.measuredUsd, 0.02);
  assert.equal(e.historyEstimatedTokens, 1200000);
  assert.equal(e.historyEstimatedUsd, 0.024);
  assert.equal(e.estimatedUsd, 0.044);
});

test('summarizeTraffic splits visitors into signed-in and never-signed-in, all time and last 7 days', () => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const t = summarizeTraffic([
    { first_seen: now - day, signed_in: 1, platform: 'ios', browser: 'safari', src: 'xhs', in_app: 0 },
    { first_seen: now - 2 * day, signed_in: 0, platform: 'android', browser: 'xiaomi', src: 'xhs', in_app: 0 },
    { first_seen: now - 20 * day, signed_in: 0, platform: 'ios', browser: 'wechat', src: 'direct', in_app: 1 },
  ], now, 7 * day);
  assert.equal(t.all.total, 3);
  assert.equal(t.all.neverSignedIn, 2);
  assert.equal(t.last7d.total, 2);
  assert.equal(t.last7d.neverSignedIn, 1);
  assert.equal(t.all.inApp, 1);
  assert.deepEqual(t.all.bySrc, { xhs: 2, direct: 1 });
});
