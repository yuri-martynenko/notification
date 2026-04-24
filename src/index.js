'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

require('./db'); // initialize and migrate

const installRoute = require('./routes/install');
const portalsRoute = require('./routes/portals');
const countersRoute = require('./routes/counters');
const webhookRoute = require('./routes/webhook');
const oauthRoute = require('./routes/oauth');
const hostUsersRoute = require('./routes/hostUsers');
const poller = require('./workers/poller');
const logger = require('./utils/logger');

const app = express();

app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: false, // disabled for iframe embedding into Bitrix24
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
  })
);

// Allow embedding in any Bitrix24 portal iframe
app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  next();
});

app.use(cors({ origin: true, credentials: false }));
app.use(morgan('combined'));
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Install endpoint (Bitrix24 placement entry)
app.use('/', installRoute);

// API routes
app.use('/api/portals', portalsRoute);
app.use('/api/host-users', hostUsersRoute);
app.use('/api', countersRoute);
app.use('/api/webhook', webhookRoute);
app.use('/api/oauth', oauthRoute);

// Static SPA
app.use(express.static(path.join(__dirname, '..', 'public')));

// SPA fallback for unknown GET routes
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Server listening on port ${PORT}`);
  poller.start();
});

function shutdown() {
  logger.info('Shutting down...');
  poller.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app;
