'use strict';

const axios = require('axios');
const { db } = require('../db');
const { encryptJson, decryptJson, randomToken } = require('../utils/crypto');
const logger = require('../utils/logger');

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

function domainFromWebhook(url) {
  const m = url.match(/^https?:\/\/([^/]+)\//);
  return m ? m[1] : null;
}

/**
 * Save (overwrite) credentials for a portal.
 */
function saveCreds(portalId, creds) {
  const { ciphertext, iv, tag } = encryptJson(creds);
  db.prepare(`
    INSERT INTO portal_credentials (portal_id, ciphertext, iv, tag, updated_at)
    VALUES (?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(portal_id) DO UPDATE SET
      ciphertext = excluded.ciphertext,
      iv = excluded.iv,
      tag = excluded.tag,
      updated_at = strftime('%s','now')
  `).run(portalId, ciphertext, iv, tag);
}

function loadCreds(portalId) {
  const row = db.prepare(
    'SELECT ciphertext, iv, tag FROM portal_credentials WHERE portal_id = ?'
  ).get(portalId);
  if (!row) throw new Error(`No credentials for portal ${portalId}`);
  return decryptJson(row.ciphertext, row.iv, row.tag);
}

/**
 * Validate a webhook by calling user.current on the remote portal.
 */
async function validateWebhook(url) {
  try {
    const u = (url.endsWith('/') ? url : url + '/') + 'user.current.json';
    const { data } = await axios.post(u, {}, { timeout: 10000 });
    if (data && data.error) {
      return { ok: false, error: `${data.error}: ${data.error_description || ''}` };
    }
    if (data && data.result) {
      return {
        ok: true,
        remoteUserId: String(data.result.ID || data.result.id),
        remoteUserName: [data.result.NAME, data.result.LAST_NAME].filter(Boolean).join(' ').trim() || null,
        remoteUserEmail: data.result.EMAIL || null,
      };
    }
    return { ok: false, error: 'Empty response' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Search for a user on a remote portal by email (preferred) or full name.
 * Uses the portal's stored credentials.
 */
async function findRemoteUser(portal, { email, lastName, firstName }) {
  const { callMethod } = require('./b24Client');
  const params = { FILTER: {} };
  if (email) params.FILTER.EMAIL = email;
  if (lastName) params.FILTER.LAST_NAME = lastName;
  if (firstName) params.FILTER.NAME = firstName;
  const data = await callMethod(portal, 'user.search', params).catch(() => null);
  if (!data || !data.result || !data.result.length) return null;
  const u = data.result[0];
  return {
    id: String(u.ID),
    name: [u.NAME, u.LAST_NAME].filter(Boolean).join(' ').trim(),
    email: u.EMAIL || null,
  };
}

/**
 * Add a webhook-based portal.
 * Admin-created. The portal is shared across host users; the webhook's remote user
 * becomes the default mapping for the creator admin.
 */
async function addWebhookPortal({ adminHostUserId, title, webhookUrl }) {
  const domain = domainFromWebhook(webhookUrl);
  if (!domain) throw new Error('Invalid webhook URL');

  const validated = await validateWebhook(webhookUrl);
  if (!validated.ok) throw new Error(`Webhook validation failed: ${validated.error}`);

  return db.transaction(() => {
    const exists = db.prepare(`SELECT id FROM portals WHERE domain = ?`).get(domain);
    if (exists) throw new Error(`Portal ${domain} already added`);

    const portalRow = db.prepare(`
      INSERT INTO portals (owner_user_id, title, domain, auth_type, enabled)
      VALUES (?, ?, ?, 'webhook', 1)
    `).run(adminHostUserId, title || domain, domain);

    const portalId = portalRow.lastInsertRowid;
    saveCreds(portalId, { url: webhookUrl });

    // Default mapping: admin -> webhook owner on the remote portal.
    db.prepare(`
      INSERT INTO user_mappings (host_user_id, portal_id, remote_user_id, remote_user_name, remote_user_email, verified)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(adminHostUserId, portalId, validated.remoteUserId, validated.remoteUserName, validated.remoteUserEmail);

    const secret = randomToken(24);
    db.prepare(
      `INSERT INTO portal_inbound_secrets (portal_id, secret) VALUES (?, ?)`
    ).run(portalId, secret);

    return { portalId, secret, defaultMapping: { remoteUserId: validated.remoteUserId } };
  })();
}

/**
 * Add OAuth portal (called from OAuth callback).
 */
function addOauthPortal({ adminHostUserId, title, domain, accessToken, refreshToken, expiresIn, clientId, clientSecret, remoteUserId, remoteUserName, remoteUserEmail }) {
  return db.transaction(() => {
    const exists = db.prepare(`SELECT id FROM portals WHERE domain = ?`).get(domain);
    let portalId;
    if (exists) {
      portalId = exists.id;
      db.prepare(
        `UPDATE portals SET title = ?, auth_type='oauth', enabled = 1, last_error = NULL WHERE id = ?`
      ).run(title || domain, portalId);
    } else {
      const row = db.prepare(`
        INSERT INTO portals (owner_user_id, title, domain, auth_type, enabled)
        VALUES (?, ?, ?, 'oauth', 1)
      `).run(adminHostUserId, title || domain, domain);
      portalId = row.lastInsertRowid;
    }

    saveCreds(portalId, {
      accessToken,
      refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + (expiresIn || 3600) - 60,
      clientId,
      clientSecret,
      domain,
    });

    db.prepare(`
      INSERT INTO user_mappings (host_user_id, portal_id, remote_user_id, remote_user_name, remote_user_email, verified)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(host_user_id, portal_id) DO UPDATE SET
        remote_user_id = excluded.remote_user_id,
        remote_user_name = excluded.remote_user_name,
        remote_user_email = excluded.remote_user_email,
        verified = 1
    `).run(adminHostUserId, portalId, remoteUserId, remoteUserName, remoteUserEmail);

    if (!db.prepare(`SELECT 1 FROM portal_inbound_secrets WHERE portal_id = ?`).get(portalId)) {
      db.prepare(`INSERT INTO portal_inbound_secrets (portal_id, secret) VALUES (?, ?)`)
        .run(portalId, randomToken(24));
    }

    return portalId;
  })();
}

/**
 * List all portals (all users see the same portals; admin-created).
 */
function listAllPortals() {
  return db.prepare(`
    SELECT p.id, p.title, p.domain, p.auth_type, p.owner_user_id, p.enabled,
           p.last_polled_at, p.last_error, p.created_at,
           s.secret AS inbound_secret
    FROM portals p
    LEFT JOIN portal_inbound_secrets s ON s.portal_id = p.id
    ORDER BY p.created_at DESC
  `).all().map((p) => ({
    id: p.id,
    title: p.title,
    domain: p.domain,
    authType: p.auth_type,
    ownerUserId: p.owner_user_id,
    enabled: !!p.enabled,
    lastPolledAt: p.last_polled_at,
    lastError: p.last_error ? safeParse(p.last_error) : null,
    inboundSecret: p.inbound_secret,
    createdAt: p.created_at,
  }));
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

function deletePortal(portalId) {
  const info = db.prepare(`DELETE FROM portals WHERE id = ?`).run(portalId);
  if (info.changes === 0) throw new Error('Portal not found');
  return true;
}

function setPortalEnabled(portalId, enabled) {
  const info = db.prepare(`UPDATE portals SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, portalId);
  if (info.changes === 0) throw new Error('Portal not found');
  return true;
}

function getPortalById(portalId) {
  return db.prepare(
    `SELECT id, owner_user_id, title, domain, auth_type, enabled
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

// ============ USER MAPPINGS ============

function listMappings(hostUserDbId) {
  return db.prepare(`
    SELECT m.id, m.portal_id, m.remote_user_id, m.remote_user_name, m.remote_user_email, m.verified, m.created_at,
           p.title AS portal_title, p.domain AS portal_domain
    FROM user_mappings m
    JOIN portals p ON p.id = m.portal_id
    WHERE m.host_user_id = ?
    ORDER BY p.title
  `).all(hostUserDbId);
}

function listPortalMappings(portalId) {
  return db.prepare(`
    SELECT m.id, m.host_user_id, m.remote_user_id, m.remote_user_name, m.remote_user_email, m.verified,
           u.host_user_id AS host_raw_user_id
    FROM user_mappings m
    JOIN host_users u ON u.id = m.host_user_id
    WHERE m.portal_id = ?
    ORDER BY m.created_at
  `).all(portalId);
}

function getMapping(hostUserDbId, portalId) {
  return db.prepare(
    `SELECT * FROM user_mappings WHERE host_user_id = ? AND portal_id = ?`
  ).get(hostUserDbId, portalId);
}

function setMapping({ hostUserDbId, portalId, remoteUserId, remoteUserName, remoteUserEmail, verified }) {
  db.prepare(`
    INSERT INTO user_mappings (host_user_id, portal_id, remote_user_id, remote_user_name, remote_user_email, verified)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(host_user_id, portal_id) DO UPDATE SET
      remote_user_id = excluded.remote_user_id,
      remote_user_name = excluded.remote_user_name,
      remote_user_email = excluded.remote_user_email,
      verified = excluded.verified
  `).run(hostUserDbId, portalId, String(remoteUserId), remoteUserName || null, remoteUserEmail || null, verified ? 1 : 0);
}

function deleteMapping(hostUserDbId, portalId) {
  db.prepare(`DELETE FROM user_mappings WHERE host_user_id = ? AND portal_id = ?`)
    .run(hostUserDbId, portalId);
}

/**
 * All (portalId, remoteUserId) pairs that need polling, across all host users.
 * Deduplicated: each portal+remote_user combo returned once.
 */
function listAllPollingTargets() {
  return db.prepare(`
    SELECT DISTINCT m.portal_id, m.remote_user_id,
           p.domain, p.auth_type, p.enabled, p.title
    FROM user_mappings m
    JOIN portals p ON p.id = m.portal_id
    WHERE p.enabled = 1
  `).all();
}

module.exports = {
  ensureHostUser,
  domainFromWebhook,
  addWebhookPortal,
  addOauthPortal,
  validateWebhook,
  findRemoteUser,
  listAllPortals,
  deletePortal,
  setPortalEnabled,
  getPortalById,
  getInboundSecret,
  regenerateInboundSecret,
  loadCreds,
  saveCreds,
  listMappings,
  listPortalMappings,
  getMapping,
  setMapping,
  deleteMapping,
  listAllPollingTargets,
};
