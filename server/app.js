require('./config'); // loads .env and validates JWT_SECRET before anything else runs
require('express-async-errors'); // async route errors reach the error handler instead of crashing the process
const db = require('./db'); // opens the Turso connection; server.js awaits db.ready before listening
const { RESEND_API_KEY, EMAIL_FROM, APP_PUBLIC_URL, EXPERIMENT_ISSUE_BRIEF, EXPERIMENT_ISSUE_BRIEF_USER_IDS } = require('./config');

const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth');
const recordsRoutes = require('./routes/records');
const generateRoutes = require('./routes/generate');
const transcribeRoutes = require('./routes/transcribe');
const eventsRoutes = require('./routes/events');
const adminRoutes = require('./routes/admin');
const issuesRoutes = require('./routes/issues');
const progressRoutes = require('./routes/progress');
const termsRoutes = require('./routes/terms');

const app = express();

app.set('trust proxy', 1);

// One line per API request, so a bug report can be matched to a request in Render's logs.
// Never logs bodies, tokens or query strings — only method, path, status, time.
app.use('/api', (req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (req.path === '/health' || process.env.NODE_TEST_CONTEXT) return;
    const ms = Date.now() - started;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    console[level === 'info' ? 'log' : level](`[req] ${req.method} ${req.baseUrl}${req.path} ${res.statusCode} ${ms}ms${ms > 5000 ? ' [slow]' : ''}`);
  });
  next();
});
app.use(cors({
  origin: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key'],
  exposedHeaders: ['X-New-Token'],
}));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
// Cheap liveness + DB check for uptime monitors (no auth, no user data).
app.get('/api/health', async (req, res) => {
  try {
    await db.get('SELECT 1 AS ok');
    res.json({
      ok: true,
      emailConfigured: Boolean(RESEND_API_KEY),
      emailFromOk: Boolean(EMAIL_FROM) && !/example\.com/i.test(EMAIL_FROM),
      publicUrlConfigured: Boolean(APP_PUBLIC_URL),
      experimentIssueBrief: Boolean(EXPERIMENT_ISSUE_BRIEF),
      experimentAllowlist: Boolean(String(EXPERIMENT_ISSUE_BRIEF_USER_IDS || '').trim()),
    });
  } catch (e) {
    res.status(503).json({ ok: false });
  }
});
// Transcribe accepts a raw audio blob — register it before the JSON parser so
// body-parser cannot consume or overwrite the buffer.
app.use('/api/transcribe', transcribeRoutes);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/records', recordsRoutes);
app.use('/api/generate', generateRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/feedback', require('./routes/feedback'));
app.use('/api/admin', adminRoutes);
app.use('/api/issues', issuesRoutes);
app.use('/api/progress', progressRoutes);
app.use('/api/terms', termsRoutes);

// Last resort for anything a route did not handle itself.
app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.originalUrl.split('?')[0]}`, err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '服务器出错了，请稍后再试' });
});

module.exports = app;
