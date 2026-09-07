const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { logEvent, countAiCallsToday } = require('../events');
const {
  DAILY_AI_LIMIT, OPENAI_API_KEY, ASR_MODEL, ASR_TIMEOUT_MS, MAX_AUDIO_BYTES,
} = require('../config');
const { WHISPER_PROMPT } = require('../ballet-glossary');
const { fetchWithTimeout, isAbortError } = require('../lib/fetch-timeout');

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
    return res.status(503).json({ error: '服务器未配置语音识别（OPENAI_API_KEY），请手动输入复盘内容' });
  }
  const audio = req.body;
  if (!Buffer.isBuffer(audio) || audio.length === 0) {
    return res.status(400).json({ error: '没有收到录音' });
  }
  if (audio.length > MAX_AUDIO_BYTES) {
    return res.status(400).json({ error: '这段录音太长了，请录短一点再试' });
  }
  if ((await countAiCallsToday(req.userId)) >= DAILY_AI_LIMIT) {
    await logEvent(req.userId, 'asr_fail', { reason: 'quota_exceeded', model: ASR_MODEL });
    return res.status(429).json({ error: '今天的AI次数已经用完了，可以先手动记录内容' });
  }

  const contentType = req.headers['content-type'] || 'audio/webm';
  const ext = extensionFor(contentType);
  const startedAt = Date.now();

  const form = new FormData();
  form.append('file', new Blob([audio], { type: contentType.split(';')[0] }), `clip.${ext}`);
  form.append('model', ASR_MODEL);
  form.append('prompt', WHISPER_PROMPT);
  form.append('response_format', 'json');

  try {
    const response = await fetchWithTimeout('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    }, ASR_TIMEOUT_MS);
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      const detail = await response.text();
      await logEvent(req.userId, 'asr_fail', { reason: 'api_error', status: response.status, latencyMs, model: ASR_MODEL });
      return res.status(502).json({ error: '语音识别失败，请重试或改用手动输入', detail });
    }
    const data = await response.json();
    const text = (data.text || '').trim();
    await logEvent(req.userId, 'asr_success', {
      latencyMs,
      model: ASR_MODEL,
      chars: text.length,
      bytes: audio.length,
    });
    res.json({ text, model: ASR_MODEL });
  } catch (e) {
    const timedOut = isAbortError(e);
    await logEvent(req.userId, 'asr_fail', {
      reason: timedOut ? 'timeout' : 'exception',
      message: e.message,
      latencyMs: Date.now() - startedAt,
      model: ASR_MODEL,
    });
    const msg = timedOut ? '语音识别超时，请重试或改用手动输入' : '语音识别失败，请重试或改用手动输入';
    res.status(timedOut ? 504 : 500).json({ error: msg });
  }
});

module.exports = router;
