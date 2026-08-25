-- ============================================================
-- REVIEW ONLY: Staff account management and access enforcement
-- Do not run automatically from the frontend.
-- ============================================================

begin;

do $preflight$
declare
  v_mismatch text;
begin
  if pg_catalog.to_regclass('public.profiles') is null then
    raise exception 'Preflight failed: public.profiles does not exist.';
  end if;

  if pg_catalog.to_regclass('public.staff_professional_information') is null then
    raise exception 'Preflight failed: public.staff_professional_information does not exist.';
  end if;

  select pg_catalog.string_agg(
    expected.table_name || '.' || expected.column_name ||
    ' expected ' || expected.data_type || ' but found ' ||
    coalesce(actual.data_type, 'missing'),
    '; '
  )
  into v_mismatch
  from (
    values
      ('profiles', 'id', 'uuid'),
      ('profiles', 'full_name', 'text'),
      ('profiles', 'email', 'text'),
      ('profiles', 'role', 'text'),
      ('profiles', 'created_at', 'timestamp with time zone'),
      ('staff_professional_information', 'id', 'bigint'),
      ('staff_professional_information', 'auth_user_id', 'uuid'),
      ('staff_professional_information', 'staff_code', 'text'),
      ('staff_professional_information', 'created_at', 'timestamp with time zone')
  ) as expected(table_name, column_name, data_type)
  left join (
    select
      columns.table_name,
      columns.column_name,
      columns.data_type
    from information_schema.columns
    where columns.table_schema = 'public'
  ) as actual
    on actual.table_name = expected.table_name
   and actual.column_name = expected.column_name
  where actual.column_name is null
     or actual.data_type <> expected.data_type;

  if v_mismatch is not null then
    raise exception 'Preflight failed: %', v_mismatch;
  end if;
end;
$preflight$;

alter table public.profiles
  add column if not exists account_status text not null default 'active',
  add column if not exists deactivated_at timestamptz,
  add column if not exists deactivated_by uuid,
  add column if not exists reactivated_at timestamptz,
  add column if not exists reactivated_by uuid;

alter table public.staff_professional_information
  add column if not exists position text;

do $post_alter_preflight$
declare
  v_mismatch text;
begin
  select pg_catalog.string_agg(
    expected.table_name || '.' || expected.column_name ||
    ' expected ' || expected.data_type || ' but found ' ||
    coalesce(actual.data_type, 'missing'),
    '; '
  )
  into v_mismatch
  from (
    values
      ('profiles', 'account_status', 'text'),
      ('profiles', 'deactivated_at', 'timestamp with time zone'),
      ('profiles', 'deactivated_by', 'uuid'),
      ('profiles', 'reactivated_at', 'timestamp with time zone'),
      ('profiles', 'reactivated_by', 'uuid'),
      ('staff_professional_information', 'position', 'text')
  ) as expected(table_name, column_name, data_type)
  left join (
    select
      columns.table_name,
      columns.column_name,
      columns.data_type
    from information_schema.columns
    where columns.table_schema = 'public'
  ) as actual
    on actual.table_name = expected.table_name
   and actual.column_name = expected.column_name
  where actual.column_name is null
     or actual.data_type <> expected.data_type;

  if v_mismatch is not null then
    raise exception 'Post-alter preflight failed: %', v_mismatch;
  end if;
end;
$post_alter_preflight$;

do $constraints$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'profiles_account_status_check'
      and conrelid = 'public.profiles'::pg_catalog.regclass
  ) then
    alter table public.profiles
      add constraint profiles_account_status_check
      check (account_status in ('active', 'inactive'));
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'profiles_deactivated_by_fkey'
      and conrelid = 'public.profiles'::pg_catalog.regclass
  ) then
    alter table public.profiles
      add constraint profiles_deactivated_by_fkey
      foreign key (deactivated_by)
      references auth.users(id)
      on delete set null;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'profiles_reactivated_by_fkey'
      and conrelid = 'public.profiles'::pg_catalog.regclass
  ) then
    alter table public.profiles
      add constraint profiles_reactivated_by_fkey
      foreign key (reactivated_by)
      references auth.users(id)
      on delete set null;
  end if;
end;
$constraints$;

-- Preserve existing codes. Only professional rows without a code are backfilled.
update public.staff_professional_information as professional
set staff_code =
  'STAFF-' ||
  pg_catalog.date_part('year', coalesce(professional.created_at, pg_catalog.now()))::integer::text ||
  '-' ||
  pg_catalog.lpad(professional.id::text, 4, '0')
where pg_catalog.btrim(coalesce(professional.staff_code, '')) = '';

do $staff_code_preflight$
begin
  if exists (
    select 1
    from public.staff_professional_information as professional
    where pg_catalog.btrim(coalesce(professional.staff_code, '')) <> ''
    group by pg_catalog.lower(pg_catalog.btrim(professional.staff_code))
    having pg_catalog.count(*) > 1
  ) then
    raise exception 'Preflight failed: duplicate staff_code values must be resolved before applying the unique index.';
  end if;
end;
$staff_code_preflight$;

create unique index if not exists staff_professional_information_staff_code_uidx
on public.staff_professional_information (
  pg_catalog.lower(pg_catalog.btrim(staff_code))
)
where pg_catalog.btrim(coalesce(staff_code, '')) <> '';

create index if not exists profiles_staff_account_status_idx
on public.profiles (account_status)
where pg_catalog.lower(pg_catalog.btrim(coalesce(role, ''))) = 'staff';

create or replace function public.is_current_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''))) = 'admin'
  );
$function$;

create or replace function public.is_active_staff_profile(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.profiles as profile
    where profile.id = p_user_id
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''))) = 'staff'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''))) = 'active'
  );
$function$;

drop function if exists public.set_staff_account_status(uuid, text);

create function public.set_staff_account_status(
  p_staff_profile_id uuid,
  p_account_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_status text;
  v_profile public.profiles%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  if not public.is_current_admin() then
    raise exception 'Only an Admin can change Staff account access.' using errcode = '42501';
  end if;

  v_status := pg_catalog.lower(pg_catalog.btrim(coalesce(p_account_status, '')));
  if v_status not in ('active', 'inactive') then
    raise exception 'Staff account status must be active or inactive.' using errcode = '22023';
  end if;

  update public.profiles as profile
  set
    account_status = v_status,
    deactivated_at = case
      when v_status = 'inactive' then pg_catalog.now()
      else profile.deactivated_at
    end,
    deactivated_by = case
      when v_status = 'inactive' then auth.uid()
      else profile.deactivated_by
    end,
    reactivated_at = case
      when v_status = 'active' then pg_catalog.now()
      else null
    end,
    reactivated_by = case
      when v_status = 'active' then auth.uid()
      else null
    end
  where profile.id = p_staff_profile_id
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''))) = 'staff'
  returning profile.* into v_profile;

  if v_profile.id is null then
    raise exception 'The selected Staff profile was not found.' using errcode = 'P0002';
  end if;

  return pg_catalog.jsonb_build_object(
    'id', v_profile.id,
    'full_name', v_profile.full_name,
    'email', v_profile.email,
    'role', v_profile.role,
    'account_status', v_profile.account_status,
    'deactivated_at', v_profile.deactivated_at,
    'deactivated_by', v_profile.deactivated_by,
    'reactivated_at', v_profile.reactivated_at,
    'reactivated_by', v_profile.reactivated_by,
    'created_at', v_profile.created_at
  );
end;
$function$;

alter table public.staff_personal_information enable row level security;
alter table public.staff_professional_information enable row level security;

drop policy if exists "Staff users can manage own personal information"
  on public.staff_personal_information;
create policy "Staff users can manage own personal information"
on public.staff_personal_information
for all
to authenticated
using (
  auth_user_id = auth.uid()
  and public.is_active_staff_profile(auth.uid())
)
with check (
  auth_user_id = auth.uid()
  and public.is_active_staff_profile(auth.uid())
);

drop policy if exists "Staff users can manage own professional information"
  on public.staff_professional_information;
create policy "Staff users can manage own professional information"
on public.staff_professional_information
for all
to authenticated
using (
  auth_user_id = auth.uid()
  and public.is_active_staff_profile(auth.uid())
)
with check (
  auth_user_id = auth.uid()
  and public.is_active_staff_profile(auth.uid())
);

revoke all on function public.is_current_admin() from public, anon;
grant execute on function public.is_current_admin() to authenticated;

revoke all on function public.is_active_staff_profile(uuid) from public, anon;
grant execute on function public.is_active_staff_profile(uuid) to authenticated;

revoke all on function public.set_staff_account_status(uuid, text) from public, anon;
grant execute on function public.set_staff_account_status(uuid, text) to authenticated;

notify pgrst, 'reload schema';

-- Manual verification after applying:
-- select id, full_name, role, account_status, deactivated_at, deactivated_by,
--        reactivated_at, reactivated_by, created_at
-- from public.profiles
-- where lower(trim(coalesce(role, ''))) = 'staff'
-- order by created_at desc;
--
-- select auth_user_id, staff_code, position, created_at
-- from public.staff_professional_information
-- order by created_at desc;
--
-- select schemaname, tablename, policyname, roles, cmd, qual, with_check
-- from pg_policies
-- where schemaname = 'public'
--   and tablename in ('profiles', 'staff_personal_information', 'staff_professional_information')
-- order by tablename, policyname;

commit;
