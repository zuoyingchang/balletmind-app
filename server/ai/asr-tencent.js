// Tencent Cloud "一句话识别" (SentenceRecognition, synchronous, <=60s audio) — asr.tencentcloudapi.com.
// Implements Tencent Cloud API 3.0's common TC3-HMAC-SHA256 signing scheme, used by all their
// services (this file only calls the one ASR action, but the signer itself is generic).
//
// NOT YET VERIFIED AGAINST THE REAL API. The signing algorithm here follows Tencent's published spec,
// but has only been checked structurally (see test/asr-tencent.test.js) — there is no way to confirm the
// signature bytes are byte-for-byte correct without real credentials. Before enabling ASR_FALLBACK_PROVIDER
// in production, run `node scripts/test-tencent-asr.js <path-to-a-short-webm-or-wav-file>` locally with
// real keys and confirm it returns real transcribed text.
const crypto = require('crypto');
const { fetchWithTimeout, isAbortError } = require('../lib/fetch-timeout');

const SERVICE = 'asr';
const HOST = 'asr.tencentcloudapi.com';
const ACTION = 'SentenceRecognition';
const API_VERSION = '2019-06-14';
const TIMEOUT_MS = Number(process.env.ASR_FALLBACK_TIMEOUT_MS) || 15000;

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

// Tencent Cloud API 3.0 signature (TC3-HMAC-SHA256). Reference: Tencent Cloud "公共参数" / "签名方法 v3" docs.
function signRequest({ secretId, secretKey, timestamp, payload }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10); // UTC date, as required
  const canonicalHeaders = `content-type:application/json\nhost:${HOST}\nx-tc-action:${ACTION.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const hashedPayload = sha256Hex(payload);
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join('\n');

  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, SERVICE);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, date };
}

// EngSerViceType: engine per Tencent's docs, e.g. '16k_zh' (Mandarin, 16kHz) or '16k_zh-PY' (Mandarin
// with English mixed in — closer to how a ballet class actually sounds). Overridable via env because
// which one transcribes mixed Chinese/French/English ballet terms best has NOT been evaluated yet.
function buildPayload(audioBase64, voiceFormat) {
  return JSON.stringify({
    EngSerViceType: process.env.ASR_FALLBACK_ENGINE || '16k_zh-PY',
    SourceType: 1, // 1 = raw audio bytes in `Data`, not a URL
    VoiceFormat: voiceFormat,
    Data: audioBase64,
    ...(process.env.ASR_FALLBACK_HOTWORD_ID ? { HotwordId: process.env.ASR_FALLBACK_HOTWORD_ID } : {}),
  });
}

/**
 * @param {Buffer} audioBuffer already remuxed into a Tencent-accepted container (see lib/audio-convert.js)
 * @param {string} voiceFormat one of 'wav' | 'mp3' | 'm4a' | 'ogg-opus' (Tencent's field, not a MIME type)
 */
async function transcribeWithTencent(audioBuffer, voiceFormat) {
  const secretId = process.env.ASR_FALLBACK_SECRET_ID;
  const secretKey = process.env.ASR_FALLBACK_SECRET_KEY;
  const region = process.env.ASR_FALLBACK_REGION || 'ap-guangzhou';
  if (!secretId || !secretKey) throw new Error('tencent_asr_not_configured');

  const timestamp = Math.floor(Date.now() / 1000);
  const payload = buildPayload(audioBuffer.toString('base64'), voiceFormat);
  const { authorization, date } = signRequest({ secretId, secretKey, timestamp, payload });

  const response = await fetchWithTimeout(`https://${HOST}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Host: HOST,
      'X-TC-Action': ACTION,
      'X-TC-Version': API_VERSION,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Region': region,
      'X-TC-Date': date,
      Authorization: authorization,
    },
    body: payload,
  }, TIMEOUT_MS);

  if (!response.ok) {
    const detail = await response.text();
    const err = new Error(`tencent_asr_http_${response.status}`);
    err.status = response.status;
    err.detail = detail;
    throw err;
  }
  const data = await response.json();
  // Tencent returns 200 even for API-level errors; the real error lives in Response.Error.
  if (data.Response && data.Response.Error) {
    const err = new Error(`tencent_asr_api_${data.Response.Error.Code}`);
    err.detail = data.Response.Error.Message;
    err.requestId = data.Response.RequestId;
    throw err;
  }
  return { text: (data.Response && data.Response.Result) || '' };
}

module.exports = { transcribeWithTencent, signRequest, buildPayload, isAbortError };
