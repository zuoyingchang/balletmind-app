require('./config'); // loads .env and validates JWT_SECRET before anything else runs
require('./db'); // opens the sqlite connection and ensures tables exist

const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth');
const recordsRoutes = require('./routes/records');
const generateRoutes = require('./routes/generate');
const eventsRoutes = require('./routes/events');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/records', recordsRoutes);
app.use('/api/generate', generateRoutes);
app.use('/api/events', eventsRoutes);

module.exports = app;
