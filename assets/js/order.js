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
// Same structure as the Restaurant page: a Main venue (sections in the order staff set) and a Roof Deck venue.
const ROOF_SLUGS = ['roofdeck-grill', 'lemon-drinks'];
const isOrderable = (it) => it.price != null && it.is_available;

async function loadCatalog({ silent = false } = {}) {
  const root = $('menu-root');
  try {
    const [cats, items, secs, dishes] = await Promise.all([
      supabase.from('categories').select('*').eq('is_visible', true).order('sort_order').order('name'),
      supabase.from('menu_items').select('*').eq('is_visible', true).order('sort_order').order('name'),
      supabase.from('restaurant_sections').select('id, name, sort_order').eq('is_visible', true).order('sort_order').order('name'),
      supabase.from('restaurant_dishes').select('id, section_id, name, description, price, image_url, sort_order').eq('is_visible', true).order('sort_order').order('name'),
    ]);
    if (cats.error) throw cats.error;
    if (items.error) throw items.error;
    // The Restaurant page tables are optional here: if they cannot be read, only the menu items are shown.
    const hasRestaurant = !secs.error && !dishes.error;

    state.categories = cats.data;
    const visibleCats = new Set(cats.data.map((c) => c.id));
    const menuItems = items.data.filter((i) => visibleCats.has(i.category_id))
      .map((i) => ({ ...i, price: Number(i.price), is_available: Boolean(i.is_available) }));
    const dishToItem = (d) => ({ ...d, price: d.price == null ? null : Number(d.price), is_available: d.price != null });

    const main = hasRestaurant
      ? secs.data.map((s) => ({ id: s.id, title: s.name, items: dishes.data.filter((d) => d.section_id === s.id).map(dishToItem) }))
      : [];
    const venues = { main, roofdeck: [] };
    for (const c of cats.data) {
      const list = menuItems.filter((i) => i.category_id === c.id);
      if (!list.length) continue;
      (ROOF_SLUGS.includes(c.slug) ? venues.roofdeck : venues.main).push({ id: c.id, title: c.name, items: list });
    }
    state.venues = venues;
    state.items = new Map([...venues.main, ...venues.roofdeck].flatMap((s) => s.items).map((i) => [i.id, i]));
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

// Drop cart lines whose item was hidden, removed, unpriced, or sold out.
function reconcileCart() {
  let removed = 0;
  for (const id of [...state.cart.keys()]) {
    const it = state.items.get(id);
    if (!it || !isOrderable(it)) { state.cart.delete(id); removed++; }
  }
  if (removed) { saveCart(); toast('Some items in your cart are no longer available and were removed.', 'error'); }
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
    <button type="button" data-action="inc" data-id="${esc(it.id)}" aria-label="Add one ${esc(it.name)}" ${q >= 50 ? 'disabled' : ''}>+</button></div>`;
}

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
            <div class="dish-foot"><span class="price">${it.price != null ? peso(it.price) : 'Ask for today&rsquo;s price'}</span><span class="controls">${dishControls(it)}</span></div>
          </div>
        </article>`).join('')}
      </div>` : '<p class="empty-sec">Ask your server for today&rsquo;s selection.</p>'}
    </section>`).join('');
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
        <button type="button" data-action="inc" data-id="${esc(it.id)}" aria-label="Add one ${esc(it.name)}" ${qty >= 50 ? 'disabled' : ''}>+</button>
      </div>
      <button type="button" class="btn-xs danger" data-action="remove" data-id="${esc(it.id)}" style="justify-self:end;" aria-label="Remove ${esc(it.name)} from cart">Remove</button>
    </div>`).join('');

  const sub = localSubtotal();
  const q = { subtotal: sub, total: sub };
  $('t-subtotal').textContent = peso(q.subtotal);
  $('t-total').textContent = peso(q.total);

  const fab = $('cart-fab');
  fab.hidden = !lines.length || !!state.confirmId;
  $('fab-count').textContent = `View order · ${count} item${count === 1 ? '' : 's'}`;
  $('fab-total').textContent = peso(q.total);
}

function setQty(id, qty) {
  const it = state.items.get(id);
  if (!it || !it.is_available) return;
  if (qty <= 0) state.cart.delete(id); else state.cart.set(id, Math.min(50, qty));
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
    const { data, error } = await supabase.rpc('place_order', {
      p_customer_name: form.name.value,
      p_phone: form.phone.value,
      p_email: form.email.value,
      p_order_type: form.order_type.value,
      p_room_number: form.order_type.value === 'room_delivery' ? form.room_number.value : '',
      p_notes: form.notes.value,
      p_discount_code: '',
      p_items: cartPayload(),
    });
    if (error) throw error;
    state.cart.clear(); saveCart();
    renderCart();
    closeCart();
    await showConfirmation(data.order_id);
    subscribeMyOrders(session.user.id);
    loadMyOrders();
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
  const where = o.order_type === 'room_delivery' ? `${TYPE_LABEL[o.order_type]} · Room ${esc(o.room_number)}` : TYPE_LABEL[o.order_type];
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

async function loadMyOrders() {
  const box = $('my-orders');
  try {
    const { data: sess } = await supabase.auth.getSession();
    if (!sess.session) return;
    const { data, error } = await supabase.from('orders').select('id, order_number, status, total, created_at')
      .order('created_at', { ascending: false }).limit(5);
    if (error) throw error;
    box.hidden = data.length === 0;
    $('my-orders-list').innerHTML = data.map((o) => `
      <div class="my-order"><span class="num">#${esc(o.order_number)}</span>
        <span>${fmtDate(o.created_at)}</span><span class="price">${peso(o.total)}</span>
        <span class="st st-${esc(o.status)}">${STATUS_LABEL[o.status]}</span></div>`).join('');
  } catch { box.hidden = true; }
}

const onMyOrderChange = debounce(async () => {
  loadMyOrders();
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
    if (e.target.name === 'order_type') $('room-field').hidden = e.target.value !== 'room_delivery';
  });
  form.addEventListener('input', (e) => {
    const f = e.target.closest('.field');
    if (f?.classList.contains('invalid')) f.classList.remove('invalid');
  });

  $('cart-fab').addEventListener('click', openCart);
  $('cart-close').addEventListener('click', closeCart);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCart(); });

  await loadCatalog();

  // Live price/menu updates: realtime, plus a refresh on focus and every minute as a safety net.
  const refresh = debounce(() => loadCatalog({ silent: true }), 400);
  state.channels.push(
    supabase.channel('catalog')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_items' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'categories' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'restaurant_sections' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'restaurant_dishes' }, refresh)
      .subscribe()
  );
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 60000);

  const { data } = await supabase.auth.getSession();
  if (data.session) { subscribeMyOrders(data.session.user.id); loadMyOrders(); }
  // Safety net for the order status shown after checkout.
  setInterval(() => { if (state.confirmId && !document.hidden) onMyOrderChange(); }, 20000);
}

init();
