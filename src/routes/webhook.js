'use strict';

const express = require('express');
const { db } = require('../db');
const { getPortalById, listPortalMappings } = require('../services/portals');
const { refreshCounters } = require('../services/counters');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Inbound webhook endpoint.
 * URL: POST /api/webhook/:portalId/:secret
 * Bitrix24 outgoing webhooks send form-urlencoded data with event=ONIMNOTIFYADD etc.
 *
 * We don't try to interpret each event payload — instead, ANY incoming event triggers
 * a fast counter refresh for that portal (debounced).
 */
const refreshDebounce = new Map(); // portalId -> last fired ts

router.post('/:portalId/:secret', express.urlencoded({ extended: true }), async (req, res) => {
  const portalId = parseInt(req.params.portalId, 10);
  const secret = req.params.secret;

  const row = db.prepare(
    `SELECT secret FROM portal_inbound_secrets WHERE portal_id = ?`
  ).get(portalId);
  if (!row || row.secret !== secret) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const portal = getPortalById(portalId);
  if (!portal || !portal.enabled) {
    return res.status(404).json({ error: 'portal_not_found_or_disabled' });
  }

  // Idempotency: store an event key (event + ts) to drop duplicates within ~30s.
  const eventKey = (req.body.event || 'unknown') + ':' + (req.body.ts || Math.floor(Date.now() / 1000 / 30));
  try {
    db.prepare(
      `INSERT INTO webhook_events (portal_id, event_key) VALUES (?, ?)`
    ).run(portalId, eventKey);
  } catch (e) {
    // Duplicate — already processed
    return res.json({ ok: true, deduped: true });
  }

  db.prepare(
    `UPDATE portal_inbound_secrets SET last_event_at = strftime('%s','now') WHERE portal_id = ?`
  ).run(portalId);

  // Debounce: refresh at most once every 5 seconds per portal.
  const now = Date.now();
  const last = refreshDebounce.get(portalId) || 0;
  if (now - last > 5000) {
    refreshDebounce.set(portalId, now);
    setImmediate(async () => {
      try {
        const mappings = listPortalMappings(portalId);
        for (const m of mappings) {
          await refreshCounters(portal, m.remote_user_id).catch((e) =>
            logger.warn(`Webhook refresh failed for portal ${portalId} user ${m.remote_user_id}: ${e.message}`)
          );
        }
      } catch (e) {
        logger.warn(`Webhook-triggered refresh failed for portal ${portalId}: ${e.message}`);
      }
    });
  }

  // Bitrix24 expects a fast response.
  res.json({ ok: true });
});

module.exports = router;
