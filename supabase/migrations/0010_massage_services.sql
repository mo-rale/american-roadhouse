-- Massage types and prices shown on the Services page. Everyone can read the active ones;
-- staff can see all of them; only administrators change them.
create table if not exists public.massage_services (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (char_length(btrim(name)) between 1 and 120),
  description      text not null default '' check (char_length(description) <= 500),
  duration_minutes int  check (duration_minutes is null or duration_minutes between 1 and 1440),
  price            numeric(10,2) check (price is null or price >= 0),
  is_active        boolean not null default true,
  sort_order       int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

drop trigger if exists touch_massage_services on public.massage_services;
create trigger touch_massage_services before update on public.massage_services
  for each row execute function public.touch_updated_at();

alter table public.massage_services enable row level security;
revoke all on public.massage_services from public, anon, authenticated;
grant select on public.massage_services to anon, authenticated;
grant insert, update, delete on public.massage_services to authenticated;

drop policy if exists massage_select on public.massage_services;
create policy massage_select on public.massage_services for select using (is_active or public.is_staff());
drop policy if exists massage_write on public.massage_services;
create policy massage_write on public.massage_services for all
  using (public.is_admin()) with check (public.is_admin());

-- live updates for the dashboard and the Services page
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'massage_services') then
    alter publication supabase_realtime add table public.massage_services;
  end if;
end $$;
