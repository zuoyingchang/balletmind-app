// Pilates counterpart of ballet-terms.js: glossary rows, history-search chips,
// and alias groups. Same row shape as TERM_GLOSSARY; pron '—' makes the
// play button speak the English name. Alias groups are appended to
// TERM_ALIAS_GROUPS so history search works for both practices.

const PILATES_ALIAS_GROUPS = [
  ['reformer', '核心床', '大器械', '滑床'],
  ['cadillac', 'tower', '凯迪拉克', '高架床'],
  ['wunda chair', 'chair', '普拉提椅', '稳踏椅'],
  ['ladder barrel', '梯桶'],
  ['spine corrector', '脊柱矫正器', '小桶'],
  ['magic circle', '魔术圈', '普拉提圈'],
  ['footwork', '脚部练习'],
  ['hundred', 'the hundred', '百次拍击', '一百次'],
  ['roll up', 'rollup', '卷起', '卷体'],
  ['roll over', 'rollover', '翻滚'],
  ['rolling like a ball', '滚球', '像球一样滚动'],
  ['single leg stretch', '单腿伸展'],
  ['double leg stretch', '双腿伸展'],
  ['criss cross', 'crisscross', '交叉卷腹'],
  ['spine stretch', '脊柱伸展'],
  ['saw', '锯式'],
  ['swan', '天鹅'],
  ['swimming', '游泳'],
  ['side kick', '侧踢'],
  ['teaser', 'v字坐'],
  ['shoulder bridge', 'bridge', '桥式', '肩桥'],
  ['leg circles', '单腿画圈', '画圈'],
  ['seal', '海豹'],
  ['mermaid', '美人鱼'],
  ['elephant', '大象'],
  ['long stretch', '长伸展', '平板'],
  ['knee stretch', '跪姿伸展'],
  ['feet in straps', '脚套绳', '脚套'],
  ['stomach massage', '腹部按摩'],
  ['short box', '短箱'],
  ['long box', '长箱'],
  ['spring', '弹簧', '红弹簧', '蓝弹簧', '黄弹簧', '绿弹簧'],
  ['neutral', '中立位', '骨盆中立'],
  ['imprint', '印记', '腰贴垫'],
  ['肋骨', '肋骨外翻', '肋骨收'],
  ['肩胛', '肩胛下沉', '耸肩'],
  ['breathing', '呼吸', '侧肋呼吸', '胸式呼吸'],
  ['代偿'],
  ['腰', '腰椎', '下背'],
  ['脖子', '颈椎'],
];

const PILATES_SEARCH_CHIPS = ['Footwork', 'Hundred', 'Roll Up', 'Teaser', '弹簧', '肋骨', '代偿'];

const PILATES_GLOSSARY = [
  { group: '器械', rows: [
    { fr: 'Reformer', en: 'reformer', zh: '核心床', pron: '—', desc: '滑床加弹簧和绳子，弹簧越多越重；最常见的器械课' },
    { fr: 'Cadillac', en: 'cadillac', zh: '凯迪拉克', pron: '—', desc: '带架子的床，可以挂弹簧和吊杆，也叫 Tower' },
    { fr: 'Wunda Chair', en: 'wunda chair', zh: '普拉提椅', pron: '—', desc: '带踏板的小椅子，踩踏板练腿和核心，平衡要求高' },
    { fr: 'Ladder Barrel', en: 'ladder barrel', zh: '梯桶', pron: '—', desc: '一边梯子一边圆桶，常用来做伸展和侧弯' },
    { fr: 'Spine Corrector', en: 'spine corrector', zh: '脊柱矫正器', pron: '—', desc: '小号半圆桶，垫在背下做伸展和卷动' },
    { fr: 'Magic Circle', en: 'magic circle', zh: '魔术圈', pron: '—', desc: '有弹性的圈，夹在腿间或手间增加阻力' },
    { fr: 'Spring', en: 'spring', zh: '弹簧', pron: '—', desc: '颜色代表轻重，常见红重、蓝中、黄轻；不同馆可能不一样' },
  ] },
  { group: 'Reformer 动作', rows: [
    { fr: 'Footwork', en: 'footwork', zh: '脚部练习', pron: '—', desc: '躺着用脚推踏杆，脚跟、脚尖、V 字分组做，通常是热身' },
    { fr: 'Feet in Straps', en: 'feet in straps', zh: '脚套绳', pron: '—', desc: '脚套进绳圈做蛙腿、画圈、开合，练腿和骨盆稳定' },
    { fr: 'Long Stretch', en: 'long stretch', zh: '长伸展', pron: '—', desc: '在滑床上做平板推拉，肩和核心要稳住不塌腰' },
    { fr: 'Elephant', en: 'elephant', zh: '大象', pron: '—', desc: '手脚撑着、臀部抬高，用腹部带滑床前后动' },
    { fr: 'Knee Stretch', en: 'knee stretch', zh: '跪姿伸展', pron: '—', desc: '跪在滑床上把滑床往后推，上身保持不动' },
    { fr: 'Stomach Massage', en: 'stomach massage', zh: '腹部按摩', pron: '—', desc: '坐着推踏杆，背保持圆或直，练核心控制' },
    { fr: 'Short Box', en: 'short box', zh: '短箱', pron: '—', desc: '坐在箱子上做后倒、侧弯、扭转，练腹部和脊柱' },
    { fr: 'Mermaid', en: 'mermaid', zh: '美人鱼', pron: '—', desc: '侧坐着推滑床做侧弯，拉伸侧腰' },
  ] },
  { group: '垫上动作', rows: [
    { fr: 'Hundred', en: 'the hundred', zh: '百次拍击', pron: '—', desc: '头肩抬起、手臂上下拍 100 下，配合 5 吸 5 呼' },
    { fr: 'Roll Up', en: 'roll up', zh: '卷起', pron: '—', desc: '从躺着一节一节卷起来坐起，不靠甩' },
    { fr: 'Roll Over', en: 'roll over', zh: '翻滚', pron: '—', desc: '腿从头上翻过去，再一节一节放下来' },
    { fr: 'Rolling Like a Ball', en: 'rolling like a ball', zh: '滚球', pron: '—', desc: '抱腿团成球前后滚，滚回来时保持形状' },
    { fr: 'Single Leg Stretch', en: 'single leg stretch', zh: '单腿伸展', pron: '—', desc: '头肩抬起，两腿交替收和伸' },
    { fr: 'Double Leg Stretch', en: 'double leg stretch', zh: '双腿伸展', pron: '—', desc: '手脚同时伸出再收回，腰不离垫' },
    { fr: 'Criss Cross', en: 'criss cross', zh: '交叉卷腹', pron: '—', desc: '对侧手肘找膝盖的扭转卷腹' },
    { fr: 'Spine Stretch', en: 'spine stretch', zh: '脊柱伸展', pron: '—', desc: '坐着向前卷，像越过一个球' },
    { fr: 'Saw', en: 'saw', zh: '锯式', pron: '—', desc: '坐着扭转再前倾，手去够对侧小脚趾' },
    { fr: 'Swan', en: 'swan', zh: '天鹅', pron: '—', desc: '趴着把上身抬起的伸展，靠背不是靠腰挤' },
    { fr: 'Swimming', en: 'swimming', zh: '游泳', pron: '—', desc: '趴着对侧手脚交替快速上下' },
    { fr: 'Side Kick', en: 'side kick', zh: '侧踢', pron: '—', desc: '侧躺前后踢腿，骨盆不跟着晃' },
    { fr: 'Teaser', en: 'teaser', zh: 'V 字坐', pron: '—', desc: '身体和腿抬成 V 字，最考核心控制' },
    { fr: 'Shoulder Bridge', en: 'bridge', zh: '桥式', pron: '—', desc: '躺着把骨盆抬起，一节一节起落' },
    { fr: 'Leg Circles', en: 'leg circles', zh: '单腿画圈', pron: '—', desc: '一条腿在空中画圈，骨盆保持不动' },
    { fr: 'Seal', en: 'seal', zh: '海豹', pron: '—', desc: '滚球的变体，滚回来时脚掌拍三下' },
  ] },
  { group: '身体提示词', rows: [
    { fr: 'Neutral', en: 'neutral pelvis', zh: '骨盆中立', pron: '—', desc: '躺着时腰下留一点自然空隙，不压平也不拱起' },
    { fr: 'Imprint', en: 'imprint', zh: '印记', pron: '—', desc: '腰轻轻贴向垫子，常用在腿抬起的动作里保护腰' },
    { fr: 'Ribs', en: 'ribs', zh: '肋骨收', pron: '—', desc: '肋骨不往外翻，前胸不顶起来' },
    { fr: 'Scapula', en: 'shoulder blades', zh: '肩胛下沉', pron: '—', desc: '肩膀远离耳朵，肩胛往下往后放' },
    { fr: 'Breathing', en: 'lateral breathing', zh: '侧肋呼吸', pron: '—', desc: '吸气时肋骨往两侧和后面打开，肚子不鼓' },
    { fr: 'Core', en: 'powerhouse', zh: '核心', pron: '—', desc: '腹部、背部、骨盆底一起发力，普拉提叫 powerhouse' },
    { fr: 'Articulation', en: 'articulation', zh: '逐节卷动', pron: '—', desc: '脊柱一节一节动，不是整块一起起来' },
    { fr: 'Compensation', en: 'compensation', zh: '代偿', pron: '—', desc: '该用的肌肉没用上，别的地方替它用力，比如腰代替腹部' },
  ] },
];

const pilatesApi = { PILATES_ALIAS_GROUPS, PILATES_SEARCH_CHIPS, PILATES_GLOSSARY };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = pilatesApi;
} else {
  Object.assign(globalThis, pilatesApi);
  if (typeof TERM_ALIAS_GROUPS !== 'undefined') TERM_ALIAS_GROUPS.push(...PILATES_ALIAS_GROUPS);
}
