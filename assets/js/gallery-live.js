// Gallery page: shows the photos managed in the staff dashboard (Gallery tab).
// The photos already in gallery.html are the fallback if the database cannot be reached or has none.
import { supabase, isConfigured, esc, safeImg } from './shop-common.js';

const LABEL = { rooms: 'Rooms', hotel: 'Hotel', restaurant: 'Restaurant', food: 'Food' };

async function init() {
  if (!isConfigured) return;
  const grid = document.querySelector('.gallery-grid');
  const filters = document.querySelector('.gallery-filters');
  if (!grid || !filters) return;
  try {
    const { data, error } = await supabase.from('gallery_photos').select('*').eq('is_visible', true).order('sort_order').order('created_at');
    if (error || !data || !data.length) return;
    grid.innerHTML = data.map((p) => `<div class="gallery-item" data-cat="${esc(p.category)}">
      <img src="${esc(safeImg(p.image_url))}" alt="${esc(p.caption)}" loading="lazy">
      <div class="gallery-overlay">${esc(LABEL[p.category] || '')} &ndash; VIEW PHOTO</div>
    </div>`).join('');
    const present = Object.keys(LABEL).filter((c) => data.some((p) => p.category === c));
    filters.innerHTML = `<button class="gallery-filter active" data-filter="all">All</button>`
      + present.map((c) => `<button class="gallery-filter" data-filter="${c}">${LABEL[c]}</button>`).join('');
    if (window.initGallery) window.initGallery();      // hook the filters and the photo viewer up to the new photos
  } catch { /* keep the built-in photos */ }
}
init();
