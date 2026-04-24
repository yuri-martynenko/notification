'use strict';

const { db } = require('../db');
const b24 = require('./b24Client');
const logger = require('../utils/logger');

function buildLink(portal, entity, payload = {}) {
  const base = `https://${portal.domain}`;
  switch (entity) {
    case 'im':
      if (payload.dialogId) return `${base}/online/?IM_DIALOG=${encodeURIComponent(payload.dialogId)}`;
      return `${base}/online/`;
    case 'notify':
      return `${base}/online/?IM_HISTORY=NOTIFY`;
    case 'tasks':
      if (payload.taskId) return `${base}/company/personal/user/${payload.userId || 0}/tasks/task/view/${payload.taskId}/`;
      return `${base}/company/personal/user/${payload.userId || 0}/tasks/`;
    case 'crm':
      if (payload.entityType && payload.id) {
        const map = { LEAD: 'lead', DEAL: 'deal', CONTACT: 'contact', COMPANY: 'company' };
        const slug = map[payload.entityType] || 'lead';
        return `${base}/crm/${slug}/details/${payload.id}/`;
      }
      return `${base}/crm/`;
    case 'livefeed':
      if (payload.postId) return `${base}/company/personal/log/${payload.postId}/`;
      return `${base}/company/personal/log/`;
    default:
      return base;
  }
}

/**
 * IM counters. When using webhook auth, the counters returned reflect the webhook-owner user.
 * For OAuth, they reflect the authenticated user. Passing remoteUserId is informational here
 * (we use it only for link building and caching).
 */
async function fetchIm(portal, remoteUserId) {
  const counters = await b24.callMethod(portal, 'im.counter.get').catch(() => null);
  const recent = await b24.callMethod(portal, 'im.recent.get', { SKIP_OPENLINES: 'N' }).catch(() => ({ result: [] }));

  let total = 0;
  const items = [];
  const list = (recent && recent.result) || [];
  for (const r of list) {
    const cnt = Number(r.counter || 0);
    if (cnt > 0) {
      total += cnt;
      items.push({
        dialogId: r.id || r.chat_id || r.user_id,
        title: r.title || (r.user && (r.user.name || r.user.fullname)) || 'Чат',
        count: cnt,
        lastMessageAt: r.message && r.message.date ? r.message.date : null,
        link: buildLink(portal, 'im', { dialogId: r.id || r.chat_id || r.user_id }),
      });
    }
  }
  if (total === 0 && counters && counters.result) {
    const c = counters.result;
    total = Number(c.TYPE?.CHAT || 0) + Number(c.TYPE?.DIALOG || 0) + Number(c.TYPE?.LINES || 0);
  }
  items.sort((a, b) => (b.lastMessageAt || '').localeCompare(a.lastMessageAt || ''));
  return { total, items: items.slice(0, 50) };
}

async function fetchNotify(portal, remoteUserId) {
  const data = await b24.callMethod(portal, 'im.notify.history.get', { LIMIT: 50 }).catch(() => null);
  const items = [];
  let total = 0;
  if (data && data.result) {
    const list = Array.isArray(data.result) ? data.result : (data.result.notifications || data.result.NOTIFY || []);
    for (const n of list) {
      if (n.unread === false || n.UNREAD === 'N') continue;
      total++;
      items.push({
        id: n.id || n.ID,
        title: n.title || n.TITLE || (n.text || n.TEXT || '').slice(0, 80),
        text: (n.text || n.TEXT || '').replace(/<[^>]+>/g, '').slice(0, 200),
        date: n.date || n.DATE,
        link: buildLink(portal, 'notify'),
      });
    }
  }
  if (total === 0) {
    const c = await b24.callMethod(portal, 'im.counter.get').catch(() => null);
    if (c && c.result) total = Number(c.result.TYPE?.NOTIFY || c.result.NOTIFY || 0);
  }
  return { total, items: items.slice(0, 50) };
}

async function fetchTasks(portal, remoteUserId) {
  if (!remoteUserId) return { total: 0, items: [] };
  const params = {
    select: ['ID', 'TITLE', 'STATUS', 'PRIORITY', 'DEADLINE', 'CREATED_DATE', 'GROUP_ID'],
    filter: { '<STATUS': 5, RESPONSIBLE_ID: remoteUserId },
    order: { DEADLINE: 'ASC' },
    start: 0,
  };
  const data = await b24.callMethod(portal, 'tasks.task.list', params).catch(() => null);
  const items = [];
  if (data && data.result && data.result.tasks) {
    for (const t of data.result.tasks) {
      items.push({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        deadline: t.deadline,
        link: buildLink(portal, 'tasks', { taskId: t.id, userId: remoteUserId }),
      });
    }
  }
  return { total: items.length, items: items.slice(0, 50) };
}

async function fetchCrm(portal, remoteUserId) {
  if (!remoteUserId) return { total: 0, items: [] };
  const cmd = {
    deals: `crm.deal.list?filter[ASSIGNED_BY_ID]=${remoteUserId}&filter[CLOSED]=N&select[]=ID&select[]=TITLE&select[]=STAGE_ID&select[]=DATE_MODIFY&select[]=OPPORTUNITY&select[]=CURRENCY_ID&order[DATE_MODIFY]=DESC`,
    leads: `crm.lead.list?filter[ASSIGNED_BY_ID]=${remoteUserId}&filter[STATUS_ID]=NEW&select[]=ID&select[]=TITLE&select[]=DATE_CREATE&order[DATE_CREATE]=DESC`,
  };
  const data = await b24.callBatch(portal, cmd).catch(() => null);
  const items = [];
  if (data && data.result && data.result.result) {
    const deals = data.result.result.deals || [];
    const leads = data.result.result.leads || [];
    for (const d of deals.slice(0, 25)) {
      items.push({
        id: d.ID,
        type: 'DEAL',
        title: d.TITLE || `Сделка #${d.ID}`,
        amount: d.OPPORTUNITY,
        currency: d.CURRENCY_ID,
        date: d.DATE_MODIFY,
        link: buildLink(portal, 'crm', { entityType: 'DEAL', id: d.ID }),
      });
    }
    for (const l of leads.slice(0, 25)) {
      items.push({
        id: l.ID,
        type: 'LEAD',
        title: l.TITLE || `Лид #${l.ID}`,
        date: l.DATE_CREATE,
        link: buildLink(portal, 'crm', { entityType: 'LEAD', id: l.ID }),
      });
    }
  }
  return { total: items.length, items };
}

async function fetchLivefeed(portal, remoteUserId) {
  const data = await b24.callMethod(portal, 'log.blogpost.get', { LAST_ID: 0, PAGE_SIZE: 50 }).catch(() => null);
  const items = [];
  let total = 0;
  if (data && data.result) {
    const list = Array.isArray(data.result) ? data.result : (data.result.posts || []);
    for (const p of list.slice(0, 30)) {
      items.push({
        id: p.ID || p.id,
        title: (p.TITLE || p.title || '').slice(0, 100) || 'Запись в ленте',
        text: (p.DETAIL_TEXT || p.detail_text || '').replace(/<[^>]+>/g, '').slice(0, 200),
        date: p.DATE_PUBLISH || p.date_publish,
        author: p.AUTHOR_ID || p.author_id,
        link: buildLink(portal, 'livefeed', { postId: p.ID || p.id }),
      });
    }
    total = items.length;
  }
  return { total, items };
}

const FETCHERS = { im: fetchIm, notify: fetchNotify, tasks: fetchTasks, crm: fetchCrm, livefeed: fetchLivefeed };

/**
 * Refresh counters for a specific (portal, remote_user_id) pair.
 */
async function refreshCounters(portal, remoteUserId, entitiesFilter = null) {
  const entities = entitiesFilter || Object.keys(FETCHERS);
  const result = {};
  const errors = [];

  for (const entity of entities) {
    try {
      const data = await FETCHERS[entity](portal, remoteUserId);
      db.prepare(`
        INSERT INTO counters (portal_id, remote_user_id, entity, total, items_json, updated_at)
        VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
        ON CONFLICT(portal_id, remote_user_id, entity) DO UPDATE SET
          total = excluded.total,
          items_json = excluded.items_json,
          updated_at = strftime('%s','now')
      `).run(portal.id, String(remoteUserId), entity, data.total, JSON.stringify(data.items));
      result[entity] = data;
    } catch (e) {
      logger.warn(`Portal ${portal.id} (${portal.domain}) user=${remoteUserId} ${entity}: ${e.message}`);
      errors.push({ entity, message: e.message });
    }
  }

  db.prepare(`
    INSERT INTO polling_state (portal_id, remote_user_id, last_polled_at, last_error)
    VALUES (?, ?, strftime('%s','now'), ?)
    ON CONFLICT(portal_id, remote_user_id) DO UPDATE SET
      last_polled_at = strftime('%s','now'),
      last_error = excluded.last_error
  `).run(portal.id, String(remoteUserId), errors.length ? JSON.stringify(errors) : null);

  db.prepare(
    `UPDATE portals SET last_polled_at = strftime('%s','now'), last_error = ? WHERE id = ?`
  ).run(errors.length ? JSON.stringify(errors) : null, portal.id);

  return { result, errors };
}

/**
 * Read counters for the specified host user.
 * Uses each portal's mapping to pick the correct remote_user_id.
 */
function readUserCounters(hostUserDbId) {
  const mappings = db.prepare(`
    SELECT m.portal_id, m.remote_user_id, m.remote_user_name, m.remote_user_email,
           p.title, p.domain, p.auth_type, p.enabled, p.last_polled_at, p.last_error
    FROM user_mappings m
    JOIN portals p ON p.id = m.portal_id
    WHERE m.host_user_id = ? AND p.enabled = 1
    ORDER BY p.title
  `).all(hostUserDbId);

  const out = [];
  for (const m of mappings) {
    const counters = db.prepare(`
      SELECT entity, total, items_json, updated_at FROM counters
      WHERE portal_id = ? AND remote_user_id = ?
    `).all(m.portal_id, m.remote_user_id);

    const byEntity = {};
    let portalTotal = 0;
    for (const c of counters) {
      byEntity[c.entity] = {
        total: c.total,
        items: JSON.parse(c.items_json),
        updatedAt: c.updated_at,
      };
      portalTotal += c.total;
    }

    const state = db.prepare(
      `SELECT last_polled_at, last_error FROM polling_state WHERE portal_id = ? AND remote_user_id = ?`
    ).get(m.portal_id, m.remote_user_id);

    out.push({
      portal: {
        id: m.portal_id,
        title: m.title,
        domain: m.domain,
        authType: m.auth_type,
      },
      mapping: {
        remoteUserId: m.remote_user_id,
        remoteUserName: m.remote_user_name,
        remoteUserEmail: m.remote_user_email,
      },
      lastPolledAt: state ? state.last_polled_at : null,
      lastError: state && state.last_error ? safeParse(state.last_error) : null,
      total: portalTotal,
      counters: byEntity,
    });
  }
  return out;
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

module.exports = { refreshCounters, readUserCounters, buildLink, FETCHERS };
