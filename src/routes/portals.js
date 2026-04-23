'use strict';

const express = require('express');
const { requireSession } = require('../middleware/auth');
const portals = require('../services/portals');
const { refreshPortalCounters } = require('../services/counters');
const logger = require('../utils/logger');

const router = express.Router();

router.use(requireSession);

router.get('/', (req, res) => {
  const list = portals.listUserPortals(req.session.hostUserDbId);
  // Augment each portal with full inbound webhook URL for convenience.
  const publicUrl = (process.env.APP_PUBLIC_URL || '').replace(/\/$/, '');
  const out = list.map((p) => ({
    ...p,
    inboundWebhookUrl: p.inboundSecret
      ? `${publicUrl}/api/webhook/${p.id}/${p.inboundSecret}`
      : null,
  }));
  res.json({ portals: out });
});

/**
 * Add a webhook-based portal.
 * Body: { title, webhookUrl }
 */
router.post('/webhook', async (req, res) => {
  const { title, webhookUrl } = req.body || {};
  if (!webhookUrl || !/^https?:\/\/[^/]+\/rest\//.test(webhookUrl)) {
    return res.status(400).json({ error: 'invalid_webhook', message: 'Webhook URL must be like https://portal.bitrix24.ru/rest/USER/CODE/' });
  }
  try {
    const { portalId } = await portals.addWebhookPortal({
      hostUserId: req.session.hostUserDbId,
      title,
      webhookUrl,
    });
    // Trigger initial fetch (don't await long)
    const portal = portals.getPortalById(portalId);
    refreshPortalCounters(portal).catch((e) =>
      logger.warn(`Initial refresh portal ${portalId} failed: ${e.message}`)
    );
    res.json({ ok: true, portalId });
  } catch (e) {
    res.status(400).json({ error: 'add_failed', message: e.message });
  }
});

router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    portals.deletePortal(req.session.hostUserDbId, id);
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: 'not_found', message: e.message });
  }
});

router.patch('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { enabled } = req.body || {};
  try {
    if (typeof enabled === 'boolean') {
      portals.setPortalEnabled(req.session.hostUserDbId, id, enabled);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'update_failed', message: e.message });
  }
});

router.post('/:id/refresh', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const portal = portals.getPortalById(id);
  if (!portal || portal.host_user_id !== req.session.hostUserDbId) {
    return res.status(404).json({ error: 'not_found' });
  }
  try {
    const result = await refreshPortalCounters(portal);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: 'refresh_failed', message: e.message });
  }
});

router.post('/:id/regenerate-secret', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const portal = portals.getPortalById(id);
  if (!portal || portal.host_user_id !== req.session.hostUserDbId) {
    return res.status(404).json({ error: 'not_found' });
  }
  const secret = portals.regenerateInboundSecret(id);
  res.json({ ok: true, secret });
});

module.exports = router;
