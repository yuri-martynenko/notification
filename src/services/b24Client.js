'use strict';

const axios = require('axios');
const logger = require('../utils/logger');
const { db } = require('../db');
const { encryptJson, decryptJson } = require('../utils/crypto');

/**
 * Build base URL for a webhook-based portal.
 * webhookUrl example: https://example.bitrix24.ru/rest/123/abc123def456/
 */
function webhookBase(webhookUrl) {
  return webhookUrl.endsWith('/') ? webhookUrl : webhookUrl + '/';
}

/**
 * Build base URL for OAuth-based portal.
 */
function oauthBase(domain) {
  return `https://${domain}/rest/`;
}

/**
 * Load decrypted credentials for a portal row.
 */
function loadCreds(portalId) {
  const row = db.prepare(
    'SELECT ciphertext, iv, tag FROM portal_credentials WHERE portal_id = ?'
  ).get(portalId);
  if (!row) throw new Error(`No credentials for portal ${portalId}`);
  return decryptJson(row.ciphertext, row.iv, row.tag);
}

/**
 * Save (overwrite) credentials for a portal.
 */
function saveCreds(portalId, creds) {
  const { ciphertext, iv, tag } = encryptJson(creds);
  const stmt = db.prepare(`
    INSERT INTO portal_credentials (portal_id, ciphertext, iv, tag, updated_at)
    VALUES (?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(portal_id) DO UPDATE SET
      ciphertext = excluded.ciphertext,
      iv = excluded.iv,
      tag = excluded.tag,
      updated_at = strftime('%s','now')
  `);
  stmt.run(portalId, ciphertext, iv, tag);
}

/**
 * Refresh OAuth access token using refresh_token. Bitrix24 refresh tokens are valid for 28 days
 * and rotate on each refresh.
 */
async function refreshOauth(portal, creds) {
  const url = `https://oauth.bitrix.info/oauth/token/`;
  const params = {
    grant_type: 'refresh_token',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
  };
  const { data } = await axios.get(url, { params, timeout: 15000 });
  if (!data.access_token) {
    throw new Error('OAuth refresh failed: no access_token in response');
  }
  const updated = {
    ...creds,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in || 3600) - 60,
    domain: data.domain || creds.domain || portal.domain,
  };
  saveCreds(portal.id, updated);
  return updated;
}

/**
 * Call Bitrix24 REST method. Handles auth refresh and proper error parsing.
 *
 * @param {object} portal - portal row from DB ({id, domain, auth_type, ...})
 * @param {string} method - REST method, e.g. "im.counters.get"
 * @param {object} params - method params
 */
async function callMethod(portal, method, params = {}) {
  let creds = loadCreds(portal.id);

  let url;
  let body;
  let attempt = 0;

  while (attempt < 2) {
    attempt++;
    if (portal.auth_type === 'webhook') {
      url = `${webhookBase(creds.url)}${method}.json`;
      body = params;
    } else if (portal.auth_type === 'oauth') {
      // Refresh if expired
      if (!creds.accessToken || (creds.expiresAt && creds.expiresAt < Math.floor(Date.now() / 1000))) {
        creds = await refreshOauth(portal, creds);
      }
      url = `${oauthBase(creds.domain || portal.domain)}${method}.json`;
      body = { ...params, auth: creds.accessToken };
    } else {
      throw new Error(`Unsupported auth_type: ${portal.auth_type}`);
    }

    try {
      const { data } = await axios.post(url, body, {
        timeout: 15000,
        headers: { 'Content-Type': 'application/json' },
      });
      if (data && data.error) {
        // Try refresh once for OAuth on token errors
        if (
          portal.auth_type === 'oauth' &&
          ['expired_token', 'invalid_token', 'NO_AUTH_FOUND'].includes(data.error) &&
          attempt === 1
        ) {
          logger.warn(`Portal ${portal.id}: token expired, refreshing`);
          creds = await refreshOauth(portal, creds);
          continue;
        }
        const err = new Error(`B24 error ${data.error}: ${data.error_description || ''}`);
        err.b24error = data.error;
        throw err;
      }
      return data; // { result, time, total, next? }
    } catch (e) {
      if (attempt < 2 && portal.auth_type === 'oauth' && e.response && e.response.status === 401) {
        creds = await refreshOauth(portal, creds);
        continue;
      }
      throw e;
    }
  }
}

/**
 * Batch call up to 50 methods in one request.
 * cmds: { keyName: "method?param=value", ... }
 * Returns: { result: { result: {keyName: ...}, result_error: {...}, ... }, ... }
 */
async function callBatch(portal, cmds, halt = 0) {
  return callMethod(portal, 'batch', { halt, cmd: cmds });
}

module.exports = {
  callMethod,
  callBatch,
  loadCreds,
  saveCreds,
  refreshOauth,
};
