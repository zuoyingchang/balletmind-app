// Internal stats only. Not a billing API. Classify usage events and apply list-price estimates.

// A single call this slow is a hang (provider stall / lost connection), not normal latency.
const SLOW_CALL_MS = 60000;

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

// Median / P95 plus how many calls were hangs. Average and P95 alone get dragged around by a
// handful of multi-minute stalls, so the page leads with the median and flags the slow ones.
function latencySummary(nums, slowMs = SLOW_CALL_MS) {
  // A 0 ms latency is a missing measurement, not a fast call.
  const sorted = (nums || []).filter((n) => typeof n === 'number' && n > 0).sort((a, b) => a - b);
  const pick = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);
  return {
    count: sorted.length,
    avgMs: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
    p50Ms: pick(50),
    p95Ms: pick(95),
    maxMs: sorted.length ? sorted[sorted.length - 1] : null,
    slowCount: sorted.filter((n) => n >= slowMs).length,
    slowThresholdMs: slowMs,
  };
}

// How often the primary provider failed and the backup (Anthropic) answered instead.
function fallbackSummary(metas) {
  const list = metas || [];
  const fellBack = list.filter((m) => m && m.fellBack === true).length;
  return {
    total: list.length,
    fellBack,
    rate: list.length ? Math.round((fellBack / list.length) * 1000) / 10 : null,
  };
}

// 问问我的档案 never calls a chat model; the only AI it can touch is an embedding lookup (OpenAI),
// which runs when keyword hits are sparse. Newer events record embeddingRan; for older ones we
// infer it from the retrieval path / keyword count and report how many were inferred.
function askUsedEmbedding(m) {
  if (typeof m.embeddingRan === 'boolean') return { used: m.embeddingRan, inferred: false };
  const path = m.retrievalPath;
  if (path === 'embedding' || path === 'hybrid') return { used: true, inferred: true };
  if (path === 'keyword' && typeof m.keywordCount === 'number' && m.keywordCount <= 1) return { used: true, inferred: true };
  return { used: false, inferred: true };
}

function summarizeAsk(metas) {
  const out = { total: 0, embedding: 0, local: 0, inferred: 0 };
  for (const m of metas || []) {
    const r = askUsedEmbedding(m || {});
    out.total += 1;
    if (r.used) out.embedding += 1; else out.local += 1;
    if (r.inferred) out.inferred += 1;
  }
  return out;
}

function countBy(rows, keyFn) {
  const out = {};
  for (const r of rows) {
    const k = keyFn(r) || 'other';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

// Visitors = anonymous browser ids that opened the app (see lib/telemetry.js); signed_in marks
// the ones that later logged in or registered.
function summarizeTraffic(rows, now, weekMs) {
  const list = rows || [];
  const recent = list.filter((r) => Number(r.first_seen) >= now - weekMs);
  const part = (rs) => ({
    total: rs.length,
    signedIn: rs.filter((r) => r.signed_in).length,
    neverSignedIn: rs.filter((r) => !r.signed_in).length,
    inApp: rs.filter((r) => r.in_app).length,
    byPlatform: countBy(rs, (r) => r.platform),
    byBrowser: countBy(rs, (r) => r.browser),
    bySrc: countBy(rs, (r) => r.src),
  });
  return { last7d: part(recent), all: part(list) };
}

// screen_view events -> per screen: views and distinct logged-in users.
function summarizeScreens(events, since) {
  const screens = {};
  for (const e of events || []) {
    if (since && Number(e.created_at) < since) continue;
    const name = e.meta && e.meta.screen;
    if (!name) continue;
    screens[name] = screens[name] || { views: 0, users: new Set() };
    screens[name].views += 1;
    if (e.user_id != null) screens[name].users.add(e.user_id);
  }
  return Object.entries(screens)
    .map(([screen, v]) => ({ screen, views: v.views, users: v.users.size }))
    .sort((a, b) => b.views - a.views);
}

// client_error events -> "where / kind" counts plus which browsers they came from.
function summarizeClientErrors(events, since) {
  const rows = (events || []).filter((e) => !since || Number(e.created_at) >= since);
  const byWhereKind = {};
  const byBrowser = {};
  for (const e of rows) {
    const m = e.meta || {};
    const k = `${m.where || 'api'} / ${m.kind || 'other'}`;
    byWhereKind[k] = (byWhereKind[k] || 0) + 1;
    const b = `${m.platform || 'other'} · ${m.browser || 'other'}`;
    byBrowser[b] = (byBrowser[b] || 0) + 1;
  }
  const sorted = (o) => Object.entries(o).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  return { total: rows.length, byWhereKind: sorted(byWhereKind), byBrowser: sorted(byBrowser) };
}

// OpenAI embedding spend. Real token counts exist only from the day embedding_call events started
// being logged; earlier saved records that already hold a cached vector are priced as an estimate
// (about 1.2 tokens per character of the text that was embedded).
const TOKENS_PER_CHAR_ESTIMATE = 1.2;
function summarizeEmbedding(metas, usdPerMTok, history) {
  let tokens = 0;
  const bySource = { save: 0, ask: 0 };
  for (const m of metas || []) {
    if (typeof m.inputTokens === 'number') tokens += m.inputTokens;
    const src = m.source === 'ask' ? 'ask' : 'save';
    bySource[src] += 1;
  }
  const measuredUsd = (tokens / 1e6) * usdPerMTok;
  const h = history || { records: 0, chars: 0 };
  const estimatedTokens = Math.round((h.chars || 0) * TOKENS_PER_CHAR_ESTIMATE);
  const historyUsd = (estimatedTokens / 1e6) * usdPerMTok;
  return {
    callCount: (metas || []).length,
    tokens,
    bySource,
    measuredUsd: roundUsd(measuredUsd),
    historyRecords: h.records || 0,
    historyEstimatedTokens: estimatedTokens,
    historyEstimatedUsd: roundUsd(historyUsd),
    estimatedUsd: roundUsd(measuredUsd + historyUsd),
    usdPerMTok,
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
  SLOW_CALL_MS,
  latencySummary,
  fallbackSummary,
  summarizeAsk,
  askUsedEmbedding,
  summarizeEmbedding,
  summarizeTraffic,
  summarizeScreens,
  summarizeClientErrors,
  classifyLlmProvider,
  collectLlmByProvider,
  collectWhisperUsage,
  roundUsd,
};
