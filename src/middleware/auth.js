'use strict';

const crypto = require('crypto');
const { ensureHostUser } = require('../services/portals');

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

function issueToken(hostPortal, hostUserId, ttlSec = 86400) {
  return sign({
    hostPortal,
    hostUserId: String(hostUserId),
    exp: Math.floor(Date.now() / 1000) + ttlSec,
  });
}

function isAdmin(hostUserId) {
  const raw = (process.env.ADMIN_USER_IDS || '1').trim();
  if (!raw) return String(hostUserId) === '1';
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(String(hostUserId));
}

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
  req.session = {
    ...session,
    hostUserDbId: dbId,
    isAdmin: isAdmin(session.hostUserId),
  };
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.isAdmin) {
    return res.status(403).json({ error: 'forbidden', message: 'Admin access required' });
  }
  next();
}

module.exports = { sign, verify, issueToken, requireSession, requireAdmin, isAdmin };
