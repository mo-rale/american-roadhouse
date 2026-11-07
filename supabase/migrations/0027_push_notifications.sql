-- Phone notifications for staff: a push message when a new order or inquiry arrives, or a customer changes an order.
-- Phones sign up from the staff dashboard (Alerts button). A database trigger calls the "send-push" edge function,
-- which sends the messages and puts the number of waiting items on the app icon.
-- The shared secret that protects the function is stored in push_config (never in this file): see docs/PUSH_NOTIFICATIONS.md.

create extension if not exists pg_net;

create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
drop policy if exists push_subscriptions_own on public.push_subscriptions;
create policy push_subscriptions_own on public.push_subscriptions for all
  using (user_id = auth.uid() and public.is_staff()) with check (user_id = auth.uid() and public.is_staff());
revoke all on public.push_subscriptions from anon, authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

create table if not exists public.push_config (
  key   text primary key,
  value text not null
);
alter table public.push_config enable row level security;       -- no policies: only the database itself reads it
revoke all on public.push_config from anon, authenticated;

create or replace function public.notify_staff_push() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_secret  text;
  v_payload jsonb;
  v_type    text;
  v_kind    text;
begin
  select value into v_secret from public.push_config where key = 'webhook_secret';
  if v_secret is null then
    return new;                                                    -- not set up yet: do nothing
  end if;

  if tg_table_name = 'orders' then
    v_type := case new.order_type when 'delivery' then 'Delivery' when 'pickup' then 'Pickup'
                                  when 'dine_in' then 'Dine in' when 'room_delivery' then 'Room delivery' else new.order_type end;
    if tg_op = 'INSERT' then
      v_payload := jsonb_build_object('title', 'New order #' || new.order_number,
        'body', new.customer_name || ' · ₱' || to_char(new.total, 'FM999,999,990.00') || ' · ' || v_type,
        'tag', 'order-' || new.id, 'url', '/qsnqpbzovgcamaqq.html');
    else
      v_payload := jsonb_build_object('title', 'Order #' || new.order_number || ' was changed',
        'body', new.customer_name || ' · now ₱' || to_char(new.total, 'FM999,999,990.00') || ' · ' || v_type,
        'tag', 'order-' || new.id, 'url', '/qsnqpbzovgcamaqq.html');
    end if;
  elsif tg_table_name = 'inquiries' then
    v_kind := case new.kind when 'booking' then 'room booking' when 'table' then 'table reservation'
                            when 'message' then 'message' when 'massage' then 'massage request'
                            when 'event' then 'event request' else new.kind end;
    v_payload := jsonb_build_object('title', 'New ' || v_kind, 'body', new.full_name,
      'tag', 'inquiry-' || new.id, 'url', '/qsnqpbzovgcamaqq.html');
  else
    return new;
  end if;

  begin
    perform net.http_post(
      url     := 'https://ywdpitfavhokktfcqqca.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret),
      body    := v_payload);
  exception when others then
    null;                                                           -- a notification problem must never block an order
  end;
  return new;
end $$;

drop trigger if exists push_new_order on public.orders;
create trigger push_new_order after insert on public.orders
  for each row execute function public.notify_staff_push();

drop trigger if exists push_edited_order on public.orders;
create trigger push_edited_order after update on public.orders
  for each row when (new.edited_at is not null and new.edited_at is distinct from old.edited_at)
  execute function public.notify_staff_push();

drop trigger if exists push_new_inquiry on public.inquiries;
create trigger push_new_inquiry after insert on public.inquiries
  for each row execute function public.notify_staff_push();
