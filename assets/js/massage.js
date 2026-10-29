// Services page: clicking Massage opens the massage menu (types and prices from the database,
// edited by the administrator in the staff dashboard) and a request form that lands in the
// dashboard's "Massage inquiries" tab.
import { supabase, isConfigured, esc, peso } from './shop-common.js';

const dlg = document.getElementById('massage-dlg');
const list = document.getElementById('massage-list');
if (dlg && list) {
  const menuView = document.getElementById('massage-menu');
  const formView = document.getElementById('massage-formview');
  const form = document.getElementById('massage-form');
  const typeSel = document.getElementById('mf-type');
  const errBox = document.getElementById('mf-error');
  const okBox = document.getElementById('mf-ok');
  let services = [];

  const durationText = (r) => (r.duration_minutes ? `${r.duration_minutes} min` : r.duration_label || '');
  const priceText = (r) => (r.price != null ? peso(r.price) : 'Ask for price');

  const render = () => {
    if (!services.length) {
      list.innerHTML = '<li class="massage-empty">Our massage menu is being updated. Please call <a href="tel:+639158754860">0915 875 4860</a> or send a request below for types and prices.</li>';
      return;
    }
    list.innerHTML = services.map((r) => `<li class="massage-row">
      <div class="massage-info"><strong>${esc(r.name)}</strong>${r.description ? `<span>${esc(r.description)}</span>` : ''}</div>
      <div class="massage-meta">${durationText(r) ? `<span class="massage-dur">${esc(durationText(r))}</span>` : ''}
        <span class="massage-price">${priceText(r)}</span>${r.price != null && r.price_unit ? `<span class="massage-dur">${esc(r.price_unit)}</span>` : ''}</div></li>`).join('');
    const keep = typeSel.value;
    typeSel.innerHTML = '<option value="">No preference / not sure yet</option>' +
      services.map((r) => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
    if (keep) typeSel.value = keep;
  };

  const load = async () => {
    if (!isConfigured) { services = []; render(); return; }
    list.innerHTML = '<li class="massage-empty">Loading…</li>';
    const { data, error } = await supabase.from('massage_services').select('*')
      .eq('is_active', true).order('sort_order').order('name');
    if (error) { list.innerHTML = '<li class="massage-empty">Could not load the massage menu. Please try again, or call <a href="tel:+639158754860">0915 875 4860</a>.</li>'; return; }
    services = data;
    render();
  };

  const show = (view) => {
    menuView.hidden = view !== 'menu';
    formView.hidden = view !== 'form';
    if (view === 'form') { okBox.hidden = true; form.hidden = false; errBox.textContent = ''; }
  };

  document.querySelectorAll('[data-open-massage]').forEach((el) => el.addEventListener('click', (e) => {
    e.preventDefault();
    show('menu');
    dlg.showModal();
    load();
  }));
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  dlg.querySelectorAll('[data-show]').forEach((b) => b.addEventListener('click', () => show(b.dataset.show)));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });   // click on the backdrop

  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  form.elements.date.min = today;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.textContent = '';
    if (form.elements._honey.value) return;
    const name = form.elements.full_name.value.trim();
    const phone = form.elements.phone.value.trim();
    const email = form.elements.email.value.trim();
    if (name.length < 2) { errBox.textContent = 'Please enter your name.'; form.elements.full_name.focus(); return; }
    if (!/^[0-9+() -]{7,24}$/.test(phone)) { errBox.textContent = 'Please enter a valid phone number.'; form.elements.phone.focus(); return; }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { errBox.textContent = 'Please enter a valid email address.'; form.elements.email.focus(); return; }
    if (!isConfigured) { errBox.textContent = 'Online requests are unavailable right now. Please call 0915 875 4860.'; return; }
    const details = {
      massage_type: typeSel.value, date: form.elements.date.value, time: form.elements.time.value,
      guests: form.elements.guests.value, notes: form.elements.notes.value.trim(),
    };
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    const { error } = await supabase.rpc('submit_inquiry', { p_kind: 'massage', p_full_name: name, p_phone: phone, p_email: email, p_details: details });
    btn.disabled = false;
    if (error) {
      errBox.textContent = /RATE_LIMIT/.test(error.message) ? 'Too many requests right now. Please call 0915 875 4860.' : 'Sorry, we could not send your request. Please try again or call 0915 875 4860.';
      return;
    }
    form.reset();
    form.hidden = true;
    okBox.hidden = false;
  });

  // keep an open list current if the administrator changes it
  if (supabase) {
    supabase.channel('massage-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'massage_services' }, () => { if (dlg.open) load(); })
      .subscribe();
  }
}
