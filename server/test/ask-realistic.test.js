const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAskDateRange } = require('../ai/ask-daterange');
const { retrieveAskRecords } = require('../ai/ask-retrieve');
const { buildAskDigest, stripAskFillers } = require('../ai/ask-digest');

const DAY = 24 * 60 * 60 * 1000;

function archive(now) {
  return [
    {
      id: 1, class_name: '基训',
      good_points: '定点更稳\n外开比上周清楚',
      improve_points: '转圈还是晃',
      next_time_reminder: '',
      created_at: now - 2 * DAY,
    },
    {
      id: 2, class_name: '把杆',
      good_points: '手位更稳',
      improve_points: '脚背再绷',
      next_time_reminder: '',
      created_at: now - 5 * DAY,
    },
    {
      id: 3, class_name: '基训',
      good_points: '一位手更开',
      improve_points: '内收肌力量',
      next_time_reminder: '',
      created_at: now - 10 * DAY,
    },
    {
      id: 4, class_name: '跳跃组合',
      good_points: '',
      improve_points: '落地膝盖没对脚趾',
      next_time_reminder: '小跳先想落地',
      created_at: now - 20 * DAY,
    },
    {
      id: 5, class_name: '基训',
      good_points: '呼吸更顺',
      improve_points: 'pirouette 一圈不稳',
      next_time_reminder: '',
      created_at: now - 40 * DAY,
    },
  ];
}

function texts(digest, id) {
  const sec = (digest.sections || []).find((s) => s.id === id);
  return sec ? sec.lines.map((l) => l.text) : [];
}

async function ask(question, records, now) {
  const dateRange = parseAskDateRange(question, now);
  const rows = dateRange
    ? records.filter((r) => r.created_at >= dateRange.since && r.created_at <= dateRange.until)
    : records;
  const searchQuestion = dateRange ? question.replace(dateRange.matchedText, '').trim() : question;
  const topicless = !!dateRange && !stripAskFillers(searchQuestion);
  const round = topicless
    ? { matches: rows.slice(0, 8) }
    : await retrieveAskRecords(rows, searchQuestion, { mode: 'keyword', limit: 8 });
  return buildAskDigest({ records: round.matches, issues: [], question: searchQuestion });
}

test('realistic: 最近2周进步 lists good lines in the window, not old classes or improve leftovers', async () => {
  const now = Date.now();
  const digest = await ask('最近2周进步', archive(now), now);
  assert.deepEqual(digest.sections.map((s) => s.id), ['good']);
  const good = texts(digest, 'good');
  assert.ok(good.includes('定点更稳'));
  assert.ok(good.includes('手位更稳'));
  assert.ok(good.includes('一位手更开'));
  assert.ok(!good.includes('呼吸更顺'));
  assert.ok(!texts(digest, 'improve').length);
});

test('realistic: 最近两周带改善 lists improve lines in the window', async () => {
  const now = Date.now();
  const digest = await ask('最近两周带改善', archive(now), now);
  assert.deepEqual(digest.sections.map((s) => s.id), ['improve']);
  const improve = texts(digest, 'improve');
  assert.ok(improve.includes('转圈还是晃'));
  assert.ok(improve.includes('脚背再绷'));
  assert.ok(improve.includes('内收肌力量'));
  assert.ok(!improve.includes('落地膝盖没对脚趾'));
  assert.ok(!improve.includes('pirouette 一圈不稳'));
});

test('realistic: 外开最近几天怎么样 stays on turnout in the last week', async () => {
  const now = Date.now();
  const digest = await ask('外开最近几天怎么样', archive(now), now);
  assert.deepEqual(texts(digest, 'good'), ['外开比上周清楚']);
  assert.ok(!texts(digest, 'improve').includes('转圈还是晃'));
});

test('realistic: 转圈最近几天怎么样 does not pull month-old pirouette', async () => {
  const now = Date.now();
  const digest = await ask('转圈最近几天怎么样', archive(now), now);
  assert.deepEqual(texts(digest, 'improve'), ['转圈还是晃']);
  assert.ok(!texts(digest, 'improve').includes('pirouette 一圈不稳'));
});

test('realistic: 转圈 without a date still finds older pirouette lines', async () => {
  const now = Date.now();
  const digest = await ask('转圈', archive(now), now);
  const improve = texts(digest, 'improve');
  assert.ok(improve.includes('转圈还是晃'));
  assert.ok(improve.includes('pirouette 一圈不稳'));
});

test('realistic: 把杆课记了什么 is that class, not the whole archive', async () => {
  const now = Date.now();
  const digest = await ask('把杆课记了什么', archive(now), now);
  assert.deepEqual(texts(digest, 'good'), ['手位更稳']);
  assert.deepEqual(texts(digest, 'improve'), ['脚背再绷']);
});

test('realistic: 最近3天 overview keeps both buckets from in-window classes', async () => {
  const now = Date.now();
  const digest = await ask('最近3天', archive(now), now);
  assert.ok(texts(digest, 'good').includes('定点更稳'));
  assert.ok(texts(digest, 'improve').includes('转圈还是晃'));
  assert.ok(!texts(digest, 'good').includes('手位更稳'));
});
