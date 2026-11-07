-- Transportation on the Services page: motorcycle rental (2 motorcycles) and airport pick-up (1 car).
-- The list is edited in the staff dashboard (Website > Transportation); requests arrive under Inquiries > Transport.

alter type public.inquiry_kind add value if not exists 'transport';

create table if not exists public.transport_services (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  description text not null default '' check (char_length(description) <= 300),
  price_label text not null default '' check (char_length(price_label) <= 60),
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists transport_services_order_idx on public.transport_services (sort_order, created_at);
alter table public.transport_services enable row level security;
drop policy if exists transport_services_select on public.transport_services;
create policy transport_services_select on public.transport_services for select using (is_active or public.is_staff());
drop policy if exists transport_services_write on public.transport_services;
create policy transport_services_write on public.transport_services for all using (public.is_staff()) with check (public.is_staff());
revoke all on public.transport_services from anon, authenticated;
grant select on public.transport_services to anon, authenticated;
grant insert, update, delete on public.transport_services to authenticated;

insert into public.transport_services (name, description, price_label, sort_order)
select v.name, v.description, v.price_label, v.sort_order from (values
  ('Motorcycle rental', 'Two motorcycles are available to rent for getting around Candijay and nearby places.', 'Ask for rates', 10),
  ('Airport pick-up', 'Our car can pick you up at the airport. Tell us your flight and arrival time and we will arrange it.', 'Ask for rates', 20)
) as v (name, description, price_label, sort_order) where not exists (select 1 from public.transport_services);

-- requests: accept the 'transport' kind and its fields
create or replace function public.submit_inquiry(
  p_kind      text,
  p_full_name text,
  p_phone     text,
  p_email     text,
  p_details   jsonb
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_name    text := btrim(coalesce(p_full_name, ''));
  v_phone   text := btrim(coalesce(p_phone, ''));
  v_email   text := nullif(btrim(coalesce(p_email, '')), '');
  v_details jsonb;
begin
  if p_kind not in ('booking', 'table', 'message', 'massage', 'event', 'transport') then
    raise exception 'INVALID_KIND: Unknown request type.';
  end if;
  if char_length(v_name) not between 2 and 80 then
    raise exception 'INVALID_NAME: Please enter your name.';
  end if;
  if v_phone !~ '^[0-9+() -]{7,24}$' then
    raise exception 'INVALID_PHONE: Please enter a valid phone number.';
  end if;
  if v_email is not null and (char_length(v_email) > 120 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'INVALID_EMAIL: Please enter a valid email address.';
  end if;
  if p_details is null or jsonb_typeof(p_details) <> 'object' then
    p_details := '{}'::jsonb;
  end if;
  if (select count(*) from public.inquiries where created_at > now() - interval '10 minutes') >= 40 then
    raise exception 'RATE_LIMIT: Too many requests right now. Please call us at 0915 875 4860.';
  end if;

  select coalesce(jsonb_object_agg(key, left(btrim(value), 500)), '{}'::jsonb) into v_details
  from jsonb_each_text(p_details)
  where key in ('check_in', 'check_out', 'guests', 'room_preference', 'date', 'time',
                'party_size', 'special_request', 'notes', 'message', 'massage_type', 'service_type', 'address', 'event_type', 'venue',
                'transport_type', 'days', 'flight')
    and btrim(value) <> '';

  insert into public.inquiries (kind, full_name, phone, email, details)
  values (p_kind::public.inquiry_kind, v_name, v_phone, v_email, v_details);
end $$;

revoke execute on function public.submit_inquiry(text, text, text, text, jsonb) from public;
grant  execute on function public.submit_inquiry(text, text, text, text, jsonb) to anon, authenticated;

-- phone notification text for the new kind
create or replace function public.notify_staff_push()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_secret  text;
  v_payload jsonb;
  v_type    text;
  v_kind    text;
begin
  select value into v_secret from public.push_config where key = 'webhook_secret';
  if v_secret is null then
    return new;
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
    v_kind := case new.kind::text when 'booking' then 'room booking' when 'table' then 'table reservation'
                            when 'message' then 'message' when 'massage' then 'massage request'
                            when 'event' then 'event request' when 'transport' then 'transport request' else new.kind::text end;
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
    null;
  end;
  return new;
end $function$;
