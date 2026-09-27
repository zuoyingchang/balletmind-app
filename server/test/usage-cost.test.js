const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyLlmProvider, collectLlmByProvider, collectWhisperUsage } = require('../lib/usage-cost');

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
