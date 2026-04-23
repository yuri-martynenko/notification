'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'app.db');

// Ensure data directory exists
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS host_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_portal TEXT NOT NULL,
      host_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE (host_portal, host_user_id)
    );

    CREATE TABLE IF NOT EXISTS portals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_user_id INTEGER NOT NULL REFERENCES host_users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      domain TEXT NOT NULL,
      auth_type TEXT NOT NULL CHECK (auth_type IN ('webhook','oauth')),
      remote_user_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      poll_interval_sec INTEGER,
      last_polled_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE (host_user_id, domain)
    );

    -- Encrypted credentials. For webhook: { url }. For oauth: { accessToken, refreshToken, expiresAt, clientId, clientSecret }.
    CREATE TABLE IF NOT EXISTS portal_credentials (
      portal_id INTEGER PRIMARY KEY REFERENCES portals(id) ON DELETE CASCADE,
      ciphertext BLOB NOT NULL,
      iv BLOB NOT NULL,
      tag BLOB NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    -- Webhook secret token used to receive events from remote portal.
    CREATE TABLE IF NOT EXISTS portal_inbound_secrets (
      portal_id INTEGER PRIMARY KEY REFERENCES portals(id) ON DELETE CASCADE,
      secret TEXT NOT NULL,
      last_event_at INTEGER
    );

    -- Per-entity counters per portal. We store both "total" and a list of items in JSON.
    CREATE TABLE IF NOT EXISTS counters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portal_id INTEGER NOT NULL REFERENCES portals(id) ON DELETE CASCADE,
      entity TEXT NOT NULL CHECK (entity IN ('im','notify','tasks','crm','livefeed')),
      total INTEGER NOT NULL DEFAULT 0,
      items_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE (portal_id, entity)
    );

    -- Per-user app settings (poll interval override, etc).
    CREATE TABLE IF NOT EXISTS settings (
      host_user_id INTEGER PRIMARY KEY REFERENCES host_users(id) ON DELETE CASCADE,
      data_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    -- Idempotency for inbound webhook events (avoid double-processing).
    CREATE TABLE IF NOT EXISTS webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portal_id INTEGER NOT NULL REFERENCES portals(id) ON DELETE CASCADE,
      event_key TEXT NOT NULL,
      received_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE (portal_id, event_key)
    );

    CREATE INDEX IF NOT EXISTS idx_counters_portal ON counters(portal_id);
    CREATE INDEX IF NOT EXISTS idx_portals_user ON portals(host_user_id);
    CREATE INDEX IF NOT EXISTS idx_portals_enabled ON portals(enabled);
  `);
}

migrate();

module.exports = { db, migrate };
