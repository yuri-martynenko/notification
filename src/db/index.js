'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'app.db');

const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function currentVersion() {
  return db.prepare('PRAGMA user_version').get().user_version;
}

function setVersion(v) {
  db.exec(`PRAGMA user_version = ${v}`);
}

function migrate() {
  // Version 1: initial schema (per-user portals)
  if (currentVersion() < 1) {
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

      CREATE TABLE IF NOT EXISTS portal_credentials (
        portal_id INTEGER PRIMARY KEY REFERENCES portals(id) ON DELETE CASCADE,
        ciphertext BLOB NOT NULL,
        iv BLOB NOT NULL,
        tag BLOB NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );

      CREATE TABLE IF NOT EXISTS portal_inbound_secrets (
        portal_id INTEGER PRIMARY KEY REFERENCES portals(id) ON DELETE CASCADE,
        secret TEXT NOT NULL,
        last_event_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS counters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        portal_id INTEGER NOT NULL REFERENCES portals(id) ON DELETE CASCADE,
        entity TEXT NOT NULL CHECK (entity IN ('im','notify','tasks','crm','livefeed')),
        total INTEGER NOT NULL DEFAULT 0,
        items_json TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        UNIQUE (portal_id, entity)
      );

      CREATE TABLE IF NOT EXISTS settings (
        host_user_id INTEGER PRIMARY KEY REFERENCES host_users(id) ON DELETE CASCADE,
        data_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );

      CREATE TABLE IF NOT EXISTS webhook_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        portal_id INTEGER NOT NULL REFERENCES portals(id) ON DELETE CASCADE,
        event_key TEXT NOT NULL,
        received_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        UNIQUE (portal_id, event_key)
      );
    `);
    setVersion(1);
  }

  // Version 2: admin-owned portals + user_mappings table
  if (currentVersion() < 2) {
    db.exec('BEGIN');
    try {
      // New portals table: owner_user_id (admin) + globally unique domain
      db.exec(`
        CREATE TABLE portals_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          owner_user_id INTEGER REFERENCES host_users(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          domain TEXT NOT NULL UNIQUE,
          auth_type TEXT NOT NULL CHECK (auth_type IN ('webhook','oauth')),
          enabled INTEGER NOT NULL DEFAULT 1,
          poll_interval_sec INTEGER,
          last_polled_at INTEGER,
          last_error TEXT,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );
      `);

      const insP = db.prepare(`
        INSERT INTO portals_new (id, owner_user_id, title, domain, auth_type, enabled, poll_interval_sec, last_polled_at, last_error, created_at)
        VALUES (@id, @host_user_id, @title, @domain, @auth_type, @enabled, @poll_interval_sec, @last_polled_at, @last_error, @created_at)
      `);
      for (const p of db.prepare(`SELECT * FROM portals`).all()) {
        try { insP.run(p); } catch (e) { /* skip dupes */ }
      }

      db.exec(`
        CREATE TABLE user_mappings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          host_user_id INTEGER NOT NULL REFERENCES host_users(id) ON DELETE CASCADE,
          portal_id INTEGER NOT NULL REFERENCES portals_new(id) ON DELETE CASCADE,
          remote_user_id TEXT NOT NULL,
          remote_user_name TEXT,
          remote_user_email TEXT,
          verified INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          UNIQUE (host_user_id, portal_id)
        );
      `);

      const insM = db.prepare(`
        INSERT OR IGNORE INTO user_mappings (host_user_id, portal_id, remote_user_id, verified)
        VALUES (?, ?, ?, 1)
      `);
      for (const m of db.prepare(`SELECT id, host_user_id, remote_user_id FROM portals WHERE remote_user_id IS NOT NULL`).all()) {
        insM.run(m.host_user_id, m.id, m.remote_user_id);
      }

      db.exec(`
        CREATE TABLE counters_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          portal_id INTEGER NOT NULL REFERENCES portals_new(id) ON DELETE CASCADE,
          remote_user_id TEXT NOT NULL,
          entity TEXT NOT NULL CHECK (entity IN ('im','notify','tasks','crm','livefeed')),
          total INTEGER NOT NULL DEFAULT 0,
          items_json TEXT NOT NULL DEFAULT '[]',
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          UNIQUE (portal_id, remote_user_id, entity)
        );
      `);

      const insC = db.prepare(`
        INSERT OR IGNORE INTO counters_new (portal_id, remote_user_id, entity, total, items_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const c of db.prepare(`
        SELECT c.*, p.remote_user_id AS ru FROM counters c JOIN portals p ON p.id = c.portal_id
      `).all()) {
        if (c.ru) insC.run(c.portal_id, c.ru, c.entity, c.total, c.items_json, c.updated_at);
      }

      db.exec(`
        DROP TABLE counters;
        ALTER TABLE counters_new RENAME TO counters;
        DROP TABLE portals;
        ALTER TABLE portals_new RENAME TO portals;

        CREATE TABLE IF NOT EXISTS polling_state (
          portal_id INTEGER NOT NULL REFERENCES portals(id) ON DELETE CASCADE,
          remote_user_id TEXT NOT NULL,
          last_polled_at INTEGER,
          last_error TEXT,
          PRIMARY KEY (portal_id, remote_user_id)
        );

        CREATE INDEX IF NOT EXISTS idx_counters_portal_user ON counters(portal_id, remote_user_id);
        CREATE INDEX IF NOT EXISTS idx_user_mappings_user ON user_mappings(host_user_id);
        CREATE INDEX IF NOT EXISTS idx_user_mappings_portal ON user_mappings(portal_id);
        CREATE INDEX IF NOT EXISTS idx_portals_enabled ON portals(enabled);
      `);

      setVersion(2);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

migrate();

module.exports = { db, migrate };
