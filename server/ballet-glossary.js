// Shared ballet vocabulary. Used as Whisper's `prompt` (biases the ASR toward
// these spellings) and kept in one place so a term we add for transcription
// also stays available for the structuring prompt later if we want that.

// Ordered least- to most-important: OpenAI's whisper-1 prompt only keeps the
// FINAL ~224 tokens if the prompt runs long (everything earlier is silently
// dropped), so the terms that most need to survive truncation go LAST, not
// first. Real mis-transcription evidence is in eval/cases.js — e.g.
// "普利耶"=plié, "格朗巴特芒"=grand battement, "皮鲁埃特"=pirouette,
// "tandoo"=tendu, "链转"=chaîné — those anchor the very end of the list.
const BALLET_TERMS = [
  // 较少见/进阶词，排最前（预算不够时最先被截掉）：
  '三位', '四位', '六位', '外开', '甩头',
  'fouetté', 'piqué turn', 'promenade', 'cabriole', 'entrechat',
  'croisé', 'effacé', 'écarté', 'épaulement', 'pointe', 'demi-pointe',
  'alignment', 'adagio', 'petit allegro', 'grand allegro',
  // 常见跳跃类：
  'sauté', 'échappé', 'assemblé', 'jeté', 'grand jeté', 'pas de chat',
  'glissade', 'coupé', 'changement', 'sissonne', 'pas de bourrée',
  'temps levé', 'balancé', 'soutenu', 'cambré',
  // 常用但相对没那么容易听混的把杆/中间动作：
  'rond de jambe', 'frappé', 'fondu', 'développé', 'port de bras',
  'arabesque', 'attitude', 'passé', 'retiré',
  // 高频 + 最容易被听错/转写错的词排最后（最靠近 224 token 窗口、最该保住）：
  'plié', 'tendu', 'dégagé', 'relevé', 'pirouette', 'grand battement',
  'chaîné', 'turnout', 'spotting', '一位', '二位', '五位', '把杆', '足尖',
  '坐胯', '掉胯', '格朗巴特芒', '巴特芒', '巴特梦',
];

// whisper-1 only keeps the final ~224 tokens of a long prompt — everything
// before that is silently dropped, not the tail. So the highest-priority
// terms sit at the end of BALLET_TERMS (see above), and this intro sentence
// is kept short on purpose so it doesn't eat into that budget.
// Derived from BALLET_TERMS so a term added there (e.g. for the structuring
// prompt) automatically biases transcription too — no separate list to drift.
const WHISPER_PROMPT = `芭蕾课后中文口述，夹杂法语动作名称，请按正确写法转写：${BALLET_TERMS.join('、')}。`;

module.exports = { BALLET_TERMS, WHISPER_PROMPT };
