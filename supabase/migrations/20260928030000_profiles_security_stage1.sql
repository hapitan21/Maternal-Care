-- Stage 1: move legitimate profile identity writes behind trusted RPCs.
--
-- This migration is intentionally backward-compatible. Existing table grants
-- and RLS policies remain in place until the updated clients have been
-- runtime-verified and the separate Stage 2 lockdown is approved.

begin;

-- Fail before replacing functions if the live profiles shape is not compatible
-- with the identity fields used by the existing application workflows.
do $preflight$
declare
  v_column record;
  v_actual text;
  v_unsupported_required_columns text;
begin
  if pg_catalog.to_regclass('public.profiles') is null then
    raise exception 'Preflight failed: public.profiles does not exist.';
  end if;

  if pg_catalog.to_regclass('auth.users') is null then
    raise exception 'Preflight failed: auth.users does not exist.';
  end if;

  for v_column in
    select *
    from (values
      ('id', 'uuid'),
      ('full_name', 'text'),
      ('email', 'text'),
      ('role', 'text'),
      ('account_status', 'text')
    ) as expected(column_name, expected_type)
  loop
    select columns.udt_name
      into v_actual
    from information_schema.columns
    where columns.table_schema = 'public'
      and columns.table_name = 'profiles'
      and columns.column_name = v_column.column_name;

    if v_actual is null or v_actual <> v_column.expected_type then
      raise exception 'Preflight failed: public.profiles.% expected % but found %.',
        v_column.column_name,
        v_column.expected_type,
        coalesce(v_actual, 'missing');
    end if;
  end loop;

  select pg_catalog.string_agg(columns.column_name, ', ' order by columns.ordinal_position)
    into v_unsupported_required_columns
  from information_schema.columns
  where columns.table_schema = 'public'
    and columns.table_name = 'profiles'
    and columns.is_nullable = 'NO'
    and columns.column_default is null
    and columns.is_identity = 'NO'
    and columns.is_generated = 'NEVER'
    and columns.column_name not in ('id', 'full_name', 'email', 'role');

  if v_unsupported_required_columns is not null then
    raise exception 'Preflight failed: public.profiles has required columns without defaults: %.',
      v_unsupported_required_columns;
  end if;
end;
$preflight$;

create or replace function public.ensure_current_patient_profile()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_auth_email text;
  v_auth_full_name text;
  v_profile public.profiles%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select
    nullif(pg_catalog.btrim(coalesce(users.email, '')), ''),
    nullif(pg_catalog.btrim(coalesce(users.raw_user_meta_data ->> 'full_name', '')), '')
  into v_auth_email, v_auth_full_name
  from auth.users as users
  where users.id = v_user_id;

  if not found then
    raise exception 'The authenticated account was not found.' using errcode = 'P0002';
  end if;

  if v_auth_email is null then
    raise exception 'The authenticated account does not have an email address.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.patients as patient
    where patient.user_id = v_user_id
  ) then
    raise exception 'A clinic-linked Patient record is required.'
      using errcode = '42501';
  end if;

  select profile.*
    into v_profile
  from public.profiles as profile
  where profile.id = v_user_id
  for update;

  if found then
    if pg_catalog.lower(pg_catalog.btrim(coalesce(v_profile.role, ''))) <> 'patient' then
      raise exception 'This login is not a Patient account.' using errcode = '42501';
    end if;

    update public.profiles as profile
    set
      full_name = coalesce(
        nullif(pg_catalog.btrim(coalesce(profile.full_name, '')), ''),
        v_auth_full_name,
        'Patient'
      ),
      email = v_auth_email
    where profile.id = v_user_id
    returning profile.* into v_profile;
  else
    begin
      insert into public.profiles (
        id,
        full_name,
        email,
        role
      )
      values (
        v_user_id,
        coalesce(v_auth_full_name, 'Patient'),
        v_auth_email,
        'patient'
      )
      returning * into v_profile;
    exception
      when unique_violation then
        select profile.*
          into v_profile
        from public.profiles as profile
        where profile.id = v_user_id
        for update;

        if not found
           or pg_catalog.lower(pg_catalog.btrim(coalesce(v_profile.role, ''))) <> 'patient' then
          raise exception 'This login is not a Patient account.' using errcode = '42501';
        end if;

        update public.profiles as profile
        set
          full_name = coalesce(
            nullif(pg_catalog.btrim(coalesce(profile.full_name, '')), ''),
            v_auth_full_name,
            'Patient'
          ),
          email = v_auth_email
        where profile.id = v_user_id
        returning profile.* into v_profile;
    end;
  end if;

  return pg_catalog.jsonb_build_object('profile_id', v_profile.id);
end;
$function$;

create or replace function public.sync_current_profile_email()
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_auth_email text;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select nullif(pg_catalog.btrim(coalesce(users.email, '')), '')
    into v_auth_email
  from auth.users as users
  where users.id = v_user_id;

  if not found then
    raise exception 'The authenticated account was not found.' using errcode = 'P0002';
  end if;

  if v_auth_email is null then
    raise exception 'The authenticated account does not have an email address.'
      using errcode = '22023';
  end if;

  update public.profiles as profile
  set email = v_auth_email
  where profile.id = v_user_id;

  if not found then
    raise exception 'The authenticated profile was not found.' using errcode = 'P0002';
  end if;

  return v_auth_email;
end;
$function$;

revoke all on function public.ensure_current_patient_profile()
  from public, anon, authenticated;
grant execute on function public.ensure_current_patient_profile()
  to authenticated;

revoke all on function public.sync_current_profile_email()
  from public, anon, authenticated;
grant execute on function public.sync_current_profile_email()
  to authenticated;

-- Preserve the existing audit implementation and add only the missing
-- User Management authorization boundary.
create or replace function public.record_audit_event(
  p_module text,
  p_action text,
  p_entity_type text default null,
  p_entity_id text default null,
  p_description text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_request_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_name text;
  v_actor_role text;
  v_actor_status text;
  v_module text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_module, ''::text)));
  v_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_action, ''::text)));
  v_entity_type text := nullif(pg_catalog.btrim(coalesce(p_entity_type, ''::text)), '');
  v_entity_id text := nullif(pg_catalog.btrim(coalesce(p_entity_id, ''::text)), '');
  v_description text := pg_catalog.btrim(coalesce(p_description, ''::text));
  v_metadata jsonb := coalesce(p_metadata, '{}'::jsonb);
  v_headers jsonb := '{}'::jsonb;
  v_ip_text text;
  v_ip inet;
  v_user_agent text;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select
    pg_catalog.left(
      coalesce(nullif(pg_catalog.btrim(profile.full_name), ''), 'Unknown user'),
      160
    ),
    pg_catalog.left(
      pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))),
      50
    ),
    pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text)))
  into v_actor_name, v_actor_role, v_actor_status
  from public.profiles as profile
  where profile.id = auth.uid();

  if not found or v_actor_status is distinct from 'active' then
    raise exception 'An active authenticated profile is required.' using errcode = '42501';
  end if;

  if v_actor_role = '' then
    raise exception 'The authenticated profile role is unavailable.' using errcode = '42501';
  end if;

  if v_module = 'user_management' and v_actor_role <> 'admin' then
    raise exception 'Only an active Admin can record User Management audit events.'
      using errcode = '42501';
  end if;

  if v_module not in (
    'authentication', 'user_management', 'patient_management',
    'appointment_management', 'reminder_management', 'visit_records',
    'reports', 'system_settings'
  ) then
    raise exception 'Unsupported audit module.' using errcode = '22023';
  end if;

  if v_action not in (
    'create', 'update', 'delete', 'login', 'logout', 'activate',
    'deactivate', 'reactivate', 'cancel', 'reschedule', 'check_in',
    'complete', 'export', 'print', 'archive', 'link', 'register',
    'finish', 'acknowledge', 'reassign', 'role_change', 'settings_update'
  ) then
    raise exception 'Unsupported audit action.' using errcode = '22023';
  end if;

  if v_description = '' or pg_catalog.char_length(v_description) > 500 then
    raise exception 'Audit description must contain between 1 and 500 characters.'
      using errcode = '22023';
  end if;

  if v_entity_type is not null and pg_catalog.char_length(v_entity_type) > 80 then
    raise exception 'Audit entity type is too long.' using errcode = '22023';
  end if;
  if v_entity_id is not null and pg_catalog.char_length(v_entity_id) > 160 then
    raise exception 'Audit entity identifier is too long.' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(v_metadata) <> 'object'
     or pg_catalog.octet_length(v_metadata::text) > 4096 then
    raise exception 'Audit metadata must be a JSON object no larger than 4096 bytes.'
      using errcode = '22023';
  end if;

  if pg_catalog.lower(v_metadata::text) ~
       '"[^"]*(password|passcode|pwd|token|secret|api[_-]?key|apikey|otp|cookie|authorization|session|diagnosis|medication|dosage|clinical|medical|form_data|reassignment_reason)[^"]*"[[:space:]]*:'
     or v_metadata::text ~* 'bearer[[:space:]]+[a-z0-9._~+/-]+={0,2}'
     or v_metadata::text ~* 'eyj[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+'
     or v_description ~* 'bearer[[:space:]]+[a-z0-9._~+/-]+={0,2}'
     or v_description ~* 'eyj[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+' then
    raise exception 'Audit content contains prohibited sensitive information.'
      using errcode = '22023';
  end if;

  begin
    v_headers := coalesce(
      nullif(pg_catalog.current_setting('request.headers', true), '')::jsonb,
      '{}'::jsonb
    );
  exception when others then
    v_headers := '{}'::jsonb;
  end;

  v_ip_text := pg_catalog.btrim(pg_catalog.split_part(coalesce(
    v_headers ->> 'cf-connecting-ip',
    v_headers ->> 'x-real-ip',
    v_headers ->> 'x-forwarded-for',
    ''
  ), ',', 1));

  begin
    v_ip := nullif(v_ip_text, '')::inet;
  exception when invalid_text_representation then
    v_ip := null;
  end;

  v_user_agent := pg_catalog.left(nullif(v_headers ->> 'user-agent', ''), 500);

  insert into public.audit_logs (
    actor_user_id,
    actor_name,
    actor_role,
    module,
    action,
    status,
    entity_type,
    entity_id,
    description,
    metadata,
    ip_address,
    user_agent,
    request_id,
    created_at
  )
  values (
    auth.uid(),
    v_actor_name,
    v_actor_role,
    v_module,
    v_action,
    'success',
    v_entity_type,
    v_entity_id,
    v_description,
    v_metadata,
    v_ip,
    v_user_agent,
    p_request_id,
    pg_catalog.now()
  )
  returning id into v_id;

  return v_id;
end;
$function$;

revoke all on function public.record_audit_event(text, text, text, text, text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.record_audit_event(text, text, text, text, text, jsonb, uuid)
  to authenticated;

notify pgrst, 'reload schema';

commit;
