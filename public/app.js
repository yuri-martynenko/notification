'use strict';

(function () {
  // Get token from query string or sessionStorage
  function getToken() {
    const url = new URL(window.location.href);
    const t = url.searchParams.get('token');
    if (t) {
      try { sessionStorage.setItem('app_token', t); } catch (e) {}
      return t;
    }
    try { return sessionStorage.getItem('app_token'); } catch (e) { return null; }
  }

  const TOKEN = getToken();

  if (!TOKEN) {
    document.body.innerHTML = '<div style="padding:60px;text-align:center;font-family:sans-serif;"><h2>Сессия не найдена</h2><p>Откройте приложение из меню Битрикс24.</p></div>';
    return;
  }

  function api(path, options = {}) {
    const opts = Object.assign({}, options);
    opts.headers = Object.assign({ 'X-App-Token': TOKEN, 'Content-Type': 'application/json' }, options.headers || {});
    if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    return fetch(path, opts).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.message || data.error || `HTTP ${r.status}`);
      return data;
    });
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function toast(msg, type) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (type ? ' toast-' + type : '');
    setTimeout(() => t.classList.add('hidden'), 3000);
  }

  function show(modalId) {
    $(modalId).classList.remove('hidden');
  }
  function hide(modalId) {
    $(modalId).classList.add('hidden');
  }

  // Wire modal close behavior
  $$('.modal').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target.hasAttribute('data-close')) m.classList.add('hidden');
    });
  });

  // Tabs in add modal
  $$('#modal-add .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('#modal-add .tab').forEach((t) => t.classList.toggle('active', t === tab));
      $$('#modal-add .tab-content').forEach((c) =>
        c.classList.toggle('hidden', c.id !== 'tab-' + tab.dataset.tab)
      );
    });
  });

  const ENTITY_META = {
    im: { icon: '💬', name: 'Чаты' },
    notify: { icon: '🔔', name: 'Уведомления' },
    tasks: { icon: '✅', name: 'Задачи' },
    crm: { icon: '👥', name: 'CRM' },
    livefeed: { icon: '📰', name: 'Лента' },
  };

  function fmtDate(s) {
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d)) return s;
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60000) return 'только что';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' мин назад';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' ч назад';
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
  }

  function renderItem(item) {
    const title = item.title || item.text || ('#' + item.id);
    const sub = item.date || item.lastMessageAt;
    return `<a class="item" href="${item.link}" target="_blank" rel="noopener" title="${title.replace(/"/g, '&quot;')}">${title}${sub ? ' <small>· ' + fmtDate(sub) + '</small>' : ''}</a>`;
  }

  function renderPortal(p) {
    const counters = p.counters || {};
    const errBanner = p.portal.lastError && p.portal.lastError.length
      ? `<div class="error-banner">⚠ Последнее обновление с ошибками: ${p.portal.lastError.map(e => e.entity + ' (' + e.message + ')').join('; ')}</div>`
      : '';

    const cells = Object.keys(ENTITY_META).map((ent) => {
      const c = counters[ent];
      if (!c) return '';
      const total = c.total || 0;
      const items = (c.items || []).slice(0, 5);
      return `
        <div class="entity-cell" data-portal="${p.portal.id}" data-entity="${ent}">
          <div class="entity-cell-head">
            <span><span class="entity-icon">${ENTITY_META[ent].icon}</span><span class="entity-name">${ENTITY_META[ent].name}</span></span>
            <span class="badge ${total > 0 ? '' : 'badge-muted'}">${total}</span>
          </div>
          <div class="entity-items">
            ${items.length ? items.map(renderItem).join('') : '<span class="entity-empty">Нет новых</span>'}
          </div>
        </div>
      `;
    }).join('');

    const lastPolled = p.portal.lastPolledAt
      ? 'обновлено ' + fmtDate(p.portal.lastPolledAt * 1000)
      : 'ещё не обновлялось';

    return `
      <div class="portal-card" data-portal-id="${p.portal.id}">
        <div class="portal-header">
          <div class="portal-title">
            <a href="https://${p.portal.domain}" target="_blank" rel="noopener">${p.portal.title}</a>
            ${p.total > 0 ? `<span class="badge-grand">${p.total}</span>` : ''}
            <span class="portal-domain">· ${p.portal.domain} · ${p.portal.authType === 'webhook' ? 'webhook' : 'OAuth'}</span>
          </div>
          <div class="portal-meta">
            <span>${lastPolled}</span>
            <div class="portal-actions">
              <button class="icon-btn" title="Обновить" data-act="refresh">⟳</button>
              <button class="icon-btn" title="Получение в реальном времени" data-act="inbound">🔗</button>
              <button class="icon-btn" title="Удалить" data-act="delete">🗑</button>
            </div>
          </div>
        </div>
        ${errBanner}
        <div class="entity-grid">${cells}</div>
      </div>
    `;
  }

  let currentData = null;
  let portalsList = [];

  async function loadAll() {
    try {
      const [counters, portals] = await Promise.all([
        api('/api/counters'),
        api('/api/portals'),
      ]);
      currentData = counters;
      portalsList = portals.portals;
      render();
    } catch (e) {
      toast('Ошибка загрузки: ' + e.message, 'error');
    }
  }

  function render() {
    const container = $('#portals-container');
    const empty = $('#empty-state');
    if (!currentData || !currentData.portals || currentData.portals.length === 0) {
      container.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    container.innerHTML = currentData.portals.map(renderPortal).join('');

    // Wire action buttons
    $$('.portal-card').forEach((card) => {
      const portalId = parseInt(card.dataset.portalId, 10);
      $$('.icon-btn', card).forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          handlePortalAction(portalId, btn.dataset.act, btn);
        });
      });
    });

    // Update Bitrix24 left-menu badge with grand total
    try {
      if (window.BX24 && currentData.grandTotal !== undefined) {
        BX24.placement.call('setTitle', { title: 'Уведомления' + (currentData.grandTotal ? ' (' + currentData.grandTotal + ')' : '') });
      }
    } catch (e) {}
  }

  async function handlePortalAction(portalId, action, btn) {
    if (action === 'refresh') {
      btn.innerHTML = '<span class="spinner"></span>';
      try {
        await api('/api/portals/' + portalId + '/refresh', { method: 'POST' });
        await loadAll();
        toast('Обновлено', 'success');
      } catch (e) {
        toast('Ошибка: ' + e.message, 'error');
      } finally {
        btn.innerHTML = '⟳';
      }
    } else if (action === 'delete') {
      if (!confirm('Удалить этот портал из списка?')) return;
      try {
        await api('/api/portals/' + portalId, { method: 'DELETE' });
        await loadAll();
        toast('Удалено', 'success');
      } catch (e) {
        toast('Ошибка: ' + e.message, 'error');
      }
    } else if (action === 'inbound') {
      const p = portalsList.find((x) => x.id === portalId);
      if (!p || !p.inboundWebhookUrl) return toast('URL недоступен', 'error');
      $('#inbound-url').textContent = p.inboundWebhookUrl;
      show('#modal-inbound');
    }
  }

  // Add portal flows
  $('#btn-add').addEventListener('click', () => show('#modal-add'));
  $('#empty-add').addEventListener('click', () => show('#modal-add'));

  // Pre-fill OAuth redirect URI
  $('#oauth-redirect-uri').textContent = window.location.origin + '/api/oauth/callback';

  $('#wh-submit').addEventListener('click', async () => {
    const title = $('#wh-title').value.trim();
    const webhookUrl = $('#wh-url').value.trim();
    const errEl = $('#wh-error');
    errEl.classList.add('hidden');
    const btn = $('#wh-submit');
    btn.disabled = true;
    try {
      await api('/api/portals/webhook', { method: 'POST', body: { title, webhookUrl } });
      hide('#modal-add');
      $('#wh-title').value = '';
      $('#wh-url').value = '';
      await loadAll();
      toast('Портал подключён', 'success');
    } catch (e) {
      errEl.textContent = e.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });

  $('#oauth-submit').addEventListener('click', async () => {
    const title = $('#oauth-title').value.trim();
    const domain = $('#oauth-domain').value.trim();
    const clientId = $('#oauth-client-id').value.trim();
    const clientSecret = $('#oauth-client-secret').value.trim();
    const errEl = $('#oauth-error');
    errEl.classList.add('hidden');
    if (!domain || !clientId || !clientSecret) {
      errEl.textContent = 'Заполните все поля';
      errEl.classList.remove('hidden');
      return;
    }
    try {
      const params = new URLSearchParams({ title, domain, clientId, clientSecret });
      const data = await api('/api/oauth/start?' + params.toString());
      // Open OAuth flow in new window; callback will postMessage back.
      const w = window.open(data.authUrl, 'oauth_b24', 'width=720,height=720');
      window.addEventListener('message', function onMsg(ev) {
        if (ev.data && ev.data.type === 'oauth:done') {
          window.removeEventListener('message', onMsg);
          hide('#modal-add');
          loadAll();
          toast('Портал подключён', 'success');
        }
      });
    } catch (e) {
      errEl.textContent = e.message;
      errEl.classList.remove('hidden');
    }
  });

  // Settings
  $('#btn-settings').addEventListener('click', async () => {
    try {
      const s = await api('/api/settings');
      $('#set-poll').value = s.pollIntervalSec;
      $('#set-zero').checked = !!s.showZeroCounters;
      $$('#modal-settings .check input[data-ent]').forEach((cb) => {
        cb.checked = s.enabledEntities.includes(cb.dataset.ent);
      });
      show('#modal-settings');
    } catch (e) {
      toast('Ошибка: ' + e.message, 'error');
    }
  });

  $('#set-submit').addEventListener('click', async () => {
    const enabledEntities = $$('#modal-settings .check input[data-ent]')
      .filter((cb) => cb.checked)
      .map((cb) => cb.dataset.ent);
    const body = {
      pollIntervalSec: parseInt($('#set-poll').value, 10) || 120,
      showZeroCounters: $('#set-zero').checked,
      enabledEntities,
    };
    try {
      await api('/api/settings', { method: 'POST', body });
      hide('#modal-settings');
      await loadAll();
      toast('Сохранено', 'success');
    } catch (e) {
      toast('Ошибка: ' + e.message, 'error');
    }
  });

  // Refresh all
  $('#btn-refresh').addEventListener('click', async () => {
    const btn = $('#btn-refresh');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Обновление...';
    try {
      await api('/api/counters/refresh', { method: 'POST' });
      await loadAll();
      toast('Все порталы обновлены', 'success');
    } catch (e) {
      toast('Ошибка: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span class="ico">⟳</span> Обновить';
    }
  });

  $('#inbound-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#inbound-url').textContent);
      toast('URL скопирован', 'success');
    } catch (e) {
      toast('Скопируйте вручную', 'error');
    }
  });

  // Initial load + auto-refresh every 30s (light: just re-read DB, no remote calls)
  loadAll();
  setInterval(loadAll, 30000);
})();
