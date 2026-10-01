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
  ['spotting', '甩头', '定点'],
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

// Beginner glossary: French (classroom spelling) · English (easy to type) · Chinese ·
// desc (one-line plain-language explanation) · pron (Chinese phonetic reading, for
// display next to the tap-to-hear button -- see speakTerm() in index.html, which
// uses the browser's own French text-to-speech voice, not a recorded audio file).
const TERM_GLOSSARY = [
  { group: '把杆', rows: [
    { fr: 'plié', en: 'plie', zh: '蹲', pron: '普利耶', desc: '膝盖弯曲，脚跟不离地；蹲到脚跟离地就是 grand plié' },
    { fr: 'demi-plié', en: 'demi-plie', zh: '半蹲', pron: '德米·普利耶', desc: '小幅度蹲，脚跟始终贴地，几乎每个组合开头都会做' },
    { fr: 'grand plié', en: 'grand plie', zh: '大蹲', pron: '格朗·普利耶', desc: '蹲到最低，一二五位时脚跟会离地' },
    { fr: 'tendu', en: 'tendu', zh: '擦地', pron: '唐迪', desc: '脚沿地面伸出去，脚尖绷直，腿不抬离地面' },
    { fr: 'dégagé', en: 'degage', zh: '小踢', pron: '德加热', desc: '比擦地多一步，脚尖离地几厘米' },
    { fr: 'rond de jambe', en: 'rond de jambe', zh: '划圈', pron: '隆德让布', desc: '腿在地面或空中画一个圆' },
    { fr: 'frappé', en: 'frappe', zh: '打击', pron: '法拉佩', desc: '脚从脚踝处快速打出去，像小弹击的动作' },
    { fr: 'fondu', en: 'fondu', zh: '单腿蹲', pron: '芳丢', desc: '一条腿支撑蹲下，像"融化"一样慢慢下沉' },
    { fr: 'développé', en: 'developpe', zh: '伸展', pron: '德维洛佩', desc: '腿从吸腿位慢慢向外展开、伸直' },
    { fr: 'grand battement', en: 'battement', zh: '大踢腿', pron: '格朗·巴特芒', desc: '腿快速有力地踢到最高，再落回原位' },
    { fr: 'port de bras', en: 'port de bras', zh: '手臂动作', pron: '波尔德布拉', desc: '手臂从一个手位过渡到另一个手位的动作' },
    { fr: 'relevé', en: 'releve', zh: '半脚尖', pron: '赫勒维', desc: '踮起脚跟，用半脚尖或全脚尖站立' },
    { fr: 'cambré', en: 'cambre', zh: '胸腰', pron: '康布雷', desc: '上身从腰部向后或向侧弯，常在把杆最后做' },
    { fr: 'coupé', en: 'coupe', zh: '切腿', pron: '古佩', desc: '一只脚快速切到另一只脚的脚踝，做为过渡动作' },
  ]},
  { group: '转与跳', rows: [
    { fr: 'pirouette', en: 'pirouette', zh: '单足转', pron: '皮鲁埃特', desc: '单腿支撑原地转圈，另一腿收在吸腿位' },
    { fr: 'chaîné', en: 'chaine', zh: '链转', pron: '谢内', desc: '双脚交替、连续快速转圈，像一条链子一样移动' },
    { fr: 'fouetté', en: 'fouette', zh: '挥鞭转', pron: '富埃泰', desc: '一条腿像挥鞭子一样甩动带动身体连续转圈' },
    { fr: 'piqué', en: 'pique', zh: '点转', pron: '皮克', desc: '直腿踩点半脚尖或足尖，借力转一圈' },
    { fr: 'promenade', en: 'promenade', zh: '慢转', pron: '普罗姆纳德', desc: '保持一个造型，脚跟小步移动慢慢转一圈' },
    { fr: 'sauté', en: 'saute', zh: '小跳', pron: '索泰', desc: '原地或小范围的跳跃，落地轻巧' },
    { fr: 'échappé', en: 'echappe', zh: '跳开', pron: '埃夏佩', desc: '从五位跳开成二位或四位，再跳回五位' },
    { fr: 'assemblé', en: 'assemble', zh: '集合跳', pron: '阿桑布雷', desc: '一腿先出去，跳起后双腿在空中并拢再落地' },
    { fr: 'jeté', en: 'jete', zh: '抛跳', pron: '热泰', desc: '一腿向外抛出，重心从一只脚换到另一只脚' },
    { fr: 'grand jeté', en: 'grand jete', zh: '大跳', pron: '格朗·热泰', desc: '向前大幅度跨跳，空中呈一字或劈叉造型' },
    { fr: 'pas de bourrée', en: 'pas de bourree', zh: '波列步', pron: '帕德布雷', desc: '双脚交替的小碎步，常用来过渡到下一个动作' },
    { fr: 'changement', en: 'changement', zh: '变脚跳', pron: '尚日芒', desc: '原地跳起，双脚在空中交换前后位置' },
    { fr: 'glissade', en: 'glissade', zh: '滑步', pron: '格利萨德', desc: '一脚向旁滑出带动身体移动，另一脚跟上五位' },
    { fr: 'pas de chat', en: 'pas de chat', zh: '猫跳', pron: '帕德夏', desc: '两腿依次屈膝提起再落地，像猫一样轻盈' },
    { fr: 'soutenu', en: 'soutenu', zh: '收腿转', pron: '苏特努', desc: '双腿收紧成五位，踮脚原地转一圈' },
    { fr: 'chassé', en: 'chasse', zh: '追步', pron: '沙塞', desc: '一脚追赶另一脚，带动身体向前或向旁移动' },
    { fr: 'temps levé', en: 'temps leve', zh: '单腿小跳', pron: '唐·勒维', desc: '单腿支撑原地小跳，另一腿保持姿态不动' },
  ]},
  { group: '姿态与课堂', rows: [
    { fr: 'arabesque', en: 'arabesque', zh: '阿拉贝斯克', pron: '阿拉贝斯克', desc: '单腿站立，另一腿向后伸直抬起的经典造型' },
    { fr: 'attitude', en: 'attitude', zh: '阿蒂蒂德', pron: '阿蒂蒂德', desc: '单腿站立，另一腿向后（或前）屈膝抬起的造型' },
    { fr: 'passé', en: 'passe', zh: '吸腿', pron: '帕塞', desc: '脚尖贴着支撑腿膝盖内侧收起，也叫 retiré' },
    { fr: 'retiré', en: 'retire', zh: '吸腿', pron: '尔蒂雷', desc: '和 passé 是同一个位置，脚收在支撑腿膝盖旁' },
    { fr: 'pointe', en: 'pointe', zh: '足尖', pron: '普安特', desc: '穿足尖鞋，用脚尖完全立起' },
    { fr: 'barre', en: 'barre', zh: '把杆', pron: '巴尔', desc: '课堂前半段扶着练习用的横杆' },
    { fr: '(turnout)', en: 'turnout', zh: '外开', pron: '—', desc: '髋关节向外旋转，让大腿、小腿、脚尽量朝外——芭蕾最基础的身体条件，通常直接用英文 turnout 称呼，没有固定的法语课堂用词' },
    { fr: 'spotting', en: 'spotting', zh: '甩头', pron: '—', desc: '转圈时眼睛盯住一点、头最后甩过去，用来防止头晕；英文术语，没有对应法语词' },
    { fr: 'alignment', en: 'alignment', zh: '身体对位', pron: '—', desc: '肩、髋、膝、脚踝等关节上下对齐、不歪斜；和"身体线条"（line，指造型好不好看）是两个概念，别搞混了' },
    { fr: 'hanches', en: 'hips', zh: '髋部', pron: '昂什', desc: '髋部/胯；常说的"掉胯""坐胯"就是指髋部没控制住，往下沉或往旁边斜' },
  ]},
  { group: '课堂用语', rows: [
    { fr: 'en dehors', en: 'outward', zh: '向外转', pron: '昂德欧尔', desc: '转的方向朝支撑腿外侧，比如 pirouette en dehors；和"外开"（turnout）不是一回事，这个说的是转向' },
    { fr: 'en dedans', en: 'inward', zh: '向内转', pron: '昂德当', desc: '转的方向朝支撑腿内侧，和 en dehors 相对' },
    { fr: 'épaulement', en: 'epaulement', zh: '身体转位', pron: '埃波尔芒', desc: '肩膀和身体相对腿的角度，让造型不是死板地正对前方' },
    { fr: 'croisé', en: 'croise', zh: '交叉方向', pron: '克瓦泽', desc: '身体斜对观众/镜子，两腿在视觉上呈交叉状态的方向' },
    { fr: 'effacé', en: 'efface', zh: '斜开方向', pron: '埃法塞', desc: '身体斜对观众/镜子，两腿在视觉上呈打开状态的方向' },
    { fr: 'en croix', en: 'en croix', zh: '十字位', pron: '昂克华', desc: '按前、旁、后、旁的顺序做一遍动作，因为路径像个十字' },
    { fr: 'en face', en: 'en face', zh: '正面', pron: '昂法斯', desc: '身体正对镜子或观众' },
    { fr: 'adagio', en: 'adagio', zh: '慢板组合', pron: '阿达吉欧', desc: '节奏慢、强调控制和延展的组合；这个词其实来自意大利语，不是法语' },
    { fr: 'allegro', en: 'allegro', zh: '快板跳跃组合', pron: '阿莱格罗', desc: '节奏快、以跳跃为主的组合；同样是意大利语来源' },
  ]},
  { group: '脚位', rows: [
    { fr: 'première', en: 'first', zh: '一位', pron: '普雷米耶尔', desc: '两脚跟并拢，脚尖分别向外打开成一条线' },
    { fr: 'seconde', en: 'second', zh: '二位', pron: '瑟公德', desc: '两脚分开约一脚半的距离，脚尖朝外' },
    { fr: 'troisième', en: 'third', zh: '三位', pron: '特瓦兹耶姆', desc: '一脚跟贴在另一脚足弓中间，较少单独使用' },
    { fr: 'quatrième', en: 'fourth', zh: '四位', pron: '卡特里耶姆', desc: '一脚在前一脚在后，前后分开一脚距离' },
    { fr: 'cinquième', en: 'fifth', zh: '五位', pron: '森基耶姆', desc: '一脚跟贴在另一脚脚尖处，两脚完全贴合' },
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
// strong: a recognized ballet-term alias, or an explicit Latin/digit word the
// question actually spelled out -- specific enough that a record NOT
// matching any of these probably isn't what was asked about.
// weak: generic sliding-bigram tokens -- cheap paraphrase recall, but a
// high-frequency word like "改进" turns into its own bigram and matches
// almost every improve_points line, so these must never outweigh a strong
// token match (see searchRecordsByQuestion).
function questionTokens(question) {
  const folded = foldBalletText(question);
  if (!folded) return { strong: [], weak: [] };
  const termTokens = [];
  for (const group of TERM_ALIAS_GROUPS) {
    if (group.some((alias) => folded.includes(foldBalletText(alias)))) {
      termTokens.push(...group.map(foldBalletText));
    }
  }
  if (/(spotting|甩头|定点|转头|头转)/.test(folded)) {
    ['spotting', '甩头', '定点', '转头', '头转'].forEach((t) => termTokens.push(t));
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
  return {
    strong: [...new Set([...termTokens, ...latinWords])],
    weak: [...new Set(bigrams)],
  };
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
  const { strong, weak } = questionTokens(question);
  // "最近tendu有什么要改进的" used to flood back nearly every improve_points
  // line in the archive: "改进" alone became a bigram token worth the same
  // +1 as "tendu", so nothing calling out a term was ever required to
  // actually be about it. Once the question names a real term (strong is
  // non-empty), a record MUST match one of those -- weak bigram overlap no
  // longer counts on its own, only as a tiebreaker alongside a strong hit.
  const scored = (records || [])
    .map((r) => {
      const hay = foldBalletText([r.class_name, r.good_points, r.improve_points, r.next_time_reminder].join('\n'));
      const strongScore = strong.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
      const weakScore = weak.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
      const score = strong.length ? (strongScore > 0 ? strongScore * 100 + weakScore : 0) : weakScore;
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
