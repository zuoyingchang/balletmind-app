// Server-side logging helpers. Everything here goes to stdout/stderr, which Render
// shows in the service's Logs tab. Never pass passwords, tokens, emails, transcripts
// or record content in — only ids, status codes, timings and short error text.

const BILLING_HINT = /credit|balance|quota|billing|insufficient|payment|exceeded your current/i;

// Upstream (Anthropic / OpenAI) call failed. Money and key problems get an [ALERT]
// tag so `ALERT` is one search in the Logs tab.
function logUpstreamFailure(service, status, detail) {
  const text = String(detail || '').slice(0, 500);
  const billingLike = status === 401 || status === 402 || status === 403 || BILLING_HINT.test(text);
  const tag = billingLike ? '[ALERT][billing-or-key]' : '[upstream]';
  console.error(`${tag} ${service} HTTP ${status}: ${text}`);
}

function logAuth(kind, fields) {
  console.log(`[auth] ${kind} ${Object.entries(fields || {}).map(([k, v]) => `${k}=${v}`).join(' ')}`.trim());
}

function logQuota(kind, userId) {
  console.warn(`[quota] ${kind} user=${userId}`);
}

module.exports = { logUpstreamFailure, logAuth, logQuota };
