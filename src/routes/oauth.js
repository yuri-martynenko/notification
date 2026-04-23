'use strict';

const express = require('express');
const axios = require('axios');
const { requireSession, verify } = require('../middleware/auth');
const { addOauthPortal, ensureHostUser } = require('../services/portals');
const { refreshPortalCounters } = require('../services/counters');
const { getPortalById } = require('../services/portals');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Step 1: User in our SPA clicks "Connect via OAuth".
 * They paste their app credentials from the remote portal:
 *   - Domain (e.g. "other.bitrix24.ru")
 *   - clientId, clientSecret (from a "локальное приложение" they registered there)
 * We then redirect them to the remote portal's authorization endpoint.
 *
 * GET /api/oauth/start?token=...&domain=other.bitrix24.ru&clientId=...&clientSecret=...&title=...
 */
router.get('/start', requireSession, (req, res) => {
  const { domain, clientId, clientSecret, title } = req.query;
  if (!domain || !clientId || !clientSecret) {
    return res.status(400).json({ error: 'missing_params', message: 'domain, clientId, clientSecret are required' });
  }
  // Encode state with our session info + the credentials we'll need at callback.
  // (clientSecret in state is acceptable here because state goes back to us, not to the user, over HTTPS.)
  const state = Buffer.from(JSON.stringify({
    hostPortal: req.session.hostPortal,
    hostUserId: req.session.hostUserId,
    domain,
    clientId,
    clientSecret,
    title: title || domain,
    nonce: Math.random().toString(36).slice(2),
  })).toString('base64url');

  const redirectUri = `${(process.env.APP_PUBLIC_URL || '').replace(/\/$/, '')}/api/oauth/callback`;
  const authUrl =
    `https://${domain}/oauth/authorize/?` +
    `client_id=${encodeURIComponent(clientId)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;

  res.json({ ok: true, authUrl });
});

/**
 * Step 2: Remote portal redirects user back here with ?code=...&state=...
 */
router.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) {
    return res.status(400).send('Missing code or state');
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
  } catch {
    return res.status(400).send('Invalid state');
  }

  try {
    // Exchange code for tokens
    const tokenUrl = `https://oauth.bitrix.info/oauth/token/`;
    const { data } = await axios.get(tokenUrl, {
      params: {
        grant_type: 'authorization_code',
        client_id: parsed.clientId,
        client_secret: parsed.clientSecret,
        code,
      },
      timeout: 15000,
    });
    if (!data.access_token) {
      throw new Error('Token exchange returned no access_token');
    }

    // Get current user on remote portal
    const userResp = await axios.post(
      `https://${data.domain || parsed.domain}/rest/user.current.json`,
      { auth: data.access_token },
      { timeout: 15000 }
    );
    const remoteUserId = userResp.data && userResp.data.result ? String(userResp.data.result.ID) : null;

    const hostUserDbId = ensureHostUser(parsed.hostPortal, parsed.hostUserId);
    const portalId = addOauthPortal({
      hostUserId: hostUserDbId,
      title: parsed.title,
      domain: data.domain || parsed.domain,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      clientId: parsed.clientId,
      clientSecret: parsed.clientSecret,
      remoteUserId,
    });

    // Trigger initial fetch
    const portal = getPortalById(portalId);
    refreshPortalCounters(portal).catch((e) =>
      logger.warn(`Initial OAuth portal refresh failed: ${e.message}`)
    );

    res.send(`<!doctype html>
<html><body style="font-family:sans-serif;padding:40px;text-align:center;">
  <h2 style="color:#22a06b;">✓ Портал подключён</h2>
  <p><b>${parsed.title}</b> успешно добавлен.</p>
  <p>Это окно можно закрыть.</p>
  <script>setTimeout(function(){ try { window.opener && window.opener.postMessage({type:'oauth:done', portalId:${portalId}}, '*'); window.close(); } catch(e){} }, 800);</script>
</body></html>`);
  } catch (e) {
    logger.error('OAuth callback failed:', e.response?.data || e.message);
    res.status(500).send(`<!doctype html>
<html><body style="font-family:sans-serif;padding:40px;">
  <h2 style="color:#dc3545;">Ошибка подключения</h2>
  <pre>${(e.response?.data && JSON.stringify(e.response.data, null, 2)) || e.message}</pre>
</body></html>`);
  }
});

module.exports = router;
