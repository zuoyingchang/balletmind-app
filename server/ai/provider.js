// Which LLM backend answers. Read at call time (not import time) so it can be
// switched with an environment variable and tested without reloading modules.
//   AI_PROVIDER=anthropic          (default) Anthropic Messages API, ANTHROPIC_API_KEY
//   AI_PROVIDER=openai-compatible  any /chat/completions API: DeepSeek, Qwen (DashScope),
//                                  Doubao (Volcano Ark), GLM, Kimi ...
//                                  needs AI_BASE_URL, AI_MODEL, AI_API_KEY
function providerName() {
  const p = String(process.env.AI_PROVIDER || 'anthropic').toLowerCase().replace(/_/g, '-');
  return p === 'openai-compatible' ? 'openai-compatible' : 'anthropic';
}

function aiConfigured() {
  if (providerName() === 'openai-compatible') {
    return Boolean(process.env.AI_API_KEY && process.env.AI_BASE_URL && process.env.AI_MODEL);
  }
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function missingConfigHint() {
  return providerName() === 'openai-compatible'
    ? 'AI_PROVIDER=openai-compatible needs AI_BASE_URL, AI_MODEL and AI_API_KEY'
    : 'ANTHROPIC_API_KEY is not set';
}

// Secondary provider: when the primary (an OpenAI-compatible model such as DeepSeek) fails in a way
// that another provider could fix, retry the same request on Anthropic. Only that direction is
// supported (compat primary -> Anthropic fallback). Off unless AI_FALLBACK_PROVIDER=anthropic and
// ANTHROPIC_API_KEY is set.
function fallbackProviderName() {
  if (providerName() !== 'openai-compatible') return null;
  if (String(process.env.AI_FALLBACK_PROVIDER || '').toLowerCase() !== 'anthropic') return null;
  return process.env.ANTHROPIC_API_KEY ? 'anthropic' : null;
}

// AI_MODEL belongs to the primary, so the fallback model is its own setting.
function fallbackModel() {
  return process.env.AI_FALLBACK_MODEL || 'claude-sonnet-5';
}

// Worth trying another provider: transport failures and account/capacity problems (bad key,
// no balance, rate limit, outage). A plain 400 means our request is wrong; a second provider
// would not fix that, so it is not retried elsewhere.
function isFallbackEligible(result) {
  if (result.error) return true;
  const s = result.response && result.response.status;
  return s === 401 || s === 402 || s === 403 || s === 429 || s >= 500;
}

const fallbackTimes = [];
function recordFallback() {
  fallbackTimes.push(Date.now());
  if (fallbackTimes.length > 500) fallbackTimes.shift();
}
function recentFallbackCount(windowMs = 30 * 60 * 1000) {
  const since = Date.now() - windowMs;
  return fallbackTimes.filter((t) => t >= since).length;
}

module.exports = {
  providerName, aiConfigured, missingConfigHint,
  fallbackProviderName, fallbackModel, isFallbackEligible, recordFallback, recentFallbackCount,
};
