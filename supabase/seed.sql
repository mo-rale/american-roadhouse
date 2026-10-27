-- Starter data taken from the current menu.html and rooms.html.
-- Items that are "ask for today's price" on the site are intentionally not seeded:
-- add them from the staff dashboard once real prices are confirmed.

-- Run this after all migrations (0001 to 0008). The Main sections (Appetizer, Salad, ...) and their dishes are
-- created by migrations 0006 and 0008; this file adds the Roof Deck sections, priced items and room rates.
insert into public.categories (name, slug, sort_order, venue) values
  ('Roofdeck Grill', 'roofdeck-grill', 1, 'roofdeck'),
  ('Lemon Drinks',   'lemon-drinks',   2, 'roofdeck')
on conflict (slug) do update set venue = excluded.venue, sort_order = excluded.sort_order;

insert into public.menu_items (category_id, name, description, price, image_url, sort_order)
select c.id, v.name, v.description, v.price, v.image_url, v.sort_order
from (values
  ('roofdeck-grill', 'Paa',                  'Grilled chicken leg quarter, served with rice and kalamansi.', 185, 'assets/food/paa-menu.jpg', 1),
  ('roofdeck-grill', 'Pecho',                'Grilled chicken breast, served with rice.',                    195, 'assets/food/pecho-menu.jpg', 2),
  ('roofdeck-grill', 'Pork BBQ',             'Skewered pork barbecue, 9 pieces, served with rice.',          165, 'assets/food/pork-bbq-menu.jpg', 3),
  ('roofdeck-grill', 'Spicy Pork',           'Grilled pork kasim with a spicy marinade, served with rice.',  199, 'assets/food/spicy-pork-menu.jpg', 4),
  ('roofdeck-grill', 'Spicy Chicken BBQ',    'Grilled chicken thigh with a spicy marinade, served with rice.', 199, 'assets/food/spicy-chicken-menu.jpg', 5),
  ('roofdeck-grill', 'Longganisa Sausage',   'Grilled Filipino sausage, served with rice.',                  185, 'assets/food/longganisa-menu.jpg', 6),
  ('roofdeck-grill', 'Grilled Bangus (Small)',  'Whole grilled milkfish, small.',  165, 'assets/food/bangus-menu.jpg', 7),
  ('roofdeck-grill', 'Grilled Bangus (Medium)', 'Whole grilled milkfish, medium.', 190, 'assets/food/bangus-menu.jpg', 8),
  ('roofdeck-grill', 'Grilled Bangus (Large)',  'Whole grilled milkfish, large.',  285, 'assets/food/bangus-menu.jpg', 9),
  ('roofdeck-grill', 'Grilled Pork Belly',   'Grilled pork belly, served with rice.',                        200, 'assets/food/pork-belly-menu.jpg', 10),
  ('lemon-drinks', 'Classic Lemon (Medium)',    'Iced classic lemon drink.',     95,  'assets/food/classic-lemon-generated.jpg', 1),
  ('lemon-drinks', 'Classic Lemon (Large)',     'Iced classic lemon drink.',     160, 'assets/food/classic-lemon-generated.jpg', 2),
  ('lemon-drinks', 'Lemon Calamansi (Medium)',  'Iced lemon calamansi drink.',   90,  'assets/food/lemon-calamansi-generated.jpg', 3),
  ('lemon-drinks', 'Lemon Calamansi (Large)',   'Iced lemon calamansi drink.',   185, 'assets/food/lemon-calamansi-generated.jpg', 4),
  ('lemon-drinks', 'Lemon Cucumber (Medium)',   'Refreshing iced lemon cucumber drink.', 85,  'assets/food/lemon-yakult-generated.jpg', 5),
  ('lemon-drinks', 'Lemon Cucumber (Large)',    'Refreshing iced lemon cucumber drink.', 190, 'assets/food/lemon-yakult-generated.jpg', 6),
  ('lemon-drinks', 'Lemon Yakult (Medium)',     'Lemon drink with a creamy Yakult finish.', 99,  'assets/food/lemon-yakult-generated.jpg', 7),
  ('lemon-drinks', 'Lemon Yakult (Large)',      'Lemon drink with a creamy Yakult finish.', 180, 'assets/food/lemon-yakult-generated.jpg', 8),
  ('lemon-drinks', 'Lemon Soda (Medium)',       'Sparkling lemon soda.',         90,  'assets/food/lemon-soda-generated.jpg', 9),
  ('lemon-drinks', 'Lemon Soda (Large)',        'Sparkling lemon soda.',         170, 'assets/food/lemon-soda-generated.jpg', 10)
) as v(slug, name, description, price, image_url, sort_order)
join public.categories c on c.slug = v.slug;

insert into public.room_rates (name, description, price_per_night, image_url, sort_order) values
  ('Studio',              'Air-conditioned studio with free Wi-Fi.',      1458, 'assets/rooms/studio_room.jpg',   1),
  ('Deluxe Queen Studio', 'Air-conditioned queen studio with free Wi-Fi.', 1426, 'assets/rooms/Deluxe_studio.jpg', 2),
  ('Deluxe Suite',        'Air-conditioned suite with free Wi-Fi.',        2835, 'assets/rooms/Deluxe_suite.jpg',  3);
