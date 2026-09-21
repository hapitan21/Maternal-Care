begin;

-- The previous validator returned no registration email and required the
-- final Staff handoff step. Replace it with the same pair-bound preflight,
-- allowing the persisted state created by Generate Patient Access.
drop function if exists public.validate_patient_activation_qr(text, text);

create function public.validate_patient_activation_qr(
  p_patient_id text,
  p_activation_token text
)
returns table (
  valid boolean,
  state text,
  patient_id text,
  email text,
  expires_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  normalized_patient_id text := pg_catalog.btrim(coalesce(p_patient_id, ''));
  normalized_activation_token text := pg_catalog.btrim(coalesce(p_activation_token, ''));
  selected_patient public.patients%rowtype;
  registration_state text;
begin
  if normalized_patient_id = '' or normalized_activation_token = '' then
    return query
    select false, 'malformed'::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  select patients.*
    into selected_patient
  from public.patients as patients
  where pg_catalog.btrim(coalesce(patients.patient_id, '')) = normalized_patient_id
  limit 1;

  if not found then
    return query
    select false, 'unknown'::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  if pg_catalog.btrim(coalesce(selected_patient.control_number, ''))
     <> normalized_activation_token then
    return query
    select false, 'mismatch'::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  if pg_catalog.lower(pg_catalog.btrim(coalesce(selected_patient.status, '')))
       in ('archived', 'deleted', 'cancelled', 'canceled')
     or selected_patient.archived_at is not null then
    return query
    select false, 'archived'::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  if selected_patient.user_id is not null
     or selected_patient.control_used_at is not null then
    return query
    select false, 'used'::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  registration_state := pg_catalog.lower(
    pg_catalog.btrim(coalesce(selected_patient.registration_status, 'completed'))
  );

  if registration_state not in (
    'awaiting_patient_access_confirmation',
    'completed'
  ) then
    return query
    select false, 'pending_registration'::text, null::text, null::text, null::timestamptz;
    return;
  end if;

  return query
  select
    true,
    'valid'::text,
    selected_patient.patient_id,
    pg_catalog.lower(
      nullif(pg_catalog.btrim(coalesce(selected_patient.email, '')), '')
    ),
    null::timestamptz;
end;
$function$;

revoke all on function public.validate_patient_activation_qr(text, text)
  from public;
grant execute on function public.validate_patient_activation_qr(text, text)
  to anon, authenticated;

-- Keep the existing atomic ownership boundary, but accept the persisted
-- generated-access state as well as the final Staff-completed state. Supabase
-- Auth remains the source of truth for the login email.
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
  current_user_email text;
  registered_email text;
  normalized_patient_id text := pg_catalog.btrim(coalesce(p_patient_id, ''));
  normalized_control_number text := pg_catalog.btrim(coalesce(p_control_number, ''));
  requester_role text;
  registration_state text;
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

  select
    pg_catalog.lower(pg_catalog.btrim(coalesce(users.email, '')))
    into current_user_email
  from auth.users as users
  where users.id = current_user_id;

  if nullif(current_user_email, '') is null then
    raise exception 'The authenticated Patient account has no login email.'
      using errcode = 'P0001';
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
    for update;
  exception
    when no_data_found then
      raise exception 'Invalid Patient ID or control number.'
        using errcode = 'P0001';
    when too_many_rows then
      raise exception 'Patient activation data is not unique. Please contact the clinic.'
        using errcode = 'P0001';
  end;

  if pg_catalog.btrim(coalesce(selected_patient.control_number, ''))
     <> normalized_control_number then
    raise exception 'The Patient ID and access code do not match.'
      using errcode = 'P0001';
  end if;

  if pg_catalog.lower(pg_catalog.btrim(coalesce(selected_patient.status, '')))
       in ('archived', 'deleted', 'cancelled', 'canceled')
     or selected_patient.archived_at is not null then
    raise exception 'This patient record is archived or unavailable.'
      using errcode = 'P0001';
  end if;

  registration_state := pg_catalog.lower(
    pg_catalog.btrim(coalesce(selected_patient.registration_status, 'completed'))
  );

  if registration_state not in (
    'awaiting_patient_access_confirmation',
    'completed'
  ) then
    raise exception 'Patient access has not been generated.'
      using errcode = 'P0001';
  end if;

  if selected_patient.user_id is not null
     or selected_patient.control_used_at is not null then
    raise exception 'This patient account has already been activated.'
      using errcode = 'P0001';
  end if;

  registered_email := pg_catalog.lower(
    pg_catalog.btrim(coalesce(selected_patient.email, ''))
  );

  if registered_email <> '' and registered_email <> current_user_email then
    raise exception 'The authentication email does not match the registered Patient email.'
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

  update public.patients as patients
  set
    user_id = current_user_id,
    email = current_user_email,
    control_used_at = linked_at,
    account_status = 'active',
    updated_at = linked_at
  where patients.id = selected_patient.id
    and patients.user_id is null
    and patients.control_used_at is null;

  if not found then
    raise exception 'This patient account has already been activated.'
      using errcode = 'P0001';
  end if;

  update public.patient_personal_information as personal_information
  set
    email = current_user_email,
    updated_at = linked_at
  where personal_information.patient_record_id = selected_patient.id::text;

  return query
  select
    selected_patient.id,
    selected_patient.patient_id,
    'active'::text,
    true;
end;
$function$;

revoke all on function public.link_patient_auth_account(text, text)
  from public, anon;
grant execute on function public.link_patient_auth_account(text, text)
  to authenticated;

notify pgrst, 'reload schema';

commit;
