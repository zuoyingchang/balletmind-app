// Repackages the browser's recording into a container Tencent Cloud ASR accepts, without
// re-encoding the audio (fast, no quality loss): Chrome/Android record webm/Opus -> remux
// to ogg/Opus (same codec, just a different box). iPhone Safari records mp4/AAC -> Tencent
// accepts that natively as "m4a", so it passes through untouched.
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS) || 8000;

function contentTypeToExt(contentType) {
  const t = (contentType || '').split(';')[0].trim().toLowerCase();
  if (t.includes('webm')) return 'webm';
  if (t.includes('mp4') || t.includes('m4a')) return 'mp4';
  if (t.includes('mpeg') || t.includes('mp3')) return 'mp3';
  if (t.includes('wav')) return 'wav';
  if (t.includes('ogg')) return 'ogg';
  return 'webm';
}

// What Tencent's VoiceFormat field should say for a given input, and whether it needs remuxing first.
function tencentTarget(ext) {
  if (ext === 'webm') return { voiceFormat: 'ogg-opus', remuxTo: 'ogg' };
  if (ext === 'mp4') return { voiceFormat: 'm4a', remuxTo: null };
  if (ext === 'mp3') return { voiceFormat: 'mp3', remuxTo: null };
  if (ext === 'wav') return { voiceFormat: 'wav', remuxTo: null };
  if (ext === 'ogg') return { voiceFormat: 'ogg-opus', remuxTo: null };
  return { voiceFormat: 'm4a', remuxTo: null };
}

// Runs ffmpeg fully in-memory over stdin/stdout — no temp files, so nothing to clean up and no
// collision between concurrent requests. `-c copy` = remux only, never re-encodes.
function remux(buffer, toContainer) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-c', 'copy', '-f', toContainer, 'pipe:1'];
    const proc = spawn(ffmpegPath, args);
    const out = [];
    const errOut = [];
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('ffmpeg_timeout')); }, FFMPEG_TIMEOUT_MS);
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => errOut.push(d));
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg_exit_${code}: ${Buffer.concat(errOut).toString().slice(0, 300)}`));
      resolve(Buffer.concat(out));
    });
    proc.stdin.on('error', () => {}); // ffmpeg closing stdin early on a bad file must not crash the process
    proc.stdin.end(buffer);
  });
}

/**
 * @param {Buffer} audioBuffer raw bytes as the browser sent them
 * @param {string} contentType the browser's Content-Type header
 * @returns {Promise<{ buffer: Buffer, voiceFormat: string }>} audio ready to send to Tencent, and the VoiceFormat value to declare
 */
async function prepareForTencentAsr(audioBuffer, contentType) {
  const ext = contentTypeToExt(contentType);
  const { voiceFormat, remuxTo } = tencentTarget(ext);
  if (!remuxTo) return { buffer: audioBuffer, voiceFormat };
  const buffer = await remux(audioBuffer, remuxTo);
  return { buffer, voiceFormat };
}

module.exports = { prepareForTencentAsr, contentTypeToExt, tencentTarget, remux };
