const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { logEvent, countAiCallsToday } = require('../events');
const { logUpstreamFailure, logQuota } = require('../lib/log');
const {
  DAILY_AI_LIMIT, OPENAI_API_KEY, ASR_MODEL, ASR_TIMEOUT_MS, MAX_AUDIO_BYTES,
} = require('../config');
const { WHISPER_PROMPT } = require('../ballet-glossary');
const { fetchWithTimeout, isAbortError } = require('../lib/fetch-timeout');
const { asrFallbackProviderName, recordAsrFallback } = require('../ai/asr-provider');
const { transcribeWithTencent } = require('../ai/asr-tencent');
const { prepareForTencentAsr } = require('../lib/audio-convert');
const { sessionIdFromReq, withSession } = require('../lib/text');

const router = express.Router();

function extensionFor(contentType) {
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  if (type.includes('webm')) return 'webm';
  if (type.includes('mp4') || type.includes('m4a')) return 'mp4';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('wav')) return 'wav';
  if (type.includes('ogg')) return 'ogg';
  return 'webm';
}

router.get('/status', requireAuth, (req, res) => {
  res.json({ configured: Boolean(OPENAI_API_KEY), model: OPENAI_API_KEY ? ASR_MODEL : null });
});

router.post('/', requireAuth, express.raw({ type: () => true, limit: '12mb' }), async (req, res) => {
  if (!OPENAI_API_KEY) {
    console.error('[ALERT][config] OPENAI_API_KEY is not set');
    return res.status(503).json({ error: '语音识别暂时不可用，请手动输入复盘内容' });
  }
  const audio = req.body;
  if (!Buffer.isBuffer(audio) || audio.length === 0) {
    return res.status(400).json({ error: '没有收到录音' });
  }
  if (audio.length > MAX_AUDIO_BYTES) {
    return res.status(400).json({ error: '这段录音太长了，请录短一点再试' });
  }
  if ((await countAiCallsToday(req.userId)) >= DAILY_AI_LIMIT) {
    logQuota('transcribe blocked', req.userId);
    await logEvent(req.userId, 'asr_fail', withSession({ reason: 'quota_exceeded', model: ASR_MODEL }, sessionIdFromReq(req)));
    return res.status(429).json({ error: '今天的AI次数已经用完了，可以先手动记录内容' });
  }

  const durationHeader = Number(req.headers['x-audio-duration-sec']);
  const durationSec = Number.isFinite(durationHeader) && durationHeader > 0
    ? Math.min(durationHeader, 180)
    : undefined;
  const contentType = req.headers['content-type'] || 'audio/webm';
  const ext = extensionFor(contentType);
  const startedAt = Date.now();

  const form = new FormData();
  form.append('file', new Blob([audio], { type: contentType.split(';')[0] }), `clip.${ext}`);
  form.append('model', ASR_MODEL);
  form.append('prompt', WHISPER_PROMPT);
  form.append('response_format', 'json');

  try {
    const callWhisper = () => fetchWithTimeout('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    }, ASR_TIMEOUT_MS);
    let response;
    try {
      response = await callWhisper();
      if (response.status >= 500 || response.status === 429) {
        await new Promise((r) => setTimeout(r, 500));
        response = await callWhisper();
      }
    } catch (firstErr) {
      if (isAbortError(firstErr)) throw firstErr; // a timeout already cost ASR_TIMEOUT_MS; do not double the wait
      await new Promise((r) => setTimeout(r, 500));
      response = await callWhisper();
    }
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      const detail = await response.text();
      logUpstreamFailure('openai/whisper', response.status, detail);
      const fell = await tryTencentFallback(req, audio, contentType, startedAt, durationSec);
      if (fell) return res.json(fell);
      await logEvent(req.userId, 'asr_fail', withSession({ reason: 'api_error', status: response.status, latencyMs, model: ASR_MODEL }, sessionIdFromReq(req)));
      return res.status(502).json({ error: '语音识别失败，请重试或改用手动输入' });
    }
    const data = await response.json();
    const text = (data.text || '').trim();
    await logEvent(req.userId, 'asr_success', withSession({
      latencyMs,
      model: ASR_MODEL,
      chars: text.length,
      bytes: audio.length,
      ...(durationSec ? { durationSec } : {}),
    }, sessionIdFromReq(req)));
    res.json({ text, model: ASR_MODEL });
  } catch (e) {
    const timedOut = isAbortError(e);
    console.error(`[whisper] ${timedOut ? 'timeout' : 'exception'}`, timedOut ? '' : e);
    const fell = await tryTencentFallback(req, audio, contentType, startedAt, durationSec);
    if (fell) return res.json(fell);
    await logEvent(req.userId, 'asr_fail', withSession({
      reason: timedOut ? 'timeout' : 'exception',
      error: timedOut ? 'timeout' : 'exception',
      latencyMs: Date.now() - startedAt,
      model: ASR_MODEL,
    }, sessionIdFromReq(req)));
    const msg = timedOut ? '语音识别超时，请重试或改用手动输入' : '语音识别失败，请重试或改用手动输入';
    res.status(timedOut ? 504 : 500).json({ error: msg });
  }
});


// Whisper failed (any reason). If a domestic fallback is configured, remux the same audio and try
// once on Tencent Cloud. Returns the response payload on success, or null to fall through to the
// normal Whisper failure handling (which logs asr_fail and answers with the neutral error message).
async function tryTencentFallback(req, audio, contentType, startedAt, durationSec) {
  const fallback = asrFallbackProviderName();
  if (!fallback) return null;
  try {
    const { buffer, voiceFormat } = await prepareForTencentAsr(audio, contentType);
    const { text } = await transcribeWithTencent(buffer, voiceFormat);
    recordAsrFallback();
    const latencyMs = Date.now() - startedAt;
    console.error(`[ALERT][fallback] Whisper failed; transcribed via Tencent instead (${latencyMs}ms)`);
    await logEvent(req.userId, 'asr_success', withSession({
      latencyMs, model: 'tencent-sentence-recognition', chars: text.length, bytes: audio.length, fellBack: true,
      ...(durationSec ? { durationSec } : {}),
    }, sessionIdFromReq(req)));
    return { text, model: 'tencent-sentence-recognition' };
  } catch (e) {
    console.error('[ALERT][fallback] Tencent ASR fallback also failed:', e.message, e.detail ? String(e.detail).slice(0, 300) : '');
    return null;
  }
}

module.exports = router;
