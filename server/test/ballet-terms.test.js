const test = require('node:test');
const assert = require('node:assert/strict');
const {
  foldBalletText,
  expandSearchNeedles,
  recordMatchesSearch,
  extractIssueKeywords,
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

test('extractIssueKeywords returns 1–3 terms actually present, including aliases', () => {
  const keys = extractIssueKeywords('蹲的时候骨盆晃，核心没站住，膝盖也软');
  assert.ok(keys.includes('蹲'));
  assert.ok(keys.length >= 1 && keys.length <= 3);
  assert.deepEqual(extractIssueKeywords('plié 膝盖方向不对'), ['plié', '膝盖']);
});

test('expandSearchNeedles for 蹲 includes ascii plie', () => {
  const needles = expandSearchNeedles('蹲');
  assert.ok(needles.includes('plie'));
  assert.ok(needles.includes('蹲'));
});
