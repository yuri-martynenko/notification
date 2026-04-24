'use strict';

(function () {
  function getToken() {
    const url = new URL(window.location.href);
    const t = url.searchParams.get('token');
    if (t) {
      try { sessionStorage.setItem('app_token', t); } catch {}
      return t;
    }
    try { return sessionStorage.getItem('app_token'); } catch { return null; }
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

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  function toast(msg, type) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast ' + (type ? 'toast-' + type : '');
    setTimeout(() => t.classList.add('hidden'), 3000);
  }

  function show(id) { $(id).classList.remove('hidden'); }
  function hide(id) { $(id).classList.add('hidden'); }

  // ============ STATE ============
  let isAdmin = false;
  let currentCounters = null;
  let currentPortals = [];
  let currentView = 'counters';

  const ENTITY_META = {
    im: { icon: '💬', name: 'Чаты' },
    notify: { icon: '🔔', name: 'Уведомления' },
    tasks: { icon: '✅', name: 'Задачи' },
    crm: { icon: '👥', name: 'CRM' },
    livefeed: { icon: '📰', name: 'Лента' },
  };

  // ============ NAV ============
  function switchView(view) {
    currentView = view;
    $$('.nav-tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== 'view-' + view));
    const addBtn = $('#btn-add');
    if (addBtn) addBtn.style.display = (view === 'portals' && isAdmin) ? '' : 'none';
    if (view === 'counters') loadCounters();
    if (view === 'portals') loadPortals();
    if (view === 'mappings') loadMappings();
  }

  $$('.nav-tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

  // ============ MODALS ============
  $$('.modal').forEach((m) => m.addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-close')) m.classList.add('hidden');
  }));
  $$('#modal-add .tab').forEach((tab) => tab.addEventListener('click', () => {
    $$('#modal-add .tab').forEach((t) => t.classList.toggle('active', t === tab));
    $$('#modal-add .tab-content').forEach((c) => c.classList.toggle('hidden', c.id !== 'tab-' + tab.dataset.tab));
  }));

  // ============ COUNTERS VIEW ============
  function fmtDate(s) {
    if (!s) return '';
    const d = new Date(typeof s === 'number' ? s * 1000 : s);
    if (isNaN(d)) return s;
    const diff = Date.now() - d.getTime();
    if (diff < 60000) return 'только что';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' мин назад';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' ч назад';
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
  }
  function escape(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }

  function renderCounterItem(item) {
    const title = item.title || item.text || ('#' + item.id);
    const sub = item.date || item.lastMessageAt;
    return `<a class="item" href="${escape(item.link)}" target="_blank" rel="noopener" title="${escape(title)}">${escape(title)}${sub ? ' <small>· ' + escape(fmtDate(sub)) + '</small>' : ''}</a>`;
  }

  function renderCountersPortal(p) {
    const counters = p.counters || {};
    const mapInfo = p.mapping ? `<span class="mapping-info">вы как ${escape(p.mapping.remoteUserName || '#' + p.mapping.remoteUserId)}</span>` : '';
    const err = p.lastError && p.lastError.length
      ? `<div class="error-banner">⚠ Ошибки обновления: ${p.lastError.map(e => escape(e.entity || '') + ' — ' + escape(e.message || '')).join('; ')}</div>`
      : '';
    const cells = Object.keys(ENTITY_META).map((ent) => {
      const c = counters[ent];
      if (!c) return '';
      const items = (c.items || []).slice(0, 5);
      return `
        <div class="entity-cell">
          <div class="entity-cell-head">
            <span><span class="entity-icon">${ENTITY_META[ent].icon}</span><span class="entity-name">${ENTITY_META[ent].name}</span></span>
            <span class="badge ${c.total > 0 ? '' : 'badge-muted'}">${c.total}</span>
          </div>
          <div class="entity-items">
            ${items.length ? items.map(renderCounterItem).join('') : '<span class="entity-empty">Нет новых</span>'}
          </div>
        </div>`;
    }).join('');
    const lastPolled = p.lastPolledAt ? 'обновлено ' + fmtDate(p.lastPolledAt) : 'ещё не обновлялось';
    return `
      <div class="portal-card">
        <div class="portal-header">
          <div class="portal-title">
            <a href="https://${escape(p.portal.domain)}" target="_blank" rel="noopener">${escape(p.portal.title)}</a>
            ${p.total > 0 ? `<span class="badge-grand">${p.total}</span>` : ''}
            <span class="portal-domain">· ${escape(p.portal.domain)} ${mapInfo}</span>
          </div>
          <div class="portal-meta">
            <span>${escape(lastPolled)}</span>
            <button class="icon-btn" title="Обновить" data-portal="${p.portal.id}" data-act="refresh-one">⟳</button>
          </div>
        </div>
        ${err}
        <div class="entity-grid">${cells || '<div class="entity-empty" style="padding:20px;text-align:center;">Нет настроенных счётчиков</div>'}</div>
      </div>`;
  }

  async function loadCounters() {
    try {
      const data = await api('/api/counters');
      currentCounters = data;
      isAdmin = !!data.isAdmin;
      updateRoleUI();

      const container = $('#counters-container');
      const empty = $('#empty-counters');
      if (!data.portals.length) {
        container.innerHTML = '';
        empty.classList.remove('hidden');
        if (isAdmin) {
          $('#empty-title').textContent = 'Нет подключённых порталов';
          $('#empty-hint').textContent = 'Перейдите на вкладку «Порталы» и подключите первый внешний Битрикс24.';
        } else {
          $('#empty-title').textContent = 'Для вас не настроены счётчики';
          $('#empty-hint').textContent = 'Обратитесь к администратору — он должен подключить внешние порталы и связать ваш аккаунт.';
        }
        return;
      }
      empty.classList.add('hidden');
      container.innerHTML = data.portals.map(renderCountersPortal).join('');
      $$('[data-act="refresh-one"]', container).forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.innerHTML = '<span class="spinner"></span>';
          try {
            await api('/api/portals/' + btn.dataset.portal + '/refresh', { method: 'POST' });
            await loadCounters();
            toast('Обновлено', 'success');
          } catch (e) {
            toast('Ошибка: ' + e.message, 'error');
          } finally {
            btn.innerHTML = '⟳';
          }
        });
      });
      try {
        if (window.BX24 && data.grandTotal !== undefined) {
          BX24.placement.call('setTitle', { title: 'Уведомления' + (data.grandTotal ? ' (' + data.grandTotal + ')' : '') });
        }
      } catch {}
    } catch (e) {
      toast('Ошибка загрузки: ' + e.message, 'error');
    }
  }

  // ============ PORTALS VIEW (admin) ============
  async function loadPortals() {
    try {
      const data = await api('/api/portals');
      isAdmin = !!data.isAdmin;
      updateRoleUI();
      currentPortals = data.portals;

      const container = $('#portals-container');
      const empty = $('#empty-portals');
      if (!data.portals.length) {
        container.innerHTML = '';
        empty.classList.remove('hidden');
        return;
      }
      empty.classList.add('hidden');
      container.innerHTML = data.portals.map(renderAdminPortal).join('');

      $$('[data-act]', container).forEach((btn) => btn.addEventListener('click', onPortalAction));
    } catch (e) {
      toast('Ошибка: ' + e.message, 'error');
    }
  }

  function renderAdminPortal(p) {
    const lastPolled = p.lastPolledAt ? fmtDate(p.lastPolledAt) : 'ещё не опрашивался';
    return `
      <div class="portal-card admin" data-portal="${p.id}">
        <div class="portal-header">
          <div class="portal-title">
            <a href="https://${escape(p.domain)}" target="_blank" rel="noopener">${escape(p.title)}</a>
            <span class="portal-domain">· ${escape(p.domain)} · ${p.authType}</span>
          </div>
          <div class="portal-meta">
            <span>${escape(lastPolled)}</span>
            <button class="icon-btn" title="Обновить" data-portal="${p.id}" data-act="refresh">⟳</button>
            <button class="icon-btn" title="Webhook URL" data-portal="${p.id}" data-act="inbound">🔗</button>
            <button class="icon-btn" title="Удалить" data-portal="${p.id}" data-act="delete">🗑</button>
          </div>
        </div>
        ${p.lastError ? `<div class="error-banner">⚠ ${escape(JSON.stringify(p.lastError))}</div>` : ''}
        <div class="portal-body">
          <button class="btn btn-ghost" data-portal="${p.id}" data-act="view-mappings">👥 Пользователи (связи)</button>
        </div>
      </div>`;
  }

  async function onPortalAction(e) {
    const btn = e.currentTarget;
    const id = btn.dataset.portal;
    const act = btn.dataset.act;
    if (act === 'refresh') {
      btn.innerHTML = '<span class="spinner"></span>';
      try { await api('/api/portals/' + id + '/refresh', { method: 'POST' }); toast('Обновлено', 'success'); }
      catch (err) { toast('Ошибка: ' + err.message, 'error'); }
      finally { btn.innerHTML = '⟳'; loadPortals(); }
    } else if (act === 'delete') {
      if (!confirm('Удалить портал и все связанные данные?')) return;
      try { await api('/api/portals/' + id, { method: 'DELETE' }); toast('Удалено', 'success'); loadPortals(); }
      catch (err) { toast('Ошибка: ' + err.message, 'error'); }
    } else if (act === 'inbound') {
      const p = currentPortals.find((x) => x.id == id);
      if (!p || !p.inboundWebhookUrl) return toast('URL недоступен', 'error');
      $('#inbound-url').textContent = p.inboundWebhookUrl;
      show('#modal-inbound');
    } else if (act === 'view-mappings') {
      switchView('mappings');
      setTimeout(() => {
        const el = document.querySelector(`[data-mappings-portal="${id}"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 200);
    }
  }

  // ============ MAPPINGS VIEW (admin) ============
  async function loadMappings() {
    try {
      if (!currentPortals.length) {
        const pd = await api('/api/portals');
        currentPortals = pd.portals;
      }
      const container = $('#mappings-container');
      if (!currentPortals.length) {
        container.innerHTML = '<div class="empty"><div class="empty-icon">🔗</div><h2>Сначала подключите портал</h2></div>';
        return;
      }
      const sections = [];
      for (const p of currentPortals) {
        const { mappings } = await api(`/api/portals/${p.id}/mappings`);
        sections.push(renderMappingsSection(p, mappings));
      }
      container.innerHTML = sections.join('');
      $$('[data-act="add-mapping"]', container).forEach((b) => b.addEventListener('click', () => openMappingModal(b.dataset.portal)));
      $$('[data-act="del-mapping"]', container).forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Удалить связь?')) return;
        try { await api(`/api/portals/${b.dataset.portal}/mappings/${b.dataset.user}`, { method: 'DELETE' }); loadMappings(); toast('Удалено', 'success'); }
        catch (e) { toast('Ошибка: ' + e.message, 'error'); }
      }));
    } catch (e) {
      toast('Ошибка: ' + e.message, 'error');
    }
  }

  function renderMappingsSection(portal, mappings) {
    const rows = mappings.map((m) => `
      <tr>
        <td>${escape(m.host_raw_user_id)}</td>
        <td>${escape(m.remote_user_id)}</td>
        <td>${escape(m.remote_user_name || '—')}</td>
        <td>${escape(m.remote_user_email || '—')}</td>
        <td>${m.verified ? '✓' : '—'}</td>
        <td><button class="icon-btn" data-act="del-mapping" data-portal="${portal.id}" data-user="${m.host_user_id}">🗑</button></td>
      </tr>`).join('');
    return `
      <div class="mappings-section" data-mappings-portal="${portal.id}">
        <div class="mappings-head">
          <h3>${escape(portal.title)} <span class="portal-domain">· ${escape(portal.domain)}</span></h3>
          <button class="btn btn-primary" data-act="add-mapping" data-portal="${portal.id}">+ Добавить связь</button>
        </div>
        ${mappings.length ? `
          <table class="mappings-table">
            <thead><tr><th>USER_ID сотрудника (iumiti)</th><th>USER_ID на внешнем портале</th><th>Имя</th><th>Email</th><th>Подтв.</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        ` : '<p class="hint">Пока нет связей. Сотрудники не увидят счётчики с этого портала, пока вы не свяжете их с пользователями на внешнем портале.</p>'}
      </div>`;
  }

  function openMappingModal(portalId) {
    const portal = currentPortals.find((p) => p.id == portalId);
    $('#mapping-title').textContent = 'Добавить связь — ' + portal.title;
    $('#mapping-portal-domain').textContent = portal.domain;
    $('#mapping-host-portal-name').textContent = 'iumiti.bitrix24.ru';
    $('#mapping-host-user').value = '';
    $('#mapping-remote-user').value = '';
    $('#mapping-email').value = '';
    $('#mapping-autofind-result').textContent = '';
    $('#mapping-error').classList.add('hidden');
    $('#mapping-submit').dataset.portal = portalId;
    show('#modal-mapping');
  }

  $('#mapping-autofind').addEventListener('click', async () => {
    const email = $('#mapping-email').value.trim();
    const portalId = $('#mapping-submit').dataset.portal;
    if (!email) return;
    $('#mapping-autofind-result').textContent = 'Ищу...';
    try {
      const { user } = await api(`/api/portals/${portalId}/find-user`, { method: 'POST', body: { email } });
      if (!user) {
        $('#mapping-autofind-result').textContent = '❌ Пользователь не найден на внешнем портале';
        return;
      }
      $('#mapping-remote-user').value = user.id;
      $('#mapping-autofind-result').textContent = `✓ Найден: ${user.name} (id=${user.id})`;
    } catch (e) {
      $('#mapping-autofind-result').textContent = '❌ ' + e.message;
    }
  });

  $('#mapping-submit').addEventListener('click', async () => {
    const portalId = $('#mapping-submit').dataset.portal;
    const hostUserRaw = $('#mapping-host-user').value.trim();
    const remoteUserId = $('#mapping-remote-user').value.trim();
    const email = $('#mapping-email').value.trim();
    if (!hostUserRaw || !remoteUserId) {
      $('#mapping-error').textContent = 'Заполните оба ID';
      $('#mapping-error').classList.remove('hidden');
      return;
    }
    // We need the host_user DB id. For simplicity: host_user record is created lazily
    // when the user first opens the app; admin enters the raw USER_ID (from iumiti portal)
    // and we resolve it via a helper endpoint. If not yet created — prompt user to open
    // the app first. MVP shortcut: create it if missing via /api/host-users.
    try {
      const resolve = await api('/api/host-users/ensure', {
        method: 'POST',
        body: { hostUserId: hostUserRaw },
      });
      await api(`/api/portals/${portalId}/mappings`, {
        method: 'POST',
        body: {
          hostUserDbId: resolve.id,
          remoteUserId,
          remoteUserEmail: email || undefined,
        },
      });
      hide('#modal-mapping');
      loadMappings();
      toast('Связь добавлена', 'success');
    } catch (e) {
      $('#mapping-error').textContent = e.message;
      $('#mapping-error').classList.remove('hidden');
    }
  });

  // ============ ADD PORTAL ============
  $('#btn-add').addEventListener('click', () => show('#modal-add'));
  if ($('#empty-add')) $('#empty-add').addEventListener('click', () => show('#modal-add'));
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
      $('#wh-title').value = ''; $('#wh-url').value = '';
      loadPortals();
      loadCounters();
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
      window.open(data.authUrl, 'oauth_b24', 'width=720,height=720');
      window.addEventListener('message', function onMsg(ev) {
        if (ev.data && ev.data.type === 'oauth:done') {
          window.removeEventListener('message', onMsg);
          hide('#modal-add');
          loadPortals(); loadCounters();
          toast('Портал подключён', 'success');
        }
      });
    } catch (e) {
      errEl.textContent = e.message;
      errEl.classList.remove('hidden');
    }
  });

  // ============ SETTINGS ============
  $('#btn-settings').addEventListener('click', async () => {
    try {
      const s = await api('/api/settings');
      $('#set-poll').value = s.pollIntervalSec;
      $$('#modal-settings .check input[data-ent]').forEach((cb) => cb.checked = s.enabledEntities.includes(cb.dataset.ent));
      show('#modal-settings');
    } catch (e) { toast('Ошибка: ' + e.message, 'error'); }
  });
  $('#set-submit').addEventListener('click', async () => {
    const enabledEntities = $$('#modal-settings .check input[data-ent]').filter((cb) => cb.checked).map((cb) => cb.dataset.ent);
    try {
      await api('/api/settings', { method: 'POST', body: {
        pollIntervalSec: parseInt($('#set-poll').value, 10) || 120,
        enabledEntities,
      }});
      hide('#modal-settings');
      if (currentView === 'counters') loadCounters();
      toast('Сохранено', 'success');
    } catch (e) { toast('Ошибка: ' + e.message, 'error'); }
  });

  // ============ REFRESH ALL ============
  $('#btn-refresh').addEventListener('click', async () => {
    const b = $('#btn-refresh');
    b.disabled = true; b.innerHTML = '<span class="spinner"></span>';
    try { await api('/api/counters/refresh', { method: 'POST' }); loadCounters(); toast('Обновлено', 'success'); }
    catch (e) { toast('Ошибка: ' + e.message, 'error'); }
    finally { b.disabled = false; b.innerHTML = '⟳'; }
  });

  $('#inbound-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#inbound-url').textContent); toast('URL скопирован', 'success'); }
    catch { toast('Скопируйте вручную', 'error'); }
  });

  // ============ ROLE UI ============
  function updateRoleUI() {
    const badge = $('#role-badge');
    if (isAdmin) {
      badge.textContent = 'Администратор';
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
    $$('.admin-only').forEach((el) => el.classList.toggle('hidden', !isAdmin));
    $('#tabs-nav').classList.toggle('hidden', !isAdmin);
  }

  // ============ BOOTSTRAP ============
  loadCounters();
  setInterval(() => { if (currentView === 'counters') loadCounters(); }, 30000);
})();
