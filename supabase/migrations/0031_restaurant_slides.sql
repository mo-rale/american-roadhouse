-- Editable photo slideshow at the top of the Restaurant page, managed in the staff dashboard (Slideshow tab).
-- The 2 photos that were built into the page are imported below.

create table if not exists public.restaurant_slides (
  id         uuid primary key default gen_random_uuid(),
  image_url  text not null check (image_url ~ '^(assets/|https://)'),
  caption    text not null check (char_length(btrim(caption)) between 1 and 140),
  sort_order integer not null default 0,
  is_visible boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists restaurant_slides_order_idx on public.restaurant_slides (sort_order, created_at);
alter table public.restaurant_slides enable row level security;
drop policy if exists restaurant_slides_select on public.restaurant_slides;
create policy restaurant_slides_select on public.restaurant_slides for select using (is_visible or public.is_staff());
drop policy if exists restaurant_slides_write on public.restaurant_slides;
create policy restaurant_slides_write on public.restaurant_slides for all using (public.is_staff()) with check (public.is_staff());
revoke all on public.restaurant_slides from anon, authenticated;
grant select on public.restaurant_slides to anon, authenticated;
grant insert, update, delete on public.restaurant_slides to authenticated;

insert into public.restaurant_slides (image_url, caption, sort_order)
select v.image_url, v.caption, v.sort_order
from (values
  ('assets/venue/dining-room-bar.webp', 'The dining room and bar', 10),
  ('assets/venue/dining-room-flowers.webp', 'The dining room with the flower wall', 20)
) as v (image_url, caption, sort_order)
where not exists (select 1 from public.restaurant_slides);
