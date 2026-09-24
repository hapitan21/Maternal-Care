begin;

do $preflight$
begin
  if pg_catalog.to_regclass('public.patients') is null
     or pg_catalog.to_regclass('public.patient_personal_information') is null
     or pg_catalog.to_regclass('public.patient_emergency_contact') is null
     or pg_catalog.to_regclass('public.patient_obstetric_history') is null
     or pg_catalog.to_regclass('public.schedule') is null then
    raise exception 'Required Patient profile tables are unavailable.';
  end if;
end;
$preflight$;

create function public.get_my_patient_profile_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  patient_row public.patients%rowtype;
  personal_row public.patient_personal_information%rowtype;
  obstetric_row public.patient_obstetric_history%rowtype;
  emergency_row public.patient_emergency_contact%rowtype;
  personal_record_count integer := 0;
  attending_physician text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select patient.*
    into patient_row
  from public.patients patient
  where patient.user_id = auth.uid()
    and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.account_status, ''))) = 'active'
    and patient.archived_at is null
    and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.status, '')))
        not in ('inactive', 'archived', 'deleted')
  order by patient.updated_at desc nulls last, patient.created_at desc nulls last, patient.id desc
  limit 1;

  if patient_row.id is null then
    raise exception 'An active linked Patient record is required.' using errcode = '42501';
  end if;

  select count(*)::integer
    into personal_record_count
  from public.patient_personal_information personal_information
  where personal_information.patient_record_id = patient_row.id::text
     or personal_information.user_id = auth.uid();

  select personal_information.*
    into personal_row
  from public.patient_personal_information personal_information
  where personal_information.patient_record_id = patient_row.id::text
     or personal_information.user_id = auth.uid()
  order by
    (personal_information.patient_record_id = patient_row.id::text) desc,
    (personal_information.user_id = auth.uid()) desc,
    personal_information.updated_at desc nulls last,
    personal_information.created_at desc nulls last,
    personal_information.id desc
  limit 1;

  select obstetric.*
    into obstetric_row
  from public.patient_obstetric_history obstetric
  where obstetric.patient_id = patient_row.id
  order by
    (
      obstetric.expected_delivery_date between
        (current_date - 14) and (current_date + 300)
    ) desc,
    obstetric.updated_at desc nulls last,
    obstetric.created_at desc nulls last,
    obstetric.id desc
  limit 1;

  select emergency_contact.*
    into emergency_row
  from public.patient_emergency_contact emergency_contact
  join public.patient_personal_information personal_information
    on personal_information.id = emergency_contact.patient_id
  where personal_information.patient_record_id = patient_row.id::text
     or personal_information.user_id = auth.uid()
  order by
    (personal_information.id = personal_row.id) desc,
    emergency_contact.updated_at desc nulls last,
    emergency_contact.created_at desc nulls last,
    emergency_contact.id desc
  limit 1;

  select coalesce(
      nullif(pg_catalog.btrim(doctor_profile.full_name), ''),
      nullif(pg_catalog.btrim(appointment.doctor_name), '')
    )
    into attending_physician
  from public.schedule appointment
  left join public.profiles doctor_profile
    on doctor_profile.id = appointment.doctor_id
  where appointment.patient_id = patient_row.id
    and coalesce(
      nullif(pg_catalog.btrim(doctor_profile.full_name), ''),
      nullif(pg_catalog.btrim(appointment.doctor_name), '')
    ) is not null
    and pg_catalog.lower(
      pg_catalog.regexp_replace(
        pg_catalog.btrim(coalesce(appointment.status::text, '')),
        '[[:space:]-]+',
        '_',
        'g'
      )
    ) not in ('cancelled', 'canceled', 'no_show', 'missed')
  order by
    (
      pg_catalog.lower(
        pg_catalog.regexp_replace(
          pg_catalog.btrim(coalesce(appointment.status::text, '')),
          '[[:space:]-]+',
          '_',
          'g'
        )
      ) in ('scheduled', 'pending', 'checked_in')
      and appointment.start_time >= pg_catalog.now()
    ) desc,
    case
      when appointment.start_time >= pg_catalog.now() then appointment.start_time
      else null
    end asc nulls last,
    appointment.start_time desc nulls last,
    appointment.id desc
  limit 1;

  return pg_catalog.jsonb_build_object(
    'patient', pg_catalog.jsonb_build_object(
      'id', patient_row.id,
      'user_id', patient_row.user_id,
      'patient_id', patient_row.patient_id,
      'full_name', patient_row.full_name,
      'date_of_birth', patient_row.date_of_birth,
      'age', patient_row.age,
      'address', patient_row.address,
      'contact_number', patient_row.contact_number,
      'blood_type', patient_row.blood_type,
      'sex_at_birth', patient_row.sex_at_birth,
      'civil_status', patient_row.civil_status,
      'nationality', patient_row.nationality,
      'expected_delivery_date', patient_row.expected_delivery_date,
      'gestational_age', patient_row.gestational_age,
      'trimester', patient_row.trimester,
      'status', patient_row.status,
      'account_status', patient_row.account_status,
      'created_at', patient_row.created_at
    ),
    'legacy_personal', case
      when personal_row.id is null then null
      else pg_catalog.jsonb_build_object(
        'id', personal_row.id,
        'user_id', personal_row.user_id,
        'patient_record_id', personal_row.patient_record_id,
        'gender', personal_row.gender,
        'civil_status', personal_row.civil_status,
        'nationality', personal_row.nationality,
        'updated_at', personal_row.updated_at,
        'created_at', personal_row.created_at
      )
    end,
    'obstetric', case
      when obstetric_row.id is null then null
      else pg_catalog.jsonb_build_object(
        'id', obstetric_row.id,
        'gravida', obstetric_row.gravida,
        'para', obstetric_row.para,
        'last_menstrual_period', obstetric_row.last_menstrual_period,
        'expected_delivery_date', obstetric_row.expected_delivery_date,
        'updated_at', obstetric_row.updated_at,
        'created_at', obstetric_row.created_at
      )
    end,
    'emergency_contact', case
      when emergency_row.id is null then null
      else pg_catalog.jsonb_build_object(
        'id', emergency_row.id,
        'patient_id', emergency_row.patient_id,
        'contact_person', emergency_row.contact_person,
        'relationship', emergency_row.relationship,
        'contact_number', emergency_row.contact_number,
        'updated_at', emergency_row.updated_at,
        'created_at', emergency_row.created_at
      )
    end,
    'attending_physician', attending_physician,
    'personal_record_count', personal_record_count
  );
end;
$function$;

create function public.update_my_patient_profile(p_profile jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  patient_row public.patients%rowtype;
  personal_row public.patient_personal_information%rowtype;
  normalized_phone text;
  next_full_name text;
  next_birthdate date;
  next_address text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  if p_profile is null or pg_catalog.jsonb_typeof(p_profile) <> 'object' then
    raise exception 'Patient profile details are required.' using errcode = '22023';
  end if;

  select patient.*
    into patient_row
  from public.patients patient
  where patient.user_id = auth.uid()
    and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.account_status, ''))) = 'active'
    and patient.archived_at is null
    and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.status, '')))
        not in ('inactive', 'archived', 'deleted')
  order by patient.updated_at desc nulls last, patient.created_at desc nulls last, patient.id desc
  limit 1
  for update;

  if patient_row.id is null then
    raise exception 'An active linked Patient record is required.' using errcode = '42501';
  end if;

  next_full_name := nullif(pg_catalog.btrim(p_profile ->> 'full_name'), '');
  if next_full_name is null then
    raise exception 'Full name is required.' using errcode = '22023';
  end if;

  normalized_phone := pg_catalog.regexp_replace(
    pg_catalog.btrim(coalesce(p_profile ->> 'contact_number', '')),
    '[[:space:]()-]',
    '',
    'g'
  );
  if normalized_phone !~ '^(09[0-9]{9}|[+]639[0-9]{9}|639[0-9]{9}|9[0-9]{9})$' then
    raise exception 'Contact number must be a valid Philippine mobile number.'
      using errcode = '22023';
  end if;

  if nullif(pg_catalog.btrim(p_profile ->> 'date_of_birth'), '') is null then
    raise exception 'Date of birth is required.' using errcode = '22023';
  end if;

  begin
    next_birthdate := pg_catalog.btrim(p_profile ->> 'date_of_birth')::date;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'Date of birth is not valid.' using errcode = '22023';
  end;

  if next_birthdate is not null and next_birthdate > current_date then
    raise exception 'Date of birth cannot be in the future.' using errcode = '22023';
  end if;

  next_address := nullif(pg_catalog.btrim(p_profile ->> 'address'), '');
  if next_address is null then
    raise exception 'Address is required.' using errcode = '22023';
  end if;

  update public.patients patient
  set full_name = next_full_name,
      date_of_birth = next_birthdate,
      age = case
        when next_birthdate is null then null
        else pg_catalog.date_part(
          'year',
          pg_catalog.age(current_date, next_birthdate)
        )::integer
      end,
      address = next_address,
      contact_number = pg_catalog.btrim(p_profile ->> 'contact_number'),
      civil_status = nullif(pg_catalog.btrim(p_profile ->> 'civil_status'), ''),
      nationality = nullif(pg_catalog.btrim(p_profile ->> 'nationality'), ''),
      updated_at = pg_catalog.now()
  where patient.id = patient_row.id
  returning patient.* into patient_row;

  select personal_information.*
    into personal_row
  from public.patient_personal_information personal_information
  where personal_information.patient_record_id = patient_row.id::text
     or personal_information.user_id = auth.uid()
  order by
    (personal_information.patient_record_id = patient_row.id::text) desc,
    (personal_information.user_id = auth.uid()) desc,
    personal_information.updated_at desc nulls last,
    personal_information.created_at desc nulls last,
    personal_information.id desc
  limit 1
  for update;

  if personal_row.id is null then
    insert into public.patient_personal_information (
      user_id,
      patient_record_id,
      patient_code,
      full_name,
      gender,
      birthdate,
      nationality,
      email,
      address,
      blood_type,
      civil_status,
      contact_number,
      age,
      updated_at
    ) values (
      auth.uid(),
      patient_row.id::text,
      patient_row.patient_id,
      patient_row.full_name,
      patient_row.sex_at_birth,
      patient_row.date_of_birth,
      patient_row.nationality,
      auth.jwt() ->> 'email',
      patient_row.address,
      patient_row.blood_type,
      patient_row.civil_status,
      patient_row.contact_number,
      patient_row.age,
      pg_catalog.now()
    );
  else
    update public.patient_personal_information personal_information
    set patient_code = patient_row.patient_id,
        full_name = patient_row.full_name,
        gender = coalesce(patient_row.sex_at_birth, personal_information.gender),
        birthdate = patient_row.date_of_birth,
        nationality = patient_row.nationality,
        email = coalesce(auth.jwt() ->> 'email', personal_information.email),
        address = patient_row.address,
        blood_type = patient_row.blood_type,
        civil_status = patient_row.civil_status,
        contact_number = patient_row.contact_number,
        age = patient_row.age,
        updated_at = pg_catalog.now()
    where personal_information.id = personal_row.id;
  end if;

  return public.get_my_patient_profile_summary();
end;
$function$;

create function public.save_my_patient_emergency_contact(p_contact jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  patient_row public.patients%rowtype;
  personal_row public.patient_personal_information%rowtype;
  emergency_row public.patient_emergency_contact%rowtype;
  normalized_phone text;
  requested_contact_person text;
  requested_relationship text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  if p_contact is null or pg_catalog.jsonb_typeof(p_contact) <> 'object' then
    raise exception 'Emergency contact details are required.' using errcode = '22023';
  end if;

  requested_contact_person := nullif(pg_catalog.btrim(p_contact ->> 'contact_person'), '');
  requested_relationship := nullif(pg_catalog.btrim(p_contact ->> 'relationship'), '');
  normalized_phone := pg_catalog.regexp_replace(
    pg_catalog.btrim(coalesce(p_contact ->> 'contact_number', '')),
    '[[:space:]()-]',
    '',
    'g'
  );

  if requested_contact_person is null or requested_relationship is null then
    raise exception 'Contact person and relationship are required.' using errcode = '22023';
  end if;
  if normalized_phone !~ '^(09[0-9]{9}|[+]639[0-9]{9}|639[0-9]{9}|9[0-9]{9})$' then
    raise exception 'Emergency contact number must be a valid Philippine mobile number.'
      using errcode = '22023';
  end if;

  select patient.*
    into patient_row
  from public.patients patient
  where patient.user_id = auth.uid()
    and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.account_status, ''))) = 'active'
    and patient.archived_at is null
    and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.status, '')))
        not in ('inactive', 'archived', 'deleted')
  order by patient.updated_at desc nulls last, patient.created_at desc nulls last, patient.id desc
  limit 1;

  if patient_row.id is null then
    raise exception 'An active linked Patient record is required.' using errcode = '42501';
  end if;

  select personal_information.*
    into personal_row
  from public.patient_personal_information personal_information
  where personal_information.patient_record_id = patient_row.id::text
     or personal_information.user_id = auth.uid()
  order by
    (personal_information.patient_record_id = patient_row.id::text) desc,
    (personal_information.user_id = auth.uid()) desc,
    personal_information.updated_at desc nulls last,
    personal_information.created_at desc nulls last,
    personal_information.id desc
  limit 1;

  if personal_row.id is null then
    insert into public.patient_personal_information (
      user_id, patient_record_id, patient_code, full_name, gender, birthdate,
      nationality, email, address, blood_type, civil_status, contact_number,
      age, updated_at
    ) values (
      auth.uid(), patient_row.id::text, patient_row.patient_id,
      patient_row.full_name, patient_row.sex_at_birth, patient_row.date_of_birth,
      patient_row.nationality, auth.jwt() ->> 'email', patient_row.address,
      patient_row.blood_type, patient_row.civil_status,
      patient_row.contact_number, patient_row.age, pg_catalog.now()
    )
    returning * into personal_row;
  end if;

  select emergency_contact.*
    into emergency_row
  from public.patient_emergency_contact emergency_contact
  join public.patient_personal_information personal_information
    on personal_information.id = emergency_contact.patient_id
  where personal_information.patient_record_id = patient_row.id::text
     or personal_information.user_id = auth.uid()
  order by
    (personal_information.id = personal_row.id) desc,
    emergency_contact.updated_at desc nulls last,
    emergency_contact.created_at desc nulls last,
    emergency_contact.id desc
  limit 1
  for update of emergency_contact;

  if emergency_row.id is null then
    insert into public.patient_emergency_contact (
      patient_id, contact_person, relationship, contact_number, updated_at
    ) values (
      personal_row.id,
      requested_contact_person,
      requested_relationship,
      pg_catalog.btrim(p_contact ->> 'contact_number'),
      pg_catalog.now()
    );
  else
    update public.patient_emergency_contact emergency_contact
    set contact_person = requested_contact_person,
        relationship = requested_relationship,
        contact_number = pg_catalog.btrim(p_contact ->> 'contact_number'),
        updated_at = pg_catalog.now()
    where emergency_contact.id = emergency_row.id;
  end if;

  return public.get_my_patient_profile_summary();
end;
$function$;

revoke all on function public.get_my_patient_profile_summary()
  from public, anon;
grant execute on function public.get_my_patient_profile_summary()
  to authenticated;

revoke all on function public.update_my_patient_profile(jsonb)
  from public, anon;
grant execute on function public.update_my_patient_profile(jsonb)
  to authenticated;

revoke all on function public.save_my_patient_emergency_contact(jsonb)
  from public, anon;
grant execute on function public.save_my_patient_emergency_contact(jsonb)
  to authenticated;

notify pgrst, 'reload schema';

commit;
