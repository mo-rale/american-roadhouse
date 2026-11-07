-- Editable "Menu Highlights" cards on the home page, managed in the staff dashboard (Highlights tab).
-- The 4 cards that were built into index.html are imported below, so the home page looks the same on day one.

create table if not exists public.home_highlights (
  id         uuid primary key default gen_random_uuid(),
  image_url  text not null check (image_url ~ '^(assets/|https://)'),
  title      text not null check (char_length(btrim(title)) between 1 and 80),
  subtitle   text not null default '' check (char_length(subtitle) <= 80),
  sort_order integer not null default 0,
  is_visible boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists home_highlights_order_idx on public.home_highlights (sort_order, created_at);
alter table public.home_highlights enable row level security;
drop policy if exists home_highlights_select on public.home_highlights;
create policy home_highlights_select on public.home_highlights for select using (is_visible or public.is_staff());
drop policy if exists home_highlights_write on public.home_highlights;
create policy home_highlights_write on public.home_highlights for all using (public.is_staff()) with check (public.is_staff());
revoke all on public.home_highlights from anon, authenticated;
grant select on public.home_highlights to anon, authenticated;
grant insert, update, delete on public.home_highlights to authenticated;

insert into public.home_highlights (image_url, title, subtitle, sort_order)
select v.image_url, v.title, v.subtitle, v.sort_order
from (values
  ('assets/food/mains-fish.jpg', 'Garlic-Herb Grilled Fish', 'Ask for today''s price', 10),
  ('assets/food/mains-chicken.jpg', 'Grilled Chicken', 'Ask for today''s price', 20),
  ('assets/food/shrimp-pasta.jpg', 'Creamy Shrimp Pasta', 'Ask for today''s price', 30),
  ('assets/food/pizza.jpg', 'Pizza', 'Ask for today''s price', 40)
) as v (image_url, title, subtitle, sort_order)
where not exists (select 1 from public.home_highlights);

-- At most 4 highlight cards (the home page shows one row of four).
create or replace function public.home_highlights_max4() returns trigger
language plpgsql set search_path = public as $$
begin
  if (select count(*) from public.home_highlights) >= 4 then
    raise exception 'The home page can show at most 4 highlights. Delete one first.';
  end if;
  return new;
end $$;
drop trigger if exists home_highlights_max4 on public.home_highlights;
create trigger home_highlights_max4 before insert on public.home_highlights
  for each row execute function public.home_highlights_max4();
