const { AI_MODEL, AI_MAX_OUTPUT_TOKENS, AI_TIMEOUT_MS, AI_TEMPERATURE } = require('../config');
const { fetchWithTimeout, isAbortError } = require('../lib/fetch-timeout');
const { joinLines } = require('../lib/text');
const { SYSTEM_PROMPT, REVIEW_TOOL } = require('./review-prompt');

function userTranscriptMessage(transcript) {
  return `请整理下面 <transcript> 标签内的语音转写内容：\n<transcript>\n${transcript}\n</transcript>`;
}

function systemBlocks(termHint) {
  const blocks = [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
  if (termHint) blocks.push({ type: 'text', text: termHint });
  return blocks;
}

async function callAnthropicOnce(termHint, transcript) {
  return fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: AI_MAX_OUTPUT_TOKENS,
      temperature: AI_TEMPERATURE,
      system: systemBlocks(termHint),
      messages: [{ role: 'user', content: userTranscriptMessage(transcript) }],
      tools: [REVIEW_TOOL],
      tool_choice: { type: 'tool', name: 'submit_review' },
    }),
  }, AI_TIMEOUT_MS);
}

// One retry on timeout, network error, or 5xx. 4xx is not retried.
async function callAnthropicWithRetry(termHint, transcript) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await callAnthropicOnce(termHint, transcript);
      if (response.ok || response.status < 500) return { response, attempt };
      if (attempt === 2) return { response, attempt };
    } catch (e) {
      if (attempt === 2) {
        return { error: isAbortError(e) ? new Error('timeout') : e, attempt };
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

function findToolUse(data) {
  return (data.content || []).find((block) => block.type === 'tool_use');
}

function reviewFromToolInput(input = {}) {
  return {
    good_points: joinLines(input.good_points),
    improve_points: joinLines(input.improve_points),
    next_time_reminder: joinLines(input.next_time_reminder),
    confidence_level: input.confidence_level || '',
    note: input.note || '',
  };
}

module.exports = {
  callAnthropicOnce,
  callAnthropicWithRetry,
  findToolUse,
  reviewFromToolInput,
};
