const test = require('node:test');
const assert = require('node:assert/strict');
const { searchRecordsByQuestion } = require('../../public/js/ballet-terms');
const {
  KEYWORD_SPARSE_MAX,
  cosineSimilarity,
  retrieveAskRecords,
} = require('../ai/ask-retrieve');
const { CORPUS, CASES } = require('../eval/ask-retrieve-cases');

test('KEYWORD_SPARSE_MAX is 1: embedding only when keyword hits are 0 or 1', () => {
  assert.equal(KEYWORD_SPARSE_MAX, 1);
});

test('cosineSimilarity is 0 for orthogonal or zero vectors', () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
  assert.ok(cosineSimilarity([1, 0], [1, 0]) > 0.99);
});

test('frozen standard questions hit on keywords; paraphrase questions mostly miss', () => {
  for (const c of CASES.filter((x) => x.bucket === 'standard')) {
    const hits = searchRecordsByQuestion(CORPUS, c.q, 3);
    assert.ok(hits.length >= (c.expectKeywordMin || 1), `${c.id} should keyword-hit`);
  }
  for (const c of CASES.filter((x) => x.bucket === 'paraphrase')) {
    const hits = searchRecordsByQuestion(CORPUS, c.q, 3);
    const max = c.expectKeywordMax == null ? 1 : c.expectKeywordMax;
    assert.ok(hits.length <= max, `${c.id} expected sparse keywords, got ${hits.length}`);
  }
});

function embedById(targetId) {
  return async (texts) => texts.map((text, i) => {
    if (i === 0) return [1, 0];
    const record = CORPUS[i - 1];
    return record && record.id === targetId ? [1, 0] : [0, 1];
  });
}

test('hybrid skips embedding when keyword already has >=2 hits', async () => {
  let embedCalls = 0;
  const recs = [
    { id: 10, class_name: '基训', improve_points: '转圈重心不稳', good_points: '', next_time_reminder: '', created_at: 2 },
    { id: 11, class_name: '基训', improve_points: '转圈骨盆晃', good_points: '', next_time_reminder: '', created_at: 1 },
  ];
  const out = await retrieveAskRecords(recs, '转圈', {
    embedTexts: async (texts) => {
      embedCalls++;
      return texts.map(() => [1, 0]);
    },
  });
  assert.equal(embedCalls, 0);
  assert.equal(out.retrievalPath, 'keyword');
  assert.equal(out.keywordCount, 2);
  assert.equal(out.matches.length, 2);
});

test('hybrid runs embedding when keyword is empty and can recover a paraphrase hit', async () => {
  const out = await retrieveAskRecords(CORPUS, '感觉站不太住', { embedTexts: embedById(1) });
  assert.equal(out.keywordCount, 0);
  assert.equal(out.retrievalPath, 'embedding');
  assert.equal(out.matches[0].id, 1);
});

test('hybrid keeps the one keyword hit and can add an embedding neighbor', async () => {
  const recs = [
    { id: 1, class_name: '基训', improve_points: '转圈重心不稳', good_points: '', next_time_reminder: '', created_at: 2 },
    { id: 2, class_name: '基训', improve_points: '单脚站的时候晃', good_points: '', next_time_reminder: '', created_at: 1 },
  ];
  const out = await retrieveAskRecords(recs, '转圈', {
    embedTexts: async (texts) => texts.map((text, i) => {
      if (i === 0) return [1, 0];
      return text.includes('晃') ? [0.95, 0.05] : [0.2, 0.8];
    }),
    minSim: 0.45,
  });
  assert.equal(out.keywordCount, 1);
  assert.equal(out.retrievalPath, 'hybrid');
  assert.equal(out.matches[0].id, 1);
  assert.equal(out.matches[1].id, 2);
});

test('embedding below threshold still skips Claude path (matches empty)', async () => {
  const out = await retrieveAskRecords(CORPUS, '完全无关的问题xyz', {
    embedTexts: async (texts) => texts.map((t, i) => (i === 0 ? [1, 0] : [0, 1])),
  });
  assert.equal(out.retrievalPath, 'none');
  assert.equal(out.matches.length, 0);
});

test('embedding failure falls back to keyword-only', async () => {
  const out = await retrieveAskRecords(CORPUS, '转圈重心不稳', {
    embedTexts: async () => { throw new Error('boom'); },
  });
  assert.ok(out.keywordCount >= 1);
  assert.equal(out.retrievalPath, 'keyword');
  assert.equal(out.matches[0].id, 1);
});

// ---------- cached embeddings (records.js writes record.embedding at save time) ----------
test('a record with a cached embedding is not re-sent to embedTexts', async () => {
  const recs = [
    { id: 1, class_name: '基训', improve_points: '转圈重心不稳', good_points: '', next_time_reminder: '', created_at: 2, embedding: JSON.stringify([1, 0]) },
    { id: 2, class_name: '基训', improve_points: '单脚站的时候晃', good_points: '', next_time_reminder: '', created_at: 1 },
  ];
  const seenTexts = [];
  const out = await retrieveAskRecords(recs, '感觉站不太住', {
    mode: 'embedding',
    minSim: 0.1,
    embedTexts: async (texts) => {
      seenTexts.push(...texts);
      // Only the question and record 2's corpus should ever be sent -- record 1
      // already has a stored embedding and must be skipped.
      return texts.map(() => [0.9, 0.1]);
    },
  });
  assert.equal(seenTexts.length, 2, 'only the question + the uncached record should be embedded');
  assert.equal(seenTexts[0], '感觉站不太住');
  assert.ok(!seenTexts.some((t) => t.includes('转圈重心不稳')), "record 1's corpus must not be re-embedded");
  assert.deepEqual(out.matches.map((m) => m.id).sort(), [1, 2]);
});

test('when every record already has a cached embedding, only the question is embedded', async () => {
  const recs = [
    { id: 1, improve_points: 'a', good_points: '', next_time_reminder: '', created_at: 1, embedding: JSON.stringify([1, 0]) },
    { id: 2, improve_points: 'b', good_points: '', next_time_reminder: '', created_at: 2, embedding: JSON.stringify([0.9, 0.1]) },
  ];
  let callTextsLength = null;
  await retrieveAskRecords(recs, '随便问一句', {
    mode: 'embedding',
    minSim: 0,
    embedTexts: async (texts) => {
      callTextsLength = texts.length;
      return texts.map(() => [1, 0]);
    },
  });
  assert.equal(callTextsLength, 1, 'texts sent should be just the question when all records are cached');
});

test('a malformed stored embedding is treated as missing and re-embedded', async () => {
  const recs = [
    { id: 1, improve_points: '转圈重心不稳', good_points: '', next_time_reminder: '', created_at: 1, embedding: 'not valid json' },
  ];
  let embedded = false;
  const out = await retrieveAskRecords(recs, '转圈重心不稳', {
    mode: 'embedding',
    minSim: 0.1,
    embedTexts: async (texts) => {
      embedded = texts.length === 2;
      return texts.map(() => [1, 0]);
    },
  });
  assert.ok(embedded, 'a malformed stored embedding should fall back to live embedding, not crash or silently drop');
  assert.equal(out.matches[0].id, 1);
});
