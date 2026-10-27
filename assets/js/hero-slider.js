// Swipeable photo hero (scroll-snap). Works with touch, trackpad, keyboard, the arrows and the dots.
(() => {
  document.querySelectorAll('.hero-slider').forEach((root) => {
    const track = root.querySelector('.hero-track');
    const slides = [...root.querySelectorAll('.hero-slide')];
    const dots = [...root.querySelectorAll('.hero-dot')];
    const prev = root.querySelector('.hero-prev');
    const next = root.querySelector('.hero-next');
    if (!track || slides.length < 2) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const index = () => Math.round(track.scrollLeft / track.clientWidth);
    const go = (i) => track.scrollTo({
      left: Math.max(0, Math.min(slides.length - 1, i)) * track.clientWidth,
      behavior: reduce.matches ? 'auto' : 'smooth',
    });
    const sync = () => {
      const i = index();
      dots.forEach((d, n) => d.setAttribute('aria-current', String(n === i)));
      slides.forEach((s, n) => s.setAttribute('aria-hidden', String(n !== i)));
      prev.disabled = i === 0;
      next.disabled = i === slides.length - 1;
    };

    track.addEventListener('scroll', () => requestAnimationFrame(sync), { passive: true });
    prev.addEventListener('click', () => go(index() - 1));
    next.addEventListener('click', () => go(index() + 1));
    dots.forEach((d, n) => d.addEventListener('click', () => go(n)));
    track.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); go(index() + 1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(index() - 1); }
    });
    window.addEventListener('resize', () => { track.scrollLeft = index() * track.clientWidth; sync(); });
    sync();
  });
})();
