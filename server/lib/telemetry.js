// Anonymous visit + client-error telemetry. Everything is reduced to short enums before it is
// stored: no IP, no raw user agent, no free text, no link to an account.
const PLATFORMS = ['ios', 'android', 'desktop', 'other'];
const BROWSERS = ['safari', 'chrome', 'firefox', 'edge', 'opera', 'wechat', 'xhs', 'qq', 'xiaomi', 'huawei', 'other'];
const ERROR_WHERE = ['ai_process', 'asr', 'records', 'ask', 'auth', 'progress', 'api', 'js'];
const ERROR_KINDS = ['network', 'timeout', 'http_4xx', 'http_5xx', 'exception', 'permission', 'unsupported', 'other'];

const VID_RE = /^[a-z0-9-]{16,40}$/i;
const SRC_RE = /^[a-z0-9_-]{1,24}$/;

const pick = (list, value, fallback) => (list.includes(value) ? value : fallback);

function sanitizeVid(v) {
  const s = String(v || '').trim();
  return VID_RE.test(s) ? s.toLowerCase() : null;
}

function sanitizeVisit(body) {
  const b = body && typeof body === 'object' ? body : {};
  const vid = sanitizeVid(b.vid);
  if (!vid) return null;
  const src = String(b.src || '').trim().toLowerCase();
  return {
    vid,
    platform: pick(PLATFORMS, b.platform, 'other'),
    browser: pick(BROWSERS, b.browser, 'other'),
    inApp: b.inApp === true,
    src: SRC_RE.test(src) ? src : 'direct',
  };
}

function sanitizeClientError(body) {
  const b = body && typeof body === 'object' ? body : {};
  const vid = sanitizeVid(b.vid);
  if (!vid) return null;
  const status = Number(b.status);
  const meta = {
    where: pick(ERROR_WHERE, b.where, 'api'),
    kind: pick(ERROR_KINDS, b.kind, 'other'),
    vid,
    platform: pick(PLATFORMS, b.platform, 'other'),
    browser: pick(BROWSERS, b.browser, 'other'),
  };
  if (Number.isInteger(status) && status >= 100 && status <= 599) meta.status = status;
  return meta;
}

module.exports = { PLATFORMS, BROWSERS, ERROR_WHERE, ERROR_KINDS, sanitizeVid, sanitizeVisit, sanitizeClientError };
