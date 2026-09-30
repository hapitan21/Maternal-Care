-- Appointment Policy Stage 1: additive operational policy foundation.
--
-- This migration intentionally does not change schedule grants, RLS policies,
-- existing appointment RPCs, triggers, tables, or existing appointment rows.

begin;


-- Return only the operational settings needed by appointment workflows.
create or replace function public.get_operational_appointment_policy()
returns table (
  timezone text,
  clinic_opening_time time without time zone,
  clinic_closing_time time without time zone,
  default_appointment_duration_minutes integer,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_settings public.system_settings%rowtype;
  v_timezone text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;

  select settings.*
    into v_settings
  from public.system_settings as settings
  where settings.singleton_guard = true;

  if not found then
    raise exception 'Operational appointment policy is not configured.'
      using errcode = '55000';
  end if;

  v_timezone := nullif(
    pg_catalog.btrim(coalesce(v_settings.timezone, '')),
    ''
  );

  if v_timezone is null
     or not exists (
       select 1
       from pg_catalog.pg_timezone_names as timezone_name
       where timezone_name.name = v_timezone
     ) then
    raise exception 'Operational appointment policy has an invalid timezone.'
      using errcode = '55000';
  end if;

  if v_settings.clinic_opening_time is null
     or v_settings.clinic_closing_time is null
     or v_settings.clinic_closing_time <= v_settings.clinic_opening_time then
    raise exception 'Operational appointment policy has invalid clinic hours.'
      using errcode = '55000';
  end if;

  if v_settings.default_appointment_duration_minutes is null
     or v_settings.default_appointment_duration_minutes <= 0 then
    raise exception 'Operational appointment policy has an invalid default appointment duration.'
      using errcode = '55000';
  end if;

  return query
  select
    v_timezone,
    v_settings.clinic_opening_time,
    v_settings.clinic_closing_time,
    v_settings.default_appointment_duration_minutes,
    v_settings.updated_at;
end;
$function$;


-- Internal validator for server-authoritative standard appointment ranges.
-- It deliberately reloads the singleton policy and trusts no caller-provided
-- timezone or clinic-hour values.
create or replace function public.validate_appointment_policy_range(
  p_start_time timestamptz,
  p_end_time timestamptz
)
returns void
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_settings public.system_settings%rowtype;
  v_timezone text;
  v_local_start timestamp without time zone;
  v_local_end timestamp without time zone;
begin
  if p_start_time is null then
    raise exception 'Appointment start time is required.'
      using errcode = '22004';
  end if;

  if p_end_time is null then
    raise exception 'Appointment end time is required.'
      using errcode = '22004';
  end if;

  if p_end_time <= p_start_time then
    raise exception 'Appointment end time must be after the start time.'
      using errcode = '22023';
  end if;

  select settings.*
    into v_settings
  from public.system_settings as settings
  where settings.singleton_guard = true;

  if not found then
    raise exception 'Operational appointment policy is not configured.'
      using errcode = '55000';
  end if;

  v_timezone := nullif(
    pg_catalog.btrim(coalesce(v_settings.timezone, '')),
    ''
  );

  if v_timezone is null
     or not exists (
       select 1
       from pg_catalog.pg_timezone_names as timezone_name
       where timezone_name.name = v_timezone
     ) then
    raise exception 'Operational appointment policy has an invalid timezone.'
      using errcode = '55000';
  end if;

  if v_settings.clinic_opening_time is null
     or v_settings.clinic_closing_time is null
     or v_settings.clinic_closing_time <= v_settings.clinic_opening_time then
    raise exception 'Operational appointment policy has invalid clinic hours.'
      using errcode = '55000';
  end if;

  if v_settings.default_appointment_duration_minutes is null
     or v_settings.default_appointment_duration_minutes <= 0 then
    raise exception 'Operational appointment policy has an invalid default appointment duration.'
      using errcode = '55000';
  end if;

  v_local_start := p_start_time at time zone v_timezone;
  v_local_end := p_end_time at time zone v_timezone;

  if v_local_start::date <> v_local_end::date then
    raise exception 'A standard appointment must start and end on the same clinic-local date.'
      using errcode = '22023';
  end if;

  if v_local_start::time < v_settings.clinic_opening_time then
    raise exception 'Appointment start time is before the configured clinic opening time.'
      using errcode = '22023';
  end if;

  if v_local_end::time > v_settings.clinic_closing_time then
    raise exception 'Appointment end time is after the configured clinic closing time.'
      using errcode = '22023';
  end if;
end;
$function$;


-- Authoritative creation path for normal Doctor and Staff appointments.
create or replace function public.create_standard_appointment(
  p_patient_id uuid,
  p_doctor_id uuid,
  p_title text,
  p_description text,
  p_start_time timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_actor_role text;
  v_patient_name text;
  v_doctor_name text;
  v_title text;
  v_description text;
  v_duration_minutes integer;
  v_end_time timestamptz;
  v_saved_schedule public.schedule%rowtype;
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
          pg_catalog.btrim(coalesce(profile.account_status, ''))
        ) = 'active'
    and pg_catalog.lower(
          pg_catalog.btrim(coalesce(profile.role, ''))
        ) in ('doctor', 'staff');

  if v_actor_role is null then
    raise exception 'Only an active Doctor or Staff member can create standard appointments.'
      using errcode = '42501';
  end if;

  if v_actor_role = 'doctor' and p_doctor_id is distinct from auth.uid() then
    raise exception 'Doctors may only create appointments assigned to themselves.'
      using errcode = '42501';
  end if;

  if p_patient_id is null then
    raise exception 'Select a valid Patient.'
      using errcode = '23503';
  end if;

  select nullif(
           pg_catalog.btrim(coalesce(patient.full_name, '')),
           ''
         )
    into v_patient_name
  from public.patients as patient
  where patient.id = p_patient_id;

  if v_patient_name is null then
    raise exception 'The selected Patient was not found or has no valid name.'
      using errcode = '23503';
  end if;

  if p_doctor_id is null then
    raise exception 'Select an active Doctor.'
      using errcode = '23503';
  end if;

  select coalesce(
           nullif(
             pg_catalog.btrim(coalesce(personal.full_name, '')),
             ''
           ),
           nullif(
             pg_catalog.btrim(coalesce(profile.full_name, '')),
             ''
           )
         )
    into v_doctor_name
  from public.profiles as profile
  left join public.doctor_personal_information as personal
    on personal.auth_user_id = profile.id
  where profile.id = p_doctor_id
    and pg_catalog.lower(
          pg_catalog.btrim(coalesce(profile.role, ''))
        ) = 'doctor'
    and pg_catalog.lower(
          pg_catalog.btrim(coalesce(profile.account_status, ''))
        ) = 'active';

  if v_doctor_name is null then
    raise exception 'The selected Doctor is not active or has no valid name.'
      using errcode = '23503';
  end if;

  v_title := nullif(pg_catalog.btrim(coalesce(p_title, '')), '');

  if v_title is null then
    raise exception 'Appointment title is required.'
      using errcode = '22023';
  end if;

  if p_start_time is null then
    raise exception 'Appointment start time is required.'
      using errcode = '22004';
  end if;

  if p_start_time <= pg_catalog.now() then
    raise exception 'Appointment start time must be in the future.'
      using errcode = '22023';
  end if;

  -- Hold the singleton row stable while deriving and validating the range.
  select settings.default_appointment_duration_minutes
    into v_duration_minutes
  from public.system_settings as settings
  where settings.singleton_guard = true
  for share;

  if not found then
    raise exception 'Operational appointment policy is not configured.'
      using errcode = '55000';
  end if;

  if v_duration_minutes is null or v_duration_minutes <= 0 then
    raise exception 'Operational appointment policy has an invalid default appointment duration.'
      using errcode = '55000';
  end if;

  v_end_time := p_start_time
    + pg_catalog.make_interval(mins => v_duration_minutes);

  perform public.validate_appointment_policy_range(
    p_start_time,
    v_end_time
  );

  if exists (
    select 1
    from public.schedule as schedule
    where schedule.patient_id = p_patient_id
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
      and schedule.start_time < v_end_time
      and schedule.end_time > p_start_time
  ) then
    raise exception 'The Patient already has an appointment during this time.'
      using errcode = '23505';
  end if;

  if exists (
    select 1
    from public.schedule as schedule
    where schedule.doctor_id = p_doctor_id
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
      and schedule.start_time < v_end_time
      and schedule.end_time > p_start_time
  ) then
    raise exception 'The selected Doctor already has an appointment during this time.'
      using errcode = '23505';
  end if;

  v_description := nullif(
    pg_catalog.btrim(coalesce(p_description, '')),
    ''
  );

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
    p_patient_id,
    v_patient_name,
    p_doctor_id,
    v_doctor_name,
    v_title,
    v_description,
    p_start_time,
    v_end_time,
    'scheduled'
  )
  returning * into v_saved_schedule;

  return pg_catalog.to_jsonb(v_saved_schedule);
end;
$function$;


alter function public.get_operational_appointment_policy()
  owner to postgres;
alter function public.validate_appointment_policy_range(timestamptz, timestamptz)
  owner to postgres;
alter function public.create_standard_appointment(uuid, uuid, text, text, timestamptz)
  owner to postgres;


revoke all on function public.get_operational_appointment_policy()
  from public, anon, authenticated;
grant execute on function public.get_operational_appointment_policy()
  to authenticated;

revoke all on function public.validate_appointment_policy_range(timestamptz, timestamptz)
  from public, anon, authenticated;

revoke all on function public.create_standard_appointment(uuid, uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_standard_appointment(uuid, uuid, text, text, timestamptz)
  to authenticated;


comment on function public.get_operational_appointment_policy() is
  'Stage 1 authenticated read surface for validated operational appointment policy fields.';
comment on function public.validate_appointment_policy_range(timestamptz, timestamptz) is
  'Stage 1 private validator for clinic-local standard appointment ranges.';
comment on function public.create_standard_appointment(uuid, uuid, text, text, timestamptz) is
  'Stage 1 authoritative Doctor/Staff creation path for standard appointments.';


commit;
