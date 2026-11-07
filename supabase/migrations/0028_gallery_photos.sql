-- Editable gallery: the photos on the Gallery page come from this table, managed in the staff dashboard (Gallery tab).
-- The 20 photos that were built into the page are imported below, so the gallery looks the same on day one.
-- New photos are uploaded from the dashboard into the existing menu-images storage bucket.

create table if not exists public.gallery_photos (
  id         uuid primary key default gen_random_uuid(),
  image_url  text not null check (image_url ~ '^(assets/|https://)'),
  caption    text not null check (char_length(btrim(caption)) between 1 and 140),
  category   text not null check (category in ('rooms', 'hotel', 'restaurant', 'food')),
  sort_order integer not null default 0,
  is_visible boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists gallery_photos_order_idx on public.gallery_photos (sort_order, created_at);
alter table public.gallery_photos enable row level security;
drop policy if exists gallery_photos_select on public.gallery_photos;
create policy gallery_photos_select on public.gallery_photos for select using (is_visible or public.is_staff());
drop policy if exists gallery_photos_write on public.gallery_photos;
create policy gallery_photos_write on public.gallery_photos for all using (public.is_staff()) with check (public.is_staff());
revoke all on public.gallery_photos from anon, authenticated;
grant select on public.gallery_photos to anon, authenticated;
grant insert, update, delete on public.gallery_photos to authenticated;

insert into public.gallery_photos (image_url, caption, category, sort_order)
select v.image_url, v.caption, v.category, v.sort_order
from (values
  ('assets/venue/roofdeck-wide-1.jpg', 'Roof deck seating overlooking rice fields', 'hotel', 10),
  ('assets/rooms/Deluxe_suite.jpg', 'Room with private balcony', 'rooms', 20),
  ('assets/rooms/studio_room.jpg', 'Room with double bed', 'rooms', 30),
  ('assets/venue/roofdeck-bar-2.jpg', 'Bar area on the roof deck', 'restaurant', 40),
  ('assets/food/mains-fish.jpg', 'Garlic-herb grilled fish plate', 'food', 50),
  ('assets/food/shrimp-pasta.jpg', 'Creamy shrimp pasta', 'food', 60),
  ('assets/food/mains-chicken.jpg', 'Grilled chicken with cheese', 'food', 70),
  ('assets/venue/roofdeck-bar-4.jpg', 'Table set for an event', 'restaurant', 80),
  ('assets/food/garden-salad.jpg', 'Garden salad', 'food', 90),
  ('assets/food/grilled-cheese.jpg', 'Grilled cheese sandwich', 'food', 100),
  ('assets/food/sausage-sandwich.jpg', 'Grilled sausage sandwich', 'food', 110),
  ('assets/venue/roofdeck-poster-2.jpg', 'Roof deck resto bar', 'restaurant', 120),
  ('assets/venue/bar-sign.webp', 'The bar with the American Roadhouse sign', 'restaurant', 130),
  ('assets/venue/dining-room-sofas.webp', 'Indoor restaurant seating with leather booths', 'restaurant', 140),
  ('assets/venue/dining-room-flowers.webp', 'Dining room with tables set and a flower wall', 'restaurant', 150),
  ('assets/venue/dining-room-bar.webp', 'Dining room and bar', 'restaurant', 160),
  ('assets/venue/roofdeck-bar-4.jpg', 'Open-air roof deck seating prepared for guests', 'restaurant', 170),
  ('assets/venue/roofdeck-bar-5.jpg', 'Lounge seating on the roof deck', 'restaurant', 180),
  ('assets/venue/roofdeck-bar-6.jpg', 'Roof deck dining area in the evening', 'restaurant', 190),
  ('assets/food/pizza.jpg', 'Pizza with melted cheese and tomato sauce', 'food', 200)
) as v (image_url, caption, category, sort_order)
where not exists (select 1 from public.gallery_photos);
