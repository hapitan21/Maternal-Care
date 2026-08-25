begin;

do $$
begin
  if to_regclass('public.staff_personal_information') is null then
    raise exception 'Required table public.staff_personal_information is missing.';
  end if;

  if to_regclass('public.staff_professional_information') is null then
    raise exception 'Required table public.staff_professional_information is missing.';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'staff_personal_information'
      and column_name = 'auth_user_id'
  ) then
    raise exception 'Required column public.staff_personal_information.auth_user_id is missing.';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'staff_professional_information'
      and column_name = 'auth_user_id'
  ) then
    raise exception 'Required column public.staff_professional_information.auth_user_id is missing.';
  end if;
end $$;

alter table public.staff_personal_information
  add column if not exists address text;

alter table public.staff_professional_information
  add column if not exists position text,
  add column if not exists date_hired date,
  add column if not exists employment_status text;

comment on column public.staff_personal_information.address is
  'Staff personal address. Staff profile data must be read from Staff-owned tables, not Doctor profile tables.';

comment on column public.staff_professional_information.position is
  'Staff position or role label for Staff Profile and Settings.';

comment on column public.staff_professional_information.date_hired is
  'Staff employment start date for Staff Profile and Settings.';

comment on column public.staff_professional_information.employment_status is
  'Staff employment status for Staff Profile and Settings.';

notify pgrst, 'reload schema';

commit;
