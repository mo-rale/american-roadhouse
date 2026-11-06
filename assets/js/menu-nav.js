// Restaurant page: a sticky category navigator for the Main and Roof Deck menus.
// - one scrollable row of categories (with a dish count) that stays under the header while you scroll
// - the category you are reading is highlighted (scroll-spy) and kept in view
// - arrows on desktop, swipe on touch; the strip is rebuilt whenever the live menu re-renders
// It replaces the old wrapping chip block (hidden in CSS); without JavaScript the sections still work.
(function () {
  'use strict';
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var behavior = reduce ? 'auto' : 'smooth';
  var rails = [];   // { wrap, scroller, links, secs }

  function el(tag, cls, attrs) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }
  function navHeight() { var n = document.getElementById('site-nav'); return n ? n.getBoundingClientRect().height : 70; }
  function setTop() { document.documentElement.style.setProperty('--rail-top', Math.round(navHeight()) + 'px'); }
  function offset(wrap) { return navHeight() + (wrap ? wrap.offsetHeight : 64) + 14; }

  function updateArrows(r) {
    var s = r.scroller, max = s.scrollWidth - s.clientWidth;
    r.wrap.classList.toggle('can-left', s.scrollLeft > 4);
    r.wrap.classList.toggle('can-right', s.scrollLeft < max - 4);
  }
  function centre(r, a) {
    var s = r.scroller;
    s.scrollTo({ left: a.offsetLeft - (s.clientWidth - a.offsetWidth) / 2, behavior: behavior });
  }
  function setActive(r, idx) {
    if (r.active === idx) return;
    r.active = idx;
    r.links.forEach(function (a, i) { if (i === idx) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); });
    if (idx >= 0) centre(r, r.links[idx]);
  }
  function spy(r) {
    if (!r.wrap.offsetParent) return;                 // its tab is hidden
    var line = offset(r.wrap), idx = -1;
    r.secs.forEach(function (s, i) { if (s.getBoundingClientRect().top <= line + 1) idx = i; });
    // before the first heading reaches the line nothing is highlighted
    setActive(r, idx);
  }

  function build(container) {
    var panel = container.closest('.tab-panel');
    if (!panel) return;
    var old = panel.querySelector(':scope > .rail-wrap');
    if (old) { rails = rails.filter(function (r) { return r.wrap !== old; }); old.remove(); }
    var secs = Array.prototype.slice.call(container.querySelectorAll('.dining-cat'));
    if (secs.length < 2) return;

    var wrap = el('div', 'rail-wrap', { role: 'navigation', 'aria-label': 'Menu categories' });
    var prev = el('button', 'rail-btn prev', { type: 'button', 'aria-label': 'Show earlier categories' }); prev.innerHTML = '&#8249;';
    var next = el('button', 'rail-btn next', { type: 'button', 'aria-label': 'Show more categories' }); next.innerHTML = '&#8250;';
    var scroller = el('div', 'rail-scroll');
    var list = el('ul', 'rail-list');
    var links = secs.map(function (s) {
      var title = (s.querySelector('h3') || {}).textContent || '';
      var n = s.querySelectorAll('.menu-item').length;
      var li = el('li'), a = el('a', n ? '' : 'is-empty', { href: '#' + s.id });
      a.appendChild(document.createTextNode(title.trim()));
      var c = el('span', 'rail-count'); c.textContent = n; c.setAttribute('aria-label', n + (n === 1 ? ' dish' : ' dishes'));
      a.appendChild(c); li.appendChild(a); list.appendChild(li);
      return a;
    });
    scroller.appendChild(list);
    wrap.appendChild(prev); wrap.appendChild(scroller); wrap.appendChild(next);
    container.parentNode.insertBefore(wrap, container);

    var r = { wrap: wrap, scroller: scroller, links: links, secs: secs, active: -2 };
    rails.push(r);

    list.addEventListener('click', function (e) {
      var a = e.target.closest('a'); if (!a) return;
      e.preventDefault();
      var i = links.indexOf(a), s = secs[i];
      var y = s.getBoundingClientRect().top + window.pageYOffset - offset(wrap) + 8;
      window.scrollTo({ top: y, behavior: behavior });
      setActive(r, i);
      if (history.replaceState) history.replaceState(null, '', '#' + s.id);
    });
    prev.addEventListener('click', function () { scroller.scrollBy({ left: -scroller.clientWidth * 0.7, behavior: behavior }); });
    next.addEventListener('click', function () { scroller.scrollBy({ left: scroller.clientWidth * 0.7, behavior: behavior }); });
    // mouse wheel over the strip scrolls it sideways (until its end, then the page scrolls as usual)
    scroller.addEventListener('wheel', function (e) {
      var dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!dx || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;   // a trackpad's own sideways swipe already works
      var max = scroller.scrollWidth - scroller.clientWidth;
      if ((dx < 0 && scroller.scrollLeft <= 0) || (dx > 0 && scroller.scrollLeft >= max - 1)) return;
      e.preventDefault();
      scroller.scrollLeft += dx * (e.deltaMode === 1 ? 32 : 1);
    }, { passive: false });
    scroller.addEventListener('scroll', function () { updateArrows(r); }, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(function () { updateArrows(r); }).observe(scroller);
    updateArrows(r); spy(r);
  }

  function init() {
    setTop();
    ['main-live', 'roof-live'].forEach(function (id) {
      var c = document.getElementById(id);
      if (!c) return;
      build(c);
      var t;
      new MutationObserver(function () { clearTimeout(t); t = setTimeout(function () { build(c); }, 60); }).observe(c, { childList: true });
    });
    var ticking = false;
    function onScroll() {
      if (ticking) return; ticking = true;
      requestAnimationFrame(function () { ticking = false; setTop(); rails.forEach(spy); });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', function () { setTop(); rails.forEach(function (r) { updateArrows(r); spy(r); }); });
    // switching Main / Roof Deck: let the page settle, then re-measure
    document.addEventListener('click', function (e) { if (e.target.closest('.tab-btn')) setTimeout(function () { rails.forEach(function (r) { updateArrows(r); spy(r); }); }, 80); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
