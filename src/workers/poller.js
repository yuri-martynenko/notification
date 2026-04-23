'use strict';

const { db } = require('../db');
const { refreshPortalCounters } = require('../services/counters');
const { getSettings } = require('../services/settings');
const logger = require('../utils/logger');

let timer = null;
let running = false;

/**
 * Iterate all enabled portals and refresh those whose poll-interval has elapsed.
 */
async function tick() {
  if (running) return;
  running = true;
  const startedAt = Date.now();
  let processed = 0;

  try {
    const portals = db.prepare(`
      SELECT p.*, hu.id AS host_user_id
      FROM portals p
      JOIN host_users hu ON hu.id = p.host_user_id
      WHERE p.enabled = 1
    `).all();

    const now = Math.floor(Date.now() / 1000);

    for (const portal of portals) {
      const settings = getSettings(portal.host_user_id);
      const interval = portal.poll_interval_sec || settings.pollIntervalSec;
      const lastPolled = portal.last_polled_at || 0;
      if (now - lastPolled < interval) continue;

      try {
        await refreshPortalCounters(portal, settings.enabledEntities);
        processed++;
      } catch (e) {
        logger.error(`Portal ${portal.id} refresh failed:`, e.message);
        db.prepare(
          `UPDATE portals SET last_polled_at = strftime('%s','now'), last_error = ? WHERE id = ?`
        ).run(JSON.stringify({ message: e.message }), portal.id);
      }
    }

    if (processed > 0) {
      logger.info(`Polling tick: refreshed ${processed} portals in ${Date.now() - startedAt}ms`);
    }
  } catch (e) {
    logger.error('Polling tick failed:', e);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  // Run a tick every 15s. Per-portal interval is enforced inside tick().
  timer = setInterval(tick, 15000);
  logger.info('Polling worker started (tick=15s)');
  // First tick immediately after a short delay
  setTimeout(tick, 3000);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, tick };
