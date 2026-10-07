begin;

do $preflight$
begin
  if pg_catalog.to_regclass('public.patients') is null
     or pg_catalog.to_regclass('public.patient_obstetric_history') is null
     or pg_catalog.to_regprocedure('public.save_patient_registration(uuid,uuid,jsonb)') is null
     or pg_catalog.to_regprocedure('public.save_patient_registration_core_20260924(uuid,uuid,jsonb)') is null then
    raise exception 'The existing Patient registration tables and compatibility RPCs are required.';
  end if;
end;
$preflight$;

-- Leave existing Patients unknown; do not backfill membership or counts.
alter table public.patients
  add column philhealth_member boolean,
  add column philhealth_pin text;

alter table public.patient_obstetric_history
  add column full_term integer,
  add column preterm integer,
  add column abortion_miscarriage integer,
  add column living_children integer,
  add constraint patient_obstetric_history_full_term_nonnegative
    check (full_term is null or full_term >= 0),
  add constraint patient_obstetric_history_preterm_nonnegative
    check (preterm is null or preterm >= 0),
  add constraint patient_obstetric_history_abortion_miscarriage_nonnegative
    check (abortion_miscarriage is null or abortion_miscarriage >= 0),
  add constraint patient_obstetric_history_living_children_nonnegative
    check (living_children is null or living_children >= 0);

-- CREATE OR REPLACE preserves the existing function owner and privileges.
-- Keep both internal registration functions, authorization, and workflow intact.
create or replace function public.save_patient_registration(
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
  previous_patient public.patients%rowtype;
  previous_obstetric public.patient_obstetric_history%rowtype;
  resolved_philhealth_member boolean;
  resolved_philhealth_pin text;
  resolved_counts jsonb;
  count_key text;
  submitted_value text;
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

  if p_registration_data is null
     or pg_catalog.jsonb_typeof(p_registration_data) <> 'object' then
    raise exception 'Patient registration data must be a JSON object.' using errcode = '22023';
  end if;

  -- Capture only a matching, still-provisional registration after authorization.
  -- The Patient lock serializes re-saves and completion with the existing core.
  select patient.*
    into previous_patient
  from public.patients patient
  where patient.registration_token = p_registration_token
    and patient.registration_status = 'awaiting_patient_access_confirmation'
    and (p_patient_record_id is null or patient.id = p_patient_record_id)
  for update;

  if previous_patient.id is not null then
    select obstetric.*
      into previous_obstetric
    from public.patient_obstetric_history obstetric
    where obstetric.patient_id = previous_patient.id
    order by obstetric.updated_at desc nulls last,
             obstetric.created_at desc nulls last,
             obstetric.id desc
    limit 1
    for update;
  end if;

  resolved_philhealth_member := previous_patient.philhealth_member;
  resolved_philhealth_pin := previous_patient.philhealth_pin;
  resolved_counts := pg_catalog.jsonb_build_object(
    'fullTerm', previous_obstetric.full_term,
    'preterm', previous_obstetric.preterm,
    'abortionMiscarriage', previous_obstetric.abortion_miscarriage,
    'livingChildren', previous_obstetric.living_children
  );

  -- JSON key presence distinguishes omission from an explicit blank/null clear.
  if p_registration_data ? 'philHealthMember' then
    submitted_value := nullif(pg_catalog.lower(
      pg_catalog.btrim(p_registration_data ->> 'philHealthMember')
    ), '');
    if submitted_value is not null and submitted_value not in ('yes', 'no', 'true', 'false') then
      raise exception 'PhilHealth membership must be Yes, No, or unknown.' using errcode = '22023';
    end if;
    resolved_philhealth_member := case submitted_value
      when 'yes' then true when 'true' then true
      when 'no' then false when 'false' then false
      else null
    end;
  end if;

  if p_registration_data ? 'philHealthPin' then
    if pg_catalog.jsonb_typeof(p_registration_data -> 'philHealthPin') not in ('string', 'null') then
      raise exception 'PhilHealth PIN must be text or null.' using errcode = '22023';
    end if;
    resolved_philhealth_pin := nullif(pg_catalog.btrim(p_registration_data ->> 'philHealthPin'), '');
  end if;
  if resolved_philhealth_member is distinct from true then
    resolved_philhealth_pin := null;
  end if;

  foreach count_key in array array['fullTerm', 'preterm', 'abortionMiscarriage', 'livingChildren'] loop
    if p_registration_data ? count_key then
      submitted_value := nullif(pg_catalog.btrim(p_registration_data ->> count_key), '');
      if submitted_value is not null and submitted_value !~ '^[0-9]+$' then
        raise exception '% must be a nonnegative whole number or blank.', count_key using errcode = '22023';
      end if;
      -- The integer cast also rejects values outside the column's integer range.
      resolved_counts := pg_catalog.jsonb_set(
        resolved_counts,
        array[count_key],
        coalesce(pg_catalog.to_jsonb(submitted_value::integer), 'null'::jsonb)
      );
    end if;
  end loop;

  -- Keep the draft and RPC result consistent with permanent storage, including
  -- values preserved from an older client's omitted keys. The core saves this
  -- same JSON draft; it otherwise receives all existing payload fields intact.
  p_registration_data := p_registration_data || resolved_counts || pg_catalog.jsonb_build_object(
    'philHealthMember', resolved_philhealth_member,
    'philHealthPin', resolved_philhealth_pin
  );

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
      philhealth_member = resolved_philhealth_member,
      philhealth_pin = resolved_philhealth_pin,
      updated_at = pg_catalog.now()
  where patient.id = saved_registration.id;

  -- The unchanged core replaces the obstetric row, so persist resolved counts
  -- only after it completes, inside this same registration transaction.
  update public.patient_obstetric_history obstetric
  set full_term = (resolved_counts ->> 'fullTerm')::integer,
      preterm = (resolved_counts ->> 'preterm')::integer,
      abortion_miscarriage = (resolved_counts ->> 'abortionMiscarriage')::integer,
      living_children = (resolved_counts ->> 'livingChildren')::integer
  where obstetric.patient_id = saved_registration.id;

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

notify pgrst, 'reload schema';

commit;
