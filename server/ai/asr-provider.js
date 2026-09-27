// Whisper (OpenAI) is always the primary transcriber. This only decides whether a domestic ASR
// fallback is configured, mirroring ai/provider.js's LLM fallback but for voice.
function asrFallbackProviderName() {
  if (String(process.env.ASR_FALLBACK_PROVIDER || '').toLowerCase() !== 'tencent') return null;
  return (process.env.ASR_FALLBACK_SECRET_ID && process.env.ASR_FALLBACK_SECRET_KEY) ? 'tencent' : null;
}

const fallbackTimes = [];
function recordAsrFallback() {
  fallbackTimes.push(Date.now());
  if (fallbackTimes.length > 500) fallbackTimes.shift();
}
function recentAsrFallbackCount(windowMs = 30 * 60 * 1000) {
  const since = Date.now() - windowMs;
  return fallbackTimes.filter((t) => t >= since).length;
}

module.exports = { asrFallbackProviderName, recordAsrFallback, recentAsrFallbackCount };
