// Shared helpers for the ordering page and staff dashboard.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const env = window.__ENV || {};
export const isConfigured = Boolean(
  env.SUPABASE_URL && env.SUPABASE_ANON_KEY && !/YOUR-/.test(env.SUPABASE_URL + env.SUPABASE_ANON_KEY)
);

export const supabase = isConfigured
  ? createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    })
  : null;

const pesoFmt = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
export const peso = (n) => pesoFmt.format(Number(n) || 0);

export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Only allow site-relative or https image URLs in src attributes.
export const safeImg = (u) => (u && /^(assets\/|https:\/\/)/.test(u) ? u : 'assets/brand/logo-mark.png');

export const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '';

export const STATUS_LABEL = {
  pending: 'Pending', preparing: 'Preparing', ready: 'Ready', completed: 'Completed', cancelled: 'Cancelled',
};
export const TYPE_LABEL = { delivery: 'Delivery', pickup: 'Pickup', dine_in: 'Dine in', room_delivery: 'Room delivery' };

// Database errors look like "CODE: Friendly message"; show only the message.
export function friendlyError(err) {
  const msg = (err && err.message) || 'Something went wrong. Please try again.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Network problem. Check your connection and try again.';
  if (/row-level security|permission denied/i.test(msg)) return 'You do not have permission to do that.';
  if (/violates check constraint/i.test(msg)) return 'One of the values is not allowed (for example a price must be above zero).';
  if (/duplicate key/i.test(msg)) return 'That value already exists. Please choose a different one.';
  if (/violates foreign key/i.test(msg)) return 'This record is still in use and cannot be removed. Hide it instead.';
  return msg.replace(/^[A-Z_]{4,}:\s*/, '');
}

let toastTimer;
export function toast(message, kind = 'ok') {
  let el = document.getElementById('shop-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'shop-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.className = `shop-toast ${kind} show`;
  el.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4500);
}

export const debounce = (fn, ms = 250) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

// Parse and validate a money input. Returns { ok, value, message }.
export function parsePrice(raw, { max = 1000000 } = {}) {
  const s = String(raw ?? '').trim().replace(/,/g, '');
  if (s === '') return { ok: false, message: 'Enter a price.' };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, message: 'Use a positive number with at most 2 decimals.' };
  const value = Number(s);
  if (!(value > 0)) return { ok: false, message: 'Price must be greater than zero.' };
  if (value > max) return { ok: false, message: `Price cannot exceed ${peso(max)}.` };
  return { ok: true, value };
}
