// Shared ballet term aliases: French (accented), English/ASCII, typeable IPA, Chinese.
// Used by history search. Keep groups small — only terms adult recaps actually say.

function foldBalletText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae');
}

const TERM_ALIAS_GROUPS = [
  ['plié', 'plie', 'pli.e', '蹲'],
  ['tendu', 'tandoo', '擦地'],
  ['dégagé', 'degage', '小踢'],
  ['rond de jambe', 'ronddejambe', '划圈'],
  ['frappé', 'frappe', '打击'],
  ['fondu', '单腿蹲'],
  ['développé', 'developpe', '伸展'],
  ['grand battement', 'battement', '大踢腿', '大踢', '格朗巴特芒', '巴特芒', '巴特梦'],
  ['port de bras', 'portdebras', '手臂动作'],
  ['pirouette', '单足转'],
  ['chaîné', 'chaine', '链转'],
  ['fouetté', 'fouette', '挥鞭转'],
  ['piqué', 'pique', '点转'],
  ['promenade', '慢转'],
  ['sauté', 'saute', '小跳'],
  ['échappé', 'echappe'],
  ['assemblé', 'assemble'],
  ['jeté', 'jete', '抛跳'],
  ['grand jeté', 'grand jete', '大跳'],
  ['arabesque', '阿拉贝斯克'],
  ['attitude', '阿蒂蒂德'],
  ['passé', 'passe', 'retiré', 'retire', '吸腿'],
  ['relevé', 'releve', '半脚尖'],
  ['pointe', '足尖'],
  ['turnout', '外开'],
  ['spotting', '甩头'],
  ['alignment', '身体线条'],
  ['barre', '把杆'],
  ['core', '核心'],
  ['重心'],
  ['膝盖'],
  ['骨盆'],
  ['脚踝'],
  ['肩膀'],
  ['髋部', '髋'],
  ['坐胯', '掉胯', '坐髋'],
  ['脚尖'],
];

const HISTORY_SEARCH_CHIPS = ['plié', 'tendu', 'pirouette', 'passé', 'arabesque', '外开', '把杆'];

// Beginner glossary: French (classroom spelling) · English (easy to type) · Chinese.
const TERM_GLOSSARY = [
  { group: '把杆', rows: [
    { fr: 'plié', en: 'plie', zh: '蹲' },
    { fr: 'tendu', en: 'tendu', zh: '擦地' },
    { fr: 'dégagé', en: 'degage', zh: '小踢' },
    { fr: 'rond de jambe', en: 'rond de jambe', zh: '划圈' },
    { fr: 'frappé', en: 'frappe', zh: '打击' },
    { fr: 'fondu', en: 'fondu', zh: '单腿蹲' },
    { fr: 'développé', en: 'developpe', zh: '伸展' },
    { fr: 'grand battement', en: 'battement', zh: '大踢腿' },
    { fr: 'port de bras', en: 'port de bras', zh: '手臂动作' },
    { fr: 'relevé', en: 'releve', zh: '半脚尖' },
  ]},
  { group: '转与跳', rows: [
    { fr: 'pirouette', en: 'pirouette', zh: '单足转' },
    { fr: 'chaîné', en: 'chaine', zh: '链转' },
    { fr: 'fouetté', en: 'fouette', zh: '挥鞭转' },
    { fr: 'piqué', en: 'pique', zh: '点转' },
    { fr: 'promenade', en: 'promenade', zh: '慢转' },
    { fr: 'sauté', en: 'saute', zh: '小跳' },
    { fr: 'échappé', en: 'echappe', zh: '跳开' },
    { fr: 'assemblé', en: 'assemble', zh: '集合跳' },
    { fr: 'jeté', en: 'jete', zh: '抛跳' },
    { fr: 'grand jeté', en: 'grand jete', zh: '大跳' },
  ]},
  { group: '姿态与课堂', rows: [
    { fr: 'arabesque', en: 'arabesque', zh: '阿拉贝斯克' },
    { fr: 'attitude', en: 'attitude', zh: '阿蒂蒂德' },
    { fr: 'passé', en: 'passe', zh: '吸腿' },
    { fr: 'retiré', en: 'retire', zh: '吸腿' },
    { fr: 'pointe', en: 'pointe', zh: '足尖' },
    { fr: 'barre', en: 'barre', zh: '把杆' },
    { fr: 'en dehors', en: 'turnout', zh: '外开' },
    { fr: 'spotting', en: 'spotting', zh: '甩头' },
    { fr: 'alignment', en: 'alignment', zh: '身体线条' },
    { fr: 'hanches', en: 'hips', zh: '坐胯 / 掉胯' },
  ]},
  { group: '脚位', rows: [
    { fr: 'première', en: 'first', zh: '一位' },
    { fr: 'seconde', en: 'second', zh: '二位' },
    { fr: 'troisième', en: 'third', zh: '三位' },
    { fr: 'quatrième', en: 'fourth', zh: '四位' },
    { fr: 'cinquième', en: 'fifth', zh: '五位' },
  ]},
];

function expandSearchNeedles(keyword) {
  const q = foldBalletText(keyword).trim();
  if (!q) return [];
  const needles = new Set([q]);
  for (const group of TERM_ALIAS_GROUPS) {
    const folded = group.map(foldBalletText);
    const exact = folded.includes(q);
    const prefix = q.length >= 3 && folded.some((alias) => alias.startsWith(q) || (q.length >= 4 && alias.includes(q)));
    if (!exact && !prefix) continue;
    folded.forEach((alias) => needles.add(alias));
  }
  return [...needles];
}

function recordMatchesSearch(record, keyword) {
  const needles = expandSearchNeedles(keyword);
  if (needles.length === 0) return true;
  const hay = foldBalletText([
    record.class_name,
    record.transcript,
    record.good_points,
    record.improve_points,
    record.next_time_reminder,
    record.session_tips,
  ].join('\n'));
  return needles.some((needle) => hay.includes(needle));
}

// Retrieval for "问问你的档案" (ask-your-archive). A free-form question like
// "我最近转圈老在说什么" won't appear verbatim in any record, so unlike
// recordMatchesSearch (built for typed search terms) this breaks the
// question into overlap-able tokens first: recognized ballet-term aliases,
// plus generic word/character n-grams with obvious filler words dropped.
// This is the cheap first pass. Embedding only runs when keyword hits are
// sparse (see server/ai/ask-retrieve.js).
const ASK_STOPWORDS = new Set([
  '的', '了', '我', '是', '吗', '呢', '什么', '老', '在', '说', '最近', '上次',
  '这次', '一下', '都', '过', '着', '和', '与', '给', '把', '还', '就', '也', '有',
]);
function questionTokens(question) {
  const folded = foldBalletText(question);
  if (!folded) return [];
  const termTokens = [];
  for (const group of TERM_ALIAS_GROUPS) {
    if (group.some((alias) => folded.includes(foldBalletText(alias)))) {
      termTokens.push(...group.map(foldBalletText));
    }
  }
  const stripped = folded.replace(/[，。？！,.?!、；;""'']/g, ' ');
  // Latin/digit runs (English term spellings, numbers) as whole-word tokens.
  const latinWords = (stripped.match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 2);
  // Everything else: a *sliding* 2-character window, not fixed non-overlapping
  // chunks — "我转圈的" chunked as "我转"/"圈的" would never produce "转圈"
  // even though it's the word that actually matters, since it straddles a
  // chunk boundary. Overlapping windows catch it regardless of position.
  const cjkOnly = stripped.replace(/[a-z0-9]/g, ' ');
  const bigrams = [];
  for (let i = 0; i < cjkOnly.length - 1; i++) {
    const pair = cjkOnly.slice(i, i + 2);
    if (/\s/.test(pair) || ASK_STOPWORDS.has(pair)) continue;
    bigrams.push(pair);
  }
  return [...new Set([...termTokens, ...latinWords, ...bigrams])];
}
function recapFieldIntent(question) {
  const q = foldBalletText(question);
  const good = /做得好|好的地方|优点/.test(q);
  const improve = /待改进|还要改|需要改进|改进的地方|做得不好/.test(q);
  return { good, improve };
}

function recordsForFieldIntent(records, intent, limit) {
  const sorted = [...(records || [])].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  const hasGood = (r) => String(r.good_points || '').trim();
  const hasImprove = (r) => String(r.improve_points || '').trim() || String(r.next_time_reminder || '').trim();
  let pool = sorted;
  if (intent.good && !intent.improve) pool = sorted.filter(hasGood);
  else if (intent.improve && !intent.good) pool = sorted.filter(hasImprove);
  else if (intent.good && intent.improve) pool = sorted.filter((r) => hasGood(r) || hasImprove(r));
  else return [];
  return pool.slice(0, limit);
}

function searchRecordsByQuestion(records, question, limit = 3) {
  const tokens = questionTokens(question);
  const scored = (records || [])
    .map((r) => {
      const hay = foldBalletText([r.class_name, r.good_points, r.improve_points, r.next_time_reminder].join('\n'));
      const score = tokens.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
      return { record: r, score };
    })
    .filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score || b.record.created_at - a.record.created_at);
  if (scored.length) return scored.slice(0, limit).map((x) => x.record);
  const intent = recapFieldIntent(question);
  if (intent.good || intent.improve) return recordsForFieldIntent(records, intent, limit);
  return [];
}

function stripEvalTails(text) {
  let t = String(text || '').trim().replace(/^[·•\-]\s*/, '');
  const tail = /(?:\s|，|,|、|。)*((做得?|做的)\s*(很|挺|比较|还)?(不错|好|棒)|得(很|挺|比较|还)?(不错|好|棒)|还可以|还不错|挺好|很好|不错|可以|尚可|挺不错|还凑合|凑合|需要再注意|需要改进|需要加强|需要注意|待改进|还行|一般般)\s*[了啊呢吧。！.]*$/u;
  for (let i = 0; i < 6; i += 1) {
    const next = t.replace(tail, '').trim();
    if (next === t) break;
    t = next;
  }
  t = t.replace(/^(这次课|这节课|今天这节课|今天课)(上)?(我们)?/, '').trim();
  t = t.replace(/[了啊呢吧]+$/u, '').trim();
  return t;
}

function compactPhrase(s, maxLen = 28) {
  let t = stripEvalTails(s).replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen && !/需要多加练习|的时候/.test(t)) return t;
  t = t.replace(/^(我觉得|我感觉|老师说)/, '');
  t = t.replace(/需要多加练习|不太好|不够好/g, '');
  t = t.replace(/[^，。；;、\n]{0,8}的时候/g, '');
  t = t.replace(/[，。；;]+/g, '、').replace(/、+/g, '、').replace(/^、|、$/g, '');
  if (t.length > maxLen) t = `${t.slice(0, maxLen - 1)}…`;
  return t.trim();
}

const api = {
  foldBalletText,
  TERM_ALIAS_GROUPS,
  HISTORY_SEARCH_CHIPS,
  TERM_GLOSSARY,
  expandSearchNeedles,
  recordMatchesSearch,
  questionTokens,
  searchRecordsByQuestion,
  compactPhrase,
  stripEvalTails,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  Object.assign(globalThis, api);
}
