-- Editable home page: text and photos (site_content), the "Built Around Comfort" cards (home_features),
-- the "Places Near Me" cards (home_places), the FAQ (home_faqs) and which gallery photos show on the home page.
-- Everything currently on the home page is imported below, so the page looks the same on day one.

-- ---------- home page text and photos (one row per piece)
create table if not exists public.site_content (
  key        text primary key check (key ~ '^[a-z0-9_]{1,40}$'),
  value      text not null check (char_length(value) <= 1000),
  updated_at timestamptz not null default now()
);
alter table public.site_content enable row level security;
drop policy if exists site_content_select on public.site_content;
create policy site_content_select on public.site_content for select using (true);
drop policy if exists site_content_write on public.site_content;
create policy site_content_write on public.site_content for all using (public.is_staff()) with check (public.is_staff());
revoke all on public.site_content from anon, authenticated;
grant select on public.site_content to anon, authenticated;
grant insert, update, delete on public.site_content to authenticated;

insert into public.site_content (key, value) values
  ('hero_eyebrow', 'STAY IN COMFORT  ·  DINE IN STYLE  ·  ENJOY SENERITY'),
  ('hero_name', 'American Roadhouse Hotel & Restaurant'),
  ('hero_title', 'Your Comfortable Stay in Candijay, Bohol'),
  ('hero_text', 'Enjoy a relaxing stay – With a cozy, air-conditioned dining room or unwind on our roof deck and enjoy fresh countryside breeze of ricefields and mountain landscape.'),
  ('hero_image', 'assets/venue/bar-sign.webp'),
  ('welcome_eyebrow', 'WELCOME TO AMERICAN ROADHOUSE'),
  ('welcome_title', 'A Comfortable Place to Stay, Dine, and Unwind'),
  ('welcome_text', 'Tucked into the rice fields of Tugas, American Roadhouse pairs simple, comfortable rooms with a restaurant and roof deck built for good food and easy company. It’s the kind of place travelers use as a base for exploring Bohol – and locals use for a night out.'),
  ('comfort_eyebrow', 'WHY GUESTS CHOOSE US'),
  ('comfort_title', 'Built Around Comfort'),
  ('gallery_eyebrow', 'A LOOK INSIDE'),
  ('gallery_title', 'Gallery'),
  ('places_eyebrow', 'BEYOND THE ROADHOUSE'),
  ('places_title', 'Places Near Me'),
  ('places_text', 'Your comfortable base for exploring Bohol.'),
  ('faq_eyebrow', 'GOOD TO KNOW'),
  ('faq_title', 'Frequently Asked Questions'),
  ('cta_title', 'Ready for Your Stay?'),
  ('cta_text', 'Make American Roadhouse part of your Candijay experience.'),
  ('cta_image', 'assets/venue/dining-room-flowers.webp')
on conflict (key) do nothing;

-- ---------- "Built Around Comfort" cards
create table if not exists public.home_features (
  id         uuid primary key default gen_random_uuid(),
  icon       text not null default 'star' check (icon in ('bed', 'dining', 'pin', 'people', 'star', 'wifi', 'car', 'sun')),
  title      text not null check (char_length(btrim(title)) between 1 and 60),
  body       text not null check (char_length(btrim(body)) between 1 and 200),
  sort_order integer not null default 0,
  is_visible boolean not null default true,
  created_at timestamptz not null default now()
);
-- ---------- "Places Near Me" cards
create table if not exists public.home_places (
  id         uuid primary key default gen_random_uuid(),
  image_url  text not null check (image_url ~ '^(assets/|https://)'),
  name       text not null check (char_length(btrim(name)) between 1 and 80),
  note       text not null default '' check (char_length(note) <= 200),
  distance   text not null default '' check (char_length(distance) <= 40),
  map_url    text check (map_url is null or map_url ~ '^https://'),
  sort_order integer not null default 0,
  is_visible boolean not null default true,
  created_at timestamptz not null default now()
);
-- ---------- FAQ
create table if not exists public.home_faqs (
  id         uuid primary key default gen_random_uuid(),
  question   text not null check (char_length(btrim(question)) between 1 and 160),
  answer     text not null check (char_length(btrim(answer)) between 1 and 600),
  sort_order integer not null default 0,
  is_visible boolean not null default true,
  created_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['home_features', 'home_places', 'home_faqs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select using (is_visible or public.is_staff())', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format('create policy %I on public.%I for all using (public.is_staff()) with check (public.is_staff())', t || '_write', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
    execute format('grant insert, update, delete on public.%I to authenticated', t);
    execute format('create index if not exists %I on public.%I (sort_order, created_at)', t || '_order_idx', t);
  end loop;
end $$;

insert into public.home_features (icon, title, body, sort_order)
select v.icon, v.title, v.body, v.sort_order from (values
  ('bed', 'Comfortable Stay', 'A welcoming place to rest during your visit to Candijay.', 10),
  ('dining', 'Dining', 'Enjoy satisfying meals and refreshments at our restaurant.', 20),
  ('pin', 'Convenient Location', 'Located in Tugas, Candijay, Bohol.', 30),
  ('people', 'Welcoming Experience', 'A comfortable environment for travelers and visitors.', 40)
) as v (icon, title, body, sort_order) where not exists (select 1 from public.home_features);

insert into public.home_places (image_url, name, note, sort_order)
select v.image_url, v.name, v.note, v.sort_order from (values
  ('assets/venue/roofdeck-wide-1.jpg', 'Nearby Attractions', 'Bohol’s countryside, beaches, and landmarks are within reach.', 10),
  ('assets/food/garden-salad.jpg', 'Local Food', 'Fresh, satisfying meals inspired by local flavors.', 20),
  ('assets/venue/roofdeck-bar-4.jpg', 'Local Experiences', 'A relaxed setting for gatherings, big or small.', 30)
) as v (image_url, name, note, sort_order) where not exists (select 1 from public.home_places);

insert into public.home_faqs (question, answer, sort_order)
select v.question, v.answer, v.sort_order from (values
  ('What room options are available?', 'We offer a small number of air-conditioned rooms. See the Rooms page for current options, or contact us for full details and rates.', 10),
  ('How can I make a reservation?', 'Send a booking request through our website or call us directly at 0915 875 4860. Our team will confirm availability with you.', 20),
  ('What are the check-in and check-out times?', 'Check-in and check-out times will be confirmed when you book – please contact us for current details.', 30),
  ('Does the restaurant accept walk-ins?', 'Walk-ins are welcome. For larger groups or events, reserving a table ahead of time is recommended.', 40),
  ('Where is American Roadhouse located?', 'We’re located at Purok 5 Tugas, Candijay, Bohol 6312, Philippines. See the map above for directions.', 50),
  ('How can I contact the hotel?', 'Call us at 0915 875 4860, or use the contact form on our Contact page and we’ll get back to you.', 60)
) as v (question, answer, sort_order) where not exists (select 1 from public.home_faqs);

-- ---------- which gallery photos appear in the home page preview
alter table public.gallery_photos add column if not exists show_on_home boolean not null default false;
update public.gallery_photos set show_on_home = true
 where image_url in ('assets/venue/roofdeck-wide-1.jpg', 'assets/rooms/studio_room.jpg', 'assets/food/shrimp-pasta.jpg', 'assets/venue/roofdeck-bar-2.jpg')
   and not exists (select 1 from public.gallery_photos g where g.show_on_home);
