-- At most 4 "Places Near Me" cards (the home page shows one row of four).
create or replace function public.home_places_max4() returns trigger
language plpgsql set search_path = public as $$
begin
  if (select count(*) from public.home_places) >= 4 then
    raise exception 'The home page can show at most 4 places. Delete one first.';
  end if;
  return new;
end $$;
drop trigger if exists home_places_max4 on public.home_places;
create trigger home_places_max4 before insert on public.home_places
  for each row execute function public.home_places_max4();
