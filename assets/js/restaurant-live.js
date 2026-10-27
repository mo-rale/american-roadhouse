// Restaurant page: fills the Main and Roof Deck tabs from the database, so staff can edit them
// from the dashboard.
//   Main tab      -> restaurant_sections + restaurant_dishes (Restaurant / Page sections tabs)
//   Roof Deck tab -> the "Roofdeck Grill" items of the ordering menu (Menu tab)
// The HTML already on the page is the fallback if the database cannot be reached.
import { supabase, isConfigured, esc, safeImg, debounce } from './shop-common.js';

const money = (n) => `₱${Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2 })}`;
const ASK = 'Ask for today&rsquo;s price';

const row = ({ name, description, image_url, price, soldOut }) => `
  <div class="menu-item">
    ${image_url ? `<img src="${esc(safeImg(image_url))}" alt="${esc(name)}" loading="lazy">` : ''}
    <div style="flex:1;">
      <div class="menu-item-top"><h4 style="font-size:17px;">${esc(name)}</h4>
        <span class="menu-price">${soldOut ? 'Sold out' : price != null ? money(price) : ASK}</span></div>
      ${description ? `<p style="font-size:14px;color:#6b6357;margin-top:6px;">${esc(description)}</p>` : ''}
    </div>
  </div>`;

function renderMain(sections, dishes) {
  const root = document.getElementById('main-live');
  if (!root) return;
  if (!sections.length) {
    root.innerHTML = '<p class="dining-empty">Our menu is being updated. Please check back soon.</p>';
    return;
  }
  const bySection = new Map();
  dishes.forEach((d) => { if (!bySection.has(d.section_id)) bySection.set(d.section_id, []); bySection.get(d.section_id).push(d); });
  const pad = (n) => String(n).padStart(2, '0');
  const rail = sections.map((s, i) => `<li><a href="#cat-${esc(s.id)}"><span class="dining-num">${pad(i + 1)}</span>${esc(s.name)}</a></li>`).join('');
  const blocks = sections.map((s, i) => {
    const list = bySection.get(s.id) || [];
    return `<section class="dining-cat" id="cat-${esc(s.id)}" aria-labelledby="h-${esc(s.id)}">
      <div class="dining-cat-head"><span class="dining-num">${pad(i + 1)}</span><h3 id="h-${esc(s.id)}">${esc(s.name)}</h3></div>
      ${list.length ? list.map(row).join('') : '<p class="dining-empty">Ask your server for today&rsquo;s selection.</p>'}
    </section>`;
  }).join('');
  root.innerHTML = `<ol class="dining-rail" aria-label="Menu categories">${rail}</ol>${blocks}`;
}

function renderRoof(items) {
  const root = document.getElementById('roof-live');
  if (!root) return;
  root.innerHTML = `<section class="dining-cat" aria-labelledby="h-grill">
    <div class="dining-cat-head"><span class="dining-num">&#9679;</span><h3 id="h-grill">Roof Deck Grill</h3></div>
    ${items.length ? items.map((i) => row({ name: i.name, description: i.description, image_url: i.image_url, price: i.price, soldOut: !i.is_available })).join('')
      : '<p class="dining-empty">Ask your server for today&rsquo;s selection.</p>'}
  </section>`;
}

async function load() {
  const [secs, dishes, grill] = await Promise.all([
    supabase.from('restaurant_sections').select('id, name, sort_order').eq('is_visible', true).order('sort_order').order('name'),
    supabase.from('restaurant_dishes').select('id, section_id, name, description, price, image_url, sort_order').eq('is_visible', true).order('sort_order').order('name'),
    supabase.from('menu_items').select('id, name, description, price, image_url, is_available, sort_order, categories!inner(slug)')
      .eq('categories.slug', 'roofdeck-grill').eq('is_visible', true).order('sort_order').order('name'),
  ]);
  if (!secs.error && !dishes.error) renderMain(secs.data, dishes.data);   // otherwise keep the page as written
  if (!grill.error) renderRoof(grill.data);
}

if (isConfigured) {
  load();
  const refresh = debounce(load, 400);
  let ch = supabase.channel('restaurant-page');
  for (const table of ['restaurant_sections', 'restaurant_dishes', 'menu_items', 'categories']) {
    ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, refresh);
  }
  ch.subscribe();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) load(); }, 60000);
}
