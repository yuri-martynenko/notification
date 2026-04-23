'use strict';

const { db } = require('../db');
const b24 = require('./b24Client');
const { saveCreds } = b24;
const { randomToken } = require('../utils/crypto');
const logger = require('../utils/logger');

/**
 * Get or create a host_user record (Bitrix24 user on the host portal).
 */
function ensureHostUser(hostPortal, hostUserId) {
  const existing = db.prepare(
    `SELECT id FROM host_users WHERE host_portal = ? AND host_user_id = ?`
  ).get(hostPortal, String(hostUserId));
  if (existing) return existing.id;
  const info = db.prepare(
    `INSERT INTO host_users (host_portal, host_user_id) VALUES (?, ?)`
  ).run(hostPortal, String(hostUserId));
  return info.lastInsertRowid;
}

/**
 * Extract domain from a webhook URL.
 * https://example.bitrix24.ru/rest/123/abc/ -> example.bitrix24.ru
 */
function domainFromWebhook(url) {
  const m = url.match(/^https?:\/\/([^/]+)\//);
  return m ? m[1] : null;
}

/**
 * Validate a webhook by calling user.current.
 * Returns { ok, remoteUserId, error }
 */
async function validateWebhook(url) {
  try {
    const fakePortal = { id: -1, auth_type: 'webhook', domain: domainFromWebhook(url) };
    // Temporarily store creds in-memory by patching loadCreds via a different path is awkward;
    // simpler: do a direct axios call here.
    const axios = require('axios');
    const u = (url.endsWith('/') ? url : url + '/') + 'user.current.json';
    const { data } = await axios.post(u, {}, { timeout: 10000 });
    if (data && data.error) {
      return { ok: false, error: `${data.error}: ${data.error_description || ''}` };
    }
    if (data && data.result) {
      return { ok: true, remoteUserId: String(data.result.ID || data.result.id) };
    }
    return { ok: false, error: 'Empty response' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Add a webhook-based portal.
 */
async function addWebhookPortal({ hostUserId, title, webhookUrl }) {
  const domain = domainFromWebhook(webhookUrl);
  if (!domain) throw new Error('Invalid webhook URL');

  const validated = await validateWebhook(webhookUrl);
  if (!validated.ok) {
    throw new Error(`Webhook validation failed: ${validated.error}`);
  }

  const tx = db.transaction(() => {
    const exists = db.prepare(
      `SELECT id FROM portals WHERE host_user_id = ? AND domain = ?`
    ).get(hostUserId, domain);
    if (exists) throw new Error(`Portal ${domain} already added`);

    const portalRow = db.prepare(`
      INSERT INTO portals (host_user_id, title, domain, auth_type, remote_user_id, enabled)
      VALUES (?, ?, ?, 'webhook', ?, 1)
    `).run(hostUserId, title || domain, domain, validated.remoteUserId);

    const portalId = portalRow.lastInsertRowid;
    saveCreds(portalId, { url: webhookUrl });

    // Generate inbound webhook secret so remote portal can push events to us.
    const secret = randomToken(24);
    db.prepare(
      `INSERT INTO portal_inbound_secrets (portal_id, secret) VALUES (?, ?)`
    ).run(portalId, secret);

    return { portalId, secret };
  });

  return tx();
}

/**
 * Add an OAuth-based portal. Called from OAuth callback after successful exchange.
 */
function addOauthPortal({ hostUserId, title, domain, accessToken, refreshToken, expiresIn, clientId, clientSecret, remoteUserId }) {
  const tx = db.transaction(() => {
    const exists = db.prepare(
      `SELECT id FROM portals WHERE host_user_id = ? AND domain = ?`
    ).get(hostUserId, domain);

    let portalId;
    if (exists) {
      portalId = exists.id;
      db.prepare(
        `UPDATE portals SET title = ?, auth_type='oauth', remote_user_id = ?, enabled = 1, last_error = NULL WHERE id = ?`
      ).run(title || domain, remoteUserId, portalId);
    } else {
      const portalRow = db.prepare(`
        INSERT INTO portals (host_user_id, title, domain, auth_type, remote_user_id, enabled)
        VALUES (?, ?, ?, 'oauth', ?, 1)
      `).run(hostUserId, title || domain, domain, remoteUserId);
      portalId = portalRow.lastInsertRowid;
    }

    saveCreds(portalId, {
      accessToken,
      refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + (expiresIn || 3600) - 60,
      clientId,
      clientSecret,
      domain,
    });

    const sec = db.prepare(
      `SELECT portal_id FROM portal_inbound_secrets WHERE portal_id = ?`
    ).get(portalId);
    if (!sec) {
      const secret = randomToken(24);
      db.prepare(
        `INSERT INTO portal_inbound_secrets (portal_id, secret) VALUES (?, ?)`
      ).run(portalId, secret);
    }

    return portalId;
  });

  return tx();
}

function listUserPortals(hostUserId) {
  const portals = db.prepare(`
    SELECT p.id, p.title, p.domain, p.auth_type, p.remote_user_id, p.enabled,
           p.last_polled_at, p.last_error, p.created_at,
           s.secret AS inbound_secret
    FROM portals p
    LEFT JOIN portal_inbound_secrets s ON s.portal_id = p.id
    WHERE p.host_user_id = ?
    ORDER BY p.created_at DESC
  `).all(hostUserId);
  return portals.map((p) => ({
    id: p.id,
    title: p.title,
    domain: p.domain,
    authType: p.auth_type,
    remoteUserId: p.remote_user_id,
    enabled: !!p.enabled,
    lastPolledAt: p.last_polled_at,
    lastError: p.last_error ? JSON.parse(p.last_error) : null,
    inboundSecret: p.inbound_secret,
    createdAt: p.created_at,
  }));
}

function deletePortal(hostUserId, portalId) {
  const portal = db.prepare(
    `SELECT id FROM portals WHERE id = ? AND host_user_id = ?`
  ).get(portalId, hostUserId);
  if (!portal) throw new Error('Portal not found');
  db.prepare(`DELETE FROM portals WHERE id = ?`).run(portalId);
  return true;
}

function setPortalEnabled(hostUserId, portalId, enabled) {
  const portal = db.prepare(
    `SELECT id FROM portals WHERE id = ? AND host_user_id = ?`
  ).get(portalId, hostUserId);
  if (!portal) throw new Error('Portal not found');
  db.prepare(`UPDATE portals SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, portalId);
  return true;
}

function getPortalById(portalId) {
  return db.prepare(
    `SELECT id, host_user_id, title, domain, auth_type, remote_user_id, enabled
     FROM portals WHERE id = ?`
  ).get(portalId);
}

function getInboundSecret(portalId) {
  const r = db.prepare(`SELECT secret FROM portal_inbound_secrets WHERE portal_id = ?`).get(portalId);
  return r ? r.secret : null;
}

function regenerateInboundSecret(portalId) {
  const secret = randomToken(24);
  db.prepare(
    `INSERT INTO portal_inbound_secrets (portal_id, secret) VALUES (?, ?)
     ON CONFLICT(portal_id) DO UPDATE SET secret = excluded.secret, last_event_at = NULL`
  ).run(portalId, secret);
  return secret;
}

module.exports = {
  ensureHostUser,
  addWebhookPortal,
  addOauthPortal,
  listUserPortals,
  deletePortal,
  setPortalEnabled,
  getPortalById,
  getInboundSecret,
  regenerateInboundSecret,
  validateWebhook,
  domainFromWebhook,
};
