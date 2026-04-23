'use strict';

const { db } = require('../db');

const DEFAULTS = {
  pollIntervalSec: parseInt(process.env.DEFAULT_POLL_INTERVAL_SEC || '120', 10),
  enabledEntities: ['im', 'notify', 'tasks', 'crm', 'livefeed'],
  showZeroCounters: false,
};

function getSettings(hostUserId) {
  const row = db.prepare(`SELECT data_json FROM settings WHERE host_user_id = ?`).get(hostUserId);
  if (!row) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(row.data_json) };
  } catch {
    return { ...DEFAULTS };
  }
}

function setSettings(hostUserId, partial) {
  const merged = { ...getSettings(hostUserId), ...partial };
  // Validate
  if (merged.pollIntervalSec < 15) merged.pollIntervalSec = 15;
  if (merged.pollIntervalSec > 3600) merged.pollIntervalSec = 3600;
  if (!Array.isArray(merged.enabledEntities)) merged.enabledEntities = DEFAULTS.enabledEntities;

  db.prepare(`
    INSERT INTO settings (host_user_id, data_json, updated_at)
    VALUES (?, ?, strftime('%s','now'))
    ON CONFLICT(host_user_id) DO UPDATE SET
      data_json = excluded.data_json,
      updated_at = strftime('%s','now')
  `).run(hostUserId, JSON.stringify(merged));

  return merged;
}

module.exports = { getSettings, setSettings, DEFAULTS };
