-- ============================================================
-- REVIEW ONLY: Secure Patient Auth account linking
-- Do not execute this file from the frontend.
-- ============================================================

begin;

alter table public.patients
  add column if not exists user_id uuid,
  add column if not exists control_used_at timestamptz,
  add column if not exists account_status text not null default 'pending_activation';

-- Patient activation states are stored in public.patients.account_status.
-- public.profiles.account_status uses its existing valid values and must not
-- receive 'pending_activation'.
-- This linking migration preserves any existing public.profiles.account_status
-- value and writes pending_activation only to public.patients.account_status.

-- ============================================================
-- Manual preflight queries
-- Run these read-only checks in Supabase SQL Editor before applying.
-- ============================================================

-- Confirm the exact patients.id and patients.user_id types:
-- select
--   columns.column_name,
--   columns.data_type,
--   columns.udt_schema,
--   columns.udt_name
-- from information_schema.columns as columns
-- where columns.table_schema = 'public'
--   and columns.table_name = 'patients'
--   and columns.column_name in ('id', 'user_id')
-- order by columns.column_name;

-- Inspect any existing patients.user_id foreign key:
-- select
--   constraints.conname,
--   pg_catalog.pg_get_constraintdef(constraints.oid) as definition
-- from pg_catalog.pg_constraint as constraints
-- where constraints.conrelid = 'public.patients'::pg_catalog.regclass
--   and constraints.contype = 'f';

-- Detect duplicate non-null Auth links:
-- select
--   patients.user_id,
--   count(*) as patient_count,
--   array_agg(patients.id order by patients.id) as patient_ids
-- from public.patients as patients
-- where patients.user_id is not null
-- group by patients.user_id
-- having count(*) > 1;

-- Detect duplicate Patient ID/control-number pairs after trimming:
-- select
--   pg_catalog.btrim(patients.patient_id) as patient_id,
--   pg_catalog.btrim(patients.control_number) as control_number,
--   count(*) as patient_count,
--   array_agg(patients.id order by patients.id) as patient_ids
-- from public.patients as patients
-- where pg_catalog.btrim(coalesce(patients.patient_id, '')) <> ''
--   and pg_catalog.btrim(coalesce(patients.control_number, '')) <> ''
-- group by
--   pg_catalog.btrim(patients.patient_id),
--   pg_catalog.btrim(patients.control_number)
-- having count(*) > 1;

-- ============================================================
-- Required uniqueness checks
-- The migration must roll back if existing data violates either rule.
-- ============================================================

do $migration$
declare
  duplicate_user_groups integer;
  duplicate_access_groups integer;
begin
  select count(*)
    into duplicate_user_groups
  from (
    select patients.user_id
    from public.patients as patients
    where patients.user_id is not null
    group by patients.user_id
    having count(*) > 1
  ) as duplicates;

  if duplicate_user_groups > 0 then
    raise exception
      'Cannot enforce one Patient row per Auth user: % duplicate non-null user_id group(s) require manual review.',
      duplicate_user_groups
      using errcode = '23505';
  end if;

  select count(*)
    into duplicate_access_groups
  from (
    select
      pg_catalog.btrim(patients.patient_id),
      pg_catalog.btrim(patients.control_number)
    from public.patients as patients
    where pg_catalog.btrim(coalesce(patients.patient_id, '')) <> ''
      and pg_catalog.btrim(coalesce(patients.control_number, '')) <> ''
    group by
      pg_catalog.btrim(patients.patient_id),
      pg_catalog.btrim(patients.control_number)
    having count(*) > 1
  ) as duplicates;

  if duplicate_access_groups > 0 then
    raise exception
      'Cannot install secure Patient linking: % duplicate Patient ID/control-number pair group(s) require manual review.',
      duplicate_access_groups
      using errcode = '23505';
  end if;
end;
$migration$;

create unique index if not exists patients_user_id_unique
on public.patients (user_id)
where user_id is not null;

-- ============================================================
-- Required Auth user foreign key
-- Add it only when an equivalent single-column foreign key is absent.
-- ============================================================

do $migration$
declare
  patients_table_oid oid := pg_catalog.to_regclass('public.patients');
  auth_users_table_oid oid := pg_catalog.to_regclass('auth.users');
  patient_user_attnum smallint;
  auth_user_id_attnum smallint;
  patient_user_type oid;
  auth_user_id_type oid;
  named_constraint_is_valid boolean;
  equivalent_constraint_exists boolean;
begin
  select attributes.attnum, attributes.atttypid
    into strict patient_user_attnum, patient_user_type
  from pg_catalog.pg_attribute as attributes
  where attributes.attrelid = patients_table_oid
    and attributes.attname = 'user_id'
    and not attributes.attisdropped;

  select attributes.attnum, attributes.atttypid
    into strict auth_user_id_attnum, auth_user_id_type
  from pg_catalog.pg_attribute as attributes
  where attributes.attrelid = auth_users_table_oid
    and attributes.attname = 'id'
    and not attributes.attisdropped;

  if patient_user_type <> auth_user_id_type then
    raise exception
      'Cannot add patients_user_id_fkey because public.patients.user_id type % does not match auth.users.id type %.',
      pg_catalog.format_type(patient_user_type, null),
      pg_catalog.format_type(auth_user_id_type, null)
      using errcode = '42804';
  end if;

  select exists (
    select 1
    from pg_catalog.pg_constraint as constraints
    where constraints.conrelid = patients_table_oid
      and constraints.conname = 'patients_user_id_fkey'
      and constraints.contype = 'f'
      and constraints.confrelid = auth_users_table_oid
      and constraints.conkey = array[patient_user_attnum]::smallint[]
      and constraints.confkey = array[auth_user_id_attnum]::smallint[]
      and constraints.confdeltype = 'n'
  ) into named_constraint_is_valid;

  if exists (
    select 1
    from pg_catalog.pg_constraint as constraints
    where constraints.conrelid = patients_table_oid
      and constraints.conname = 'patients_user_id_fkey'
  ) and not named_constraint_is_valid then
    raise exception
      'Constraint patients_user_id_fkey already exists but does not reference auth.users(id) from public.patients.user_id.'
      using errcode = '42710';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_constraint as constraints
    where constraints.conrelid = patients_table_oid
      and constraints.contype = 'f'
      and constraints.confrelid = auth_users_table_oid
      and constraints.conkey = array[patient_user_attnum]::smallint[]
      and constraints.confkey = array[auth_user_id_attnum]::smallint[]
      and constraints.confdeltype <> 'n'
  ) then
    raise exception
      'An existing public.patients.user_id foreign key does not use ON DELETE SET NULL. Review it manually before applying this migration.'
      using errcode = '42710';
  end if;

  select exists (
    select 1
    from pg_catalog.pg_constraint as constraints
    where constraints.conrelid = patients_table_oid
      and constraints.contype = 'f'
      and constraints.confrelid = auth_users_table_oid
      and constraints.conkey = array[patient_user_attnum]::smallint[]
      and constraints.confkey = array[auth_user_id_attnum]::smallint[]
      and constraints.confdeltype = 'n'
  ) into equivalent_constraint_exists;

  if not equivalent_constraint_exists then
    alter table public.patients
      add constraint patients_user_id_fkey
      foreign key (user_id)
      references auth.users(id)
      on delete set null;
  end if;
end;
$migration$;

-- ============================================================
-- Verify the live primary-key type before defining the RPC signatures.
-- A read-only REST cast check against this project also confirms UUID.
-- Abort instead of installing mismatched functions in another environment.
-- ============================================================

do $migration$
declare
  patients_id_type oid;
begin
  select attributes.atttypid
    into strict patients_id_type
  from pg_catalog.pg_attribute as attributes
  where attributes.attrelid = 'public.patients'::pg_catalog.regclass
    and attributes.attname = 'id'
    and not attributes.attisdropped;

  if patients_id_type <> pg_catalog.to_regtype('pg_catalog.uuid') then
    raise exception
      'public.patients.id is %, but this reviewed migration requires the verified UUID signature. Stop and revise the RPC return types.',
      pg_catalog.format_type(patients_id_type, null)
      using errcode = '42804';
  end if;
end;
$migration$;

create or replace function public.link_patient_auth_account(
  p_patient_id text,
  p_control_number text
)
returns table (
  id uuid,
  patient_id text,
  account_status text,
  linked boolean
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_user_id uuid := auth.uid();
  normalized_patient_id text := pg_catalog.btrim(coalesce(p_patient_id, ''));
  normalized_control_number text := pg_catalog.btrim(coalesce(p_control_number, ''));
  requester_role text;
  selected_patient public.patients%rowtype;
  linked_at timestamptz := pg_catalog.now();
begin
  if current_user_id is null then
    raise exception 'You must be authenticated before linking a patient account.'
      using errcode = '42501';
  end if;

  if normalized_patient_id = '' or normalized_control_number = '' then
    raise exception 'Invalid Patient ID or control number.'
      using errcode = '22023';
  end if;

  select pg_catalog.lower(pg_catalog.btrim(coalesce(profiles.role, '')))
    into requester_role
  from public.profiles as profiles
  where profiles.id = current_user_id
  limit 1;

  if coalesce(requester_role, 'patient') <> 'patient' then
    raise exception 'Only a Patient authentication account can link a patient record.'
      using errcode = '42501';
  end if;

  begin
    select patients.*
      into strict selected_patient
    from public.patients as patients
    where pg_catalog.btrim(coalesce(patients.patient_id, '')) = normalized_patient_id
      and pg_catalog.btrim(coalesce(patients.control_number, '')) = normalized_control_number
    for update;
  exception
    when no_data_found or too_many_rows then
      raise exception 'Invalid Patient ID or control number.'
        using errcode = 'P0001';
  end;

  if pg_catalog.lower(pg_catalog.btrim(coalesce(selected_patient.status, ''))) in ('archived', 'deleted')
     or selected_patient.archived_at is not null then
    raise exception 'This patient record is archived.'
      using errcode = 'P0001';
  end if;

  if selected_patient.user_id is not null
     and selected_patient.user_id <> current_user_id then
    raise exception 'This patient is already linked to another account.'
      using errcode = 'P0001';
  end if;

  if selected_patient.user_id is null
     and selected_patient.control_used_at is not null then
    raise exception 'This control number has already been used.'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.patients as linked_patient
    where linked_patient.user_id = current_user_id
      and linked_patient.id <> selected_patient.id
  ) then
    raise exception 'This authentication account is already linked to another patient record.'
      using errcode = '23505';
  end if;

  if selected_patient.user_id is null then
    update public.patients as patients
    set
      user_id = current_user_id,
      control_used_at = linked_at,
      account_status = 'pending_activation'
    where patients.id = selected_patient.id;

    selected_patient.user_id := current_user_id;
    selected_patient.control_used_at := linked_at;
    selected_patient.account_status := 'pending_activation';
  elsif selected_patient.control_used_at is null then
    update public.patients as patients
    set control_used_at = linked_at
    where patients.id = selected_patient.id;

    selected_patient.control_used_at := linked_at;
  end if;

  return query
  select
    selected_patient.id,
    selected_patient.patient_id,
    case
      when pg_catalog.lower(pg_catalog.btrim(coalesce(selected_patient.status, ''))) in ('archived', 'deleted')
        or selected_patient.archived_at is not null
      then 'archived'
      else coalesce(selected_patient.account_status, 'pending_activation')
    end,
    true;
end;
$function$;

create or replace function public.get_current_patient_account_status()
returns table (
  id uuid,
  patient_id text,
  account_status text,
  linked boolean
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    patients.id,
    patients.patient_id,
    case
      when pg_catalog.lower(pg_catalog.btrim(coalesce(patients.status, ''))) in ('archived', 'deleted')
        or patients.archived_at is not null
      then 'archived'
      else coalesce(patients.account_status, 'pending_activation')
    end as account_status,
    true as linked
  from public.patients as patients
  where auth.uid() is not null
    and patients.user_id = auth.uid();
$function$;

revoke all on function public.link_patient_auth_account(text, text) from public;
revoke all on function public.link_patient_auth_account(text, text) from anon;
grant execute on function public.link_patient_auth_account(text, text) to authenticated;

revoke all on function public.get_current_patient_account_status() from public;
revoke all on function public.get_current_patient_account_status() from anon;
grant execute on function public.get_current_patient_account_status() to authenticated;

-- ============================================================
-- Optional legacy cleanup - intentionally NOT executed here.
-- Only consider this after the secure QR/linking flow is manually verified
-- and repository search confirms no active code calls the legacy RPC.
-- ============================================================
-- revoke all on function public.get_patient_login_access_record(text, text)
--   from public;
-- revoke all on function public.get_patient_login_access_record(text, text)
--   from anon;
-- revoke all on function public.get_patient_login_access_record(text, text)
--   from authenticated;

notify pgrst, 'reload schema';

-- Manual post-application verification:
-- select id, patient_id, user_id, control_used_at, status, account_status
-- from public.patients
-- order by created_at desc nulls last;
--
-- select
--   constraints.conname,
--   pg_catalog.pg_get_constraintdef(constraints.oid) as definition
-- from pg_catalog.pg_constraint as constraints
-- where constraints.conrelid = 'public.patients'::pg_catalog.regclass
--   and constraints.conname = 'patients_user_id_fkey';
--
-- select indexes.indexdef
-- from pg_catalog.pg_indexes as indexes
-- where indexes.schemaname = 'public'
--   and indexes.tablename = 'patients'
--   and indexes.indexname = 'patients_user_id_unique';

commit;
