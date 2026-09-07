const db = require('./db');

async function listCorrections(userId) {
  return db.all('SELECT * FROM term_corrections WHERE user_id = ? ORDER BY created_at DESC', [userId]);
}

async function addCorrection(userId, wrongTerm, correctTerm) {
  const now = Date.now();
  const info = await db.run(
    'INSERT INTO term_corrections (user_id, wrong_term, correct_term, created_at) VALUES (?, ?, ?, ?)',
    [userId, wrongTerm, correctTerm, now]
  );
  return { id: info.lastInsertRowid, wrong_term: wrongTerm, correct_term: correctTerm, created_at: now };
}

// Rendered into the AI system prompt so future generations prefer terms the
// user has already confirmed — "记住用户手动修正的芭蕾术语，优先匹配用户修正版本".
async function correctionsAsPromptHint(userId) {
  const rows = await listCorrections(userId);
  if (rows.length === 0) return '';
  const lines = rows.map((r) => `"${r.wrong_term}" 应写作 "${r.correct_term}"`).join('；');
  return `\n\n这位用户过去手动纠正过以下芭蕾术语识别错误，本次整理如果遇到类似表述，请优先采用用户确认过的写法：${lines}。`;
}

module.exports = { listCorrections, addCorrection, correctionsAsPromptHint };
