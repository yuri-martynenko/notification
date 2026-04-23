'use strict';

const express = require('express');
const { requireSession } = require('../middleware/auth');
const { readUserCounters, refreshPortalCounters } = require('../services/counters');
const { getSettings, setSettings } = require('../services/settings');
const { db } = require('../db');
const logger = require('../utils/logger');

const router = express.Router();

router.use(requireSession);

router.get('/counters', (req, res) => {
  const data = readUserCounters(req.session.hostUserDbId);
  const settings = getSettings(req.session.hostUserDbId);
  // Filter to enabled entities and apply zero-counter visibility
  for (const portal of data) {
    const filtered = {};
    for (const ent of settings.enabledEntities) {
      if (portal.counters[ent]) filtered[ent] = portal.counters[ent];
    }
    portal.counters = filtered;
    if (!settings.showZeroCounters) {
      // total stays the same; client decides what to render
    }
  }
  const grandTotal = data.reduce((s, p) => s + p.total, 0);
  res.json({ portals: data, grandTotal, settings });
});

router.post('/counters/refresh', async (req, res) => {
  const portals = db.prepare(
    `SELECT * FROM portals WHERE host_user_id = ? AND enabled = 1`
  ).all(req.session.hostUserDbId);
  const settings = getSettings(req.session.hostUserDbId);
  const results = [];
  for (const p of portals) {
    try {
      const r = await refreshPortalCounters(p, settings.enabledEntities);
      results.push({ portalId: p.id, ok: true, errors: r.errors });
    } catch (e) {
      results.push({ portalId: p.id, ok: false, message: e.message });
    }
  }
  res.json({ ok: true, results });
});

router.get('/settings', (req, res) => {
  res.json(getSettings(req.session.hostUserDbId));
});

router.post('/settings', (req, res) => {
  const merged = setSettings(req.session.hostUserDbId, req.body || {});
  res.json(merged);
});

module.exports = router;
