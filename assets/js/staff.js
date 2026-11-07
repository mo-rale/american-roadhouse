// Staff dashboard. The UI hides controls by role, but every rule is enforced
// by Row Level Security / triggers in the database, not by this file.
import {
  supabase, isConfigured, peso, esc, safeImg, toast, debounce, friendlyError, parsePrice,
  fmtDate, STATUS_LABEL, TYPE_LABEL,
} from './shop-common.js';

const $ = (id) => document.getElementById(id);
const S = { profile: null, tab: 'orders', orderFilter: 'active', fresh: new Set(), channel: null, categories: [], sections: [], menuItems: [] };
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
  const sorts = [['desc', 'Newest first'], ['asc', 'Oldest first']];
  const sel = r.sort || 'desc';
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
const PAGE_LABEL = { rooms: 'Rooms', restaurant: 'Restaurant', services: 'Services', gallery: 'Gallery', contact: 'About & Contact', booking: 'Booking' };
const VENUE_LABEL = { main: 'Main', roofdeck: 'Roof Deck' };
// menu sections grouped by venue, so the picker is short headings with their sections under them
const sectionGroups = () => Object.keys(VENUE_LABEL).map((v) => [VENUE_LABEL[v] + ' menu', S.categories.filter((c) => c.venue === v).map((c) => [c.id, c.name])]).filter(([, items]) => items.length);
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
      { key: 'category_id', label: 'Section', type: 'select', required: true, groups: () => sectionGroups() },
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
  extras: {
    label: 'Extras', noun: 'extra', table: 'menu_extras', select: '*, categories(name, venue)', admin: false, order: ['sort_order', 'name'],
    note: 'Add-ons available for every dish in a selected menu section. Customers see these when adding a dish from that section.',
    columns: [
      ['Extra', (r) => esc(r.name)],
      ['Section', (r) => esc(r.categories ? `${VENUE_LABEL[r.categories.venue] || ''} · ${r.categories.name}` : '—')],
      ['Price', (r) => `<span class="price">+${peso(r.price)}</span>`],
    ],
    toggles: [{ key: 'is_active', label: 'Available' }],
    fields: [
      { key: 'category_id', label: 'Section', type: 'select', required: true, groups: () => sectionGroups(), hint: 'This extra is offered for every dish in this section.' },
      { key: 'name', label: 'Extra (what customers see)', type: 'text', required: true, max: 80 },
      { key: 'price', label: 'Extra price (PHP)', type: 'money0', hint: 'Added to the dish price for each portion. Use 0 for a free option.' },
      { key: 'sort_order', label: 'Sort order', type: 'int', def: 0, hint: 'Lower numbers come first.' },
      { key: 'is_active', label: 'Available to customers', type: 'checkbox', def: true },
    ],
  },
  options: {
    label: 'Sizes & flavors', noun: 'option', table: 'menu_options', select: '*, menu_items(name, category_id, categories(name, venue))', admin: false, order: ['option_type', 'sort_order', 'name'],
    note: 'Choices a customer picks for one dish, such as a size or a flavor. Each one shows the full price the customer pays for that choice.',
    columns: [
      ['Dish', (r) => esc(r.menu_items?.name || '—')],
      ['Type', (r) => esc(r.option_type === 'size' ? 'Size' : 'Flavor')],
      ['Option', (r) => esc(r.name)],
      ['Price', (r) => optionPrice(r)],
    ],
    toggles: [{ key: 'is_active', label: 'Available' }],
    fields: [
      { key: 'menu_item_id', label: 'Dish', type: 'select', required: true, groups: () => dishGroups(), hint: 'Dishes are grouped by menu section. This choice is offered only for the dish you pick.' },
      { key: 'option_type', label: 'Type', type: 'select', required: true, options: () => [['size', 'Size'], ['flavor', 'Flavor']] },
      { key: 'name', label: 'Name customers see', type: 'text', required: true, max: 80, hint: 'For example: Large, or IPA (Red).' },
      { key: 'price', label: 'Full price for this choice (PHP)', type: 'money0', hint: 'The customer pays this price instead of the dish price. For a flavor that costs the same as the dish, enter 0.' },
      { key: 'sort_order', label: 'Order in the list', type: 'int', def: 0, hint: 'Lower numbers come first.' },
      { key: 'is_active', label: 'Available to customers', type: 'checkbox', def: true },
    ],
  },
  gallery: {
    label: 'Gallery', noun: 'photo', table: 'gallery_photos', select: '*', admin: false, order: ['sort_order', 'created_at'],
    note: 'The photos on the website Gallery page, in this order. Grab the ⠿ handle and drag a photo up or down to change its place. New photos go to the end.',
    columns: [
      ['', (r) => `<img src="${esc(safeImg(r.image_url))}" alt="">`],
      ['Caption', (r) => esc(r.caption || '—')],
      ['Category', (r) => esc({ rooms: 'Rooms', hotel: 'Hotel', restaurant: 'Restaurant', food: 'Food' }[r.category] || r.category)],
    ],
    toggles: [{ key: 'is_visible', label: 'Shown' }],
    sortable: true,
    fields: [
      { key: 'image_url', label: 'Photo', type: 'image', span2: true },
      { key: 'caption', label: 'Caption', type: 'text', required: true, max: 140, span2: true, hint: 'A short description of the photo. It is also read aloud to blind visitors and helps Google understand the photo.' },
      { key: 'category', label: 'Category', type: 'select', required: true, options: () => [['rooms', 'Rooms'], ['hotel', 'Hotel'], ['restaurant', 'Restaurant'], ['food', 'Food']], hint: 'Which filter button on the Gallery page shows this photo.' },
      { key: 'is_visible', label: 'Show on the website', type: 'checkbox', def: true },
    ],
    validate: (p) => (p.image_url ? {} : { image_url: 'Please choose a photo.' }),
    beforeSave: (payload, row, rows) => { if (!row && !payload.sort_order) payload.sort_order = Math.max(0, ...rows.map((r) => Number(r.sort_order) || 0)) + 10; },
  },
  highlights: {
    label: 'Highlights', noun: 'highlight', table: 'home_highlights', select: '*, menu_items(name, price, image_url)', admin: false, order: ['sort_order', 'created_at'],
    note: 'The “Menu Highlights” cards on the home page (up to 4), in this order. Each card is a dish from the menu: its name, photo and price are taken from the menu. Grab the ⠿ handle and drag a card to change its place.',
    columns: [
      ['', (r) => `<img src="${esc(safeImg(r.menu_items?.image_url || r.image_url))}" alt="">`],
      ['Dish', (r) => esc(r.menu_items?.name || r.title || '—')],
      ['Shows', (r) => (r.menu_items ? `<span class="price">${peso(r.menu_items.price)}</span>` : esc(r.subtitle || '—'))],
    ],
    toggles: [{ key: 'is_visible', label: 'Shown' }],
    sortable: true, max: 4,
    fields: [
      { key: 'menu_item_id', label: 'Dish from the menu', type: 'select', groups: () => dishGroups(), span2: true, hint: 'The card shows this dish’s name, photo and price from the menu. Change them in Menu and the home page follows.' },
      { key: 'is_visible', label: 'Show on the home page', type: 'checkbox', def: true },
    ],
    validate: (p) => (!p.menu_item_id && !(editing.row && !editing.row.menu_item_id) ? { menu_item_id: 'Choose a dish from the menu.' } : {}),
    beforeSave: (payload, row, rows) => { if (!row) payload.sort_order = Math.max(0, ...rows.map((r) => Number(r.sort_order) || 0)) + 10; },
  },
  slideshow: {
    label: 'Slideshow', noun: 'photo', table: 'page_slides', select: '*', admin: false, order: ['page', 'sort_order', 'created_at'],
    note: 'The photos that slide across the top of a page. Pick the page for each photo; a page with no photos keeps its normal header picture. Grab the ⠿ handle and drag a photo to change its place. With 2 or more photos it plays by itself.',
    columns: [
      ['', (r) => `<img src="${esc(safeImg(r.image_url))}" alt="">`],
      ['Page', (r) => esc(PAGE_LABEL[r.page] || r.page)],
      ['Description', (r) => esc(r.caption || '—')],
    ],
    toggles: [{ key: 'is_visible', label: 'Shown' }],
    sortable: true,
    fields: [
      { key: 'page', label: 'Page', type: 'select', required: true, options: () => Object.entries(PAGE_LABEL), get def() { return S.rpage || ''; }, hint: 'Which page this photo slides on.' },
      { key: 'image_url', label: 'Photo', type: 'image', span2: true, hint: 'A wide, landscape photo works best.' },
      { key: 'caption', label: 'Description', type: 'text', required: true, max: 140, span2: true, hint: 'A short description of the photo, read aloud to blind visitors and used by Google.' },
      { key: 'is_visible', label: 'Show on the website', type: 'checkbox', def: true },
    ],
    validate: (p) => (p.image_url ? {} : { image_url: 'Please choose a photo.' }),
    beforeSave: (payload, row, rows) => { if (!row) payload.sort_order = Math.max(0, ...rows.map((r) => Number(r.sort_order) || 0)) + 10; },
  },
  massage: {
    label: 'Massage', noun: 'massage', table: 'massage_services', select: '*', admin: true, order: ['sort_order', 'name'],
    note: 'The massage types and prices customers see when they click Massage on the Services page. Hide a type to remove it from the page without deleting it.',
    columns: [
      ['Massage', (r) => esc(r.name)],
      ['Duration', (r) => esc(r.duration_minutes ? `${r.duration_minutes} min` : r.duration_label || '—')],
      ['Price', (r) => (r.price != null ? `<span class="price" data-pricecell>${peso(r.price)}</span> <span class="muted">${esc(r.price_unit || '')}</span>` : '<span class="badge">Ask for price</span>')],
    ],
    toggles: [{ key: 'is_active', label: 'Shown' }],
    fields: [
      { key: 'name', label: 'Type of massage', type: 'text', required: true, max: 120 },
      { key: 'price', label: 'Price (PHP, optional)', type: 'priceopt', hint: 'Leave empty to show "Ask for price".' },
      { key: 'price_unit', label: 'Price unit (optional)', type: 'text', max: 40, hint: 'Shown under the price, for example "per 30 minutes".' },
      { key: 'duration_minutes', label: 'Duration (minutes, optional)', type: 'stockopt', hint: 'A fixed length, for example 30.' },
      { key: 'duration_label', label: 'Duration text (optional)', type: 'text', max: 40, hint: 'Used when there is no fixed length, for example "Duration varies".' },
      { key: 'sort_order', label: 'Sort order', type: 'int', def: 0, hint: 'Lower numbers come first.' },
      { key: 'description', label: 'Description', type: 'textarea', max: 500, span2: true },
      { key: 'is_active', label: 'Shown on the Services page', type: 'checkbox', def: true },
    ],
  },
  guests: {
    label: 'Special guests', noun: 'guest', table: 'special_guests', select: '*', admin: true, order: ['sort_order', 'name'],
    note: 'Notable guests shown on the front page, in the photo area next to "A Comfortable Place to Stay, Dine, and Unwind". They rotate one at a time. With no guest shown, that area keeps its normal room photo.',
    columns: [
      ['', (r) => `<img src="${esc(safeImg(r.image_url))}" alt="">`],
      ['Name', (r) => esc(r.name)],
      ['Title', (r) => esc(r.title || '—')],
      ['Visited', (r) => esc(r.visit_date ? new Date(`${r.visit_date}T00:00:00`).toLocaleDateString('en-PH', { month: 'short', year: 'numeric' }) : '—')],
    ],
    toggles: [{ key: 'is_visible', label: 'Shown' }],
    fields: [
      { key: 'name', label: 'Guest name', type: 'text', required: true, max: 120 },
      { key: 'title', label: 'Title or role (optional)', type: 'text', max: 120, hint: 'For example "Singer" or "Mayor of Candijay".' },
      { key: 'visit_date', label: 'Date of visit (optional)', type: 'date' },
      { key: 'sort_order', label: 'Sort order', type: 'int', def: 0, hint: 'Lower numbers come first.' },
      { key: 'image_url', label: 'Photo', type: 'image', span2: true },
      { key: 'note', label: 'A short note (optional)', type: 'textarea', max: 400, span2: true, keepEmpty: true },
      { key: 'is_visible', label: 'Shown on the front page', type: 'checkbox', def: true },
    ],
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
  document.querySelector('link[rel="manifest"]')?.remove();
  updateInstallBtn();
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
  const t = [['orders', 'Orders'], ['inquiries', 'Inquiries'], ['menu', 'Menu'], ['delivery', 'Delivery fee'], ['rooms', 'Room rates'], ['massage', 'Massage'], ['website', 'Website'], ['history', 'Price history']];
  if (isAdmin()) t.push(['staff', 'Staff']);
  return t;
}

/* ---------- phone alerts (push notifications) and the number on the app icon ---------- */
const VAPID_PUBLIC_KEY = 'BJhzKXURTWmyaujowe850bvS6E8oWRDBg48cgALtXcNar1MR_YKd4hEzKceO8GEFMpuhs1H0ilgSl_90GA-AD5o';
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const PUSH_LABEL = { on: 'Alerts: on', off: 'Alerts: off', denied: 'Alerts: blocked', unsupported: 'Alerts: n/a', ios: 'Alerts: n/a' };
function pushLabel() { return PUSH_LABEL[S.push] || 'Alerts: off'; }
const b64ToBytes = (b64) => { const p = '='.repeat((4 - (b64.length % 4)) % 4); const raw = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };

async function pushStatus() {
  if (!pushSupported()) return isIOS() && !isStandalone() ? 'ios' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = await reg?.pushManager.getSubscription();
    return sub && Notification.permission === 'granted' ? 'on' : 'off';
  } catch { return 'off'; }
}
async function refreshPushUi() {
  S.push = await pushStatus();
  document.querySelectorAll('[data-push]').forEach((b) => { b.textContent = pushLabel(); b.setAttribute('aria-pressed', String(S.push === 'on')); });
}
async function togglePush() {
  const st = await pushStatus();
  if (st === 'ios') { toast('On an iPhone: tap Share, then "Add to Home Screen", then open the Staff icon and turn Alerts on there.'); return; }
  if (st === 'unsupported') { toast('This browser cannot show phone alerts. Use Chrome on Android, or add this page to the Home Screen on an iPhone.', 'error'); return; }
  if (st === 'denied') { toast('Alerts are blocked for this site. Allow notifications in the browser or phone settings, then try again.', 'error'); return; }
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    if (st === 'on') {
      const sub = await reg.pushManager.getSubscription();
      if (sub) { await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); await sub.unsubscribe(); }
      toast('Alerts are off on this phone.');
    } else {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('Alerts were not allowed, so nothing was turned on.', 'error'); await refreshPushUi(); return; }
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY) });
      const j = sub.toJSON();
      const { error } = await supabase.from('push_subscriptions').upsert({ user_id: S.profile.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 200) }, { onConflict: 'endpoint' });
      if (error) throw error;
      toast('Alerts are on. This phone will be notified of new orders and inquiries.');
    }
  } catch (err) { toast(friendlyError(err), 'error'); }
  await refreshPushUi();
}
// the red number on the app icon (Android and iPhone, once installed from the Home Screen)
function syncAppBadge() {
  const n = (S.pendingOrders || 0) + (S.newInq ? S.newInq.booking + S.newInq.massage + S.newInq.event : 0);
  try { if ('setAppBadge' in navigator) { if (n > 0) navigator.setAppBadge(n); else navigator.clearAppBadge(); } } catch { /* not supported */ }
}

/* ---------- install the Staff app (only offered after signing in) ---------- */
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; updateInstallBtn(); });
window.addEventListener('appinstalled', () => { installEvent = null; updateInstallBtn(); toast('Staff app installed. Open it from your home screen.'); });
function updateInstallBtn() {
  const b = $('install-btn');
  if (!b) return;
  // shown only to signed-in staff, never inside the installed app, and only where the phone can do it
  b.hidden = !S.profile || isStandalone() || !(installEvent || isIOS());
}
async function installApp() {
  if (installEvent) { installEvent.prompt(); await installEvent.userChoice.catch(() => {}); installEvent = null; updateInstallBtn(); return; }
  if (isIOS()) toast('On an iPhone: tap the Share button in Safari, then "Add to Home Screen", then Add.');
}
// the Staff app's manifest is only added once someone has signed in, so the install option never appears on the sign-in screen
function addStaffManifest() {
  if (document.querySelector('link[rel="manifest"]')) return;
  const l = document.createElement('link');
  l.rel = 'manifest'; l.href = '/qsnqpbzovgcamaqq.webmanifest';
  document.head.appendChild(l);
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
  addStaffManifest();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  updateInstallBtn();
  refreshPushUi();
  showTab(S.tab);
  if (S.tab !== 'orders') loadOrders();
  if (!isInqTab()) loadInquiries();
}

// screens that live under a top tab, shown as a row of sub-tabs
const MENU_SUB = [['menu', 'Items'], ['sections', 'Sections'], ['extras', 'Extras'], ['options', 'Sizes & flavors']];
const WEB_SUB = [['highlights', 'Home highlights'], ['slideshow', 'Slideshow'], ['gallery', 'Gallery'], ['guests', 'Special guests']];
const TAB_GROUP = {};
MENU_SUB.forEach(([k]) => { TAB_GROUP[k] = 'menu'; });
WEB_SUB.forEach(([k]) => { TAB_GROUP[k] = 'website'; });

function showTab(tab) {
  S.tab = tab;
  S.rng = { orders: {}, inquiries: {}, history: {} };
  S.isub = S.isub || 'booking';
  S.rq = ''; S.iq = ''; S.rcat = ''; S.rvenue = ''; S.rstock = ''; S.ractive = ''; S.rxprice = ''; S.rpage = ''; S.hq = ''; S.hf = 'all'; S.hlimit = 30;
  if (tab === 'website') { showTab('highlights'); return; }
  document.querySelectorAll('#st-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === (TAB_GROUP[tab] || tab))));
  const p = $('st-panel');
  p.innerHTML = '<div class="skel" style="height:140px;"></div>';
  if (tab === 'orders') return loadOrders();
  if (isInqTab(tab)) return loadInquiries();
  if (tab === 'history') return loadHistory();
  if (tab === 'staff') return loadStaff();
  if (tab === 'delivery') return loadDelivery();
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

// Alert sounds: a ding for a new order, a notification tone for a new inquiry (and the preview when Sound is switched on).
const SOUNDS = { order: 'assets/sounds/the_price_is_right_ding.mp3', inquiry: 'assets/sounds/inquiry_notification.mp3' };
const alertAudio = {};
function beep(kind = 'order') {
  try {
    const a = alertAudio[kind] = alertAudio[kind] || new Audio(SOUNDS[kind] || SOUNDS.order);
    a.currentTime = 0;
    a.play().catch(() => { /* the browser blocks sound until the page has been clicked once */ });
  } catch { /* audio not available */ }
}

async function loadOrders() {
  try {
    const { data, error } = await applyRange(supabase.from('orders').select('*, order_items(*, menu_items(image_url))'), 'orders', 'created_at')
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
  S.pendingOrders = n; syncAppBadge();
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
    <div class="o-head"><span class="num">#${esc(o.order_number)}</span><span class="st st-${esc(o.status)}">${STATUS_LABEL[o.status]}</span>${o.edited_at ? ' <span class="badge" title="The customer changed this order">Edited</span>' : ''}</div>
    <div class="o-meta"><span class="${late ? 'late-txt' : ''}">${ago(o.created_at)}</span> · ${TYPE_LABEL[o.order_type]}${o.room_number ? ` · Room ${esc(o.room_number)}` : ''}${o.delivery_address ? `<br><strong>Deliver to:</strong> ${esc(o.delivery_address)}${o.delivery_lat != null ? ` · <button type="button" class="btn-xs" data-route="${esc(o.id)}">Show route${o.delivery_km != null ? ` (${Number(o.delivery_km).toFixed(1)} km)` : ''}</button>` : ''}` : ''}<br>
      <strong>${esc(o.customer_name)}</strong> · <a href="tel:${esc(o.customer_phone)}">${esc(o.customer_phone)}</a></div>
    <div class="o-items">${o.order_items.map((i) => { const img = i.menu_items?.image_url; return `<div><span class="o-it">${img ? `<button type="button" class="o-thumbbtn" data-photo="${esc(safeImg(img))}" data-name="${esc(i.item_name)}" aria-label="View photo of ${esc(i.item_name)}"><img class="o-thumb" src="${esc(safeImg(img))}" alt="" loading="lazy"></button>` : '<span class="o-thumb o-none" aria-hidden="true"></span>'}<span>${i.quantity} × ${esc(i.item_name)}${(i.extras || []).length ? `<small class="o-extra">${i.extras.map((x) => `+ ${esc(x.name)}`).join('<br>')}</small>` : ''}</span></span><span class="price">${peso(i.line_total)}</span></div>`; }).join('')}
      ${Number(o.discount_total) > 0 ? `<div><span>Discount (${esc(o.discount_code)})</span><span class="price">−${peso(o.discount_total)}</span></div>` : ''}
      ${Number(o.delivery_fee) > 0 ? `<div><span>Delivery fee</span><span class="price">${peso(o.delivery_fee)}</span></div>` : ''}
      <div class="o-total"><strong>Total</strong><strong class="price">${peso(o.total)}</strong></div></div>
    ${o.notes ? `<div class="o-note"><strong>Customer note:</strong> ${esc(o.notes)}</div>` : ''}
    <div class="o-actions">${actions}${isAdmin() ? ` <button type="button" class="btn-xs danger" data-del-order="${esc(o.id)}">Delete</button>` : ''}</div></article>`;
}

function renderOrders() {
  if (!$('o-body')) {
    $('st-panel').innerHTML = `<div id="o-stats" class="stat-row"></div>
      <div class="st-toolbar"><div class="chips" id="o-chips" role="group" aria-label="Filter orders"></div>
        <div class="tool-right">
          <input type="search" id="o-search" class="st-search" placeholder="Search # or name" aria-label="Search orders" value="${esc(S.orderSearch || '')}">
          <button type="button" class="btn-xs" id="sound-btn" data-sound="1"></button>
          <button type="button" class="btn-xs" data-push="1">${esc(pushLabel())}</button>
          <span class="live-dot" id="live"></span></div></div>
      <div id="rng-orders">${rangeBar('orders')}</div>${purgeBar('orders')}
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
  'orders', 'created_at', 'desc');

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

// Administrators can delete any order, in any status. Always asks first, because it cannot be undone.
async function deleteOrder(id) {
  const o = allOrders.find((x) => x.id === id);
  if (!o || !isAdmin()) return;
  const active = ['pending', 'preparing', 'ready'].includes(o.status);
  const ok = await confirmDialog(
    `Delete order #${o.order_number}?`,
    `${o.customer_name} · ${peso(o.total)} · ${STATUS_LABEL[o.status]}. ${active ? 'This order is still active, and the customer will no longer see it. ' : ''}It will be permanently deleted and cannot be recovered. To keep a record, cancel it instead.`,
    'Delete permanently');
  if (!ok) return;
  document.querySelectorAll(`.o-card[data-oid="${CSS.escape(id)}"] button`).forEach((b) => (b.disabled = true));
  const { error } = await supabase.rpc('admin_delete_order', { p_id: id });
  if (error) { toast(friendlyError(error), 'error'); renderOrders(); return; }
  allOrders = allOrders.filter((x) => x.id !== id);
  toast(`Order #${o.order_number} deleted.`);
  updateBadges();
  renderOrders();
}

const refreshOrders = debounce(() => loadOrders(), 250);

const TAB_FOR_TABLE = {
  menu_items: 'menu', menu_extras: 'extras', menu_options: 'options', categories: 'sections', room_rates: 'rooms', massage_services: 'massage', special_guests: 'guests', gallery_photos: 'gallery', home_highlights: 'highlights', page_slides: 'slideshow', price_history: 'history',
};
const isEditing = () => $('dlg').open || $('pwd')?.open || $('cfm').open || document.querySelector('.qp-form');

function refreshTab(tab = S.tab) {
  if (tab === 'orders') return loadOrders();
  if (isInqTab(tab)) return loadInquiries();
  if (tab === 'history') return loadHistory();
  if (tab === 'staff') return loadStaff();
  if (tab === 'delivery') return;   // a settings form: never reload it under someone who is typing
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
      } else if (payload.eventType === 'UPDATE' && payload.new.edited_at && Date.now() - new Date(payload.new.edited_at).getTime() < 8000) {
        S.fresh.add(payload.new.id);
        toast(`Order #${payload.new.order_number} was changed by the customer`);
        if (S.sound) beep();
      }
      refreshOrders();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'inquiries' }, (payload) => {
      if (payload.eventType === 'INSERT') {
        S.fresh.add(payload.new.id);
        toast(`New ${KIND_LABEL[payload.new.kind].toLowerCase()} from ${payload.new.full_name}`);
        if (S.sound) beep('inquiry');
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
      if (S.tab === 'orders' || isInqTab() || (Date.now() - (S.lastPoll || 0)) > 55000) {
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
const KIND_LABEL = { booking: 'Room booking', table: 'Table reservation', message: 'Message', massage: 'Massage', event: 'Event' };
const isInqTab = (t = S.tab) => t === 'inquiries';
// inside Inquiries: Massage and Events have their own sub-tabs, Booking shows everything else
const inqSub = (i) => (i.kind === 'massage' ? 'massage' : i.kind === 'event' ? 'event' : 'booking');
const inqScope = () => inquiries.filter((i) => inqSub(i) === S.isub);
const INQ_STATUS = { new: 'New', contacted: 'Contacted', closed: 'Closed' };
const DETAIL_LABEL = {
  check_in: 'Check-in', check_out: 'Check-out', guests: 'Guests', room_preference: 'Room',
  event_type: 'Event', venue: 'Venue', massage_type: 'Massage', service_type: 'Where', address: 'Home address', date: 'Date', time: 'Time', party_size: 'Party size', special_request: 'Special request', notes: 'Message', message: 'Message',
};
let inquiries = [];
S.ifilter = 'new';

async function loadInquiries() {
  try {
    const { data, error } = await applyRange(supabase.from('inquiries').select('*'), 'inquiries', 'created_at').order('created_at', { ascending: false }).limit(hasRange('inquiries') ? 500 : 200);
    if (error) throw error;
    inquiries = data;
    updateInquiryBadge();
    if (isInqTab()) renderInquiries();
  } catch (err) { if (isInqTab()) panelError(err, loadInquiries); }
}

async function updateInquiryBadge() {
  const base = () => supabase.from('inquiries').select('id', { count: 'exact', head: true }).eq('status', 'new');
  const [other, massage, event] = await Promise.all([base().not('kind', 'in', '(massage,event)'), base().eq('kind', 'massage'), base().eq('kind', 'event')]);
  S.newInq = { booking: other.count || 0, massage: massage.count || 0, event: event.count || 0 };
  const n = S.newInq.booking + S.newInq.massage + S.newInq.event;
  syncAppBadge();
  const tab = document.querySelector('#st-tabs [data-tab="inquiries"]');
  if (tab) tab.innerHTML = `Inquiries${n ? ` <span class="tab-badge" aria-label="${n} new">${n}</span>` : ''}`;
  renderInqSubtabs();
}

const INQ_SUB = [['booking', 'Booking'], ['massage', 'Massage'], ['event', 'Events']];
function renderInqSubtabs() {
  const el = $('i-sub');
  if (!el) return;
  el.innerHTML = INQ_SUB.map(([k, l]) => {
    const n = S.newInq?.[k] || 0;
    return `<button type="button" role="tab" data-isub="${k}" aria-selected="${k === S.isub}">${l}${n ? ` <span class="tab-badge" aria-label="${n} new">${n}</span>` : ''}</button>`;
  }).join('');
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
    $('st-panel').innerHTML = `<div class="subtabs" id="i-sub" role="tablist" aria-label="Inquiry type"></div>
      <div class="st-toolbar"><div class="chips" id="i-chips" role="group" aria-label="Filter inquiries"></div>
      <div class="tool-right"><input type="search" id="i-search" class="st-search" placeholder="Search name or phone" aria-label="Search inquiries" value="${esc(S.iq || '')}">
        <button type="button" class="btn-xs" id="isound-btn" data-sound="1"></button>
        <button type="button" class="btn-xs" data-push="1">${esc(pushLabel())}</button></div></div>
      <div id="rng-inquiries">${rangeBar('inquiries')}</div>${purgeBar('inquiries')}
      <div id="i-body"></div>`;
  }
  renderInqSubtabs();
  const isb = $('isound-btn');
  isb.textContent = S.sound ? 'Sound: on' : 'Sound: off';
  isb.setAttribute('aria-pressed', String(S.sound));
  const counts = {};
  const scoped = inqScope();
  scoped.forEach((i) => { counts[i.status] = (counts[i.status] || 0) + 1; });
  $('i-chips').innerHTML = [...Object.entries(INQ_STATUS), ['all', 'All']].map(([k, l]) =>
    `<button type="button" data-ifilter="${k}" aria-pressed="${k === S.ifilter}">${l} <span class="chip-n">${k === 'all' ? scoped.length : counts[k] || 0}</span></button>`).join('');
  const q = (S.iq || '').toLowerCase().trim();
  const list = sortRows(scoped.filter((i) => (S.ifilter === 'all' || i.status === S.ifilter) &&
    (!q || i.full_name.toLowerCase().includes(q) || i.phone.includes(q) || (i.email || '').toLowerCase().includes(q))),
  'inquiries', 'created_at', 'desc');
  $('i-body').innerHTML = list.length
    ? `<div class="order-grid">${list.map(inquiryCard).join('')}</div>`
    : `<div class="empty"><strong>${q ? 'No inquiries match your search' : 'No inquiries here'}</strong>${q ? 'Try a different name or phone number.' : hasRange('inquiries') ? 'No inquiries were received in this date range.' : S.isub === 'massage' ? 'Massage requests from the Services page will appear here automatically.' : S.isub === 'event' ? 'Event and gathering requests from the Services page will appear here automatically.' : 'Room bookings, table reservations and messages from the website will appear here automatically.'}</div>`;
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

/* ---------- admin: delete old records ---------- */
const PURGE_LABEL = {
  orders: ['completed and cancelled orders', 'orders'],
  inquiries: ['closed inquiries', 'inquiries'],
  history: ['price-history entries', 'history'],
};
const purgeBar = (kind) => isAdmin()
  ? `<div class="purge-row"><span>Clean up</span>
      <select data-purge-days="${kind}" aria-label="Delete records older than">
        ${[[30, '30 days'], [90, '3 months'], [180, '6 months'], [365, '1 year']].map(([v, l]) => `<option value="${v}">older than ${l}</option>`).join('')}
      </select>
      <button type="button" class="btn-xs danger" data-purge="${kind}">Delete old ${PURGE_LABEL[kind][0]}</button></div>`
  : '';

async function purgeOld(kind) {
  const days = Number(document.querySelector(`[data-purge-days="${kind}"]`)?.value || 90);
  const [what] = PURGE_LABEL[kind];
  const { data: n, error } = await supabase.rpc('admin_purge_old', { p_kind: kind, p_older_than_days: days, p_dry_run: true });
  if (error) { toast(friendlyError(error), 'error'); return; }
  if (!n) { toast(`No ${what} older than ${days} days.`); return; }
  const ok = await confirmDialog(`Delete ${n} ${what}?`, `Everything of this kind older than ${days} days will be removed for good. This cannot be undone.`, `Delete ${n}`);
  if (!ok) return;
  const res = await supabase.rpc('admin_purge_old', { p_kind: kind, p_older_than_days: days, p_dry_run: false });
  if (res.error) toast(friendlyError(res.error), 'error'); else toast(`Deleted ${res.data} ${what}.`);
  RANGE_RELOAD[PURGE_LABEL[kind][1]]();
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
    if (key === 'menu' || key === 'extras' || key === 'options' || key === 'highlights') await ensureCategories();
    let q = supabase.from(cfg.table).select(cfg.select);
    cfg.order.forEach((c) => (q = q.order(c)));
    const { data, error } = await q;
    if (error) throw error;
    if (S.tab !== key) return;
    currentRows = data;
    if (cfg.max) $('r-body')?.remove();          // rebuild the toolbar so the Add button follows the limit
    renderResource(key);
  } catch (err) { panelError(err, () => loadResource(key)); }
}

async function ensureCategories() {
  const { data, error } = await supabase.from('categories').select('id, name, venue').order('venue').order('sort_order').order('name');
  if (error) throw error;
  S.categories = data;
  const items = await supabase.from('menu_items').select('id, name, category_id, categories(name, venue)').order('name');
  if (items.error) throw items.error;
  S.menuItems = items.data;
}

const rowText = (r) => [r.name, r.code, r.slug, r.description, r.categories?.name, r.menu_items?.name].filter(Boolean).join(' ').toLowerCase();

const menuSubtabs = (key) => (TAB_GROUP[key]
  ? `<div class="subtabs" role="tablist" aria-label="${TAB_GROUP[key] === 'menu' ? 'Menu' : 'Website'}">${(TAB_GROUP[key] === 'menu' ? MENU_SUB : WEB_SUB).map(([k, l]) => `<button type="button" role="tab" data-rsub="${k}" aria-selected="${k === key}">${l}</button>`).join('')}</div>`
  : '');

// "Venue - Section" groups of dishes for the picker, so a long menu is easy to scan
function dishGroups() {
  const groups = new Map();
  [...S.menuItems].sort((a, b) => a.name.localeCompare(b.name)).forEach((i) => {
    const g = `${VENUE_LABEL[i.categories?.venue] || ''} · ${i.categories?.name || 'Other'}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push([i.id, i.name]);
  });
  return [...groups].sort((a, b) => a[0].localeCompare(b[0]));
}
// what the customer pays for this choice; a flavor at 0 simply keeps the dish price
function optionPrice(r) {
  if (r.option_type === 'flavor' && Number(r.price) === 0) return '<span class="muted">Same as dish price</span>';
  return `<span class="price">${peso(r.price)}</span>`;
}
// Sizes & flavors: one card per dish with its choices listed inside (instead of one long table)
function renderOptionGroups(rows, canWrite) {
  const byDish = new Map();
  rows.forEach((r) => { const k = r.menu_item_id; if (!byDish.has(k)) byDish.set(k, { dish: r.menu_items, id: k, list: [] }); byDish.get(k).list.push(r); });
  const groups = [...byDish.values()].sort((a, b) => (a.dish?.name || '').localeCompare(b.dish?.name || ''));
  const open = groups.length <= 8 || Boolean(S.rq);
  const where = (d) => `${VENUE_LABEL[d?.categories?.venue] || ''} · ${d?.categories?.name || ''}`;
  const count = (list) => { const sz = list.filter((x) => x.option_type === 'size').length, fl = list.length - sz; return [sz ? `${sz} size${sz > 1 ? 's' : ''}` : '', fl ? `${fl} flavor${fl > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · '); };
  return `<p class="count-line">${rows.length} choice${rows.length === 1 ? '' : 's'} on ${groups.length} dish${groups.length === 1 ? '' : 'es'}</p>
    <div class="opt-groups">${groups.map((g) => `<details class="opt-group" ${open ? 'open' : ''}>
      <summary><span class="opt-dish"><strong>${esc(g.dish?.name || 'Unknown dish')}</strong><small>${esc(where(g.dish))}</small></span>
        <span class="opt-count">${esc(count(g.list))}</span></summary>
      <ul class="opt-list">${g.list.map((r) => `<li class="${r.is_active ? '' : 'is-off'}">
        <span class="badge ${r.option_type === 'size' ? '' : 'alt'}">${r.option_type === 'size' ? 'Size' : 'Flavor'}</span>
        <span class="opt-name">${esc(r.name)}</span><span class="opt-price">${optionPrice(r)}</span>
        <label class="switch"><input type="checkbox" data-toggle="is_active" data-id="${esc(r.id)}" ${r.is_active ? 'checked' : ''} ${canWrite ? '' : 'disabled'} aria-label="Available: ${esc(r.name)}"><span></span></label>
        ${canWrite ? `<span class="row-actions"><button type="button" class="btn-xs" data-edit="${esc(r.id)}">Edit</button><button type="button" class="btn-xs danger" data-delete="${esc(r.id)}">Delete</button></span>` : ''}</li>`).join('')}</ul>
      ${canWrite ? `<div class="opt-add"><button type="button" class="btn-xs" data-addopt="${esc(g.id)}">+ Add a size or flavor to ${esc(g.dish?.name || 'this dish')}</button></div>` : ''}
    </details>`).join('')}</div>`;
}

function renderResource(key) {
  const cfg = RES[key];
  const canWrite = !cfg.admin || isAdmin();
  if (!$('r-body')) {
    $('st-panel').innerHTML = `${menuSubtabs(key)}<div class="st-toolbar"><h2 style="font-size:22px;">${esc(cfg.label)}</h2>
      <div class="tool-right">
        <input type="search" id="r-search" class="st-search" placeholder="Search ${esc(cfg.label.toLowerCase())}" aria-label="Search ${esc(cfg.label)}" value="${esc(S.rq || '')}">
        ${key === 'options' ? `<select id="r-cat" class="st-select" aria-label="Filter by section"><option value="">All sections</option>${S.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (${esc(VENUE_LABEL[c.venue] || '')})</option>`).join('')}</select>` : ''}
        ${key === 'slideshow' ? `<select id="r-page" class="st-select" aria-label="Filter by page"><option value="">All pages</option>${Object.entries(PAGE_LABEL).map(([v, l]) => `<option value="${v}" ${S.rpage === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>` : ''}
        ${key === 'menu' ? `<select id="r-venue" class="st-select" aria-label="Filter by venue"><option value="">All venues</option><option value="main">Main</option><option value="roofdeck">Roof Deck</option></select>
          <select id="r-cat" class="st-select" aria-label="Filter by section"><option value="">All sections</option>${S.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (${esc(VENUE_LABEL[c.venue] || '')})</option>`).join('')}</select>` : ''}
        ${key === 'menu' ? `<select id="r-stock" class="st-select" aria-label="Filter by stock"><option value="">Any stock</option><option value="low">Low or out</option><option value="untracked">Not tracked</option></select>` : ''}
        ${key === 'extras' ? `<select id="r-active" class="st-select" aria-label="Filter by availability"><option value="">Any status</option><option value="on">Available</option><option value="off">Hidden</option></select>
          <select id="r-xprice" class="st-select" aria-label="Filter by price"><option value="">Any price</option><option value="paid">Paid</option><option value="free">Free</option></select>` : ''}
        ${canWrite && cfg.max && currentRows.length >= cfg.max ? `<span class="badge">Maximum of ${cfg.max} reached. Delete one to add another.</span>` : canWrite ? `<button type="button" class="btn btn-primary btn-sm" data-new="1">Add ${esc(cfg.noun)}</button>`
          : '<span class="badge">View only. Administrators manage this.</span>'}</div></div>
      ${cfg.note ? `<p class="count-line" style="text-transform:none;letter-spacing:0;margin-bottom:14px;">${esc(cfg.note)}</p>` : ''}
      <div id="r-body"></div>`;
  }
  const q = (S.rq || '').toLowerCase().trim();
  const rows = currentRows.filter((r) => (!q || rowText(r).includes(q)) && (!S.rcat || (r.category_id || r.menu_items?.category_id) === S.rcat)
    && (!S.rvenue || (r.categories?.venue || r.menu_items?.categories?.venue) === S.rvenue)
    && (S.rstock !== 'low' || isLowStock(r)) && (S.rstock !== 'untracked' || r.stock == null)
    && (S.ractive !== 'on' || r.is_active) && (S.ractive !== 'off' || r.is_active === false)
    && (!S.rpage || r.page === S.rpage)
    && (S.rxprice !== 'free' || Number(r.price) === 0) && (S.rxprice !== 'paid' || Number(r.price) > 0));
  const body = $('r-body');
  if (!currentRows.length) {
    body.innerHTML = `<div class="empty"><strong>No ${esc(cfg.noun)}s yet</strong>${canWrite ? `Use “Add ${esc(cfg.noun)}” to create the first one.` : ''}</div>`;
    return;
  }
  if (!rows.length) {
    body.innerHTML = '<div class="empty"><strong>No matches</strong>Try a different search or category.</div>';
    return;
  }
  if (key === 'options') { body.innerHTML = renderOptionGroups(rows, canWrite); return; }
  const drag = Boolean(cfg.sortable && canWrite && !q);
  const heads = [...cfg.columns.map((c) => c[0]), ...cfg.toggles.map((t) => t.label)];
  const td = (h, html, cls = '') => `<td data-label="${esc(h)}" class="${cls}">${html}</td>`;
  const lowN = key === 'menu' ? currentRows.filter(isLowStock).length : 0;
  body.innerHTML = `<p class="count-line">Showing ${rows.length} of ${currentRows.length}${lowN ? ` · ${lowN} low or out of stock` : ''}</p>
    <div class="tbl-wrap"><table class="tbl resp"><thead><tr>${drag ? '<th></th>' : ''}${heads.map((h) => `<th>${esc(h)}</th>`).join('')}${canWrite ? '<th></th>' : ''}</tr></thead><tbody>
    ${rows.map((r) => `<tr data-id="${esc(r.id)}">${drag ? '<td class="drag-cell"><span class="drag-handle" data-drag="1" title="Drag to change the order" aria-label="Drag to change the order">⠿</span></td>' : ''}${cfg.columns.map(([h, f]) => {
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
    </tbody></table></div>${cfg.sortable && canWrite && q ? '<p class="count-line" style="text-transform:none;letter-spacing:0">Clear the search to drag photos into a new order.</p>' : ''}`;
}

// Drag a row by its handle to change the order (pointer events, so it works with a finger as well as a mouse)
function startRowDrag(e) {
  const handle = e.target.closest('[data-drag]');
  if (!handle || e.button > 0) return;
  const tr = handle.closest('tr'), tbody = tr.parentElement;
  e.preventDefault();
  handle.setPointerCapture(e.pointerId);
  tr.classList.add('dragging');
  const move = (ev) => {
    const others = [...tbody.children].filter((x) => x !== tr);
    const after = others.find((r) => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
    if (after) { if (tr.nextElementSibling !== after) tbody.insertBefore(tr, after); }
    else if (tbody.lastElementChild !== tr) tbody.appendChild(tr);
    if (ev.clientY < 70) window.scrollBy(0, -14); else if (ev.clientY > window.innerHeight - 70) window.scrollBy(0, 14);
  };
  const up = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
    tr.classList.remove('dragging');
    saveRowOrder(S.tab, [...tbody.querySelectorAll('tr')].map((x) => x.dataset.id));
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
}
async function saveRowOrder(key, ids) {
  const cfg = RES[key];
  const changed = ids.map((id, i) => ({ id, pos: (i + 1) * 10 })).filter((x) => currentRows.find((r) => r.id === x.id)?.sort_order !== x.pos);
  if (!changed.length) return;
  const results = await Promise.all(changed.map((x) => supabase.from(cfg.table).update({ sort_order: x.pos }).eq('id', x.id)));
  const failed = results.find((r) => r.error);
  if (failed) toast(friendlyError(failed.error), 'error'); else toast('Order saved. The website shows it right away.');
  loadResource(key);
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
  else if (f.type === 'select') {
    const opt = ([val, lab]) => `<option value="${esc(val)}" ${val === v ? 'selected' : ''}>${esc(lab)}</option>`;
    const list = f.groups ? f.groups().map(([g, items]) => `<optgroup label="${esc(g)}">${items.map(opt).join('')}</optgroup>`).join('') : f.options().map(opt).join('');
    input = `<select id="${id}" name="${f.key}"><option value="">Select…</option>${list}</select>`;
  }
  else if (f.type === 'date') input = `<input type="date" id="${id}" name="${f.key}" value="${esc(v ?? '')}">`;
  else if (f.type === 'datetime') input = `<input type="datetime-local" id="${id}" name="${f.key}" value="${esc(toLocalInput(v))}">`;
  else if (f.type === 'stockopt') input = `<input type="text" inputmode="numeric" id="${id}" name="${f.key}" value="${esc(v ?? '')}" placeholder="Not tracked" autocomplete="off">`;
  else if (f.type === 'price' || f.type === 'priceopt' || f.type === 'money0') input = `<input type="text" inputmode="decimal" id="${id}" name="${f.key}" value="${esc(v ?? '')}" autocomplete="off">`;
  else if (f.type === 'int') input = `<input type="number" step="1" id="${id}" name="${f.key}" value="${esc(v ?? 0)}">`;
  else input = `<input type="text" id="${id}" name="${f.key}" value="${esc(v ?? '')}" maxlength="${f.max || 200}" autocomplete="off">`;
  return `<div class="${cls}"><label for="${id}">${esc(f.label.toUpperCase())}</label>${input}${hint}${err}</div>`;
}

let editing = null; // { key, row|null }

function openDialog(key, row, preset = null) {
  const cfg = RES[key];
  editing = { key, row };
  S.pendingImg = {};
  const base = row || preset;
  const lockedDish = key === 'options' && !row && preset?.menu_item_id ? S.menuItems.find((i) => i.id === preset.menu_item_id) : null;
  const title = lockedDish ? `Add a size or flavor to ${lockedDish.name}` : `${row ? 'Edit' : 'Add'} ${cfg.noun}`;
  $('dlg-form').innerHTML = `<h3>${esc(title)}</h3>
    <div class="grid-fields">${cfg.fields.map((f) => (lockedDish && f.key === 'menu_item_id'
      ? `<input type="hidden" id="fld-menu_item_id" name="menu_item_id" value="${esc(lockedDish.id)}">`
      : fieldHtml(f, base))).join('')}</div>
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
    } else if (f.type === 'date') {
      v = v || null;
    } else if (f.type === 'datetime') {
      v = v ? new Date(v).toISOString() : null;
    } else if (f.type === 'image') {
      v = v || null;
    } else {
      if (f.required && !v) bad = `${f.label} is required.`;
      else if (f.max && v.length > f.max) bad = `Maximum ${f.max} characters.`;
      else if (f.type === 'slug' && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(v)) bad = 'Use lowercase letters, numbers and single dashes.';
      else if (f.pattern && !f.pattern.test(v)) bad = f.patternMsg || 'Invalid value.';
      if (v === '' && !f.required) v = (f.key === 'description' || f.keepEmpty) ? '' : null;
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

// A section that still has dishes cannot simply be removed: ask whether to move them or delete them too.
async function deleteSection(row) {
  const { count, error: cErr } = await supabase.from('menu_items').select('id', { count: 'exact', head: true }).eq('category_id', row.id);
  if (cErr) { toast(friendlyError(cErr), 'error'); return; }
  if (!count) {
    const ok = await confirmDialog(`Delete “${row.name}”?`, 'This cannot be undone. To keep it but stop showing it, switch it off instead.', 'Delete');
    if (!ok) return;
    const { error } = await supabase.from('categories').delete().eq('id', row.id);
    if (error) toast(friendlyError(error), 'error'); else toast('Deleted.');
    loadResource('sections');
    return;
  }
  const d = $('secdel');
  const f = $('secdel-form');
  const others = currentRows.filter((r) => r.id !== row.id);
  $('secdel-title').textContent = `“${row.name}” has ${count} dish${count === 1 ? '' : 'es'}`;
  $('secdel-msg').textContent = 'A section cannot be deleted while it has dishes. Choose what happens to them.';
  f.elements.target.innerHTML = others.map((c) => `<option value="${esc(c.id)}" ${c.venue === row.venue ? '' : 'data-other'}>${esc(c.name)} (${esc(VENUE_LABEL[c.venue] || c.venue)})</option>`).join('');
  f.elements.mode.value = others.length ? 'move' : 'delete';
  f.elements.mode.forEach?.((r) => { if (r.value === 'move') r.disabled = !others.length; });
  $('secdel-error').textContent = '';
  const ok = $('secdel-ok');
  ok.disabled = false;
  await new Promise((resolve) => {
    const done = () => { d.onclose = null; if (d.open) d.close(); resolve(); };
    $('secdel-no').onclick = done;
    d.onclose = () => resolve();
    ok.onclick = async () => {
      const mode = f.elements.mode.value;
      const target = f.elements.target.value;
      if (mode === 'move' && !target) { $('secdel-error').textContent = 'Choose a section to move the dishes to.'; return; }
      ok.disabled = true;
      const step = mode === 'move'
        ? await supabase.from('menu_items').update({ category_id: target }).eq('category_id', row.id)
        : await supabase.from('menu_items').delete().eq('category_id', row.id);
      if (step.error) { $('secdel-error').textContent = friendlyError(step.error); ok.disabled = false; return; }
      const { error } = await supabase.from('categories').delete().eq('id', row.id);
      if (error) { $('secdel-error').textContent = friendlyError(error); ok.disabled = false; return; }
      toast(mode === 'move' ? `Section deleted. ${count} dish${count === 1 ? ' was' : 'es were'} moved.` : `Section and ${count} dish${count === 1 ? '' : 'es'} deleted.`);
      done();
    };
    d.showModal();
  });
  loadResource('sections');
}

async function deleteRow(key, id) {
  const row = currentRows.find((r) => r.id === id);
  if (!row) return;
  if (key === 'sections') return deleteSection(row);
  const ok = await confirmDialog(`Delete “${row.name || row.code}”?`, 'This cannot be undone. To keep it but stop showing it, switch it off instead.', 'Delete');
  if (!ok) return;
  const { error } = await supabase.from(RES[key].table).delete().eq('id', id);
  if (error) toast(friendlyError(error), 'error'); else toast('Deleted.');
  loadResource(key);
}

const PRICE_FIELD = { menu_items: 'price', room_rates: 'price_per_night', massage_services: 'price' };

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
      <div id="rng-history">${rangeBar('history')}</div>${purgeBar('history')}
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

/* ---------- delivery fee settings ---------- */
const DEL_FIELDS = [
  ['base_fee', 'Base fee (PHP)', 'Charged for the first kilometres, up to the distance below.'],
  ['base_km', 'Distance covered by the base fee (km)', 'Within this distance the customer pays only the base fee.'],
  ['per_km_fee', 'Fee for each extra km (PHP)', 'Added for every kilometre beyond the base distance.'],
  ['max_km', 'Farthest delivery distance (km)', 'Orders pinned farther than this are refused.'],
  ['road_factor', 'Road factor', 'Roads are longer than a straight line. 1.3 means we count 30% extra. Use 1 for a straight line.'],
];
const delFee = (c, km) => Math.ceil(Number(c.base_fee) + Math.max(0, km - Number(c.base_km)) * Number(c.per_km_fee));

function delExamples(c) {
  const rows = [1, 2, 3, 5, 8, 10].filter((k) => k <= Number(c.max_km));
  return rows.map((k) => `<tr><td data-label="Distance">${k} km</td><td data-label="Fee"><span class="price">${peso(delFee(c, k))}</span></td></tr>`).join('');
}

async function loadDelivery() {
  try {
    const { data, error } = await supabase.from('delivery_settings').select('*').eq('id', 1).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Delivery settings are not set up yet. Run migration 0017 in Supabase first.');
    S.del = data;
    const ready = data.store_lat != null && data.store_lng != null;
    $('st-panel').innerHTML = `
      <div class="st-toolbar"><h2 style="font-size:22px;">Delivery fee</h2></div>
      <p class="hint" style="margin:0 0 14px;">Customers who choose Delivery pin their location on a map. The fee is worked out from the distance to the restaurant using the numbers below, and changes apply to new orders straight away.</p>
      ${ready ? '' : '<div class="banner error" style="margin-bottom:14px;">The restaurant location is not set, so no delivery fee is being charged yet. Set it below.</div>'}
      <form id="delivery-form" class="add-staff" novalidate>
        <div style="display:flex;align-items:flex-start;gap:12px;padding:14px 16px;margin:0 0 18px;background:#fff;border:1px solid #e7e0d3;border-radius:12px;">
          <input type="checkbox" id="d-active" ${data.is_active ? 'checked' : ''} style="width:20px;height:20px;margin-top:2px;flex:none;accent-color:#B8893A;">
          <label for="d-active" style="display:block;margin:0;text-transform:none;letter-spacing:0;font-size:15px;font-weight:600;color:#1c1916;cursor:pointer;">Accept delivery orders
            <span style="display:block;font-weight:400;font-size:13px;color:#6b6357;margin-top:2px;">Switch off to stop new delivery orders (for example when closed or out of riders). Dine in and room orders keep working.</span></label>
        </div>
        <h3>Restaurant location</h3>
        <div class="add-staff-grid">
          <div class="field"><label for="d-lat">LATITUDE</label><input type="text" inputmode="decimal" id="d-lat" value="${data.store_lat ?? ''}" placeholder="9.8000"><div class="err"></div></div>
          <div class="field"><label for="d-lng">LONGITUDE</label><input type="text" inputmode="decimal" id="d-lng" value="${data.store_lng ?? ''}" placeholder="124.5500"><div class="err"></div></div>
        </div>
        <p class="hint">Easiest: open the restaurant in Google Maps, right-click the pin, and click the numbers shown at the top of the menu to copy them. Paste both numbers (for example <em>9.8123, 124.5456</em>) into the Latitude box and they will fill in. Or stand at the restaurant and press the button.</p>
        <p><button type="button" class="btn-xs" id="d-here">Use my current location</button></p>
        <h3>Fee</h3>
        <div class="add-staff-grid">
          ${DEL_FIELDS.map(([k, l, h]) => `<div class="field"><label for="d-${k}">${l.toUpperCase()}</label><input type="text" inputmode="decimal" id="d-${k}" value="${data[k]}"><div class="err"></div><p class="hint" style="margin:4px 0 0;">${h}</p></div>`).join('')}
        </div>
        <div class="form-error" id="delivery-error" role="alert"></div>
        <button type="submit" class="btn btn-primary btn-sm" id="delivery-save">Save delivery settings</button>
      </form>
      <h3 style="margin:22px 0 8px;">What customers pay (examples)</h3>
      <div class="tbl-wrap"><table class="tbl resp"><thead><tr><th>Distance</th><th>Delivery fee</th></tr></thead><tbody id="d-examples">${delExamples(data)}</tbody></table></div>`;
  } catch (err) { panelError(err, loadDelivery); }
}

function onDeliveryPaste(input) {
  const m = input.value.match(/(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)/);
  if (m) { $('d-lat').value = m[1]; $('d-lng').value = m[2]; }
}

async function onSaveDelivery() {
  const errBox = $('delivery-error');
  errBox.classList.remove('show');
  document.querySelectorAll('#delivery-form .field').forEach((f) => f.classList.remove('invalid'));
  const bad = (id, msg) => { const f = $(id).closest('.field'); f.classList.add('invalid'); f.querySelector('.err').textContent = msg; $(id).focus(); };
  const num = (id) => Number(String($(id).value).replace(',', '.').trim());
  const latRaw = $('d-lat').value.trim(), lngRaw = $('d-lng').value.trim();
  let lat = null, lng = null;
  if (latRaw || lngRaw) {
    lat = num('d-lat'); lng = num('d-lng');
    if (!latRaw || !Number.isFinite(lat) || lat < -90 || lat > 90) return bad('d-lat', 'Enter a latitude, for example 9.8123.');
    if (!lngRaw || !Number.isFinite(lng) || lng < -180 || lng > 180) return bad('d-lng', 'Enter a longitude, for example 124.5456.');
  }
  const limits = { base_fee: [0, 100000], base_km: [0, 100], per_km_fee: [0, 100000], max_km: [0.5, 500], road_factor: [1, 3] };
  const payload = { is_active: $('d-active').checked, store_lat: lat, store_lng: lng, updated_at: new Date().toISOString() };
  for (const [k, [lo, hi]] of Object.entries(limits)) {
    const v = num(`d-${k}`);
    if (!Number.isFinite(v) || v < lo || v > hi) return bad(`d-${k}`, `Enter a number between ${lo} and ${hi}.`);
    payload[k] = v;
  }
  const btn = $('delivery-save');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving…';
  try {
    const { error } = await supabase.from('delivery_settings').update(payload).eq('id', 1);
    if (error) throw error;
    toast('Delivery settings saved.');
    loadDelivery();
  } catch (err) {
    errBox.textContent = friendlyError(err); errBox.classList.add('show');
    btn.disabled = false; btn.textContent = 'Save delivery settings';
  }
}

/* ---------- dish photo preview (tap a photo on an order card) ---------- */
function showPhoto(url, name) {
  let dlg = $('photo-dlg');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'photo-dlg';
    dlg.style.cssText = 'width:min(720px,94vw);max-width:94vw;max-height:92vh;padding:0;border:0;border-radius:16px;overflow:hidden;position:fixed;';
    dlg.innerHTML = `<button type="button" id="photo-x" aria-label="Close preview" style="position:absolute;right:12px;top:12px;width:42px;height:42px;border:0;border-radius:50%;background:rgba(20,17,14,.78);color:#fff;font-size:28px;line-height:1;cursor:pointer;z-index:2;">&times;</button>
      <img id="photo-big" alt="" style="display:block;width:100%;max-height:68vh;object-fit:contain;background:#14110e;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 18px;"><strong id="photo-cap" style="font-size:18px;"></strong><button type="button" class="btn-xs" id="photo-close">Close</button></div>`;
    document.body.appendChild(dlg);
    $('photo-x').onclick = () => dlg.close();
    $('photo-close').onclick = () => dlg.close();
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  }
  $('photo-big').src = url;
  $('photo-cap').textContent = name;
  dlg.showModal();
  $('photo-close').focus();
}

/* ---------- delivery route map ---------- */
let leafletReady = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletReady) return leafletReady;
  leafletReady = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'; js.onload = resolve; js.onerror = () => { leafletReady = null; reject(new Error('map')); };
    document.head.appendChild(js);
  });
  return leafletReady;
}

async function showRoute(orderId) {
  const o = allOrders.find((x) => x.id === orderId);
  if (!o || o.delivery_lat == null) return;
  let dlg = $('route-dlg');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'route-dlg';
    dlg.style.cssText = 'width:min(720px,94vw);max-width:94vw;padding:0;border:0;border-radius:14px;overflow:hidden;';
    dlg.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid #e7e0d3;">
        <strong id="route-title"></strong><button type="button" class="btn-xs" id="route-close">Close</button></div>
      <div id="route-map" style="height:min(60vh,420px);background:#ece6da;"></div>
      <div style="padding:12px 18px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;justify-content:space-between;">
        <span id="route-info" style="font-size:14px;"></span><a class="btn btn-primary btn-sm" id="route-gmaps" target="_blank" rel="noopener">Open in Google Maps</a></div>`;
    document.body.appendChild(dlg);
    $('route-close').onclick = () => dlg.close();
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  }
  $('route-title').textContent = `Order #${o.order_number} · ${o.delivery_address || 'Delivery'}`;
  $('route-info').textContent = 'Finding the route…';
  dlg.showModal();

  try {
    if (!S.del) {
      const { data } = await supabase.from('delivery_settings').select('*').eq('id', 1).maybeSingle();
      S.del = data;
    }
    const sLat = S.del?.store_lat, sLng = S.del?.store_lng;
    const dest = [Number(o.delivery_lat), Number(o.delivery_lng)];
    const from = sLat != null ? [Number(sLat), Number(sLng)] : null;
    $('route-gmaps').href = `https://www.google.com/maps/dir/?api=1${from ? `&origin=${from[0]},${from[1]}` : ''}&destination=${dest[0]},${dest[1]}&travelmode=driving`;

    await loadLeaflet();
    const L = window.L;
    if (S.routeMap) { S.routeMap.remove(); S.routeMap = null; }
    const map = L.map('route-map');
    S.routeMap = map;
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
    L.marker(dest).addTo(map).bindTooltip('Customer', { permanent: true, direction: 'top' });
    if (!from) {
      map.setView(dest, 16);
      $('route-info').textContent = 'Set the restaurant location in the Delivery fee tab to see the route from the restaurant.';
      setTimeout(() => map.invalidateSize(), 80);
      return;
    }
    L.circleMarker(from, { radius: 8, color: '#fff', weight: 2, fillColor: '#14110E', fillOpacity: 1 }).addTo(map).bindTooltip('Restaurant', { permanent: true, direction: 'top' });
    map.fitBounds([from, dest], { padding: [30, 30] });
    setTimeout(() => { map.invalidateSize(); map.fitBounds([from, dest], { padding: [30, 30] }); }, 80);

    // Road route from the free OpenStreetMap routing service; falls back to a straight line if it is unreachable.
    let drawn = false;
    try {
      const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${from[1]},${from[0]};${dest[1]},${dest[0]}?overview=full&geometries=geojson`);
      const j = await r.json();
      const route = j.routes?.[0];
      if (route) {
        const line = L.geoJSON(route.geometry, { style: { color: '#1a73e8', weight: 6, opacity: 0.85 } }).addTo(map);
        map.fitBounds(line.getBounds(), { padding: [30, 30] });
        const mins = Math.max(1, Math.round(route.duration / 60));
        $('route-info').innerHTML = `<strong>${(route.distance / 1000).toFixed(1)} km</strong> by road · about <strong>${mins} min</strong> by car`;
        drawn = true;
      }
    } catch { /* handled below */ }
    if (!drawn) {
      L.polyline([from, dest], { color: '#1a73e8', weight: 4, dashArray: '8 8' }).addTo(map);
      $('route-info').textContent = 'Road route unavailable right now. The dashed line is a straight line; use Open in Google Maps for turn-by-turn directions.';
    }
  } catch {
    $('route-info').textContent = 'The map could not load. Use Open in Google Maps.';
  }
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
  $('install-btn').addEventListener('click', installApp);
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
    const ph = e.target.closest('[data-photo]');
    if (ph) { showPhoto(ph.dataset.photo, ph.dataset.name); return; }
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
    else if (t.dataset.rsub) showTab(t.dataset.rsub);
    else if (t.dataset.isub) { S.isub = t.dataset.isub; S.ifilter = 'all'; renderInquiries(); }
    else if (t.dataset.istatus) setInquiryStatus(t.dataset.id, t.dataset.istatus);
    else if (t.dataset.idelete) deleteInquiry(t.dataset.idelete);
    else if (t.dataset.purge) purgeOld(t.dataset.purge);
    else if (t.dataset.hfilter) { S.hf = t.dataset.hfilter; S.hlimit = 30; renderHistory(); }
    else if (t.dataset.hmore) { S.hlimit += 30; renderHistory(); }
    else if (t.dataset.status) setStatus(t.dataset.id, t.dataset.status);
    else if (t.dataset.cancelOrder) cancelOrder(t.dataset.cancelOrder);
    else if (t.dataset.delOrder) deleteOrder(t.dataset.delOrder);
    else if (t.dataset.push) togglePush();
    else if (t.dataset.sound) {
      S.sound = !S.sound;
      try { localStorage.setItem('ar_sound', S.sound ? '1' : '0'); } catch { /* ignore */ }
      if (S.sound) beep(S.tab === 'inquiries' ? 'inquiry' : 'order');
      if (S.tab === 'inquiries') renderInquiries(); else renderOrders();
    }
    else if (t.dataset.addopt) openDialog('options', null, { menu_item_id: t.dataset.addopt, option_type: 'flavor' });
    else if (t.dataset.new) openDialog(S.tab, null);
    else if (t.dataset.edit) openDialog(S.tab, currentRows.find((r) => r.id === t.dataset.edit));
    else if (t.dataset.delete) deleteRow(S.tab, t.dataset.delete);
    else if (t.dataset.quickprice) quickPrice(t.dataset.quickprice, t.closest('td'));
    else if (t.dataset.quickstock) quickStock(t.dataset.quickstock, t.closest('td'));
    else if (t.dataset.qpCancel) renderResource(S.tab);
    else if (t.id === 'd-here') {
      if (!navigator.geolocation) { toast('This browser cannot share its location.', 'error'); return; }
      navigator.geolocation.getCurrentPosition((p) => { $('d-lat').value = p.coords.latitude.toFixed(6); $('d-lng').value = p.coords.longitude.toFixed(6); toast('Location filled in. Press Save to keep it.'); }, () => toast('Could not get the location. Paste the numbers from Google Maps instead.', 'error'), { enableHighAccuracy: true, timeout: 12000 });
    }
    else if (t.dataset.route) showRoute(t.dataset.route);
    else if (t.dataset.staffToggle) setStaff(t.dataset.staffToggle, t.dataset.role, t.dataset.active !== 'true');
  });
  $('st-panel').addEventListener('pointerdown', startRowDrag);
  $('st-panel').addEventListener('input', (e) => {
    if (e.target.id === 'd-lat') onDeliveryPaste(e.target);
    if (e.target.closest?.('#delivery-form') && S.del) {
      const c = { ...S.del }; ['base_fee', 'base_km', 'per_km_fee', 'max_km'].forEach((k) => { const v = Number(String($(`d-${k}`)?.value).replace(',', '.')); if (Number.isFinite(v)) c[k] = v; });
      const ex = $('d-examples'); if (ex) ex.innerHTML = delExamples(c);
    }
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
    if (e.target.id === 'r-page') { S.rpage = e.target.value; renderResource(S.tab); }
    if (e.target.id === 'r-venue') { S.rvenue = e.target.value; renderResource(S.tab); }
    if (e.target.id === 'r-stock') { S.rstock = e.target.value; renderResource(S.tab); }
    if (e.target.id === 'r-active') { S.ractive = e.target.value; renderResource(S.tab); }
    if (e.target.id === 'r-xprice') { S.rxprice = e.target.value; renderResource(S.tab); }
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
    if (e.target.id === 'delivery-form') { e.preventDefault(); await onSaveDelivery(); return; }
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
