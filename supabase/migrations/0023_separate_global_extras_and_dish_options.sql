-- Keep global add-ons separate from dish-specific sizes and flavors.

create table if not exists public.menu_options (
  id            uuid primary key default gen_random_uuid(),
  menu_item_id  uuid not null references public.menu_items (id) on delete cascade,
  option_type   text not null check (option_type in ('size', 'flavor')),
  name          text not null check (char_length(btrim(name)) between 1 and 80),
  price         numeric(10,2) not null check (price >= 0),
  sort_order    integer not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists menu_options_item_idx on public.menu_options (menu_item_id, option_type, sort_order);
alter table public.menu_options enable row level security;
drop policy if exists menu_options_select on public.menu_options;
create policy menu_options_select on public.menu_options for select using (is_active or public.is_staff());
drop policy if exists menu_options_write on public.menu_options;
create policy menu_options_write on public.menu_options for all using (public.is_staff()) with check (public.is_staff());
grant select on public.menu_options to anon, authenticated;
grant insert, update, delete on public.menu_options to authenticated;
do $$ begin alter publication supabase_realtime add table public.menu_options; exception when duplicate_object then null; end $$;

-- Convert the previous mixed per-dish rows: Size/Flavor become dish options;
-- everything else becomes one global extra, de-duplicated by name and price.
alter table public.menu_extras alter column menu_item_id drop not null;
alter table public.menu_extras alter column category_id drop not null;

insert into public.menu_options (menu_item_id, option_type, name, price, sort_order, is_active)
select menu_item_id, lower(option_group), name, price, sort_order, is_active
  from public.menu_extras
 where lower(option_group) in ('size', 'flavor') and menu_item_id is not null;

insert into public.menu_extras (category_id, menu_item_id, name, price, sort_order, is_active, option_group)
select category_id, null, name, price, min(sort_order), bool_or(is_active), 'Extra'
  from public.menu_extras
 where lower(coalesce(option_group, 'extra')) not in ('size', 'flavor')
 group by category_id, lower(name), name, price;

delete from public.menu_extras;

create or replace function public._price_cart(p_items jsonb, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_code text := nullif(btrim(coalesce(p_code, '')), '');
  v_el jsonb; v_id uuid; v_qty int; v_ex_id uuid; m record; ex record;
  v_used jsonb := '{}'::jsonb; v_tot int; v_lines jsonb := '[]'::jsonb;
  v_subtotal numeric(12,2) := 0; v_bad text := ''; v_unit numeric(12,2); v_size_price numeric(12,2);
  v_ex_total numeric(12,2); v_ex_json jsonb; v_disc public.discounts;
  v_discount numeric(12,2) := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 40 then
    raise exception 'EMPTY_CART: Your cart is empty or invalid.';
  end if;
  for v_el in select * from jsonb_array_elements(p_items) loop
    begin v_id := (v_el ->> 'id')::uuid; v_qty := (v_el ->> 'qty')::int;
    exception when others then raise exception 'INVALID_QTY: Quantities must be between 1 and 50.'; end;
    if v_id is null or v_qty is null or v_qty < 1 or v_qty > 50 then raise exception 'INVALID_QTY: Quantities must be between 1 and 50.'; end if;
    select mi.id, mi.name, mi.price, mi.stock, mi.category_id,
           (mi.is_visible and mi.is_available and mi.price is not null and coalesce(c.is_visible, true)) as ok
      into m from public.menu_items mi left join public.categories c on c.id = mi.category_id where mi.id = v_id;
    if not found then v_bad := v_bad || case when v_bad = '' then '' else ', ' end || 'An item'; continue; end if;
    if not m.ok then v_bad := v_bad || case when v_bad = '' then '' else ', ' end || m.name; continue; end if;
    v_tot := coalesce((v_used ->> v_id::text)::int, 0) + v_qty;
    v_used := jsonb_set(v_used, array[v_id::text], to_jsonb(v_tot), true);
    if m.stock is not null and v_tot > m.stock then
      v_bad := v_bad || case when v_bad = '' then '' else ', ' end || case when m.stock > 0 then m.name || ' (only ' || m.stock || ' left)' else m.name end;
      continue;
    end if;
    v_ex_total := 0; v_size_price := null; v_ex_json := '[]'::jsonb;
    if jsonb_typeof(v_el -> 'extras') = 'array' then
      if jsonb_array_length(v_el -> 'extras') > 20 then raise exception 'INVALID_EXTRAS: Too many options on one dish.'; end if;
      for v_ex_id in select distinct (x.value)::uuid from jsonb_array_elements_text(v_el -> 'extras') as x(value) order by 1 loop
        select x.id, x.name, x.price, x.option_type into ex
          from (
            select e.id, e.name, e.price, 'extra'::text as option_type
              from public.menu_extras e where e.id = v_ex_id and e.is_active
            union all
            select o.id, o.name, o.price, o.option_type
              from public.menu_options o where o.id = v_ex_id and o.is_active and o.menu_item_id = m.id
          ) x limit 1;
        if not found then raise exception 'ITEM_UNAVAILABLE: An option for % is no longer available. Please update your cart.', m.name; end if;
        if ex.option_type = 'size' then
          if v_size_price is not null then raise exception 'INVALID_OPTIONS: Choose only one size for %.', m.name; end if;
          v_size_price := ex.price;
        else
          v_ex_total := v_ex_total + ex.price;
        end if;
        v_ex_json := v_ex_json || jsonb_build_array(jsonb_build_object('id', ex.id, 'name', ex.name, 'price', ex.price, 'option_type', ex.option_type));
      end loop;
    end if;
    v_unit := coalesce(v_size_price, m.price) + v_ex_total; v_subtotal := v_subtotal + v_unit * v_qty;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('id', m.id, 'name', m.name, 'price', v_unit, 'qty', v_qty, 'line_total', v_unit * v_qty, 'extras', v_ex_json));
  end loop;
  if v_bad <> '' then raise exception 'ITEM_UNAVAILABLE: % is no longer available. Please update your cart.', v_bad; end if;
  if v_code is not null then
    select * into v_disc from public.discounts d where lower(d.code) = lower(v_code) and d.is_active
      and (d.starts_at is null or d.starts_at <= now()) and (d.ends_at is null or d.ends_at >= now());
    if not found then raise exception 'INVALID_DISCOUNT: That discount code is not valid.'; end if;
    if v_subtotal < v_disc.min_subtotal then raise exception 'DISCOUNT_MIN: This code needs a minimum order of %.', v_disc.min_subtotal; end if;
    v_discount := case when v_disc.type = 'percent' then round(v_subtotal * v_disc.value / 100, 2) else least(v_disc.value, v_subtotal) end;
  end if;
  return jsonb_build_object('subtotal', v_subtotal, 'discount_total', v_discount, 'total', v_subtotal - v_discount,
    'discount_code', case when v_code is null then null else v_disc.code end, 'lines', v_lines);
end $$;

