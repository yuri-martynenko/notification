'use strict';

const express = require('express');
const { requireSession, requireAdmin } = require('../middleware/auth');
const { ensureHostUser } = require('../services/portals');

const router = express.Router();

router.use(requireSession);
router.use(requireAdmin);

/**
 * Create-or-fetch host_user for an arbitrary USER_ID on the host portal.
 * Admin-only. Used when admin adds a mapping for a user that hasn't opened the app yet.
 * Body: { hostUserId }
 */
router.post('/ensure', (req, res) => {
  const { hostUserId } = req.body || {};
  if (!hostUserId) return res.status(400).json({ error: 'missing_hostUserId' });
  const id = ensureHostUser(req.session.hostPortal, String(hostUserId));
  res.json({ id, hostPortal: req.session.hostPortal, hostUserId: String(hostUserId) });
});

module.exports = router;
