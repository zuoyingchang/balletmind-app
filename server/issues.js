const db = require('./db');
const { splitLines } = require('./lib/text');
const { BALLET_TERMS } = require('./ballet-glossary');

// Recurring Issue Tracking (V0.2 PRD #1) — deliberately NOT AI-based. Matching
// a new "improve_points" line against existing open issues is plain text
// normalization + containment, so there is no model in the loop to hallucinate
// a pattern that isn't really there, and status only ever changes when the
// user clicks a button. "AI不替用户下结论" — literally true here: there's no AI.

function normalize(s) {
  return (s || '').trim().toLowerCase().replace(/[，。！？,.!?\s]/g, '');
}

// Longest terms first so "grand battement" wins over a shorter term it
// happens to contain. Terms under 3 normalized characters are skipped —
// too common on their own to be a useful signal (e.g. two-character
// position names).
const TERMS_BY_LENGTH = [...BALLET_TERMS]
  .map(normalize)
  .filter((t) => t.length >= 3)
  .sort((a, b) => b.length - a.length);

// The one named move/term a line is about, e.g. "grand battement 一般般"
// and "Grand battement 需要改进" both extract "grandbattement" even though
// the rest of the sentence differs.
function extractTerm(s) {
  const norm = normalize(s);
  return TERMS_BY_LENGTH.find((t) => norm.includes(t)) || null;
}

// Generic evaluative filler with no actual content — "一般般" and "需要改进"
// both just mean "not good enough" without saying what's wrong. Stripped out
// before comparing what's left of a line, same idea as ASK_STOPWORDS in
// ballet-terms.js for the ask-archive tokenizer.
const GENERIC_FILLER = [
  '一般般', '一般', '还行', '还可以', '不错', '不够好', '不够', '不太好', '不太行',
  '需要改进', '需要加强', '需要注意', '还需努力', '还要努力', '有待提高', '待提高',
  '继续加油', '继续努力', '继续保持', '加油', '多加练习', '多练习', '多练', '可以更好', '要注意',
].map(normalize).sort((a, b) => b.length - a.length);

function stripFiller(s) {
  let out = s;
  for (const f of GENERIC_FILLER) out = out.split(f).join('');
  return out;
}

// Cheap, deterministic "do these two leftover snippets share any real
// content" check — sliding 2-character window, works for CJK and Latin
// alike without needing word segmentation.
function hasOverlap(a, b) {
  if (a.length < 2 || b.length < 2) return a === b;
  const grams = new Set();
  for (let i = 0; i < a.length - 1; i++) grams.add(a.slice(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) if (grams.has(b.slice(i, i + 2))) return true;
  return false;
}

// NOT symmetric on purpose: `existingText` is an already-stored issue's
// text, `newLine` is the incoming improve_points line being matched against
// it (see the one call site below — always isSimilar(issue.text, line)).
// The direction matters for the same-term branch: a vague new line ("一般般")
// safely buckets into whatever existing issue already covers that term, but
// a SPECIFIC new line must not get silently absorbed by an existing issue
// that turned out to be vague itself — otherwise the first vague mention of
// a term becomes a black hole that swallows every later, unrelated specific
// complaint about the same move.
function isSimilar(existingText, newLine) {
  const na = normalize(existingText);
  const nb = normalize(newLine);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // loose containment match — catches "重心不稳" vs "重心还是不太稳" without NLP
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true;
  // same named ballet term, then look at what's left after stripping it and
  // generic filler like "一般般"/"需要改进".
  const ta = extractTerm(existingText);
  const tb = extractTerm(newLine);
  if (!ta || ta !== tb) return false;
  const rNew = stripFiller(nb.split(tb).join(''));
  if (!rNew) return true; // new line says nothing specific -- safe to bucket here
  const rExisting = stripFiller(na.split(ta).join(''));
  if (!rExisting) return false; // existing issue has no specific content either -- don't let it absorb a real complaint
  return hasOverlap(rExisting, rNew);
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

// Called when a record is deleted. Takes that record out of every issue it was
// counted in: drops its occurrence rows, recomputes each issue's count and
// first/last record, and removes an issue that has no evidence left. The user's
// own status choice on a surviving issue is untouched.
async function removeRecordFromIssues(userId, recordId) {
  const affected = await db.all(
    `SELECT DISTINCT io.issue_id AS id
     FROM issue_occurrences io JOIN issues i ON i.id = io.issue_id
     WHERE io.record_id = ? AND i.user_id = ?`,
    [recordId, userId]
  );
  await db.run(
    'DELETE FROM issue_occurrences WHERE record_id = ? AND issue_id IN (SELECT id FROM issues WHERE user_id = ?)',
    [recordId, userId]
  );
  for (const { id } of affected) {
    const rest = await db.all(
      `SELECT io.record_id FROM issue_occurrences io
       JOIN records r ON r.id = io.record_id
       WHERE io.issue_id = ? AND io.record_id != ?
       ORDER BY r.created_at ASC, io.id ASC`,
      [id, recordId]
    );
    if (rest.length === 0) {
      await db.run('DELETE FROM issues WHERE id = ?', [id]);
      continue;
    }
    await db.run(
      'UPDATE issues SET occurrence_count = ?, first_record_id = ?, last_record_id = ?, updated_at = ? WHERE id = ?',
      [rest.length, rest[0].record_id, rest[rest.length - 1].record_id, Date.now(), id]
    );
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

module.exports = { processRecordForIssues, removeRecordFromIssues, listIssuesWithOccurrences, isSimilar };
