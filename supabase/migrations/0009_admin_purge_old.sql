-- Admin-only clean-up of old records.
--   orders    : only completed / cancelled orders (their items go with them)
--   inquiries : only closed inquiries
--   history   : price-change log entries
-- p_dry_run = true just counts what would be removed. At least 30 days must be kept.
create or replace function public.admin_purge_old(p_kind text, p_older_than_days int, p_dry_run boolean default true)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_cutoff timestamptz;
  v_count  int;
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN: Administrators only.';
  end if;
  if p_older_than_days is null or p_older_than_days < 30 then
    raise exception 'RANGE: Only records older than 30 days can be deleted.';
  end if;
  v_cutoff := now() - make_interval(days => p_older_than_days);

  if p_kind = 'orders' then
    if p_dry_run then
      select count(*) into v_count from public.orders where status in ('completed', 'cancelled') and created_at < v_cutoff;
    else
      with d as (delete from public.orders where status in ('completed', 'cancelled') and created_at < v_cutoff returning 1)
      select count(*) into v_count from d;
    end if;
  elsif p_kind = 'inquiries' then
    if p_dry_run then
      select count(*) into v_count from public.inquiries where status = 'closed' and created_at < v_cutoff;
    else
      with d as (delete from public.inquiries where status = 'closed' and created_at < v_cutoff returning 1)
      select count(*) into v_count from d;
    end if;
  elsif p_kind = 'history' then
    if p_dry_run then
      select count(*) into v_count from public.price_history where changed_at < v_cutoff;
    else
      with d as (delete from public.price_history where changed_at < v_cutoff returning 1)
      select count(*) into v_count from d;
    end if;
  else
    raise exception 'KIND: Unknown record type.';
  end if;
  return v_count;
end $$;

revoke all on function public.admin_purge_old(text, int, boolean) from public, anon;
grant execute on function public.admin_purge_old(text, int, boolean) to authenticated;
