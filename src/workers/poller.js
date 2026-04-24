'use strict';

const { db } = require('../db');
const { refreshCounters } = require('../services/counters');
const { getSettings } = require('../services/settings');
const { listAllPollingTargets } = require('../services/portals');
const logger = require('../utils/logger');

let timer = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  const startedAt = Date.now();
  let processed = 0;

  try {
    const targets = listAllPollingTargets(); // [{portal_id, remote_user_id, domain, auth_type, enabled, title}]
    const now = Math.floor(Date.now() / 1000);

    for (const t of targets) {
      const portal = { id: t.portal_id, domain: t.domain, auth_type: t.auth_type, enabled: t.enabled, title: t.title };
      // Find most restrictive interval: take the smallest pollIntervalSec among host users mapped to this portal.
      // Default if nobody configured.
      const mappedUsers = db.prepare(
        `SELECT host_user_id FROM user_mappings WHERE portal_id = ? AND remote_user_id = ?`
      ).all(t.portal_id, t.remote_user_id);

      let minInterval = 3600;
      for (const u of mappedUsers) {
        const s = getSettings(u.host_user_id);
        if (s.pollIntervalSec < minInterval) minInterval = s.pollIntervalSec;
      }
      if (!mappedUsers.length) minInterval = 120;

      const state = db.prepare(
        `SELECT last_polled_at FROM polling_state WHERE portal_id = ? AND remote_user_id = ?`
      ).get(t.portal_id, t.remote_user_id);
      const lastPolled = state ? state.last_polled_at || 0 : 0;
      if (now - lastPolled < minInterval) continue;

      // Combine enabled entities from all mapped users (union).
      const enabled = new Set();
      for (const u of mappedUsers) {
        const s = getSettings(u.host_user_id);
        for (const e of s.enabledEntities) enabled.add(e);
      }
      const entities = Array.from(enabled);

      try {
        await refreshCounters(portal, t.remote_user_id, entities);
        processed++;
      } catch (e) {
        logger.error(`Polling ${portal.domain}:${t.remote_user_id} failed:`, e.message);
        db.prepare(`
          INSERT INTO polling_state (portal_id, remote_user_id, last_polled_at, last_error)
          VALUES (?, ?, strftime('%s','now'), ?)
          ON CONFLICT(portal_id, remote_user_id) DO UPDATE SET
            last_polled_at = strftime('%s','now'),
            last_error = excluded.last_error
        `).run(t.portal_id, t.remote_user_id, JSON.stringify({ message: e.message }));
      }
    }

    if (processed > 0) {
      logger.info(`Polling tick: refreshed ${processed} targets in ${Date.now() - startedAt}ms`);
    }
  } catch (e) {
    logger.error('Polling tick failed:', e);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(tick, 15000);
  logger.info('Polling worker started (tick=15s)');
  setTimeout(tick, 3000);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, tick };
