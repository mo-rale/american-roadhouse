-- Home page highlights can point at a dish on the menu: the card then shows that dish's name, photo and price
-- from the menu automatically. The 4 original cards keep their own photo and text (menu_item_id stays empty).

alter table public.home_highlights add column if not exists menu_item_id uuid references public.menu_items (id) on delete cascade;
alter table public.home_highlights alter column image_url drop not null;
alter table public.home_highlights alter column title drop not null;
alter table public.home_highlights drop constraint if exists home_highlights_has_content;
alter table public.home_highlights add constraint home_highlights_has_content
  check (menu_item_id is not null or (image_url is not null and title is not null));
