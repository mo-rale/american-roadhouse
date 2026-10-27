// Staff dashboard. The UI hides controls by role, but every rule is enforced
// by Row Level Security / triggers in the database, not by this file.
import {
  supabase, isConfigured, peso, esc, safeImg, toast, debounce, friendlyError, parsePrice,
  fmtDate, STATUS_LABEL, TYPE_LABEL,
} from './shop-common.js';

const $ = (id) => document.getElementById(id);
const S = { profile: null, tab: 'orders', orderFilter: 'active', fresh: new Set(), channel: null, categories: [], sections: [] };
S.rng = { orders: {}, inquiries: {}, history: {} };
const RANGE_RELOAD = { orders: () => loadOrders(), inquiries: () => loadInquiries(), history: () => loadHistory() };
const RANGE_RENDER = { orders: () => renderOrders(), inquiries: () => renderInquiries(), history: () => renderHistory() };
const ymd = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const hasRange = (key) => Boolean(S.rng[key]?.from || S.rng[key]?.to);

// Date-range filter applied in the database query, so it covers more than the latest page of rows.
function applyRange(q, key, col) {
  const r = S.rng[key] || {};
  if (r.from) q = q.gte(col, new Date(`${r.from}T00:00:00`).toISOString());
  if (r.to) q = q.lte(col, new Date(`${r.to}T23:59:59.999`).toISOString());
  return q;
}

function rangeBar(key) {
  const r = S.rng[key] || {};
  const sorts = key === 'orders'
    ? [['', 'Default order'], ['desc', 'Newest first'], ['asc', 'Oldest first']]
    : [['desc', 'Newest first'], ['asc', 'Oldest first']];
  const sel = r.sort || (key === 'orders' ? '' : 'desc');
  const preset = (id, label) => `<button type="button" class="btn-xs" data-rng-preset="${id}" data-key="${key}">${label}</button>`;
  return `<div class="range-row" role="group" aria-label="Date range and sorting">
    <label>From <input type="date" data-rng="${key}" data-f="from" value="${esc(r.from || '')}" ${r.to ? `max="${esc(r.to)}"` : ''}></label>
    <label>To <input type="date" data-rng="${key}" data-f="to" value="${esc(r.to || '')}" ${r.from ? `min="${esc(r.from)}"` : ''}></label>
    <span class="presets">${preset('today', 'Today')}${preset('7', 'Last 7 days')}${preset('30', 'Last 30 days')}
      <button type="button" class="btn-xs danger" data-rng-clear="${key}" ${hasRange(key) ? '' : 'hidden'}>Clear dates</button></span>
    <label class="sort-sel">Sort <select data-rng-sort="${key}">${sorts.map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
  </div>`;
}

function syncRange(key) {
  const r = S.rng[key] || {};
  const root = document.querySelector(`#rng-${key}`);
  if (!root) return;
  root.querySelector('[data-f="from"]').max = r.to || '';
  root.querySelector('[data-f="to"]').min = r.from || '';
  root.querySelector('[data-rng-clear]').hidden = !hasRange(key);
}

const sortRows = (rows, key, col, fallback) => {
  const dir = S.rng[key]?.sort || fallback;
  return [...rows].sort((a, b) => (dir === 'asc' ? 1 : -1) * (new Date(a[col]) - new Date(b[col])));
};
const isAdmin = () => S.profile?.role === 'admin';

const onOff = (v, a = 'Yes', b = 'No') => `<span class="badge ${v ? '' : 'bad'}">${v ? a : b}</span>`;

/* ---------- resource definitions (drive the generic CRUD tables) ---------- */
const VENUE_LABEL = { main: 'Main', roofdeck: 'Roof Deck' };
const LOW_STOCK = 5;   // "Low" badge and the low-stock filter use this
const isLowStock = (r) => r.stock != null && r.stock <= LOW_STOCK;
const stockCell = (r) => {
  if (r.stock == null) return '<span class="badge" data-stockcell>Not tracked</span>';
  const tag = r.stock === 0 ? ' <span class="badge bad">Out</span>' : r.stock <= LOW_STOCK ? ' <span class="badge bad">Low</span>' : '';
  return `<span class="num" data-stockcell>${r.stock}</span>${tag}`;
};
const slugify = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';

const RES = {
  menu: {
    label: 'Menu', noun: 'menu item', table: 'menu_items', select: '*, categories(name, venue)', admin: false,
    order: ['sort_order', 'name'],
    note: 'One menu for the whole restaurant: everything customers see on the Restaurant page and the ordering page. An item shows under Main or Roof Deck according to its section.',
    columns: [
      ['', (r) => `<img src="${esc(safeImg(r.image_url))}" alt="">`],
      ['Name', (r) => esc(r.name)],
      ['Venue', (r) => esc(VENUE_LABEL[r.categories?.venue] || '—')],
      ['Section', (r) => esc(r.categories?.name || '—')],
      ['Price', (r) => (r.price != null ? `<span class="price" data-pricecell>${peso(r.price)}</span>` : '<span class="badge">Ask for price</span>')],
      ['Stock', stockCell],
    ],
    toggles: [
      { key: 'is_visible', label: 'Visible' },
      { key: 'is_available', label: 'Available' },
    ],
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, max: 120 },
      { key: 'category_id', label: 'Section', type: 'select', required: true, options: () => S.categories.map((c) => [c.id, `${VENUE_LABEL[c.venue] || ''} · ${c.name}`]) },
      { key: 'price', label: 'Price (PHP, optional)', type: 'priceopt', hint: 'Leave empty to show "Ask for today\'s price". An item needs a price before it can be ordered online.' },
      { key: 'stock', label: 'Stock (portions)', type: 'stockopt', hint: 'Leave empty if you do not track stock. Each order subtracts from it; at 0 the item shows as sold out.' },
      { key: 'sort_order', label: 'Sort order', type: 'int', def: 0 },
      { key: 'image_url', label: 'Photo', type: 'image', span2: true },
      { key: 'description', label: 'Description', type: 'textarea', max: 500, span2: true },
      { key: 'is_visible', label: 'Visible to customers', type: 'checkbox', def: true },
      { key: 'is_available', label: 'Available to order', type: 'checkbox', def: true },
    ],
  },
  sections: {
    label: 'Menu sections', noun: 'section', table: 'categories', select: '*', admin: false, order: ['venue', 'sort_order', 'name'],
    note: 'The headings the menu is grouped under, in the order shown. Main sections appear on the Restaurant and ordering pages; Roof Deck sections appear in the Roof Deck tab. A section cannot be deleted while it has items; hide it instead.',
    columns: [['Section', (r) => esc(r.name)], ['Venue', (r) => esc(VENUE_LABEL[r.venue] || r.venue)], ['Order', (r) => String(r.sort_order)]],
    toggles: [{ key: 'is_visible', label: 'Visible' }],
    fields: [
      { key: 'name', label: 'Section name', type: 'text', required: true, max: 60 },
      { key: 'venue', label: 'Venue', type: 'select', required: true, options: () => Object.entries(VENUE_LABEL) },
      { key: 'sort_order', label: 'Sort order', type: 'int', def: 0, hint: 'Lower numbers come first within a venue.' },
      { key: 'is_visible', label: 'Visible on the pages', type: 'checkbox', def: true },
    ],
    // a new section needs a web-friendly name; an existing one keeps its slug
    beforeSave: (payload, row, rows) => {
      if (row) return;
      const base = slugify(payload.name);
      let slug = base, n = 2;
      while (rows.some((r) => r.slug === slug)) slug = `${base}-${n++}`;
      payload.slug = slug;
    },
  },
  rooms: {
    label: 'Room rates', noun: 'room rate', table: 'room_rates', select: '*', admin: true, order: ['sort_order', 'name'],
    columns: [['Room', (r) => esc(r.name)], ['Per night', (r) => `<span class="price" data-pricecell>${peso(r.price_per_night)}</span>`]],
    toggles: [{ key: 'is_active', label: 'Active' }],
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, max: 120 },
      { key: 'price_per_night', label: 'Price per night (PHP)', type: 'price', required: true },
      { key: 'image_url', label: 'Photo', type: 'image', span2: true },
      { key: 'description', label: 'Description', type: 'textarea', max: 500, span2: true },
      { key: 'sort_order', label: 'Sort order', type: 'int', def: 0 },
      { key: 'is_active', label: 'Active', type: 'checkbox', def: true },
    ],
  },
};

/* ---------- auth + routing ---------- */
async function route() {
  $('signout').hidden = true;
  $('who').textContent = '';
  $('st-loading').hidden = false;
  $('st-login').hidden = true;
  $('st-app').hidden = true;
  $('st-banner').innerHTML = '';
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session || session.user.is_anonymous) return showLogin();
    const { data: profile, error } = await supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
    if (error) throw error;
    if (!profile || !profile.is_active) {
      $('st-loading').hidden = true;
      $('st-banner').innerHTML = `<div class="banner error">This account (${esc(session.user.email)}) does not have staff access. Ask an administrator to enable it.
        <button type="button" class="btn-xs" id="na-out" style="margin-left:8px;">Sign out</button></div>`;
      $('na-out').onclick = signOut;
      return;
    }
    S.profile = profile;
    startApp();
  } catch (err) {
    $('st-loading').hidden = true;
    $('st-banner').innerHTML = `<div class="banner error">Could not load the dashboard. ${esc(friendlyError(err))}
      <button type="button" class="btn-xs" id="retry" style="margin-left:8px;">Retry</button></div>`;
    $('retry').onclick = route;
  }
}

function showLogin() {
  $('st-loading').hidden = true;
  $('st-login').hidden = false;
}

async function signOut() {
  if (S.channel) { await supabase.removeChannel(S.channel); S.channel = null; }
  if (S.poll) { clearInterval(S.poll); S.poll = null; }
  await supabase.auth.signOut();
  S.profile = null;
  route();
}

async function onLogin(e) {
  e.preventDefault();
  const err = $('login-error'), btn = $('login-btn');
  err.classList.remove('show');
  const email = $('l-email').value.trim(), password = $('l-pass').value;
  if (!email || !password) { err.textContent = 'Enter your email and password.'; err.classList.add('show'); return; }
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Signing in…';
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  btn.disabled = false; btn.textContent = 'Sign in';
  if (error) {
    err.textContent = /invalid login/i.test(error.message) ? 'Incorrect email or password.' : friendlyError(error);
    err.classList.add('show');
    return;
  }
  $('l-pass').value = '';
  route();
}

/* ---------- app shell ---------- */
function tabsForRole() {
  const t = [['orders', 'Orders'], ['inquiries', 'Inquiries'], ['menu', 'Menu'], ['sections', 'Menu sections'], ['rooms', 'Room rates'], ['history', 'Price history']];
  if (isAdmin()) t.push(['staff', 'Staff']);
  return t;
}

function startApp() {
  $('st-loading').hidden = true;
  $('st-app').hidden = false;
  $('who').innerHTML = `<span class="who-email">${esc(S.profile.email || S.profile.full_name || 'staff')} · </span><strong>${isAdmin() ? 'Administrator' : 'Employee'}</strong>`;
  $('signout').hidden = false;
  $('st-tabs').innerHTML = tabsForRole()
    .map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === S.tab}">${l}</button>`).join('');
  document.querySelector('.shop-band')?.classList.add('compact');
  subscribeOrders();
  showTab(S.tab);
  if (S.tab !== 'orders') loadOrders();
  if (S.tab !== 'inquiries') loadInquiries();
}

function showTab(tab) {
  S.tab = tab;
  S.rng = { orders: {}, inquiries: {}, history: {} };
  S.rq = ''; S.iq = ''; S.rcat = ''; S.rvenue = ''; S.rstock = ''; S.hq = ''; S.hf = 'all'; S.hlimit = 30;
  document.querySelectorAll('#st-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  const p = $('st-panel');
  p.innerHTML = '<div class="skel" style="height:140px;"></div>';
  if (tab === 'orders') return loadOrders();
  if (tab === 'inquiries') return loadInquiries();
  if (tab === 'history') return loadHistory();
  if (tab === 'staff') return loadStaff();
  return loadResource(tab);
}

const panelError = (err, retry) => {
  $('st-panel').innerHTML = `<div class="banner error">${esc(friendlyError(err))} <button type="button" class="btn-xs" id="p-retry" style="margin-left:8px;">Retry</button></div>`;
  $('p-retry').onclick = retry;
};

/* ---------- orders ---------- */
const ORDER_FILTERS = [['active', 'Active'], ['pending', 'Pending'], ['preparing', 'Preparing'], ['ready', 'Ready'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['all', 'All']];
const NEXT = { pending: ['preparing', 'Start preparing'], preparing: ['ready', 'Mark ready'], ready: ['completed', 'Complete order'] };
let allOrders = [];
S.sound = (() => { try { return localStorage.getItem('ar_sound') === '1'; } catch { return false; } })();

const minsSince = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
const ago = (iso) => {
  const m = minsSince(iso);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)} h ${m % 60} min ago`;
  return fmtDate(iso);
};

function beep() {
  try {
    const c = new (window.AudioContext || window.webkitAudioContext)();
    const o = c.createOscillator(), g = c.createGain();
    o.connect(g); g.connect(c.destination);
    o.frequency.value = 880; g.gain.value = 0.08;
    o.start(); o.stop(c.currentTime + 0.25);
  } catch { /* audio not available */ }
}

async function loadOrders() {
  try {
    const { data, error } = await applyRange(supabase.from('orders').select('*, order_items(*)'), 'orders', 'created_at')
      .order('created_at', { ascending: false }).limit(hasRange('orders') ? 500 : 150);
    if (error) throw error;
    allOrders = data;
    updateBadges();
    if (S.tab === 'orders') renderOrders();
  } catch (err) { if (S.tab === 'orders') panelError(err, loadOrders); }
}

async function updateBadges() {
  // Counted separately so the badge ignores whatever date range is being viewed.
  const { count } = await supabase.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  const n = count || 0;
  const tab = document.querySelector('#st-tabs [data-tab="orders"]');
  if (tab) tab.innerHTML = `Orders${n ? ` <span class="tab-badge" aria-label="${n} pending">${n}</span>` : ''}`;
  document.title = `${n ? `(${n}) ` : ''}Staff Dashboard | American Roadhouse`;
}

function orderCard(o) {
  const next = NEXT[o.status];
  const late = o.status === 'pending' && minsSince(o.created_at) >= 10;
  const actions = next
    ? `<button type="button" class="btn btn-primary btn-sm" data-status="${next[0]}" data-id="${esc(o.id)}">${next[1]}</button>
       <button type="button" class="btn-xs danger" data-cancel-order="${esc(o.id)}">Cancel order</button>`
    : isAdmin()
      ? `<button type="button" class="btn-xs" data-status="pending" data-id="${esc(o.id)}">Reopen order</button>`
      : '<span class="o-meta">Closed. Only an administrator can reopen it.</span>';
  return `<article class="o-card s-${esc(o.status)} ${late ? 'late' : ''} ${S.fresh.has(o.id) ? 'fresh' : ''}" data-oid="${esc(o.id)}">
    <div class="o-head"><span class="num">#${esc(o.order_number)}</span><span class="st st-${esc(o.status)}">${STATUS_LABEL[o.status]}</span></div>
    <div class="o-meta"><span class="${late ? 'late-txt' : ''}">${ago(o.created_at)}</span> · ${TYPE_LABEL[o.order_type]}${o.room_number ? ` · Room ${esc(o.room_number)}` : ''}<br>
      <strong>${esc(o.customer_name)}</strong> · <a href="tel:${esc(o.customer_phone)}">${esc(o.customer_phone)}</a></div>
    <div class="o-items">${o.order_items.map((i) => `<div><span>${i.quantity} × ${esc(i.item_name)}</span><span class="price">${peso(i.line_total)}</span></div>`).join('')}
      ${Number(o.discount_total) > 0 ? `<div><span>Discount (${esc(o.discount_code)})</span><span class="price">−${peso(o.discount_total)}</span></div>` : ''}
      <div class="o-total"><strong>Total</strong><strong class="price">${peso(o.total)}</strong></div></div>
    ${o.notes ? `<div class="o-note"><strong>Customer note:</strong> ${esc(o.notes)}</div>` : ''}
    <div class="o-actions">${actions}</div></article>`;
}

function renderOrders() {
  if (!$('o-body')) {
    $('st-panel').innerHTML = `<div id="o-stats" class="stat-row"></div>
      <div class="st-toolbar"><div class="chips" id="o-chips" role="group" aria-label="Filter orders"></div>
        <div class="tool-right">
          <input type="search" id="o-search" class="st-search" placeholder="Search # or name" aria-label="Search orders" value="${esc(S.orderSearch || '')}">
          <button type="button" class="btn-xs" id="sound-btn" data-sound="1"></button>
          <span class="live-dot" id="live"></span></div></div>
      <div id="rng-orders">${rangeBar('orders')}</div>
      <div id="o-body"></div>`;
  }
  const counts = {};
  allOrders.forEach((o) => { counts[o.status] = (counts[o.status] || 0) + 1; });
  const active = (counts.pending || 0) + (counts.preparing || 0) + (counts.ready || 0);
  const today = new Date().toDateString();
  const rangeSet = hasRange('orders');
  const sales = allOrders.filter((o) => o.status !== 'cancelled' && (rangeSet || new Date(o.created_at).toDateString() === today))
    .reduce((t, o) => t + Number(o.total), 0);

  $('o-stats').innerHTML = [
    ['Pending', counts.pending || 0, 'stat-pending'], ['Preparing', counts.preparing || 0, 'stat-preparing'],
    ['Ready', counts.ready || 0, 'stat-ready'], [rangeSet ? 'Sales in range' : "Today's sales", peso(sales), 'stat-sales'],
  ].map(([l, v, c]) => `<div class="stat ${c}"><div class="stat-n">${v}</div><div class="stat-l">${l}</div></div>`).join('');

  $('o-chips').innerHTML = ORDER_FILTERS.map(([k, l]) => {
    const n = k === 'active' ? active : k === 'all' ? allOrders.length : counts[k] || 0;
    return `<button type="button" data-ofilter="${k}" aria-pressed="${k === S.orderFilter}">${l} <span class="chip-n">${n}</span></button>`;
  }).join('');
  const sb = $('sound-btn');
  sb.textContent = S.sound ? 'Sound: on' : 'Sound: off';
  sb.setAttribute('aria-pressed', String(S.sound));
  const live = $('live');
  live.className = `live-dot ${S.live ? 'on' : ''}`;
  live.textContent = S.live ? 'Live' : 'Connecting…';

  const q = (S.orderSearch || '').toLowerCase().trim().replace(/^#/, '');
  const inFilter = (o) => S.orderFilter === 'all' || (S.orderFilter === 'active'
    ? ['pending', 'preparing', 'ready'].includes(o.status) : o.status === S.orderFilter);
  const list = sortRows(allOrders.filter((o) => inFilter(o) && (!q ||
    String(o.order_number).includes(q) || o.customer_name.toLowerCase().includes(q) || o.customer_phone.includes(q))),
  'orders', 'created_at', S.orderFilter === 'active' ? 'asc' : 'desc');

  const body = $('o-body');
  if (!list.length) {
    body.innerHTML = `<div class="empty"><strong>${q ? 'No orders match your search' : 'No orders here'}</strong>${q ? 'Try a different name or order number.' : rangeSet ? 'No orders were placed in this date range.' : 'New orders will appear automatically as customers place them.'}</div>`;
  } else if (S.orderFilter === 'active') {
    const oldestFirst = list;
    body.innerHTML = `<div class="kanban">${['pending', 'preparing', 'ready'].map((st) => {
      const col = oldestFirst.filter((o) => o.status === st);
      return `<section class="kcol" aria-label="${STATUS_LABEL[st]} orders"><h3><span class="st st-${st}">${STATUS_LABEL[st]}</span> <span class="chip-n">${col.length}</span></h3>
        ${col.length ? col.map(orderCard).join('') : '<p class="kempty">Nothing here</p>'}</section>`;
    }).join('')}</div>`;
  } else {
    body.innerHTML = `<div class="order-grid">${list.map(orderCard).join('')}</div>`;
  }
  S.fresh.clear();
}

async function setStatus(id, status) {
  document.querySelectorAll(`.o-card[data-oid="${CSS.escape(id)}"] button`).forEach((b) => (b.disabled = true));
  const { error } = await supabase.from('orders').update({ status }).eq('id', id);
  if (error) toast(friendlyError(error), 'error'); else toast(`Order marked ${STATUS_LABEL[status]}.`);
  loadOrders();
}

async function cancelOrder(id) {
  const o = allOrders.find((x) => x.id === id);
  if (!o) return;
  const ok = await confirmDialog(`Cancel order #${o.order_number}?`, `${o.customer_name} will see this order as cancelled.`, 'Cancel order');
  if (ok) setStatus(id, 'cancelled');
}

const refreshOrders = debounce(() => loadOrders(), 250);

const TAB_FOR_TABLE = {
  menu_items: 'menu', categories: 'sections', room_rates: 'rooms', price_history: 'history',
};
const isEditing = () => $('dlg').open || $('pwd')?.open || $('cfm').open || document.querySelector('.qp-form');

function refreshTab(tab = S.tab) {
  if (tab === 'orders') return loadOrders();
  if (tab === 'inquiries') return loadInquiries();
  if (tab === 'history') return loadHistory();
  if (tab === 'staff') return loadStaff();
  return loadResource(tab);
}

// A change made by anyone else (another staff member, a customer) refreshes the tab being viewed.
const liveRefresh = debounce((table) => {
  const wants = TAB_FOR_TABLE[table] === S.tab || (table === 'categories' && S.tab === 'menu');
  if (wants && !isEditing()) refreshTab();
}, 300);

async function subscribeOrders() {
  if (S.channel) return;
  // Make sure the realtime socket carries this user's login, or row security would hide the events.
  const { data: { session } } = await supabase.auth.getSession();
  if (session) supabase.realtime.setAuth(session.access_token);

  let ch = supabase.channel('staff-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (payload) => {
      if (payload.eventType === 'INSERT') {
        S.fresh.add(payload.new.id);
        toast(`New order #${payload.new.order_number} from ${payload.new.customer_name}`);
        if (S.sound) beep();
      }
      refreshOrders();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'inquiries' }, (payload) => {
      if (payload.eventType === 'INSERT') {
        S.fresh.add(payload.new.id);
        toast(`New ${KIND_LABEL[payload.new.kind].toLowerCase()} from ${payload.new.full_name}`);
        if (S.sound) beep();
      }
      refreshInquiries();
    });
  for (const table of Object.keys(TAB_FOR_TABLE)) {
    ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => liveRefresh(table));
  }
  S.channel = ch.subscribe((status) => {
    S.live = status === 'SUBSCRIBED';
    const el = $('live');
    if (el) { el.classList.toggle('on', S.live); el.textContent = S.live ? 'Live' : 'Reconnecting…'; }
    if (S.live) refreshTab();   // catch anything missed while the connection was down
  });

  // Safety net: if a live event is ever missed, the view still catches up on its own.
  if (!S.poll) {
    S.poll = setInterval(() => {
      if (document.hidden || isEditing()) return;
      if (S.tab === 'orders' || S.tab === 'inquiries' || (Date.now() - (S.lastPoll || 0)) > 55000) {
        S.lastPoll = Date.now();
        refreshTab();
      }
    }, 20000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.profile && !isEditing()) refreshTab(); });
  }
}

function confirmDialog(title, message, label = 'Confirm', danger = true) {
  return new Promise((resolve) => {
    const d = $('cfm');
    d.querySelector('h3').textContent = title;
    d.querySelector('p').textContent = message;
    const ok = d.querySelector('[data-ok]');
    ok.textContent = label;
    ok.className = `btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}`;
    const done = (v) => { d.onclose = null; if (d.open) d.close(); resolve(v); };
    ok.onclick = () => done(true);
    d.querySelector('[data-no]').onclick = () => done(false);
    d.onclose = () => resolve(false);
    d.showModal();
    d.querySelector('[data-no]').focus();
  });
}

/* ---------- inquiries (room bookings, table reservations, messages) ---------- */
const KIND_LABEL = { booking: 'Room booking', table: 'Table reservation', message: 'Message' };
const INQ_STATUS = { new: 'New', contacted: 'Contacted', closed: 'Closed' };
const DETAIL_LABEL = {
  check_in: 'Check-in', check_out: 'Check-out', guests: 'Guests', room_preference: 'Room',
  date: 'Date', time: 'Time', party_size: 'Party size', special_request: 'Special request', notes: 'Message', message: 'Message',
};
let inquiries = [];
S.ifilter = 'new';

async function loadInquiries() {
  try {
    const { data, error } = await applyRange(supabase.from('inquiries').select('*'), 'inquiries', 'created_at').order('created_at', { ascending: false }).limit(hasRange('inquiries') ? 500 : 200);
    if (error) throw error;
    inquiries = data;
    updateInquiryBadge();
    if (S.tab === 'inquiries') renderInquiries();
  } catch (err) { if (S.tab === 'inquiries') panelError(err, loadInquiries); }
}

async function updateInquiryBadge() {
  const { count } = await supabase.from('inquiries').select('id', { count: 'exact', head: true }).eq('status', 'new');
  const n = count || 0;
  const tab = document.querySelector('#st-tabs [data-tab="inquiries"]');
  if (tab) tab.innerHTML = `Inquiries${n ? ` <span class="tab-badge" aria-label="${n} new">${n}</span>` : ''}`;
}

function inquiryCard(i) {
  const details = Object.entries(i.details || {})
    .map(([k, v]) => `<div><span>${esc(DETAIL_LABEL[k] || k)}</span><strong>${esc(v)}</strong></div>`).join('');
  return `<article class="o-card i-${esc(i.status)} ${S.fresh.has(i.id) ? 'fresh' : ''}">
    <div class="o-head"><span class="badge">${esc(KIND_LABEL[i.kind])}</span><span class="st st-${i.status === 'new' ? 'pending' : i.status === 'contacted' ? 'preparing' : 'completed'}">${INQ_STATUS[i.status]}</span></div>
    <div class="o-meta">${ago(i.created_at)}<br><strong>${esc(i.full_name)}</strong> · <a href="tel:${esc(i.phone.replace(/\s/g, ''))}">${esc(i.phone)}</a>
      ${i.email ? `<br><a href="mailto:${esc(i.email)}">${esc(i.email)}</a>` : ''}</div>
    ${details ? `<div class="o-items kv">${details}</div>` : ''}
    <div class="o-actions">
      ${Object.keys(INQ_STATUS).map((s) => `<button type="button" class="btn-xs" data-istatus="${s}" data-id="${esc(i.id)}" ${s === i.status ? 'aria-current="true" disabled' : ''}>${INQ_STATUS[s]}</button>`).join('')}
      ${isAdmin() ? `<button type="button" class="btn-xs danger" data-idelete="${esc(i.id)}">Delete</button>` : ''}
    </div></article>`;
}

function renderInquiries() {
  if (!$('i-body')) {
    $('st-panel').innerHTML = `<div class="st-toolbar"><div class="chips" id="i-chips" role="group" aria-label="Filter inquiries"></div>
      <div class="tool-right"><input type="search" id="i-search" class="st-search" placeholder="Search name or phone" aria-label="Search inquiries" value="${esc(S.iq || '')}"></div></div>
      <div id="rng-inquiries">${rangeBar('inquiries')}</div>
      <div id="i-body"></div>`;
  }
  const counts = {};
  inquiries.forEach((i) => { counts[i.status] = (counts[i.status] || 0) + 1; });
  $('i-chips').innerHTML = [...Object.entries(INQ_STATUS), ['all', 'All']].map(([k, l]) =>
    `<button type="button" data-ifilter="${k}" aria-pressed="${k === S.ifilter}">${l} <span class="chip-n">${k === 'all' ? inquiries.length : counts[k] || 0}</span></button>`).join('');
  const q = (S.iq || '').toLowerCase().trim();
  const list = sortRows(inquiries.filter((i) => (S.ifilter === 'all' || i.status === S.ifilter) &&
    (!q || i.full_name.toLowerCase().includes(q) || i.phone.includes(q) || (i.email || '').toLowerCase().includes(q))),
  'inquiries', 'created_at', 'desc');
  $('i-body').innerHTML = list.length
    ? `<div class="order-grid">${list.map(inquiryCard).join('')}</div>`
    : `<div class="empty"><strong>${q ? 'No inquiries match your search' : 'No inquiries here'}</strong>${q ? 'Try a different name or phone number.' : hasRange('inquiries') ? 'No inquiries were received in this date range.' : 'Room bookings, table reservations and messages from the website will appear here automatically.'}</div>`;
  S.fresh.clear();
}

async function setInquiryStatus(id, status) {
  const { error } = await supabase.from('inquiries').update({ status }).eq('id', id);
  if (error) toast(friendlyError(error), 'error'); else toast(`Marked ${INQ_STATUS[status].toLowerCase()}.`);
  loadInquiries();
}

async function deleteInquiry(id) {
  const i = inquiries.find((x) => x.id === id);
  if (!i) return;
  const ok = await confirmDialog(`Delete inquiry from ${i.full_name}?`, 'This cannot be undone.', 'Delete');
  if (!ok) return;
  const { error } = await supabase.from('inquiries').delete().eq('id', id);
  if (error) toast(friendlyError(error), 'error'); else toast('Deleted.');
  loadInquiries();
}

const refreshInquiries = debounce(() => loadInquiries(), 250);

/* ---------- photo upload (Supabase Storage) ---------- */
const BUCKET = 'menu-images';
const BUCKET_MARK = `/storage/v1/object/public/${BUCKET}/`;

// Shrinks to max 1200px and re-encodes as JPEG so uploads stay light and consistent.
async function prepareImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Please choose a JPG, PNG or WebP image.');
  if (file.size > 15 * 1024 * 1024) throw new Error('That photo is larger than 15 MB. Please choose a smaller one.');
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.86));
  if (!blob) throw new Error('Could not process that photo. Try a different one.');
  if (blob.size > 3 * 1024 * 1024) throw new Error('That photo is still too large after resizing. Try a simpler image.');
  return blob;
}

async function uploadImage(blob, folder) {
  const path = `${folder}/${crypto.randomUUID()}.jpg`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: false });
  if (error) throw error;
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

function removeImage(url) {
  const i = url ? url.indexOf(BUCKET_MARK) : -1;
  if (i < 0) return;   // only files in our bucket (not the site's own assets/ photos)
  supabase.storage.from(BUCKET).remove([decodeURIComponent(url.slice(i + BUCKET_MARK.length))]).catch(() => {});
}

async function onImagePick(input) {
  const wrap = input.closest('.img-field');
  const key = wrap.dataset.imgfield;
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  const errEl = wrap.parentElement.querySelector('.err');
  wrap.parentElement.classList.remove('invalid');
  try {
    const blob = await prepareImage(file);
    S.pendingImg[key] = blob;
    const prev = wrap.querySelector('.img-prev');
    prev.src = URL.createObjectURL(blob); prev.hidden = false;
    wrap.querySelector('[data-img-clear]').hidden = false;
    wrap.querySelector('[data-img-pick]').textContent = 'Replace photo';
  } catch (err) {
    errEl.textContent = friendlyError(err);
    wrap.parentElement.classList.add('invalid');
  }
}

function onImageClear(btn) {
  const wrap = btn.closest('.img-field');
  const key = wrap.dataset.imgfield;
  delete S.pendingImg[key];
  wrap.querySelector('input[type=hidden]').value = '';
  const prev = wrap.querySelector('.img-prev');
  prev.hidden = true; prev.removeAttribute('src');
  btn.hidden = true;
  wrap.querySelector('[data-img-pick]').textContent = 'Choose photo';
}

/* ---------- generic CRUD tables ---------- */
let currentRows = [];

async function loadResource(key) {
  const cfg = RES[key];
  try {
    if (key === 'menu') await ensureCategories();
    let q = supabase.from(cfg.table).select(cfg.select);
    cfg.order.forEach((c) => (q = q.order(c)));
    const { data, error } = await q;
    if (error) throw error;
    if (S.tab !== key) return;
    currentRows = data;
    renderResource(key);
  } catch (err) { panelError(err, () => loadResource(key)); }
}

async function ensureCategories() {
  const { data, error } = await supabase.from('categories').select('id, name, venue').order('venue').order('sort_order').order('name');
  if (error) throw error;
  S.categories = data;
}

const rowText = (r) => [r.name, r.code, r.slug, r.description, r.categories?.name].filter(Boolean).join(' ').toLowerCase();

function renderResource(key) {
  const cfg = RES[key];
  const canWrite = !cfg.admin || isAdmin();
  if (!$('r-body')) {
    $('st-panel').innerHTML = `<div class="st-toolbar"><h2 style="font-size:22px;">${esc(cfg.label)}</h2>
      <div class="tool-right">
        <input type="search" id="r-search" class="st-search" placeholder="Search ${esc(cfg.label.toLowerCase())}" aria-label="Search ${esc(cfg.label)}" value="${esc(S.rq || '')}">
        ${key === 'menu' ? `<select id="r-venue" class="st-select" aria-label="Filter by venue"><option value="">All venues</option><option value="main">Main</option><option value="roofdeck">Roof Deck</option></select>
          <select id="r-cat" class="st-select" aria-label="Filter by section"><option value="">All sections</option>${S.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (${esc(VENUE_LABEL[c.venue] || '')})</option>`).join('')}</select>
          <select id="r-stock" class="st-select" aria-label="Filter by stock"><option value="">Any stock</option><option value="low">Low or out</option><option value="untracked">Not tracked</option></select>` : ''}
        ${canWrite ? `<button type="button" class="btn btn-primary btn-sm" data-new="1">Add ${esc(cfg.noun)}</button>`
          : '<span class="badge">View only. Administrators manage this.</span>'}</div></div>
      ${cfg.note ? `<p class="count-line" style="text-transform:none;letter-spacing:0;margin-bottom:14px;">${esc(cfg.note)}</p>` : ''}
      <div id="r-body"></div>`;
  }
  const q = (S.rq || '').toLowerCase().trim();
  const rows = currentRows.filter((r) => (!q || rowText(r).includes(q)) && (!S.rcat || r.category_id === S.rcat)
    && (!S.rvenue || r.categories?.venue === S.rvenue)
    && (S.rstock !== 'low' || isLowStock(r)) && (S.rstock !== 'untracked' || r.stock == null));
  const body = $('r-body');
  if (!currentRows.length) {
    body.innerHTML = `<div class="empty"><strong>No ${esc(cfg.noun)}s yet</strong>${canWrite ? `Use “Add ${esc(cfg.noun)}” to create the first one.` : ''}</div>`;
    return;
  }
  if (!rows.length) {
    body.innerHTML = '<div class="empty"><strong>No matches</strong>Try a different search or category.</div>';
    return;
  }
  const heads = [...cfg.columns.map((c) => c[0]), ...cfg.toggles.map((t) => t.label)];
  const td = (h, html, cls = '') => `<td data-label="${esc(h)}" class="${cls}">${html}</td>`;
  const lowN = key === 'menu' ? currentRows.filter(isLowStock).length : 0;
  body.innerHTML = `<p class="count-line">Showing ${rows.length} of ${currentRows.length}${lowN ? ` · ${lowN} low or out of stock` : ''}</p>
    <div class="tbl-wrap"><table class="tbl resp"><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join('')}${canWrite ? '<th></th>' : ''}</tr></thead><tbody>
    ${rows.map((r) => `<tr>${cfg.columns.map(([h, f]) => {
      let html = f(r);
      if (canWrite && html.includes('data-pricecell')) {
        html = `<button type="button" class="qprice" data-quickprice="${esc(r.id)}" aria-label="Edit price of ${esc(r.name)}">${html}</button>`;
      }
      if (canWrite && html.includes('data-stockcell')) {
        html = `<button type="button" class="qprice" data-quickstock="${esc(r.id)}" aria-label="Edit stock of ${esc(r.name)}">${html}</button>`;
      }
      return td(h, html, h === '' ? 'img-cell' : '');
    }).join('')}${cfg.toggles.map((t) => td(t.label, `<label class="switch"><input type="checkbox" data-toggle="${t.key}" data-id="${esc(r.id)}" ${r[t.key] ? 'checked' : ''} ${canWrite ? '' : 'disabled'} aria-label="${esc(t.label)}: ${esc(r.name || r.code)}"><span></span></label>`)).join('')}
    ${canWrite ? `<td class="actions-cell"><div class="row-actions"><button type="button" class="btn-xs" data-edit="${esc(r.id)}">Edit</button><button type="button" class="btn-xs danger" data-delete="${esc(r.id)}">Delete</button></div></td>` : ''}</tr>`).join('')}
    </tbody></table></div>`;
}

const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

function fieldHtml(f, row) {
  const v = row ? row[f.key] : f.def;
  const id = `fld-${f.key}`;
  const cls = `field ${f.span2 ? 'span2' : ''}`;
  const err = `<div class="err"></div>`;
  const hint = f.hint ? `<div style="font-size:12px;color:#8a8378;margin-top:4px;">${esc(f.hint)}</div>` : '';
  if (f.type === 'image') {
    return `<div class="${cls}"><label for="${id}">${esc(f.label.toUpperCase())}</label>
      <div class="img-field" data-imgfield="${f.key}">
        <img class="img-prev" src="${esc(v ? safeImg(v) : '')}" alt="Photo preview" ${v ? '' : 'hidden'}>
        <div class="img-ctl">
          <button type="button" class="btn btn-outline btn-sm" data-img-pick="${f.key}">${v ? 'Replace photo' : 'Choose photo'}</button>
          <button type="button" class="btn-xs danger" data-img-clear="${f.key}" ${v ? '' : 'hidden'}>Remove photo</button>
          <span class="img-note">JPG, PNG or WebP. It is resized automatically.</span>
        </div>
        <input type="file" id="${id}" accept="image/jpeg,image/png,image/webp" hidden>
        <input type="hidden" name="${f.key}" value="${esc(v || '')}">
      </div><div class="err"></div></div>`;
  }
  if (f.type === 'checkbox') return `<div class="${cls} check-field"><input type="checkbox" id="${id}" name="${f.key}" ${v ? 'checked' : ''}><label for="${id}" style="margin:0;">${esc(f.label)}</label></div>`;
  let input;
  if (f.type === 'textarea') input = `<textarea id="${id}" name="${f.key}" rows="3" maxlength="${f.max || 500}">${esc(v ?? '')}</textarea>`;
  else if (f.type === 'select') input = `<select id="${id}" name="${f.key}"><option value="">Select…</option>${f.options().map(([val, lab]) => `<option value="${esc(val)}" ${val === v ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>`;
  else if (f.type === 'datetime') input = `<input type="datetime-local" id="${id}" name="${f.key}" value="${esc(toLocalInput(v))}">`;
  else if (f.type === 'stockopt') input = `<input type="text" inputmode="numeric" id="${id}" name="${f.key}" value="${esc(v ?? '')}" placeholder="Not tracked" autocomplete="off">`;
  else if (f.type === 'price' || f.type === 'priceopt' || f.type === 'money0') input = `<input type="text" inputmode="decimal" id="${id}" name="${f.key}" value="${esc(v ?? '')}" autocomplete="off">`;
  else if (f.type === 'int') input = `<input type="number" step="1" id="${id}" name="${f.key}" value="${esc(v ?? 0)}">`;
  else input = `<input type="text" id="${id}" name="${f.key}" value="${esc(v ?? '')}" maxlength="${f.max || 200}" autocomplete="off">`;
  return `<div class="${cls}"><label for="${id}">${esc(f.label.toUpperCase())}</label>${input}${hint}${err}</div>`;
}

let editing = null; // { key, row|null }

function openDialog(key, row) {
  const cfg = RES[key];
  editing = { key, row };
  S.pendingImg = {};
  $('dlg-form').innerHTML = `<h3>${row ? 'Edit' : 'Add'} ${esc(cfg.noun)}</h3>
    <div class="grid-fields">${cfg.fields.map((f) => fieldHtml(f, row)).join('')}</div>
    <div class="form-error" id="dlg-error" role="alert" style="margin-top:14px;"></div>
    <div class="dialog-actions"><button type="button" class="btn btn-outline btn-sm" id="dlg-cancel">Cancel</button>
      <button type="submit" class="btn btn-primary btn-sm" id="dlg-save">Save</button></div>`;
  $('dlg').showModal();
  $('dlg-cancel').onclick = () => $('dlg').close();
  $('dlg-form').querySelector('input:not([type=checkbox]), select, textarea')?.focus();
}

function collect(cfg, form) {
  const payload = {}, errors = {};
  for (const f of cfg.fields) {
    const el = form.elements[f.key];
    let v = f.type === 'checkbox' ? el.checked : el.value.trim();
    let bad = null;
    if (f.type === 'checkbox') { /* ok */ }
    else if (f.type === 'stockopt') {
      if (v === '') v = null;
      else if (!/^\d{1,6}$/.test(v)) bad = 'Enter a whole number (0 or more), or leave empty.';
      else v = Number(v);
    }
    else if (f.type === 'priceopt') {
      if (v === '') v = null;
      else { const r = parsePrice(v); if (r.ok) v = r.value; else bad = r.message; }
    }
    else if (f.type === 'price') {
      const r = parsePrice(v);
      if (r.ok) v = r.value; else bad = r.message;
    } else if (f.type === 'money0') {
      if (!/^\d+(\.\d{1,2})?$/.test(v.replace(/,/g, '') || '0')) bad = 'Use a number of 0 or more with at most 2 decimals.';
      else v = Number(v.replace(/,/g, '') || 0);
    } else if (f.type === 'int') {
      if (!/^-?\d+$/.test(v)) bad = 'Enter a whole number.'; else v = Number(v);
    } else if (f.type === 'datetime') {
      v = v ? new Date(v).toISOString() : null;
    } else if (f.type === 'image') {
      v = v || null;
    } else {
      if (f.required && !v) bad = `${f.label} is required.`;
      else if (f.max && v.length > f.max) bad = `Maximum ${f.max} characters.`;
      else if (f.type === 'slug' && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(v)) bad = 'Use lowercase letters, numbers and single dashes.';
      else if (f.pattern && !f.pattern.test(v)) bad = f.patternMsg || 'Invalid value.';
      if (v === '' && !f.required) v = f.key === 'description' ? '' : null;
    }
    if (bad) errors[f.key] = bad;
    payload[f.key] = v;
  }
  if (!Object.keys(errors).length && cfg.validate) Object.assign(errors, cfg.validate(payload) || {});
  return { payload, errors };
}

async function onSave(e) {
  e.preventDefault();
  const cfg = RES[editing.key];
  const form = e.currentTarget;
  const { payload, errors } = collect(cfg, form);
  if (!Object.keys(errors).length && cfg.beforeSave) cfg.beforeSave(payload, editing.row, currentRows);
  form.querySelectorAll('.field').forEach((f) => { f.classList.remove('invalid'); });
  const keys = Object.keys(errors);
  keys.forEach((k) => {
    const f = form.elements[k].closest('.field');
    f.classList.add('invalid');
    f.querySelector('.err').textContent = errors[k];
  });
  if (keys.length) { form.elements[keys[0]].focus(); return; }

  const btn = $('dlg-save');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving…';
  const uploaded = [];
  try {
    for (const f of cfg.fields) {
      if (f.type === 'image' && S.pendingImg[f.key]) {
        payload[f.key] = await uploadImage(S.pendingImg[f.key], cfg.table);
        uploaded.push(payload[f.key]);
      }
    }
  } catch (err) {
    btn.disabled = false; btn.textContent = 'Save';
    const eb = $('dlg-error'); eb.textContent = friendlyError(err); eb.classList.add('show');
    return;
  }
  const q = editing.row
    ? supabase.from(cfg.table).update(payload).eq('id', editing.row.id)
    : supabase.from(cfg.table).insert(payload);
  const { error } = await q;
  btn.disabled = false; btn.textContent = 'Save';
  if (error) {
    uploaded.forEach(removeImage);   // don't leave orphaned files behind
    const eb = $('dlg-error'); eb.textContent = friendlyError(error); eb.classList.add('show');
    return;
  }
  if (editing.row) {
    for (const f of cfg.fields) {
      if (f.type === 'image' && editing.row[f.key] && editing.row[f.key] !== payload[f.key]) removeImage(editing.row[f.key]);
    }
  }
  $('dlg').close();
  toast(`${cfg.noun[0].toUpperCase()}${cfg.noun.slice(1)} saved. Customers see changes right away.`);
  loadResource(editing.key);
}

async function toggleField(key, id, field) {
  const row = currentRows.find((r) => r.id === id);
  if (!row) return;
  const { error } = await supabase.from(RES[key].table).update({ [field]: !row[field] }).eq('id', id);
  if (error) toast(friendlyError(error), 'error'); else toast('Saved. Customers see this right away.');
  loadResource(key);
}

async function deleteRow(key, id) {
  const row = currentRows.find((r) => r.id === id);
  if (!row) return;
  const ok = await confirmDialog(`Delete “${row.name || row.code}”?`, 'This cannot be undone. To keep it but stop showing it, switch it off instead.', 'Delete');
  if (!ok) return;
  const { error } = await supabase.from(RES[key].table).delete().eq('id', id);
  if (error) toast(friendlyError(error), 'error'); else toast('Deleted.');
  loadResource(key);
}

const PRICE_FIELD = { menu_items: 'price', room_rates: 'price_per_night' };

function quickPrice(id, cell) {
  const row = currentRows.find((r) => r.id === id);
  const field = PRICE_FIELD[RES[S.tab].table];
  if (!row || !field) return;
  cell.innerHTML = `<form class="qp-form" data-qp="${esc(id)}" novalidate>
    <input type="text" inputmode="decimal" value="${esc(row[field])}" aria-label="New price for ${esc(row.name)}" autocomplete="off">
    <button type="submit" class="btn-xs">Save</button><button type="button" class="btn-xs" data-qp-cancel="1">Cancel</button>
    <div class="qp-err" role="alert"></div></form>`;
  const inp = cell.querySelector('input');
  inp.focus(); inp.select();
}

async function saveQuickPrice(form) {
  const id = form.dataset.qp;
  const field = PRICE_FIELD[RES[S.tab].table];
  const r = parsePrice(form.querySelector('input').value);
  if (!r.ok) { form.querySelector('.qp-err').textContent = r.message; form.querySelector('input').focus(); return; }
  const row = currentRows.find((x) => x.id === id);
  if (row && Number(row[field]) === r.value) { renderResource(S.tab); return; }
  form.querySelectorAll('button, input').forEach((e) => (e.disabled = true));
  const { error } = await supabase.from(RES[S.tab].table).update({ [field]: r.value }).eq('id', id);
  if (error) { toast(friendlyError(error), 'error'); renderResource(S.tab); return; }
  toast(`Price updated to ${peso(r.value)}. Customers see it right away.`);
  loadResource(S.tab);
}

function quickStock(id, cell) {
  const row = currentRows.find((r) => r.id === id);
  if (!row) return;
  cell.innerHTML = `<form class="qp-form" data-qs="${esc(id)}" novalidate>
    <input type="text" inputmode="numeric" value="${esc(row.stock ?? '')}" placeholder="Not tracked" aria-label="Stock of ${esc(row.name)}" autocomplete="off">
    <button type="submit" class="btn-xs">Save</button><button type="button" class="btn-xs" data-qp-cancel="1">Cancel</button>
    <div class="qp-err" role="alert"></div></form>`;
  const inp = cell.querySelector('input');
  inp.focus(); inp.select();
}

async function saveQuickStock(form) {
  const id = form.dataset.qs;
  const raw = form.querySelector('input').value.trim();
  let value = null;
  if (raw !== '') {
    if (!/^\d{1,6}$/.test(raw)) { form.querySelector('.qp-err').textContent = 'Enter a whole number (0 or more), or leave empty to stop tracking.'; form.querySelector('input').focus(); return; }
    value = Number(raw);
  }
  form.querySelectorAll('button, input').forEach((e) => (e.disabled = true));
  const { error } = await supabase.from('menu_items').update({ stock: value }).eq('id', id);
  if (error) { toast(friendlyError(error), 'error'); renderResource(S.tab); return; }
  toast(value == null ? 'Stock tracking turned off for this item.' : `Stock set to ${value}.`);
  loadResource(S.tab);
}

/* ---------- price history ---------- */
const TABLE_LABEL = { menu_items: 'Menu item', room_rates: 'Room rate' };
let histRows = [];

async function loadHistory() {
  try {
    const { data, error } = await applyRange(supabase.from('price_history').select('*'), 'history', 'changed_at').order('changed_at', { ascending: false }).limit(hasRange('history') ? 1000 : 300);
    if (error) throw error;
    histRows = data.map((h) => (h.table_name === 'restaurant_dishes' ? { ...h, table_name: 'menu_items' } : h));   // dishes were merged into the menu
    if (S.tab === 'history') renderHistory();
  } catch (err) { panelError(err, loadHistory); }
}

const dayLabel = (iso) => {
  const d = new Date(iso), t = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  const y = new Date(t); y.setDate(t.getDate() - 1);
  if (same(d, t)) return 'Today';
  if (same(d, y)) return 'Yesterday';
  return d.toLocaleDateString('en-PH', { dateStyle: 'medium' });
};
const timeLabel = (iso) => new Date(iso).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });

function renderHistory() {
  if (!$('h-body')) {
    $('st-panel').innerHTML = `<div class="st-toolbar"><div class="chips" id="h-chips" role="group" aria-label="Filter by type"></div>
      <div class="tool-right"><input type="search" id="h-search" class="st-search" placeholder="Search item or person" aria-label="Search price history" value="${esc(S.hq || '')}"></div></div>
      <div id="rng-history">${rangeBar('history')}</div>
      <div id="h-body"></div>`;
  }
  $('h-chips').innerHTML = [['all', 'All'], ...Object.entries(TABLE_LABEL)]
    .map(([k, l]) => `<button type="button" data-hfilter="${k}" aria-pressed="${k === S.hf}">${l}</button>`).join('');
  const q = (S.hq || '').toLowerCase().trim();
  const rows = sortRows(histRows.filter((h) => (S.hf === 'all' || h.table_name === S.hf) &&
    (!q || `${h.record_name} ${h.changed_by_email}`.toLowerCase().includes(q))), 'history', 'changed_at', 'desc');
  const body = $('h-body');
  if (!histRows.length) { body.innerHTML = hasRange('history') ? '<div class="empty"><strong>No price changes in this date range</strong>Try a wider range.</div>' : '<div class="empty"><strong>No price changes yet</strong>Every price edit will be listed here with who made it and when.</div>'; return; }
  if (!rows.length) { body.innerHTML = '<div class="empty"><strong>No matches</strong>Try a different filter or search.</div>'; return; }

  const shown = rows.slice(0, S.hlimit || 30);
  let html = '', lastDay = '', open = false;
  for (const h of shown) {
    const day = dayLabel(h.changed_at);
    if (day !== lastDay) {
      if (open) html += '</ul>';
      html += `<h3 class="hday">${esc(day)}</h3><ul class="hlist">`;
      lastDay = day; open = true;
    }
    const up = h.old_price != null && Number(h.new_price) > Number(h.old_price);
    const down = h.old_price != null && Number(h.new_price) < Number(h.old_price);
    const who = h.changed_by_email || (h.old_price == null ? 'Initial setup' : 'System');
    html += `<li class="h-row">
      <span class="h-name">${esc(h.record_name || '')}</span>
      <span class="h-change">${h.old_price == null ? '<span class="badge">New</span> '
        : `<span class="old price">${peso(h.old_price)}</span>`}<span class="price">${peso(h.new_price)}</span>${up ? ' <span class="delta up" title="Increase">↑</span>' : down ? ' <span class="delta down" title="Decrease">↓</span>' : ''}</span>
      <span class="h-sub">${esc(TABLE_LABEL[h.table_name] || h.table_name)} · ${esc(who)} · ${timeLabel(h.changed_at)}</span></li>`;
  }
  if (open) html += '</ul>';
  const more = rows.length - shown.length;
  body.innerHTML = `<p class="count-line">Showing ${shown.length} of ${rows.length} changes</p>${html}
    ${more > 0 ? `<div style="text-align:center;margin-top:16px;"><button type="button" class="btn btn-outline btn-sm" data-hmore="1">Show ${Math.min(30, more)} more</button></div>` : ''}`;
}

/* ---------- staff management (admin) ---------- */
const PW_RULE = 'At least 10 characters, with letters and numbers.';

function pwProblem(pw, email = '') {
  if (pw.length < 10 || pw.length > 72 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return PW_RULE;
  if (pw.toLowerCase() === email.toLowerCase()) return 'The password cannot be the same as the email.';
  return '';
}

function genPassword() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const pick = (set, n) => Array.from(crypto.getRandomValues(new Uint32Array(n)), (x) => set[x % set.length]).join('');
  return pick(letters, 12) + pick('23456789', 2);
}

// Calls the server-side function that holds the privileged key (never the browser).
async function callAdminStaff(body) {
  const { data, error } = await supabase.functions.invoke('admin-staff', { body });
  if (error) {
    let msg = 'Could not reach the server. Please try again.';
    try { const j = await error.context.json(); if (j?.error) msg = j.error; } catch { /* keep default */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

const pwField = (id, label) => `<div class="field"><label for="${id}">${label}</label>
  <div class="pw-row"><input type="password" id="${id}" autocomplete="new-password" spellcheck="false">
    <button type="button" class="btn-xs" data-pw-gen="${id}">Generate</button>
    <button type="button" class="btn-xs" data-pw-show="${id}">Show</button></div>
  <div class="err"></div></div>`;

async function loadStaff() {
  try {
    const { data, error } = await supabase.from('profiles').select('*').order('created_at');
    if (error) throw error;
    $('st-panel').innerHTML = `
      <div class="st-toolbar"><h2 style="font-size:22px;">Staff</h2></div>
      <form id="staff-form" class="add-staff" novalidate>
        <h3>Add a staff member</h3>
        <div class="add-staff-grid">
          <div class="field"><label for="s-email">EMAIL</label><input type="email" id="s-email" autocomplete="off" placeholder="name@example.com"><div class="err"></div></div>
          ${pwField('s-pass', 'TEMPORARY PASSWORD')}
          <div class="field"><label for="s-role">ROLE</label><select id="s-role"><option value="employee">Employee</option><option value="admin">Administrator</option></select></div>
        </div>
        <p class="hint">${PW_RULE} Give them the email and password privately; they can sign in right away. Use “Generate” for a strong one.</p>
        <div class="form-error" id="staff-error" role="alert"></div>
        <button type="submit" class="btn btn-primary btn-sm" id="staff-save">Create account</button>
      </form>
      <div class="tbl-wrap"><table class="tbl resp"><thead><tr><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
        ${data.map((p) => `<tr><td data-label="Email">${esc(p.email || p.id)}</td><td data-label="Role">${p.role === 'admin' ? 'Administrator' : 'Employee'}</td><td data-label="Status">${onOff(p.is_active, 'Active', 'Disabled')}</td>
          <td class="actions-cell"><div class="row-actions">
            <button type="button" class="btn-xs" data-reset-pw="${esc(p.email || '')}">Reset password</button>
            ${p.id === S.profile.id ? '<span class="badge">You</span>'
              : `<button type="button" class="btn-xs" data-staff-toggle="${esc(p.email)}" data-role="${p.role}" data-active="${p.is_active}">${p.is_active ? 'Disable' : 'Enable'}</button>`}</div></td></tr>`).join('')}
      </tbody></table></div>`;
  } catch (err) { panelError(err, loadStaff); }
}

async function onCreateStaff(form) {
  const email = $('s-email').value.trim().toLowerCase();
  const pw = $('s-pass').value;
  const errBox = $('staff-error');
  errBox.classList.remove('show');
  form.querySelectorAll('.field').forEach((f) => f.classList.remove('invalid'));
  const bad = (id, msg) => { const f = $(id).closest('.field'); f.classList.add('invalid'); f.querySelector('.err').textContent = msg; $(id).focus(); };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad('s-email', 'Enter a valid email address.');
  const problem = pwProblem(pw, email);
  if (problem) return bad('s-pass', problem);

  const btn = $('staff-save');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Creating…';
  try {
    const res = await callAdminStaff({ action: 'create', email, password: pw, role: $('s-role').value });
    toast(res.existed ? 'That login already existed. Staff access was granted; its password is unchanged.' : 'Account created. They can sign in now.');
    loadStaff();
  } catch (err) {
    errBox.textContent = friendlyError(err); errBox.classList.add('show');
    btn.disabled = false; btn.textContent = 'Create account';
  }
}

function openResetPassword(email) {
  S.resetEmail = email;
  $('pwd-who').textContent = email;
  $('pwd-new').value = ''; $('pwd-new').type = 'password';
  $('pwd-error').classList.remove('show');
  $('pwd-new').closest('.field').classList.remove('invalid');
  $('pwd').showModal();
  $('pwd-new').focus();
}

async function onResetPassword(e) {
  e.preventDefault();
  const pw = $('pwd-new').value;
  const field = $('pwd-new').closest('.field');
  const problem = pwProblem(pw, S.resetEmail);
  field.classList.toggle('invalid', Boolean(problem));
  field.querySelector('.err').textContent = problem;
  if (problem) { $('pwd-new').focus(); return; }
  const btn = $('pwd-save'), eb = $('pwd-error');
  eb.classList.remove('show');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving…';
  try {
    await callAdminStaff({ action: 'reset_password', email: S.resetEmail, password: pw });
    $('pwd').close();
    $('pwd-new').value = '';
    toast(`Password updated for ${S.resetEmail}. Share it with them privately.`);
  } catch (err) {
    eb.textContent = friendlyError(err); eb.classList.add('show');
  } finally {
    btn.disabled = false; btn.textContent = 'Set password';
  }
}

async function setStaff(email, role, active) {
  const { error } = await supabase.rpc('admin_set_staff_role', { p_email: email, p_role: role, p_active: active });
  if (error) { toast(friendlyError(error), 'error'); return false; }
  toast('Staff access updated.');
  loadStaff();
  return true;
}

/* ---------- init ---------- */
function init() {
  if (!isConfigured) {
    $('st-loading').hidden = true;
    $('st-banner').innerHTML = '<div class="banner info">Supabase is not configured. Create <code>.env</code> and run <code>node scripts/build-env.mjs</code> (see docs/SUPABASE_SETUP.md).</div>';
    return;
  }
  $('login-form').addEventListener('submit', onLogin);
  $('signout').addEventListener('click', signOut);
  $('dlg-form').addEventListener('submit', onSave);
  $('dlg-form').addEventListener('change', (e) => { if (e.target.type === 'file') onImagePick(e.target); });
  $('dlg-form').addEventListener('click', (e) => {
    const pick = e.target.closest('[data-img-pick]');
    if (pick) pick.closest('.img-field').querySelector('input[type=file]').click();
    const clear = e.target.closest('[data-img-clear]');
    if (clear) onImageClear(clear);
  });

  $('st-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });
  $('st-panel').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.rngPreset) {
      const key = t.dataset.key, today = new Date(), p = t.dataset.rngPreset;
      const from = new Date(today); from.setDate(today.getDate() - (p === 'today' ? 0 : Number(p) - 1));
      S.rng[key].from = ymd(from); S.rng[key].to = ymd(today);
      document.querySelector(`#rng-${key} [data-f="from"]`).value = S.rng[key].from;
      document.querySelector(`#rng-${key} [data-f="to"]`).value = S.rng[key].to;
      syncRange(key); RANGE_RELOAD[key]();
    }
    else if (t.dataset.rngClear) {
      const key = t.dataset.rngClear;
      S.rng[key].from = ''; S.rng[key].to = '';
      document.querySelectorAll(`#rng-${key} input[type=date]`).forEach((i) => { i.value = ''; });
      syncRange(key); RANGE_RELOAD[key]();
    }
    else if (t.dataset.ofilter) { S.orderFilter = t.dataset.ofilter; renderOrders(); }
    else if (t.dataset.ifilter) { S.ifilter = t.dataset.ifilter; renderInquiries(); }
    else if (t.dataset.istatus) setInquiryStatus(t.dataset.id, t.dataset.istatus);
    else if (t.dataset.idelete) deleteInquiry(t.dataset.idelete);
    else if (t.dataset.hfilter) { S.hf = t.dataset.hfilter; S.hlimit = 30; renderHistory(); }
    else if (t.dataset.hmore) { S.hlimit += 30; renderHistory(); }
    else if (t.dataset.status) setStatus(t.dataset.id, t.dataset.status);
    else if (t.dataset.cancelOrder) cancelOrder(t.dataset.cancelOrder);
    else if (t.dataset.sound) {
      S.sound = !S.sound;
      try { localStorage.setItem('ar_sound', S.sound ? '1' : '0'); } catch { /* ignore */ }
      if (S.sound) beep();
      renderOrders();
    }
    else if (t.dataset.new) openDialog(S.tab, null);
    else if (t.dataset.edit) openDialog(S.tab, currentRows.find((r) => r.id === t.dataset.edit));
    else if (t.dataset.delete) deleteRow(S.tab, t.dataset.delete);
    else if (t.dataset.quickprice) quickPrice(t.dataset.quickprice, t.closest('td'));
    else if (t.dataset.quickstock) quickStock(t.dataset.quickstock, t.closest('td'));
    else if (t.dataset.qpCancel) renderResource(S.tab);
    else if (t.dataset.staffToggle) setStaff(t.dataset.staffToggle, t.dataset.role, t.dataset.active !== 'true');
  });
  $('st-panel').addEventListener('change', (e) => {
    if (e.target.dataset.rng) {
      const key = e.target.dataset.rng, f = e.target.dataset.f, r = S.rng[key];
      r[f] = e.target.value;
      if (r.from && r.to && r.from > r.to) {   // keep the range valid if a date was typed by hand
        r[f === 'from' ? 'to' : 'from'] = e.target.value;
        document.querySelector(`#rng-${key} [data-f="${f === 'from' ? 'to' : 'from'}"]`).value = e.target.value;
      }
      syncRange(key); RANGE_RELOAD[key]();
      return;
    }
    if (e.target.dataset.rngSort !== undefined) {
      const key = e.target.dataset.rngSort;
      S.rng[key].sort = e.target.value;
      RANGE_RENDER[key]();
      return;
    }
    if (e.target.dataset.toggle) toggleField(S.tab, e.target.dataset.id, e.target.dataset.toggle);
    if (e.target.id === 'r-cat') { S.rcat = e.target.value; renderResource(S.tab); }
    if (e.target.id === 'r-venue') { S.rvenue = e.target.value; renderResource(S.tab); }
    if (e.target.id === 'r-stock') { S.rstock = e.target.value; renderResource(S.tab); }
  });
  $('st-panel').addEventListener('input', (e) => {
    if (e.target.id === 'o-search') { S.orderSearch = e.target.value; renderOrders(); }
    if (e.target.id === 'r-search') { S.rq = e.target.value; renderResource(S.tab); }
    if (e.target.id === 'i-search') { S.iq = e.target.value; renderInquiries(); }
    if (e.target.id === 'h-search') { S.hq = e.target.value; S.hlimit = 30; renderHistory(); }
  });
  $('st-panel').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.closest('.qp-form')) renderResource(S.tab);
  });
  $('st-panel').addEventListener('submit', async (e) => {
    if (e.target.dataset.qp) { e.preventDefault(); saveQuickPrice(e.target); return; }
    if (e.target.dataset.qs) { e.preventDefault(); saveQuickStock(e.target); return; }
    if (e.target.id !== 'staff-form') return;
    e.preventDefault();
    await onCreateStaff(e.target);
  });

  document.addEventListener('click', (e) => {
    const gen = e.target.closest('[data-pw-gen]');
    if (gen) {
      const input = $(gen.dataset.pwGen);
      input.value = genPassword(); input.type = 'text';
      input.closest('.field').classList.remove('invalid');
      const show = input.closest('.field').querySelector('[data-pw-show]');
      if (show) show.textContent = 'Hide';
    }
    const show = e.target.closest('[data-pw-show]');
    if (show) {
      const input = $(show.dataset.pwShow);
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      show.textContent = reveal ? 'Hide' : 'Show';
    }
    const reset = e.target.closest('[data-reset-pw]');
    if (reset) openResetPassword(reset.dataset.resetPw);
  });
  $('pwd-form').addEventListener('submit', onResetPassword);
  $('pwd-cancel').addEventListener('click', () => $('pwd').close());

  supabase.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') route(); });
  route();
}

init();
