const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  guestIdentity, guestIpLimiter, guestSiteBudget, tagActor, GUEST_QUOTA_MESSAGE,
} = require('../middleware/guest');
const {
  logEvent, countAiCallsToday, countAiRecapsToday, countGuestRecapsToday,
} = require('../events');
const { logUpstreamFailure, logQuota } = require('../lib/log');
const { aiConfigured, missingConfigHint } = require('../ai/provider');
const {
  dailyAiLimitFor, dailyRecapLimitFor, MAX_TRANSCRIPT_LENGTH,
  GUEST_RECAPS_PER_DAY, GUEST_MAX_TRANSCRIPT_LENGTH,
} = require('../config');
const { llmUsageMeta } = require('../lib/llm-event-meta');
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

function inputFrom(req) {
  const from = req.body && req.body.from;
  return (from === 'voice' || from === 'typed' || from === 'mixed') ? from : undefined;
}

function failMeta(req, extra) {
  const from = inputFrom(req);
  return tagActor(req, withSession({ promptVersion: PROMPT_VERSION, ...(from ? { from } : {}), ...extra }, sessionIdFromReq(req)));
}

router.post('/', requireAuth, generate);
router.post('/guest', guestIdentity, guestIpLimiter, guestSiteBudget, generate);

async function generate(req, res) {
  const { transcript } = req.body || {};
  if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
    return res.status(400).json({ error: '缺少语音转写内容' });
  }
  const maxLength = req.guestVid ? GUEST_MAX_TRANSCRIPT_LENGTH : MAX_TRANSCRIPT_LENGTH;
  if (transcript.length > maxLength) {
    return res.status(400).json({ error: `本次内容过长（超过${maxLength}字），请分段录制` });
  }
  if (req.guestVid) {
    if ((await countGuestRecapsToday(req.guestVid)) >= GUEST_RECAPS_PER_DAY) {
      logQuota('guest generate blocked', req.guestVid);
      return res.status(429).json({ error: GUEST_QUOTA_MESSAGE, code: 'guest_quota' });
    }
  } else if ((await countAiRecapsToday(req.userId)) >= dailyRecapLimitFor(req.userId)) {
    logQuota('generate blocked (daily recap)', req.userId);
    await logEvent(req.userId, 'ai_process_fail', failMeta(req, { reason: 'daily_recap_quota_exceeded', chars: transcript.length }));
    return res.status(429).json({ error: '今天的AI复盘额度用完了，可以直接手动记，明天再用AI整理', code: 'daily_recap_quota' });
  }
  if (!req.guestVid && (await countAiCallsToday(req.userId)) >= dailyAiLimitFor(req.userId)) {
    logQuota('generate blocked', req.userId);
    await logEvent(req.userId, 'ai_process_fail', failMeta(req, { reason: 'quota_exceeded', chars: transcript.length }));
    return res.status(429).json({ error: '今天的AI整理次数已经用完了，可以先手动记录内容，明天再生成复盘' });
  }
  if (!aiConfigured()) {
    console.error(`[ALERT][config] ${missingConfigHint()}`);
    return res.status(500).json({ error: 'AI服务暂时不可用，可以先手动记录内容' });
  }

  const startedAt = Date.now();
  try {
    const termHint = req.guestVid ? '' : await correctionsAsPromptHint(req.userId);
    const { response, error, attempt, fellBack } = await callAnthropicWithRetry(termHint, transcript);
    const latencyMs = Date.now() - startedAt;

    if (error) {
      const reason = error.message === 'timeout' ? 'timeout' : 'network_error';
      console.error(`[anthropic] generate ${reason} after ${attempt} attempt(s), ${latencyMs}ms`, error.message);
      await logEvent(req.userId, 'ai_process_fail', failMeta(req, { reason, attempt, latencyMs, chars: transcript.length }));
      const msg = reason === 'timeout' ? 'AI处理超时，请重新尝试' : 'AI服务连接失败，请重新尝试';
      return res.status(504).json({ error: msg });
    }

    if (!response.ok) {
      const errText = await response.text();
      logUpstreamFailure('anthropic/generate', response.status, errText);
      await logEvent(req.userId, 'ai_process_fail', failMeta(req, { reason: 'api_error', status: response.status, attempt, latencyMs, chars: transcript.length }));
      return res.status(502).json({ error: 'AI服务暂时不可用，请稍后重试，或先手动记录' });
    }

    const data = await response.json();
    const toolUse = findToolUse(data);
    if (!toolUse) {
      await logEvent(req.userId, 'ai_process_fail', failMeta(req, { reason: 'no_tool_use', attempt, latencyMs, chars: transcript.length }));
      return res.status(502).json({ error: 'AI未返回有效内容' });
    }

    const input = toolUse.input || {};
    await logEvent(req.userId, 'ai_process_success', tagActor(req, withSession(llmUsageMeta({
      data,
      attempt,
      fellBack,
      extra: {
        confidence_level: input.confidence_level,
        latencyMs,
        chars: transcript.length,
        from: inputFrom(req),
        promptVersion: PROMPT_VERSION,
      },
    }), sessionIdFromReq(req))));
    res.json(reviewFromToolInput(input));
  } catch (e) {
    await logEvent(req.userId, 'ai_process_fail', failMeta(req, {
      reason: 'exception',
      error: 'exception',
      latencyMs: Date.now() - startedAt,
      chars: transcript.length,
    }));
    console.error('[generate] exception', e);
    res.status(500).json({ error: '服务器错误，请稍后重试' });
  }
}

module.exports = router;
module.exports.SYSTEM_PROMPT = SYSTEM_PROMPT;
module.exports.REVIEW_TOOL = REVIEW_TOOL;
module.exports.callAnthropicOnce = callAnthropicOnce;
module.exports.PROMPT_VERSION = PROMPT_VERSION;
