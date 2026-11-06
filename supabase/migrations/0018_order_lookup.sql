-- "Your orders": a customer enters the phone number used on an order and sees their recent orders.
-- Only the order status, items and totals come back (no name, address, notes or coordinates), only the last 30 days,
-- at most 10 orders, and lookups are rate limited so phone numbers cannot be scanned.
create table if not exists public.order_lookup_log (
  id         bigint generated always as identity primary key,
  user_id    uuid,
  phone_key  text not null,
  created_at timestamptz not null default now()
);
create index if not exists order_lookup_log_user_idx  on public.order_lookup_log (user_id, created_at desc);
create index if not exists order_lookup_log_phone_idx on public.order_lookup_log (phone_key, created_at desc);
alter table public.order_lookup_log enable row level security;   -- no policies: only the function below writes to it

create or replace function public.lookup_orders(p_phone text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_key    text;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: Please try again.';
  end if;
  if char_length(v_digits) < 10 or char_length(v_digits) > 15 then
    raise exception 'INVALID_PHONE: Please enter the full phone number you used for the order.';
  end if;
  v_key := right(v_digits, 10);

  delete from public.order_lookup_log where created_at < now() - interval '1 day';
  if (select count(*) from public.order_lookup_log where user_id = v_uid and created_at > now() - interval '10 minutes') >= 8
     or (select count(*) from public.order_lookup_log where phone_key = v_key and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'TOO_MANY_LOOKUPS: Too many attempts. Please wait a few minutes or call 0915 875 4860.';
  end if;
  insert into public.order_lookup_log (user_id, phone_key) values (v_uid, v_key);

  select coalesce(jsonb_agg(o order by o.created_at desc), '[]'::jsonb) into v_result
  from (
    select ord.order_number, ord.status, ord.order_type, ord.created_at,
           ord.subtotal, ord.discount_total, ord.delivery_fee, ord.total,
           (select coalesce(jsonb_agg(jsonb_build_object('name', i.item_name, 'qty', i.quantity, 'line_total', i.line_total)), '[]'::jsonb)
              from public.order_items i where i.order_id = ord.id) as items
    from public.orders ord
    where right(regexp_replace(ord.customer_phone, '\D', '', 'g'), 10) = v_key
      and ord.created_at > now() - interval '30 days'
    order by ord.created_at desc
    limit 10
  ) o;

  return v_result;
end $$;

revoke execute on function public.lookup_orders(text) from public, anon;
grant  execute on function public.lookup_orders(text) to authenticated;
