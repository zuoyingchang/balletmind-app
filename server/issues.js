const db = require('./db');
const { splitLines } = require('./lib/text');

// Recurring Issue Tracking (V0.2 PRD #1) — deliberately NOT AI-based. Matching
// a new "improve_points" line against existing open issues is plain text
// normalization + containment, so there is no model in the loop to hallucinate
// a pattern that isn't really there, and status only ever changes when the
// user clicks a button. "AI不替用户下结论" — literally true here: there's no AI.

function normalize(s) {
  return (s || '').trim().toLowerCase().replace(/[，。！？,.!?\s]/g, '');
}

function isSimilar(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // loose containment match — catches "重心不稳" vs "重心还是不太稳" without NLP
  return na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na));
}

// Called after a record is saved. Matches each line of improve_points against
// this user's open (non-resolved) issues; bumps the count on a match, opens a
// new issue otherwise. Every match/create is also logged in issue_occurrences
// so the UI can link each issue back to the specific records it came from.
async function processRecordForIssues(userId, recordId, improvePointsText) {
  const lines = splitLines(improvePointsText);
  if (lines.length === 0) return;

  const openIssues = await db.all(
    "SELECT * FROM issues WHERE user_id = ? AND status != 'resolved'",
    [userId]
  );

  for (const line of lines) {
    const match = openIssues.find((issue) => isSimilar(issue.text, line));
    const now = Date.now();
    if (match) {
      await db.run(
        'UPDATE issues SET occurrence_count = occurrence_count + 1, last_record_id = ?, updated_at = ? WHERE id = ?',
        [recordId, now, match.id]
      );
      await db.run(
        'INSERT INTO issue_occurrences (issue_id, record_id, created_at) VALUES (?, ?, ?)',
        [match.id, recordId, now]
      );
      match.occurrence_count += 1; // keep in-memory list consistent within this loop
    } else {
      const info = await db.run(
        `INSERT INTO issues (user_id, text, status, occurrence_count, first_record_id, last_record_id, created_at, updated_at)
         VALUES (?, ?, 'open', 1, ?, ?, ?, ?)`,
        [userId, line, recordId, recordId, now, now]
      );
      await db.run(
        'INSERT INTO issue_occurrences (issue_id, record_id, created_at) VALUES (?, ?, ?)',
        [info.lastInsertRowid, recordId, now]
      );
      openIssues.push({ id: info.lastInsertRowid, text: line, status: 'open', occurrence_count: 1 });
    }
  }
}

// Issues + the record dates/ids they trace back to (evidence linking).
async function listIssuesWithOccurrences(userId) {
  const issues = await db.all(
    'SELECT * FROM issues WHERE user_id = ? ORDER BY occurrence_count DESC, updated_at DESC',
    [userId]
  );
  if (issues.length === 0) return [];

  const occurrences = await db.all(
    `SELECT io.issue_id, io.record_id, r.created_at, r.class_name
     FROM issue_occurrences io
     JOIN records r ON r.id = io.record_id
     WHERE io.issue_id IN (${issues.map(() => '?').join(',')})
     ORDER BY r.created_at ASC`,
    issues.map((i) => i.id)
  );

  return issues.map((issue) => ({
    ...issue,
    occurrences: occurrences
      .filter((o) => o.issue_id === issue.id)
      .map((o) => ({ recordId: o.record_id, createdAt: o.created_at, className: o.class_name })),
  }));
}

module.exports = { processRecordForIssues, listIssuesWithOccurrences, isSimilar };
