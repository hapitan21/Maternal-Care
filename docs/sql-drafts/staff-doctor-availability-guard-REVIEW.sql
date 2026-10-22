-- REVIEW DRAFT ONLY. Do not run against production without approval and
-- staging checks of the live schedule/user_availability schema and workflows.
-- Existing appointments are neither updated nor deleted by this draft.
-- The guard covers assigned active schedule rows regardless of which RPC
-- or authorized writer inserts or reschedules them.

begin;

create or replace function public.guard_schedule_doctor_availability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_timezone text;
  v_start_local timestamp without time zone;
  v_end_local timestamp without time zone;
  v_day integer;
  v_availability public.user_availability%rowtype;
begin
  -- Completion/cancellation and edits to existing appointment details remain
  -- possible, including for appointments outside a newly changed schedule.
  if tg_op = 'UPDATE'
     and new.doctor_id is not distinct from old.doctor_id
     and new.start_time is not distinct from old.start_time
     and new.end_time is not distinct from old.end_time
     and pg_catalog.lower(pg_catalog.btrim(coalesce(old.status, 'scheduled')))
         not in ('cancel', 'cancelled', 'canceled', 'no_show', 'no show',
                 'completed', 'complete') then
    return new;
  end if;

  if pg_catalog.lower(pg_catalog.btrim(coalesce(new.status, 'scheduled')))
       in ('cancel', 'cancelled', 'canceled', 'no_show', 'no show',
           'completed', 'complete') then
    return new;
  end if;

  -- Unassigned rows are outside this Doctor-specific guard. Existing RPC/RLS
  -- authorization must still govern whether such a row can be created.
  if new.doctor_id is null then
    return new;
  end if;

  if new.start_time is null or new.end_time is null
     or new.end_time <= new.start_time then
    raise exception 'Appointment must have a valid start and end time.'
      using errcode = '22023';
  end if;

  -- Serialize competing bookings before checking overlap. Hash collisions
  -- only cause extra waiting; they do not weaken the check.
  perform pg_catalog.pg_advisory_xact_lock(6240001, pg_catalog.hashtext(new.doctor_id::text));
  if new.patient_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(6240002, pg_catalog.hashtext(new.patient_id::text));
  end if;

  select settings.timezone into v_timezone
  from public.system_settings as settings
  where settings.singleton_guard = true;
  if v_timezone is null then
    raise exception 'Operational appointment timezone is unavailable.'
      using errcode = '55000';
  end if;

  v_start_local := new.start_time at time zone v_timezone;
  v_end_local := new.end_time at time zone v_timezone;
  if v_start_local::date <> v_end_local::date then
    raise exception 'Appointment must fit within one clinic-local day.'
      using errcode = '22023';
  end if;
  v_day := pg_catalog.extract(dow from v_start_local)::integer;

  -- FOR SHARE makes concurrent Doctor Settings updates wait until the booking
  -- completes (and vice versa). A missing/unavailable row fails closed.
  select availability.* into v_availability
  from public.user_availability as availability
  where availability.profile_id = new.doctor_id
    and availability.day_of_week = v_day
  for share;

  if not found or not coalesce(v_availability.is_available, false)
     or v_availability.start_time is null or v_availability.end_time is null
     or v_start_local::time < v_availability.start_time
     or v_end_local::time > v_availability.end_time then
    raise exception 'Appointment is outside the selected Doctor availability.'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from public.schedule as existing
    where existing.id is distinct from new.id
      and existing.doctor_id = new.doctor_id
      and pg_catalog.lower(pg_catalog.btrim(coalesce(existing.status, 'scheduled')))
          not in ('cancel', 'cancelled', 'canceled', 'no_show', 'no show',
                  'completed', 'complete')
      and existing.start_time < new.end_time
      and existing.end_time > new.start_time
  ) then
    raise exception 'The selected Doctor already has an appointment during this time.'
      using errcode = '23505';
  end if;

  if new.patient_id is not null and exists (
    select 1 from public.schedule as existing
    where existing.id is distinct from new.id
      and existing.patient_id = new.patient_id
      and pg_catalog.lower(pg_catalog.btrim(coalesce(existing.status, 'scheduled')))
          not in ('cancel', 'cancelled', 'canceled', 'no_show', 'no show',
                  'completed', 'complete')
      and existing.start_time < new.end_time
      and existing.end_time > new.start_time
  ) then
    raise exception 'The Patient already has an appointment during this time.'
      using errcode = '23505';
  end if;

  return new;
end;
$function$;

alter function public.guard_schedule_doctor_availability() owner to postgres;
revoke all on function public.guard_schedule_doctor_availability()
  from public, anon, authenticated;

drop trigger if exists schedule_doctor_availability_guard on public.schedule;
create trigger schedule_doctor_availability_guard
before insert or update of doctor_id, start_time, end_time, status
on public.schedule
for each row execute function public.guard_schedule_doctor_availability();

commit;

-- Staging review before approval: verify the live column types and trigger
-- ordering, RLS/SECURITY DEFINER ownership, legacy direct schedule writers,
-- walk-in and registration-created appointments, patient/Doctor/Admin flows,
-- same-time concurrency, Doctor Settings changes, and unchanged history.
