'use strict';

const express = require('express');
const { requireSession, requireAdmin } = require('../middleware/auth');
const portals = require('../services/portals');
const { refreshCounters } = require('../services/counters');
const b24 = require('../services/b24Client');
const logger = require('../utils/logger');

const router = express.Router();

router.use(requireSession);

/**
 * GET /api/portals — list all portals (all users).
 * Response includes inboundWebhookUrl only for admins.
 */
router.get('/', (req, res) => {
  const list = portals.listAllPortals();
  const publicUrl = (process.env.APP_PUBLIC_URL || '').replace(/\/$/, '');
  const out = list.map((p) => {
    const base = {
      id: p.id,
      title: p.title,
      domain: p.domain,
      authType: p.authType,
      enabled: p.enabled,
      lastPolledAt: p.lastPolledAt,
      lastError: p.lastError,
      createdAt: p.createdAt,
    };
    if (req.session.isAdmin) {
      base.inboundWebhookUrl = p.inboundSecret ? `${publicUrl}/api/webhook/${p.id}/${p.inboundSecret}` : null;
      base.ownerUserId = p.ownerUserId;
    }
    return base;
  });
  res.json({ portals: out, isAdmin: req.session.isAdmin });
});

/**
 * POST /api/portals/webhook — admin only.
 * Body: { title, webhookUrl }
 */
router.post('/webhook', requireAdmin, async (req, res) => {
  const { title, webhookUrl } = req.body || {};
  if (!webhookUrl || !/^https?:\/\/[^/]+\/rest\//.test(webhookUrl)) {
    return res.status(400).json({ error: 'invalid_webhook', message: 'Webhook URL must be like https://portal.bitrix24.ru/rest/USER/CODE/' });
  }
  try {
    const { portalId } = await portals.addWebhookPortal({
      adminHostUserId: req.session.hostUserDbId,
      title,
      webhookUrl,
    });
    const portal = portals.getPortalById(portalId);
    const mapping = portals.getMapping(req.session.hostUserDbId, portalId);
    if (mapping) {
      refreshCounters(portal, mapping.remote_user_id).catch((e) =>
        logger.warn(`Initial refresh portal ${portalId} failed: ${e.message}`)
      );
    }
    res.json({ ok: true, portalId });
  } catch (e) {
    res.status(400).json({ error: 'add_failed', message: e.message });
  }
});

router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    portals.deletePortal(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: 'not_found', message: e.message });
  }
});

router.patch('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { enabled } = req.body || {};
  try {
    if (typeof enabled === 'boolean') portals.setPortalEnabled(id, enabled);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'update_failed', message: e.message });
  }
});

/**
 * POST /api/portals/:id/refresh — available to any user mapped to the portal.
 * Non-admins refresh only their own mapping.
 */
router.post('/:id/refresh', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const portal = portals.getPortalById(id);
  if (!portal) return res.status(404).json({ error: 'not_found' });

  try {
    if (req.session.isAdmin) {
      // Admin: refresh all mappings for this portal
      const list = portals.listPortalMappings(id);
      const out = [];
      for (const m of list) {
        const r = await refreshCounters(portal, m.remote_user_id).catch((e) => ({ error: e.message }));
        out.push({ remoteUserId: m.remote_user_id, ...r });
      }
      return res.json({ ok: true, refreshed: out });
    }
    const mapping = portals.getMapping(req.session.hostUserDbId, id);
    if (!mapping) return res.status(403).json({ error: 'no_mapping', message: 'You are not mapped to this portal' });
    const result = await refreshCounters(portal, mapping.remote_user_id);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: 'refresh_failed', message: e.message });
  }
});

router.post('/:id/regenerate-secret', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const portal = portals.getPortalById(id);
  if (!portal) return res.status(404).json({ error: 'not_found' });
  const secret = portals.regenerateInboundSecret(id);
  res.json({ ok: true, secret });
});

// ============ USER MAPPINGS ============

/**
 * GET /api/portals/:id/mappings — admin only. List all users mapped to this portal.
 */
router.get('/:id/mappings', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  res.json({ mappings: portals.listPortalMappings(id) });
});

/**
 * POST /api/portals/:id/mappings — admin only. Set/update mapping for a host user.
 * Body: { hostUserDbId, remoteUserId, remoteUserName?, remoteUserEmail?, verified? }
 */
router.post('/:id/mappings', requireAdmin, (req, res) => {
  const portalId = parseInt(req.params.id, 10);
  const { hostUserDbId, remoteUserId, remoteUserName, remoteUserEmail, verified } = req.body || {};
  if (!hostUserDbId || !remoteUserId) {
    return res.status(400).json({ error: 'missing_params' });
  }
  try {
    portals.setMapping({
      hostUserDbId: parseInt(hostUserDbId, 10),
      portalId,
      remoteUserId,
      remoteUserName,
      remoteUserEmail,
      verified: verified !== false,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'mapping_failed', message: e.message });
  }
});

/**
 * DELETE /api/portals/:id/mappings/:hostUserDbId — admin only.
 */
router.delete('/:id/mappings/:hostUserDbId', requireAdmin, (req, res) => {
  const portalId = parseInt(req.params.id, 10);
  const hostUserDbId = parseInt(req.params.hostUserDbId, 10);
  portals.deleteMapping(hostUserDbId, portalId);
  res.json({ ok: true });
});

/**
 * POST /api/portals/:id/find-user — admin. Search for a user on the remote portal by email/name.
 * Body: { email?, lastName?, firstName? }
 */
router.post('/:id/find-user', requireAdmin, async (req, res) => {
  const portalId = parseInt(req.params.id, 10);
  const portal = portals.getPortalById(portalId);
  if (!portal) return res.status(404).json({ error: 'not_found' });
  try {
    const found = await portals.findRemoteUser(portal, req.body || {});
    res.json({ user: found });
  } catch (e) {
    res.status(500).json({ error: 'search_failed', message: e.message });
  }
});

module.exports = router;
