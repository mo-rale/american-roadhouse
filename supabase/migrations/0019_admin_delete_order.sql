-- Administrators can delete any single order (new, in progress, completed or cancelled). Its items go with it.
-- The dashboard asks for confirmation first; this function is the only way to delete an order from the website.
create or replace function public.admin_delete_order(p_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN: Administrators only.';
  end if;
  with d as (delete from public.orders where id = p_id returning 1)
  select count(*) into v_count from d;
  if v_count = 0 then
    raise exception 'NOT_FOUND: That order no longer exists.';
  end if;
  return v_count;
end $$;

revoke all on function public.admin_delete_order(uuid) from public, anon;
grant execute on function public.admin_delete_order(uuid) to authenticated;
