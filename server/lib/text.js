function splitLines(text) {
  return (text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function joinLines(value) {
  return Array.isArray(value) ? value.filter(Boolean).join('\n') : (value || '');
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

module.exports = { splitLines, joinLines, parseJson, averageInt };
