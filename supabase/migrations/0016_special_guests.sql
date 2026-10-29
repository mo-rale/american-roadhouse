-- Special guests shown on the front page. Everyone can read the visible ones;
-- staff can see all of them; only administrators change them.
create table if not exists public.special_guests (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  title       text check (title is null or char_length(title) <= 120),
  note        text not null default '' check (char_length(note) <= 400),
  visit_date  date,
  image_url   text,
  is_visible  boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists touch_special_guests on public.special_guests;
create trigger touch_special_guests before update on public.special_guests
  for each row execute function public.touch_updated_at();

alter table public.special_guests enable row level security;
revoke all on public.special_guests from public, anon, authenticated;
grant select on public.special_guests to anon, authenticated;
grant insert, update, delete on public.special_guests to authenticated;

drop policy if exists guests_select on public.special_guests;
create policy guests_select on public.special_guests for select using (is_visible or public.is_staff());
drop policy if exists guests_write on public.special_guests;
create policy guests_write on public.special_guests for all
  using (public.is_admin()) with check (public.is_admin());

do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'special_guests') then
    alter publication supabase_realtime add table public.special_guests;
  end if;
end $$;
