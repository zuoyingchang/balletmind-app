// Offline retrieval contrast for 问问你的档案.
// Always prints keyword hits. Embedding / hybrid need OPENAI_API_KEY + --live-embed.
// Not in `npm test`. Run: `cd server && npm run eval:ask-retrieve`

require('dotenv').config();
const { searchRecordsByQuestion } = require('../../public/js/ballet-terms');
const { retrieveAskRecords } = require('../ai/ask-retrieve');
const { CORPUS, CASES } = require('./ask-retrieve-cases');

const live = process.argv.includes('--live-embed');
const hasKey = Boolean(process.env.OPENAI_API_KEY);

function idsOf(records) {
  return (records || []).map((r) => r.id);
}

function hitExpected(got, expectIds) {
  if (!expectIds.length) return got.length === 0;
  return expectIds.every((id) => got.includes(id));
}

async function main() {
  console.log('Ask retrieval eval');
  console.log(`corpus=${CORPUS.length} cases=${CASES.length} liveEmbed=${live && hasKey}`);
  if (live && !hasKey) {
    console.log('Pass OPENAI_API_KEY to fill embedding columns. Keyword column still runs.\n');
  }
  console.log('id\tbucket\tkeyword_n\tembed_n\thybrid_n\tpath\tkw_ok\thybrid_ok\tq');

  let paraphraseKwMiss = 0;
  let paraphraseHybridRecover = 0;
  let paraphraseN = 0;

  for (const c of CASES) {
    const kw = searchRecordsByQuestion(CORPUS, c.q, 3);
    const keywordIds = idsOf(kw);
    let embedIds = [];
    let hybrid = { matches: kw, retrievalPath: keywordIds.length ? 'keyword' : 'none', embeddingCount: 0 };

    if (live && hasKey) {
      const [emb, hy] = await Promise.all([
        retrieveAskRecords(CORPUS, c.q, { mode: 'embedding' }),
        retrieveAskRecords(CORPUS, c.q, { mode: 'hybrid' }),
      ]);
      embedIds = idsOf(emb.matches);
      hybrid = hy;
    }

    const hybridIds = idsOf(hybrid.matches);
    const kwOk = hitExpected(keywordIds, c.expectIds);
    const hybridOk = hitExpected(hybridIds, c.expectIds);
    if (c.bucket === 'paraphrase') {
      paraphraseN++;
      if (keywordIds.length === 0) paraphraseKwMiss++;
      if (keywordIds.length === 0 && hybridOk) paraphraseHybridRecover++;
    }

    console.log([
      c.id,
      c.bucket,
      keywordIds.length,
      live && hasKey ? embedIds.length : '—',
      live && hasKey ? hybridIds.length : '—',
      live && hasKey ? hybrid.retrievalPath : (keywordIds.length ? 'keyword' : 'none'),
      kwOk ? 'Y' : 'N',
      live && hasKey ? (hybridOk ? 'Y' : 'N') : '—',
      c.q,
    ].join('\t'));
  }

  console.log('\nParaphrase: keyword-empty', paraphraseKwMiss, '/', paraphraseN,
    '| recovered by hybrid (needs --live-embed)', live && hasKey ? `${paraphraseHybridRecover}/${paraphraseKwMiss}` : 'n/a');
  console.log('Trigger in product: keyword hits <= 1 → embedding. This table is the evidence for that rule.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
