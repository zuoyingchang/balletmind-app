// A small golden-set eval for the /api/generate prompt — PRD §11 defines
// Hallucination Rate, Terminology Error, and information-coverage as the
// metrics that matter; this is a lightweight, automatable proxy for them.
//
// This calls the REAL Anthropic API, so it costs real money per run.
// It is deliberately NOT part of `npm test` (which is free and uses mocked
// fetch) — run it by hand with `npm run eval` when the prompt changes.

require('../config'); // loads .env
const { callAnthropicOnce } = require('../routes/generate');

const CASES = [
  {
    name: '忠实提取 — 三段内容都明确说了，应该原样归类',
    transcript: '今天pirouette单圈，腿passé位置还行，但是转的时候骨盆晃，重心不稳，下次多练地面静态控腿。',
    check(r) {
      if (r.confidence_level !== '高') return fail(`期望 confidence_level=高，实际=${r.confidence_level}`);
      if (!/passé|收腿/.test(r.good_points)) return fail(`good_points 没提到 passé/收腿：${r.good_points}`);
      if (!/骨盆|重心/.test(r.improve_points)) return fail(`improve_points 没提到骨盆/重心：${r.improve_points}`);
      if (!/控腿|passé/.test(r.next_time_reminder)) return fail(`next_time_reminder 没提到控腿：${r.next_time_reminder}`);
      return pass();
    },
  },
  {
    name: '信息不足 — 应该降低置信度并说明，不能瞎编',
    transcript: '嗯……今天没什么特别的。',
    check(r) {
      if (r.confidence_level !== '低') return fail(`期望 confidence_level=低，实际=${r.confidence_level}`);
      if (!/信息.*有限|信息不足/.test(r.note)) return fail(`note 没有说明信息不足：${r.note}`);
      if (r.good_points || r.improve_points || r.next_time_reminder) {
        return fail(`不该凭空生成内容，实际输出了：good=${r.good_points} improve=${r.improve_points} next=${r.next_time_reminder}`);
      }
      return pass();
    },
  },
  {
    name: '防幻觉 — 用户暗示但没明说的建议不能被写成正式计划',
    transcript: '今天感觉腿没什么力气，turnout也开不太出去，可能是我平时没怎么练核心。',
    check(r) {
      const forbidden = /建议|应该|每天练习\d+分钟/;
      if (forbidden.test(r.next_time_reminder) || forbidden.test(r.improve_points)) {
        return fail(`疑似编造了用户没有明确说过的建议：improve=${r.improve_points} next=${r.next_time_reminder}`);
      }
      if (r.confidence_level === '高') return fail('这种带猜测语气的内容不该是高置信度');
      return pass();
    },
  },
  {
    name: '术语表识别 — 发音变形的术语应该被正确识别',
    transcript: '今天格朗巴特芒踢腿踢得比以前高一点，感觉有进步。',
    check(r) {
      if (!/[Gg]rand battement|大踢腿/.test(r.good_points)) {
        return fail(`没能借助术语表识别出 grand battement：good_points=${r.good_points}`);
      }
      return pass();
    },
  },
  {
    name: '真正无法辨认的术语 — 不能强行套用词汇表硬编一个术语',
    transcript: '今天练了那个转圈的动作，具体叫什么我也不记得了，反正转的时候有点晕。',
    check(r) {
      if (r.confidence_level === '高') return fail('这种连用户自己都说不清的术语不该是高置信度');
      const namedASpecificTurn = /pirouette|chaîné|fouetté|piqué/.test(r.improve_points + r.note);
      if (namedASpecificTurn && !/不确定|无法确认|歧义|无法判断|无法从描述中判断|不予强行|不能确定|说不清/.test(r.note)) {
        return fail(`猜了一个具体的转类术语，但没有在 note 里说明这是猜测：${r.note}`);
      }
      return pass();
    },
  },
];

function pass() { return { ok: true }; }
function fail(reason) { return { ok: false, reason }; }

async function runCase(c) {
  const response = await callAnthropicOnce(c.termHint || '', c.transcript);
  if (!response.ok) {
    return { ...c, ok: false, reason: `API调用失败: ${response.status} ${await response.text()}` };
  }
  const data = await response.json();
  const toolUse = (data.content || []).find((b) => b.type === 'tool_use');
  if (!toolUse) return { ...c, ok: false, reason: 'AI未返回结构化结果' };
  const input = toolUse.input || {};
  const joinLines = (v) => (Array.isArray(v) ? v.filter(Boolean).join('\n') : v || '');
  const result = {
    good_points: joinLines(input.good_points),
    improve_points: joinLines(input.improve_points),
    next_time_reminder: joinLines(input.next_time_reminder),
    confidence_level: input.confidence_level || '',
    note: input.note || '',
  };
  const outcome = c.check(result);
  return { ...c, result, ...outcome };
}

(async () => {
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
  process.exit(failed.length > 0 ? 1 : 0);
})();
