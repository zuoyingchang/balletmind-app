const { AI_MODEL } = require('../config');
const { providerName, fallbackModel } = require('../ai/provider');

function primaryProviderLabel() {
  if (providerName() === 'openai-compatible') return 'deepseek';
  return 'anthropic';
}

function llmUsageMeta({ data, attempt, fellBack, extra }) {
  const usedFallback = Boolean(fellBack);
  return {
    provider: usedFallback ? 'anthropic' : primaryProviderLabel(),
    model: usedFallback ? fallbackModel() : (process.env.AI_MODEL || AI_MODEL),
    fellBack: usedFallback,
    attempt,
    inputTokens: data && data.usage ? data.usage.input_tokens : undefined,
    outputTokens: data && data.usage ? data.usage.output_tokens : undefined,
    cacheReadTokens: data && data.usage ? data.usage.cache_read_input_tokens : undefined,
    cacheCreationTokens: data && data.usage ? data.usage.cache_creation_input_tokens : undefined,
    ...(extra || {}),
  };
}

module.exports = { llmUsageMeta, primaryProviderLabel };
