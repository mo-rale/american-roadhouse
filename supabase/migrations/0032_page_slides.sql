-- The header slideshow is now available on every page except the home page.
-- restaurant_slides becomes page_slides, with a "page" column saying which page a photo belongs to.
-- The 2 existing photos stay on the Restaurant page.

alter table public.restaurant_slides rename to page_slides;
alter index if exists public.restaurant_slides_order_idx rename to page_slides_order_idx;
alter policy restaurant_slides_select on public.page_slides rename to page_slides_select;
alter policy restaurant_slides_write on public.page_slides rename to page_slides_write;

alter table public.page_slides add column if not exists page text not null default 'restaurant';
alter table public.page_slides alter column page drop default;
alter table public.page_slides drop constraint if exists page_slides_page_check;
alter table public.page_slides add constraint page_slides_page_check
  check (page in ('rooms', 'restaurant', 'services', 'gallery', 'contact', 'booking'));
create index if not exists page_slides_page_idx on public.page_slides (page, sort_order);
