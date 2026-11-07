-- Box fee: a packaging fee added to delivery and pickup orders (not dine-in or room orders).
-- The amount is set in the staff dashboard (Delivery fee tab); it starts at 20 pesos.
-- The fee is copied onto each order, so changing it later does not change past orders.

alter table public.delivery_settings add column if not exists box_fee numeric(10,2) not null default 20 check (box_fee >= 0 and box_fee <= 100000);
alter table public.orders add column if not exists box_fee numeric(10,2) not null default 0;

create or replace function public.place_order(p_customer_name text, p_phone text, p_email text, p_order_type text, p_room_number text, p_notes text, p_discount_code text, p_items jsonb, p_delivery_address text DEFAULT NULL::text, p_delivery_lat numeric DEFAULT NULL::numeric, p_delivery_lng numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid      uuid := auth.uid();
  v_name     text := btrim(coalesce(p_customer_name, ''));
  v_phone    text := btrim(coalesce(p_phone, ''));
  v_email    text := nullif(btrim(coalesce(p_email, '')), '');
  v_room     text := nullif(btrim(coalesce(p_room_number, '')), '');
  v_notes    text := nullif(btrim(coalesce(p_notes, '')), '');
  v_addr     text := nullif(btrim(coalesce(p_delivery_address, '')), '');
  v_priced   jsonb;
  v_cfg      public.delivery_settings;
  v_km       numeric;
  v_fee      numeric(10,2) := 0;
  v_box      numeric(10,2) := 0;
  v_customer uuid;
  v_order    public.orders;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: Please try again.';
  end if;
  if char_length(v_name) not between 2 and 80 then
    raise exception 'INVALID_NAME: Please enter your name (2-80 characters).';
  end if;
  if v_phone !~ '^[0-9+() -]{7,20}$' then
    raise exception 'INVALID_PHONE: Please enter a valid phone number.';
  end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'INVALID_EMAIL: Please enter a valid email address.';
  end if;
  if p_order_type not in ('delivery', 'pickup', 'dine_in', 'room_delivery') then
    raise exception 'INVALID_TYPE: Please choose how you would like to receive your order.';
  end if;
  if p_order_type = 'room_delivery' and (v_room is null or char_length(v_room) > 20) then
    raise exception 'INVALID_ROOM: Please enter your room number.';
  end if;
  if p_order_type = 'delivery' and (v_addr is null or char_length(v_addr) not between 6 and 300) then
    raise exception 'INVALID_ADDRESS: Please enter your delivery address.';
  end if;
  if v_notes is not null and char_length(v_notes) > 500 then
    raise exception 'INVALID_NOTES: Notes must be 500 characters or fewer.';
  end if;
  if (select count(*) from public.orders where user_id = v_uid and status = 'pending') >= 5 then
    raise exception 'TOO_MANY_PENDING: You already have several pending orders. Please wait for the kitchen to confirm them.';
  end if;

  if jsonb_typeof(p_items) = 'array' then
    perform m.id from public.menu_items m
     where m.id in (select (x ->> 'id')::uuid from jsonb_array_elements(p_items) x)
     order by m.id for update;
  end if;

  v_priced := public._price_cart(p_items, p_discount_code);

  if p_order_type in ('delivery', 'pickup') then
    select coalesce(box_fee, 0) into v_box from public.delivery_settings where id = 1;
    v_box := coalesce(v_box, 0);
  end if;

  if p_order_type = 'delivery' then
    select * into v_cfg from public.delivery_settings where id = 1;
    if v_cfg.is_active is false then
      raise exception 'DELIVERY_OFF: Delivery is not available right now. Please choose dine-in or call 0915 875 4860.';
    end if;
    if v_cfg.store_lat is not null and v_cfg.store_lng is not null then
      if p_delivery_lat is null or p_delivery_lng is null
         or p_delivery_lat not between -90 and 90 or p_delivery_lng not between -180 and 180 then
        raise exception 'NO_PIN: Please pin your delivery location on the map.';
      end if;
      v_km := 6371 * 2 * asin(sqrt(
                power(sin(radians(p_delivery_lat - v_cfg.store_lat) / 2), 2) +
                cos(radians(v_cfg.store_lat)) * cos(radians(p_delivery_lat)) *
                power(sin(radians(p_delivery_lng - v_cfg.store_lng) / 2), 2))) * v_cfg.road_factor;
      if v_km > v_cfg.max_km then
        raise exception 'OUT_OF_RANGE: Sorry, that location is about % km away. We deliver up to % km.', round(v_km, 1), v_cfg.max_km;
      end if;
      v_fee := ceil(v_cfg.base_fee + greatest(0, v_km - v_cfg.base_km) * v_cfg.per_km_fee);
    end if;
  end if;

  insert into public.customers (user_id, name, phone, email)
  values (v_uid, v_name, v_phone, v_email)
  on conflict (user_id) do update set name = excluded.name, phone = excluded.phone, email = excluded.email
  returning id into v_customer;

  insert into public.orders
    (user_id, customer_id, customer_name, customer_phone, order_type, room_number, delivery_address, notes,
     subtotal, discount_code, discount_total, total, delivery_fee, box_fee, delivery_km, delivery_lat, delivery_lng)
  values
    (v_uid, v_customer, v_name, v_phone, p_order_type,
     case when p_order_type = 'room_delivery' then v_room end,
     case when p_order_type = 'delivery' then v_addr end, v_notes,
     (v_priced ->> 'subtotal')::numeric, v_priced ->> 'discount_code',
     (v_priced ->> 'discount_total')::numeric, (v_priced ->> 'total')::numeric + v_fee + v_box,
     v_fee, v_box, round(v_km, 2), p_delivery_lat, p_delivery_lng)
  returning * into v_order;

  insert into public.order_items (order_id, menu_item_id, item_name, unit_price, quantity, line_total, extras)
  select v_order.id, (l ->> 'id')::uuid, l ->> 'name', (l ->> 'price')::numeric,
         (l ->> 'qty')::int, (l ->> 'line_total')::numeric, coalesce(l -> 'extras', '[]'::jsonb)
  from jsonb_array_elements(v_priced -> 'lines') l;

  update public.menu_items m set stock = m.stock - s.q
    from (select (l ->> 'id')::uuid as id, sum((l ->> 'qty')::int)::int as q
            from jsonb_array_elements(v_priced -> 'lines') l group by 1) s
   where m.id = s.id and m.stock is not null;

  return jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number,
                            'total', v_order.total, 'status', v_order.status);
end $function$;

create or replace function public.update_order(p_order_id uuid, p_items jsonb, p_notes text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  update public.menu_items m set stock = m.stock + s.q
    from (select menu_item_id, sum(quantity)::int as q from public.order_items where order_id = v_order.id group by 1) s
   where s.menu_item_id = m.id and m.stock is not null;
  if jsonb_typeof(p_items) = 'array' then
    perform m.id from public.menu_items m
     where m.id in (select (x ->> 'id')::uuid from jsonb_array_elements(p_items) x)
     order by m.id for update;
  end if;

  v_priced := public._price_cart(p_items, '');

  delete from public.order_items where order_id = v_order.id;
  insert into public.order_items (order_id, menu_item_id, item_name, unit_price, quantity, line_total, extras)
  select v_order.id, (l ->> 'id')::uuid, l ->> 'name', (l ->> 'price')::numeric, (l ->> 'qty')::int, (l ->> 'line_total')::numeric,
         coalesce(l -> 'extras', '[]'::jsonb)
  from jsonb_array_elements(v_priced -> 'lines') l;

  update public.menu_items m set stock = m.stock - s.q
    from (select (l ->> 'id')::uuid as id, sum((l ->> 'qty')::int)::int as q
            from jsonb_array_elements(v_priced -> 'lines') l group by 1) s
   where m.id = s.id and m.stock is not null;

  update public.orders
     set subtotal = (v_priced ->> 'subtotal')::numeric,
         discount_code = null,
         discount_total = 0,
         total = (v_priced ->> 'total')::numeric + v_order.delivery_fee + v_order.box_fee,
         notes = v_notes,
         edited_at = now()
   where id = v_order.id;

  return jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number,
                            'total', (v_priced ->> 'total')::numeric + v_order.delivery_fee + v_order.box_fee, 'status', v_order.status);
end $function$;

create or replace function public.lookup_orders(p_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
           ord.subtotal, ord.discount_total, ord.delivery_fee, ord.box_fee, ord.total,
           (select coalesce(jsonb_agg(jsonb_build_object('name', i.item_name, 'qty', i.quantity, 'line_total', i.line_total, 'extras', i.extras)), '[]'::jsonb)
              from public.order_items i where i.order_id = ord.id) as items
    from public.orders ord
    where right(regexp_replace(ord.customer_phone, '\D', '', 'g'), 10) = v_key
      and ord.created_at > now() - interval '30 days'
    order by ord.created_at desc
    limit 10
  ) o;

  return v_result;
end $function$;
