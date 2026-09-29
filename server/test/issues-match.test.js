process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || 'file::memory:';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-do-not-use-in-prod';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isSimilar, extractTerm } = require('../issues');

test('plié and plie with the same remainder are the same issue', () => {
  assert.equal(isSimilar('plié 膝盖没蹲够', 'plie 膝盖没蹲够'), true);
  assert.equal(isSimilar('plie 膝盖没蹲够', 'plié 膝盖没蹲够'), true);
});

test('développé and developpe with the same remainder are the same issue', () => {
  assert.equal(isSimilar('développé 腿没伸直', 'developpe 腿没伸直'), true);
});

test('turnout and 外开 with the same remainder are the same issue', () => {
  assert.equal(isSimilar('turnout 不够', '外开不够'), true);
  assert.equal(isSimilar('外开 骨盆前倾', 'turnout 骨盆前倾'), true);
});

test('a line that used both turnout and 外开 still matches a later 外开-only line', () => {
  assert.equal(isSimilar('turnout 不够，外开要再打开', '外开还是不够'), true);
});

test('same move with different body-part leftovers stay separate issues', () => {
  assert.equal(isSimilar('turnout 骨盆前倾', '外开 膝盖内扣'), false);
});

test('蹲 and plié with the same remainder are the same issue', () => {
  assert.equal(isSimilar('蹲 膝盖没对脚趾', 'plié 膝盖没对脚趾'), true);
});

test('extractTerm maps 外开 to the same id as turnout', () => {
  assert.equal(extractTerm('外开不够').canonical, extractTerm('turnout 不够').canonical);
});

test('body-part words like 膝盖 are not treated as the named move', () => {
  assert.equal(extractTerm('蹲 膝盖没对脚趾').canonical, extractTerm('plié 膝盖没对脚趾').canonical);
  assert.equal(extractTerm('膝盖内扣'), null);
});

test('same named move with only evaluative filler is one issue', () => {
  assert.equal(isSimilar('jeté 需要改进', 'jeté'), true);
  assert.equal(isSimilar('jeté', 'Jeté 需要改进'), true);
});

test('grand battement and Grand battement collapse to one card', () => {
  const { collapseSimilarIssueRows } = require('../issues');
  const rows = collapseSimilarIssueRows([
    { id: 1, text: 'grand battement', status: 'open', occurrence_count: 2, occurrences: [{ recordId: 1, createdAt: 1 }] },
    { id: 2, text: 'Grand battement', status: 'open', occurrence_count: 2, occurrences: [{ recordId: 2, createdAt: 2 }] },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].occurrence_count, 2);
});

test('collapseSimilarIssueRows keeps one card and adds counts', () => {
  const { collapseSimilarIssueRows } = require('../issues');
  const rows = collapseSimilarIssueRows([
    { id: 1, text: 'jeté 需要改进', status: 'open', occurrence_count: 1, occurrences: [] },
    { id: 2, text: 'jeté', status: 'open', occurrence_count: 2, occurrences: [] },
    { id: 3, text: '重心不稳', status: 'open', occurrence_count: 1, occurrences: [] },
  ]);
  assert.equal(rows.length, 2);
  const jete = rows.find((r) => /jet/i.test(r.text));
  assert.equal(jete.occurrence_count, 3);
  assert.deepEqual(jete.mergedIds.sort(), [1, 2]);
});
