// Pilates counterpart of ballet-glossary.js. Same whisper-1 constraint: only
// the final ~224 tokens of the prompt survive, so the terms most likely to be
// mis-heard go LAST.
const PILATES_TERMS = [
  // 进阶 / 较少见：
  'Corkscrew', 'Jackknife', 'Boomerang', 'Control Balance', 'Snake', 'Twist',
  'Elephant', 'Long Stretch', 'Up Stretch', 'Knee Stretch', 'Tendon Stretch',
  'Pike', 'Roll Down', 'Push Through',
  'Short Box', 'Long Box', 'Ladder Barrel', 'Spine Corrector', 'Wunda Chair', 'Tower',
  // 常见垫上：
  'Roll Up', 'Roll Over', 'Rolling Like a Ball', 'Single Leg Stretch', 'Double Leg Stretch',
  'Criss Cross', 'Spine Stretch', 'Saw', 'Swan', 'Swimming', 'Side Kick', 'Seal', 'Teaser',
  'Shoulder Bridge', 'Leg Circles',
  // 高频 + 最容易被听错的排最后：
  'Reformer', 'Cadillac', 'Chair', 'Mat', 'Footwork', 'Hundred', 'Feet in Straps',
  'Stomach Massage', 'Mermaid', 'Bridge', '核心床', '凯迪拉克', '普拉提椅', '梯桶',
  '红弹簧', '蓝弹簧', '黄弹簧', '绿弹簧', '中立位', '印记', '骨盆后倾', '肋骨外翻',
  '肩胛下沉', '侧肋呼吸', '核心激活', '代偿', '腰椎', '胸椎',
  '垫上', '垫上课', '私教', '小班课', '团课', '器械课', '普拉提',
];

const PILATES_WHISPER_PROMPT = `普拉提课后中文口述，夹杂英文动作和器械名称，请按正确写法转写：${PILATES_TERMS.join('、')}。`;

module.exports = { PILATES_TERMS, PILATES_WHISPER_PROMPT };
