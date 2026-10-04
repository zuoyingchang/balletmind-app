// Ask-archive retrieval: keyword first, embedding only when keyword is sparse.
//
// Executable trigger (not a vibe): keyword hits <= KEYWORD_SPARSE_MAX (1).
//   >= 2 keyword matches → keyword only (enough signal, skip the extra cost)
//   0 or 1 keyword match  → run embeddings, merge, still skip Claude if empty
// Question length / clause count is not a trigger.

const { searchRecordsByQuestion } = require('../../public/js/ballet-terms');

const KEYWORD_SPARSE_MAX = 1;
const ASK_RETRIEVE_LIMIT = 3;
const EMBEDDING_MIN_SIM = 0.45;
const EMBEDDING_MODEL = process.env.ASK_EMBEDDING_MODEL || 'text-embedding-3-small';
const EMBEDDING_TIMEOUT_MS = Number(process.env.ASK_EMBEDDING_TIMEOUT_MS) || 10000;

function recordCorpus(r) {
  return [r.class_name, r.good_points, r.improve_points, r.next_time_reminder]
    .filter(Boolean)
    .join('\n');
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function mergeRecords(keywordRecords, embeddingHits, limit) {
  const out = [];
  const seen = new Set();
  for (const r of keywordRecords) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length >= limit) return out;
  }
  for (const hit of embeddingHits) {
    const r = hit.record;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length >= limit) return out;
  }
  return out;
}

function pathFor({ keywordCount, embeddingRan, embeddingAdded, matchCount }) {
  if (matchCount === 0) return 'none';
  if (!embeddingRan) return 'keyword';
  if (keywordCount === 0) return 'embedding';
  if (embeddingAdded > 0) return 'hybrid';
  return 'keyword';
}

async function embedTextsOpenAI(texts, { fetchImpl, apiKey, model } = {}) {
  const key = apiKey !== undefined ? apiKey : (process.env.OPENAI_API_KEY || '');
  if (!key) throw new Error('missing_openai_key');
  const fetchFn = fetchImpl || fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), EMBEDDING_TIMEOUT_MS);
  try {
    const response = await fetchFn(`https://api.openai.com/v1/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: model || EMBEDDING_MODEL, input: texts }),
      signal: ac.signal,
    });
    if (!response.ok) throw new Error(`embeddings_http_${response.status}`);
    const data = await response.json();
    const rows = [...(data.data || [])].sort((a, b) => a.index - b.index);
    if (rows.length !== texts.length) throw new Error('embeddings_count_mismatch');
    return rows.map((row) => row.embedding);
  } finally {
    clearTimeout(timer);
  }
}

function parseStoredEmbedding(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.length ? v : null;
  } catch (e) {
    return null;
  }
}

// Records save their embedding once, at creation (routes/records.js, best-
// effort/fire-and-forget) -- only records missing one (saved before this
// shipped, or whose background call failed) get re-embedded here. Once a
// user's whole history is cached, an ask call embeds just the question.
async function embeddingHits(records, question, { embedTexts, minSim, limit }) {
  if (!records.length) return [];
  const cached = new Map();
  const missing = [];
  for (const r of records) {
    const vec = parseStoredEmbedding(r.embedding);
    if (vec) cached.set(r.id, vec);
    else missing.push(r);
  }
  const texts = [question, ...missing.map(recordCorpus)];
  const vectors = await embedTexts(texts);
  const qv = vectors[0];
  missing.forEach((r, i) => cached.set(r.id, vectors[i + 1]));
  return records
    .map((record) => ({ record, sim: cosineSimilarity(qv, cached.get(record.id)) }))
    .filter((x) => x.sim >= minSim)
    .sort((a, b) => b.sim - a.sim || (b.record.created_at || 0) - (a.record.created_at || 0))
    .slice(0, limit);
}

/**
 * @param {object[]} records
 * @param {string} question
 * @param {{ mode?: 'hybrid'|'keyword'|'embedding', limit?: number, embedTexts?: Function, skipEmbedding?: boolean }} [opts]
 */
async function retrieveAskRecords(records, question, opts = {}) {
  const limit = opts.limit || ASK_RETRIEVE_LIMIT;
  const minSim = opts.minSim == null ? EMBEDDING_MIN_SIM : opts.minSim;
  const mode = opts.mode || 'hybrid';
  const recs = records || [];
  const q = String(question || '').trim();
  const keywordMatches = q ? searchRecordsByQuestion(recs, q, limit) : [];
  const keywordCount = keywordMatches.length;

  const wantEmbedding = mode === 'embedding'
    || (mode === 'hybrid' && !opts.skipEmbedding && keywordCount <= KEYWORD_SPARSE_MAX);

  let embeddingRan = false;
  let embeddingList = [];
  if (wantEmbedding && q && recs.length) {
    const embedTexts = opts.embedTexts || ((texts) => embedTextsOpenAI(texts, opts));
    try {
      embeddingList = await embeddingHits(recs, q, { embedTexts, minSim, limit });
      embeddingRan = true;
    } catch (e) {
      embeddingList = [];
      embeddingRan = false;
    }
  }

  let matches;
  if (mode === 'keyword') {
    matches = keywordMatches;
  } else if (mode === 'embedding') {
    matches = embeddingList.map((h) => h.record).slice(0, limit);
  } else {
    matches = mergeRecords(keywordMatches, embeddingList, limit);
  }

  const keywordIds = new Set(keywordMatches.map((r) => r.id));
  const embeddingAdded = matches.filter((r) => !keywordIds.has(r.id)).length;

  return {
    matches,
    retrievalPath: pathFor({
      keywordCount,
      embeddingRan: embeddingRan && mode !== 'keyword',
      embeddingAdded,
      matchCount: matches.length,
    }),
    keywordCount,
    embeddingCount: embeddingList.length,
    embeddingAdded,
    embeddingRan: embeddingRan && mode !== 'keyword',
  };
}

module.exports = {
  KEYWORD_SPARSE_MAX,
  ASK_RETRIEVE_LIMIT,
  EMBEDDING_MIN_SIM,
  EMBEDDING_MODEL,
  cosineSimilarity,
  recordCorpus,
  retrieveAskRecords,
  embedTextsOpenAI,
  parseStoredEmbedding,
};
