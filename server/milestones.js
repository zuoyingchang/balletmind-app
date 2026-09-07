const db = require('./db');

// Objective milestone celebration (V0.2 #11) — pure counting, never a
// capability judgement. Triggers on the 1st record, then every 10th, and on
// a handful of "nice" consecutive-week streak numbers.
const STREAK_MILESTONES = new Set([2, 4, 8, 12, 26, 52]);

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
    cursor -= 7 * 24 * 60 * 60 * 1000;
  }
  return streak;
}

// Called right after a record is saved. Returns at most one milestone object
// (count takes priority over streak so a user never sees two banners at once)
// or null if this save didn't cross a milestone.
async function checkMilestone(userId) {
  const { c: totalCount } = await db.get('SELECT COUNT(*) AS c FROM records WHERE user_id = ?', [userId]);

  if (totalCount === 1 || (totalCount >= 10 && totalCount % 10 === 0)) {
    return { type: 'count', value: totalCount };
  }

  const streak = await computeWeekStreak(userId);
  if (STREAK_MILESTONES.has(streak)) {
    return { type: 'streak', value: streak };
  }

  return null;
}

module.exports = { checkMilestone, computeWeekStreak };
