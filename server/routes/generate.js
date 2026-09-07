const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { logEvent, countAiCallsToday } = require('../events');
const { DAILY_AI_LIMIT, MAX_TRANSCRIPT_LENGTH } = require('../config');

const router = express.Router();

// System prompt, transcribed from the Prompt Design Document (V1.1).
// JSON validity itself is enforced by the tool-use schema below, but the
// content-style rules here (no evaluative/flowery language, no unsolicited
// coaching advice) are not — the schema can't express those.
const SYSTEM_PROMPT = `你是一个芭蕾训练笔记整理助手。
你的任务是根据用户语音转写后的内容，整理用户本次训练的复盘信息。
你只能基于用户明确提供的信息进行提取、归纳和结构化，不可以编造用户没有提到的问题、优点或训练建议。
请将用户的口述内容整理为以下三个主要部分：
1. 做得好的地方；
2. 待改进点；
3. 下次练习注意事项。
如果用户提供的信息不足，不要自行补充内容，应明确标注"用户描述信息有限"。
如果某些内容可能由于语音识别错误而存在歧义，不要擅自修改为你认为正确的芭蕾术语，应降低confidence_level，并在note中说明。
输出内容不得包含额外的解释性、评价性或抒情文字——只整理事实，不评价用户表现好坏，不使用鼓励或安慰性语言。
本功能仅用于帮助用户整理个人训练记录，不替代专业芭蕾教师的指导或专业意见。

不得因为你拥有芭蕾知识，就自行增加用户没有说过的训练建议，例如"建议加强核心训练"、"应该增加turnout训练"、"建议每天练习20分钟"等——这类内容一律不得出现，除非是用户自己明确说过的。

示例：
用户口述："今天pirouette单圈，腿passé位置还行，但是转的时候骨盆晃，重心不稳，下次多练地面静态控腿。"
应整理为：
- good_points: ["Pirouette passé 腿位置控制尚可"]
- improve_points: ["旋转过程骨盆晃动，重心不稳定"]
- next_time_reminder: ["多练习地面静态passé控腿"]
- confidence_level: "高"
- note: ""`;

// Forces the model to return arguments matching this schema — the Anthropic API
// validates/parses the JSON server-side, so we never have to hand-parse free text
// (which previously broke whenever the model quoted a term inside a string value).
// Arrays here match the Prompt Design Document's Output Schema exactly; the route
// handler below joins them into newline-separated strings before responding, since
// that's what the frontend's textareas and the records table already expect.
const REVIEW_TOOL = {
  name: 'submit_review',
  description: '提交结构化的芭蕾训练复盘结果',
  input_schema: {
    type: 'object',
    properties: {
      good_points: { type: 'array', items: { type: 'string' }, description: '用户明确提到的做得较好的部分，不得自行推断，若无则为空数组' },
      improve_points: { type: 'array', items: { type: 'string' }, description: '用户明确提到的待改进问题，不得新增问题，若无则为空数组' },
      next_time_reminder: { type: 'array', items: { type: 'string' }, description: '用户明确提出的下次注意事项，不得自行生成训练建议，若无则为空数组' },
      confidence_level: { type: 'string', enum: ['高', '中', '低'], description: 'AI 对本次结构化结果可靠程度的判断' },
      note: { type: 'string', description: '信息不足、术语模糊、ASR可疑等说明，无异常则为空字符串' },
    },
    required: ['good_points', 'improve_points', 'next_time_reminder', 'confidence_level', 'note'],
  },
};

// POST /api/generate  { transcript } -> AI structured draft
// The Anthropic API key never reaches the browser — it only lives here, on the server.
router.post('/', requireAuth, async (req, res) => {
  const { transcript } = req.body || {};
  if (!transcript || !transcript.trim()) {
    return res.status(400).json({ error: '缺少语音转写内容' });
  }
  if (transcript.length > MAX_TRANSCRIPT_LENGTH) {
    return res.status(400).json({ error: `本次内容过长（超过${MAX_TRANSCRIPT_LENGTH}字），请分段录制` });
  }
  if ((await countAiCallsToday(req.userId)) >= DAILY_AI_LIMIT) {
    await logEvent(req.userId, 'ai_process_fail', { reason: 'quota_exceeded' });
    return res.status(429).json({ error: '今天的AI整理次数已经用完了，可以先手动记录内容，明天再生成复盘' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: '服务器未配置 ANTHROPIC_API_KEY，请检查 .env 文件' });
  }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `用户语音转写内容：\n${transcript}` }],
        tools: [REVIEW_TOOL],
        tool_choice: { type: 'tool', name: 'submit_review' },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      await logEvent(req.userId, 'ai_process_fail', { reason: 'api_error', status: response.status });
      return res.status(502).json({ error: 'AI服务调用失败，请Retry', detail: errText });
    }

    const data = await response.json();
    const toolUse = (data.content || []).find((b) => b.type === 'tool_use');
    if (!toolUse) {
      await logEvent(req.userId, 'ai_process_fail', { reason: 'no_tool_use' });
      return res.status(502).json({ error: 'AI未返回有效内容' });
    }

    const input = toolUse.input || {};
    const joinLines = (v) => Array.isArray(v) ? v.filter(Boolean).join('\n') : (v || '');
    await logEvent(req.userId, 'ai_process_success', { confidence_level: input.confidence_level });
    res.json({
      good_points: joinLines(input.good_points),
      improve_points: joinLines(input.improve_points),
      next_time_reminder: joinLines(input.next_time_reminder),
      confidence_level: input.confidence_level || '',
      note: input.note || '',
    });
  } catch (e) {
    await logEvent(req.userId, 'ai_process_fail', { reason: 'exception', message: e.message });
    res.status(500).json({ error: '服务器错误', detail: e.message });
  }
});

module.exports = router;
