// io3 Community — client
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const state = { token: null, user: null, socket: null, view: 'feed', feedFilter: '', unread: 0 };
  try { state.token = localStorage.getItem('io3_token'); } catch {}

  // ---------- Utilitaires ----------
  const el = (tag, props = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : String(c));
    return n;
  };
  const toast = (msg) => {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 2600);
  };
  const fmtDate = (s) => {
    const d = new Date(s.replace(' ', 'T') + 'Z');
    return d.toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  const formData = (form) => {
    const o = {};
    for (const [k, v] of new FormData(form)) o[k] = v;
    $$('input[type=checkbox]', form).forEach((c) => (o[c.name] = c.checked));
    return o;
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && state.token && !opts.noLogout) logout();
    if (!res.ok) throw new Error(data.error || 'Erreur réseau');
    return data;
  }

  // ---------- Auth ----------
  $$('[data-auth]').forEach((b) =>
    b.addEventListener('click', () => {
      $$('[data-auth]').forEach((x) => x.classList.toggle('active', x === b));
      $('#loginForm').hidden = b.dataset.auth !== 'login';
      $('#registerForm').hidden = b.dataset.auth !== 'register';
      $('#authError').textContent = '';
    })
  );

  async function handleAuth(e, path) {
    e.preventDefault();
    const btn = $('button[type=submit]', e.target);
    btn.disabled = true;
    $('#authError').textContent = '';
    try {
      const { token, user } = await api(path, { method: 'POST', body: formData(e.target), noLogout: true });
      state.token = token;
      try { localStorage.setItem('io3_token', token); } catch {}
      state.user = user;
      e.target.reset();
      enterApp();
    } catch (err) {
      $('#authError').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }
  $('#loginForm').addEventListener('submit', (e) => handleAuth(e, '/api/login'));
  $('#registerForm').addEventListener('submit', (e) => handleAuth(e, '/api/register'));

  function logout() {
    state.token = null;
    state.user = null;
    try { localStorage.removeItem('io3_token'); } catch {}
    if (state.socket) state.socket.disconnect();
    state.socket = null;
    $('#app').hidden = true;
    $('#auth').hidden = false;
  }
  $('#logoutBtn').addEventListener('click', logout);

  // ---------- Navigation ----------
  function show(view) {
    state.view = view;
    $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    $$('.view').forEach((v) => (v.hidden = v.id !== 'view-' + view));
    if (view === 'feed') loadTrips();
    if (view === 'stats') loadStats();
    if (view === 'add') resetTripForm();
    if (view === 'profile') fillProfile();
    if (view === 'chat') {
      state.unread = 0;
      updateBadge();
      scrollChat();
      setTimeout(() => $('#chatForm input').focus(), 50);
    }
    try { history.replaceState(null, '', '#' + view); } catch {}
  }
  $$('.nav-btn').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));

  // ---------- Trajets ----------
  const routeLabel = { ville: '🏙️ Ville', route: '🛣️ Route', autoroute: '🚀 Autoroute', mixte: '🔀 Mixte' };
  const modeLabel = { eco: 'Eco', normal: 'Normal', sport: 'Sport' };

  function tripCard(t, { actions = true } = {}) {
    const facts = [
      `📏 ${t.distance_km} km`,
      `🔋 ${t.battery_start}% → ${t.battery_end}%`,
      routeLabel[t.route_type],
      t.drive_mode && `⚙️ ${modeLabel[t.drive_mode]}`,
      t.consumption && `⚡ ${t.consumption} kWh/100`,
      t.temp_c !== null && t.temp_c !== undefined && `🌡️ ${t.temp_c}°C`,
      t.avg_speed && `⏱️ ${t.avg_speed} km/h`,
      t.climate && '❄️ Clim/chauffage',
    ].filter(Boolean);

    const mine = state.user && t.username === state.user.username;
    const card = el('article', { class: 'trip' },
      el('div', { class: 'trip-top' },
        el('span', { class: 'trip-user' }, t.username, ' ', el('span', { class: 'tag ' + (t.version === '4X4' ? 'x4' : 'x2') }, t.version)),
        el('span', { class: 'muted small-text' }, fmtDate(t.created_at))
      ),
      el('div', { class: 'range' }, t.est_range_km ?? '—', ' ', el('small', {}, 'km estimés à 100 %')),
      (() => {
        const b = el('div', { class: 'battery', title: `${t.battery_start}% → ${t.battery_end}%` });
        const i = el('i');
        i.style.left = t.battery_end + '%';
        i.style.width = t.battery_start - t.battery_end + '%';
        b.append(i);
        return b;
      })(),
      el('div', { class: 'facts' }, facts.map((f) => el('span', {}, f))),
      t.notes && el('p', { class: 'notes' }, t.notes)
    );
    if (actions) {
      const row = el('div', { class: 'trip-actions' },
        el('button', { class: 'btn sm', onclick: () => shareTrip(t.id) }, '💬 Partager au chat'),
        mine && el('button', { class: 'btn sm danger', onclick: () => deleteTrip(t.id) }, 'Supprimer')
      );
      card.append(row);
    }
    return card;
  }

  async function loadTrips() {
    const list = $('#tripList');
    const f = state.feedFilter;
    const q = f === 'mine' ? '?mine=1' : f ? '?version=' + f : '';
    try {
      const { trips } = await api('/api/trips' + q);
      list.replaceChildren(
        ...(trips.length
          ? trips.map((t) => tripCard(t))
          : [el('div', { class: 'empty' }, 'Aucun trajet pour le moment. ', el('button', { class: 'btn primary sm', onclick: () => show('add') }, 'Partage le premier !'))])
      );
    } catch (e) {
      list.replaceChildren(el('div', { class: 'empty' }, e.message));
    }
  }
  $$('#feedFilter .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      $$('#feedFilter .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
      state.feedFilter = b.dataset.f;
      loadTrips();
    })
  );

  async function shareTrip(id) {
    try {
      await api(`/api/trips/${id}/share`, { method: 'POST', body: {} });
      toast('Partagé dans le chat ✅');
    } catch (e) { toast(e.message); }
  }
  async function deleteTrip(id) {
    if (!confirm('Supprimer ce trajet ?')) return;
    try {
      await api('/api/trips/' + id, { method: 'DELETE' });
      loadTrips();
      toast('Trajet supprimé');
    } catch (e) { toast(e.message); }
  }

  // Formulaire d'ajout
  const tripForm = $('#tripForm');
  function resetTripForm() {
    $('#tripError').textContent = '';
    const v = state.user?.version || '4X2';
    const r = $(`input[name=version][value="${v}"]`, tripForm);
    if (r && !$('input[name=version]:checked', tripForm)) r.checked = true;
    updateEstimate();
  }
  function updateEstimate() {
    const d = parseFloat(tripForm.distance_km.value);
    const s = parseFloat(tripForm.battery_start.value);
    const e = parseFloat(tripForm.battery_end.value);
    const used = s - e;
    $('#estimate').textContent =
      d > 0 && used > 0
        ? `Autonomie estimée à 100 % : ${Math.round((d / used) * 100)} km  (${used}% utilisés)`
        : 'Autonomie estimée à 100 % : —';
  }
  tripForm.addEventListener('input', updateEstimate);
  tripForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', tripForm);
    btn.disabled = true;
    $('#tripError').textContent = '';
    try {
      await api('/api/trips', { method: 'POST', body: formData(tripForm) });
      const share = tripForm.share.checked;
      tripForm.reset();
      toast(share ? 'Publié et partagé dans le chat ✅' : 'Trajet publié ✅');
      show('feed');
    } catch (err) {
      $('#tripError').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- Stats ----------
  async function loadStats() {
    const box = $('#statsBox');
    try {
      const s = await api('/api/stats');
      const maxR = Math.max(1, ...['4X2', '4X4'].flatMap((v) => Object.values(s[v].by_route).filter(Boolean)));
      const card = (v) => {
        const d = s[v];
        const color = v === '4X4' ? 'var(--x4)' : 'var(--x2)';
        const val = (x, unit) => (x === null ? '—' : `${x}${unit}`);
        return el('div', { class: 'panel stat-card' },
          el('h2', {}, el('span', { class: 'tag ' + (v === '4X4' ? 'x4' : 'x2') }, v), `io3 ${v}`),
          el('div', { class: 'kpis' },
            el('div', { class: 'kpi' }, el('b', {}, val(d.avg_range_km, ' km')), el('span', {}, 'Autonomie moyenne (100 %)')),
            el('div', { class: 'kpi' }, el('b', {}, val(d.max_range_km, ' km')), el('span', {}, 'Meilleure autonomie')),
            el('div', { class: 'kpi' }, el('b', {}, val(d.avg_consumption, '')), el('span', {}, 'Conso moy. kWh/100 km')),
            el('div', { class: 'kpi' }, el('b', {}, d.trips), el('span', {}, `trajets · ${d.total_km} km`)),
            el('div', { class: 'kpi' }, el('b', {}, val(d.cold_range_km, ' km')), el('span', {}, 'Par temps froid (<10°C)')),
            el('div', { class: 'kpi' }, el('b', {}, val(d.warm_range_km, ' km')), el('span', {}, 'Par temps doux (≥10°C)'))
          ),
          el('div', { class: 'bars' },
            Object.entries(d.by_route).map(([rt, r]) => {
              const i = el('i');
              i.style.width = r ? (r / maxR) * 100 + '%' : '0';
              i.style.background = color;
              return el('div', { class: 'bar-row' }, el('span', {}, routeLabel[rt]), el('div', { class: 'bar-track' }, i), el('b', {}, r ? r + ' km' : '—'));
            })
          )
        );
      };
      box.replaceChildren(
        card('4X2'),
        card('4X4'),
        el('p', { class: 'muted small-text stats-wide' },
          `${s.members} membre(s). L'autonomie « à 100 % » est extrapolée : distance ÷ % de batterie utilisé × 100. Plus il y a de trajets partagés, plus la moyenne est fiable.`)
      );
    } catch (e) {
      box.replaceChildren(el('p', { class: 'error' }, e.message));
    }
  }

  // ---------- Profil ----------
  function fillProfile() {
    const u = state.user;
    $('#profileName').textContent = u.username;
    $('#profileMeta').textContent = `${u.email} · membre depuis ${fmtDate(u.created_at)}`;
    const f = $('#profileForm');
    $(`input[name=version][value="${u.version}"]`, f).checked = true;
    f.city.value = u.city || '';
  }
  $('#profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { user } = await api('/api/me', { method: 'PATCH', body: formData(e.target) });
      state.user = user;
      toast('Profil enregistré ✅');
    } catch (err) { toast(err.message); }
  });

  // ---------- Chat ----------
  function msgNode(m) {
    const me = state.user && m.username === state.user.username;
    return el('div', { class: 'msg' + (me ? ' me' : '') },
      el('div', { class: 'msg-head' },
        el('b', {}, m.username),
        el('span', { class: 'tag ' + (m.user_version === '4X4' ? 'x4' : 'x2') }, m.user_version),
        el('span', {}, fmtDate(m.created_at))
      ),
      m.text && el('div', { class: 'msg-text' }, m.text),
      m.trip && tripCard(m.trip, { actions: false }),
      !m.text && !m.trip && el('div', { class: 'msg-text muted' }, '(trajet supprimé)')
    );
  }
  const scrollChat = () => { const l = $('#chatList'); l.scrollTop = l.scrollHeight; };
  const updateBadge = () => {
    const b = $('#chatBadge');
    b.hidden = !state.unread;
    b.textContent = state.unread > 9 ? '9+' : state.unread;
  };

  async function loadMessages() {
    const { messages } = await api('/api/messages');
    $('#chatList').replaceChildren(...messages.map(msgNode));
    if (!messages.length) $('#chatList').append(el('p', { class: 'empty' }, 'Lance la discussion avec la communauté io3 👋'));
    scrollChat();
  }

  function connectSocket() {
    if (state.socket) state.socket.disconnect();
    const s = io({ auth: { token: state.token } });
    state.socket = s;
    s.on('message', (m) => {
      const list = $('#chatList');
      $('.empty', list)?.remove();
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
      list.append(msgNode(m));
      if (nearBottom || m.username === state.user.username) scrollChat();
      if (state.view !== 'chat' && m.username !== state.user.username) {
        state.unread++;
        updateBadge();
      }
    });
    s.on('online', (names) => {
      $('#onlineInfo').textContent = `🟢 ${names.length} en ligne : ${names.slice(0, 8).join(', ')}${names.length > 8 ? '…' : ''}`;
    });
    s.on('connect', () => loadMessages().catch(() => {}));
    s.on('connect_error', (err) => { if (err.message === 'unauthorized') logout(); });
  }
  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = e.target.text;
    const text = input.value.trim();
    if (!text || !state.socket) return;
    state.socket.emit('message', text);
    input.value = '';
  });

  // ---------- PWA ----------
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    $('#installBtn').hidden = false;
  });
  $('#installBtn').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('#installBtn').hidden = true;
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  // ---------- Démarrage ----------
  function enterApp() {
    $('#auth').hidden = true;
    $('#app').hidden = false;
    connectSocket();
    const initial = location.hash.slice(1);
    show(['feed', 'add', 'stats', 'chat', 'profile'].includes(initial) ? initial : 'feed');
  }

  (async () => {
    if (!state.token) { $('#auth').hidden = false; return; }
    try {
      const { user } = await api('/api/me', { noLogout: true });
      state.user = user;
      enterApp();
    } catch {
      logout();
    }
  })();
})();
