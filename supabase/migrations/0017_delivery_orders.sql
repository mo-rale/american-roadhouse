-- Delivery orders: customers can ask for their food to be delivered to an address.
-- Old "pickup" orders stay valid and readable; the website now offers Delivery instead of Pickup.
alter table public.orders add column if not exists delivery_address text
  check (delivery_address is null or char_length(delivery_address) between 6 and 300);

alter table public.orders drop constraint if exists orders_order_type_check;
alter table public.orders add constraint orders_order_type_check
  check (order_type in ('delivery', 'pickup', 'dine_in', 'room_delivery'));

-- Delivery fee settings (one row). Staff change these in the dashboard; customers can read them to see the fee.
-- fee = base_fee for the first base_km, then per_km_fee for every extra km, rounded up to a whole peso.
-- Distance = straight line from the store to the customer's pin x road_factor (roads are longer than a straight line).
create table if not exists public.delivery_settings (
  id          int primary key default 1 check (id = 1),
  is_active   boolean not null default true,
  store_lat   numeric(9,6) check (store_lat between -90 and 90),
  store_lng   numeric(9,6) check (store_lng between -180 and 180),
  base_fee    numeric(8,2) not null default 50  check (base_fee >= 0),
  base_km     numeric(5,2) not null default 2   check (base_km >= 0),
  per_km_fee  numeric(8,2) not null default 15  check (per_km_fee >= 0),
  road_factor numeric(4,2) not null default 1.3 check (road_factor between 1 and 3),
  max_km      numeric(5,1) not null default 15  check (max_km > 0),
  updated_at  timestamptz not null default now()
);
insert into public.delivery_settings (id) values (1) on conflict do nothing;
alter table public.delivery_settings enable row level security;
drop policy if exists delivery_settings_select on public.delivery_settings;
create policy delivery_settings_select on public.delivery_settings for select using (true);
drop policy if exists delivery_settings_write on public.delivery_settings;
create policy delivery_settings_write on public.delivery_settings for update
  using (public.is_staff()) with check (public.is_staff());
grant select on public.delivery_settings to anon, authenticated;
grant update on public.delivery_settings to authenticated;

alter table public.orders add column if not exists delivery_fee numeric(10,2) not null default 0 check (delivery_fee >= 0);
alter table public.orders add column if not exists delivery_km  numeric(6,2);
alter table public.orders add column if not exists delivery_lat numeric(9,6);
alter table public.orders add column if not exists delivery_lng numeric(9,6);

-- place_order gains an optional delivery address (a new last parameter), so the old signature is replaced.
drop function if exists public.place_order(text, text, text, text, text, text, text, jsonb);
drop function if exists public.place_order(text, text, text, text, text, text, text, jsonb, text);

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

  -- Lock the ordered items so two customers cannot both take the last portion.
  if jsonb_typeof(p_items) = 'array' then
    perform m.id from public.menu_items m
     where m.id in (select (x ->> 'id')::uuid from jsonb_array_elements(p_items) x)
     order by m.id for update;
  end if;

  v_priced := public._price_cart(p_items, p_discount_code);

  -- Delivery fee, worked out here (never trusted from the browser) from the pin the customer dropped on the map.
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

  insert into public.order_items (order_id, menu_item_id, item_name, unit_price, quantity, line_total)
  select v_order.id, (l ->> 'id')::uuid, l ->> 'name', (l ->> 'price')::numeric,
         (l ->> 'qty')::int, (l ->> 'line_total')::numeric
  from jsonb_array_elements(v_priced -> 'lines') l;

  -- take the portions out of stock (items without a stock number are not tracked)
  update public.menu_items m
     set stock = m.stock - (l ->> 'qty')::int
    from jsonb_array_elements(v_priced -> 'lines') l
   where m.id = (l ->> 'id')::uuid and m.stock is not null;

  return jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number,
                            'total', v_order.total, 'status', v_order.status);
end $$;

revoke execute on function public.place_order(text, text, text, text, text, text, text, jsonb, text, numeric, numeric) from public, anon;
grant  execute on function public.place_order(text, text, text, text, text, text, text, jsonb, text, numeric, numeric) to authenticated;
