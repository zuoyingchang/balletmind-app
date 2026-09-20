// Frozen corpus + questions for ask retrieval A/B.
// Two buckets:
//   standard   — wording overlaps the record; keyword should hit
//   paraphrase — same meaning, different words; keyword should be empty or 1
// Run: cd server && npm run eval:ask-retrieve
// Without OPENAI_API_KEY this still prints the keyword column. Pass --live-embed
// (and a real key) to fill embedding / hybrid columns.

const CORPUS = [
  {
    id: 1,
    class_name: '基训',
    good_points: '',
    improve_points: '转圈的时候重心不稳',
    next_time_reminder: '多练习定点',
    created_at: 4,
  },
  {
    id: 2,
    class_name: '基训',
    good_points: '',
    improve_points: 'tendu 脚掌中部没踩实',
    next_time_reminder: '',
    created_at: 3,
  },
  {
    id: 3,
    class_name: '基训',
    good_points: '',
    improve_points: '手臂位置不对',
    next_time_reminder: '',
    created_at: 2,
  },
  {
    id: 4,
    class_name: '基训',
    good_points: '',
    improve_points: 'spotting 没看住',
    next_time_reminder: '',
    created_at: 1,
  },
];

const CASES = [
  {
    id: 'std-turn',
    bucket: 'standard',
    q: '转圈重心不稳',
    expectIds: [1],
    expectKeywordMin: 1,
    note: '用词和记录一致',
  },
  {
    id: 'std-tendu',
    bucket: 'standard',
    q: 'tendu 脚掌',
    expectIds: [2],
    expectKeywordMin: 1,
    note: '术语原文',
  },
  {
    id: 'std-spot',
    bucket: 'standard',
    q: 'spotting',
    expectIds: [4],
    expectKeywordMin: 1,
    note: '术语原文',
  },
  {
    id: 'para-balance',
    bucket: 'paraphrase',
    q: '感觉站不太住',
    expectIds: [1],
    expectKeywordMax: 0,
    note: '记录写「重心不稳」，问法换成站不稳',
  },
  {
    id: 'para-foot',
    bucket: 'paraphrase',
    q: '往外抹地那一下脚心是虚的',
    expectIds: [2],
    expectKeywordMax: 0,
    note: '记录写 tendu 脚掌，问法避开 tendu/擦地',
  },
  {
    id: 'para-spot',
    bucket: 'paraphrase',
    q: '转的时候眼睛对不上那个点',
    expectIds: [4],
    expectKeywordMax: 1,
    note: '记录写 spotting，问法换成眼睛定点；「转的」可能擦到转圈那条',
  },
  {
    id: 'neg-unrelated',
    bucket: 'negative',
    q: '完全无关的问题xyz',
    expectIds: [],
    expectKeywordMax: 0,
    note: '关键词和向量都应该空，不能为了召回而误伤',
  },
];

module.exports = { CORPUS, CASES };
