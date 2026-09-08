const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { logEvent, countAiCallsToday } = require('../events');
const { DAILY_AI_LIMIT, MAX_TRANSCRIPT_LENGTH, AI_MODEL } = require('../config');
const { sessionIdFromReq, withSession } = require('../lib/text');
const { correctionsAsPromptHint } = require('../terms');
const { PROMPT_VERSION, SYSTEM_PROMPT, REVIEW_TOOL } = require('../ai/review-prompt');
const {
  callAnthropicOnce,
  callAnthropicWithRetry,
  findToolUse,
  reviewFromToolInput,
} = require('../ai/anthropic');

const router = express.Router();

function failMeta(req, extra) {
  return withSession({ promptVersion: PROMPT_VERSION, ...extra }, sessionIdFromReq(req));
}

router.post('/', requireAuth, async (req, res) => {
  const { transcript } = req.body || {};
  if (!transcript || !transcript.trim()) {
    return res.status(400).json({ error: '缺少语音转写内容' });
  }
  if (transcript.length > MAX_TRANSCRIPT_LENGTH) {
    return res.status(400).json({ error: `本次内容过长（超过${MAX_TRANSCRIPT_LENGTH}字），请分段录制` });
  }
  if ((await countAiCallsToday(req.userId)) >= DAILY_AI_LIMIT) {
    await logEvent(req.userId, 'ai_process_fail', failMeta(req, { reason: 'quota_exceeded' }));
    return res.status(429).json({ error: '今天的AI整理次数已经用完了，可以先手动记录内容，明天再生成复盘' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: '服务器未配置 ANTHROPIC_API_KEY，请检查 .env 文件' });
  }

  const startedAt = Date.now();
  try {
    const termHint = await correctionsAsPromptHint(req.userId);
    const { response, error, attempt } = await callAnthropicWithRetry(termHint, transcript);
    const latencyMs = Date.now() - startedAt;

    if (error) {
      const reason = error.message === 'timeout' ? 'timeout' : 'network_error';
      await logEvent(req.userId, 'ai_process_fail', failMeta(req, { reason, attempt, latencyMs }));
      const msg = reason === 'timeout' ? 'AI处理超时，请重新尝试' : 'AI服务连接失败，请重新尝试';
      return res.status(504).json({ error: msg });
    }

    if (!response.ok) {
      const errText = await response.text();
      await logEvent(req.userId, 'ai_process_fail', failMeta(req, { reason: 'api_error', status: response.status, attempt, latencyMs }));
      return res.status(502).json({ error: 'AI服务调用失败，请Retry', detail: errText });
    }

    const data = await response.json();
    const toolUse = findToolUse(data);
    if (!toolUse) {
      await logEvent(req.userId, 'ai_process_fail', failMeta(req, { reason: 'no_tool_use', attempt, latencyMs }));
      return res.status(502).json({ error: 'AI未返回有效内容' });
    }

    const input = toolUse.input || {};
    await logEvent(req.userId, 'ai_process_success', withSession({
      confidence_level: input.confidence_level,
      attempt,
      latencyMs,
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
      cacheReadTokens: data.usage?.cache_read_input_tokens,
      cacheCreationTokens: data.usage?.cache_creation_input_tokens,
      model: process.env.AI_MODEL || AI_MODEL,
      promptVersion: PROMPT_VERSION,
    }, sessionIdFromReq(req)));
    res.json(reviewFromToolInput(input));
  } catch (e) {
    await logEvent(req.userId, 'ai_process_fail', failMeta(req, {
      reason: 'exception',
      message: e.message,
      latencyMs: Date.now() - startedAt,
    }));
    res.status(500).json({ error: '服务器错误', detail: e.message });
  }
});

module.exports = router;
module.exports.SYSTEM_PROMPT = SYSTEM_PROMPT;
module.exports.REVIEW_TOOL = REVIEW_TOOL;
module.exports.callAnthropicOnce = callAnthropicOnce;
module.exports.PROMPT_VERSION = PROMPT_VERSION;
