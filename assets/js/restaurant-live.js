// Restaurant page: fills the Main and Roof Deck tabs from the database, so staff can edit them
// from the dashboard's Menu and Menu sections tabs (the same menu the ordering page uses).
// The HTML already on the page is the fallback if the database cannot be reached.
import { supabase, isConfigured, esc, safeImg, debounce } from './shop-common.js';

const money = (n) => `₱${Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2 })}`;
const ASK = 'Ask for today&rsquo;s price';
const pad = (n) => String(n).padStart(2, '0');

const row = ({ name, description, image_url, price, soldOut }) => `
  <div class="menu-item">
    ${image_url ? `<img src="${esc(safeImg(image_url))}" alt="${esc(name)}" loading="lazy">` : ''}
    <div style="flex:1;">
      <div class="menu-item-top"><h4 style="font-size:17px;">${esc(name)}</h4>
        <span class="menu-price">${soldOut ? 'Sold out' : price != null ? money(price) : ASK}</span></div>
      ${description ? `<p style="font-size:14px;color:#6b6357;margin-top:6px;">${esc(description)}</p>` : ''}
    </div>
  </div>`;

const section = (s, marker) => `
  <section class="dining-cat" id="cat-${esc(s.id)}" aria-labelledby="h-${esc(s.id)}">
    <div class="dining-cat-head"><span class="dining-num">${marker}</span><h3 id="h-${esc(s.id)}">${esc(s.title)}</h3></div>
    ${s.items.length ? s.items.map(row).join('') : '<p class="dining-empty">Ask your server for today&rsquo;s selection.</p>'}
  </section>`;

function renderMain(sections) {
  const root = document.getElementById('main-live');
  if (!root) return;
  if (!sections.length) {
    root.innerHTML = '<p class="dining-empty">Our menu is being updated. Please check back soon.</p>';
    return;
  }
  const rail = sections.map((s, i) => `<li><a href="#cat-${esc(s.id)}"><span class="dining-num">${pad(i + 1)}</span>${esc(s.title)}</a></li>`).join('');
  root.innerHTML = `<ol class="dining-rail" aria-label="Menu categories">${rail}</ol>${sections.map((s, i) => section(s, pad(i + 1))).join('')}`;
}

function renderRoof(sections) {
  const root = document.getElementById('roof-live');
  if (!root) return;
  root.innerHTML = sections.length
    ? sections.map((s) => section(s, '&#9679;')).join('')
    : '<p class="dining-empty">Ask your server for today&rsquo;s selection.</p>';
}

async function load() {
  const [cats, items] = await Promise.all([
    supabase.from('categories').select('id, name, venue, sort_order').eq('is_visible', true).order('sort_order').order('name'),
    supabase.from('menu_items').select('id, category_id, name, description, price, image_url, is_available, stock, sort_order')
      .eq('is_visible', true).order('sort_order').order('name'),
  ]);
  if (cats.error || items.error) return;      // keep the page as written

  const list = items.data.map((i) => ({
    ...i,
    soldOut: !i.is_available || (i.stock != null && i.stock <= 0),
  }));
  const venues = { main: [], roofdeck: [] };
  for (const c of cats.data) {
    const sectionItems = list.filter((i) => i.category_id === c.id);
    // Main lists every section (empty ones say "ask your server"); Roof Deck only sections with items.
    if (c.venue === 'main' || sectionItems.length) venues[c.venue]?.push({ id: c.id, title: c.name, items: sectionItems });
  }
  renderMain(venues.main);
  renderRoof(venues.roofdeck);
}

if (isConfigured) {
  load();
  const refresh = debounce(load, 400);
  let ch = supabase.channel('restaurant-page');
  for (const table of ['menu_items', 'categories']) {
    ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, refresh);
  }
  ch.subscribe();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) load(); }, 60000);
}
