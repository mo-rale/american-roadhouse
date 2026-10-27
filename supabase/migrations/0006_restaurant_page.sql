-- Editable content for the Restaurant page's "Main" tab: ordered sections (Appetizer, Salad, ...)
-- and the dishes inside them. The Roof Deck tab reads the "Roofdeck Grill" items from menu_items.
-- Anyone can read visible rows; only active staff (employees and admins) can change them.

create table public.restaurant_sections (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(btrim(name)) between 1 and 60),
  sort_order integer not null default 0,
  is_visible boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.restaurant_dishes (
  id          uuid primary key default gen_random_uuid(),
  section_id  uuid not null references public.restaurant_sections (id) on delete restrict,
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 500),
  price       numeric(10,2) check (price is null or (price > 0 and price <= 1000000)),  -- null = "Ask for today's price"
  image_url   text check (image_url is null or char_length(image_url) <= 500),
  is_visible  boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index restaurant_dishes_section_idx on public.restaurant_dishes (section_id, sort_order);

create trigger touch_restaurant_sections before update on public.restaurant_sections
  for each row execute function public.touch_updated_at();
create trigger touch_restaurant_dishes before update on public.restaurant_dishes
  for each row execute function public.touch_updated_at();

-- A dish may have no price yet; only log the audit trail when a price exists.
create or replace function public.log_price_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  col   text  := tg_argv[0];
  j_new jsonb := to_jsonb(new);
  j_old jsonb;
begin
  if (j_new ->> col) is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    j_old := to_jsonb(old);
    if (j_old ->> col) is not distinct from (j_new ->> col) then
      return new;
    end if;
  end if;
  insert into public.price_history
    (table_name, record_id, record_name, field, old_price, new_price, changed_by, changed_by_email)
  values
    (tg_table_name, (j_new ->> 'id')::uuid, coalesce(j_new ->> 'name', j_new ->> 'code'), col,
     (j_old ->> col)::numeric, (j_new ->> col)::numeric, auth.uid(), auth.jwt() ->> 'email');
  return new;
end $$;

create trigger log_price_restaurant_dishes after insert or update on public.restaurant_dishes
  for each row execute function public.log_price_change('price');

revoke all on public.restaurant_sections, public.restaurant_dishes from anon, authenticated;
grant select on public.restaurant_sections, public.restaurant_dishes to anon;
grant select, insert, update, delete on public.restaurant_sections, public.restaurant_dishes to authenticated;

alter table public.restaurant_sections enable row level security;
alter table public.restaurant_dishes   enable row level security;

create policy restaurant_sections_select on public.restaurant_sections for select
  using (is_visible or public.is_staff());
create policy restaurant_sections_write on public.restaurant_sections for all
  using (public.is_staff()) with check (public.is_staff());

create policy restaurant_dishes_select on public.restaurant_dishes for select
  using (is_visible or public.is_staff());
create policy restaurant_dishes_write on public.restaurant_dishes for all
  using (public.is_staff()) with check (public.is_staff());

alter publication supabase_realtime add table public.restaurant_sections, public.restaurant_dishes;

-- Starter content: what the page showed before it became editable.
insert into public.restaurant_sections (name, sort_order) values
  ('Appetizer', 1), ('Salad', 2), ('Angus Burger', 3), ('Pizza', 4), ('Main Course', 5),
  ('Sides', 6), ('Desserts', 7), ('Breakfast', 8), ('Main Dishes', 9);

insert into public.restaurant_dishes (section_id, name, description, image_url, sort_order)
select s.id, v.name, v.description, v.image_url, v.sort_order
from (values
  ('Salad',       'Garden Salad',                'Fresh lettuce, tomato, carrot, and cucumber, finished with a light dressing.', 'assets/food/garden-salad.jpg', 1),
  ('Pizza',       'Pizza',                       'Baked pizza with tomato sauce and melted cheese.', 'assets/food/pizza.jpg', 1),
  ('Breakfast',   'Breakfast Plate',             'A hearty Filipino-style breakfast with garlic rice, egg, and a savory breakfast meat.', 'assets/food/breakfast-plate-generated.jpg', 1),
  ('Breakfast',   'Silog Meal',                  'Filipino longganisa served with garlic rice and a fried egg.', 'assets/food/silog-meal-generated.jpg', 2),
  ('Main Dishes', 'Garlic-Herb Grilled Fish',    'Grilled fish fillet topped with garlic, served with a corn and green bean stir-fry and mashed potato.', 'assets/food/mains-fish.jpg', 1),
  ('Main Dishes', 'Grilled Chicken with Cheese', 'Sliced grilled chicken finished with shredded cheese and a side of fresh lettuce.', 'assets/food/mains-chicken.jpg', 2),
  ('Main Dishes', 'Creamy Shrimp Pasta',         'Linguine tossed in a creamy sauce with shrimp, peppers, and herbs.', 'assets/food/shrimp-pasta.jpg', 3)
) as v(section, name, description, image_url, sort_order)
join public.restaurant_sections s on s.name = v.section;
