// Shared ballet vocabulary. Used as Whisper's `prompt` (biases the ASR toward
// these spellings) and kept in one place so a term we add for transcription
// also stays available for the structuring prompt later if we want that.

const BALLET_TERMS = [
  'plié', 'tendu', 'dégagé', 'rond de jambe', 'frappé', 'fondu', 'développé',
  'grand battement', 'port de bras', 'pirouette', 'chaîné', 'fouetté',
  'piqué turn', 'promenade', 'sauté', 'échappé', 'assemblé', 'jeté',
  'grand jeté', 'sissonne', 'cabriole', 'entrechat', 'changement',
  'arabesque', 'attitude', 'passé', 'retiré', 'croisé', 'effacé', 'écarté',
  'épaulement', 'relevé', 'pointe', 'demi-pointe', 'turnout', 'spotting',
  'alignment', 'adagio', 'petit allegro', 'grand allegro',
  '一位', '二位', '三位', '四位', '五位', '把杆', '足尖', '外开', '甩头',
];

// Whisper only looks at the first ~224 tokens of this prompt as a bias, not as
// instructions. Spoken-style mixed Chinese + French is what actually helps.
const WHISPER_PROMPT = `这是一堂成人芭蕾课后的中文复盘口述，里面会夹杂法语动作名称。请按芭蕾术语的正确写法转写，例如：plié、tendu、dégagé、rond de jambe、frappé、fondu、développé、grand battement、port de bras、pirouette、chaîné、fouetté、piqué、promenade、sauté、échappé、assemblé、jeté、grand jeté、arabesque、attitude、passé、retiré、croisé、relevé、turnout、spotting、一位、二位、五位、把杆、足尖。`;

module.exports = { BALLET_TERMS, WHISPER_PROMPT };
