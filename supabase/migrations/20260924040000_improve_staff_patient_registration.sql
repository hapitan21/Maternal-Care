begin;

do $preflight$
begin
  if pg_catalog.to_regclass('public.patients') is null
     or pg_catalog.to_regclass('public.patient_personal_information') is null
     or pg_catalog.to_regclass('public.patient_emergency_contact') is null then
    raise exception 'Required Patient registration tables are unavailable.';
  end if;

  if pg_catalog.to_regprocedure(
    'public.save_patient_registration(uuid,uuid,jsonb)'
  ) is null then
    raise exception 'The existing transactional Patient registration RPC is unavailable.';
  end if;

  if pg_catalog.to_regprocedure(
    'public.save_patient_registration_core_20260924(uuid,uuid,jsonb)'
  ) is not null then
    raise exception 'The Patient registration compatibility core already exists.';
  end if;
end;
$preflight$;

-- These columns remain nullable so existing Patient records are not fabricated
-- or made invalid by this migration. The registration RPC requires them only
-- for new or still-provisional registrations.
alter table public.patients
  add column if not exists sex_at_birth text,
  add column if not exists civil_status text,
  add column if not exists nationality text;

-- Keep the existing personal-information record compatible with current
-- profile readers while public.patients remains the primary source for the
-- newly added demographics. Partner data is distinct from emergency contact.
alter table public.patient_personal_information
  add column if not exists nationality text,
  add column if not exists civil_status text,
  add column if not exists partner_name text,
  add column if not exists partner_contact_number text;

alter function public.save_patient_registration(uuid, uuid, jsonb)
  rename to save_patient_registration_core_20260924;

revoke all on function public.save_patient_registration_core_20260924(uuid, uuid, jsonb)
  from public, anon, authenticated;

create function public.save_patient_registration(
  p_registration_token uuid,
  p_patient_record_id uuid default null,
  p_registration_data jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  full_name text,
  patient_id text,
  control_number text,
  date_of_birth date,
  age integer,
  contact_number text,
  email text,
  address text,
  status text,
  account_status text,
  registration_status text,
  user_id uuid,
  control_used_at timestamptz,
  created_at timestamptz,
  registration_data jsonb
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  saved_registration record;
  personal_information_id uuid;
  normalized_patient_phone text;
  normalized_emergency_phone text;
  resolved_nationality text;
  normalized_civil_status text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.profiles profile
    where profile.id = auth.uid()
      and pg_catalog.lower(
        pg_catalog.btrim(coalesce(profile.role, ''))
      ) in ('staff', 'admin')
      and pg_catalog.lower(
        pg_catalog.btrim(coalesce(profile.account_status, ''))
      ) = 'active'
  ) then
    raise exception 'Only active Staff or Admin users can register Patients.'
      using errcode = '42501';
  end if;

  if nullif(pg_catalog.btrim(p_registration_data ->> 'sexAtBirth'), '') is null
     or nullif(pg_catalog.btrim(p_registration_data ->> 'civilStatus'), '') is null
     or nullif(pg_catalog.btrim(p_registration_data ->> 'emergencyContactPerson'), '') is null
     or nullif(pg_catalog.btrim(p_registration_data ->> 'emergencyContactRelationship'), '') is null
     or nullif(pg_catalog.btrim(p_registration_data ->> 'emergencyContactNumber'), '') is null then
    raise exception 'Required Patient demographic or emergency-contact fields are incomplete.'
      using errcode = '22023';
  end if;

  if pg_catalog.lower(
    pg_catalog.btrim(p_registration_data ->> 'sexAtBirth')
  ) <> 'female' then
    raise exception 'Sex at Birth must be Female for this maternal-care registration workflow.'
      using errcode = '22023';
  end if;

  normalized_civil_status := pg_catalog.lower(
    pg_catalog.btrim(p_registration_data ->> 'civilStatus')
  );

  if normalized_civil_status not in (
    'single',
    'married',
    'widowed',
    'separated',
    'divorced',
    'other'
  ) then
    raise exception 'Civil status is not valid.' using errcode = '22023';
  end if;

  normalized_patient_phone := pg_catalog.regexp_replace(
    pg_catalog.btrim(coalesce(p_registration_data ->> 'contactNumber', '')),
    '[[:space:]()-]',
    '',
    'g'
  );
  normalized_emergency_phone := pg_catalog.regexp_replace(
    pg_catalog.btrim(coalesce(p_registration_data ->> 'emergencyContactNumber', '')),
    '[[:space:]()-]',
    '',
    'g'
  );

  if normalized_patient_phone !~ '^(09[0-9]{9}|[+]639[0-9]{9}|639[0-9]{9}|9[0-9]{9})$' then
    raise exception 'Patient contact number must be a valid Philippine mobile number.'
      using errcode = '22023';
  end if;

  if normalized_emergency_phone !~ '^(09[0-9]{9}|[+]639[0-9]{9}|639[0-9]{9}|9[0-9]{9})$' then
    raise exception 'Emergency contact number must be a valid Philippine mobile number.'
      using errcode = '22023';
  end if;

  resolved_nationality := nullif(
    pg_catalog.btrim(
      case
        when pg_catalog.lower(
          pg_catalog.btrim(coalesce(p_registration_data ->> 'nationality', ''))
        ) = 'other'
          then p_registration_data ->> 'nationalityOther'
        else p_registration_data ->> 'nationality'
      end
    ),
    ''
  );

  if pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_registration_data ->> 'nationality', ''))
  ) = 'other' and resolved_nationality is null then
    raise exception 'Specify the Patient nationality when Other is selected.'
      using errcode = '22023';
  end if;

  select registration.*
    into strict saved_registration
  from public.save_patient_registration_core_20260924(
    p_registration_token,
    p_patient_record_id,
    p_registration_data
  ) registration;

  update public.patients patient
  set sex_at_birth = 'Female',
      civil_status = pg_catalog.btrim(p_registration_data ->> 'civilStatus'),
      nationality = resolved_nationality,
      updated_at = pg_catalog.now()
  where patient.id = saved_registration.id;

  select personal_information.id
    into personal_information_id
  from public.patient_personal_information personal_information
  where personal_information.patient_record_id = saved_registration.id::text
  limit 1;

  if personal_information_id is null then
    raise exception 'The Patient personal-information record was not created.'
      using errcode = 'P0001';
  end if;

  update public.patient_personal_information personal_information
  set gender = 'Female',
      civil_status = pg_catalog.btrim(p_registration_data ->> 'civilStatus'),
      nationality = resolved_nationality,
      partner_name = nullif(
        pg_catalog.btrim(p_registration_data ->> 'husbandPartner'),
        ''
      ),
      partner_contact_number = nullif(
        pg_catalog.btrim(p_registration_data ->> 'partnerContactNumber'),
        ''
      ),
      updated_at = pg_catalog.now()
  where personal_information.id = personal_information_id;

  -- The existing core historically treated Husband/Partner as the emergency
  -- contact. Replace that compatibility row with the explicitly collected
  -- emergency contact, using the table's existing personal-information key.
  delete from public.patient_emergency_contact emergency_contact
  where emergency_contact.patient_id = personal_information_id;

  insert into public.patient_emergency_contact (
    patient_id,
    contact_person,
    relationship,
    contact_number,
    updated_at
  ) values (
    personal_information_id,
    pg_catalog.btrim(p_registration_data ->> 'emergencyContactPerson'),
    pg_catalog.btrim(p_registration_data ->> 'emergencyContactRelationship'),
    pg_catalog.btrim(p_registration_data ->> 'emergencyContactNumber'),
    pg_catalog.now()
  );

  return query
  select
    patient.id,
    patient.full_name,
    patient.patient_id,
    patient.control_number,
    patient.date_of_birth,
    patient.age,
    patient.contact_number,
    patient.email,
    patient.address,
    patient.status,
    patient.account_status,
    patient.registration_status,
    patient.user_id,
    patient.control_used_at,
    patient.created_at,
    p_registration_data
  from public.patients patient
  where patient.id = saved_registration.id;
end;
$function$;

revoke all on function public.save_patient_registration(uuid, uuid, jsonb)
  from public, anon;
grant execute on function public.save_patient_registration(uuid, uuid, jsonb)
  to authenticated;

notify pgrst, 'reload schema';

commit;
