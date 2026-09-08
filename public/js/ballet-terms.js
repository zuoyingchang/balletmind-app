// Shared ballet term aliases: French (accented), English/ASCII, typeable IPA, Chinese.
// Used by history search and keyword chips. Keep groups small — only terms
// adult recaps actually say, not a dictionary dump.

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

function extractIssueKeywords(text, limit = 3) {
  const hay = foldBalletText(text);
  if (!hay) return [];
  const found = [];
  const groups = TERM_ALIAS_GROUPS.slice().sort((a, b) => {
    const la = Math.max(...a.map((t) => foldBalletText(t).length));
    const lb = Math.max(...b.map((t) => foldBalletText(t).length));
    return lb - la;
  });
  for (const group of groups) {
    const shown = group.find((alias) => hay.includes(foldBalletText(alias)));
    if (!shown) continue;
    const key = foldBalletText(shown);
    if (found.some((t) => {
      const ft = foldBalletText(t);
      return ft.includes(key) || key.includes(ft);
    })) continue;
    found.push(shown);
    if (found.length >= limit) break;
  }
  return found;
}

const api = {
  foldBalletText,
  TERM_ALIAS_GROUPS,
  HISTORY_SEARCH_CHIPS,
  expandSearchNeedles,
  recordMatchesSearch,
  extractIssueKeywords,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  Object.assign(globalThis, api);
}
