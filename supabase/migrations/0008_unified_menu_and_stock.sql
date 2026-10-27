-- One menu for the whole restaurant, plus stock tracking.
--   * The Restaurant page's sections and dishes (restaurant_sections / restaurant_dishes) are merged into
--     categories / menu_items, so the Restaurant page, the ordering page and the staff "Menu" tab all read
--     and edit the same list. A category now belongs to a venue: 'main' or 'roofdeck'.
--   * menu_items.price may be empty ("Ask for today's price"); such items are listed but cannot be ordered.
--   * menu_items.stock: empty = not tracked. Orders subtract from it, cancelling an order puts it back, and
--     an item at 0 shows as sold out.
-- Runs as one transaction: if the copy check fails nothing is changed.

-- 1. categories belong to a venue
alter table public.categories
  add column venue text not null default 'roofdeck' check (venue in ('main', 'roofdeck'));

-- 2. optional price, stock
alter table public.menu_items alter column price drop not null;
alter table public.menu_items drop constraint menu_items_price_check;
alter table public.menu_items
  add constraint menu_items_price_check check (price is null or (price > 0 and price <= 1000000));
alter table public.menu_items add column stock integer check (stock is null or stock >= 0);

-- 3. sections become categories
update public.categories
   set venue = 'roofdeck', sort_order = case slug when 'roofdeck-grill' then 1 else 2 end
 where slug in ('roofdeck-grill', 'lemon-drinks');

update public.categories set venue = 'main' where slug = 'snacks';
delete from public.categories c
 where c.slug = 'snacks' and not exists (select 1 from public.menu_items m where m.category_id = c.id);

update public.categories c
   set venue = 'main', sort_order = s.sort_order, is_visible = s.is_visible
  from public.restaurant_sections s
 where lower(c.name) = lower(s.name);

insert into public.categories (name, slug, sort_order, is_visible, venue)
select s.name,
       trim(both '-' from lower(regexp_replace(btrim(s.name), '[^a-zA-Z0-9]+', '-', 'g'))),
       s.sort_order, s.is_visible, 'main'
  from public.restaurant_sections s
 where not exists (select 1 from public.categories c where lower(c.name) = lower(s.name));

-- 4. dishes become menu items (same ids; no duplicate price-history entry)
alter table public.menu_items disable trigger log_price_menu_items;
insert into public.menu_items
  (id, category_id, name, description, price, image_url, is_visible, is_available, sort_order, created_at)
select d.id, c.id, d.name, d.description, d.price, d.image_url, d.is_visible, true, d.sort_order, d.created_at
  from public.restaurant_dishes d
  join public.restaurant_sections s on s.id = d.section_id
  join public.categories c on lower(c.name) = lower(s.name);
alter table public.menu_items enable trigger log_price_menu_items;

do $$
begin
  if (select count(*) from public.restaurant_dishes)
     <> (select count(*) from public.menu_items m where m.id in (select id from public.restaurant_dishes)) then
    raise exception 'Migration check failed: not every restaurant dish was copied to menu_items';
  end if;
end $$;

drop table public.restaurant_dishes;
drop table public.restaurant_sections;

-- 5. pricing and ordering with stock
create or replace function public._price_cart(p_items jsonb, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_code     text := nullif(btrim(coalesce(p_code, '')), '');
  v_subtotal numeric(12,2);
  v_bad      text;
  v_lines    jsonb;
  v_disc     public.discounts;
  v_discount numeric(12,2) := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) not between 1 and 40 then
    raise exception 'EMPTY_CART: Your cart is empty or invalid.';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_items) as x(id uuid, qty int)
             where x.id is null or x.qty is null or x.qty < 1 or x.qty > 50) then
    raise exception 'INVALID_QTY: Quantities must be between 1 and 50.';
  end if;

  with cart as (
    select x.id, sum(x.qty)::int as qty
    from jsonb_to_recordset(p_items) as x(id uuid, qty int) group by x.id
  ), priced as (
    select cart.id, cart.qty, m.name, m.price, m.stock,
           (m.id is not null and m.is_visible and m.is_available and m.price is not null
            and coalesce(c.is_visible, true) and (m.stock is null or m.stock >= cart.qty)) as ok
    from cart
    left join public.menu_items m on m.id = cart.id
    left join public.categories c on c.id = m.category_id
  )
  select coalesce(sum(price * qty) filter (where ok), 0),
         string_agg(case when stock is not null and stock < qty and stock > 0
                         then name || ' (only ' || stock || ' left)'
                         else coalesce(name, 'An item') end, ', ') filter (where not ok),
         jsonb_agg(jsonb_build_object('id', id, 'name', name, 'price', price, 'qty', qty,
                                      'line_total', price * qty)) filter (where ok)
    into v_subtotal, v_bad, v_lines
  from priced;

  if v_bad is not null then
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

create or replace function public.place_order(
  p_customer_name text,
  p_phone         text,
  p_email         text,
  p_order_type    text,
  p_room_number   text,
  p_notes         text,
  p_discount_code text,
  p_items         jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid      uuid := auth.uid();
  v_name     text := btrim(coalesce(p_customer_name, ''));
  v_phone    text := btrim(coalesce(p_phone, ''));
  v_email    text := nullif(btrim(coalesce(p_email, '')), '');
  v_room     text := nullif(btrim(coalesce(p_room_number, '')), '');
  v_notes    text := nullif(btrim(coalesce(p_notes, '')), '');
  v_priced   jsonb;
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
  if p_order_type not in ('pickup', 'dine_in', 'room_delivery') then
    raise exception 'INVALID_TYPE: Please choose how you would like to receive your order.';
  end if;
  if p_order_type = 'room_delivery' and (v_room is null or char_length(v_room) > 20) then
    raise exception 'INVALID_ROOM: Please enter your room number.';
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

  insert into public.customers (user_id, name, phone, email)
  values (v_uid, v_name, v_phone, v_email)
  on conflict (user_id) do update set name = excluded.name, phone = excluded.phone, email = excluded.email
  returning id into v_customer;

  insert into public.orders
    (user_id, customer_id, customer_name, customer_phone, order_type, room_number, notes,
     subtotal, discount_code, discount_total, total)
  values
    (v_uid, v_customer, v_name, v_phone, p_order_type,
     case when p_order_type = 'room_delivery' then v_room end, v_notes,
     (v_priced ->> 'subtotal')::numeric, v_priced ->> 'discount_code',
     (v_priced ->> 'discount_total')::numeric, (v_priced ->> 'total')::numeric)
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

-- 6. cancelling an order puts its portions back; reopening a cancelled order takes them out again
create or replace function public.adjust_stock_on_status_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    update public.menu_items m set stock = m.stock + x.q
      from (select menu_item_id, sum(quantity)::int as q from public.order_items
             where order_id = new.id and menu_item_id is not null group by menu_item_id) x
     where m.id = x.menu_item_id and m.stock is not null;
  elsif old.status = 'cancelled' and new.status <> 'cancelled' then
    update public.menu_items m set stock = greatest(m.stock - x.q, 0)
      from (select menu_item_id, sum(quantity)::int as q from public.order_items
             where order_id = new.id and menu_item_id is not null group by menu_item_id) x
     where m.id = x.menu_item_id and m.stock is not null;
  end if;
  return new;
end $$;

create trigger adjust_stock_orders after update of status on public.orders
  for each row execute function public.adjust_stock_on_status_change();
