// Build-time only (macOS): renders public/audio/terms/<slug>.m4a for every glossary term
// with the system "say" voices (French: Thomas, English-only terms: Samantha) and AAC-encodes
// them with afconvert. The generated files are committed; Render does not run this.
// Note: these are Apple system voices -- fine for the free beta, but re-render with a licensed
// TTS service before commercialising.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TERM_GLOSSARY, termAudioSlug } = require('../public/js/ballet-terms.js');

const outDir = path.join(__dirname, '..', 'public', 'audio', 'terms');
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'term-audio-'));
const seen = new Map();
let count = 0;

TERM_GLOSSARY.forEach((section) => section.rows.forEach((row) => {
  const englishOnly = row.pron === '—';
  const text = englishOnly ? row.en : row.fr;
  const slug = termAudioSlug(text);
  if (!slug) throw new Error(`empty slug for ${JSON.stringify(row)}`);
  if (seen.has(slug)) throw new Error(`slug clash: ${slug} (${seen.get(slug)} vs ${text})`);
  seen.set(slug, text);
  const aiff = path.join(tmp, `${slug}.aiff`);
  execFileSync('say', ['-v', englishOnly ? 'Samantha' : 'Thomas', '-o', aiff, text]);
  execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '32000', aiff, path.join(outDir, `${slug}.m4a`)]);
  count++;
}));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${count} files to ${path.relative(process.cwd(), outDir)}`);
