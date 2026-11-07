// Restaurant page photo slideshow: shows the photos managed in the staff dashboard (Slideshow tab).
// The photos already in restaurant.html are the fallback if the database cannot be reached or has none.
import { supabase, isConfigured, esc, safeImg } from './shop-common.js';

async function init() {
  if (!isConfigured) return;
  const root = document.querySelector('.hero-slider');
  const track = root && root.querySelector('.hero-track');
  const dots = root && root.querySelector('.hero-dots');
  if (!track || !dots) return;
  try {
    const { data, error } = await supabase.from('restaurant_slides').select('*').eq('is_visible', true).order('sort_order').order('created_at');
    if (error || !data || !data.length) return;
    track.innerHTML = data.map((p, i) => `<div class="hero-slide" role="group" aria-roledescription="slide" aria-label="${i + 1} of ${data.length}: ${esc(p.caption)}" style="background-image:url('${esc(safeImg(p.image_url))}');background-position:center 55%;"></div>`).join('');
    dots.innerHTML = data.map((p, i) => `<button class="hero-dot" type="button" aria-label="Show photo ${i + 1}: ${esc(p.caption)}"></button>`).join('');
    if (window.refreshHeroSlider) window.refreshHeroSlider(root);
  } catch { /* keep the built-in photos */ }
}
init();
