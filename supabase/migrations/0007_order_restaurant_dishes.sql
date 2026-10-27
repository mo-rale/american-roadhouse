-- Let customers order dishes from the Restaurant page's Main tab as soon as staff give them a price.
-- Before this, only menu_items could be ordered. place_order() still recomputes every price on the
-- server, now from either menu_items or restaurant_dishes, and ignores hidden or unpriced dishes.

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
    select cart.id, cart.qty,
           coalesce(m.name, rd.name)   as name,
           coalesce(m.price, rd.price) as price,
           case
             when m.id  is not null then (m.is_visible and m.is_available and coalesce(c.is_visible, true))
             when rd.id is not null then (rd.is_visible and rd.price is not null and coalesce(rs.is_visible, true))
             else false
           end as ok
    from cart
    left join public.menu_items m          on m.id = cart.id
    left join public.categories c          on c.id = m.category_id
    left join public.restaurant_dishes rd  on rd.id = cart.id
    left join public.restaurant_sections rs on rs.id = rd.section_id
  )
  select coalesce(sum(price * qty) filter (where ok), 0),
         string_agg(coalesce(name, 'An item'), ', ') filter (where not ok),
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

  -- menu_item_id stays null for Restaurant-page dishes (the name and price are stored on the line anyway).
  insert into public.order_items (order_id, menu_item_id, item_name, unit_price, quantity, line_total)
  select v_order.id,
         (select m.id from public.menu_items m where m.id = (l ->> 'id')::uuid),
         l ->> 'name', (l ->> 'price')::numeric,
         (l ->> 'qty')::int, (l ->> 'line_total')::numeric
  from jsonb_array_elements(v_priced -> 'lines') l;

  return jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number,
                            'total', v_order.total, 'status', v_order.status);
end $$;
