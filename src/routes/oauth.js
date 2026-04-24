'use strict';

const express = require('express');
const axios = require('axios');
const { requireSession, requireAdmin } = require('../middleware/auth');
const { addOauthPortal, ensureHostUser, getPortalById, getMapping } = require('../services/portals');
const { refreshCounters } = require('../services/counters');
const logger = require('../utils/logger');

const router = express.Router();

router.get('/start', requireSession, requireAdmin, (req, res) => {
  const { domain, clientId, clientSecret, title } = req.query;
  if (!domain || !clientId || !clientSecret) {
    return res.status(400).json({ error: 'missing_params', message: 'domain, clientId, clientSecret are required' });
  }
  const state = Buffer.from(JSON.stringify({
    hostPortal: req.session.hostPortal,
    hostUserId: req.session.hostUserId,
    domain, clientId, clientSecret,
    title: title || domain,
    nonce: Math.random().toString(36).slice(2),
  })).toString('base64url');

  const redirectUri = `${(process.env.APP_PUBLIC_URL || '').replace(/\/$/, '')}/api/oauth/callback`;
  const authUrl =
    `https://${domain}/oauth/authorize/?` +
    `client_id=${encodeURIComponent(clientId)}` +
    `&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  res.json({ ok: true, authUrl });
});

router.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Missing code or state');
  let parsed;
  try { parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')); }
  catch { return res.status(400).send('Invalid state'); }

  try {
    const { data } = await axios.get('https://oauth.bitrix.info/oauth/token/', {
      params: {
        grant_type: 'authorization_code',
        client_id: parsed.clientId,
        client_secret: parsed.clientSecret,
        code,
      },
      timeout: 15000,
    });
    if (!data.access_token) throw new Error('Token exchange returned no access_token');

    const userResp = await axios.post(
      `https://${data.domain || parsed.domain}/rest/user.current.json`,
      { auth: data.access_token },
      { timeout: 15000 }
    );
    const r = userResp.data && userResp.data.result;
    const remoteUserId = r ? String(r.ID) : null;
    const remoteUserName = r ? [r.NAME, r.LAST_NAME].filter(Boolean).join(' ').trim() : null;
    const remoteUserEmail = r ? r.EMAIL : null;

    const hostUserDbId = ensureHostUser(parsed.hostPortal, parsed.hostUserId);
    const portalId = addOauthPortal({
      adminHostUserId: hostUserDbId,
      title: parsed.title,
      domain: data.domain || parsed.domain,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      clientId: parsed.clientId,
      clientSecret: parsed.clientSecret,
      remoteUserId,
      remoteUserName,
      remoteUserEmail,
    });

    const portal = getPortalById(portalId);
    const mapping = getMapping(hostUserDbId, portalId);
    if (mapping) {
      refreshCounters(portal, mapping.remote_user_id).catch((e) =>
        logger.warn(`Initial OAuth portal refresh failed: ${e.message}`)
      );
    }

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
