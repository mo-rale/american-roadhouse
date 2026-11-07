// Header slideshow on the inner pages: shows the photos managed in the staff dashboard (Website > Slideshow).
// A page with no photos there keeps its normal header photo.
import { supabase, isConfigured, esc, safeImg } from './shop-common.js';

const ARROW = (d) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="${d}"/></svg>`;

async function init() {
  if (!isConfigured) return;
  const page = (location.pathname.split('/').pop() || 'index').replace(/\.html$/, '');
  const root = document.querySelector('.page-hero');
  if (!root || page === 'index') return;
  try {
    const { data, error } = await supabase.from('page_slides').select('*').eq('page', page).eq('is_visible', true).order('sort_order').order('created_at');
    if (error || !data || !data.length) return;
    const slides = data.map((p, i) => `<div class="hero-slide" role="group" aria-roledescription="slide" aria-label="${i + 1} of ${data.length}: ${esc(p.caption)}" style="background-image:url('${esc(safeImg(p.image_url))}');background-position:center 55%;"></div>`).join('');
    const dots = data.map((p, i) => `<button class="hero-dot" type="button" aria-label="Show photo ${i + 1}: ${esc(p.caption)}"></button>`).join('');

    if (!root.querySelector('.hero-track')) {
      // turn the plain header into a slideshow
      root.classList.add('hero-slider');
      root.setAttribute('aria-roledescription', 'carousel');
      root.setAttribute('aria-label', 'Photos');
      root.style.backgroundImage = 'none';
      root.insertAdjacentHTML('afterbegin', '<div class="hero-track" tabindex="0" aria-live="off"></div>');
      root.insertAdjacentHTML('beforeend',
        `<button class="hero-arrow hero-prev" type="button" aria-label="Previous photo">${ARROW('15 6 9 12 15 18')}</button>`
        + `<button class="hero-arrow hero-next" type="button" aria-label="Next photo">${ARROW('9 6 15 12 9 18')}</button>`
        + '<div class="hero-dots" role="group" aria-label="Choose a photo"></div>');
      root.querySelector('.hero-track').innerHTML = slides;
      root.querySelector('.hero-dots').innerHTML = dots;
      if (window.setupHeroSlider) window.setupHeroSlider(root);
    } else {
      root.querySelector('.hero-track').innerHTML = slides;
      root.querySelector('.hero-dots').innerHTML = dots;
      if (window.refreshHeroSlider) window.refreshHeroSlider(root);
    }
  } catch { /* keep the normal header */ }
}
init();
