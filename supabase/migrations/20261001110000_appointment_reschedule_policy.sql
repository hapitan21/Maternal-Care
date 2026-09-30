begin;

-- Rescheduling moves an existing appointment without changing its stored
-- duration. p_new_end_time remains in the signature for compatibility with
-- deployed clients, but the locked schedule row is the duration authority.
create or replace function public.reschedule_appointment(
  p_schedule_id uuid,
  p_new_start_time timestamptz,
  p_new_end_time timestamptz,
  p_description text,
  p_apply_full_update boolean default false,
  p_patient_id uuid default null,
  p_patient_name text default null,
  p_doctor_id uuid default null,
  p_doctor_name text default null,
  p_title text default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_actor_role text;

  v_schedule public.schedule%rowtype;
  v_saved_schedule public.schedule%rowtype;

  v_existing_duration interval;
  v_authoritative_new_end_time timestamptz;
  v_event_id uuid;
  v_time_changed boolean;

  v_patient_id uuid;
  v_patient_name text;

  v_doctor_id uuid;
  v_doctor_name text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;

  select pg_catalog.lower(
           pg_catalog.btrim(coalesce(profile.role, ''))
         )
    into v_actor_role
  from public.profiles as profile
  where profile.id = auth.uid()
    and pg_catalog.lower(
          pg_catalog.btrim(coalesce(profile.role, ''))
        ) in ('doctor', 'staff')
    and pg_catalog.lower(
          pg_catalog.btrim(coalesce(profile.account_status, ''))
        ) = 'active';

  if v_actor_role is null then
    raise exception
      'Only an active Doctor or Staff member can reschedule appointments.'
      using errcode = '42501';
  end if;

  select schedule.*
    into v_schedule
  from public.schedule as schedule
  where schedule.id = p_schedule_id
  for update;

  if v_schedule.id is null then
    raise exception 'Appointment was not found.'
      using errcode = 'P0002';
  end if;

  if v_actor_role = 'doctor'
     and v_schedule.doctor_id is distinct from auth.uid() then
    raise exception 'This appointment is assigned to another Doctor.'
      using errcode = '42501';
  end if;

  if p_apply_full_update and v_actor_role = 'doctor' then
    raise exception 'Doctors cannot apply Staff appointment-field updates.'
      using errcode = '42501';
  end if;

  if pg_catalog.lower(
       pg_catalog.btrim(coalesce(v_schedule.status, ''))
     ) <> 'scheduled' then
    raise exception 'Only scheduled appointments can be rescheduled.'
      using errcode = '22023';
  end if;

  if v_schedule.start_time is null
     or v_schedule.end_time is null
     or v_schedule.end_time <= v_schedule.start_time then
    raise exception 'The existing appointment has an invalid stored time range.'
      using errcode = '22023';
  end if;

  v_existing_duration := v_schedule.end_time - v_schedule.start_time;

  if p_new_start_time is null then
    raise exception 'Choose a valid reschedule date and time.'
      using errcode = '22023';
  end if;

  if p_new_start_time <= pg_catalog.now() then
    raise exception 'Rescheduled appointments must start in the future.'
      using errcode = '22023';
  end if;

  -- p_new_end_time is intentionally not used as duration authority.
  v_authoritative_new_end_time := p_new_start_time + v_existing_duration;

  perform public.validate_appointment_policy_range(
    p_new_start_time,
    v_authoritative_new_end_time
  );

  v_patient_id := case
    when p_apply_full_update then p_patient_id
    else v_schedule.patient_id
  end;

  if v_patient_id is null then
    raise exception 'The appointment is not linked to a valid Patient.'
      using errcode = '23503';
  end if;

  select nullif(
           pg_catalog.btrim(coalesce(patient.full_name, '')),
           ''
         )
    into v_patient_name
  from public.patients as patient
  where patient.id = v_patient_id;

  if v_patient_name is null then
    raise exception 'The appointment is not linked to a valid Patient.'
      using errcode = '23503';
  end if;

  v_doctor_id := case
    when p_apply_full_update then p_doctor_id
    else v_schedule.doctor_id
  end;

  if v_doctor_id is null then
    raise exception 'The appointment is not linked to a valid Doctor.'
      using errcode = '23503';
  end if;

  select nullif(
           pg_catalog.btrim(coalesce(doctor.full_name, '')),
           ''
         )
    into v_doctor_name
  from public.profiles as doctor
  where doctor.id = v_doctor_id
    and pg_catalog.lower(
          pg_catalog.btrim(coalesce(doctor.role, ''))
        ) = 'doctor'
    and pg_catalog.lower(
          pg_catalog.btrim(coalesce(doctor.account_status, ''))
        ) = 'active';

  if v_doctor_name is null then
    raise exception 'The selected Doctor is not active.'
      using errcode = '23503';
  end if;

  if p_apply_full_update then
    if nullif(
         pg_catalog.btrim(coalesce(p_title, '')),
         ''
       ) is null then
      raise exception 'Appointment title is required.'
        using errcode = '22023';
    end if;
  end if;

  if exists (
    select 1
    from public.schedule as schedule
    where schedule.id <> v_schedule.id
      and schedule.patient_id = v_patient_id
      and pg_catalog.lower(
            pg_catalog.btrim(coalesce(schedule.status, 'scheduled'))
          ) not in (
            'cancel',
            'cancelled',
            'canceled',
            'no_show',
            'no show',
            'completed',
            'complete'
          )
      and schedule.start_time < v_authoritative_new_end_time
      and schedule.end_time > p_new_start_time
  ) then
    raise exception 'The Patient already has an appointment during this time.'
      using errcode = '23505';
  end if;

  if exists (
    select 1
    from public.schedule as schedule
    where schedule.id <> v_schedule.id
      and schedule.doctor_id = v_doctor_id
      and pg_catalog.lower(
            pg_catalog.btrim(coalesce(schedule.status, 'scheduled'))
          ) not in (
            'cancel',
            'cancelled',
            'canceled',
            'no_show',
            'no show',
            'completed',
            'complete'
          )
      and schedule.start_time < v_authoritative_new_end_time
      and schedule.end_time > p_new_start_time
  ) then
    raise exception 'The selected Doctor already has an appointment during this time.'
      using errcode = '23505';
  end if;

  v_time_changed :=
       v_schedule.start_time is distinct from p_new_start_time
    or v_schedule.end_time is distinct from v_authoritative_new_end_time;

  update public.schedule as schedule
  set
    patient_id = case
      when p_apply_full_update then v_patient_id
      else schedule.patient_id
    end,
    patient_name = case
      when p_apply_full_update then v_patient_name
      else schedule.patient_name
    end,
    doctor_id = case
      when p_apply_full_update then v_doctor_id
      else schedule.doctor_id
    end,
    doctor_name = case
      when p_apply_full_update then v_doctor_name
      else schedule.doctor_name
    end,
    title = case
      when p_apply_full_update
        then pg_catalog.btrim(p_title)
      else schedule.title
    end,
    description = p_description,
    start_time = p_new_start_time,
    end_time = v_authoritative_new_end_time,
    updated_at = pg_catalog.now()
  where schedule.id = v_schedule.id
  returning schedule.*
    into v_saved_schedule;

  if v_time_changed then
    insert into public.appointment_events (
      schedule_id,
      patient_id,
      event_type,
      previous_start_time,
      previous_end_time,
      new_start_time,
      new_end_time
    )
    values (
      v_saved_schedule.id,
      v_saved_schedule.patient_id,
      'appointment_rescheduled',
      v_schedule.start_time,
      v_schedule.end_time,
      v_saved_schedule.start_time,
      v_saved_schedule.end_time
    )
    returning id
      into v_event_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'schedule',
    pg_catalog.to_jsonb(v_saved_schedule),
    'appointment_event_id',
    v_event_id,
    'rescheduled',
    v_time_changed
  );
end;
$function$;

alter function public.reschedule_appointment(
  uuid,
  timestamptz,
  timestamptz,
  text,
  boolean,
  uuid,
  text,
  uuid,
  text,
  text
) owner to postgres;

comment on function public.reschedule_appointment(
  uuid,
  timestamptz,
  timestamptz,
  text,
  boolean,
  uuid,
  text,
  uuid,
  text,
  text
) is
  'Atomically reschedules an authorized appointment using its preserved stored duration, current operational policy, and authoritative conflict checks.';

revoke all on function public.reschedule_appointment(
  uuid,
  timestamptz,
  timestamptz,
  text,
  boolean,
  uuid,
  text,
  uuid,
  text,
  text
) from public, anon;

grant execute on function public.reschedule_appointment(
  uuid,
  timestamptz,
  timestamptz,
  text,
  boolean,
  uuid,
  text,
  uuid,
  text,
  text
) to authenticated;

commit;
