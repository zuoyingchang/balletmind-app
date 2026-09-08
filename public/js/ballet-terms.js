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
  ['tendu', '擦地'],
  ['dégagé', 'degage', '小踢'],
  ['rond de jambe', 'ronddejambe', '划圈'],
  ['frappé', 'frappe', '打击'],
  ['fondu', '单腿蹲'],
  ['développé', 'developpe', '伸展'],
  ['grand battement', '大踢腿', '大踢'],
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
    { fr: 'grand battement', en: 'grand battement', zh: '大踢腿' },
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
  ].join('\n'));
  return needles.some((needle) => hay.includes(needle));
}

function compactPhrase(s, maxLen = 28) {
  let t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen && !/需要多加练习|需要加强|的时候/.test(t)) return t;
  t = t.replace(/^(我觉得|我感觉|老师说)/, '');
  t = t.replace(/需要多加练习|需要加强|不太好|不够好/g, '');
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
  compactPhrase,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  Object.assign(globalThis, api);
}
