// Tiny in-memory fixed-window limiter. Enough for a single Render instance;
// counters reset on restart, which is acceptable for brute-force / spam
// protection. If this ever runs on several instances, move it to a shared store.
function rateLimit({ windowMs, max, keyFn, message }) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, Math.min(windowMs, 60 * 1000));
  sweep.unref();

  return function limiter(req, res, next) {
    if (process.env.RATE_LIMIT_DISABLED === '1') return next();
    const key = keyFn ? keyFn(req) : req.ip;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      console.warn(`[rate-limit] blocked ip=${req.ip} path=${req.baseUrl}${req.path}`);
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: message || '请求太频繁了，请稍后再试' });
    }
    next();
  };
}

const num = (name, fallback) => Number(process.env[name]) || fallback;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: num('RATE_LIMIT_LOGIN_MAX', 10),
  keyFn: (req) => `${req.ip}|${String((req.body && req.body.email) || '').trim().toLowerCase()}`,
  message: '登录尝试太多次了，请 15 分钟后再试',
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: num('RATE_LIMIT_REGISTER_MAX', 10),
  message: '注册太频繁了，请稍后再试',
});

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: num('RATE_LIMIT_FORGOT_MAX', 5),
  message: '发送太频繁了，请稍后再试',
});

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: num('RATE_LIMIT_RESET_MAX', 10),
  message: '尝试太多次了，请稍后再试',
});

const deleteAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: num('RATE_LIMIT_DELETE_ACCOUNT_MAX', 5),
  keyFn: (req) => String(req.userId || req.ip),
  message: '尝试太多次了，请稍后再试',
});

module.exports = { rateLimit, loginLimiter, registerLimiter, forgotLimiter, resetLimiter, deleteAccountLimiter };
