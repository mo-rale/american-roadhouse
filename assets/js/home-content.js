// Home page content managed in the staff dashboard (Website tab): texts and photos, the comfort cards,
// Places Near Me, the FAQ and the gallery preview. Everything already in index.html is the fallback if the
// database cannot be reached or a list is empty.
import { supabase, isConfigured, esc, safeImg } from './shop-common.js';

const ICONS = {
  bed: '<path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/>',
  dining: '<path d="M3 2v7c0 1.1.9 2 2 2h1a2 2 0 0 0 2-2V2"/><path d="M6 2v20"/><path d="M18 2c-2 2-3 4-3 8 0 3 1 4 3 4s3-1 3-4c0-4-1-6-3-8Z"/>',
  pin: '<path d="M21 10c0 6-9 12-9 12s-9-6-9-12a9 9 0 0 1 18 0Z"/><circle cx="12" cy="10" r="3"/>',
  people: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
  car: '<path d="M5 17h14v-5l-2-5H7l-2 5z"/><circle cx="8" cy="17" r="1.5"/><circle cx="16" cy="17" r="1.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
};

const list = (table, extra) => {
  let q = supabase.from(table).select('*').eq('is_visible', true);
  if (extra) q = extra(q);
  return q.order('sort_order').order('created_at').then((r) => (r.error ? [] : r.data || []), () => []);
};
const set = (id, html) => { const el = document.getElementById(id); if (el && html) el.innerHTML = html; };

async function init() {
  if (!isConfigured) return;

  // texts and photos
  supabase.from('site_content').select('key, value').then(({ data, error }) => {
    if (error || !data) return;
    const v = Object.fromEntries(data.map((r) => [r.key, r.value]));
    document.querySelectorAll('[data-cms]').forEach((el) => { if (v[el.dataset.cms]) el.textContent = v[el.dataset.cms]; });
    document.querySelectorAll('[data-cms-bg]').forEach((el) => {
      const u = v[el.dataset.cmsBg];
      if (u) el.style.backgroundImage = `url('${safeImg(u).replace(/'/g, '%27')}')`;
    });
  }, () => {});

  const [features, places, faqs, shots] = await Promise.all([
    list('home_features'),
    list('home_places'),
    list('home_faqs'),
    list('gallery_photos', (q) => q.eq('show_on_home', true).limit(8)),
  ]);

  set('home-features', features.map((f) => `<div class="feature-card">
        <div class="feature-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">${ICONS[f.icon] || ICONS.star}</svg></div>
        <h3 style="font-size:19px;margin-bottom:8px;">${esc(f.title)}</h3>
        <p style="color:#6b6357;font-size:14.5px;">${esc(f.body)}</p>
      </div>`).join(''));

  set('home-places', places.map((p) => {
    const body = `<img src="${esc(safeImg(p.image_url))}" alt="${esc(p.name)}" loading="lazy" style="height:190px;object-fit:cover;width:100%;">
        <div style="padding:20px;"><h4 style="font-size:16px;">${esc(p.name)}</h4>${p.distance ? `<p style="font-size:12.5px;color:var(--wood);font-weight:600;margin-top:6px;">${esc(p.distance)}</p>` : ''}${p.note ? `<p style="font-size:13.5px;color:#6b6357;margin-top:8px;">${esc(p.note)}</p>` : ''}${p.map_url ? '<p style="font-size:13px;margin-top:10px;font-weight:600;color:var(--wood);">View on map &rarr;</p>' : ''}</div>`;
    return p.map_url ? `<a class="card" href="${esc(p.map_url)}" target="_blank" rel="noopener" style="display:block;color:inherit;">${body}</a>` : `<div class="card">${body}</div>`;
  }).join(''));

  if (faqs.length) {
    set('home-faqs', faqs.map((q) => `<div class="faq-item">
        <button class="faq-question">${esc(q.question)}<span class="faq-icon">+</span></button>
        <div class="faq-answer"><p>${esc(q.answer)}</p></div>
      </div>`).join(''));
    if (window.initFaq) window.initFaq();
  }

  set('home-gallery', shots.map((p) => `<div class="gallery-item"><img src="${esc(safeImg(p.image_url))}" alt="${esc(p.caption)}" loading="lazy"></div>`).join(''));
}
init();
