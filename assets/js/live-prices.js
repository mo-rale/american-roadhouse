// Keeps prices on the public pages (menu, rooms, home) in sync with the database.
// Markup contract:
//   data-live-items="<menu item id>|<id>|..."  data-live-fmt="S {0} · M {1}"   (menu prices)
//   data-live-room="<room rate id>"            data-live-fmt="{0} / night"      (room prices)
// The price written in the HTML stays as the fallback if the database cannot be reached.
// A menu row whose items were hidden or deleted by staff is hidden; sold-out items say "Sold out".
import { supabase, isConfigured, debounce } from './shop-common.js';

const money = (n) => `₱${Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2 })}`;
const numberIn = (text) => Number(String(text).replace(/[^0-9.]/g, '')) || 0;

function apply(items, rooms) {
  // an item with a stock number of 0 counts as sold out
  const itemMap = new Map(items.filter((i) => i.is_visible)
    .map((i) => [i.id, { ...i, is_available: i.is_available && (i.stock == null || i.stock > 0) }]));
  document.querySelectorAll('[data-live-items]').forEach((el) => {
    const found = el.dataset.liveItems.split('|').map((id) => itemMap.get(id));
    const row = el.closest('.menu-item');
    if (found.every((f) => !f)) {            // hidden or removed by staff
      if (items.length && row) row.hidden = true;
      return;
    }
    if (row) row.hidden = false;
    const fmt = el.dataset.liveFmt || '{0}';
    const part = (f) => (!f ? '&mdash;' : !f.is_available ? 'Sold out' : f.price == null ? 'Ask for today&rsquo;s price' : money(f.price));
    el.innerHTML = found.every((f) => f && !f.is_available)
      ? 'Sold out'
      : fmt.replace(/\{(\d)\}/g, (_, i) => part(found[Number(i)]));
  });

  const roomMap = new Map(rooms.map((r) => [r.id, r]));
  document.querySelectorAll('[data-live-room]').forEach((el) => {
    const room = roomMap.get(el.dataset.liveRoom);
    if (!room && !rooms.length) return;           // nothing came back: keep the page as written
    setRoomAvailable(el, Boolean(room && room.is_active));
    if (!room) return;
    const price = money(room.price_per_night);
    if (el.classList.contains('room-price')) {
      // keep the "/ night" unit and any struck-through list price (only while it is still higher)
      const unit = el.querySelector('.room-price-unit');
      const strike = el.querySelector('s');
      const keepStrike = strike && numberIn(strike.textContent) > Number(room.price_per_night);
      el.textContent = '';
      if (keepStrike) el.append(strike, ' ');
      el.append(`${price} `);
      if (unit) el.append(unit);
    } else {
      el.textContent = (el.dataset.liveFmt || '{0}').replace('{0}', price);
    }
  });
}

// A room switched off in the dashboard: grey out its button and say so; restore it when switched back on.
function setRoomAvailable(priceEl, available) {
  const btn = priceEl.closest('.room-card-footer')?.querySelector('a.btn');
  if (!btn) return;
  if (!btn.dataset.label) { btn.dataset.label = btn.textContent; btn.dataset.href = btn.getAttribute('href') || ''; }
  if (available) {
    btn.classList.remove('is-unavailable');
    btn.removeAttribute('aria-disabled');
    btn.removeAttribute('tabindex');
    if (btn.dataset.href) btn.setAttribute('href', btn.dataset.href);
    btn.textContent = btn.dataset.label;
  } else {
    btn.classList.add('is-unavailable');
    btn.setAttribute('aria-disabled', 'true');
    btn.setAttribute('tabindex', '-1');
    btn.removeAttribute('href');
    btn.textContent = 'Not available yet';
  }
}

async function load() {
  const [items, rooms] = await Promise.all([
    supabase.from('menu_items').select('id, price, is_available, is_visible, stock'),
    supabase.from('room_rates').select('id, price_per_night, is_active'),
  ]);
  if (items.error || rooms.error) return;      // keep the prices already on the page
  apply(items.data, rooms.data);
}

if (isConfigured) {
  load();
  const refresh = debounce(load, 400);
  supabase.channel('public-prices')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_items' }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'room_rates' }, refresh)
    .subscribe();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) load(); }, 60000);
}
