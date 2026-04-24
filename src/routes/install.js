'use strict';

const express = require('express');
const { issueToken } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Bitrix24 sends POST to the iframe URL with auth params on placement load:
 * AUTH_ID, REFRESH_ID, AUTH_EXPIRES, member_id, status, PLACEMENT, PLACEMENT_OPTIONS, DOMAIN, USER_ID, ...
 *
 * We don't store the AUTH_ID (we don't need to call host-portal API on user's behalf for MVP);
 * we simply mint our own session token bound to (DOMAIN, USER_ID) and serve the SPA.
 *
 * GET also supported for direct opening of /install (debugging).
 */
/**
 * Admin login for testing before the app is registered as a Bitrix24 placement.
 * Usage: /admin-login?secret=<APP_ADMIN_SECRET>&domain=iumiti.bitrix24.ru&userId=1
 * Returns a session token just like the normal Bitrix24 install flow.
 */
router.get('/admin-login', (req, res) => {
  const secret = process.env.APP_ADMIN_SECRET;
  if (!secret) {
    return res.status(503).send('Admin login is disabled (APP_ADMIN_SECRET is not set)');
  }
  if (req.query.secret !== secret) {
    return res.status(403).send('Forbidden');
  }
  const domain = req.query.domain || process.env.HOST_PORTAL_DOMAIN;
  const userId = req.query.userId || req.query.user_id || '1';
  if (!domain) return res.status(400).send('Missing domain parameter');

  const token = issueToken(domain, userId);
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Уведомления — admin</title></head>
<body>
<script>
(function() {
  try {
    sessionStorage.setItem('app_token', ${JSON.stringify(token)});
    sessionStorage.setItem('host_portal', ${JSON.stringify(domain)});
    sessionStorage.setItem('host_user_id', ${JSON.stringify(String(userId))});
  } catch (e) {}
  window.location.replace('/?token=' + encodeURIComponent(${JSON.stringify(token)}));
})();
</script>
<noscript>Включите JavaScript</noscript>
</body></html>`);
});

router.all('/install', async (req, res) => {
  const params = { ...req.query, ...(req.body || {}) };
  const hostPortal = params.DOMAIN || params.domain || process.env.HOST_PORTAL_DOMAIN;
  const hostUserId = params.USER_ID || params.user_id || params.AUTH_USER_ID;

  if (!hostPortal || !hostUserId) {
    logger.warn('Install missing DOMAIN or USER_ID', params);
    // Fall back to dev mode if explicitly enabled
    if (process.env.NODE_ENV !== 'production') {
      const token = issueToken(
        process.env.HOST_PORTAL_DOMAIN || 'localhost',
        params.dev_user || '1'
      );
      return res.redirect(`/?token=${encodeURIComponent(token)}&dev=1`);
    }
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;padding:40px;">
        <h2>Не удалось определить пользователя</h2>
        <p>Приложение должно быть открыто внутри Битрикс24.</p>
        <pre>${JSON.stringify(params, null, 2)}</pre>
      </body></html>
    `);
  }

  const token = issueToken(hostPortal, hostUserId);
  // Render a tiny bootstrap page that stores the token in sessionStorage and redirects.
  // We can't 302-redirect because Bitrix24 uses POST and would lose the params.
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Уведомления</title></head>
<body>
<script>
(function() {
  var token = ${JSON.stringify(token)};
  var hostPortal = ${JSON.stringify(hostPortal)};
  var hostUserId = ${JSON.stringify(String(hostUserId))};
  try {
    sessionStorage.setItem('app_token', token);
    sessionStorage.setItem('host_portal', hostPortal);
    sessionStorage.setItem('host_user_id', hostUserId);
  } catch (e) {}
  window.location.replace('/?token=' + encodeURIComponent(token));
})();
</script>
<noscript>Включите JavaScript</noscript>
</body></html>`);
});

module.exports = router;
