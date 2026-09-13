const { AI_MODEL, AI_MAX_OUTPUT_TOKENS, AI_TIMEOUT_MS, AI_TEMPERATURE } = require('../config');
const { fetchWithTimeout, isAbortError } = require('../lib/fetch-timeout');
const { joinLines } = require('../lib/text');
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
// rounds) is a thin wrapper over this one HTTP shape.
async function callAnthropicMessagesOnce(systemPrompt, tools, toolChoice, messages, termHint) {
  const model = process.env.AI_MODEL || AI_MODEL;
  const body = {
    model,
    max_tokens: AI_MAX_OUTPUT_TOKENS,
    system: systemBlocks(systemPrompt, termHint),
    messages,
    tools,
    tool_choice: toolChoice,
  };
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
  }, AI_TIMEOUT_MS);
}

// One retry on timeout, network error, or 5xx. 4xx is not retried.
async function callAnthropicMessagesWithRetry(systemPrompt, tools, toolChoice, messages, termHint) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await callAnthropicMessagesOnce(systemPrompt, tools, toolChoice, messages, termHint);
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
  return {
    good_points: joinLines(input.good_points),
    improve_points: joinLines(input.improve_points),
    next_time_reminder: joinLines(input.next_time_reminder),
    session_tips: joinLines(tips),
    confidence_level: input.confidence_level || '',
    note: input.note || '',
  };
}

function answerFromToolInput(input = {}) {
  return {
    answered: !!input.answered,
    answer: input.answer || '',
    citedRecordIds: Array.isArray(input.cited_record_ids) ? input.cited_record_ids.filter((n) => Number.isInteger(n)) : [],
  };
}

module.exports = {
  callAnthropicOnce,
  callAnthropicWithRetry,
  callAskRound1WithRetry,
  callAskRound2WithRetry,
  findToolUse,
  reviewFromToolInput,
  answerFromToolInput,
};
