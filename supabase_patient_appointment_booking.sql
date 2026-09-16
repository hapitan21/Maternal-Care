-- Maternal Care - secure Patient appointment booking
-- Run this migration in the Supabase SQL Editor before enabling Patient booking.

begin;

create or replace function public.get_patient_booking_doctors()
returns table (
  doctor_id uuid,
  doctor_name text,
  specialty text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not exists (
    select 1
    from public.profiles as patient_profile
    where patient_profile.id = auth.uid()
      and lower(trim(coalesce(patient_profile.role, ''))) = 'patient'
  ) then
    raise exception 'Only authenticated Patients can view the booking directory.'
      using errcode = '42501';
  end if;

  return query
  select
    doctor_profile.id,
    coalesce(
      nullif(trim(personal.full_name), ''),
      nullif(trim(doctor_profile.full_name), ''),
      'Clinic doctor'
    ),
    coalesce(
      nullif(trim(professional.board_certification), ''),
      'Obstetrics and Gynecology'
    )
  from public.profiles as doctor_profile
  left join public.doctor_personal_information as personal
    on personal.auth_user_id = doctor_profile.id
  left join public.doctor_professional_information as professional
    on professional.auth_user_id = doctor_profile.id
  where lower(trim(coalesce(doctor_profile.role, ''))) = 'doctor'
    and lower(trim(coalesce(doctor_profile.account_status, 'active'))) not in (
      'inactive', 'deactivated', 'disabled', 'suspended', 'archived', 'deleted'
    )
  order by 2;
end;
$$;

create or replace function public.create_patient_appointment_request(
  p_doctor_id uuid,
  p_doctor_name text,
  p_title text,
  p_category text,
  p_start_time timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_patient public.patients%rowtype;
  v_doctor_name text;
  v_end_time timestamptz;
  v_schedule_id public.schedule.id%type;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select patient.*
    into v_patient
  from public.patients as patient
  where patient.user_id = auth.uid()
  limit 1;

  if v_patient.id is null then
    raise exception 'No Patient record is linked to this account.' using errcode = '42501';
  end if;

  if p_start_time is null or p_start_time <= now() then
    raise exception 'Choose an appointment time in the future.' using errcode = '22023';
  end if;

  if nullif(trim(coalesce(p_title, '')), '') is null then
    raise exception 'Appointment type is required.' using errcode = '22023';
  end if;

  if p_doctor_id is not null then
    select coalesce(
      nullif(trim(personal.full_name), ''),
      nullif(trim(doctor_profile.full_name), ''),
      nullif(trim(p_doctor_name), ''),
      'Clinic doctor'
    )
      into v_doctor_name
    from public.profiles as doctor_profile
    left join public.doctor_personal_information as personal
      on personal.auth_user_id = doctor_profile.id
    where doctor_profile.id = p_doctor_id
      and lower(trim(coalesce(doctor_profile.role, ''))) = 'doctor'
      and lower(trim(coalesce(doctor_profile.account_status, 'active'))) not in (
        'inactive', 'deactivated', 'disabled', 'suspended', 'archived', 'deleted'
      );

    if v_doctor_name is null then
      raise exception 'The selected Doctor is not available.' using errcode = '22023';
    end if;
  else
    v_doctor_name := coalesce(nullif(trim(p_doctor_name), ''), 'Available clinic doctor');
  end if;

  v_end_time := p_start_time + interval '30 minutes';

  if exists (
    select 1
    from public.schedule as schedule
    where schedule.patient_id::text = v_patient.id::text
      and lower(trim(coalesce(schedule.status, 'scheduled'))) not in (
        'cancel', 'cancelled', 'canceled', 'no_show', 'no show', 'completed'
      )
      and schedule.start_time < v_end_time
      and schedule.end_time > p_start_time
  ) then
    raise exception 'You already have an appointment during this time.' using errcode = '23505';
  end if;

  if p_doctor_id is not null and exists (
    select 1
    from public.schedule as schedule
    where schedule.doctor_id = p_doctor_id
      and lower(trim(coalesce(schedule.status, 'scheduled'))) not in (
        'cancel', 'cancelled', 'canceled', 'no_show', 'no show'
      )
      and schedule.start_time < v_end_time
      and schedule.end_time > p_start_time
  ) then
    raise exception 'That appointment slot is no longer available.' using errcode = '23505';
  end if;

  insert into public.schedule (
    patient_id,
    patient_name,
    doctor_id,
    doctor_name,
    title,
    description,
    start_time,
    end_time,
    status
  )
  values (
    v_patient.id,
    coalesce(nullif(trim(v_patient.full_name), ''), 'Patient'),
    p_doctor_id,
    v_doctor_name,
    trim(p_title),
    jsonb_build_object(
      'category', coalesce(nullif(trim(p_category), ''), 'appointment'),
      'source', 'patient-booking-request',
      'requestedByPatient', true
    )::text,
    p_start_time,
    v_end_time,
    'scheduled'
  )
  returning id into v_schedule_id;

  return jsonb_build_object('id', v_schedule_id, 'schedule_id', v_schedule_id);
end;
$$;

revoke all on function public.get_patient_booking_doctors() from public, anon;
grant execute on function public.get_patient_booking_doctors() to authenticated;

revoke all on function public.create_patient_appointment_request(uuid, text, text, text, timestamptz)
  from public, anon;
grant execute on function public.create_patient_appointment_request(uuid, text, text, text, timestamptz)
  to authenticated;

notify pgrst, 'reload schema';

commit;
