const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAskDigest } = require('../ai/ask-digest');
const { searchRecordsByQuestion } = require('../../public/js/ballet-terms');

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

test('ask digest keeps only lines that match the question, not the rest of the recap', () => {
  const digest = buildAskDigest({
    question: '最近外开怎么样',
    records: [{
      id: 4,
      class_name: '基训',
      good_points: '外开已成习惯\ntendu\nplié',
      improve_points: '内收肌力量\npirouette 一圈不稳',
      created_at: new Date(2026, 8, 30).getTime(),
    }],
    issues: [],
  });
  assert.deepEqual(digest.sections.map((s) => s.id), ['good']);
  assert.deepEqual(digest.sections[0].lines.map((l) => l.text), ['外开已成习惯']);
});

test('ask digest keeps a wrapped item as one line with no extra split', () => {
  const long = '这句特别长，一行挤不下也要能看清条与条之间的横线分隔';
  const digest = buildAskDigest({
    question: '基训',
    records: [{
      id: 1,
      class_name: '基训',
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

test('ask digest keeps a retrieved recap when the question is a paraphrase with no keyword in the line', () => {
  const digest = buildAskDigest({
    question: '感觉站不太住',
    records: [{
      id: 1,
      class_name: '基训',
      good_points: '',
      improve_points: '转圈的时候重心不稳',
      next_time_reminder: '多练习定点',
      created_at: 1,
    }],
    issues: [],
  });
  assert.equal(digest.answered, true);
  assert.match(digest.sections.find((s) => s.id === 'improve').lines.map((l) => l.text).join('\n'), /重心不稳/);
});

function sampleArchive() {
  return [
    {
      id: 11,
      class_name: '基训',
      good_points: '外开已成习惯\n定点比上次稳',
      improve_points: '转圈的时候重心不稳\n内收肌力量',
      next_time_reminder: '',
      created_at: new Date(2026, 8, 12).getTime(),
    },
    {
      id: 12,
      class_name: '把杆',
      good_points: '手位更稳',
      improve_points: '脚背再绷',
      next_time_reminder: '',
      created_at: new Date(2026, 8, 18).getTime(),
    },
    {
      id: 13,
      class_name: '跳跃组合',
      good_points: '',
      improve_points: '落地膝盖没对脚趾',
      next_time_reminder: '小跳先想落地',
      created_at: new Date(2026, 8, 22).getTime(),
    },
    {
      id: 14,
      class_name: '基训',
      good_points: '一位手更开',
      improve_points: 'pirouette 一圈不稳',
      next_time_reminder: '',
      created_at: new Date(2026, 8, 28).getTime(),
    },
  ];
}

function digestAsk(question, records) {
  return buildAskDigest({
    question,
    records: searchRecordsByQuestion(records, question, 8),
    issues: [],
  });
}

test('realistic questions keep only the asked topic, one line per recap item', () => {
  const records = sampleArchive();
  const turnout = digestAsk('最近外开怎么样', records);
  assert.deepEqual(turnout.sections.find((s) => s.id === 'good').lines.map((l) => l.text), ['外开已成习惯']);
  assert.ok(!turnout.sections.find((s) => s.id === 'improve'));

  const spin = digestAsk('转圈还在晃吗', records);
  const spinImprove = spin.sections.find((s) => s.id === 'improve').lines.map((l) => l.text);
  assert.ok(spinImprove.includes('转圈的时候重心不稳'));
  assert.ok(spinImprove.includes('pirouette 一圈不稳'));
  assert.ok(!spinImprove.includes('脚背再绷'));
  assert.ok(!spinImprove.includes('落地膝盖没对脚趾'));

  const barre = digestAsk('把杆课记了什么', records);
  assert.deepEqual(barre.sections.find((s) => s.id === 'good').lines.map((l) => l.text), ['手位更稳']);
  assert.deepEqual(barre.sections.find((s) => s.id === 'improve').lines.map((l) => l.text), ['脚背再绷']);

  const jump = digestAsk('跳跃落地怎么样', records);
  assert.match(jump.sections.find((s) => s.id === 'improve').lines.map((l) => l.text).join('\n'), /落地膝盖没对脚趾/);
  assert.ok(!jump.sections.find((s) => s.id === 'improve').lines.some((l) => l.text.includes('外开')));
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
