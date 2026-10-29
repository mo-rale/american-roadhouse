-- Massage pricing text ("per 30 minutes", "Duration varies"), the massage request form,
-- and the starting massage menu.
alter table public.massage_services add column if not exists price_unit text check (price_unit is null or char_length(price_unit) <= 40);
alter table public.massage_services add column if not exists duration_label text check (duration_label is null or char_length(duration_label) <= 40);

create or replace function public.submit_inquiry(
  p_kind      text,
  p_full_name text,
  p_phone     text,
  p_email     text,
  p_details   jsonb
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_name    text := btrim(coalesce(p_full_name, ''));
  v_phone   text := btrim(coalesce(p_phone, ''));
  v_email   text := nullif(btrim(coalesce(p_email, '')), '');
  v_details jsonb;
begin
  if p_kind not in ('booking', 'table', 'message', 'massage') then
    raise exception 'INVALID_KIND: Unknown request type.';
  end if;
  if char_length(v_name) not between 2 and 80 then
    raise exception 'INVALID_NAME: Please enter your name.';
  end if;
  if v_phone !~ '^[0-9+() -]{7,24}$' then
    raise exception 'INVALID_PHONE: Please enter a valid phone number.';
  end if;
  if v_email is not null and (char_length(v_email) > 120 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'INVALID_EMAIL: Please enter a valid email address.';
  end if;
  if p_details is null or jsonb_typeof(p_details) <> 'object' then
    p_details := '{}'::jsonb;
  end if;
  if (select count(*) from public.inquiries where created_at > now() - interval '10 minutes') >= 40 then
    raise exception 'RATE_LIMIT: Too many requests right now. Please call us at 0915 875 4860.';
  end if;

  select coalesce(jsonb_object_agg(key, left(btrim(value), 500)), '{}'::jsonb) into v_details
  from jsonb_each_text(p_details)
  where key in ('check_in', 'check_out', 'guests', 'room_preference', 'date', 'time',
                'party_size', 'special_request', 'notes', 'message', 'massage_type')
    and btrim(value) <> '';

  insert into public.inquiries (kind, full_name, phone, email, details)
  values (p_kind::public.inquiry_kind, v_name, v_phone, v_email, v_details);
end $$;

revoke execute on function public.submit_inquiry(text, text, text, text, jsonb) from public;
grant  execute on function public.submit_inquiry(text, text, text, text, jsonb) to anon, authenticated;

insert into public.massage_services (name, description, duration_minutes, duration_label, price, price_unit, sort_order)
select * from (values
  ('Head, Shoulder & Back Massage', 'Releases light to moderate tension. Try this if you are out working or looking at a computer screen all day.', 30, null, 200::numeric, 'per 30 minutes', 1),
  ('Deep Tissue Massage', 'Aims to relieve tension in the deeper layers of muscle and tissue.', null, 'Duration varies', 350::numeric, 'per 30 minutes', 2),
  ('Sport Massage', 'Aims to address aches caused by repetitive motion and help active people recover faster from stress.', null, 'Duration varies', 300::numeric, 'per 30 minutes', 3)
) as v(name, description, duration_minutes, duration_label, price, price_unit, sort_order)
where not exists (select 1 from public.massage_services);
