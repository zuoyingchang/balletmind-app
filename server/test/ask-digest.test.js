const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAskDigest } = require('../ai/ask-digest');

test('ask digest splits good and improve into cited lines', () => {
  const digest = buildAskDigest({
    question: '基训',
    records: [{
      id: 9,
      class_name: '基训',
      good_points: '定点比上次稳\n一位手更开',
      improve_points: '胯不要掉',
      next_time_reminder: '',
      created_at: new Date(2026, 8, 29).getTime(),
    }],
    issues: [],
  });
  assert.equal(digest.answered, true);
  assert.deepEqual(digest.sections.map((s) => s.id), ['good', 'improve']);
  assert.equal(digest.sections[0].lines[0].text, '定点比上次稳');
  assert.equal(digest.sections[0].lines[0].cite, '基训 9月29日');
  assert.equal(digest.sections[1].lines[0].text, '胯不要掉');
  assert.match(digest.answerPoints.join('\n'), /定点比上次稳（基训 9月29日）/);
});

test('ask digest keeps a wrapped item as one line with no extra split', () => {
  const long = '这句特别长，一行挤不下也要能看清条与条之间的横线分隔';
  const digest = buildAskDigest({
    question: '基训',
    records: [{
      id: 1,
      class_name: '把杆',
      good_points: long,
      improve_points: '',
      created_at: new Date(2026, 8, 1).getTime(),
    }],
    issues: [],
  });
  assert.equal(digest.sections[0].lines.length, 1);
  assert.equal(digest.sections[0].lines[0].text, long);
});

test('ask digest adds 已解决 when the question is about the archive', () => {
  const digest = buildAskDigest({
    question: '我的档案',
    records: [],
    issues: [{
      status: 'resolved',
      text: 'plié 膝盖没对脚趾',
      occurrences: [{ recordId: 3, createdAt: new Date(2026, 8, 10).getTime(), className: '基训' }],
    }],
  });
  assert.equal(digest.sections[0].id, 'resolved');
  assert.equal(digest.sections[0].lines[0].cite, '基训 9月10日');
});

test('ask digest lists all three sections for 我的档案', () => {
  const digest = buildAskDigest({
    question: '我的档案',
    records: [{
      id: 2,
      class_name: '把杆',
      good_points: '手位更稳',
      improve_points: '脚背再绷',
      created_at: new Date(2026, 8, 20).getTime(),
    }],
    issues: [{
      status: 'resolved',
      text: 'plié 膝盖没对脚趾',
      occurrences: [{ recordId: 2, createdAt: new Date(2026, 8, 1).getTime(), className: '基训' }],
    }],
  });
  assert.deepEqual(digest.sections.map((s) => s.id), ['good', 'improve', 'resolved']);
  assert.equal(digest.sections[0].lines[0].cite, '把杆 9月20日');
});

test('ask digest skips unrelated resolved issues on a specific question', () => {
  const digest = buildAskDigest({
    question: '转圈',
    records: [],
    issues: [{
      status: 'resolved',
      text: 'tendu 脚背没绷',
      occurrences: [{ recordId: 3, createdAt: Date.now(), className: '基训' }],
    }],
  });
  assert.equal(digest.answered, false);
});
