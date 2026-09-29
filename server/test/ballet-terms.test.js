const test = require('node:test');
const assert = require('node:assert/strict');
const {
  foldBalletText,
  expandSearchNeedles,
  recordMatchesSearch,
  compactPhrase,
} = require('../../public/js/ballet-terms');

test('plie / plié / 蹲 / pli.e belong to the same search group', () => {
  assert.equal(foldBalletText('plié'), 'plie');
  const rec = { good_points: '一位 plié 更稳', improve_points: '', transcript: '', class_name: '', next_time_reminder: '' };
  assert.equal(recordMatchesSearch(rec, 'plie'), true);
  assert.equal(recordMatchesSearch(rec, 'PLIE'), true);
  assert.equal(recordMatchesSearch(rec, '蹲'), true);
  assert.equal(recordMatchesSearch(rec, 'pli.e'), true);

  const chinese = { good_points: '蹲的时候膝盖要朝着脚趾', improve_points: '', transcript: '', class_name: '', next_time_reminder: '' };
  assert.equal(recordMatchesSearch(chinese, 'plie'), true);
  assert.equal(recordMatchesSearch(chinese, 'plié'), true);
});

test('searching 外开 finds turnout, and tendu finds 擦地', () => {
  assert.equal(recordMatchesSearch({ good_points: 'turnout 还不够', improve_points: '', transcript: '', class_name: '', next_time_reminder: '' }, '外开'), true);
  assert.equal(recordMatchesSearch({ good_points: '擦地脚尖没伸直', improve_points: '', transcript: '', class_name: '', next_time_reminder: '' }, 'tendu'), true);
});

test('compactPhrase keeps the action and drops spoken filler', () => {
  assert.equal(compactPhrase('转的时候骨盆晃，重心不稳，需要多加练习'), '骨盆晃、重心不稳');
  assert.equal(compactPhrase('重心不稳'), '重心不稳');
  assert.equal(compactPhrase('pirouette 重心不稳、核心不够'), 'pirouette 重心不稳、核心不够');
  assert.equal(compactPhrase('tendu 做得还不错'), 'tendu');
  assert.equal(compactPhrase('plié 需要改进'), 'plié');
});

test('specific how/where is kept after dropping praise tails', () => {
  const { stripEvalTails } = require('../../public/js/ballet-terms');
  const { compactReviewField, uniqueCompactGoodPoints } = require('../lib/text');
  assert.equal(stripEvalTails('tendu 膝盖打开得好'), 'tendu 膝盖打开');
  assert.equal(stripEvalTails('tendu，膝盖打开得好'), 'tendu，膝盖打开');
  assert.equal(stripEvalTails('tendu 做得不错'), 'tendu');
  assert.match(stripEvalTails('这次课我们整个人往上拎，整个的身子腿都往上拎了'), /往上拎/);
  assert.match(stripEvalTails('这次课我们整个人往上拎，整个的身子腿都往上拎了'), /身子腿/);
  assert.equal(stripEvalTails('grand battement 胯动了'), 'grand battement 胯动');
  assert.equal(stripEvalTails('spotting 不够'), 'spotting 不够');
  assert.equal(stripEvalTails('往上拎需要再注意'), '往上拎');
  assert.equal(
    compactReviewField(['tendu 膝盖打开得好', 'tendu 做得不错', 'tendu']),
    'tendu 膝盖打开'
  );
  const lift = uniqueCompactGoodPoints(['这次课我们整个人往上拎，整个的身子腿都往上拎了']);
  assert.equal(lift.length, 1);
  assert.match(lift[0], /往上拎/);
  assert.doesNotMatch(lift[0], /这次课我们/);
});

test('compactReviewField strips praise tails and duplicate lines', () => {
  const { compactReviewField } = require('../lib/text');
  assert.equal(
    compactReviewField(['tendu 做得不错', 'tendu', 'plié 需要改进']),
    'tendu\nplié'
  );
});

test('expandSearchNeedles for 蹲 includes ascii plie', () => {
  const needles = expandSearchNeedles('蹲');
  assert.ok(needles.includes('plie'));
  assert.ok(needles.includes('蹲'));
});

test('巴特梦 and 坐胯 map onto battement / hip-sit aliases', () => {
  assert.equal(recordMatchesSearch({
    good_points: '',
    improve_points: 'grand battement 高度不够',
    transcript: '',
    class_name: '',
    next_time_reminder: '',
  }, '巴特梦'), true);
  assert.equal(recordMatchesSearch({
    good_points: '',
    improve_points: '坐胯了',
    transcript: '',
    class_name: '',
    next_time_reminder: '',
  }, '掉胯'), true);
});

const { searchRecordsByQuestion } = require('../../public/js/ballet-terms');

test('generic 做得好 / 待改进 questions fall back to recent recap fields', () => {
  const recs = [
    { id: 1, class_name: '基训', good_points: 'tendu 脚尖伸直', improve_points: '', next_time_reminder: '', created_at: 2 },
    { id: 2, class_name: '基训', good_points: '', improve_points: '重心后坐', next_time_reminder: '', created_at: 1 },
  ];
  const goodHits = searchRecordsByQuestion(recs, '我最近有哪些做得好的地方', 3);
  assert.equal(goodHits.length, 1);
  assert.equal(goodHits[0].id, 1);
  const improveHits = searchRecordsByQuestion(recs, '我最近有哪些需要改进的地方', 3);
  assert.equal(improveHits.length, 1);
  assert.equal(improveHits[0].id, 2);
  const battementHits = searchRecordsByQuestion(recs.concat({
    id: 3, class_name: '基训', good_points: '', improve_points: 'grand battement 高度不够', next_time_reminder: '', created_at: 3,
  }), '我的巴特梦做得怎么样', 3);
  assert.equal(battementHits[0].id, 3);
});
