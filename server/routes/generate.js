const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// System prompt from the Prompt Design Document
const SYSTEM_PROMPT = `你是一个芭蕾训练笔记整理助手。
你的任务是根据用户语音转写后的内容，整理用户本次训练的复盘信息。
你只能基于用户明确提供的信息进行提取、归纳和结构化，不可以编造用户没有提到的问题、优点或训练建议。
请将用户的口述内容整理为以下三个主要部分：做得好的地方、待改进点、下次练习注意事项。
如果用户提供的信息不足，不要自行补充内容，应明确标注"用户描述信息有限"。
如果某些内容可能由于语音识别错误而存在歧义，不要擅自修改为你认为正确的芭蕾术语，应降低confidence_level，并在note中说明。
只输出严格符合以下JSON Schema的内容，不要输出任何额外的解释性文字、Markdown代码块标记或其他内容：
{"good_points": "字符串,做得好的地方,多条用换行分隔,若无则为空字符串", "improve_points": "字符串,待改进点,多条用换行分隔,若无则为空字符串", "next_time_reminder": "字符串,下次练习注意事项,多条用换行分隔,若无则为空字符串", "confidence_level": "高/中/低", "note": "字符串,说明信息不足或术语存疑等情况,若无异常则为空字符串"}`;

// POST /api/generate  { transcript } -> AI structured draft
// The Anthropic API key never reaches the browser — it only lives here, on the server.
router.post('/', requireAuth, async (req, res) => {
  const { transcript } = req.body || {};
  if (!transcript || !transcript.trim()) {
    return res.status(400).json({ error: '缺少语音转写内容' });
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
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: 'AI服务调用失败，请Retry', detail: errText });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    if (!textBlock) return res.status(502).json({ error: 'AI未返回有效内容' });

    let clean = textBlock.text
      .trim()
      .replace(/^```json\s*/, '')
      .replace(/^```\s*/, '')
      .replace(/```\s*$/, '');

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      return res.status(502).json({ error: 'AI返回格式解析失败，请Retry', raw: clean });
    }
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: '服务器错误', detail: e.message });
  }
});

module.exports = router;
