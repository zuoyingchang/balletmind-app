// Compares whisper-1 vs gpt-4o-mini-transcribe on the SAME real recording, side by side.
// Local only — does not touch Render or any real user.
//
// Usage:
//   cd server
//   node scripts/compare-asr-models.js <path-to-audio-file>
//
// Record yourself saying something like a real post-class recap, on purpose including terms
// that are easy to mis-hear (see server/eval/cases.js for real mis-transcription examples):
//   "今天练了plié，重心不稳，老师说tendu要绷直，转圈pirouette有点晃，
//    grand battement踢腿高度不够，下次注意spotting。"
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { WHISPER_PROMPT } = require('../ballet-glossary');

const CONTENT_TYPE_BY_EXT = { webm: 'audio/webm', mp4: 'audio/mp4', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg' };

async function transcribe(model, buffer, contentType, filename) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType }), filename);
  form.append('model', model);
  form.append('prompt', WHISPER_PROMPT);
  form.append('response_format', 'json');
  const started = Date.now();
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  const latencyMs = Date.now() - started;
  if (!res.ok) return { model, ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, latencyMs };
  const data = await res.json();
  return { model, ok: true, text: (data.text || '').trim(), latencyMs };
}

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/compare-asr-models.js <path-to-audio-file>'); process.exit(1); }
  if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY not set (check server/.env)'); process.exit(1); }

  const ext = path.extname(file).slice(1).toLowerCase();
  const contentType = CONTENT_TYPE_BY_EXT[ext] || 'audio/webm';
  const buffer = fs.readFileSync(file);
  console.log(`input: ${file} (${buffer.length} bytes, ${contentType})\n`);

  const [a, b] = await Promise.all([
    transcribe('whisper-1', buffer, contentType, path.basename(file)),
    transcribe('gpt-4o-mini-transcribe', buffer, contentType, path.basename(file)),
  ]);

  for (const r of [a, b]) {
    console.log(`--- ${r.model} (${r.latencyMs}ms) ---`);
    console.log(r.ok ? r.text : `FAILED: ${r.error}`);
    console.log();
  }
  console.log('自己念一遍原话，对比哪个模型把 plié / tendu / pirouette / grand battement 这些词听得更准。');
  console.log('gpt-4o-mini-transcribe 明显更差就别换；差不多或更好，才考虑去 Render 把 ASR_MODEL 改过去。');
})();
