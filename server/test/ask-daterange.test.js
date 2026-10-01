const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAskDateRange } = require('../ai/ask-daterange');

const DAY_MS = 24 * 60 * 60 * 1000;
// Fixed instant: Wed 2026-03-11 15:00:00 local time, so week/month boundaries are unambiguous.
const NOW = new Date(2026, 2, 11, 15, 0, 0).getTime();

test('plain questions with no time expression return null', () => {
  assert.equal(parseAskDateRange('转圈的时候有什么问题', NOW), null);
  assert.equal(parseAskDateRange('基训课最近有什么问题', NOW), null);
});

test('最近/近/这 N 天 is a rolling N-day window ending now', () => {
  for (const q of ['最近3天我的进步', '近3天我的进步', '这3天我的进步']) {
    const r = parseAskDateRange(q, NOW);
    assert.ok(r, q);
    assert.equal(r.since, NOW - 3 * DAY_MS);
    assert.equal(r.until, NOW);
  }
});

test('matchedText is the exact substring to strip before retrieval, leaving the real topic behind', () => {
  const r = parseAskDateRange('最近十天我的进步', NOW);
  assert.ok(r);
  assert.equal(r.matchedText, '最近十天');
  assert.equal('最近十天我的进步'.replace(r.matchedText, '').trim(), '我的进步');
});

test('Chinese numerals resolve, including 两', () => {
  const r = parseAskDateRange('这两周基训课有没有进步', NOW);
  assert.ok(r);
  assert.equal(r.since, NOW - 2 * 7 * DAY_MS);
  assert.equal(r.until, NOW);
});

test('N 个月 is a rolling 30*N-day window', () => {
  const r = parseAskDateRange('最近2个月有什么问题', NOW);
  assert.ok(r);
  assert.equal(r.since, NOW - 2 * 30 * DAY_MS);
  assert.equal(r.until, NOW);
});

test('今天 starts at local midnight', () => {
  const r = parseAskDateRange('今天练得怎么样', NOW);
  assert.ok(r);
  assert.equal(r.since, new Date(2026, 2, 11, 0, 0, 0).getTime());
  assert.equal(r.until, NOW);
});

test('昨天 is the full previous calendar day, excluding today', () => {
  const r = parseAskDateRange('昨天有什么问题', NOW);
  assert.ok(r);
  const todayStart = new Date(2026, 2, 11, 0, 0, 0).getTime();
  assert.equal(r.since, todayStart - DAY_MS);
  assert.equal(r.until, todayStart - 1);
});

test('这周/本周 starts Monday of the current week', () => {
  // 2026-03-11 is a Wednesday; Monday of that week is 2026-03-09.
  const r = parseAskDateRange('这周有没有进步', NOW);
  assert.ok(r);
  assert.equal(r.since, new Date(2026, 2, 9, 0, 0, 0).getTime());
  assert.equal(r.until, NOW);
});

test('上周 is the full previous Mon-Sun week, excluding this week', () => {
  const r = parseAskDateRange('上周有什么问题', NOW);
  assert.ok(r);
  const thisWeekStart = new Date(2026, 2, 9, 0, 0, 0).getTime();
  assert.equal(r.since, thisWeekStart - 7 * DAY_MS);
  assert.equal(r.until, thisWeekStart - 1);
});

test('这个月/本月 starts on the 1st of the current month', () => {
  const r = parseAskDateRange('这个月练得怎么样', NOW);
  assert.ok(r);
  assert.equal(r.since, new Date(2026, 2, 1).getTime());
  assert.equal(r.until, NOW);
});

test('上个月 is the full previous calendar month, excluding this month', () => {
  const r = parseAskDateRange('上个月有什么问题', NOW);
  assert.ok(r);
  assert.equal(r.since, new Date(2026, 1, 1).getTime());
  assert.equal(r.until, new Date(2026, 2, 1).getTime() - 1);
});

test('今年 starts on Jan 1st of the current year', () => {
  const r = parseAskDateRange('今年进步大吗', NOW);
  assert.ok(r);
  assert.equal(r.since, new Date(2026, 0, 1).getTime());
  assert.equal(r.until, NOW);
});
