// One-off comparison tool, NOT wired into the app. Run manually:
//   node eval/compare-ask-paths.js <userId> "<question>"
// Prints, for the same question against the same user's real records:
//   1. 关键词匹配 (today's primary path, 0 AI calls)
//   2. Embedding检索 (today's fallback path, 1 AI call, no generation)
//   3. RAG / AI生成 (not shipped -- an extra single AI call that writes a
//      synthesized answer from whichever digest above found something)
require('dotenv').config();
const db = require('../db');
const { retrieveAskRecords } = require('../ai/ask-retrieve');
const { buildAskDigest } = require('../ai/ask-digest');
const { listIssuesWithOccurrences } = require('../issues');

async function generateAnswer(question, digest) {
  if (!digest.answered) return null;
  const facts = digest.sections.flatMap((sec) => sec.lines.map((l) => `[${sec.title}] ${l.text}（${l.cite}）`));
  const prompt = `你在帮一个芭蕾训练记录app的用户回答问题。只能使用下面这些从TA自己的课记里抽取出来的句子作为依据，不能编造、不能加入这些句子之外的任何内容、不能下"进步了/退步了/一直没改善"之类的主观判断。把这些句子整合成一段自然、简洁的回答（2-4句话），保留原有的课程和日期引用。

用户的问题：${question}

可用的依据：
${facts.join('\n')}`;

  const started = Date.now();
  const res = await fetch(`${process.env.AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.AI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.AI_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 400 }),
  });
  const data = await res.json();
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return { text: text ? text.trim() : null, ms: Date.now() - started };
}

async function compare(userId, question) {
  const rows = await db.all(
    'SELECT id, class_name, good_points, improve_points, next_time_reminder, created_at, embedding FROM records WHERE user_id = ? ORDER BY created_at DESC',
    [userId]
  );
  const issues = await listIssuesWithOccurrences(userId);

  const t0 = Date.now();
  const keywordRound = await retrieveAskRecords(rows, question, { mode: 'keyword', limit: 8 });
  const keywordDigest = buildAskDigest({ records: keywordRound.matches, issues, question });
  const t1 = Date.now();

  const embeddingRound = await retrieveAskRecords(rows, question, { mode: 'embedding', limit: 8 });
  const embeddingDigest = buildAskDigest({ records: embeddingRound.matches, issues, question });
  const t2 = Date.now();

  const bestDigest = embeddingDigest.answered ? embeddingDigest : keywordDigest;
  const rag = await generateAnswer(question, bestDigest);
  const t3 = Date.now();

  console.log('='.repeat(70));
  console.log('问题:', question);
  console.log('-'.repeat(70));
  console.log(`【关键词匹配】命中 ${keywordRound.keywordCount} 条, ${t1 - t0}ms, 0次AI调用`);
  console.log(keywordDigest.answered ? keywordDigest.answerPoints.join('\n') : '（没找到相关记录）');
  console.log('-'.repeat(70));
  console.log(`【Embedding检索】命中 ${embeddingRound.matches.length} 条, ${t2 - t1}ms, 1次AI调用`);
  console.log(embeddingDigest.answered ? embeddingDigest.answerPoints.join('\n') : '（没找到相关记录）');
  console.log('-'.repeat(70));
  console.log(`【RAG / AI生成】${t3 - t2}ms${rag ? `, 1次AI调用` : ''}`);
  console.log(rag ? `${rag.text}\n(生成耗时 ${rag.ms}ms)` : '（没有可用依据，AI没有生成）');
  console.log('='.repeat(70));
  console.log();
}

(async () => {
  const userId = Number(process.argv[2]);
  const questions = process.argv.slice(3);
  for (const q of questions) {
    await compare(userId, q);
  }
  process.exit(0);
})();
