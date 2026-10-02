// Parses a time expression out of an ask-archive question ("最近3天我的进步",
// "上周有什么问题", "这个月练得怎么样") into a {since, until} window, so the
// /api/progress/ask retrieval can filter records to that window BEFORE
// keyword/embedding matching runs. Without this, "最近3天" was just text the
// keyword matcher ignored -- any record containing "进步" anywhere in its
// history would match regardless of age. Returns null when the question has
// no recognizable time expression (existing no-filter behavior).

const DAY_MS = 24 * 60 * 60 * 1000;

const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function parseCount(s) {
  if (/^[0-9]+$/.test(s)) return Number(s);
  return CN_NUM[s] != null ? CN_NUM[s] : null;
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfWeek(ts) {
  const d = new Date(startOfDay(ts));
  const day = d.getDay();
  const fromMonday = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - fromMonday);
  return d.getTime();
}

function startOfMonth(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function startOfYear(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), 0, 1).getTime();
}

const NUM = '([0-9一二两三四五六七八九十]+)';

/**
 * @param {string} question
 * @param {number} [now]
 * @returns {{since:number, until:number, label:string, matchedText:string}|null}
 */
function parseAskDateRange(question, now = Date.now()) {
  const q = String(question || '');

  let m = q.match(new RegExp(`(?:最近|近|这)\\s*${NUM}\\s*(?:天|日)`));
  if (m) {
    const n = parseCount(m[1]);
    if (n) return { since: now - n * DAY_MS, until: now, label: `最近${n}天`, matchedText: m[0] };
  }

  m = q.match(/最近几天|这几天|近几天/);
  if (m) {
    return { since: now - 7 * DAY_MS, until: now, label: '最近几天', matchedText: m[0] };
  }

  m = q.match(new RegExp(`(?:最近|近|这)\\s*${NUM}\\s*周`));
  if (m) {
    const n = parseCount(m[1]);
    if (n) return { since: now - n * 7 * DAY_MS, until: now, label: `最近${n}周`, matchedText: m[0] };
  }

  m = q.match(new RegExp(`(?:最近|近|这)\\s*${NUM}\\s*个?月`));
  if (m) {
    const n = parseCount(m[1]);
    if (n) return { since: now - n * 30 * DAY_MS, until: now, label: `最近${n}个月`, matchedText: m[0] };
  }

  m = q.match(/昨天/);
  if (m) {
    const todayStart = startOfDay(now);
    return { since: todayStart - DAY_MS, until: todayStart - 1, label: '昨天', matchedText: m[0] };
  }
  m = q.match(/今天/);
  if (m) {
    return { since: startOfDay(now), until: now, label: '今天', matchedText: m[0] };
  }
  m = q.match(/上(?:个)?(?:周|星期)/);
  if (m) {
    const thisWeekStart = startOfWeek(now);
    return { since: thisWeekStart - 7 * DAY_MS, until: thisWeekStart - 1, label: '上周', matchedText: m[0] };
  }
  m = q.match(/(?:这(?:个)?|本)(?:周|星期)/);
  if (m) {
    return { since: startOfWeek(now), until: now, label: '这周', matchedText: m[0] };
  }
  m = q.match(/上(?:个)?月/);
  if (m) {
    const thisMonthStart = startOfMonth(now);
    const d = new Date(now);
    const lastMonthStart = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
    return { since: lastMonthStart, until: thisMonthStart - 1, label: '上个月', matchedText: m[0] };
  }
  m = q.match(/(?:这个?|本)月/);
  if (m) {
    return { since: startOfMonth(now), until: now, label: '这个月', matchedText: m[0] };
  }
  m = q.match(/今年/);
  if (m) {
    return { since: startOfYear(now), until: now, label: '今年', matchedText: m[0] };
  }

  return null;
}

module.exports = { parseAskDateRange };
