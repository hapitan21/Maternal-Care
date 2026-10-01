-- Secure Patient-owned native Android push registration persistence.
-- This migration stores FCM registration tokens only. It does not send push
-- notifications, create delivery records, or change the existing Web Push flow.

begin;

-- Fail before creating objects if the deployed Patient identity/account shape
-- is not compatible with the authorization checks below.
do $preflight$
declare
  v_column record;
  v_actual_type text;
begin
  if pg_catalog.to_regclass('public.patients') is null then
    raise exception 'Preflight failed: public.patients does not exist.';
  end if;

  if pg_catalog.to_regclass('public.profiles') is null then
    raise exception 'Preflight failed: public.profiles does not exist.';
  end if;

  if pg_catalog.to_regclass('auth.users') is null then
    raise exception 'Preflight failed: auth.users does not exist.';
  end if;

  if pg_catalog.to_regclass('public.patient_native_push_devices') is not null then
    raise exception 'Preflight failed: public.patient_native_push_devices already exists.';
  end if;

  for v_column in
    select *
    from (values
      ('public', 'patients', 'id', 'uuid'),
      ('public', 'patients', 'user_id', 'uuid'),
      ('public', 'patients', 'account_status', 'text'),
      ('public', 'patients', 'status', 'text'),
      ('public', 'patients', 'archived_at', 'timestamptz'),
      ('public', 'profiles', 'id', 'uuid'),
      ('public', 'profiles', 'role', 'text'),
      ('public', 'profiles', 'account_status', 'text'),
      ('auth', 'users', 'id', 'uuid')
    ) as expected(table_schema, table_name, column_name, expected_type)
  loop
    select columns.udt_name
      into v_actual_type
    from information_schema.columns
    where columns.table_schema = v_column.table_schema
      and columns.table_name = v_column.table_name
      and columns.column_name = v_column.column_name;

    if v_actual_type is null or v_actual_type <> v_column.expected_type then
      raise exception 'Preflight failed: %.%.% expected % but found %.',
        v_column.table_schema,
        v_column.table_name,
        v_column.column_name,
        v_column.expected_type,
        pg_catalog.coalesce(v_actual_type, 'missing');
    end if;
  end loop;
end;
$preflight$;

create table public.patient_native_push_devices (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  patient_id uuid not null,
  user_id uuid not null,
  platform text not null default 'android',
  installation_id text not null,
  push_token text not null,
  enabled boolean not null default true,
  last_seen_at timestamptz not null default pg_catalog.now(),
  disabled_at timestamptz,
  app_version text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint patient_native_push_devices_patient_id_fkey
    foreign key (patient_id)
    references public.patients(id)
    on delete cascade,
  constraint patient_native_push_devices_user_id_fkey
    foreign key (user_id)
    references auth.users(id)
    on delete cascade,
  constraint patient_native_push_devices_platform_check
    check (platform = 'android'),
  constraint patient_native_push_devices_installation_id_check
    check (
      installation_id = pg_catalog.btrim(installation_id)
      and pg_catalog.char_length(installation_id) between 16 and 200
    ),
  constraint patient_native_push_devices_push_token_check
    check (
      push_token = pg_catalog.btrim(push_token)
      and pg_catalog.char_length(push_token) between 32 and 4096
    ),
  constraint patient_native_push_devices_app_version_check
    check (
      app_version is null
      or (
        app_version = pg_catalog.btrim(app_version)
        and pg_catalog.char_length(app_version) between 1 and 128
      )
    ),
  constraint patient_native_push_devices_enabled_state_check
    check (
      (enabled and disabled_at is null)
      or (not enabled and disabled_at is not null)
    ),
  constraint patient_native_push_devices_push_token_key
    unique (push_token),
  constraint patient_native_push_devices_platform_installation_key
    unique (platform, installation_id)
);

comment on table public.patient_native_push_devices is
  'Patient-owned native Android FCM registrations. Tokens are sensitive and available only to trusted server contexts.';
comment on column public.patient_native_push_devices.installation_id is
  'Random app-install identifier; never a hardware or advertising identifier.';
comment on column public.patient_native_push_devices.push_token is
  'Sensitive FCM registration token. Never return it from Patient-facing RPCs or include it in logs.';

create index patient_native_push_devices_patient_enabled_idx
  on public.patient_native_push_devices (patient_id, enabled);

create or replace function public.set_patient_native_push_devices_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;

create trigger patient_native_push_devices_set_updated_at
before update on public.patient_native_push_devices
for each row
execute function public.set_patient_native_push_devices_updated_at();

alter table public.patient_native_push_devices enable row level security;

-- Intentionally create no browser-facing table policies. Patient clients use
-- the ownership-verifying RPCs below, and a later trusted sender will use the
-- service role.
revoke all privileges
on table public.patient_native_push_devices
from public, anon, authenticated;

grant select, update
on table public.patient_native_push_devices
to service_role;

create or replace function public.upsert_my_patient_native_push_device(
  p_installation_id text,
  p_push_token text,
  p_platform text default 'android',
  p_app_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_patient_id uuid;
  v_installation_id text := pg_catalog.btrim(pg_catalog.coalesce(p_installation_id, ''));
  v_push_token text := pg_catalog.btrim(pg_catalog.coalesce(p_push_token, ''));
  v_platform text := pg_catalog.lower(pg_catalog.btrim(pg_catalog.coalesce(p_platform, '')));
  v_app_version text := pg_catalog.nullif(
    pg_catalog.btrim(pg_catalog.coalesce(p_app_version, '')),
    ''
  );
  v_device_id uuid;
  v_enabled boolean;
  v_created_at timestamptz;
  v_updated_at timestamptz;
  v_last_seen_at timestamptz;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;

  begin
    select patient.id
      into strict v_patient_id
    from public.patients as patient
    join public.profiles as profile
      on profile.id = patient.user_id
    where patient.user_id = v_user_id
      and pg_catalog.lower(pg_catalog.btrim(pg_catalog.coalesce(profile.role, ''))) = 'patient'
      and pg_catalog.lower(pg_catalog.btrim(pg_catalog.coalesce(profile.account_status, ''))) = 'active'
      and pg_catalog.lower(pg_catalog.btrim(pg_catalog.coalesce(patient.account_status, ''))) = 'active'
      and patient.archived_at is null
      and pg_catalog.lower(pg_catalog.btrim(pg_catalog.coalesce(patient.status, '')))
        not in ('archived', 'deleted');
  exception
    when no_data_found then
      raise exception 'An active linked Patient account is required.'
        using errcode = '42501';
    when too_many_rows then
      raise exception 'Multiple active Patient records are linked to this account.'
        using errcode = 'P0001';
  end;

  if v_platform <> 'android' then
    raise exception 'Only Android native push registrations are supported.'
      using errcode = '22023';
  end if;

  if pg_catalog.char_length(v_installation_id) < 16
     or pg_catalog.char_length(v_installation_id) > 200 then
    raise exception 'The app installation identifier is invalid.'
      using errcode = '22023';
  end if;

  if pg_catalog.char_length(v_push_token) < 32
     or pg_catalog.char_length(v_push_token) > 4096 then
    raise exception 'The native push registration token is invalid.'
      using errcode = '22023';
  end if;

  if v_app_version is not null
     and pg_catalog.char_length(v_app_version) > 128 then
    raise exception 'The app version is too long.'
      using errcode = '22023';
  end if;

  -- A token may rotate for its own installation, but a token already assigned
  -- to another installation must never be silently claimed.
  if exists (
    select 1
    from public.patient_native_push_devices as existing_device
    where existing_device.push_token = v_push_token
      and (
        existing_device.platform <> v_platform
        or existing_device.installation_id <> v_installation_id
      )
  ) then
    raise exception 'The native push registration conflicts with another app installation.'
      using errcode = '23505';
  end if;

  begin
    insert into public.patient_native_push_devices (
      patient_id,
      user_id,
      platform,
      installation_id,
      push_token,
      enabled,
      last_seen_at,
      disabled_at,
      app_version
    )
    values (
      v_patient_id,
      v_user_id,
      v_platform,
      v_installation_id,
      v_push_token,
      true,
      pg_catalog.now(),
      null,
      v_app_version
    )
    on conflict (platform, installation_id)
    do update set
      patient_id = excluded.patient_id,
      user_id = excluded.user_id,
      push_token = excluded.push_token,
      enabled = true,
      last_seen_at = pg_catalog.now(),
      disabled_at = null,
      app_version = excluded.app_version
    returning id, enabled, created_at, updated_at, last_seen_at
      into v_device_id, v_enabled, v_created_at, v_updated_at, v_last_seen_at;
  exception
    when unique_violation then
      raise exception 'The native push registration conflicts with another app installation.'
        using errcode = '23505';
  end;

  return pg_catalog.jsonb_build_object(
    'device_id', v_device_id,
    'enabled', v_enabled,
    'platform', v_platform,
    'created_at', v_created_at,
    'updated_at', v_updated_at,
    'last_seen_at', v_last_seen_at
  );
end;
$function$;

create or replace function public.deactivate_my_patient_native_push_device(
  p_installation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_patient_id uuid;
  v_installation_id text := pg_catalog.btrim(pg_catalog.coalesce(p_installation_id, ''));
  v_device_id uuid;
  v_updated_at timestamptz;
  v_disabled_at timestamptz;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;

  begin
    select patient.id
      into strict v_patient_id
    from public.patients as patient
    join public.profiles as profile
      on profile.id = patient.user_id
    where patient.user_id = v_user_id
      and pg_catalog.lower(pg_catalog.btrim(pg_catalog.coalesce(profile.role, ''))) = 'patient'
      and pg_catalog.lower(pg_catalog.btrim(pg_catalog.coalesce(profile.account_status, ''))) = 'active'
      and pg_catalog.lower(pg_catalog.btrim(pg_catalog.coalesce(patient.account_status, ''))) = 'active'
      and patient.archived_at is null
      and pg_catalog.lower(pg_catalog.btrim(pg_catalog.coalesce(patient.status, '')))
        not in ('archived', 'deleted');
  exception
    when no_data_found then
      raise exception 'An active linked Patient account is required.'
        using errcode = '42501';
    when too_many_rows then
      raise exception 'Multiple active Patient records are linked to this account.'
        using errcode = 'P0001';
  end;

  if pg_catalog.char_length(v_installation_id) < 16
     or pg_catalog.char_length(v_installation_id) > 200 then
    raise exception 'The app installation identifier is invalid.'
      using errcode = '22023';
  end if;

  update public.patient_native_push_devices as device
  set
    enabled = false,
    disabled_at = pg_catalog.coalesce(device.disabled_at, pg_catalog.now()),
    updated_at = pg_catalog.now()
  where device.platform = 'android'
    and device.installation_id = v_installation_id
    and device.patient_id = v_patient_id
    and device.user_id = v_user_id
  returning device.id, device.updated_at, device.disabled_at
    into v_device_id, v_updated_at, v_disabled_at;

  return pg_catalog.jsonb_build_object(
    'found', v_device_id is not null,
    'device_id', v_device_id,
    'enabled', false,
    'platform', 'android',
    'updated_at', v_updated_at,
    'disabled_at', v_disabled_at
  );
end;
$function$;

create or replace function public.get_my_patient_native_push_device_status(
  p_installation_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_patient_id uuid;
  v_installation_id text := pg_catalog.btrim(pg_catalog.coalesce(p_installation_id, ''));
  v_status jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;

  begin
    select patient.id
      into strict v_patient_id
    from public.patients as patient
    join public.profiles as profile
      on profile.id = patient.user_id
    where patient.user_id = v_user_id
      and pg_catalog.lower(pg_catalog.btrim(pg_catalog.coalesce(profile.role, ''))) = 'patient'
      and pg_catalog.lower(pg_catalog.btrim(pg_catalog.coalesce(profile.account_status, ''))) = 'active'
      and pg_catalog.lower(pg_catalog.btrim(pg_catalog.coalesce(patient.account_status, ''))) = 'active'
      and patient.archived_at is null
      and pg_catalog.lower(pg_catalog.btrim(pg_catalog.coalesce(patient.status, '')))
        not in ('archived', 'deleted');
  exception
    when no_data_found then
      raise exception 'An active linked Patient account is required.'
        using errcode = '42501';
    when too_many_rows then
      raise exception 'Multiple active Patient records are linked to this account.'
        using errcode = 'P0001';
  end;

  if pg_catalog.char_length(v_installation_id) < 16
     or pg_catalog.char_length(v_installation_id) > 200 then
    raise exception 'The app installation identifier is invalid.'
      using errcode = '22023';
  end if;

  select pg_catalog.jsonb_build_object(
    'found', true,
    'device_id', device.id,
    'enabled', device.enabled,
    'platform', device.platform,
    'last_seen_at', device.last_seen_at,
    'updated_at', device.updated_at,
    'disabled_at', device.disabled_at
  )
    into v_status
  from public.patient_native_push_devices as device
  where device.platform = 'android'
    and device.installation_id = v_installation_id
    and device.patient_id = v_patient_id
    and device.user_id = v_user_id;

  return pg_catalog.coalesce(
    v_status,
    pg_catalog.jsonb_build_object(
      'found', false,
      'enabled', false,
      'platform', 'android'
    )
  );
end;
$function$;

revoke all on function public.set_patient_native_push_devices_updated_at()
  from public, anon, authenticated;

revoke all on function public.upsert_my_patient_native_push_device(
  text, text, text, text
) from public, anon, authenticated;
grant execute on function public.upsert_my_patient_native_push_device(
  text, text, text, text
) to authenticated;

revoke all on function public.deactivate_my_patient_native_push_device(text)
  from public, anon, authenticated;
grant execute on function public.deactivate_my_patient_native_push_device(text)
  to authenticated;

revoke all on function public.get_my_patient_native_push_device_status(text)
  from public, anon, authenticated;
grant execute on function public.get_my_patient_native_push_device_status(text)
  to authenticated;

notify pgrst, 'reload schema';

commit;
