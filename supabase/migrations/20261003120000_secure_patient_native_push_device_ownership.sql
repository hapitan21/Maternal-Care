-- Normal registration may create a device or update its current owner only.
-- This deliberately supplies no cross-Patient installation transfer workflow.

begin;

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
  v_installation_id text := pg_catalog.btrim(coalesce(p_installation_id, ''));
  v_push_token text := pg_catalog.btrim(coalesce(p_push_token, ''));
  v_platform text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_platform, '')));
  v_app_version text := nullif(
    pg_catalog.btrim(coalesce(p_app_version, '')),
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
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''))) = 'patient'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''))) = 'active'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.account_status, ''))) = 'active'
      and patient.archived_at is null
      and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.status, '')))
        not in ('inactive', 'archived', 'deleted');
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
    insert into public.patient_native_push_devices as device (
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
      push_token = excluded.push_token,
      enabled = true,
      last_seen_at = pg_catalog.now(),
      disabled_at = null,
      app_version = excluded.app_version
    -- The conflict row is locked before this predicate is evaluated, including
    -- concurrent inserts. A locator alone never authorizes an ownership change.
    where device.patient_id = v_patient_id
      and device.user_id = v_user_id
    returning device.id, device.enabled, device.created_at, device.updated_at, device.last_seen_at
      into v_device_id, v_enabled, v_created_at, v_updated_at, v_last_seen_at;

    -- DO UPDATE WHERE false returns no row and fires no update trigger.
    if not found then
      raise exception 'The native push registration conflicts with another app installation.'
        using errcode = '42501';
    end if;
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

-- Preserve the existing Patient-facing RPC privilege boundary.
revoke all on function public.upsert_my_patient_native_push_device(
  text, text, text, text
) from public, anon, authenticated;

grant execute on function public.upsert_my_patient_native_push_device(
  text, text, text, text
) to authenticated;

notify pgrst, 'reload schema';

commit;
