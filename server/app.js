require('./config'); // loads .env and validates JWT_SECRET before anything else runs
require('./db'); // opens the Turso connection; server.js awaits db.ready before listening

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
app.use(cors({
  origin: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key'],
}));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
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
app.use('/api/admin', adminRoutes);
app.use('/api/issues', issuesRoutes);
app.use('/api/progress', progressRoutes);
app.use('/api/terms', termsRoutes);

module.exports = app;
