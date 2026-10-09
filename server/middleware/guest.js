const { rateLimit } = require('./rate-limit');
const { sanitizeVid } = require('../lib/telemetry');
const { countAllGuestAiCallsToday } = require('../events');
const { GUEST_IP_CALLS_PER_DAY, GUEST_SITE_AI_CALLS_PER_DAY } = require('../config');

const GUEST_QUOTA_MESSAGE = '今天的试用次数用完了，注册后可以继续用';

// Try-before-signup: no token, identified only by the anonymous browser id the
// page already sends for visit telemetry. Never linked to an account.
function guestIdentity(req, res, next) {
  const vid = sanitizeVid(req.headers['x-guest-vid']);
  if (!vid) return res.status(400).json({ error: '试用需要刷新页面后再试' });
  req.userId = null;
  req.guestVid = vid;
  next();
}

const guestIpLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: GUEST_IP_CALLS_PER_DAY,
  keyFn: (req) => `guest|${req.ip}`,
  message: GUEST_QUOTA_MESSAGE,
});

async function guestSiteBudget(req, res, next) {
  if ((await countAllGuestAiCallsToday()) >= GUEST_SITE_AI_CALLS_PER_DAY) {
    console.warn('[quota] guest site-wide daily budget reached');
    return res.status(429).json({ error: GUEST_QUOTA_MESSAGE, code: 'guest_quota' });
  }
  next();
}

// Event metadata for a guest call carries { source: 'guest', vid } so the
// per-browser and site-wide caps can be counted (see events.js).
function tagActor(req, meta) {
  if (!req.guestVid) return meta;
  return { ...(meta || {}), source: 'guest', vid: req.guestVid };
}

module.exports = { guestIdentity, guestIpLimiter, guestSiteBudget, tagActor, GUEST_QUOTA_MESSAGE };
