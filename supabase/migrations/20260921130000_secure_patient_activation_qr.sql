begin;

create unique index if not exists patients_user_id_unique
  on public.patients (user_id)
  where user_id is not null;

-- Staff registration already stores the public Patient ID and one-time access
-- code on the same patients row. Keep that source of truth and expose only a
-- non-PII validation result to anonymous QR scanners.
create or replace function public.validate_patient_activation_qr(
  p_patient_id text,
  p_activation_token text
)
returns table (
  valid boolean,
  state text,
  patient_id text,
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
begin
  if normalized_patient_id = '' or normalized_activation_token = '' then
    return query select false, 'malformed'::text, null::text, null::timestamptz;
    return;
  end if;

  select patients.*
    into selected_patient
  from public.patients as patients
  where pg_catalog.btrim(coalesce(patients.patient_id, '')) = normalized_patient_id
  limit 1;

  if not found then
    return query select false, 'unknown'::text, null::text, null::timestamptz;
    return;
  end if;

  if pg_catalog.btrim(coalesce(selected_patient.control_number, ''))
     <> normalized_activation_token then
    return query select false, 'mismatch'::text, null::text, null::timestamptz;
    return;
  end if;

  if pg_catalog.lower(pg_catalog.btrim(coalesce(selected_patient.status, '')))
       in ('archived', 'deleted')
     or selected_patient.archived_at is not null then
    return query select false, 'archived'::text, null::text, null::timestamptz;
    return;
  end if;

  if selected_patient.user_id is not null
     or selected_patient.control_used_at is not null then
    return query select false, 'used'::text, null::text, null::timestamptz;
    return;
  end if;

  if pg_catalog.lower(
       pg_catalog.btrim(coalesce(selected_patient.registration_status, 'completed'))
     ) <> 'completed' then
    return query select false, 'pending_registration'::text, null::text, null::timestamptz;
    return;
  end if;

  return query
  select true, 'valid'::text, selected_patient.patient_id, null::timestamptz;
end;
$function$;

-- Final ownership is established only after Supabase Auth has authenticated
-- the new Patient. The row lock serializes competing uses of the same QR code,
-- and the credential is consumed in the same update that links auth.uid().
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
       in ('archived', 'deleted')
     or selected_patient.archived_at is not null then
    raise exception 'This patient record is archived.'
      using errcode = 'P0001';
  end if;

  if pg_catalog.lower(
       pg_catalog.btrim(coalesce(selected_patient.registration_status, 'completed'))
     ) <> 'completed' then
    raise exception 'Patient registration has not been completed.'
      using errcode = 'P0001';
  end if;

  if selected_patient.user_id is not null
     or selected_patient.control_used_at is not null then
    raise exception 'This patient account has already been activated.'
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

  return query
  select
    selected_patient.id,
    selected_patient.patient_id,
    'active'::text,
    true;
end;
$function$;

revoke all on function public.validate_patient_activation_qr(text, text)
  from public;
grant execute on function public.validate_patient_activation_qr(text, text)
  to anon, authenticated;

revoke all on function public.link_patient_auth_account(text, text)
  from public, anon;
grant execute on function public.link_patient_auth_account(text, text)
  to authenticated;

-- These older anonymous helpers expose Patient record fields. The active app
-- no longer calls them; QR preflight now returns only a state and Patient ID.
do $legacy_access$
begin
  if pg_catalog.to_regprocedure(
    'public.get_patient_access_record(text,text)'
  ) is not null then
    execute 'revoke all on function public.get_patient_access_record(text, text) from public, anon, authenticated';
  end if;

  if pg_catalog.to_regprocedure(
    'public.get_patient_login_access_record(text,text)'
  ) is not null then
    execute 'revoke all on function public.get_patient_login_access_record(text, text) from public, anon, authenticated';
  end if;
end;
$legacy_access$;

notify pgrst, 'reload schema';

commit;
