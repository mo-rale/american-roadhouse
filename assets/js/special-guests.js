// Front page, top "Welcome" area: the photo on the left shows the special guests who have visited
// the restaurant, one at a time, with their name and a short note. The list is kept in the database
// and edited by the administrator in the staff dashboard (tab "Special guests"). With no visible
// guests the area keeps its normal room photo.
import { supabase, isConfigured, esc, safeImg } from './shop-common.js';

const box = document.getElementById('guest-showcase');
if (box && isConfigured) {
  const fmt = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
  const INTERVAL = 3000;   // time between guests, in milliseconds
  let timer = null;
  let current = 0;

  // Slide to guest i. dir is 1 (new one comes in from the right) or -1 (from the left).
  const show = (i, dir = 1) => {
    const slides = [...box.querySelectorAll('.guest-slide')];
    if (!slides.length) return;
    const next = (i + slides.length) % slides.length;
    if (next === current) return;
    const from = slides[current];
    const to = slides[next];
    to.style.transition = 'none';
    to.style.transform = `translateX(${dir * 100}%)`;
    void to.offsetWidth;                        // apply the start position before animating
    to.style.transition = '';
    to.style.transform = '';
    from.style.transform = `translateX(${-dir * 100}%)`;
    slides.forEach((s, n) => {
      s.classList.toggle('is-on', n === next);
      s.setAttribute('aria-hidden', String(n !== next));
      if (n !== next && s !== from) s.style.transform = '';
    });
    current = next;
    box.querySelectorAll('.guest-dot').forEach((d, n) => d.setAttribute('aria-current', String(n === current)));
  };
  const stop = () => { clearInterval(timer); timer = null; };
  const start = () => {
    stop();
    if (box.querySelectorAll('.guest-slide').length > 1) timer = setInterval(() => show(current + 1, 1), INTERVAL);
  };

  const render = (rows) => {
    stop();
    current = 0;
    box.querySelector('.guest-slides')?.remove();
    box.querySelector('.guest-dots')?.remove();
    box.querySelector('.guest-badge')?.remove();
    box.classList.toggle('has-guests', rows.length > 0);
    if (!rows.length) return;

    const slides = rows.map((g, n) => `<figure class="guest-slide${n === 0 ? ' is-on' : ''}" aria-hidden="${n !== 0}">
      <img src="${esc(safeImg(g.image_url))}" alt="${esc(g.name)}"${n ? ' loading="lazy"' : ''}>
      <figcaption>
        <strong>${esc(g.name)}</strong>
        ${g.title ? `<span class="guest-title">${esc(g.title)}</span>` : ''}
        ${g.note ? `<p>${esc(g.note)}</p>` : ''}
        ${g.visit_date ? `<span class="guest-date">Visited ${esc(fmt(g.visit_date))}</span>` : ''}
      </figcaption></figure>`).join('');
    const dots = rows.length > 1
      ? `<div class="guest-dots">${rows.map((g, n) => `<button type="button" class="guest-dot" data-i="${n}" aria-label="Show ${esc(g.name)}" aria-current="${n === 0}"></button>`).join('')}</div>`
      : '';
    box.insertAdjacentHTML('beforeend', `<div class="guest-slides" aria-roledescription="carousel" aria-label="Special guests">${slides}</div>${dots}<span class="guest-badge">Special guests</span>`);
    start();
  };

  box.addEventListener('click', (e) => {
    const d = e.target.closest('.guest-dot');
    if (d) { const i = Number(d.dataset.i); show(i, i > current ? 1 : -1); start(); }
  });
  // Pause while a mouse pointer rests on the photo; carry on when it leaves (touch screens are unaffected).
  box.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') stop(); });
  box.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') start(); });
  let x0 = null;
  box.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; stop(); }, { passive: true });
  box.addEventListener('touchend', (e) => {
    if (x0 !== null) {
      const dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 40) show(current + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
    }
    x0 = null; start();
  });

  const load = async () => {
    const { data, error } = await supabase.from('special_guests').select('*')
      .eq('is_visible', true).order('sort_order').order('visit_date', { ascending: false, nullsFirst: false });
    if (!error) render(data);
  };
  load();

  supabase.channel('guests-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'special_guests' }, load)
    .subscribe();
}
