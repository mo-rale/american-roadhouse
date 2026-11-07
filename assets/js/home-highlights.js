// Home page "Menu Highlights": shows the cards managed in the staff dashboard (Highlights tab).
// The cards already in index.html are the fallback if the database cannot be reached or has none.
import { supabase, isConfigured, esc, safeImg } from './shop-common.js';

async function init() {
  if (!isConfigured) return;
  const grid = document.getElementById('home-highlights');
  if (!grid) return;
  try {
    const { data, error } = await supabase.from('home_highlights').select('*').eq('is_visible', true).order('sort_order').order('created_at').limit(4);
    if (error || !data || !data.length) return;
    grid.innerHTML = data.map((p) => `<div class="card">
        <img src="${esc(safeImg(p.image_url))}" alt="${esc(p.title)}" loading="lazy" style="height:150px;object-fit:cover;width:100%;">
        <div style="padding:16px;">
          <h4 style="font-size:15.5px;">${esc(p.title)}</h4>
          ${p.subtitle ? `<p style="font-size:12.5px;color:#8a8378;margin-top:6px;">${esc(p.subtitle)}</p>` : ''}
        </div>
      </div>`).join('');
  } catch { /* keep the built-in cards */ }
}
init();
