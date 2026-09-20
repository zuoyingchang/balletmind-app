// Production-wired port of experiments/langgraph-issue-brief (analyze → write → review).
// Never call unless isIssueBriefExperimentOn(userId) is true. Any failure
// returns usedFallback so the route keeps the 0-LLM rule card.
const { callAnthropicMessagesWithRetry, findToolUse } = require('./anthropic');

const MAX_WRITE_ATTEMPTS = 2;

const ANALYST_TOOL = {
  name: 'submit_analysis',
  description: '把原始反复问题归类、排序，最多 3 个主题',
  input_schema: {
    type: 'object',
    properties: {
      themes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            theme_label: { type: 'string' },
            issue_ids: { type: 'array', items: { type: 'integer' } },
            reason: { type: 'string' },
          },
          required: ['theme_label', 'issue_ids'],
        },
      },
    },
    required: ['themes'],
  },
};

const WRITER_TOOL = {
  name: 'submit_brief',
  description: '课前提醒短句，最多 3 条',
  input_schema: {
    type: 'object',
    properties: {
      lines: { type: 'array', items: { type: 'string' } },
    },
    required: ['lines'],
  },
};

const REVIEWER_TOOL = {
  name: 'submit_review',
  description: '审核课前提醒草稿',
  input_schema: {
    type: 'object',
    properties: {
      approved: { type: 'boolean' },
      feedback: { type: 'string' },
    },
    required: ['approved'],
  },
};

const ANALYST_SYSTEM = `你在帮一个芭蕾训练记录类产品分析用户"反复出现的问题"数据，目的是生成一张课前提醒卡。只能使用提供的 issue 列表内容，不能编造列表之外的问题。把意思相近但文字不同的问题归为同一个主题。按对用户上课最有帮助的优先级排序，最多给 3 个主题。不做进步/退步之类的判断，只做归类和排序。`;

const WRITER_SYSTEM = `你在帮一个芭蕾训练记录类产品把分析好的问题主题写成课前提醒。要求：最多 3 条，每条一句话，口语化；只能使用给你的主题和原始问题内容，不能编造建议或加入芭蕾知识；不能出现"你进步了""你一直没改善""你退步了"之类的判断性结论，只能提醒"这个问题最近常出现"。如果收到了审核反馈，必须按反馈修改。`;

const REVIEWER_SYSTEM = `你在审核一张课前提醒卡的草稿。拒绝的情况：出现"进步了/退步了/一直没改善"之类的判断性结论；提到了原始 issues 里没有的内容；超过 3 条。其余情况批准。feedback 要具体。`;

function issuesBlock(issues) {
  return issues.map((i) => `[issue ${i.id}] ${i.text}（出现 ${i.occurrence_count} 次）`).join('\n');
}

function themesBlock(themes) {
  return (themes || []).map((t) => `- ${t.theme_label}（关联 issue: ${(t.issue_ids || []).join(', ')}）`).join('\n');
}

function fallbackLines(issues) {
  return issues.slice(0, 3).map((i) => i.text);
}

async function toolRound(systemPrompt, tools, toolChoice, userText) {
  const { response, error } = await callAnthropicMessagesWithRetry(
    systemPrompt, tools, toolChoice, [{ role: 'user', content: userText }]
  );
  if (error || !response || !response.ok) return null;
  const data = await response.json();
  return findToolUse(data);
}

async function runIssueBriefExperiment(issues) {
  const input = (issues || []).slice(0, 8);
  if (!input.length) return { usedFallback: true, lines: [], attempts: 0 };

  const analysisUse = await toolRound(
    ANALYST_SYSTEM, [ANALYST_TOOL], { type: 'tool', name: ANALYST_TOOL.name },
    `原始问题列表：\n${issuesBlock(input)}`
  );
  const themes = analysisUse && analysisUse.input && analysisUse.input.themes;
  if (!Array.isArray(themes) || !themes.length) {
    return { usedFallback: true, lines: fallbackLines(input), attempts: 0 };
  }

  let feedback = '';
  let attempts = 0;
  let lines = [];
  while (attempts < MAX_WRITE_ATTEMPTS) {
    const writeParts = [
      `主题（已按优先级排序）：\n${themesBlock(themes)}`,
      `原始问题列表：\n${issuesBlock(input)}`,
    ];
    if (feedback) writeParts.push(`上一版被驳回，审核反馈：${feedback}`);
    const writeUse = await toolRound(
      WRITER_SYSTEM, [WRITER_TOOL], { type: 'tool', name: WRITER_TOOL.name },
      writeParts.join('\n\n')
    );
    attempts += 1;
    lines = writeUse && Array.isArray(writeUse.input && writeUse.input.lines)
      ? writeUse.input.lines.map((s) => String(s).trim()).filter(Boolean).slice(0, 3)
      : [];
    if (!lines.length) break;

    const reviewUse = await toolRound(
      REVIEWER_SYSTEM, [REVIEWER_TOOL], { type: 'tool', name: REVIEWER_TOOL.name },
      `原始问题列表：\n${issuesBlock(input)}\n\n课前提醒草稿：\n${lines.map((l) => `- ${l}`).join('\n')}`
    );
    const approved = !!(reviewUse && reviewUse.input && reviewUse.input.approved);
    if (approved) return { usedFallback: false, lines, attempts };
    feedback = (reviewUse && reviewUse.input && reviewUse.input.feedback) || '请缩短并去掉判断性结论';
  }

  return { usedFallback: true, lines: fallbackLines(input), attempts };
}

module.exports = { runIssueBriefExperiment, MAX_WRITE_ATTEMPTS };
