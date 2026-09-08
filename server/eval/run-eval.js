// Offline golden-set eval for /api/generate.
// Layer 1 quality + this-run Layer 2 (latency / tokens / cost).
// Not in `npm test`. Run: `cd server && npm run eval`
// Model selection: change only AI_MODEL (or only AI_TEMPERATURE), rerun the same set.

const fs = require('fs');
const path = require('path');
require('../config');
const { AI_MODEL, AI_TEMPERATURE } = require('../config');
const { PROMPT_VERSION } = require('../ai/review-prompt');
const { callAnthropicOnce, findToolUse, reviewFromToolInput } = require('../ai/anthropic');
const { CASES } = require('./cases');
const { DIMENSIONS } = require('./helpers');

// Published Anthropic list prices ($ / MTok), Sep 2026. Cache write/hit used when usage reports them.
const MODEL_RATES = {
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheHit: 0.1 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheWrite: 1.25, cacheHit: 0.1 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheHit: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheWrite: 3.75, cacheHit: 0.3 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheHit: 0.2 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheHit: 0.5 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheHit: 0.5 },
};

function ratesFor(model) {
  const key = Object.keys(MODEL_RATES).find((k) => model === k || model.startsWith(k));
  return MODEL_RATES[key] || MODEL_RATES['claude-sonnet-4-6'];
}

function pct(n, d) {
  if (!d) return '—';
  return `${Math.round((n / d) * 1000) / 10}%`;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

function dimStats(rows, dim) {
  const subset = rows.filter((r) => (r.dimensions || []).includes(dim));
  const passCount = subset.filter((r) => r.ok).length;
  return { passCount, total: subset.length, rate: pct(passCount, subset.length) };
}

function typeStats(rows) {
  const map = {};
  for (const r of rows) {
    const t = r.type || 'untagged';
    if (!map[t]) map[t] = { pass: 0, total: 0 };
    map[t].total += 1;
    if (r.ok) map[t].pass += 1;
  }
  return map;
}

async function runCase(c) {
  const started = Date.now();
  const response = await callAnthropicOnce(c.termHint || '', c.transcript);
  const latencyMs = Date.now() - started;
  if (!response.ok) {
    const body = await response.text();
    return {
      ...c,
      ok: false,
      schemaOk: false,
      reason: `API调用失败: ${response.status} ${body}`,
      latencyMs,
    };
  }
  const data = await response.json();
  const usage = data.usage || {};
  const usageFields = {
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cacheReadTokens: usage.cache_read_input_tokens || 0,
    cacheCreationTokens: usage.cache_creation_input_tokens || 0,
  };
  const toolUse = findToolUse(data);
  if (!toolUse) {
    return {
      ...c,
      ok: false,
      schemaOk: false,
      reason: 'AI未返回结构化结果',
      latencyMs,
      ...usageFields,
    };
  }
  const result = reviewFromToolInput(toolUse.input);
  const outcome = c.check(result);
  return {
    ...c,
    result,
    ...outcome,
    schemaOk: true,
    latencyMs,
    ...usageFields,
  };
}

(async () => {
  const model = process.env.AI_MODEL || AI_MODEL;
  const rates = ratesFor(model);
  console.log('=== BalletMind Offline Eval (Layer 1 + this-run Layer 2) ===');
  console.log(`model=${model} temperature=${/^claude-(sonnet-5|opus-5|fable-5)/.test(model) ? 'omitted' : AI_TEMPERATURE} prompt=${PROMPT_VERSION}`);
  console.log(`rates=$/MTok in=${rates.input} out=${rates.output} cacheWrite=${rates.cacheWrite} cacheHit=${rates.cacheHit}`);
  console.log(`cases=${CASES.length}  (target 30–50; not RAG Precision/Recall)\n`);

  const results = [];
  for (const c of CASES) {
    process.stdout.write(`- [${c.type}] ${c.name} ... `);
    const r = await runCase(c);
    results.push(r);
    console.log(r.ok ? 'PASS' : `FAIL — ${r.reason}`);
    if (!r.ok && r.result) {
      console.log('  actual:', JSON.stringify(r.result, null, 2).split('\n').join('\n  '));
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const schemaOk = results.filter((r) => r.schemaOk).length;
  const latencies = results.map((r) => r.latencyMs).filter((n) => typeof n === 'number').sort((a, b) => a - b);
  const inputTokens = results.reduce((a, r) => a + (r.inputTokens || 0), 0);
  const outputTokens = results.reduce((a, r) => a + (r.outputTokens || 0), 0);
  const cacheReadTokens = results.reduce((a, r) => a + (r.cacheReadTokens || 0), 0);
  const cacheCreationTokens = results.reduce((a, r) => a + (r.cacheCreationTokens || 0), 0);
  const usd = (inputTokens / 1e6) * rates.input
    + (outputTokens / 1e6) * rates.output
    + (cacheCreationTokens / 1e6) * rates.cacheWrite
    + (cacheReadTokens / 1e6) * rates.cacheHit;

  console.log('\n--- Layer 1  AI Quality (same prompt + schema; not RAG P/R) ---');
  const labels = {
    coverage: 'Field Coverage',
    classification: 'Classification Accuracy',
    hallucination: 'Unsupported Content / Hallucination-free',
    terminology: 'Terminology Accuracy',
    schema: 'Schema Validity',
  };
  for (const dim of DIMENSIONS) {
    const s = dim === 'schema'
      ? { passCount: schemaOk, total: results.length, rate: pct(schemaOk, results.length) }
      : dimStats(results, dim);
    console.log(`  ${labels[dim]}: ${s.passCount}/${s.total}  (${s.rate})`);
    if (dim === 'hallucination' && s.total) {
      const failCount = s.total - s.passCount;
      console.log(`  Unsupported Content Rate: ${failCount}/${s.total}  (${pct(failCount, s.total)})`);
    }
  }
  console.log(`  Overall case pass: ${passed}/${results.length}  (${pct(passed, results.length)})`);

  console.log('\n--- by case type ---');
  const types = typeStats(results);
  Object.keys(types).sort().forEach((t) => {
    console.log(`  ${t}: ${types[t].pass}/${types[t].total}`);
  });

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('\n--- FAIL root-cause hints (ASR → terminology → Prompt → LLM → schema → backend) ---');
    failed.forEach((r) => {
      console.log(`  [${r.rootCauseHint || 'llm'}] ${r.name}`);
    });
  }

  const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
  console.log('\n--- Layer 2  this run (not production P95) ---');
  console.log(`  cases=${results.length}  avgLatencyMs=${avg}  p95LatencyMs=${percentile(latencies, 95)}`);
  console.log(`  inputTokens=${inputTokens}  outputTokens=${outputTokens}  cacheWrite=${cacheCreationTokens}  cacheRead=${cacheReadTokens}  estUsd=${usd.toFixed(4)}`);
  console.log('\nModel selection: change only AI_MODEL in .env, rerun. Compare Quality × Reliability × Latency × Cost.');
  console.log('Layer 3 (completion / edit / retention) is online — stats.html + real users, not this command.');

  const layer1 = {};
  for (const dim of DIMENSIONS) {
    layer1[dim] = dim === 'schema'
      ? { passCount: schemaOk, total: results.length, rate: pct(schemaOk, results.length) }
      : dimStats(results, dim);
  }
  const report = {
    at: new Date().toISOString(),
    model,
    temperature: AI_TEMPERATURE,
    promptVersion: PROMPT_VERSION,
    rates,
    cases: results.length,
    layer1: {
      ...layer1,
      unsupportedContentRate: layer1.hallucination && layer1.hallucination.total
        ? {
          failCount: layer1.hallucination.total - layer1.hallucination.passCount,
          total: layer1.hallucination.total,
          rate: pct(layer1.hallucination.total - layer1.hallucination.passCount, layer1.hallucination.total),
        }
        : null,
      overall: { passCount: passed, total: results.length, rate: pct(passed, results.length) },
    },
    byType: typeStats(results),
    layer2: {
      avgLatencyMs: avg,
      p95LatencyMs: percentile(latencies, 95),
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      estUsd: Number(usd.toFixed(4)),
    },
    fails: failed.map((r) => ({
      name: r.name,
      type: r.type,
      reason: r.reason,
      rootCauseHint: r.rootCauseHint,
      result: r.result || null,
    })),
    casesDetail: results.map((r) => ({
      name: r.name,
      type: r.type,
      ok: r.ok,
      schemaOk: r.schemaOk,
      reason: r.reason || null,
      latencyMs: r.latencyMs,
      dimensions: r.dimensions,
    })),
  };
  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const safeModel = model.replace(/[^\w.-]+/g, '_');
  const outFile = path.join(outDir, `${safeModel}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${outFile}`);

  process.exit(failed.length > 0 ? 1 : 0);
})();
