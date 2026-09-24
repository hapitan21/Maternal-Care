-- Immutable appointment reschedule events for deterministic SMS dispatch keys.
-- The RPC updates the schedule and records the event in one transaction.

begin;

create table public.appointment_events (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  schedule_id uuid not null,
  patient_id uuid not null,
  event_type text not null,
  previous_start_time timestamptz,
  previous_end_time timestamptz,
  new_start_time timestamptz not null,
  new_end_time timestamptz not null,
  created_at timestamptz not null default pg_catalog.now(),

  constraint appointment_events_schedule_id_fkey
    foreign key (schedule_id)
    references public.schedule(id)
    on delete restrict,

  constraint appointment_events_patient_id_fkey
    foreign key (patient_id)
    references public.patients(id)
    on delete restrict,

  constraint appointment_events_event_type_check
    check (event_type = 'appointment_rescheduled'),

  constraint appointment_events_reschedule_time_changed_check
    check (
      previous_start_time is distinct from new_start_time
      or previous_end_time is distinct from new_end_time
    ),

  constraint appointment_events_new_time_range_check
    check (new_end_time > new_start_time)
);

comment on table public.appointment_events is
  'Immutable, server-controlled appointment lifecycle events. Phase 3 records appointment_rescheduled only.';

comment on column public.appointment_events.id is
  'Database-generated immutable event identity used in deterministic notification dispatch keys.';


create index appointment_events_schedule_created_idx
  on public.appointment_events (schedule_id, created_at desc);

create index appointment_events_patient_created_idx
  on public.appointment_events (patient_id, created_at desc);


alter table public.appointment_events enable row level security;

-- There are intentionally no browser-facing policies.
-- Writes occur only inside public.reschedule_appointment(...)
-- after the authenticated actor is validated.
revoke all on table public.appointment_events
  from public, anon, authenticated;

grant select on table public.appointment_events
  to service_role;


create function public.reject_appointment_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'Appointment events are immutable.'
    using errcode = '55000';
end;
$function$;

revoke all on function public.reject_appointment_event_mutation()
  from public, anon, authenticated;


create trigger appointment_events_reject_update_delete
before update or delete
on public.appointment_events
for each row
execute function public.reject_appointment_event_mutation();


create function public.reschedule_appointment(
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
set search_path = ''
as $function$
declare
  v_actor_role text;

  v_schedule public.schedule%rowtype;
  v_saved_schedule public.schedule%rowtype;

  v_event_id uuid;
  v_time_changed boolean;

  v_patient_id uuid;
  v_patient_name text;

  v_doctor_id uuid;
  v_doctor_name text;
begin

  ------------------------------------------------------------
  -- AUTHENTICATION
  ------------------------------------------------------------

  if auth.uid() is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;


  ------------------------------------------------------------
  -- ACTOR AUTHORIZATION
  --
  -- Database inspection confirmed that the canonical active
  -- profile account_status is "active".
  ------------------------------------------------------------

  select pg_catalog.lower(
           pg_catalog.btrim(coalesce(profile.role, ''))
         )
    into v_actor_role
  from public.profiles as profile
  where profile.id = auth.uid()
    and pg_catalog.lower(
          pg_catalog.btrim(coalesce(profile.role, ''))
        ) in ('doctor', 'staff', 'admin')
    and pg_catalog.lower(
          pg_catalog.btrim(coalesce(profile.account_status, ''))
        ) = 'active';

  if v_actor_role is null then
    raise exception
      'Only an active Doctor, Staff member, or Admin can reschedule appointments.'
      using errcode = '42501';
  end if;


  ------------------------------------------------------------
  -- LOCK THE APPOINTMENT
  --
  -- FOR UPDATE serializes concurrent reschedule requests.
  ------------------------------------------------------------

  select schedule.*
    into v_schedule
  from public.schedule as schedule
  where schedule.id = p_schedule_id
  for update;

  if v_schedule.id is null then
    raise exception 'Appointment was not found.'
      using errcode = 'P0002';
  end if;


  ------------------------------------------------------------
  -- DOCTOR OWNERSHIP
  ------------------------------------------------------------

  if v_actor_role = 'doctor'
     and v_schedule.doctor_id is distinct from auth.uid() then
    raise exception 'This appointment is assigned to another Doctor.'
      using errcode = '42501';
  end if;


  ------------------------------------------------------------
  -- DOCTORS MAY NOT USE STAFF/ADMIN FULL EDIT MODE
  ------------------------------------------------------------

  if p_apply_full_update and v_actor_role = 'doctor' then
    raise exception 'Doctors cannot apply Staff appointment-field updates.'
      using errcode = '42501';
  end if;


  ------------------------------------------------------------
  -- APPOINTMENT STATUS
  --
  -- Current confirmed appointments use "scheduled".
  -- Rescheduling must not transition workflow status.
  ------------------------------------------------------------

  if pg_catalog.lower(
       pg_catalog.btrim(coalesce(v_schedule.status, ''))
     ) <> 'scheduled' then
    raise exception 'Only scheduled appointments can be rescheduled.'
      using errcode = '22023';
  end if;


  ------------------------------------------------------------
  -- TIME VALIDATION
  ------------------------------------------------------------

  if p_new_start_time is null
     or p_new_end_time is null
     or p_new_end_time <= p_new_start_time then
    raise exception 'Choose a valid appointment time range.'
      using errcode = '22023';
  end if;

  if p_new_start_time <= pg_catalog.now() then
    raise exception 'Rescheduled appointments must start in the future.'
      using errcode = '22023';
  end if;


  ------------------------------------------------------------
  -- AUTHORITATIVE PATIENT
  ------------------------------------------------------------

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


  ------------------------------------------------------------
  -- AUTHORITATIVE DOCTOR
  ------------------------------------------------------------

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


  ------------------------------------------------------------
  -- FULL-UPDATE VALIDATION
  ------------------------------------------------------------

  if p_apply_full_update then
    if nullif(
         pg_catalog.btrim(coalesce(p_title, '')),
         ''
       ) is null then
      raise exception 'Appointment title is required.'
        using errcode = '22023';
    end if;
  end if;


  ------------------------------------------------------------
  -- DETERMINE WHETHER THIS IS A REAL RESCHEDULE EVENT
  ------------------------------------------------------------

  v_time_changed :=
       v_schedule.start_time is distinct from p_new_start_time
    or v_schedule.end_time is distinct from p_new_end_time;


  ------------------------------------------------------------
  -- UPDATE SCHEDULE
  --
  -- IMPORTANT:
  -- schedule.status is intentionally NOT changed here.
  ------------------------------------------------------------

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
    end_time = p_new_end_time,
    updated_at = pg_catalog.now()

  where schedule.id = v_schedule.id

  returning schedule.*
    into v_saved_schedule;


  ------------------------------------------------------------
  -- CREATE IMMUTABLE EVENT ONLY WHEN TIME ACTUALLY CHANGED
  ------------------------------------------------------------

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


  ------------------------------------------------------------
  -- RESPONSE
  ------------------------------------------------------------

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
  'Atomically updates an authorized scheduled appointment and creates one immutable appointment_rescheduled event only when its time range changes.';


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


notify pgrst, 'reload schema';

commit;