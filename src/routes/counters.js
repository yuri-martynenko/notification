'use strict';

const express = require('express');
const { requireSession } = require('../middleware/auth');
const { readUserCounters, refreshCounters } = require('../services/counters');
const { getSettings, setSettings } = require('../services/settings');
const portals = require('../services/portals');
const { db } = require('../db');
const logger = require('../utils/logger');

const router = express.Router();

router.use(requireSession);

router.get('/counters', (req, res) => {
  const data = readUserCounters(req.session.hostUserDbId);
  const settings = getSettings(req.session.hostUserDbId);
  for (const portal of data) {
    const filtered = {};
    for (const ent of settings.enabledEntities) {
      if (portal.counters[ent]) filtered[ent] = portal.counters[ent];
    }
    portal.counters = filtered;
  }
  const grandTotal = data.reduce((s, p) => s + p.total, 0);
  res.json({ portals: data, grandTotal, settings, isAdmin: req.session.isAdmin });
});

router.post('/counters/refresh', async (req, res) => {
  const mappings = portals.listMappings(req.session.hostUserDbId);
  const settings = getSettings(req.session.hostUserDbId);
  const results = [];
  for (const m of mappings) {
    const portal = portals.getPortalById(m.portal_id);
    if (!portal || !portal.enabled) continue;
    try {
      const r = await refreshCounters(portal, m.remote_user_id, settings.enabledEntities);
      results.push({ portalId: m.portal_id, ok: true, errors: r.errors });
    } catch (e) {
      results.push({ portalId: m.portal_id, ok: false, message: e.message });
    }
  }
  res.json({ ok: true, results });
});

router.get('/settings', (req, res) => {
  res.json(getSettings(req.session.hostUserDbId));
});

router.post('/settings', (req, res) => {
  res.json(setSettings(req.session.hostUserDbId, req.body || {}));
});

// ========= Current user's mappings =========

router.get('/my-mappings', (req, res) => {
  res.json({ mappings: portals.listMappings(req.session.hostUserDbId) });
});

/**
 * Any user can set their own mapping. Admin can add them via /portals/:id/mappings.
 * This lets a non-admin adjust their remote_user_id themselves if desired.
 */
router.post('/my-mappings/:portalId', async (req, res) => {
  const portalId = parseInt(req.params.portalId, 10);
  const portal = portals.getPortalById(portalId);
  if (!portal || !portal.enabled) return res.status(404).json({ error: 'portal_not_found' });

  const { remoteUserId, autoDetectByEmail } = req.body || {};

  try {
    let resolvedId = remoteUserId;
    let resolvedName = null;
    let resolvedEmail = null;

    // Auto-detect: look up the user on the remote portal by session user's email.
    // We can only do this if we have the host user's email; for MVP, the UI collects
    // email/name and sends them here.
    if (autoDetectByEmail && req.body.email) {
      const found = await portals.findRemoteUser(portal, { email: req.body.email });
      if (!found) return res.status(404).json({ error: 'user_not_found_on_remote' });
      resolvedId = found.id;
      resolvedName = found.name;
      resolvedEmail = found.email;
    }

    if (!resolvedId) return res.status(400).json({ error: 'missing_remote_user_id' });

    portals.setMapping({
      hostUserDbId: req.session.hostUserDbId,
      portalId,
      remoteUserId: resolvedId,
      remoteUserName: resolvedName || req.body.name,
      remoteUserEmail: resolvedEmail || req.body.email,
      verified: autoDetectByEmail ? 1 : 0,
    });
    res.json({ ok: true, remoteUserId: resolvedId });
  } catch (e) {
    res.status(500).json({ error: 'mapping_failed', message: e.message });
  }
});

router.delete('/my-mappings/:portalId', (req, res) => {
  const portalId = parseInt(req.params.portalId, 10);
  portals.deleteMapping(req.session.hostUserDbId, portalId);
  res.json({ ok: true });
});

module.exports = router;
