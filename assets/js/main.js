// American Roadhouse - shared interactions
document.addEventListener('DOMContentLoaded', async () => {

  /* Shared navbar component */
  const navbarSlot = document.getElementById('shared-navbar');
  if (navbarSlot) {
    try {
      let navbarMarkup = window.AmericanRoadhouseNavbar;
      if (!navbarMarkup) {
        const response = await fetch('components/navbar.js');
        if (!response.ok) throw new Error(`Navbar request failed: ${response.status}`);
        const source = await response.text();
        const match = source.match(/window\.AmericanRoadhouseNavbar\s*=\s*String\.raw`([\s\S]*)`;\s*$/);
        navbarMarkup = match?.[1];
      }
      if (!navbarMarkup) throw new Error('Navbar markup is unavailable.');
      navbarSlot.outerHTML = navbarMarkup;

      const currentPage = window.location.pathname.split('/').pop() || 'index.html';
      document.querySelectorAll('#site-nav a[href], #mobile-menu a[href]').forEach(link => {
        const href = link.getAttribute('href').split('?')[0].split('#')[0];
        if (href === currentPage || (currentPage === 'index.html' && href === '')) {
          link.classList.add('active');
          link.setAttribute('aria-current', 'page');
        }
      });
    } catch (error) {
      console.error('Unable to load shared navbar.', error);
    }
  }

  /* Sticky nav compaction */
  const nav = document.getElementById('site-nav');
  const onScroll = () => {
    if (window.scrollY > 40) nav?.classList.add('scrolled');
    else nav?.classList.remove('scrolled');
  };
  window.addEventListener('scroll', onScroll, { passive:true });
  onScroll();

  /* Mobile menu */
  const menuBtn = document.getElementById('menu-open');
  const menuCloseBtn = document.getElementById('menu-close');
  const mobileMenu = document.getElementById('mobile-menu');
  const closeMobileMenu = () => {
    mobileMenu?.classList.remove('open');
    document.documentElement.classList.remove('menu-lock');   // let the page scroll again
    menuBtn?.setAttribute('aria-expanded', 'false');
    menuBtn?.focus();
  };
  menuBtn?.setAttribute('aria-expanded', 'false');
  menuBtn?.addEventListener('click', () => {
    const isOpen = mobileMenu?.classList.toggle('open') || false;
    document.documentElement.classList.toggle('menu-lock', isOpen);   // stop the page scrolling behind the menu
    menuBtn.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) menuCloseBtn?.focus();
  });
  menuCloseBtn?.addEventListener('click', closeMobileMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mobileMenu?.classList.contains('open')) closeMobileMenu(); });
  window.matchMedia('(min-width: 1024px)').addEventListener?.('change', (e) => { if (e.matches && mobileMenu?.classList.contains('open')) closeMobileMenu(); });
  mobileMenu?.querySelectorAll('a').forEach(a => a.addEventListener('click', closeMobileMenu));

  /* Reveal on scroll */
  const revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && revealEls.length){
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: 0.12 });
    revealEls.forEach(el => io.observe(el));
  } else {
    revealEls.forEach(el => el.classList.add('in'));
  }

  /* FAQ accordion */
  document.querySelectorAll('.faq-item').forEach(item => {
    const btn = item.querySelector('.faq-question');
    const ans = item.querySelector('.faq-answer');
    btn?.addEventListener('click', () => {
      const isOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item.open').forEach(other => {
        if (other !== item){
          other.classList.remove('open');
          other.querySelector('.faq-answer').style.maxHeight = null;
        }
      });
      item.classList.toggle('open', !isOpen);
      ans.style.maxHeight = !isOpen ? ans.scrollHeight + 'px' : null;
    });
  });

  /* Gallery filters */
  const filters = document.querySelectorAll('.gallery-filter');
  const items = document.querySelectorAll('.gallery-item');
  filters.forEach(f => f.addEventListener('click', () => {
    filters.forEach(x => x.classList.remove('active'));
    f.classList.add('active');
    const cat = f.dataset.filter;
    items.forEach(it => {
      it.style.display = (cat === 'all' || it.dataset.cat === cat) ? '' : 'none';
    });
  }));

  /* Lightbox */
  const lightbox = document.getElementById('lightbox');
  if (lightbox){
    const lbImg = document.getElementById('lightbox-img');
    const gallery = Array.from(document.querySelectorAll('.gallery-item img'));
    let idx = 0;
    const show = (i) => {
      if (!gallery.length || !lbImg) return;
      idx = (i + gallery.length) % gallery.length;
      lbImg.src = gallery[idx].src;
      lbImg.alt = gallery[idx].alt;
    };
    const closeLightbox = () => {
      lightbox.classList.remove('open');
      lightbox.setAttribute('aria-hidden', 'true');
      gallery[idx]?.closest('.gallery-item')?.focus();
    };
    document.querySelectorAll('.gallery-item').forEach((el, i) => {
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label', `View image: ${gallery[i]?.alt || 'Gallery photo'}`);
      const open = () => {
        show(i);
        lightbox.classList.add('open');
        lightbox.setAttribute('aria-hidden', 'false');
        document.getElementById('lightbox-close')?.focus();
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
    lightbox.setAttribute('aria-hidden', 'true');
    document.getElementById('lightbox-close')?.addEventListener('click', closeLightbox);
    document.getElementById('lightbox-prev')?.addEventListener('click', () => show(idx - 1));
    document.getElementById('lightbox-next')?.addEventListener('click', () => show(idx + 1));
    lightbox.addEventListener('click', (e) => { if (e.target === lightbox) closeLightbox(); });
    document.addEventListener('keydown', (e) => {
      if (!lightbox.classList.contains('open')) return;
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowRight') show(idx + 1);
      if (e.key === 'ArrowLeft') show(idx - 1);
    });
  }

  /* Tabs (Booking / Contact) */
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      const group = btn.closest('.tabs').dataset.group;
      document.querySelectorAll(`.tabs[data-group="${group}"] .tab-btn`).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll(`.tab-panel[data-group="${group}"]`).forEach(p => p.classList.remove('active'));
      document.querySelector(`.tab-panel[data-group="${group}"][data-tab="${target}"]`)?.classList.add('active');
    });
  });

  /* Deep-link tab activation, e.g. contact.html?tab=booking */
  const params = new URLSearchParams(window.location.search);
  const wantedTab = params.get('tab');
  if (wantedTab){
    const btn = document.querySelector(`.tab-btn[data-tab="${wantedTab}"]`);
    btn?.click();
    setTimeout(() => document.getElementById('forms')?.scrollIntoView({ behavior:'smooth' }), 200);
  }

  /* Keep phone fields limited to valid phone-number characters. */
  document.querySelectorAll('input[type="tel"]').forEach(input => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/[^0-9+()\s-]/g, '').slice(0, 16);
    });
  });

  /* Keep the compact SVG flag synced with the selected country code. */
  const countryFlags = {
    '+63': '<rect width="24" height="8" fill="#1B4FA3"/><rect y="8" width="24" height="8" fill="#CE1126"/><path d="M0 0v16l9-8L0 0Z" fill="#fff"/><circle cx="3.2" cy="8" r="1.2" fill="#FCD116"/>',
    '+1': '<rect width="24" height="16" fill="#fff"/><path d="M0 0h24v2H0m0 4h24v2H0m0 4h24v2H0" stroke="#B22234" stroke-width="2"/><rect width="11" height="9" fill="#3C3B6E"/>',
    '+44': '<rect width="24" height="16" fill="#1E3A8A"/><path d="M0 0l24 16M24 0L0 16" stroke="#fff" stroke-width="4"/><path d="M0 0l24 16M24 0L0 16" stroke="#C8102E" stroke-width="2"/><path d="M12 0v16M0 8h24" stroke="#fff" stroke-width="5"/><path d="M12 0v16M0 8h24" stroke="#C8102E" stroke-width="2"/>',
    '+61': '<rect width="24" height="16" fill="#012169"/><circle cx="17.5" cy="4" r="1.5" fill="#fff"/><path d="M0 0l9 6M9 0L0 6" stroke="#fff" stroke-width="2"/><path d="M4.5 0v6M0 3h9" stroke="#C8102E" stroke-width="1"/>',
    '+65': '<rect width="24" height="8" fill="#EF3340"/><rect y="8" width="24" height="8" fill="#fff"/><circle cx="5" cy="4" r="2" fill="#fff"/>',
    '+81': '<rect width="24" height="16" fill="#fff"/><circle cx="12" cy="8" r="4" fill="#BC002D"/>'
  };
  document.querySelectorAll('.phone-input').forEach(phoneInput => {
    const select = phoneInput.querySelector('select[name="country_code"]');
    const flag = phoneInput.querySelector('.country-flag');
    const updateFlag = () => { if (select && flag) flag.innerHTML = countryFlags[select.value] || countryFlags['+63']; };
    select?.addEventListener('change', updateFlag);
    updateFlag();
  });

  /* Form submission -> sent to LazyForms, then confirmation state */
  const nextDate = value => {
    const date = new Date(`${value}T00:00:00`);
    date.setDate(date.getDate() + 1);
    return date.toISOString().slice(0, 10);
  };
  /* Also save the request in Supabase so staff see it in the dashboard (email still goes out via LazyForms) */
  const saveInquiry = async (form) => {
    const env = window.__ENV;
    if (!env?.SUPABASE_URL || !env?.SUPABASE_ANON_KEY) throw new Error('Dashboard not configured');
    const fd = new FormData(form);
    if (fd.get('_honey')) return;
    const subject = String(fd.get('subject') || '').toLowerCase();
    const kind = subject.includes('booking') ? 'booking' : subject.includes('table') ? 'table' : 'message';
    const skip = new Set(['subject', 'from_name', '_honey', 'country_code', 'full_name', 'phone', 'email']);
    const details = {};
    fd.forEach((v, k) => { if (!skip.has(k) && String(v).trim()) details[k] = String(v).trim(); });
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/submit_inquiry`, {
      method: 'POST',
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        p_kind: kind,
        p_full_name: fd.get('full_name') || '',
        p_phone: `${fd.get('country_code') || ''} ${fd.get('phone') || ''}`.trim(),
        p_email: fd.get('email') || '',
        p_details: details
      })
    });
    if (!res.ok) throw new Error('Could not save request');
  };
  document.querySelectorAll('form[data-inquiry-form]').forEach(form => {
    const submitBtn = form.querySelector('button[type="submit"]');
    const errorBox = form.querySelector('.form-error');
    const checkIn = form.querySelector('input[name="check_in"]');
    const checkOut = form.querySelector('input[name="check_out"]');
    const today = new Date();
    const todayLocal = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    form.querySelectorAll('input[type="date"]').forEach(dateInput => { dateInput.min = todayLocal; });
    if (checkIn && checkOut) {
      checkIn.min = todayLocal;
      const syncCheckout = () => {
        checkOut.min = checkIn.value ? nextDate(checkIn.value) : todayLocal;
        if (checkOut.value && checkOut.value < checkOut.min) checkOut.value = '';
        checkOut.setCustomValidity('');
      };
      checkIn.addEventListener('input', syncCheckout);
      checkIn.addEventListener('change', syncCheckout);
      checkOut.addEventListener('input', () => {
        checkOut.setCustomValidity(checkIn.value && checkOut.value && checkOut.value <= checkIn.value ? 'Check-out must be after check-in.' : '');
      });
      syncCheckout();
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (checkIn && checkOut && checkOut.value <= checkIn.value) {
        checkOut.setCustomValidity('Check-out must be after check-in.');
      } else if (checkOut) {
        checkOut.setCustomValidity('');
      }
      if (!form.checkValidity()){ form.reportValidity(); return; }
      const originalLabel = submitBtn ? submitBtn.textContent : '';
      if (submitBtn){ submitBtn.disabled = true; submitBtn.textContent = 'Sending…'; }
      errorBox?.classList.remove('show');
      try {
        const sendEmail = fetch('https://api.lazyforms.com/f/89ab48a8-441f-46c0-b290-e11613e782bf', {
          method: 'POST',
          headers: { 'Accept': 'application/json' },
          body: new FormData(form)
        }).then(async (res) => {
          if (!res.ok) throw new Error('Submission service returned an error');
          const result = await res.json();
          if (!result.success) throw new Error(result.message || 'Submission failed');
        });
        const [mail, saved] = await Promise.allSettled([sendEmail, saveInquiry(form)]);
        if (saved.status === 'rejected') console.warn('Inquiry not saved to dashboard:', saved.reason);
        // Success if the team was reached by at least one channel.
        if (mail.status === 'rejected' && saved.status === 'rejected') throw mail.reason;
        form.style.display = 'none';
        form.parentElement.querySelector('.form-confirm')?.classList.add('show');
      } catch (err){
        if (errorBox){
          errorBox.textContent = "Something went wrong sending your request - please try again, or call us at 0915 875 4860.";
          errorBox.classList.add('show');
        }
      } finally {
        if (submitBtn){ submitBtn.disabled = false; submitBtn.textContent = originalLabel; }
      }
    });
  });

  /* Quick availability card -> routes to booking form (no live inventory yet) */
  const quickCheckIn = document.getElementById('qa-checkin');
  const quickCheckOut = document.getElementById('qa-checkout');
  if (quickCheckIn && quickCheckOut) {
    const today = new Date();
    const todayLocal = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    quickCheckIn.min = todayLocal;
    const syncQuickCheckout = () => {
      quickCheckOut.min = quickCheckIn.value ? nextDate(quickCheckIn.value) : todayLocal;
      if (quickCheckOut.value && quickCheckOut.value < quickCheckOut.min) quickCheckOut.value = '';
      quickCheckOut.setCustomValidity('');
    };
    quickCheckIn.addEventListener('input', syncQuickCheckout);
    quickCheckIn.addEventListener('change', syncQuickCheckout);
    quickCheckOut.addEventListener('input', () => {
      quickCheckOut.setCustomValidity(quickCheckIn.value && quickCheckOut.value && quickCheckOut.value <= quickCheckIn.value ? 'Check-out must be after check-in.' : '');
    });
    syncQuickCheckout();
  }
  document.getElementById('quick-availability')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const ci = document.getElementById('qa-checkin')?.value || '';
    const co = document.getElementById('qa-checkout')?.value || '';
    const guests = document.getElementById('qa-guests')?.value || '';
    const checkIn = quickCheckIn;
    const checkOut = quickCheckOut;
    if (checkOut && checkIn && checkOut.value <= checkIn.value) {
      checkOut.setCustomValidity('Check-out must be after check-in.');
      checkOut.reportValidity();
      return;
    }
    checkOut?.setCustomValidity('');
    const qs = new URLSearchParams({ tab:'booking', checkin:ci, checkout:co, guests }).toString();
    window.location.href = `contact.html?${qs}#forms`;
  });

  /* Prefill booking form from quick-availability query params */
  const ciParam = params.get('checkin'), coParam = params.get('checkout'), gParam = params.get('guests');
  if (ciParam) document.getElementById('bk-checkin') && (document.getElementById('bk-checkin').value = ciParam);
  if (coParam) document.getElementById('bk-checkout') && (document.getElementById('bk-checkout').value = coParam);
  if (gParam && /^\d+$/.test(gParam)) {
    const guestInput = document.getElementById('bk-guests');
    if (guestInput) guestInput.value = gParam;
  }

  /* Normalize browser-restored date values after autofill/session restoration. */
  const enforceDateRanges = () => {
    const ranges = [
      [document.getElementById('bk-checkin'), document.getElementById('bk-checkout')],
      [document.getElementById('qa-checkin'), document.getElementById('qa-checkout')]
    ];
    ranges.forEach(([checkIn, checkOut]) => {
      if (!checkIn || !checkOut || !checkIn.value) return;
      checkOut.min = nextDate(checkIn.value);
      if (checkOut.value && checkOut.value <= checkIn.value) {
        checkOut.value = '';
        checkOut.setCustomValidity('');
      }
    });
  };
  setTimeout(enforceDateRanges, 100);
  window.addEventListener('pageshow', () => setTimeout(enforceDateRanges, 0));

});
