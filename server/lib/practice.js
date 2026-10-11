// What the user practises. Picks the recap prompt and the transcription
// vocabulary; everything else (records, cards, history) is shared.
// A user can do several (users.practices, comma-separated); each record is
// tagged with the one it was recorded under.
const PRACTICES = ['ballet', 'pilates'];
const DEFAULT_PRACTICE = 'ballet';

function normalizePractice(value) {
  const v = String(value || '').trim().toLowerCase();
  return PRACTICES.includes(v) ? v : null;
}

// Array or comma string in, ordered unique list out; null when nothing valid.
function normalizePractices(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  const picked = new Set(raw.map(normalizePractice).filter(Boolean));
  const list = PRACTICES.filter((p) => picked.has(p));
  return list.length ? list : null;
}

function practicesFromRow(stored) {
  return normalizePractices(stored) || [DEFAULT_PRACTICE];
}

function activeFromRow(practices, stored) {
  const active = normalizePractice(stored);
  return active && practices.includes(active) ? active : practices[0];
}

function practiceFromReq(req) {
  return normalizePractice(req.headers['x-practice']) || DEFAULT_PRACTICE;
}

module.exports = {
  PRACTICES, DEFAULT_PRACTICE, normalizePractice, normalizePractices, practicesFromRow, activeFromRow, practiceFromReq,
};
