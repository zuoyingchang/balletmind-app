const { foldBalletText, stripEvalTails } = require('../../public/js/ballet-terms');

function splitLines(text) {
  return (text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function compactGoodPoint(text) {
  return stripEvalTails(text);
}

function foldLabelKey(text) {
  return foldBalletText(text).replace(/[\s,，、]+/g, ' ').trim();
}

function uniqueCompactGoodPoints(lines) {
  const items = [];
  const seen = new Set();
  for (const line of lines || []) {
    const label = compactGoodPoint(line);
    if (!label) continue;
    const key = foldLabelKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push({ label, key });
  }
  return items
    .filter((item, i) => {
      if (item.key.length < 2) return true;
      return !items.some((other, j) => (
        j !== i && other.key.length > item.key.length && other.key.includes(item.key)
      ));
    })
    .map((item) => item.label);
}

function joinLines(value) {
  return Array.isArray(value) ? value.filter(Boolean).join('\n') : (value || '');
}

function compactReviewField(value) {
  const lines = Array.isArray(value) ? value : splitLines(value);
  return joinLines(uniqueCompactGoodPoints(lines));
}

function parseJson(text, fallback = {}) {
  try {
    return JSON.parse(text || '{}');
  } catch (e) {
    return fallback;
  }
}

function averageInt(nums) {
  if (!nums.length) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

function latencyStats(nums) {
  const sorted = nums.filter((n) => typeof n === 'number').sort((a, b) => a - b);
  return {
    count: sorted.length,
    avgMs: averageInt(sorted),
    p95Ms: percentile(sorted, 95),
  };
}

function sessionIdFromReq(req) {
  const header = req.headers && req.headers['x-capture-session'];
  const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)
    ? req.body.sessionId
    : '';
  const raw = body || header || '';
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, 80);
}

function withSession(metadata, sessionId) {
  if (!sessionId) return metadata || null;
  return { ...(metadata || {}), sessionId };
}

module.exports = {
  splitLines, joinLines, compactGoodPoint, uniqueCompactGoodPoints, foldLabelKey, compactReviewField,
  parseJson, averageInt, percentile, latencyStats,
  sessionIdFromReq, withSession,
};
