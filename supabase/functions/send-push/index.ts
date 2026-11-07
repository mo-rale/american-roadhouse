// Sends a Web Push message to every signed-up staff phone and sets the app-icon number.
// Called only by the database trigger (public.notify_staff_push), which sends a shared secret in x-push-secret.
// Secrets to set (Supabase > Edge Functions > Secrets): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_WEBHOOK_SECRET.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const secret = Deno.env.get('PUSH_WEBHOOK_SECRET');
  if (!secret || req.headers.get('x-push-secret') !== secret) return new Response('forbidden', { status: 403 });

  let msg: { title?: string; body?: string; tag?: string; url?: string };
  try { msg = await req.json(); } catch { return new Response('bad request', { status: 400 }); }

  webpush.setVapidDetails(
    Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com',
    Deno.env.get('VAPID_PUBLIC_KEY')!,
    Deno.env.get('VAPID_PRIVATE_KEY')!,
  );
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // what is waiting for staff, shown as the number on the app icon
  const [pending, fresh] = await Promise.all([
    sb.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    sb.from('inquiries').select('id', { count: 'exact', head: true }).eq('status', 'new'),
  ]);
  const badge = (pending.count ?? 0) + (fresh.count ?? 0);

  // only active staff accounts receive these
  const { data: staff } = await sb.from('profiles').select('id').eq('is_active', true);
  const ids = (staff ?? []).map((p: { id: string }) => p.id);
  if (!ids.length) return Response.json({ sent: 0 });
  const { data: subs } = await sb.from('push_subscriptions').select('id, endpoint, p256dh, auth').in('user_id', ids);

  const payload = JSON.stringify({ title: msg.title, body: msg.body, tag: msg.tag, url: msg.url ?? '/', badge });
  let sent = 0;
  const dead: string[] = [];
  await Promise.all((subs ?? []).map(async (s: { id: string; endpoint: string; p256dh: string; auth: string }) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: 'high' });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) dead.push(s.id);            // the phone removed the app or the permission
    }
  }));
  if (dead.length) await sb.from('push_subscriptions').delete().in('id', dead);
  return Response.json({ sent, removed: dead.length, badge });
});
