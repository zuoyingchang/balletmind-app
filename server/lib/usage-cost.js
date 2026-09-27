// Internal stats only. Not a billing API. Classify usage events and apply list-price estimates.

function roundUsd(n) {
  return Math.round(n * 10000) / 10000;
}

function roundMin(n) {
  return Math.round(n * 1000) / 1000;
}

function emptyLlm() {
  return {
    callCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    latencies: [],
  };
}

function classifyLlmProvider(meta) {
  if (!meta || typeof meta !== 'object') return 'unknown';
  if (meta.fellBack === true) return 'anthropic';
  const provider = String(meta.provider || '').toLowerCase();
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'deepseek' || provider === 'openai-compatible') return 'deepseek';
  const model = String(meta.model || '').toLowerCase();
  if (model.includes('claude')) return 'anthropic';
  if (model.includes('deepseek')) return 'deepseek';
  return 'unknown';
}

function llmUsd(bucket, rates) {
  return (bucket.inputTokens / 1e6) * rates.input
    + (bucket.outputTokens / 1e6) * rates.output
    + (bucket.cacheCreationTokens / 1e6) * rates.input * 1.25
    + (bucket.cacheReadTokens / 1e6) * rates.input * 0.1;
}

function addLlmMeta(bucket, meta) {
  if (typeof meta.inputTokens === 'number') bucket.inputTokens += meta.inputTokens;
  if (typeof meta.outputTokens === 'number') bucket.outputTokens += meta.outputTokens;
  if (typeof meta.cacheReadTokens === 'number') bucket.cacheReadTokens += meta.cacheReadTokens;
  if (typeof meta.cacheCreationTokens === 'number') bucket.cacheCreationTokens += meta.cacheCreationTokens;
  if (typeof meta.latencyMs === 'number') bucket.latencies.push(meta.latencyMs);
  bucket.callCount += 1;
}

function summarizeLlm(bucket, rates) {
  const usd = llmUsd(bucket, rates);
  return {
    callCount: bucket.callCount,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    cacheCreationTokens: bucket.cacheCreationTokens,
    estimatedUsd: roundUsd(usd),
    _estimatedUsd: usd,
    usageNote: 'token 来自接口 usage；美元按看板单价估算',
  };
}

function collectLlmByProvider(metas, rates) {
  const buckets = {
    deepseek: emptyLlm(),
    anthropic: emptyLlm(),
    unknown: emptyLlm(),
  };
  const confidence = { 高: 0, 中: 0, 低: 0, other: 0 };
  const allLatencies = [];
  for (const m of metas) {
    const key = classifyLlmProvider(m);
    addLlmMeta(buckets[key] || buckets.unknown, m);
    if (typeof m.latencyMs === 'number') allLatencies.push(m.latencyMs);
    const c = m.confidence_level;
    if (c === '高' || c === '中' || c === '低') confidence[c] += 1;
    else if (c) confidence.other += 1;
  }
  const deepseek = summarizeLlm(buckets.deepseek, rates.deepseek);
  const anthropic = summarizeLlm(buckets.anthropic, rates.anthropic);
  const unknown = summarizeLlm(buckets.unknown, rates.deepseek);
  unknown.usageNote = '旧事件没有 provider/model，token 计入总量，美元按 DeepSeek 单价粗算';
  const totalUsd = deepseek._estimatedUsd + anthropic._estimatedUsd + unknown._estimatedUsd;
  return {
    deepseek,
    anthropic,
    unknown,
    totals: {
      callCount: deepseek.callCount + anthropic.callCount + unknown.callCount,
      inputTokens: deepseek.inputTokens + anthropic.inputTokens + unknown.inputTokens,
      outputTokens: deepseek.outputTokens + anthropic.outputTokens + unknown.outputTokens,
      cacheReadTokens: deepseek.cacheReadTokens + anthropic.cacheReadTokens + unknown.cacheReadTokens,
      cacheCreationTokens: deepseek.cacheCreationTokens + anthropic.cacheCreationTokens + unknown.cacheCreationTokens,
      estimatedUsd: roundUsd(totalUsd),
      _estimatedUsd: totalUsd,
      latencies: allLatencies,
    },
    confidence,
  };
}

function isWhisperModel(model) {
  const m = String(model || '').toLowerCase();
  return !m || m.includes('whisper') || m.includes('transcribe');
}

function collectWhisperUsage(metas, usdPerMin) {
  let success = 0;
  let withDuration = 0;
  let durationSec = 0;
  const latencies = [];
  for (const m of metas) {
    if (!isWhisperModel(m.model) && m.model) continue;
    success += 1;
    if (typeof m.latencyMs === 'number') latencies.push(m.latencyMs);
    if (typeof m.durationSec === 'number' && m.durationSec > 0) {
      withDuration += 1;
      durationSec += m.durationSec;
    }
  }
  const estimatedMinutes = roundMin(durationSec / 60);
  const estimatedUsd = withDuration ? roundUsd(estimatedMinutes * usdPerMin) : null;
  return {
    callCount: success,
    withDurationSec: withDuration,
    estimatedMinutes,
    estimatedUsd,
    estimatedTokens: null,
    latencies,
    usageNote: 'Whisper 按音频分钟计费，没有 token。没有 durationSec 的旧事件只计次数、不算钱。',
  };
}

module.exports = {
  classifyLlmProvider,
  collectLlmByProvider,
  collectWhisperUsage,
  roundUsd,
};
