// Adapter for OpenAI-style /chat/completions providers. Callers elsewhere in the app
// speak Anthropic's shape (tool_use blocks, usage.input_tokens); this file translates the
// request out and the response back, so nothing else has to know which provider is in use.
const { AI_MAX_OUTPUT_TOKENS, AI_TIMEOUT_MS, AI_TEMPERATURE } = require('../config');
const { fetchWithTimeout } = require('../lib/fetch-timeout');

function toOpenAITools(tools) {
  return (tools || []).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
  }));
}

// Some providers cannot force a *named* function. AI_FORCED_TOOL_CHOICE=required makes a
// forced call with a single tool use "required" instead, which is equivalent when there is one tool.
function toToolChoice(toolChoice, tools) {
  if (!toolChoice || toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'tool') {
    if ((process.env.AI_FORCED_TOOL_CHOICE || 'named') === 'required' && (tools || []).length === 1) return 'required';
    return { type: 'function', function: { name: toolChoice.name } };
  }
  return 'auto';
}

function toOpenAIMessages(systemText, messages) {
  const out = [{ role: 'system', content: systemText }];
  for (const m of messages || []) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      }));
      const msg = { role: 'assistant', content: text || null };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
    } else {
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) });
        } else if (b.type === 'text') {
          out.push({ role: 'user', content: b.text });
        }
      }
    }
  }
  return out;
}

function parseJsonObject(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const v = JSON.parse(cleaned);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (e) {
    return null;
  }
}

function fromOpenAIResponse(data, forcedToolName) {
  const choice = (data.choices || [])[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (typeof msg.content === 'string' && msg.content.trim()) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch (e) { input = {}; }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function && tc.function.name, input });
  }
  // A model that ignored the forced tool but answered with the right JSON in plain text:
  // accept it, otherwise a whole request would fail on formatting alone.
  if (forcedToolName && !content.some((b) => b.type === 'tool_use')) {
    const salvaged = parseJsonObject(msg.content);
    if (salvaged) content.push({ type: 'tool_use', id: 'salvaged_json', name: forcedToolName, input: salvaged });
  }
  const u = data.usage || {};
  const cached = u.prompt_cache_hit_tokens ?? (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ?? 0;
  return {
    id: data.id,
    type: 'message',
    role: 'assistant',
    model: data.model,
    content,
    stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
    usage: {
      input_tokens: Math.max(0, (u.prompt_tokens || 0) - cached),
      output_tokens: u.completion_tokens || 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    },
  };
}

async function callOpenAICompatible(systemPrompt, tools, toolChoice, messages, termHint) {
  const base = String(process.env.AI_BASE_URL || '').replace(/\/+$/, '');
  const systemText = termHint ? `${systemPrompt}\n\n${termHint}` : systemPrompt;
  const body = {
    model: process.env.AI_MODEL,
    max_tokens: AI_MAX_OUTPUT_TOKENS,
    temperature: AI_TEMPERATURE,
    messages: toOpenAIMessages(systemText, messages),
  };
  if (tools && tools.length) {
    body.tools = toOpenAITools(tools);
    body.tool_choice = toToolChoice(toolChoice, tools);
  }
  const res = await fetchWithTimeout(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AI_API_KEY}` },
    body: JSON.stringify(body),
  }, AI_TIMEOUT_MS);
  if (!res.ok) return res; // callers only read ok / status / text() / headers on failures
  const normalized = fromOpenAIResponse(await res.json(), toolChoice && toolChoice.type === 'tool' ? toolChoice.name : null);
  return { ok: true, status: res.status, headers: res.headers, text: async () => JSON.stringify(normalized), json: async () => normalized };
}

module.exports = { callOpenAICompatible, toOpenAIMessages, toOpenAITools, toToolChoice, fromOpenAIResponse };
