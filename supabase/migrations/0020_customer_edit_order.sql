-- Customers can change their own order (items, quantities, notes) while it is still Pending or Preparing.
-- Once the kitchen marks it Ready (or it is completed / cancelled) it is locked.
-- Prices and stock are worked out here again, exactly as in place_order; the old portions go back into stock first.
alter table public.orders add column if not exists edited_at timestamptz;

create or replace function public.update_order(p_order_id uuid, p_items jsonb, p_notes text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_order  public.orders;
  v_notes  text := nullif(btrim(coalesce(p_notes, '')), '');
  v_priced jsonb;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: Please try again.';
  end if;
  select * into v_order from public.orders where id = p_order_id and user_id = v_uid for update;
  if not found then
    raise exception 'NOT_FOUND: We could not find that order on this device.';
  end if;
  if v_order.status not in ('pending', 'preparing') then
    raise exception 'LOCKED: This order is already %, so it can no longer be changed. Please call 0915 875 4860.', v_order.status;
  end if;
  if v_notes is not null and char_length(v_notes) > 500 then
    raise exception 'INVALID_NOTES: Notes must be 500 characters or fewer.';
  end if;

  -- put the old portions back, then lock the items being ordered now
  update public.menu_items m set stock = m.stock + oi.quantity
    from public.order_items oi
   where oi.order_id = v_order.id and oi.menu_item_id = m.id and m.stock is not null;
  if jsonb_typeof(p_items) = 'array' then
    perform m.id from public.menu_items m
     where m.id in (select (x ->> 'id')::uuid from jsonb_array_elements(p_items) x)
     order by m.id for update;
  end if;

  v_priced := public._price_cart(p_items, '');     -- raises if the cart is empty or an item is unavailable (which also undoes the stock change above)

  delete from public.order_items where order_id = v_order.id;
  insert into public.order_items (order_id, menu_item_id, item_name, unit_price, quantity, line_total)
  select v_order.id, (l ->> 'id')::uuid, l ->> 'name', (l ->> 'price')::numeric, (l ->> 'qty')::int, (l ->> 'line_total')::numeric
  from jsonb_array_elements(v_priced -> 'lines') l;

  update public.menu_items m set stock = m.stock - (l ->> 'qty')::int
    from jsonb_array_elements(v_priced -> 'lines') l
   where m.id = (l ->> 'id')::uuid and m.stock is not null;

  update public.orders
     set subtotal = (v_priced ->> 'subtotal')::numeric,
         discount_code = null,
         discount_total = 0,
         total = (v_priced ->> 'total')::numeric + v_order.delivery_fee,
         notes = v_notes,
         edited_at = now()
   where id = v_order.id;

  return jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number,
                            'total', (v_priced ->> 'total')::numeric + v_order.delivery_fee, 'status', v_order.status);
end $$;

revoke all on function public.update_order(uuid, jsonb, text) from public, anon;
grant execute on function public.update_order(uuid, jsonb, text) to authenticated;

-- "Your recent orders": also say which orders belong to this browser (so they can be edited from the list)
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
    select ord.id, (ord.user_id = v_uid) as mine, ord.order_number, ord.status, ord.order_type, ord.created_at,
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
