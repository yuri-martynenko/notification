'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');
const { ensureHostUser } = require('../services/portals');

/**
 * Sign a session token { hostPortal, hostUserId, exp } with HMAC-SHA256.
 */
function sign(payload) {
  const key = process.env.ENCRYPTION_KEY || 'dev';
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const key = process.env.ENCRYPTION_KEY || 'dev';
  const expected = crypto.createHmac('sha256', key).update(body).digest('base64url');
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (data.exp && data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Issue a session token for a host user.
 */
function issueToken(hostPortal, hostUserId, ttlSec = 86400) {
  return sign({
    hostPortal,
    hostUserId: String(hostUserId),
    exp: Math.floor(Date.now() / 1000) + ttlSec,
  });
}

/**
 * Express middleware: requires X-App-Token header or ?token= query.
 * Populates req.session = { hostPortal, hostUserId, hostUserDbId }.
 */
function requireSession(req, res, next) {
  const token =
    req.get('x-app-token') ||
    req.query.token ||
    (req.cookies && req.cookies.app_token);
  const session = verify(token);
  if (!session) {
    return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid app token' });
  }
  const dbId = ensureHostUser(session.hostPortal, session.hostUserId);
  req.session = { ...session, hostUserDbId: dbId };
  next();
}

module.exports = { sign, verify, issueToken, requireSession };
