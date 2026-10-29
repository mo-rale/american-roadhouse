// Services page: "Events & Gatherings" opens a request form. Requests land in the staff
// dashboard under Inquiries > Events.
import { supabase, isConfigured } from './shop-common.js';

const dlg = document.getElementById('event-dlg');
const form = document.getElementById('event-form');
if (dlg && form) {
  const errBox = document.getElementById('ev-error');
  const okBox = document.getElementById('ev-ok');
  const other = document.getElementById('ev-other-wrap');

  const open = () => { form.hidden = false; okBox.hidden = true; errBox.textContent = ''; dlg.showModal(); };
  document.querySelectorAll('[data-open-event]').forEach((el) => el.addEventListener('click', (e) => { e.preventDefault(); open(); }));
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });   // click on the backdrop

  form.elements.event_type.addEventListener('change', () => { other.hidden = form.elements.event_type.value !== 'Other'; });
  form.elements.date.min = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.textContent = '';
    if (form.elements._honey.value) return;
    const f = form.elements;
    const name = f.full_name.value.trim();
    const phone = f.phone.value.trim();
    const email = f.email.value.trim();
    const fail = (msg, el) => { errBox.textContent = msg; el.focus(); };
    if (name.length < 2) return fail('Please enter your name.', f.full_name);
    if (!/^[0-9+() -]{7,24}$/.test(phone)) return fail('Please enter a valid phone number.', f.phone);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('Please enter a valid email address.', f.email);
    if (!f.event_type.value) return fail('Please choose the type of event.', f.event_type);
    if (f.event_type.value === 'Other' && f.event_other.value.trim().length < 2) return fail('Please tell us what kind of event.', f.event_other);
    if (!f.date.value) return fail('Please choose the event date.', f.date);
    const guests = Number(f.guests.value);
    if (!Number.isInteger(guests) || guests < 1 || guests > 1000) return fail('Please enter the expected number of guests.', f.guests);
    if (!isConfigured) { errBox.textContent = 'Online requests are unavailable right now. Please call 0915 875 4860.'; return; }

    const details = {
      event_type: f.event_type.value === 'Other' ? `Other: ${f.event_other.value.trim()}` : f.event_type.value,
      venue: f.venue.value, date: f.date.value, time: f.time.value, guests: String(guests), notes: f.notes.value.trim(),
    };
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    const { error } = await supabase.rpc('submit_inquiry', { p_kind: 'event', p_full_name: name, p_phone: phone, p_email: email, p_details: details });
    btn.disabled = false;
    if (error) {
      errBox.textContent = /RATE_LIMIT/.test(error.message) ? 'Too many requests right now. Please call 0915 875 4860.' : 'Sorry, we could not send your request. Please try again or call 0915 875 4860.';
      return;
    }
    form.reset();
    other.hidden = true;
    form.hidden = true;
    okBox.hidden = false;
  });
}
