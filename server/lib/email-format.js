// Practical format check: not RFC-perfect, just blocks "abc" / missing domain.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  const value = normalizeEmail(email);
  return value.length >= 6 && value.length <= 254 && EMAIL_RE.test(value);
}

module.exports = { normalizeEmail, isValidEmail };
