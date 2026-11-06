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
  cart: new Map(),            // line key -> { id, qty, extras: [extra ids] } (the key is the dish id plus its extras)
  extras: new Map(),          // add-on id -> { id, name, price, option_type: 'extra' }
  optionsByItem: new Map(),   // dish id -> size/flavor options, in order
  extrasOk: true,
  loaded: false,
  confirmId: null,
  channels: [],
  cfg: null,                  // delivery fee settings
  pin: null,                  // { lat, lng, km, fee } for the delivery pin
  edit: null,                 // { id, number, fee, orig: Map(itemId -> qty), stash, notes } while changing a placed order
  far: null,                  // km of a pin that is beyond the delivery limit (blocks ordering)
  placing: false,
  query: '',                  // what the customer typed in the dish search box
};

/* ---------- cart persistence ---------- */
function loadCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    raw.forEach(([k, v]) => {
      if (typeof k !== 'string') return;
      if (typeof v === 'number') { if (v >= 1 && v <= 50) state.cart.set(k, { id: k, qty: v | 0, extras: [] }); }       // an older saved cart
      else if (v && typeof v.id === 'string' && v.qty >= 1 && v.qty <= 50) state.cart.set(k, { id: v.id, qty: v.qty | 0, extras: Array.isArray(v.extras) ? v.extras.filter((x) => typeof x === 'string') : [] });
    });
  } catch { /* storage unavailable or corrupt: start empty */ }
}
function saveCart() {
  if (state.edit) return;       // an order being edited is not the saved cart
  try { localStorage.setItem(CART_KEY, JSON.stringify([...state.cart])); } catch { /* ignore */ }
}

/* ---------- catalog ---------- */
// Same structure as the Restaurant page: a Main venue and a Roof Deck venue, each a list of sections.
// Everything comes from one menu (categories + menu_items), the same list staff edit in the dashboard.
const LOW_STOCK = 5;
const isOrderable = (it) => it.price != null && it.is_available;      // is_available already accounts for stock
const maxQty = (it) => Math.min(50, it.stock ?? 50);
const lineKey = (id, extras) => (extras.length ? `${id}|${[...extras].sort().join(',')}` : id);
const itemQty = (id) => [...state.cart.values()].filter((l) => l.id === id).reduce((s, l) => s + l.qty, 0);
const itemOptions = (it) => [
  ...[...state.extras.values()],
  ...(state.optionsByItem.get(it.id) || []),
];
const selectedOptions = (it, ids) => ids.map((id) => itemOptions(it).find((x) => x.id === id)).filter(Boolean);
const optionUnit = (it, options) => {
  const size = options.find((x) => x.option_type === 'size');
  const additions = options.filter((x) => x.option_type !== 'size').reduce((s, x) => s + Number(x.price || 0), 0);
  return (size ? Number(size.price) : Number(it.price)) + additions;
};

async function loadCatalog({ silent = false } = {}) {
  const root = $('menu-root');
  try {
    const [cats, items, extras, options] = await Promise.all([
      supabase.from('categories').select('*').eq('is_visible', true).order('sort_order').order('name'),
      supabase.from('menu_items').select('*').eq('is_visible', true).order('sort_order').order('name'),
      supabase.from('menu_extras').select('*').eq('is_active', true).order('sort_order').order('name'),
      supabase.from('menu_options').select('*').eq('is_active', true).order('option_type').order('sort_order').order('name'),
    ]);
    if (cats.error) throw cats.error;
    if (items.error) throw items.error;

    state.categories = cats.data;
    // extras are optional: if they cannot be read (not set up yet) the menu still works without them
    state.extrasOk = !extras.error && !options.error;
    const exList = (extras.data || []).map((e) => ({ ...e, option_type: 'extra', price: Number(e.price) }));
    const optionList = (options.data || []).map((e) => ({ ...e, price: Number(e.price) }));
    state.extras = new Map(exList.map((e) => [e.id, e]));
    state.optionsByItem = new Map();
    optionList.forEach((e) => { if (!state.optionsByItem.has(e.menu_item_id)) state.optionsByItem.set(e.menu_item_id, []); state.optionsByItem.get(e.menu_item_id).push(e); });
    const visibleCats = new Set(cats.data.map((c) => c.id));
    const list = items.data.filter((i) => visibleCats.has(i.category_id)).map((i) => {
      const own = state.edit?.orig.get(i.id) || 0;                       // portions this order already holds are not "taken" from it
      const stock = i.stock == null ? null : Number(i.stock) + own;
      return { ...i, price: i.price == null ? null : Number(i.price), stock, is_available: Boolean(i.is_available) && (stock == null || stock > 0) };
    });

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

// Drop cart lines whose item was hidden, removed, unpriced or sold out, drop extras that are no longer offered,
// and trim quantities to the stock left (stock is shared by all of a dish's lines).
function reconcileCart() {
  let changed = 0;
  for (const [key, ln] of [...state.cart]) {
    const it = state.items.get(ln.id);
    if (!it || !isOrderable(it)) { state.cart.delete(key); changed++; continue; }
    if (!state.extrasOk) continue;
    const valid = new Set(itemOptions(it).map((x) => x.id));
    const ex = ln.extras.filter((x) => valid.has(x));
    if (ex.length !== ln.extras.length) {
      state.cart.delete(key);
      const nk = lineKey(ln.id, ex), cur = state.cart.get(nk);
      if (cur) cur.qty += ln.qty; else state.cart.set(nk, { ...ln, extras: ex });
      changed++;
    }
  }
  const used = new Map();
  for (const [key, ln] of [...state.cart]) {
    const room = Math.max(0, maxQty(state.items.get(ln.id)) - (used.get(ln.id) || 0));
    if (ln.qty > room) { ln.qty = room; changed++; }
    if (ln.qty <= 0) state.cart.delete(key); else used.set(ln.id, (used.get(ln.id) || 0) + ln.qty);
  }
  if (changed) { saveCart(); toast('Your cart was updated because some items or extras are no longer available.', 'error'); }
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
  if (itemOptions(it).length) {                      // dishes with options always go through the "customize" step
    const n = itemQty(it.id);
    return `${n ? `<span class="in-cart">${n} in order</span>` : ''}<button type="button" class="btn btn-primary btn-add" data-action="custom" data-id="${esc(it.id)}" ${n >= maxQty(it) ? 'disabled' : ''}>${n ? 'Add more' : 'Add'}</button>`;
  }
  const q = state.cart.get(it.id)?.qty || 0;
  if (!q) return `<button type="button" class="btn btn-primary btn-add" data-action="add" data-id="${esc(it.id)}">Add</button>`;
  return `<div class="qty" role="group" aria-label="Quantity of ${esc(it.name)}">
    <button type="button" data-action="dec" data-key="${esc(it.id)}" aria-label="Remove one ${esc(it.name)}">&minus;</button>
    <output aria-live="polite">${q}</output>
    <button type="button" data-action="inc" data-key="${esc(it.id)}" aria-label="Add one ${esc(it.name)}" ${q >= maxQty(it) ? 'disabled' : ''}>+</button></div>`;
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
  const words = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  const searching = words.length > 0;
  let sections = state.venues[state.venue];
  if (searching) {
    // search both menus at once: a dish matches when every word is in its name, its description or its section name
    const all = [...state.venues.main, ...state.venues.roofdeck.map((s) => ({ ...s, title: `${s.title} · Roof Deck` }))];
    sections = all.map((s) => ({ ...s, items: s.items.filter((it) => { const hay = `${it.name} ${it.description || ''} ${s.title}`.toLowerCase(); return words.every((w) => hay.includes(w)); }) }))
      .filter((s) => s.items.length);
  }
  $('venue-tabs').hidden = searching;
  renderVenueTabs();
  renderChips(sections);

  if (searching) {
    const n = sections.reduce((t, s) => t + s.items.length, 0);
    if (!n) {
      root.innerHTML = `<div class="empty"><strong>No dishes match &ldquo;${esc(state.query)}&rdquo;</strong>Try another word, like &ldquo;chicken&rdquo; or &ldquo;pasta&rdquo;, or
        <button type="button" class="link-btn" id="search-reset">clear the search</button>.</div>`;
      $('search-reset')?.addEventListener('click', clearSearch);
      return;
    }
    root.dataset.note = `${n} dish${n === 1 ? '' : 'es'} found for “${state.query}” in both menus.`;
  }

  if (!sections.length) {
    root.innerHTML = '<div class="empty"><strong>The menu is being updated</strong>No dishes are available to order right now. Please check back soon or call 0915 875 4860.</div>';
    return;
  }
  const noneOrderableHere = !sections.some((s) => s.items.some(isOrderable));
  const note = noneOrderableHere && state.venue === 'main' && state.venues.roofdeck.length
    ? `<div class="banner info">Online prices for these dishes aren&rsquo;t set yet, so please ask your server. You can
        <button type="button" class="link-btn" data-venue="roofdeck">order from the Roof Deck menu</button> right now.</div>`
    : '';
  root.innerHTML = note + (searching ? `<p class="search-note">${esc(root.dataset.note)}</p>` : '') + sections.map((s) => `
    <section class="cat-section" id="sec-${esc(s.id)}" aria-labelledby="h-${esc(s.id)}">
      <h2 id="h-${esc(s.id)}">${esc(s.title)}</h2>
      ${s.items.length ? `<div class="dish-grid">${s.items.map((it) => `
        <article class="dish ${it.price != null && !it.is_available ? 'sold-out' : ''}" data-id="${esc(it.id)}">
          ${it.image_url ? `<button type="button" class="dish-img" data-preview="${esc(it.id)}" aria-label="View photo of ${esc(it.name)}"><img src="${esc(safeImg(it.image_url))}" alt="" loading="lazy" width="96" height="96"></button>` : ''}
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
const pinMap = { map: null, marker: null, loading: null, limit: null };
// The map may be created while hidden (mobile drawer) or before the layout settles, so re-measure and show the whole delivery area.
function refitPinMap() {
  const go = () => {
    if (!pinMap.map) return;
    pinMap.map.invalidateSize();
    if (pinMap.limit) pinMap.map.fitBounds(pinMap.limit.getBounds(), { padding: [26, 26] });
  };
  setTimeout(go, 60); setTimeout(go, 400);
}
function setPin(lat, lng) {
  const st = $('pin-status');
  if (!cfgReady()) {
    state.pin = { lat, lng, km: null, fee: 0 }; state.far = null;
    st.textContent = 'Location pinned. Our team will confirm the delivery fee.'; st.className = 'pin-status ok';
  } else {
    const km = distanceKm(lat, lng), max = Number(state.cfg.max_km);
    if (km > max) {
      state.pin = null; state.far = km;
      st.textContent = `That is about ${km.toFixed(1)} km away. We deliver up to ${max} km.`; st.className = 'pin-status bad';
    } else {
      state.pin = { lat, lng, km, fee: feeForKm(km) }; state.far = null;
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
  if (pinMap.map) { refitPinMap(); return; }
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
      L.circle(start, { radius: (Number(state.cfg.base_km) * 1000) / rf, color: '#1f7a3a', weight: 3, fillColor: '#2f9e4f', fillOpacity: 0.2, interactive: false }).addTo(map);
      edgeLabel(L, map, start, (Number(state.cfg.base_km) * 1000) / rf, `${Number(state.cfg.base_km)} km`, '#1f7a3a');
    }
    edgeLabel(L, map, start, (Number(state.cfg.max_km) * 1000) / rf, `${Number(state.cfg.max_km)} km`, '#8a6320');
    L.circleMarker(start, { radius: 7, color: '#fff', weight: 2, fillColor: '#14110E', fillOpacity: 1, interactive: false }).bindTooltip('American Roadhouse', { permanent: true, direction: 'bottom', offset: [0, 6] }).addTo(map);
    pinMap.limit = limit;
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
  refitPinMap();
}
// A small distance label on the top edge of a circle.
function edgeLabel(L, map, centre, radiusM, text, colour) {
  const at = [centre[0] + radiusM / 111320, centre[1]];
  L.marker(at, { interactive: false, keyboard: false, icon: L.divIcon({ className: 'ring-label', html: `<span style="background:#fff;color:${colour};border:1.5px solid ${colour};">${text}</span>`, iconSize: [0, 0] }) }).addTo(map);
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
    if (pinMap.marker) { pinMap.marker.setLatLng([lat, lng]); pinMap.marker.setOpacity(1); }
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
  return [...state.cart].map(([key, ln]) => {
    const it = state.items.get(ln.id);
    if (!it) return null;
    const extras = selectedOptions(it, ln.extras);
    return { key, it, qty: ln.qty, extras, unit: optionUnit(it, extras) };
  }).filter(Boolean);
}
const localSubtotal = () => cartLines().reduce((s, l) => s + l.unit * l.qty, 0);

function renderCart() {
  const lines = cartLines();
  const count = lines.reduce((s, l) => s + l.qty, 0);
  $('cart-empty').hidden = lines.length > 0;
  $('checkout').hidden = lines.length === 0;
  $('cart-lines').innerHTML = lines.map(({ key, it, qty, extras, unit }) => `
    <div class="cart-line">
      <div><div class="name">${esc(it.name)}</div>
        ${extras.length ? `<div class="cart-extras">${extras.map((x) => `${x.option_type === 'size' ? '' : '+ '}${esc(x.name)} <span>(${x.option_type === 'size' ? peso(x.price) : `+${peso(x.price)}`})</span>`).join('<br>')}</div>` : ''}
        <div class="unit">${peso(unit)} each</div></div>
      <div class="price">${peso(unit * qty)}</div>
      <div class="qty" role="group" aria-label="Quantity of ${esc(it.name)}">
        <button type="button" data-action="dec" data-key="${esc(key)}" aria-label="Remove one ${esc(it.name)}">&minus;</button>
        <output>${qty}</output>
        <button type="button" data-action="inc" data-key="${esc(key)}" aria-label="Add one ${esc(it.name)}" ${itemQty(it.id) >= maxQty(it) ? 'disabled' : ''}>+</button>
      </div>
      <button type="button" class="btn-xs danger" data-action="remove" data-key="${esc(key)}" style="justify-self:end;" aria-label="Remove ${esc(it.name)} from cart">Remove</button>
    </div>`).join('');

  const sub = localSubtotal();
  const fee = state.edit ? state.edit.fee : deliveryFee();
  const q = { subtotal: sub, total: sub + (fee || 0) };
  $('t-subtotal').textContent = peso(q.subtotal);
  if (lines.length && !$('checkout').hidden) autoLocate();
  $('t-fee-row').hidden = state.edit ? !(state.edit.fee > 0) : (!isDelivery() || !cfgReady());
  if (state.edit) { $('t-fee').textContent = peso(state.edit.fee); $('t-km').textContent = ''; }
  else if (isDelivery() && cfgReady()) {
    $('t-fee').textContent = fee == null ? 'Pin your location' : peso(fee);
    $('t-km').textContent = state.pin?.km != null ? `(${state.pin.km.toFixed(1)} km)` : '';
  }
  $('t-total').textContent = peso(q.total);
  $('t-total2').textContent = peso(q.total);

  updatePlaceBtn();
  const fab = $('cart-fab');
  fab.hidden = !lines.length || !!state.confirmId;
  $('fab-count').textContent = `View order · ${count} item${count === 1 ? '' : 's'}`;
  $('fab-total').textContent = peso(q.total);
}

// Ordering is blocked while the pin is outside the delivery limit.
const outOfRange = () => !state.edit && isDelivery() && cfgReady() && state.far != null;
function updatePlaceBtn() {
  const btn = $('place-btn'), msg = $('range-msg');
  if (!btn || state.placing) return;
  const blocked = outOfRange();
  btn.disabled = blocked;
  btn.textContent = blocked ? 'Outside our delivery area' : state.edit ? 'Save changes' : 'Place Order';
  if (msg) {
    msg.hidden = !blocked;
    if (blocked) msg.textContent = `Your pin is about ${state.far.toFixed(1)} km away and we deliver up to ${Number(state.cfg.max_km)} km. Move the pin closer, or choose Dine in or call 0915 875 4860.`;
  }
}

function refreshCard(itemId) {
  const it = state.items.get(itemId);
  const card = document.querySelector(`.dish[data-id="${CSS.escape(itemId)}"] .controls`);
  if (it && card) card.innerHTML = dishControls(it);
}

// add portions of a dish (with the chosen extras) to the cart; the same dish with the same extras shares one line
function addLine(id, extras, qty) {
  const it = state.items.get(id);
  if (!it || !it.is_available) return 0;
  const add = Math.min(qty, maxQty(it) - itemQty(id));
  if (add <= 0) return 0;
  const key = lineKey(id, extras), cur = state.cart.get(key);
  if (cur) cur.qty += add; else state.cart.set(key, { id, qty: add, extras: [...extras].sort() });
  saveCart(); refreshCard(id); renderCart();
  return add;
}

function setQty(key, qty) {
  const ln = state.cart.get(key);
  if (!ln) return;
  const it = state.items.get(ln.id);
  if (!it || !it.is_available) return;
  if (qty <= 0) state.cart.delete(key);
  else ln.qty = Math.max(1, Math.min(qty, maxQty(it) - (itemQty(ln.id) - ln.qty)));
  saveCart(); refreshCard(ln.id); renderCart();
}

function cartPayload() { return [...state.cart.values()].map((l) => ({ id: l.id, qty: l.qty, extras: l.extras })); }

// the "customize" step for a dish that has paid extras
function openExtras(itemId) {
  const it = state.items.get(itemId);
  if (!it) return;
  const room = maxQty(it) - itemQty(itemId);
  if (room <= 0) { toast('You already have all the portions we have left of this dish.', 'error'); return; }
  const list = itemOptions(it);
  let qty = 1;
  $('ex-title').textContent = it.name;
  $('ex-base').textContent = `${peso(it.price)} base price. Choose a size, flavor, or extras.`;
  const groups = [['size', 'Size', 'radio'], ['flavor', 'Flavor', 'radio'], ['extra', 'Extras', 'checkbox']];
  $('ex-list').innerHTML = groups.map(([type, label, control]) => {
    const opts = list.filter((x) => (x.option_type || 'extra') === type);
    if (!opts.length) return '';
    return `<fieldset class="ex-group"><legend>${label}</legend>${opts.map((x) => `<label class="ex-opt"><input type="${control}" name="ex-${type}" value="${esc(x.id)}"><span>${esc(x.name)}</span><b>${type === 'size' ? peso(x.price) : `+${peso(x.price)}`}</b></label>`).join('')}</fieldset>`;
  }).join('');
  const chosen = () => [...$('ex-list').querySelectorAll('input:checked')].map((i) => i.value);
  const refresh = () => {
    const unit = optionUnit(it, chosen().map((id) => list.find((x) => x.id === id)).filter(Boolean));
    $('ex-q').textContent = qty;
    $('ex-dec').disabled = qty <= 1;
    $('ex-inc').disabled = qty >= room;
    $('ex-add').textContent = `Add to order · ${peso(unit * qty)}`;
  };
  const dlg = $('extras-dlg');
  $('ex-list').onchange = refresh;
  $('ex-dec').onclick = () => { qty = Math.max(1, qty - 1); refresh(); };
  $('ex-inc').onclick = () => { qty = Math.min(room, qty + 1); refresh(); };
  $('ex-cancel').onclick = () => dlg.close();
  $('ex-add').onclick = () => { addLine(itemId, chosen(), qty); dlg.close(); toast(`${it.name} added to your order.`); };
  dlg.onclick = (e) => { if (e.target === dlg) dlg.close(); };
  refresh();
  dlg.showModal();
  $('ex-add').focus();
}

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

// A short summary of what is about to be sent, so the customer can check it first.
function askConfirm(form) {
  const editing = Boolean(state.edit);
  const lines = cartLines();
  const fee = editing ? state.edit.fee : deliveryFee();
  const total = localSubtotal() + (fee || 0);
  const type = form.order_type.value;
  $('cf-title').textContent = editing ? `Save changes to order #${state.edit.number}?` : 'Place your order?';
  $('cf-sub').textContent = editing ? 'Your order will be updated for the kitchen.' : 'Please check your order before we send it to the kitchen.';
  $('cf-lines').innerHTML = lines.map(({ it, qty, extras, unit }) => `<div><span>${qty} &times; ${esc(it.name)}${extras.map((x) => `<small class="o-extra">+ ${esc(x.name)}</small>`).join('')}</span><span class="price">${peso(unit * qty)}</span></div>`).join('')
    + (fee ? `<div><span>Delivery fee</span><span class="price">${peso(fee)}</span></div>` : '');
  $('cf-total').textContent = peso(total);
  let where = '';
  if (!editing) {
    where = type === 'delivery' ? `Delivery to: ${form.delivery_address.value.trim()}`
      : type === 'room_delivery' ? `To your room: ${form.room_number.value.trim()}` : 'Dine in';
    where += ` · ${form.name.value.trim()} · ${form.phone.value.trim()}`;
  }
  $('cf-where').textContent = where;
  $('cf-yes').textContent = editing ? 'Yes, save changes' : 'Yes, place order';
  return new Promise((resolve) => {
    const dlg = $('confirm-dlg');
    let answer = false;
    const done = (v) => { answer = v; dlg.close(); };
    $('cf-yes').onclick = () => done(true);
    $('cf-no').onclick = () => done(false);
    dlg.onclick = (e) => { if (e.target === dlg) done(false); };
    dlg.onclose = () => resolve(answer);
    dlg.showModal();
    $('cf-yes').focus();
  });
}

async function onSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const errBox = $('form-error');
  errBox.classList.remove('show');
  if (!state.cart.size) return;
  if (state.edit) { if (await askConfirm(form)) await saveEdit(form); return; }
  if (outOfRange()) { updatePlaceBtn(); return; }
  if (!validateForm(form)) return;
  if (!(await askConfirm(form))) return;

  const btn = $('place-btn');
  state.placing = true;
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
    state.placing = false;
    btn.disabled = false;
    btn.textContent = 'Place Order';
    updatePlaceBtn();
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

const canEdit = (o) => ['pending', 'preparing'].includes(o.status);
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
        ${o.order_items.map((i) => `<div><span>${i.quantity} &times; ${esc(i.item_name)}${(i.extras || []).map((x) => `<small class="o-extra">+ ${esc(x.name)}</small>`).join('')}</span><span class="price">${peso(i.line_total)}</span></div>`).join('')}
        ${Number(o.discount_total) > 0 ? `<div><span>Discount (${esc(o.discount_code)})</span><span class="price">−${peso(o.discount_total)}</span></div>` : ''}
        ${Number(o.delivery_fee) > 0 ? `<div><span>Delivery fee${o.delivery_km != null ? ` (${Number(o.delivery_km).toFixed(1)} km)` : ''}</span><span class="price">${peso(o.delivery_fee)}</span></div>` : ''}
        <div><strong>Total</strong><strong class="price">${peso(o.total)}</strong></div>
      </div>
      <p style="font-size:13px;color:#6b6357;margin-bottom:18px;">This page updates automatically as the kitchen works on your order. You can change it until it is ready. Payment is collected when you receive it.</p>
      ${canEdit(o) ? '' : '<p class="confirm-locked">This order can no longer be changed online. Please call 0915 875 4860 if you need something.</p>'}
      <div class="confirm-actions">
        ${canEdit(o) ? '<button type="button" class="btn btn-primary" id="order-edit">Edit order</button>' : ''}
        <button type="button" class="btn btn-outline" id="order-more">Order something else</button>
      </div>
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

/* ---------- edit a placed order (until the kitchen marks it Ready) ---------- */
async function startEdit(orderId) {
  try {
    const o = await fetchOrder(orderId);
    if (!canEdit(o)) { toast(`Order #${o.order_number} is already ${STATUS_LABEL[o.status]}, so it can no longer be changed.`, 'error'); if (state.confirmId) showConfirmation(orderId); return; }
    const form = $('checkout');
    state.edit = {
      id: o.id, number: o.order_number, fee: Number(o.delivery_fee) || 0,
      orig: new Map(),
      stash: new Map(state.cart), notes: form.notes.value,
    };
    state.cart = new Map();
    o.order_items.filter((i) => i.menu_item_id).forEach((i) => {
      state.edit.orig.set(i.menu_item_id, (state.edit.orig.get(i.menu_item_id) || 0) + i.quantity);
      const ex = (i.extras || []).map((x) => x.id).filter(Boolean);
      const key = lineKey(i.menu_item_id, ex), cur = state.cart.get(key);
      if (cur) cur.qty += i.quantity; else state.cart.set(key, { id: i.menu_item_id, qty: i.quantity, extras: ex.sort() });
    });
    form.notes.value = o.notes || '';
    form.classList.add('editing');
    $('details-legend').textContent = 'NOTES';
    $('edit-text').textContent = `Editing order #${o.order_number}. Change your dishes, then save.`;
    $('edit-banner').hidden = false;
    state.confirmId = null;
    $('confirm-root').hidden = true; $('confirm-root').innerHTML = '';
    $('shop').hidden = false;
    $('my-orders').open && $('my-orders').close();
    await loadCatalog({ silent: true });          // recounts stock with this order's own portions, and trims anything that is gone
    renderCart();
    openCart();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    state.edit = null;
    toast(friendlyError(err), 'error');
  }
}

function endEdit() {
  const form = $('checkout');
  const e = state.edit;
  if (!e) return;
  state.edit = null;
  state.cart = e.stash;
  form.notes.value = e.notes;
  form.classList.remove('editing');
  $('details-legend').textContent = 'YOUR DETAILS';
  $('edit-banner').hidden = true;
  saveCart();
}

async function cancelEdit() {
  const id = state.edit?.id;
  endEdit();
  closeCart();
  await loadCatalog({ silent: true });
  renderCart();
  if (id) await showConfirmation(id);
}

async function saveEdit(form) {
  const errBox = $('form-error');
  const btn = $('place-btn');
  state.placing = true;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Saving…';
  try {
    await ensureSession();
    const id = state.edit.id, number = state.edit.number;
    const { error } = await supabase.rpc('update_order', { p_order_id: id, p_items: cartPayload(), p_notes: form.notes.value });
    if (error) throw error;
    endEdit();
    closeCart();
    await loadCatalog({ silent: true });
    renderCart();
    await showConfirmation(id);
    toast(`Order #${number} updated.`);
  } catch (err) {
    errBox.textContent = friendlyError(err);
    errBox.classList.add('show');
    if (/no longer available|so it can no longer be changed/i.test(errBox.textContent)) loadCatalog({ silent: true });
    errBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } finally {
    state.placing = false;
    btn.disabled = false;
    updatePlaceBtn();
  }
}

/* ---------- "Your orders": look up recent orders by phone number ---------- */
const fmtWhen = (iso) => new Date(iso).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function myOrderHtml(o) {
  const items = o.items || [];
  return `<article class="mo-order">
    <div class="mo-top"><span class="num">#${esc(o.order_number)}</span><span class="st st-${esc(o.status)}">${STATUS_LABEL[o.status] || esc(o.status)}</span></div>
    <div class="mo-meta">${esc(fmtWhen(o.created_at))} · ${TYPE_LABEL[o.order_type] || esc(o.order_type)}</div>
    ${stepsHtml(o.status)}
    <div class="mo-lines">
      ${items.map((i) => `<div><span>${i.qty} &times; ${esc(i.name)}${(i.extras || []).map((x) => `<small class="o-extra">+ ${esc(x.name)}</small>`).join('')}</span><span class="price">${peso(i.line_total)}</span></div>`).join('')}
      ${Number(o.discount_total) > 0 ? `<div><span>Discount</span><span class="price">−${peso(o.discount_total)}</span></div>` : ''}
      ${Number(o.delivery_fee) > 0 ? `<div><span>Delivery fee</span><span class="price">${peso(o.delivery_fee)}</span></div>` : ''}
      <div class="tot"><strong>Total</strong><strong class="price">${peso(o.total)}</strong></div>
    </div>
    ${o.mine && canEdit(o) ? `<button type="button" class="btn btn-outline btn-sm mo-edit" data-edit-order="${esc(o.id)}">Edit order</button>` : ''}
  </article>`;
}

async function onLookup(e) {
  e.preventDefault();
  const phone = $('mo-phone'), field = phone.closest('.field'), errBox = $('mo-error'), out = $('mo-results');
  errBox.classList.remove('show');
  const digits = phone.value.replace(/\D/g, '');
  const ok = /^[0-9+() -]{7,20}$/.test(phone.value.trim()) && digits.length >= 10;
  field.classList.toggle('invalid', !ok);
  if (!ok) { phone.focus(); return; }
  const btn = $('mo-go');
  btn.disabled = true; btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Looking…';
  out.innerHTML = '';
  try {
    await ensureSession();
    const { data, error } = await supabase.rpc('lookup_orders', { p_phone: phone.value });
    if (error) throw error;
    out.innerHTML = data?.length
      ? data.map(myOrderHtml).join('')
      : '<div class="empty"><strong>No orders found</strong>We could not find any orders from the last 30 days for that number. Check the number, or call 0915 875 4860.</div>';
  } catch (err) {
    errBox.textContent = friendlyError(err); errBox.classList.add('show');
  } finally {
    btn.disabled = false; btn.textContent = 'Show my orders';
  }
}

/* ---------- search the menu ---------- */
function setSearch(v) {
  state.query = v.trim().slice(0, 60);
  $('menu-q-clear').hidden = !state.query;
  renderMenu();
}
function clearSearch() {
  $('menu-q').value = '';
  setSearch('');
  $('menu-q').focus();
}

/* ---------- photo preview ---------- */
function openPreview(id) {
  const it = state.items.get(id);
  if (!it || !it.image_url) return;
  const dlg = $('photo-dlg');
  const img = $('photo-img');
  img.src = safeImg(it.image_url);
  img.alt = it.name;
  $('photo-name').textContent = it.name;
  $('photo-desc').textContent = it.description || '';
  $('photo-price').textContent = it.price != null ? peso(it.price) : 'Ask for today’s price';
  dlg.showModal();
  $('photo-close').focus();
}

/* ---------- cart drawer (mobile) ---------- */
function openCart() { $('cart').classList.add('open'); document.body.style.overflow = 'hidden'; $('cart-close').focus(); if (isDelivery()) refitPinMap(); }
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
    const { action, id, key } = b.dataset;
    if (action === 'custom') { openExtras(id); return; }
    if (action === 'add') { addLine(id, [], 1); document.querySelector(`[data-action="inc"][data-key="${CSS.escape(id)}"]`)?.focus(); return; }
    const cur = state.cart.get(key)?.qty || 0;
    if (action === 'inc') setQty(key, cur + 1);
    if (action === 'dec') setQty(key, cur - 1);
    if (action === 'remove') setQty(key, 0);
    // Controls are re-rendered; put keyboard focus back on the same control.
    document.querySelector(`[data-action="${action}"][data-key="${CSS.escape(key)}"]`)?.focus();
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
  $('menu-q').addEventListener('input', debounce((e) => setSearch(e.target.value), 140));
  $('menu-q').addEventListener('keydown', (e) => { if (e.key === 'Escape') clearSearch(); });
  $('menu-q-clear').addEventListener('click', clearSearch);
  // tapping a dish photo opens a larger preview; the X, the Close button, a tap outside or Escape closes it
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-preview]'); if (b) openPreview(b.dataset.preview); });
  $('confirm-root').addEventListener('click', (e) => { if (e.target.closest('#order-edit') && state.confirmId) startEdit(state.confirmId); });
  $('mo-results').addEventListener('click', (e) => { const b = e.target.closest('[data-edit-order]'); if (b) startEdit(b.dataset.editOrder); });
  $('edit-cancel').addEventListener('click', cancelEdit);
  $('photo-close').addEventListener('click', () => $('photo-dlg').close());
  $('photo-close2').addEventListener('click', () => $('photo-dlg').close());
  $('photo-dlg').addEventListener('click', (e) => { if (e.target === $('photo-dlg')) $('photo-dlg').close(); });
  $('my-orders-btn').addEventListener('click', () => { $('my-orders').showModal(); $('mo-phone').focus(); });
  $('mo-close').addEventListener('click', () => $('my-orders').close());
  $('my-orders').addEventListener('click', (e) => { if (e.target === $('my-orders')) $('my-orders').close(); });
  $('mo-form').addEventListener('submit', onLookup);
  $('mo-phone').addEventListener('input', () => $('mo-phone').closest('.field').classList.remove('invalid'));
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
