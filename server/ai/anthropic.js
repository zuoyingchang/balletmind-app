const { AI_MODEL, AI_MAX_OUTPUT_TOKENS, AI_TIMEOUT_MS, AI_PRIMARY_TIMEOUT_MS, AI_TEMPERATURE } = require('../config');
const { fetchWithTimeout, isAbortError } = require('../lib/fetch-timeout');
const { providerName, fallbackProviderName, fallbackModel, isFallbackEligible, recordFallback } = require('./provider');
const { callOpenAICompatible } = require('./openai-compat');
const { joinLines, compactReviewField, uniqueCompactGoodPoints } = require('../lib/text');
const { SYSTEM_PROMPT, REVIEW_TOOL } = require('./review-prompt');
const {
  SYSTEM_PROMPT_ASK, SEARCH_RECORDS_TOOL, ASK_TOOL, userAskMessage, recordsBlock,
} = require('./ask-prompt');

function userTranscriptMessage(transcript) {
  return `请整理下面 <transcript> 标签内的语音转写内容：\n<transcript>\n${transcript}\n</transcript>`;
}

function systemBlocks(systemPrompt, termHint) {
  const blocks = [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
  if (termHint) blocks.push({ type: 'text', text: termHint });
  return blocks;
}

function modelRejectsTemperature(model) {
  return /^claude-(sonnet-5|opus-5|fable-5)/.test(model);
}

// Lowest-level call: explicit messages array, explicit tool list/choice.
// Everything else (review extraction, single-shot ask, the ask-agent's two
// rounds) is a thin wrapper over this one HTTP shape. timeoutMs defaults to
// the full AI_TIMEOUT_MS -- only primaryWithRetry (when a fallback exists)
// ever passes a shorter one.
async function callAnthropicMessagesOnce(systemPrompt, tools, toolChoice, messages, termHint, timeoutMs) {
  if (providerName() === 'openai-compatible') {
    return callOpenAICompatible(systemPrompt, tools, toolChoice, messages, termHint, timeoutMs);
  }
  return callAnthropicNative(systemPrompt, tools, toolChoice, messages, termHint, process.env.AI_MODEL || AI_MODEL, timeoutMs);
}

async function callAnthropicNative(systemPrompt, tools, toolChoice, messages, termHint, model, timeoutMs) {
  const body = {
    model,
    max_tokens: AI_MAX_OUTPUT_TOKENS,
    system: systemBlocks(systemPrompt, termHint),
    messages,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }
  // Sonnet 5 / Opus 5 / Fable 5 reject `temperature` (invalid_request_error).
  if (!modelRejectsTemperature(model)) body.temperature = AI_TEMPERATURE;
  return fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  }, timeoutMs || AI_TIMEOUT_MS);
}

// One retry on timeout, network error, 5xx, or 429 (rate limited). Other 4xx are not retried.
// With a fallback provider configured, a timeout skips the retry (another full wait would only make
// the user wait longer) and goes straight to the fallback -- and the first attempt itself only gets
// AI_PRIMARY_TIMEOUT_MS (can be shorter than AI_TIMEOUT_MS), so a flaky primary hands off sooner
// instead of making the user sit through the full timeout before the fallback even starts.
async function primaryWithRetry(systemPrompt, tools, toolChoice, messages, termHint, hasFallback) {
  const timeoutMs = hasFallback ? AI_PRIMARY_TIMEOUT_MS : AI_TIMEOUT_MS;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await callAnthropicMessagesOnce(systemPrompt, tools, toolChoice, messages, termHint, timeoutMs);
      const retryable = response.status >= 500 || response.status === 429;
      if (response.ok || !retryable) return { response, attempt };
      if (attempt === 2) return { response, attempt };
      const wait = Number(response.headers.get('retry-after')) * 1000;
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, Math.min(wait, 3000)));
        continue;
      }
    } catch (e) {
      const timedOut = isAbortError(e);
      if (attempt === 2 || (timedOut && hasFallback)) {
        return { error: timedOut ? new Error('timeout') : e, attempt };
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function callAnthropicMessagesWithRetry(systemPrompt, tools, toolChoice, messages, termHint) {
  const fallback = fallbackProviderName();
  const primary = await primaryWithRetry(systemPrompt, tools, toolChoice, messages, termHint, Boolean(fallback));
  if (!fallback || primary.response?.ok || !isFallbackEligible(primary)) return primary;

  const why = primary.error ? `error=${primary.error.message}` : `status=${primary.response.status}`;
  recordFallback();
  console.error(`[ALERT][fallback] primary provider failed (${why}); retrying on ${fallback} (${fallbackModel()})`);
  try {
    const response = await callAnthropicNative(systemPrompt, tools, toolChoice, messages, termHint, fallbackModel());
    return { response, attempt: primary.attempt, fellBack: true };
  } catch (e) {
    return { error: isAbortError(e) ? new Error('timeout') : e, attempt: primary.attempt, fellBack: true };
  }
}

function callAnthropicToolWithRetry(systemPrompt, tool, userMessage, termHint) {
  return callAnthropicMessagesWithRetry(
    systemPrompt, [tool], { type: 'tool', name: tool.name },
    [{ role: 'user', content: userMessage }], termHint
  );
}

async function callAnthropicOnce(termHint, transcript) {
  return callAnthropicMessagesOnce(
    SYSTEM_PROMPT, [REVIEW_TOOL], { type: 'tool', name: REVIEW_TOOL.name },
    [{ role: 'user', content: userTranscriptMessage(transcript) }], termHint
  );
}

async function callAnthropicWithRetry(termHint, transcript) {
  return callAnthropicToolWithRetry(SYSTEM_PROMPT, REVIEW_TOOL, userTranscriptMessage(transcript), termHint);
}

// Round 1 of ask-your-archive: model sees the first (free, keyword-search)
// batch of records and picks between answering now or asking for one more
// search. tool_choice is 'auto', not forced — this is the one place any
// model autonomy lives in this feature.
async function callAskRound1WithRetry(question, records, dateRangeLabel, todayLabel) {
  const messages = [{ role: 'user', content: userAskMessage(question, records, dateRangeLabel, todayLabel) }];
  const { response, error, attempt } = await callAnthropicMessagesWithRetry(
    SYSTEM_PROMPT_ASK, [SEARCH_RECORDS_TOOL, ASK_TOOL], { type: 'auto' }, messages
  );
  return { response, error, attempt, messages };
}

// Round 2: only reached if round 1 asked for search_records. tool_choice is
// forced back to submit_answer so this is structurally incapable of asking
// for a third round — the loop cannot run away.
async function callAskRound2WithRetry(round1Messages, searchToolUse, secondBatchRecords) {
  const messages = [
    ...round1Messages,
    { role: 'assistant', content: [{ type: 'tool_use', id: searchToolUse.id, name: searchToolUse.name, input: searchToolUse.input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: searchToolUse.id, content: recordsBlock(secondBatchRecords) }] },
  ];
  const { response, error, attempt } = await callAnthropicMessagesWithRetry(
    SYSTEM_PROMPT_ASK, [ASK_TOOL], { type: 'tool', name: ASK_TOOL.name }, messages
  );
  return { response, error, attempt };
}

function findToolUse(data, name) {
  const blocks = (data.content || []).filter((block) => block.type === 'tool_use');
  return name ? blocks.find((b) => b.name === name) : blocks[0];
}

function reviewFromToolInput(input = {}) {
  const tips = Array.isArray(input.session_tips) ? input.session_tips.slice(0, 3) : input.session_tips;
  const improveSrc = []
    .concat(input.improve_points || [])
    .concat(input.next_time_reminder || []);
  return {
    good_points: compactReviewField(input.good_points),
    improve_points: compactReviewField(improveSrc),
    next_time_reminder: '',
    session_tips: joinLines(tips),
    confidence_level: input.confidence_level || '',
    note: input.note || '',
  };
}

function answerFromToolInput(input = {}) {
  return {
    answered: !!input.answered,
    answerPoints: Array.isArray(input.answer_points)
      ? uniqueCompactGoodPoints(input.answer_points.map((s) => String(s).trim()).filter(Boolean).map(stripAskRecordId))
      : [],
    citedRecordIds: Array.isArray(input.cited_record_ids) ? input.cited_record_ids.filter((n) => Number.isInteger(n)) : [],
  };
}

function stripAskRecordId(s) {
  return String(s || '')
    .replace(/记录\s*\d+\s*[（(]/g, '（')
    .replace(/记录\s*\d+\s*/g, '')
    .replace(/^：/, '')
    .trim();
}

module.exports = {
  callAnthropicOnce,
  callAnthropicWithRetry,
  callAnthropicMessagesWithRetry,
  callAskRound1WithRetry,
  callAskRound2WithRetry,
  findToolUse,
  reviewFromToolInput,
  answerFromToolInput,
};
