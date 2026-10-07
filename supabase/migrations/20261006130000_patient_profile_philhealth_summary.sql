begin;

create or replace function public.get_my_patient_profile_summary()
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
      'philhealth_member', patient_row.philhealth_member,
      'philhealth_pin', patient_row.philhealth_pin,
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

notify pgrst, 'reload schema';

commit;
