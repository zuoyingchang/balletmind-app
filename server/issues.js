const db = require('./db');
const { splitLines, compactGoodPoint, uniqueCompactGoodPoints, foldLabelKey } = require('./lib/text');
const { BALLET_TERMS } = require('./ballet-glossary');
const { TERM_ALIAS_GROUPS, foldBalletText } = require('../public/js/ballet-terms');

// Recurring Issue Tracking (V0.2 PRD #1) — deliberately NOT AI-based. Matching
// a new "improve_points" line against existing open issues is plain text
// normalization + containment, so there is no model in the loop to hallucinate
// a pattern that isn't really there, and status only ever changes when the
// user clicks a button. "AI不替用户下结论" — literally true here: there's no AI.

// Accent folding is the same foldBalletText the archive search uses
// (plié/plie, développé/developpe), not a second regex that can drift.
function normalize(s) {
  return foldBalletText((s || '').trim()).replace(/[，。！？,.!?\s]/g, '');
}

// Synonym-aware lookup: every alias in a TERM_ALIAS_GROUPS group (French/
// English/Chinese spellings of the same thing, e.g. ['turnout', '外开'])
// resolves to that group's first alias as a shared canonical id, so
// "turnout 不够" and "外开不够" are recognized as the same term instead of
// two unrelated strings. Reused from the search feature's own alias data —
// one list, not a second copy that can drift.
// Search aliases include body-part needles (膝盖, 骨盆) so archive search can
// find them. Those must not be "the named move" for issue matching — otherwise
// "蹲 膝盖没对脚趾" is tagged as 膝盖, not plié. Keep groups that have a
// Latin spelling (plié/turnout/…); 外开 still counts via the turnout group.
const MOVE_ALIAS_GROUPS = TERM_ALIAS_GROUPS.filter((group) =>
  group.some((alias) => /[a-z]/i.test(foldBalletText(alias)))
);
const ALIAS_LOOKUP = MOVE_ALIAS_GROUPS
  .flatMap((group) => group.map((alias) => ({ alias: normalize(alias), canonical: normalize(group[0]) })))
  .filter((e) => e.alias.length >= 2 || /[\u4e00-\u9fff]/.test(e.alias))
  .sort((a, b) => b.alias.length - a.alias.length);

// Fallback for terms the search feature's (smaller, common-terms-only)
// alias list doesn't cover but the ASR prompt list does (croisé, épaulement,
// adagio, etc.) — no synonym-linking here, just recognized as its own term.
// Longest first, and terms under 3 normalized characters skipped (too
// common on their own, e.g. two-letter position abbreviations).
const TERMS_BY_LENGTH = [...BALLET_TERMS]
  .map(normalize)
  .filter((t) => t.length >= 3)
  .sort((a, b) => b.length - a.length);

// The one named move/term a line is about, e.g. "grand battement 一般般"
// and "Grand battement 需要改进" both extract the same canonical id even
// though the rest of the sentence differs, and "turnout 不够" / "外开不够"
// extract the same id as each other despite being different spellings.
// Returns both the shared `canonical` id (for the same-term check) and the
// `matched` substring as it actually appears in `s` (for stripping it back
// out again) — those two differ whenever an alias/synonym is what matched,
// e.g. matched: "外开", canonical: "turnout".
function extractTerm(s) {
  const norm = normalize(s);
  const aliasHit = ALIAS_LOOKUP.find((e) => norm.includes(e.alias));
  if (aliasHit) return { canonical: aliasHit.canonical, matched: aliasHit.alias };
  const flatHit = TERMS_BY_LENGTH.find((t) => norm.includes(t));
  return flatHit ? { canonical: flatHit, matched: flatHit } : null;
}

// Generic evaluative filler with no actual content — "一般般" and "需要改进"
// both just mean "not good enough" without saying what's wrong. Stripped out
// before comparing what's left of a line, same idea as ASK_STOPWORDS in
// ballet-terms.js for the ask-archive tokenizer.
const GENERIC_FILLER = [
  '一般般', '一般', '还行', '还可以', '不错', '不够好', '不够', '不太好', '不太行',
  '需要改进', '需要加强', '需要注意', '还需努力', '还要努力', '有待提高', '待提高',
  '继续加油', '继续努力', '继续保持', '加油', '多加练习', '多练习', '多练', '可以更好', '要注意',
  '还是', '仍然', '总是', '老是', '又是',
].map(normalize).sort((a, b) => b.length - a.length);

function stripFiller(s) {
  let out = s;
  for (const f of GENERIC_FILLER) out = out.split(f).join('');
  return out;
}

const ALIASES_BY_CANONICAL = new Map();
for (const group of MOVE_ALIAS_GROUPS) {
  const canonical = normalize(group[0]);
  const aliases = [...new Set(group.map(normalize))].sort((a, b) => b.length - a.length);
  ALIASES_BY_CANONICAL.set(canonical, aliases);
}

// Strip every spelling of the named move (turnout and 外开, plié and 蹲…),
// not only the one substring extractTerm happened to hit first. Otherwise a
// line that used both spellings leaves the other spelling in the "leftover"
// and fails to match a later line that only used 外开.
function stripNamedMove(norm, canonical) {
  let out = norm;
  const aliases = ALIASES_BY_CANONICAL.get(canonical) || [canonical];
  for (const alias of aliases) out = out.split(alias).join('');
  if (!ALIASES_BY_CANONICAL.has(canonical) && canonical) out = out.split(canonical).join('');
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
  if (!ta || !tb || ta.canonical !== tb.canonical) return false;
  const rNew = stripFiller(stripNamedMove(nb, tb.canonical));
  const rExisting = stripFiller(stripNamedMove(na, ta.canonical));
  if (!rNew && !rExisting) return true;
  if (!rNew) return true; // new line says nothing specific -- safe to bucket here
  if (!rExisting) return false; // existing issue has no specific content -- don't swallow a real complaint
  return hasOverlap(rExisting, rNew);
}

// Called after a record is saved. Matches each line of improve_points against
// this user's open (non-resolved) issues; bumps the count on a match, opens a
// new issue otherwise. Every match/create is also logged in issue_occurrences
// so the UI can link each issue back to the specific records it came from.
async function processRecordForIssues(userId, recordId, improvePointsText) {
  const lines = uniqueCompactGoodPoints(splitLines(improvePointsText));
  if (lines.length === 0) return;

  const openIssues = await db.all(
    "SELECT * FROM issues WHERE user_id = ? AND status != 'resolved'",
    [userId]
  );

  for (const line of lines) {
    const stored = compactGoodPoint(line) || line;
    const match = openIssues.find((issue) => isSimilar(issue.text, stored) || isSimilar(stored, issue.text));
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
        [userId, stored, recordId, recordId, now, now]
      );
      await db.run(
        'INSERT INTO issue_occurrences (issue_id, record_id, created_at) VALUES (?, ?, ?)',
        [info.lastInsertRowid, recordId, now]
      );
      openIssues.push({ id: info.lastInsertRowid, text: stored, status: 'open', occurrence_count: 1 });
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

  const withOcc = issues.map((issue) => ({
    ...issue,
    occurrences: occurrences
      .filter((o) => o.issue_id === issue.id)
      .map((o) => ({ recordId: o.record_id, createdAt: o.created_at, className: o.class_name })),
  }));
  return collapseSimilarIssueRows(withOcc);
}

function issuesMatch(a, b) {
  const ka = foldLabelKey(compactGoodPoint(a) || a);
  const kb = foldLabelKey(compactGoodPoint(b) || b);
  if (ka && kb && ka === kb) return true;
  return isSimilar(a, b) || isSimilar(b, a);
}

function mergeOccurrenceRows(left, right) {
  const map = new Map();
  for (const row of [...(left || []), ...(right || [])]) {
    if (!row || row.recordId == null) continue;
    if (!map.has(row.recordId)) map.set(row.recordId, row);
  }
  return [...map.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

function collapseCluster(list) {
  const sorted = [...list].sort((a, b) => (
    (b.occurrence_count || 0) - (a.occurrence_count || 0)
    || (a.id || 0) - (b.id || 0)
  ));
  const clusters = [];
  for (const issue of sorted) {
    const hit = clusters.find((c) => issuesMatch(c.text, issue.text));
    if (!hit) {
      clusters.push({
        ...issue,
        mergedIds: [issue.id],
        occurrences: [...(issue.occurrences || [])],
      });
      continue;
    }
    if (!hit.mergedIds.includes(issue.id)) hit.mergedIds.push(issue.id);
    hit.occurrences = mergeOccurrenceRows(hit.occurrences, issue.occurrences);
    hit.occurrence_count = hit.occurrences.length
      || (hit.occurrence_count || 0) + (issue.occurrence_count || 0);
    if (issue.status === 'improving') hit.status = 'improving';
    hit.updated_at = Math.max(Number(hit.updated_at) || 0, Number(issue.updated_at) || 0);
    const createdA = Number(hit.created_at);
    const createdB = Number(issue.created_at);
    if (Number.isFinite(createdB) && (!Number.isFinite(createdA) || createdB < createdA)) {
      hit.created_at = issue.created_at;
    }
    const keep = compactGoodPoint(hit.text);
    const next = compactGoodPoint(issue.text);
    if (next && (!keep || next.length < keep.length)) hit.text = issue.text;
  }
  return clusters;
}

function collapseSimilarIssueRows(issues) {
  const active = [];
  const resolved = [];
  for (const issue of issues || []) {
    if (issue.status === 'resolved') resolved.push(issue);
    else active.push(issue);
  }
  return [...collapseCluster(active), ...collapseCluster(resolved)];
}

module.exports = {
  processRecordForIssues,
  removeRecordFromIssues,
  listIssuesWithOccurrences,
  collapseSimilarIssueRows,
  isSimilar,
  extractTerm,
};
