// Manual, real-API check for the domestic ASR fallback — run this BEFORE setting ASR_FALLBACK_PROVIDER
// in production. It is the only way to confirm the TC3 signature is actually correct; the automated
// tests can only check the code's structure, not whether Tencent accepts it.
//
// Usage:
//   cd server
//   ASR_FALLBACK_SECRET_ID=... ASR_FALLBACK_SECRET_KEY=... node scripts/test-tencent-asr.js <path-to-audio-file>
//
// Record a few real seconds of yourself saying a couple of ballet terms first (a memo app,
// or a phone recording exported as .m4a/.mp3/.wav all work) — this only reports what Tencent
// actually transcribed, so a bad recording will just look like a bad result, not a code bug.
const fs = require('fs');
const path = require('path');
const { prepareForTencentAsr, contentTypeToExt } = require('../lib/audio-convert');
const { transcribeWithTencent } = require('../ai/asr-tencent');

const CONTENT_TYPE_BY_EXT = { webm: 'audio/webm', mp4: 'audio/mp4', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg' };

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/test-tencent-asr.js <path-to-audio-file>'); process.exit(1); }
  if (!process.env.ASR_FALLBACK_SECRET_ID || !process.env.ASR_FALLBACK_SECRET_KEY) {
    console.error('set ASR_FALLBACK_SECRET_ID and ASR_FALLBACK_SECRET_KEY first (see .env.example)');
    process.exit(1);
  }
  const ext = path.extname(file).slice(1).toLowerCase();
  const contentType = CONTENT_TYPE_BY_EXT[ext] || 'audio/webm';
  const raw = fs.readFileSync(file);
  console.log(`input: ${file} (${raw.length} bytes, treated as ${contentType})`);

  const { buffer, voiceFormat } = await prepareForTencentAsr(raw, contentType);
  console.log(`sending to Tencent as VoiceFormat=${voiceFormat}, ${buffer.length} bytes`);

  const started = Date.now();
  try {
    const { text } = await transcribeWithTencent(buffer, voiceFormat);
    console.log(`\nSUCCESS in ${Date.now() - started}ms`);
    console.log('transcribed text:', JSON.stringify(text));
    console.log('\nIf that text roughly matches what you said (including the ballet terms), the signature and');
    console.log('format handling are working. If it is empty or nonsense, check the engine (ASR_FALLBACK_ENGINE)');
    console.log('and try a clearer, longer recording before assuming the code is broken.');
  } catch (e) {
    console.error(`\nFAILED after ${Date.now() - started}ms:`, e.message);
    if (e.detail) console.error('detail:', e.detail);
    if (e.status) console.error('http status:', e.status);
    console.error('\nCommon causes: SecretId/SecretKey typo, ASR service not enabled on this Tencent Cloud');
    console.error('account, or the account has no balance. Check the Tencent Cloud console\'s ASR page.');
    process.exit(1);
  }
})();
