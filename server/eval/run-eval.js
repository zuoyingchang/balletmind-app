// Golden-set eval for /api/generate. PRD quality metrics (coverage,
// hallucination, terminology) mapped to automatable checks.
// Calls the real Anthropic API — not part of `npm test`. Run with `npm run eval`.

require('../config');
const { AI_MODEL, AI_TEMPERATURE } = require('../config');
const { PROMPT_VERSION } = require('../ai/review-prompt');
const { callAnthropicOnce, findToolUse, reviewFromToolInput } = require('../ai/anthropic');
const { CASES } = require('./cases');

async function runCase(c) {
  const response = await callAnthropicOnce(c.termHint || '', c.transcript);
  if (!response.ok) {
    return { ...c, ok: false, reason: `API调用失败: ${response.status} ${await response.text()}` };
  }
  const data = await response.json();
  const toolUse = findToolUse(data);
  if (!toolUse) return { ...c, ok: false, reason: 'AI未返回结构化结果' };
  const result = reviewFromToolInput(toolUse.input);
  const outcome = c.check(result);
  return { ...c, result, ...outcome };
}

(async () => {
  console.log(`model=${AI_MODEL} temperature=${AI_TEMPERATURE} prompt=${PROMPT_VERSION}`);
  console.log(`运行 ${CASES.length} 个 eval case...\n`);
  const results = [];
  for (const c of CASES) {
    process.stdout.write(`- ${c.name} ... `);
    const r = await runCase(c);
    results.push(r);
    console.log(r.ok ? 'PASS' : `FAIL — ${r.reason}`);
    if (!r.ok) console.log('  实际输出:', JSON.stringify(r.result, null, 2).split('\n').join('\n  '));
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  console.log('换模型或改 temperature 时：只改 .env 里的 AI_MODEL / AI_TEMPERATURE，再跑同一套 case，用通过率+失败类型对比，不要凭感觉。');
  process.exit(failed.length > 0 ? 1 : 0);
})();
