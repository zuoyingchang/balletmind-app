const db = require('./db');

// Two ledgers (do not merge into one “成就”):
//   写下了 — recap rows only. Home「复盘 N 次」, badges「记录 N 次」,
//             save ceremony 1/3/5…, 课记 list. Check-in never increments this.
//   来过   — any visit (check-in or recap). Calendar pink days, archive「来过」,
//             home/share daily streak, hours, week badges/milestones.
// Daily streak (days) ≠ week badges (weeks). Streak toast only on the first
// visit of a week, copy says 来过, never 「记下了 N 次」.
const COUNT_MILESTONES = new Set([1, 3, 5]);
const STREAK_MILESTONES = new Set([2, 4, 8, 12, 26, 52]);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function mondayOf(ts) {
  const d = new Date(ts);
  const day = d.getDay() || 7; // Mon=1..Sun=7
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day + 1);
  return d.getTime();
}

async function computeWeekStreak(userId) {
  const rows = await db.all('SELECT created_at FROM records WHERE user_id = ?', [userId]);
  const weekSet = new Set(rows.map((r) => mondayOf(r.created_at)));
  let streak = 0;
  let cursor = mondayOf(Date.now());
  while (weekSet.has(cursor)) {
    streak++;
    cursor -= WEEK_MS;
  }
  return streak;
}

// Called right after a record is saved. `source: 'checkin'` never fires
// recap-count banners (打卡不算写下了). Streak only fires on the first
// visit of a week, so sitting on a nice number doesn't repeat the toast.
async function checkMilestone(userId, opts = {}) {
  const fromCheckin = opts.source === 'checkin';

  if (!fromCheckin) {
    const { c: totalCount } = await db.get(
      'SELECT COUNT(*) AS c FROM records WHERE user_id = ? AND COALESCE(is_checkin_only, 0) = 0',
      [userId]
    );

    if (COUNT_MILESTONES.has(totalCount) || (totalCount >= 10 && totalCount % 5 === 0)) {
      return { type: 'count', value: totalCount };
    }
  }

  const rows = await db.all('SELECT created_at FROM records WHERE user_id = ?', [userId]);
  if (!rows.length) return null;
  const thisWeek = mondayOf(Date.now());
  const firstVisitThisWeek = rows.filter((r) => mondayOf(r.created_at) === thisWeek).length === 1;
  if (!firstVisitThisWeek) return null;

  const weekSet = new Set(rows.map((r) => mondayOf(r.created_at)));
  let streak = 0;
  let cursor = thisWeek;
  while (weekSet.has(cursor)) {
    streak++;
    cursor -= WEEK_MS;
  }
  if (STREAK_MILESTONES.has(streak)) {
    return { type: 'streak', value: streak };
  }

  return null;
}

module.exports = { checkMilestone, computeWeekStreak };
