// Photo hero slideshow (scroll-snap): swipe, arrows, dots, keyboard, and it advances by itself.
// Slides can be rebuilt after load (page-slides.js): call window.refreshHeroSlider(root) afterwards.
(() => {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const AUTO_MS = 5000;

  function setup(root) {
    if (root._hero) return;
    const track = root.querySelector('.hero-track');
    const prev = root.querySelector('.hero-prev');
    const next = root.querySelector('.hero-next');
    const dotsBox = root.querySelector('.hero-dots');
    if (!track || !prev || !next) return;
    const slides = () => [...root.querySelectorAll('.hero-slide')];
    const dots = () => [...root.querySelectorAll('.hero-dot')];
    const count = () => slides().length;
    const index = () => Math.round(track.scrollLeft / (track.clientWidth || 1));
    const go = (i) => {
      const n = count();
      if (!n) return;
      track.scrollTo({ left: (((i % n) + n) % n) * track.clientWidth, behavior: reduce.matches ? 'auto' : 'smooth' });
    };
    const sync = () => {
      const i = index(), many = count() > 1;
      dots().forEach((d, n) => d.setAttribute('aria-current', String(n === i)));
      slides().forEach((s, n) => s.setAttribute('aria-hidden', String(n !== i)));
      prev.hidden = next.hidden = !many;
      if (dotsBox) dotsBox.hidden = !many;
    };

    // automatic advance, paused while the visitor is interacting or the tab is hidden
    let paused = false, timer = null;
    const tick = () => { if (!paused && !document.hidden && !reduce.matches && count() > 1) go(index() + 1); };
    const startTimer = () => { clearInterval(timer); timer = setInterval(tick, AUTO_MS); };
    const pause = () => { paused = true; };
    const resume = () => { paused = false; startTimer(); };

    track.addEventListener('scroll', () => requestAnimationFrame(sync), { passive: true });
    prev.addEventListener('click', () => { go(index() - 1); startTimer(); });
    next.addEventListener('click', () => { go(index() + 1); startTimer(); });
    if (dotsBox) {
      dotsBox.addEventListener('click', (e) => {
        const d = e.target.closest('.hero-dot');
        if (d) { go(dots().indexOf(d)); startTimer(); }
      });
    }
    track.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); go(index() + 1); startTimer(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(index() - 1); startTimer(); }
    });
    root.addEventListener('mouseenter', pause);
    root.addEventListener('mouseleave', resume);
    root.addEventListener('focusin', pause);
    root.addEventListener('focusout', resume);
    root.addEventListener('touchstart', pause, { passive: true });
    root.addEventListener('touchend', () => setTimeout(resume, 2500), { passive: true });
    window.addEventListener('resize', () => { track.scrollLeft = index() * track.clientWidth; sync(); });
    root._hero = { reset: () => { track.scrollLeft = 0; sync(); startTimer(); } };
    sync();
    startTimer();
  }

  window.setupHeroSlider = setup;
  window.refreshHeroSlider = (root) => { if (root && root._hero) root._hero.reset(); };
  document.querySelectorAll('.hero-slider').forEach(setup);
})();
