function pass() { return { ok: true }; }
function fail(reason) { return { ok: false, reason }; }

function blob(r) {
  return `${r.good_points || ''}\n${r.improve_points || ''}\n${r.next_time_reminder || ''}\n${r.note || ''}`;
}

function improveLines(r) {
  return String(r.improve_points || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

const DIMENSIONS = ['coverage', 'classification', 'hallucination', 'terminology', 'schema'];

function caseDef(fields) {
  const dimensions = fields.dimensions || [];
  if (!dimensions.includes('schema')) dimensions.push('schema');
  return { rootCauseHint: 'llm', ...fields, dimensions };
}

module.exports = { pass, fail, blob, improveLines, DIMENSIONS, caseDef };
