// Services page: "Transportation" opens the list of transport services (motorcycle rental, airport pick-up;
// edited by staff under Website > Transportation) and a request form that lands in the staff dashboard
// under Inquiries > Transport.
import { supabase, isConfigured, esc } from './shop-common.js';

const FALLBACK = [
  { name: 'Motorcycle rental', description: 'Two motorcycles are available to rent for getting around Candijay and nearby places.', price_label: 'Ask for rates' },
  { name: 'Airport pick-up', description: 'Our car can pick you up at the airport. Tell us your flight and arrival time and we will arrange it.', price_label: 'Ask for rates' },
];

const dlg = document.getElementById('transport-dlg');
const list = document.getElementById('transport-list');
if (dlg && list) {
  const menuView = document.getElementById('transport-menu');
  const formView = document.getElementById('transport-formview');
  const form = document.getElementById('transport-form');
  const typeSel = document.getElementById('tf-type');
  const errBox = document.getElementById('tf-error');
  const okBox = document.getElementById('tf-ok');
  let services = FALLBACK;

  const render = () => {
    list.innerHTML = services.map((r) => `<li class="massage-row">
      <div class="massage-info"><strong>${esc(r.name)}</strong>${r.description ? `<span>${esc(r.description)}</span>` : ''}</div>
      <div class="massage-meta"><span class="massage-price">${esc(r.price_label || 'Ask for rates')}</span></div></li>`).join('');
    const keep = typeSel.value;
    typeSel.innerHTML = '<option value="">Choose one</option>' + services.map((r) => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
    if (keep) typeSel.value = keep;
  };

  const load = async () => {
    render();                                   // the standard list shows at once; the live list replaces it
    if (!isConfigured) return;
    const { data, error } = await supabase.from('transport_services').select('*').eq('is_active', true).order('sort_order').order('name');
    if (!error && data && data.length) { services = data; render(); }
  };

  const show = (view) => {
    menuView.hidden = view !== 'menu';
    formView.hidden = view !== 'form';
    if (view === 'form') { okBox.hidden = true; form.hidden = false; errBox.textContent = ''; }
  };

  document.querySelectorAll('[data-open-transport]').forEach((el) => el.addEventListener('click', (e) => {
    e.preventDefault();
    show('menu');
    dlg.showModal();
    load();
  }));
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  dlg.querySelectorAll('[data-show]').forEach((b) => b.addEventListener('click', () => show(b.dataset.show)));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });   // click on the backdrop
  form.elements.date.min = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.textContent = '';
    const f = form.elements;
    if (f._honey.value) return;
    const name = f.full_name.value.trim(), phone = f.phone.value.trim(), email = f.email.value.trim();
    const fail = (msg, el) => { errBox.textContent = msg; el.focus(); };
    if (name.length < 2) return fail('Please enter your name.', f.full_name);
    if (!/^[0-9+() -]{7,24}$/.test(phone)) return fail('Please enter a valid phone number.', f.phone);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('Please enter a valid email address.', f.email);
    if (!typeSel.value) return fail('Please choose what you need.', typeSel);
    if (!f.date.value) return fail('Please choose the date.', f.date);
    if (!isConfigured) { errBox.textContent = 'Online requests are unavailable right now. Please call 0915 875 4860.'; return; }
    const details = {
      transport_type: typeSel.value, date: f.date.value, time: f.time.value, days: f.days.value.trim(),
      flight: f.flight.value.trim(), guests: f.guests.value.trim(), notes: f.notes.value.trim(),
    };
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    const { error } = await supabase.rpc('submit_inquiry', { p_kind: 'transport', p_full_name: name, p_phone: phone, p_email: email, p_details: details });
    btn.disabled = false;
    if (error) {
      errBox.textContent = /RATE_LIMIT/.test(error.message) ? 'Too many requests right now. Please call 0915 875 4860.' : 'Sorry, we could not send your request. Please try again or call 0915 875 4860.';
      return;
    }
    form.reset();
    form.hidden = true;
    okBox.hidden = false;
  });
}
