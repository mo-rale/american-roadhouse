-- Paid extras (add-ons) per menu section, for example "Extra mozzarella cheese" on every pizza.
-- Staff manage them in the dashboard (Menu > Extras). A customer ticks extras when adding a dish; the price of the
-- dish plus its extras is worked out here (never in the browser) and each order line keeps a snapshot of the extras.

create table if not exists public.menu_extras (
  id          uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.categories (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  price       numeric(10,2) not null check (price >= 0),
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists menu_extras_category_idx on public.menu_extras (category_id, sort_order);
alter table public.menu_extras enable row level security;
drop policy if exists menu_extras_select on public.menu_extras;
create policy menu_extras_select on public.menu_extras for select using (is_active or public.is_staff());
drop policy if exists menu_extras_write on public.menu_extras;
create policy menu_extras_write on public.menu_extras for all using (public.is_staff()) with check (public.is_staff());
grant select on public.menu_extras to anon, authenticated;
grant insert, update, delete on public.menu_extras to authenticated;

do $$ begin alter publication supabase_realtime add table public.menu_extras; exception when duplicate_object then null; end $$;

alter table public.order_items add column if not exists extras jsonb not null default '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- Pricing: a cart line is { id, qty, extras: [extra ids] }. Several lines can be the same dish with different extras;
-- stock is counted across all of a dish's lines.
-- ---------------------------------------------------------------------------
create or replace function public._price_cart(p_items jsonb, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_code     text := nullif(btrim(coalesce(p_code, '')), '');
  v_el       jsonb;
  v_id       uuid;
  v_qty      int;
  v_ex_id    uuid;
  m          record;
  ex         record;
  v_used     jsonb := '{}'::jsonb;
  v_tot      int;
  v_lines    jsonb := '[]'::jsonb;
  v_subtotal numeric(12,2) := 0;
  v_bad      text := '';
  v_unit     numeric(12,2);
  v_ex_total numeric(12,2);
  v_ex_json  jsonb;
  v_disc     public.discounts;
  v_discount numeric(12,2) := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) not between 1 and 40 then
    raise exception 'EMPTY_CART: Your cart is empty or invalid.';
  end if;

  for v_el in select * from jsonb_array_elements(p_items) loop
    begin
      v_id := (v_el ->> 'id')::uuid;
      v_qty := (v_el ->> 'qty')::int;
    exception when others then
      raise exception 'INVALID_QTY: Quantities must be between 1 and 50.';
    end;
    if v_id is null or v_qty is null or v_qty < 1 or v_qty > 50 then
      raise exception 'INVALID_QTY: Quantities must be between 1 and 50.';
    end if;

    select mi.id, mi.name, mi.price, mi.stock, mi.category_id,
           (mi.is_visible and mi.is_available and mi.price is not null and coalesce(c.is_visible, true)) as ok
      into m
      from public.menu_items mi left join public.categories c on c.id = mi.category_id
     where mi.id = v_id;
    if not found then
      v_bad := v_bad || case when v_bad = '' then '' else ', ' end || 'An item';
      continue;
    end if;
    if not m.ok then
      v_bad := v_bad || case when v_bad = '' then '' else ', ' end || m.name;
      continue;
    end if;

    v_tot := coalesce((v_used ->> v_id::text)::int, 0) + v_qty;
    v_used := jsonb_set(v_used, array[v_id::text], to_jsonb(v_tot), true);
    if m.stock is not null and v_tot > m.stock then
      v_bad := v_bad || case when v_bad = '' then '' else ', ' end ||
               (case when m.stock > 0 then m.name || ' (only ' || m.stock || ' left)' else m.name end);
      continue;
    end if;

    v_ex_total := 0;
    v_ex_json := '[]'::jsonb;
    if jsonb_typeof(v_el -> 'extras') = 'array' then
      if jsonb_array_length(v_el -> 'extras') > 12 then
        raise exception 'INVALID_EXTRAS: Too many extras on one dish.';
      end if;
      for v_ex_id in select distinct (x.value)::uuid from jsonb_array_elements_text(v_el -> 'extras') as x(value) order by 1 loop
        select e.id, e.name, e.price into ex
          from public.menu_extras e
         where e.id = v_ex_id and e.is_active and e.category_id = m.category_id;
        if not found then
          raise exception 'ITEM_UNAVAILABLE: An extra for % is no longer available. Please update your cart.', m.name;
        end if;
        v_ex_total := v_ex_total + ex.price;
        v_ex_json := v_ex_json || jsonb_build_array(jsonb_build_object('id', ex.id, 'name', ex.name, 'price', ex.price));
      end loop;
    end if;

    v_unit := m.price + v_ex_total;
    v_subtotal := v_subtotal + v_unit * v_qty;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'id', m.id, 'name', m.name, 'price', v_unit, 'qty', v_qty, 'line_total', v_unit * v_qty, 'extras', v_ex_json));
  end loop;

  if v_bad <> '' then
    raise exception 'ITEM_UNAVAILABLE: % is no longer available. Please update your cart.', v_bad;
  end if;

  if v_code is not null then
    select * into v_disc from public.discounts d
    where lower(d.code) = lower(v_code) and d.is_active
      and (d.starts_at is null or d.starts_at <= now())
      and (d.ends_at   is null or d.ends_at   >= now());
    if not found then
      raise exception 'INVALID_DISCOUNT: That discount code is not valid.';
    end if;
    if v_subtotal < v_disc.min_subtotal then
      raise exception 'DISCOUNT_MIN: This code needs a minimum order of %.', v_disc.min_subtotal;
    end if;
    v_discount := case when v_disc.type = 'percent'
                       then round(v_subtotal * v_disc.value / 100, 2)
                       else least(v_disc.value, v_subtotal) end;
  end if;

  return jsonb_build_object(
    'subtotal', v_subtotal, 'discount_total', v_discount, 'total', v_subtotal - v_discount,
    'discount_code', case when v_code is null then null else v_disc.code end,
    'lines', v_lines);
end $$;

-- ---------------------------------------------------------------------------
-- place_order: order lines keep their extras; stock is taken per dish across lines
-- ---------------------------------------------------------------------------
create or replace function public.place_order(
  p_customer_name text,
  p_phone         text,
  p_email         text,
  p_order_type    text,
  p_room_number   text,
  p_notes         text,
  p_discount_code text,
  p_items         jsonb,
  p_delivery_address text default null,
  p_delivery_lat  numeric default null,
  p_delivery_lng  numeric default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
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
     subtotal, discount_code, discount_total, total, delivery_fee, delivery_km, delivery_lat, delivery_lng)
  values
    (v_uid, v_customer, v_name, v_phone, p_order_type,
     case when p_order_type = 'room_delivery' then v_room end,
     case when p_order_type = 'delivery' then v_addr end, v_notes,
     (v_priced ->> 'subtotal')::numeric, v_priced ->> 'discount_code',
     (v_priced ->> 'discount_total')::numeric, (v_priced ->> 'total')::numeric + v_fee,
     v_fee, round(v_km, 2), p_delivery_lat, p_delivery_lng)
  returning * into v_order;

  insert into public.order_items (order_id, menu_item_id, item_name, unit_price, quantity, line_total, extras)
  select v_order.id, (l ->> 'id')::uuid, l ->> 'name', (l ->> 'price')::numeric,
         (l ->> 'qty')::int, (l ->> 'line_total')::numeric, coalesce(l -> 'extras', '[]'::jsonb)
  from jsonb_array_elements(v_priced -> 'lines') l;

  -- take the portions out of stock, one update per dish (items without a stock number are not tracked)
  update public.menu_items m set stock = m.stock - s.q
    from (select (l ->> 'id')::uuid as id, sum((l ->> 'qty')::int)::int as q
            from jsonb_array_elements(v_priced -> 'lines') l group by 1) s
   where m.id = s.id and m.stock is not null;

  return jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number,
                            'total', v_order.total, 'status', v_order.status);
end $$;

-- ---------------------------------------------------------------------------
-- update_order (customer edits): same, with extras
-- ---------------------------------------------------------------------------
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

  -- put the old portions back (one update per dish), then lock the items being ordered now
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
         total = (v_priced ->> 'total')::numeric + v_order.delivery_fee,
         notes = v_notes,
         edited_at = now()
   where id = v_order.id;

  return jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number,
                            'total', (v_priced ->> 'total')::numeric + v_order.delivery_fee, 'status', v_order.status);
end $$;

-- ---------------------------------------------------------------------------
-- lookup_orders: the lines also carry their extras
-- ---------------------------------------------------------------------------
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
           (select coalesce(jsonb_agg(jsonb_build_object('name', i.item_name, 'qty', i.quantity, 'line_total', i.line_total, 'extras', i.extras)), '[]'::jsonb)
              from public.order_items i where i.order_id = ord.id) as items
    from public.orders ord
    where right(regexp_replace(ord.customer_phone, '\D', '', 'g'), 10) = v_key
      and ord.created_at > now() - interval '30 days'
    order by ord.created_at desc
    limit 10
  ) o;

  return v_result;
end $$;

-- Tighten table privileges (row level security still decides who may read or write): customers only read extras and settings.
revoke all on public.menu_extras from anon, authenticated;
grant select on public.menu_extras to anon, authenticated;
grant insert, update, delete on public.menu_extras to authenticated;
revoke all on public.order_lookup_log from anon, authenticated;
revoke all on public.delivery_settings from anon, authenticated;
grant select on public.delivery_settings to anon, authenticated;
grant update on public.delivery_settings to authenticated;
