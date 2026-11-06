// Customer ordering page: live menu, cart, checkout, confirmation.
import {
  supabase, isConfigured, peso, esc, safeImg, toast, debounce, friendlyError,
  fmtDate, STATUS_LABEL, TYPE_LABEL,
} from './shop-common.js';

const $ = (id) => document.getElementById(id);
const CART_KEY = 'ar_cart_v1';
const STEPS = ['pending', 'preparing', 'ready', 'completed'];

const state = {
  categories: [],
  items: new Map(),           // every orderable or listed item, by id
  venues: { main: [], roofdeck: [] },
  venue: 'main',              // Main is the default, as on the Restaurant page
  cart: new Map(),            // item id -> qty
  loaded: false,
  confirmId: null,
  channels: [],
  cfg: null,                  // delivery fee settings
  pin: null,                  // { lat, lng, km, fee } for the delivery pin
};

/* ---------- cart persistence ---------- */
function loadCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    raw.forEach(([id, q]) => { if (typeof id === 'string' && q >= 1 && q <= 50) state.cart.set(id, q | 0); });
  } catch { /* storage unavailable or corrupt: start empty */ }
}
function saveCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify([...state.cart])); } catch { /* ignore */ }
}

/* ---------- catalog ---------- */
// Same structure as the Restaurant page: a Main venue and a Roof Deck venue, each a list of sections.
// Everything comes from one menu (categories + menu_items), the same list staff edit in the dashboard.
const LOW_STOCK = 5;
const isOrderable = (it) => it.price != null && it.is_available;      // is_available already accounts for stock
const maxQty = (it) => Math.min(50, it.stock ?? 50);

async function loadCatalog({ silent = false } = {}) {
  const root = $('menu-root');
  try {
    const [cats, items] = await Promise.all([
      supabase.from('categories').select('*').eq('is_visible', true).order('sort_order').order('name'),
      supabase.from('menu_items').select('*').eq('is_visible', true).order('sort_order').order('name'),
    ]);
    if (cats.error) throw cats.error;
    if (items.error) throw items.error;

    state.categories = cats.data;
    const visibleCats = new Set(cats.data.map((c) => c.id));
    const list = items.data.filter((i) => visibleCats.has(i.category_id)).map((i) => ({
      ...i,
      price: i.price == null ? null : Number(i.price),
      stock: i.stock == null ? null : Number(i.stock),
      is_available: Boolean(i.is_available) && (i.stock == null || i.stock > 0),
    }));

    const venues = { main: [], roofdeck: [] };
    for (const c of cats.data) {
      const sectionItems = list.filter((i) => i.category_id === c.id);
      // Main lists every section (empty ones say "ask your server"); Roof Deck only lists sections that have items.
      if (c.venue === 'main' || sectionItems.length) venues[c.venue]?.push({ id: c.id, title: c.name, items: sectionItems });
    }
    state.venues = venues;
    state.items = new Map(list.map((i) => [i.id, i]));
    state.loaded = true;
    $('banner').innerHTML = '';
    reconcileCart();
    renderMenu();
    renderCart();
  } catch (err) {
    if (silent && state.loaded) return;     // keep showing the last good menu
    root.setAttribute('aria-busy', 'false');
    root.innerHTML = `<div class="banner error">We couldn&rsquo;t load the menu. ${esc(friendlyError(err))}
      <button type="button" class="btn btn-outline btn-sm" id="retry-menu" style="margin-left:8px;">Try again</button></div>`;
    $('retry-menu')?.addEventListener('click', () => { root.setAttribute('aria-busy', 'true'); loadCatalog(); });
  }
}

// Drop cart lines whose item was hidden, removed, unpriced or sold out, and trim quantities to the stock left.
function reconcileCart() {
  let changed = 0;
  for (const [id, qty] of [...state.cart]) {
    const it = state.items.get(id);
    if (!it || !isOrderable(it)) { state.cart.delete(id); changed++; }
    else if (qty > maxQty(it)) { state.cart.set(id, maxQty(it)); changed++; }
  }
  if (changed) { saveCart(); toast('Your cart was updated because some items are no longer available in that quantity.', 'error'); }
}

function renderVenueTabs() {
  document.querySelectorAll('#venue-tabs [data-venue]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.venue === state.venue)));
}

// Quick links that scroll to a section of the current venue.
function renderChips(sections) {
  const tabs = $('cat-tabs');
  tabs.innerHTML = sections.map((s) => `<button type="button" data-jump="sec-${esc(s.id)}">${esc(s.title)}</button>`).join('');
  tabs.hidden = sections.length < 2;
}

function dishControls(it) {
  if (it.price == null) return '<span class="badge">Ask your server</span>';
  if (!it.is_available) return '<span class="badge bad">Sold out</span>';
  const q = state.cart.get(it.id) || 0;
  if (!q) return `<button type="button" class="btn btn-primary btn-add" data-action="add" data-id="${esc(it.id)}">Add</button>`;
  return `<div class="qty" role="group" aria-label="Quantity of ${esc(it.name)}">
    <button type="button" data-action="dec" data-id="${esc(it.id)}" aria-label="Remove one ${esc(it.name)}">&minus;</button>
    <output aria-live="polite">${q}</output>
    <button type="button" data-action="inc" data-id="${esc(it.id)}" aria-label="Add one ${esc(it.name)}" ${q >= maxQty(it) ? 'disabled' : ''}>+</button></div>`;
}

const priceLine = (it) => {
  const price = it.price != null ? peso(it.price) : 'Ask for today&rsquo;s price';
  const low = it.price != null && it.is_available && it.stock != null && it.stock <= LOW_STOCK
    ? ` <span class="stock-note">Only ${it.stock} left</span>` : '';
  return `<span class="price">${price}</span>${low}`;
};

function renderMenu() {
  const root = $('menu-root');
  root.setAttribute('aria-busy', 'false');
  const sections = state.venues[state.venue];
  renderVenueTabs();
  renderChips(sections);

  if (!sections.length) {
    root.innerHTML = '<div class="empty"><strong>The menu is being updated</strong>No dishes are available to order right now. Please check back soon or call 0915 875 4860.</div>';
    return;
  }
  const noneOrderableHere = !sections.some((s) => s.items.some(isOrderable));
  const note = noneOrderableHere && state.venue === 'main' && state.venues.roofdeck.length
    ? `<div class="banner info">Online prices for these dishes aren&rsquo;t set yet, so please ask your server. You can
        <button type="button" class="link-btn" data-venue="roofdeck">order from the Roof Deck menu</button> right now.</div>`
    : '';
  root.innerHTML = note + sections.map((s) => `
    <section class="cat-section" id="sec-${esc(s.id)}" aria-labelledby="h-${esc(s.id)}">
      <h2 id="h-${esc(s.id)}">${esc(s.title)}</h2>
      ${s.items.length ? `<div class="dish-grid">${s.items.map((it) => `
        <article class="dish ${it.price != null && !it.is_available ? 'sold-out' : ''}" data-id="${esc(it.id)}">
          ${it.image_url ? `<img src="${esc(safeImg(it.image_url))}" alt="${esc(it.name)}" loading="lazy" width="96" height="96">` : ''}
          <div class="dish-body">
            <h3>${esc(it.name)}</h3>
            ${it.description ? `<p>${esc(it.description)}</p>` : ''}
            <div class="dish-foot"><span class="dish-price">${priceLine(it)}</span><span class="controls">${dishControls(it)}</span></div>
          </div>
        </article>`).join('')}
      </div>` : '<p class="empty-sec">Ask your server for today&rsquo;s selection.</p>'}
    </section>`).join('');
}

/* ---------- delivery fee ---------- */
// Same maths as place_order in the database (which is the one that counts): base fee for the first km, then per km, rounded up.
const isDelivery = () => document.querySelector('input[name="order_type"]:checked')?.value === 'delivery';
const cfgReady = () => Boolean(state.cfg && state.cfg.store_lat != null && state.cfg.store_lng != null);
function distanceKm(lat, lng) {
  const c = state.cfg, R = 6371, rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat - c.store_lat) / 2) ** 2 + Math.cos(rad(c.store_lat)) * Math.cos(rad(lat)) * Math.sin(rad(lng - c.store_lng) / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a)) * Number(c.road_factor);
}
const feeForKm = (km) => Math.ceil(Number(state.cfg.base_fee) + Math.max(0, km - Number(state.cfg.base_km)) * Number(state.cfg.per_km_fee));
// null = not known yet (no pin); 0 = no fee
function deliveryFee() {
  if (!isDelivery() || !cfgReady()) return 0;
  return state.pin ? state.pin.fee : null;
}
async function loadDeliveryCfg() {
  try {
    const { data } = await supabase.from('delivery_settings').select('*').eq('id', 1).maybeSingle();
    state.cfg = data || null;
  } catch { state.cfg = null; }
}
const pinMap = { map: null, marker: null, loading: null };
function setPin(lat, lng) {
  const st = $('pin-status');
  if (!cfgReady()) {
    state.pin = { lat, lng, km: null, fee: 0 };
    st.textContent = 'Location pinned. Our team will confirm the delivery fee.'; st.className = 'pin-status ok';
  } else {
    const km = distanceKm(lat, lng), max = Number(state.cfg.max_km);
    if (km > max) {
      state.pin = null;
      st.textContent = `That is about ${km.toFixed(1)} km away. We deliver up to ${max} km.`; st.className = 'pin-status bad';
    } else {
      state.pin = { lat, lng, km, fee: feeForKm(km) };
      st.textContent = `About ${km.toFixed(1)} km from us. Delivery fee ${peso(state.pin.fee)}.`; st.className = 'pin-status ok';
    }
  }
  $('pin-field').classList.remove('invalid');
  renderCart();
}

// The map is loaded only when a customer chooses Delivery (Leaflet + OpenStreetMap).
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (pinMap.loading) return pinMap.loading;
  pinMap.loading = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'; js.onload = resolve; js.onerror = reject;
    document.head.appendChild(js);
  });
  return pinMap.loading;
}
async function initPinMap() {
  if (pinMap.map) { setTimeout(() => pinMap.map.invalidateSize(), 50); return; }
  try { await loadLeaflet(); } catch { pinMap.loading = null; $('pin-status').textContent = 'The map could not load. Try "Use my current location".'; return; }
  if (pinMap.map) return;
  const L = window.L;
  const start = cfgReady() ? [Number(state.cfg.store_lat), Number(state.cfg.store_lng)] : [9.8, 124.55];
  const map = L.map('pin-map', { scrollWheelZoom: false }).setView(start, cfgReady() ? 14 : 12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  if (cfgReady()) {
    // the delivery area: straight-line radius = distance limit / road factor (the same maths the fee uses)
    const rf = Number(state.cfg.road_factor);
    const limit = L.circle(start, { radius: (Number(state.cfg.max_km) * 1000) / rf, color: '#B8893A', weight: 2, dashArray: '6 6', fillColor: '#B8893A', fillOpacity: 0.07, interactive: false }).addTo(map);
    if (Number(state.cfg.base_km) > 0 && Number(state.cfg.base_km) < Number(state.cfg.max_km) && Number(state.cfg.base_fee) > 0) {
      L.circle(start, { radius: (Number(state.cfg.base_km) * 1000) / rf, color: '#2f6b3a', weight: 1.5, fillColor: '#2f6b3a', fillOpacity: 0.08, interactive: false }).addTo(map);
    }
    L.circleMarker(start, { radius: 7, color: '#fff', weight: 2, fillColor: '#14110E', fillOpacity: 1, interactive: false }).bindTooltip('American Roadhouse', { permanent: true, direction: 'top', offset: [0, -6] }).addTo(map);
    map.fitBounds(limit.getBounds(), { padding: [8, 8] });
    const key = L.control({ position: 'bottomleft' });
    key.onAdd = () => {
      const d = L.DomUtil.create('div', 'pin-key');
      d.innerHTML = `<span class="k-out"></span> We deliver up to ${Number(state.cfg.max_km)} km${Number(state.cfg.base_fee) > 0 && Number(state.cfg.base_km) > 0 ? `<br><span class="k-in"></span> Standard fee within ${Number(state.cfg.base_km)} km` : ''}`;
      return d;
    };
    key.addTo(map);
  }
  const marker = L.marker(start, { draggable: true, opacity: 0 }).addTo(map);
  pinMap.map = map; pinMap.marker = marker;
  const place = (ll) => { marker.setLatLng(ll); marker.setOpacity(1); setPin(ll.lat, ll.lng); };
  map.on('click', (e) => place(e.latlng));
  marker.on('dragend', () => place(marker.getLatLng()));
  if (state.pin) { marker.setLatLng([state.pin.lat, state.pin.lng]); marker.setOpacity(1); }
  setTimeout(() => map.invalidateSize(), 50);
}
let autoTried = false;
// Picking Delivery (or opening the checkout with Delivery selected) pins the customer's current location once, automatically.
function autoLocate() {
  if (autoTried || state.pin || !isDelivery() || !state.cart.size || !navigator.geolocation) return;
  autoTried = true;
  useMyLocation({ auto: true });
}
function useMyLocation({ auto = false } = {}) {
  const st = $('pin-status');
  if (!navigator.geolocation) { st.textContent = 'Your browser cannot share its location. Tap the map instead.'; st.className = 'pin-status bad'; return; }
  st.textContent = 'Finding your location…'; st.className = 'pin-status';
  navigator.geolocation.getCurrentPosition(async (pos) => {
    await initPinMap();
    const { latitude: lat, longitude: lng } = pos.coords;
    if (pinMap.marker) { pinMap.marker.setLatLng([lat, lng]); pinMap.marker.setOpacity(1); pinMap.map.setView([lat, lng], 16); }
    setPin(lat, lng);
  }, () => {
    st.textContent = auto ? 'Location is off. Tap the map to drop the pin where we should deliver.' : 'We could not get your location. Tap the map to drop the pin instead.';
    st.className = auto ? 'pin-status' : 'pin-status bad';
  }, { enableHighAccuracy: true, timeout: 12000 });
}
function syncDeliveryUi() {
  const on = isDelivery();
  $('address-field').hidden = !on;
  $('pin-field').hidden = !on;
  if (on) initPinMap();
  renderCart();
  if (on) autoLocate();
}

/* ---------- cart ---------- */
function cartLines() {
  return [...state.cart].map(([id, qty]) => ({ it: state.items.get(id), qty })).filter((l) => l.it);
}
const localSubtotal = () => cartLines().reduce((s, l) => s + Number(l.it.price) * l.qty, 0);

function renderCart() {
  const lines = cartLines();
  const count = lines.reduce((s, l) => s + l.qty, 0);
  $('cart-empty').hidden = lines.length > 0;
  $('checkout').hidden = lines.length === 0;
  $('cart-lines').innerHTML = lines.map(({ it, qty }) => `
    <div class="cart-line">
      <div><div class="name">${esc(it.name)}</div><div class="unit">${peso(it.price)} each</div></div>
      <div class="price">${peso(Number(it.price) * qty)}</div>
      <div class="qty" role="group" aria-label="Quantity of ${esc(it.name)}">
        <button type="button" data-action="dec" data-id="${esc(it.id)}" aria-label="Remove one ${esc(it.name)}">&minus;</button>
        <output>${qty}</output>
        <button type="button" data-action="inc" data-id="${esc(it.id)}" aria-label="Add one ${esc(it.name)}" ${qty >= maxQty(it) ? 'disabled' : ''}>+</button>
      </div>
      <button type="button" class="btn-xs danger" data-action="remove" data-id="${esc(it.id)}" style="justify-self:end;" aria-label="Remove ${esc(it.name)} from cart">Remove</button>
    </div>`).join('');

  const sub = localSubtotal();
  const fee = deliveryFee();
  const q = { subtotal: sub, total: sub + (fee || 0) };
  $('t-subtotal').textContent = peso(q.subtotal);
  if (lines.length && !$('checkout').hidden) autoLocate();
  $('t-fee-row').hidden = !isDelivery() || !cfgReady();
  if (isDelivery() && cfgReady()) {
    $('t-fee').textContent = fee == null ? 'Pin your location' : peso(fee);
    $('t-km').textContent = state.pin?.km != null ? `(${state.pin.km.toFixed(1)} km)` : '';
  }
  $('t-total').textContent = peso(q.total);

  const fab = $('cart-fab');
  fab.hidden = !lines.length || !!state.confirmId;
  $('fab-count').textContent = `View order · ${count} item${count === 1 ? '' : 's'}`;
  $('fab-total').textContent = peso(q.total);
}

function setQty(id, qty) {
  const it = state.items.get(id);
  if (!it || !it.is_available) return;
  if (qty <= 0) state.cart.delete(id); else state.cart.set(id, Math.min(maxQty(it), qty));
  saveCart();
  const card = document.querySelector(`.dish[data-id="${CSS.escape(id)}"] .controls`);
  if (card) card.innerHTML = dishControls(it);
  renderCart();
}

function cartPayload() { return [...state.cart].map(([id, qty]) => ({ id, qty })); }

/* ---------- checkout ---------- */
const rules = {
  name: (v) => v.trim().length >= 2 && v.trim().length <= 80,
  phone: (v) => /^[0-9+() -]{7,20}$/.test(v.trim()),
  email: (v) => v.trim() === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim()),
};

function validateForm(form) {
  const type = form.order_type.value;
  const checks = [
    ['f-name', rules.name(form.name.value)],
    ['f-phone', rules.phone(form.phone.value)],
    ['f-email', rules.email(form.email.value)],
    ['f-room', type !== 'room_delivery' || form.room_number.value.trim().length > 0],
    ['f-address', type !== 'delivery' || form.delivery_address.value.trim().length >= 6],
    ['pin-gps', type !== 'delivery' || !cfgReady() || Boolean(state.pin)],
  ];
  let first = null;
  for (const [id, ok] of checks) {
    $(id).closest('.field').classList.toggle('invalid', !ok);
    $(id).setAttribute('aria-invalid', String(!ok));
    if (!ok && !first) first = $(id);
  }
  first?.focus();
  return !first;
}

async function ensureSession() {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session;
  const { data: anon, error } = await supabase.auth.signInAnonymously();
  if (error) {
    // Most likely cause: "Allow anonymous sign-ins" is off in Supabase (Authentication > Sign In / Providers).
    console.error('Guest sign-in failed:', error.message);
    throw new Error('Ordering is temporarily unavailable. Please call 0915 875 4860 to order.');
  }
  return anon.session;
}

async function onSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const errBox = $('form-error');
  errBox.classList.remove('show');
  if (!state.cart.size) return;
  if (!validateForm(form)) return;

  const btn = $('place-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Placing order…';
  try {
    const session = await ensureSession();
    const args = {
      p_customer_name: form.name.value,
      p_phone: form.phone.value,
      p_email: form.email.value,
      p_order_type: form.order_type.value,
      p_room_number: form.order_type.value === 'room_delivery' ? form.room_number.value : '',
      p_notes: form.notes.value,
      p_discount_code: '',
      p_items: cartPayload(),
    };
    // only delivery orders send the address, so other order types keep working with any version of the database function
    if (form.order_type.value === 'delivery') {
      args.p_delivery_address = form.delivery_address.value;
      if (state.pin) { args.p_delivery_lat = state.pin.lat; args.p_delivery_lng = state.pin.lng; }
    }
    const { data, error } = await supabase.rpc('place_order', args);
    if (error) throw error;
    state.cart.clear(); saveCart();
    renderCart();
    closeCart();
    await showConfirmation(data.order_id);
    subscribeMyOrders(session.user.id);
  } catch (err) {
    errBox.textContent = friendlyError(err);
    errBox.classList.add('show');
    if (/no longer available/i.test(errBox.textContent)) loadCatalog({ silent: true });
    errBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Place Order';
  }
}

/* ---------- confirmation + my orders ---------- */
async function fetchOrder(id) {
  const { data, error } = await supabase.from('orders').select('*, order_items(*)').eq('id', id).single();
  if (error) throw error;
  return data;
}

function stepsHtml(status) {
  if (status === 'cancelled') return '<p class="banner error" style="margin:18px 0;">This order was cancelled. Please call us at 0915 875 4860 if you have questions.</p>';
  const idx = STEPS.indexOf(status);
  return `<div class="status-steps" aria-label="Order progress">${STEPS
    .map((s, i) => `<span class="${i <= idx ? 'done' : ''}">${STATUS_LABEL[s]}</span>`).join('')}</div>`;
}

function confirmHtml(o) {
  const where = o.order_type === 'room_delivery' ? `${TYPE_LABEL[o.order_type]} · Room ${esc(o.room_number)}`
    : o.order_type === 'delivery' && o.delivery_address ? `${TYPE_LABEL[o.order_type]} · ${esc(o.delivery_address)}` : TYPE_LABEL[o.order_type];
  return `
    <div class="confirm-card">
      <div class="check"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg></div>
      <h2 style="font-size:28px;margin-bottom:6px;" tabindex="-1" id="confirm-title">Thank you, ${esc(o.customer_name.split(' ')[0])}!</h2>
      <p style="color:#6b6357;">Your order has been received. Order number</p>
      <div class="order-no">#${esc(o.order_number)}</div>
      <p style="margin-top:6px;"><span class="st st-${esc(o.status)}">${STATUS_LABEL[o.status]}</span> <span style="font-size:13px;color:#6b6357;">&middot; ${where}</span></p>
      ${stepsHtml(o.status)}
      <div class="confirm-lines">
        ${o.order_items.map((i) => `<div><span>${i.quantity} &times; ${esc(i.item_name)}</span><span class="price">${peso(i.line_total)}</span></div>`).join('')}
        ${Number(o.discount_total) > 0 ? `<div><span>Discount (${esc(o.discount_code)})</span><span class="price">−${peso(o.discount_total)}</span></div>` : ''}
        ${Number(o.delivery_fee) > 0 ? `<div><span>Delivery fee${o.delivery_km != null ? ` (${Number(o.delivery_km).toFixed(1)} km)` : ''}</span><span class="price">${peso(o.delivery_fee)}</span></div>` : ''}
        <div><strong>Total</strong><strong class="price">${peso(o.total)}</strong></div>
      </div>
      <p style="font-size:13px;color:#6b6357;margin-bottom:18px;">This page updates automatically as the kitchen works on your order. Payment is collected when you receive it.</p>
      <button type="button" class="btn btn-outline" id="order-more">Order something else</button>
    </div>`;
}

async function showConfirmation(orderId) {
  const o = await fetchOrder(orderId);
  state.confirmId = orderId;
  $('shop').hidden = true;
  $('cart-fab').hidden = true;
  const root = $('confirm-root');
  root.hidden = false;
  root.innerHTML = confirmHtml(o);
  $('order-more').addEventListener('click', () => {
    state.confirmId = null;
    root.hidden = true; root.innerHTML = '';
    $('shop').hidden = false;
    renderCart();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('confirm-title').focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// keeps the confirmation screen of the order just placed up to date
const onMyOrderChange = debounce(async () => {
  if (state.confirmId) {
    try {
      const o = await fetchOrder(state.confirmId);
      const root = $('confirm-root');
      if (!root.hidden) {
        root.innerHTML = confirmHtml(o);
        $('order-more').addEventListener('click', () => location.reload());
        toast(`Order #${o.order_number} is now ${STATUS_LABEL[o.status]}.`);
      }
    } catch { /* ignore transient errors */ }
  }
}, 200);

async function subscribeMyOrders(uid) {
  if (state.mySub === uid) return;
  state.mySub = uid;
  const { data } = await supabase.auth.getSession();
  if (data.session) supabase.realtime.setAuth(data.session.access_token);
  state.channels.push(
    supabase.channel(`my-orders-${uid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `user_id=eq.${uid}` }, onMyOrderChange)
      .subscribe()
  );
}

/* ---------- cart drawer (mobile) ---------- */
function openCart() { $('cart').classList.add('open'); document.body.style.overflow = 'hidden'; $('cart-close').focus(); }
function closeCart() { $('cart').classList.remove('open'); document.body.style.overflow = ''; }

/* ---------- init ---------- */
async function init() {
  if (!isConfigured) {
    $('shop').hidden = true;
    $('banner').innerHTML = '<div class="banner info">Online ordering isn&rsquo;t available yet. Please call <a href="tel:+639158754860"><strong>0915 875 4860</strong></a> to place an order, or see our <a href="restaurant.html#dining" style="text-decoration:underline;">menu</a>.</div>';
    console.warn('Supabase is not configured. Run `node scripts/build-env.mjs` after creating .env (see docs/SUPABASE_SETUP.md).');
    return;
  }
  loadCart();

  $('cat-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-jump]');
    if (b) document.getElementById(b.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  document.addEventListener('click', (e) => {
    const v = e.target.closest('[data-venue]');
    if (!v || !state.venues[v.dataset.venue]) return;
    state.venue = v.dataset.venue;
    renderMenu();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const { action, id } = b.dataset;
    const cur = state.cart.get(id) || 0;
    if (action === 'add') setQty(id, 1);
    if (action === 'inc') setQty(id, cur + 1);
    if (action === 'dec') setQty(id, cur - 1);
    if (action === 'remove') setQty(id, 0);
    // Controls are re-rendered; put keyboard focus back on the same control.
    document.querySelector(`[data-action="${action === 'add' ? 'inc' : action}"][data-id="${CSS.escape(id)}"]`)?.focus();
  });

  const form = $('checkout');
  form.addEventListener('submit', onSubmit);
  form.addEventListener('change', (e) => {
    if (e.target.name === 'order_type') {
      $('room-field').hidden = e.target.value !== 'room_delivery';
      syncDeliveryUi();
    }
  });
  $('pin-gps').addEventListener('click', useMyLocation);
  form.addEventListener('input', (e) => {
    const f = e.target.closest('.field');
    if (f?.classList.contains('invalid')) f.classList.remove('invalid');
  });

  $('cart-fab').addEventListener('click', openCart);
  $('cart-close').addEventListener('click', closeCart);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCart(); });

  await loadDeliveryCfg();
  await loadCatalog();
  syncDeliveryUi();

  // Live price/menu updates: realtime, plus a refresh on focus and every minute as a safety net.
  const refresh = debounce(() => loadCatalog({ silent: true }), 400);
  state.channels.push(
    supabase.channel('catalog')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_items' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'categories' }, refresh)
      .subscribe()
  );
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 60000);

  const { data } = await supabase.auth.getSession();
  if (data.session) subscribeMyOrders(data.session.user.id);
  // Safety net for the order status shown after checkout.
  setInterval(() => { if (state.confirmId && !document.hidden) onMyOrderChange(); }, 20000);
}

init();
