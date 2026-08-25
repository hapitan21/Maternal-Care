-- Manual review migration. Do not run automatically.
--
-- Adds secure Staff/Admin walk-in slot reservation and finalization RPCs for:
-- Staff > Patients > Add New Patient.
--
-- Review first in the Supabase SQL Editor. This migration assumes these existing
-- tables/functions from the current app:
-- - public.profiles
-- - public.user_availability
-- - public.doctor_personal_information
-- - public.doctor_professional_information
-- - public.schedule
-- - public.patients
-- - public.finish_patient_registration(uuid, uuid, boolean)
-- - public.create_appointment_patient_reminder(uuid)

begin;

-- Manual duplicate verification query if the active-slot preflight fails:
-- select
--   s.doctor_id,
--   s.start_time,
--   count(*) as appointment_count,
--   array_agg(s.id order by s.id) as appointment_ids,
--   array_agg(s.maternal_appointment_id order by s.id) as appointment_display_ids,
--   array_agg(s.status order by s.id) as statuses
-- from public.schedule s
-- where s.doctor_id is not null
--   and s.start_time is not null
--   and pg_catalog.lower(pg_catalog.btrim(coalesce(s.status, 'scheduled'))) not in (
--   'cancel',
--   'cancelled',
--   'canceled',
--   'no_show',
--   'no show',
--   'completed',
--   'complete'
-- )
-- group by s.doctor_id, s.start_time
-- having count(*) > 1
-- order by s.start_time, s.doctor_id;

do $preflight$
declare
  v_mismatches text;
  v_missing_functions text;
  v_duplicate_groups integer;
  v_constraint_errors text;
begin
  with expected(table_schema, table_name, column_name, sql_type) as (
    values
      ('public', 'profiles', 'id', 'uuid'),
      ('public', 'profiles', 'role', 'text'),
      ('public', 'profiles', 'account_status', 'text'),
      ('public', 'profiles', 'full_name', 'text'),
      ('public', 'profiles', 'email', 'text'),
      ('public', 'user_availability', 'profile_id', 'uuid'),
      ('public', 'user_availability', 'day_of_week', 'smallint'),
      ('public', 'user_availability', 'is_available', 'boolean'),
      ('public', 'user_availability', 'start_time', 'time without time zone'),
      ('public', 'user_availability', 'end_time', 'time without time zone'),
      ('public', 'doctor_personal_information', 'auth_user_id', 'uuid'),
      ('public', 'doctor_personal_information', 'full_name', 'text'),
      ('public', 'doctor_professional_information', 'auth_user_id', 'uuid'),
      ('public', 'doctor_professional_information', 'board_certification', 'text'),
      ('public', 'doctor_professional_information', 'clinic_hospital_name', 'text'),
      ('public', 'schedule', 'id', 'uuid'),
      ('public', 'schedule', 'maternal_appointment_id', 'text'),
      ('public', 'schedule', 'patient_id', 'uuid'),
      ('public', 'schedule', 'doctor_id', 'uuid'),
      ('public', 'schedule', 'patient_name', 'text'),
      ('public', 'schedule', 'doctor_name', 'text'),
      ('public', 'schedule', 'title', 'text'),
      ('public', 'schedule', 'description', 'text'),
      ('public', 'schedule', 'start_time', 'timestamp with time zone'),
      ('public', 'schedule', 'end_time', 'timestamp with time zone'),
      ('public', 'schedule', 'status', 'text'),
      ('public', 'patients', 'id', 'uuid'),
      ('public', 'patients', 'registration_token', 'uuid'),
      ('auth', 'users', 'id', 'uuid')
  ),
  actual as (
    select
      e.*,
      pg_catalog.format_type(a.atttypid, a.atttypmod) as actual_type
    from expected e
    left join pg_catalog.pg_namespace n
      on n.nspname = e.table_schema
    left join pg_catalog.pg_class c
      on c.relnamespace = n.oid
     and c.relname = e.table_name
     and c.relkind in ('r', 'p')
    left join pg_catalog.pg_attribute a
      on a.attrelid = c.oid
     and a.attname = e.column_name
     and a.attnum > 0
     and not a.attisdropped
  )
  select pg_catalog.string_agg(
    pg_catalog.format(
      '%I.%I.%I expected %s but found %s',
      table_schema,
      table_name,
      column_name,
      sql_type,
      coalesce(actual_type, '<missing>')
    ),
    '; '
  )
  into v_mismatches
  from actual
  where actual_type is distinct from sql_type
    and not (
      table_schema = 'public'
      and table_name = 'user_availability'
      and column_name = 'day_of_week'
      and sql_type = 'smallint'
      and actual_type in ('smallint', 'int2')
    );

  if v_mismatches is not null then
    raise exception 'Walk-in registration schema preflight failed: %', v_mismatches;
  end if;

  with expected_functions(signature) as (
    values
      ('public.finish_patient_registration(uuid, uuid, boolean)'::text),
      ('public.create_appointment_patient_reminder(uuid)'::text)
  )
  select pg_catalog.string_agg(signature, '; ')
    into v_missing_functions
  from expected_functions
  where pg_catalog.to_regprocedure(signature) is null;

  if v_missing_functions is not null then
    raise exception 'Walk-in registration function preflight failed. Missing or mismatched function(s): %',
      v_missing_functions;
  end if;

  select count(*)::integer
    into v_duplicate_groups
  from (
    select s.doctor_id, s.start_time
    from public.schedule s
    where s.doctor_id is not null
      and s.start_time is not null
      and pg_catalog.lower(pg_catalog.btrim(coalesce(s.status, 'scheduled'))) not in (
      'cancel',
      'cancelled',
      'canceled',
      'no_show',
      'no show',
      'completed',
      'complete'
    )
    group by s.doctor_id, s.start_time
    having count(*) > 1
  ) duplicate_slots;

  if v_duplicate_groups > 0 then
    raise exception 'Preflight failed: % duplicate active Doctor appointment slot group(s) exist. Run the commented duplicate verification query before creating schedule_one_active_doctor_slot_idx.',
      v_duplicate_groups;
  end if;

  if pg_catalog.to_regclass('public.staff_walkin_registration_reservations') is not null then
    with expected_constraints(conname, issue) as (
      values
        (
          'staff_walkin_reservations_status_check',
          case
            when not exists (
              select 1
              from pg_catalog.pg_constraint c
              where c.conrelid = 'public.staff_walkin_registration_reservations'::pg_catalog.regclass
                and c.conname = 'staff_walkin_reservations_status_check'
            ) then null
            when not exists (
              select 1
              from pg_catalog.pg_constraint c
              where c.conrelid = 'public.staff_walkin_registration_reservations'::pg_catalog.regclass
                and c.conname = 'staff_walkin_reservations_status_check'
                and c.contype = 'c'
                and pg_catalog.pg_get_constraintdef(c.oid, true) =
                  'CHECK (status = ANY (ARRAY[''reserved''::text, ''completed''::text, ''released''::text, ''expired''::text]))'
            ) then 'status check exists with a different definition'
            else null
          end
        ),
        (
          'staff_walkin_reservations_doctor_id_fkey',
          case
            when not exists (
              select 1 from pg_catalog.pg_constraint c
              where c.conrelid = 'public.staff_walkin_registration_reservations'::pg_catalog.regclass
                and c.conname = 'staff_walkin_reservations_doctor_id_fkey'
            ) then null
            when not exists (
              select 1 from pg_catalog.pg_constraint c
              where c.conrelid = 'public.staff_walkin_registration_reservations'::pg_catalog.regclass
                and c.conname = 'staff_walkin_reservations_doctor_id_fkey'
                and c.contype = 'f'
                and c.confrelid = 'public.profiles'::pg_catalog.regclass
                and c.conkey = array[
                  (
                    select a.attnum
                    from pg_catalog.pg_attribute a
                    where a.attrelid = 'public.staff_walkin_registration_reservations'::pg_catalog.regclass
                      and a.attname = 'doctor_id'
                  )
                ]::smallint[]
                and c.confkey = array[
                  (
                    select a.attnum
                    from pg_catalog.pg_attribute a
                    where a.attrelid = 'public.profiles'::pg_catalog.regclass
                      and a.attname = 'id'
                  )
                ]::smallint[]
                and c.confdeltype = 'r'
            ) then 'doctor_id foreign key exists with a different definition'
            else null
          end
        ),
        (
          'staff_walkin_reservations_reserved_by_fkey',
          case
            when not exists (
              select 1 from pg_catalog.pg_constraint c
              where c.conrelid = 'public.staff_walkin_registration_reservations'::pg_catalog.regclass
                and c.conname = 'staff_walkin_reservations_reserved_by_fkey'
            ) then null
            when not exists (
              select 1 from pg_catalog.pg_constraint c
              where c.conrelid = 'public.staff_walkin_registration_reservations'::pg_catalog.regclass
                and c.conname = 'staff_walkin_reservations_reserved_by_fkey'
                and c.contype = 'f'
                and c.confrelid = 'auth.users'::pg_catalog.regclass
                and c.conkey = array[
                  (
                    select a.attnum
                    from pg_catalog.pg_attribute a
                    where a.attrelid = 'public.staff_walkin_registration_reservations'::pg_catalog.regclass
                      and a.attname = 'reserved_by'
                  )
                ]::smallint[]
                and c.confkey = array[
                  (
                    select a.attnum
                    from pg_catalog.pg_attribute a
                    where a.attrelid = 'auth.users'::pg_catalog.regclass
                      and a.attname = 'id'
                  )
                ]::smallint[]
                and c.confdeltype = 'r'
            ) then 'reserved_by foreign key exists with a different definition'
            else null
          end
        ),
        (
          'staff_walkin_reservations_patient_record_id_fkey',
          case
            when not exists (
              select 1 from pg_catalog.pg_constraint c
              where c.conrelid = 'public.staff_walkin_registration_reservations'::pg_catalog.regclass
                and c.conname = 'staff_walkin_reservations_patient_record_id_fkey'
            ) then null
            when not exists (
              select 1 from pg_catalog.pg_constraint c
              where c.conrelid = 'public.staff_walkin_registration_reservations'::pg_catalog.regclass
                and c.conname = 'staff_walkin_reservations_patient_record_id_fkey'
                and c.contype = 'f'
                and c.confrelid = 'public.patients'::pg_catalog.regclass
                and c.conkey = array[
                  (
                    select a.attnum
                    from pg_catalog.pg_attribute a
                    where a.attrelid = 'public.staff_walkin_registration_reservations'::pg_catalog.regclass
                      and a.attname = 'patient_record_id'
                  )
                ]::smallint[]
                and c.confkey = array[
                  (
                    select a.attnum
                    from pg_catalog.pg_attribute a
                    where a.attrelid = 'public.patients'::pg_catalog.regclass
                      and a.attname = 'id'
                  )
                ]::smallint[]
                and c.confdeltype = 'n'
            ) then 'patient_record_id foreign key exists with a different definition'
            else null
          end
        ),
        (
          'staff_walkin_reservations_schedule_id_fkey',
          case
            when not exists (
              select 1 from pg_catalog.pg_constraint c
              where c.conrelid = 'public.staff_walkin_registration_reservations'::pg_catalog.regclass
                and c.conname = 'staff_walkin_reservations_schedule_id_fkey'
            ) then null
            when not exists (
              select 1 from pg_catalog.pg_constraint c
              where c.conrelid = 'public.staff_walkin_registration_reservations'::pg_catalog.regclass
                and c.conname = 'staff_walkin_reservations_schedule_id_fkey'
                and c.contype = 'f'
                and c.confrelid = 'public.schedule'::pg_catalog.regclass
                and c.conkey = array[
                  (
                    select a.attnum
                    from pg_catalog.pg_attribute a
                    where a.attrelid = 'public.staff_walkin_registration_reservations'::pg_catalog.regclass
                      and a.attname = 'schedule_id'
                  )
                ]::smallint[]
                and c.confkey = array[
                  (
                    select a.attnum
                    from pg_catalog.pg_attribute a
                    where a.attrelid = 'public.schedule'::pg_catalog.regclass
                      and a.attname = 'id'
                  )
                ]::smallint[]
                and c.confdeltype = 'n'
            ) then 'schedule_id foreign key exists with a different definition'
            else null
          end
        )
    )
    select pg_catalog.string_agg(conname || ': ' || issue, '; ')
      into v_constraint_errors
    from expected_constraints
    where issue is not null;

    if v_constraint_errors is not null then
      raise exception 'Walk-in reservation constraint preflight failed: %', v_constraint_errors;
    end if;
  end if;
end;
$preflight$;

create extension if not exists pgcrypto;

create table if not exists public.staff_walkin_registration_reservations (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  doctor_id uuid not null,
  slot_date date not null,
  slot_time time not null,
  reserved_by uuid not null,
  patient_record_id uuid,
  schedule_id uuid,
  status text not null default 'reserved',
  expires_at timestamptz not null default pg_catalog.now() + interval '30 minutes',
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

alter table public.staff_walkin_registration_reservations enable row level security;

do $reservation_constraints$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.staff_walkin_registration_reservations'::pg_catalog.regclass
      and c.conname = 'staff_walkin_reservations_status_check'
  ) then
    alter table public.staff_walkin_registration_reservations
      add constraint staff_walkin_reservations_status_check
      check (status in ('reserved', 'completed', 'released', 'expired'));
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.staff_walkin_registration_reservations'::pg_catalog.regclass
      and c.conname = 'staff_walkin_reservations_doctor_id_fkey'
  ) then
    alter table public.staff_walkin_registration_reservations
      add constraint staff_walkin_reservations_doctor_id_fkey
      foreign key (doctor_id)
      references public.profiles(id)
      on delete restrict;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.staff_walkin_registration_reservations'::pg_catalog.regclass
      and c.conname = 'staff_walkin_reservations_reserved_by_fkey'
  ) then
    alter table public.staff_walkin_registration_reservations
      add constraint staff_walkin_reservations_reserved_by_fkey
      foreign key (reserved_by)
      references auth.users(id)
      on delete restrict;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.staff_walkin_registration_reservations'::pg_catalog.regclass
      and c.conname = 'staff_walkin_reservations_patient_record_id_fkey'
  ) then
    alter table public.staff_walkin_registration_reservations
      add constraint staff_walkin_reservations_patient_record_id_fkey
      foreign key (patient_record_id)
      references public.patients(id)
      on delete set null;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.staff_walkin_registration_reservations'::pg_catalog.regclass
      and c.conname = 'staff_walkin_reservations_schedule_id_fkey'
  ) then
    alter table public.staff_walkin_registration_reservations
      add constraint staff_walkin_reservations_schedule_id_fkey
      foreign key (schedule_id)
      references public.schedule(id)
      on delete set null;
  end if;
end;
$reservation_constraints$;

create unique index if not exists staff_walkin_one_active_reservation_per_slot_idx
  on public.staff_walkin_registration_reservations (doctor_id, slot_date, slot_time)
  where status = 'reserved';

create unique index if not exists schedule_one_active_doctor_slot_idx
  on public.schedule (doctor_id, start_time)
  where doctor_id is not null
    and start_time is not null
    and pg_catalog.lower(pg_catalog.btrim(coalesce(status, 'scheduled'))) not in (
    'cancel',
    'cancelled',
    'canceled',
    'no_show',
    'no show',
    'completed',
    'complete'
  );

drop policy if exists "Staff can read own walk-in reservations"
  on public.staff_walkin_registration_reservations;

create policy "Staff can read own walk-in reservations"
on public.staff_walkin_registration_reservations
for select
to authenticated
using (
  reserved_by = auth.uid()
  or exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(p.role, ''))) = 'admin'
  )
);

revoke all on public.staff_walkin_registration_reservations from public, anon;
grant select on public.staff_walkin_registration_reservations to authenticated;

-- Canonical walk-in slot configuration for the current clinic workflow.
-- If clinic slot times change, update this helper and rerun this migration.
create or replace function public.get_walkin_registration_slot_times()
returns table (slot_time time)
language sql
stable
set search_path = ''
as $function$
  values
    ('08:00'::time),
    ('09:00'::time),
    ('10:30'::time),
    ('11:30'::time),
    ('13:00'::time),
    ('14:30'::time),
    ('15:30'::time)
$function$;

create or replace function public.get_walkin_registration_availability(
  p_slot_date date
)
returns table (
  doctor_id uuid,
  doctor_name text,
  specialization text,
  avatar_url text,
  scheduled_count integer,
  daily_capacity integer,
  remaining_slots integer,
  slots jsonb
)
language plpgsql
security definer
stable
set search_path = ''
as $function$
declare
  v_day_of_week smallint;
begin
  if auth.uid() is null or not exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(p.role, ''))) in ('staff', 'admin')
  ) then
    raise exception 'Only authenticated Staff or Admin users can view walk-in slots.'
      using errcode = '42501';
  end if;

  if p_slot_date < (pg_catalog.now() at time zone 'Asia/Manila')::date then
    raise exception 'Walk-in registration cannot use a past date.'
      using errcode = '22023';
  end if;

  v_day_of_week := extract(dow from p_slot_date)::smallint;

  return query
  with candidate_times as (
    select slot_time
    from public.get_walkin_registration_slot_times()
  ),
  active_doctors as (
    select
      p.id,
      pg_catalog.to_jsonb(p) ->> 'avatar_url' as avatar_url,
      coalesce(nullif(pg_catalog.btrim(dpi.full_name), ''), nullif(pg_catalog.btrim(p.full_name), ''), p.email, 'Doctor') as doctor_name,
      coalesce(
        nullif(pg_catalog.btrim(dpr.board_certification), ''),
        nullif(pg_catalog.btrim(dpr.clinic_hospital_name), ''),
        'Obstetrician - Gynecologist'
      ) as specialization
    from public.profiles p
    left join public.doctor_personal_information dpi
      on dpi.auth_user_id = p.id
    left join public.doctor_professional_information dpr
      on dpr.auth_user_id = p.id
    where pg_catalog.lower(pg_catalog.btrim(coalesce(p.role, ''))) = 'doctor'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(p.account_status, 'active'))) not in (
        'inactive',
        'deactivated',
        'disabled',
        'archived',
        'deleted'
      )
  ),
  availability as (
    select ua.*
    from public.user_availability ua
    where ua.day_of_week = v_day_of_week
      and ua.is_available is true
      and ua.start_time is not null
      and ua.end_time is not null
  ),
  doctor_slots as (
    select
      d.id as doctor_id,
      d.doctor_name,
      d.specialization,
      d.avatar_url,
      ct.slot_time,
      (p_slot_date::timestamp + ct.slot_time) at time zone 'Asia/Manila' as slot_start
    from active_doctors d
    join availability ua on ua.profile_id = d.id
    join candidate_times ct
      on ct.slot_time >= ua.start_time
     and ct.slot_time < ua.end_time
  ),
  active_appointments as (
    select s.*
    from public.schedule s
    where (s.start_time at time zone 'Asia/Manila')::date = p_slot_date
      and pg_catalog.lower(pg_catalog.btrim(coalesce(s.status, 'scheduled'))) not in (
        'cancel',
        'cancelled',
        'canceled',
        'no_show',
        'no show'
      )
  ),
  active_reservations as (
    select r.*
    from public.staff_walkin_registration_reservations r
    where r.slot_date = p_slot_date
      and r.status = 'reserved'
      and r.expires_at > pg_catalog.now()
  ),
  classified as (
    select
      ds.*,
      exists (
        select 1
        from active_appointments s
        where s.doctor_id = ds.doctor_id
          and (s.start_time at time zone 'Asia/Manila')::time = ds.slot_time
      ) as has_appointment,
      exists (
        select 1
        from active_reservations r
        where r.doctor_id = ds.doctor_id
          and r.slot_time = ds.slot_time
      ) as has_reservation,
      case
        when p_slot_date = (pg_catalog.now() at time zone 'Asia/Manila')::date
         and ds.slot_time <= (pg_catalog.now() at time zone 'Asia/Manila')::time
          then true
        else false
      end as is_past
    from doctor_slots ds
  ),
  doctor_counts as (
    select
      d.id as doctor_id,
      coalesce(capacity.daily_capacity, 0)::integer as daily_capacity,
      coalesce(scheduled.scheduled_count, 0)::integer as scheduled_count,
      coalesce(reserved.active_reservation_count, 0)::integer as active_reservation_count
    from active_doctors d
    left join (
      select doctor_slots.doctor_id, count(*)::integer as daily_capacity
      from doctor_slots
      group by doctor_slots.doctor_id
    ) capacity on capacity.doctor_id = d.id
    left join (
      select active_appointments.doctor_id, count(*)::integer as scheduled_count
      from active_appointments
      group by active_appointments.doctor_id
    ) scheduled on scheduled.doctor_id = d.id
    left join (
      select active_reservations.doctor_id, count(*)::integer as active_reservation_count
      from active_reservations
      group by active_reservations.doctor_id
    ) reserved on reserved.doctor_id = d.id
  )
  select
    d.id as doctor_id,
    d.doctor_name,
    d.specialization,
    d.avatar_url,
    dc.scheduled_count,
    dc.daily_capacity,
    least(
      count(c.slot_time) filter (
        where not c.has_appointment
          and not c.has_reservation
          and not c.is_past
      )::integer,
      greatest(
        dc.daily_capacity - dc.scheduled_count - dc.active_reservation_count,
        0
      )
    )::integer as remaining_slots,
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', c.doctor_id::text || '-' || p_slot_date::text || '-' || pg_catalog.to_char(c.slot_time, 'HH24:MI'),
          'doctorId', c.doctor_id,
          'date', p_slot_date,
          'time', pg_catalog.to_char(c.slot_time, 'HH24:MI'),
          'label', pg_catalog.to_char(c.slot_start at time zone 'Asia/Manila', 'FMHH12:MI AM'),
          'status',
            case
              when c.has_reservation then 'reserved'
              when c.has_appointment
                or dc.scheduled_count + dc.active_reservation_count >= dc.daily_capacity then 'full'
              when c.is_past then 'unavailable'
              else 'available'
            end,
          'description',
            case
              when c.has_reservation then 'Reserved'
              when c.has_appointment
                or dc.scheduled_count + dc.active_reservation_count >= dc.daily_capacity then 'Scheduled Appointment'
              when c.is_past then 'Unavailable'
              else 'Walk-in Slot'
            end
        )
        order by c.slot_time
      ) filter (where c.slot_time is not null),
      '[]'::jsonb
    ) as slots
  from active_doctors d
  join doctor_counts dc on dc.doctor_id = d.id
  left join classified c on c.doctor_id = d.id
  group by
    d.id,
    d.doctor_name,
    d.specialization,
    d.avatar_url,
    dc.scheduled_count,
    dc.daily_capacity,
    dc.active_reservation_count
  order by d.doctor_name;
end;
$function$;

create or replace function public.reserve_walkin_registration_slot(
  p_doctor_id uuid,
  p_slot_date date,
  p_slot_time time
)
returns table (
  reservation_id uuid,
  doctor_id uuid,
  slot_date date,
  slot_time time,
  expires_at timestamptz,
  status text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_day_of_week smallint;
  v_availability public.user_availability%rowtype;
  v_daily_capacity integer;
  v_scheduled_count integer;
  v_active_reservation_count integer;
  v_existing public.staff_walkin_registration_reservations%rowtype;
  v_reserved public.staff_walkin_registration_reservations%rowtype;
begin
  if auth.uid() is null or not exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(p.role, ''))) in ('staff', 'admin')
  ) then
    raise exception 'Only authenticated Staff or Admin users can reserve walk-in slots.'
      using errcode = '42501';
  end if;

  if p_slot_date < (pg_catalog.now() at time zone 'Asia/Manila')::date then
    raise exception 'Walk-in registration cannot use a past date.'
      using errcode = '22023';
  end if;

  if p_slot_date = (pg_catalog.now() at time zone 'Asia/Manila')::date
     and p_slot_time <= (pg_catalog.now() at time zone 'Asia/Manila')::time then
    raise exception 'This walk-in slot has already passed.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.id = p_doctor_id
      and pg_catalog.lower(pg_catalog.btrim(coalesce(p.role, ''))) = 'doctor'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(p.account_status, 'active'))) not in (
        'inactive',
        'deactivated',
        'disabled',
        'archived',
        'deleted'
      )
  ) then
    raise exception 'The selected Doctor is not active.'
      using errcode = '22023';
  end if;

  update public.staff_walkin_registration_reservations r
  set status = 'expired',
      updated_at = pg_catalog.now()
  where r.status = 'reserved'
    and r.expires_at <= pg_catalog.now();

  v_day_of_week := extract(dow from p_slot_date)::smallint;

  select ua.*
    into v_availability
  from public.user_availability ua
  where ua.profile_id = p_doctor_id
    and ua.day_of_week = v_day_of_week
    and ua.is_available is true
    and p_slot_time >= ua.start_time
    and p_slot_time < ua.end_time
  limit 1;

  if not found then
    raise exception 'The selected slot is outside the Doctor availability.'
      using errcode = '22023';
  end if;

  with candidate_times as (
    select configured_slots.slot_time as configured_slot_time
    from public.get_walkin_registration_slot_times() as configured_slots
  )
  select count(*)::integer
    into v_daily_capacity
  from candidate_times as candidate
  where candidate.configured_slot_time >= v_availability.start_time
    and candidate.configured_slot_time < v_availability.end_time;

  if v_daily_capacity <= 0 then
    raise exception 'No walk-in capacity is configured for this Doctor and date.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.get_walkin_registration_slot_times() as configured_slots
    where configured_slots.slot_time = p_slot_time
  ) then
    raise exception 'The selected time is not a configured walk-in slot.'
      using errcode = '22023';
  end if;

  select count(*)::integer
    into v_scheduled_count
  from public.schedule s
  where s.doctor_id = p_doctor_id
    and (s.start_time at time zone 'Asia/Manila')::date = p_slot_date
    and pg_catalog.lower(pg_catalog.btrim(coalesce(s.status, 'scheduled'))) not in (
      'cancel',
      'cancelled',
      'canceled',
      'no_show',
      'no show'
    );

  if exists (
    select 1
    from public.schedule s
    where s.doctor_id = p_doctor_id
      and (s.start_time at time zone 'Asia/Manila')::date = p_slot_date
      and (s.start_time at time zone 'Asia/Manila')::time = p_slot_time
      and pg_catalog.lower(pg_catalog.btrim(coalesce(s.status, 'scheduled'))) not in (
        'cancel',
        'cancelled',
        'canceled',
        'no_show',
        'no show'
      )
  ) then
    raise exception 'This walk-in slot is already occupied.'
      using errcode = '23505';
  end if;

  select r.*
    into v_existing
  from public.staff_walkin_registration_reservations r
  where r.doctor_id = p_doctor_id
    and r.slot_date = p_slot_date
    and r.slot_time = p_slot_time
    and r.status = 'reserved'
  for update;

  if found then
    if v_existing.reserved_by = auth.uid() then
      return query
      select
        v_existing.id,
        v_existing.doctor_id,
        v_existing.slot_date,
        v_existing.slot_time,
        v_existing.expires_at,
        v_existing.status;
      return;
    end if;

    raise exception 'This walk-in slot has just been reserved by another Staff user.'
      using errcode = '23505';
  end if;

  select count(*)::integer
    into v_active_reservation_count
  from public.staff_walkin_registration_reservations r
  where r.doctor_id = p_doctor_id
    and r.slot_date = p_slot_date
    and r.status = 'reserved'
    and r.expires_at > pg_catalog.now();

  if v_scheduled_count + v_active_reservation_count >= v_daily_capacity then
    raise exception 'The Doctor daily capacity has been reached.'
      using errcode = '23505';
  end if;

  insert into public.staff_walkin_registration_reservations (
    doctor_id,
    slot_date,
    slot_time,
    reserved_by,
    status,
    expires_at,
    updated_at
  ) values (
    p_doctor_id,
    p_slot_date,
    p_slot_time,
    auth.uid(),
    'reserved',
    pg_catalog.now() + interval '30 minutes',
    pg_catalog.now()
  )
  returning * into v_reserved;

  return query
  select
    v_reserved.id,
    v_reserved.doctor_id,
    v_reserved.slot_date,
    v_reserved.slot_time,
    v_reserved.expires_at,
    v_reserved.status;
end;
$function$;

create or replace function public.release_walkin_registration_slot(
  p_reservation_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reservation public.staff_walkin_registration_reservations%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select r.*
    into v_reservation
  from public.staff_walkin_registration_reservations r
  where r.id = p_reservation_id
  for update;

  if not found then
    return;
  end if;

  if v_reservation.reserved_by <> auth.uid()
     and not exists (
       select 1
       from public.profiles p
       where p.id = auth.uid()
         and pg_catalog.lower(pg_catalog.btrim(coalesce(p.role, ''))) = 'admin'
     ) then
    raise exception 'This walk-in reservation belongs to another Staff user.'
      using errcode = '42501';
  end if;

  update public.staff_walkin_registration_reservations r
  set status = 'released',
      updated_at = pg_catalog.now()
  where r.id = p_reservation_id
    and r.status = 'reserved';
end;
$function$;

create or replace function public.finish_walkin_patient_registration(
  p_patient_record_id uuid,
  p_registration_token uuid,
  p_reservation_id uuid,
  p_access_handoff_confirmed boolean
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
  v_reservation public.staff_walkin_registration_reservations%rowtype;
  v_patient public.patients%rowtype;
  v_doctor_name text;
  v_slot_start timestamptz;
  v_slot_end timestamptz;
  v_day_of_week smallint;
  v_availability public.user_availability%rowtype;
  v_daily_capacity integer;
  v_scheduled_count integer;
  v_active_reservation_count integer;
  v_schedule public.schedule%rowtype;
  v_finished record;
begin
  if auth.uid() is null or not exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(p.role, ''))) in ('staff', 'admin')
  ) then
    raise exception 'Only authenticated Staff or Admin users can finish walk-in registration.'
      using errcode = '42501';
  end if;

  select r.*
    into v_reservation
  from public.staff_walkin_registration_reservations r
  where r.id = p_reservation_id
  for update;

  if not found then
    raise exception 'The selected walk-in reservation was not found.'
      using errcode = 'P0002';
  end if;

  if v_reservation.reserved_by <> auth.uid()
     and not exists (
       select 1
       from public.profiles p
       where p.id = auth.uid()
         and pg_catalog.lower(pg_catalog.btrim(coalesce(p.role, ''))) = 'admin'
     ) then
    raise exception 'This walk-in reservation belongs to another Staff user.'
      using errcode = '42501';
  end if;

  if v_reservation.status <> 'reserved' then
    raise exception 'The selected walk-in reservation is no longer active.'
      using errcode = 'P0001';
  end if;

  if v_reservation.expires_at <= pg_catalog.now() then
    update public.staff_walkin_registration_reservations r
    set status = 'expired',
        updated_at = pg_catalog.now()
    where r.id = v_reservation.id;

    raise exception 'The selected walk-in reservation has expired.'
      using errcode = 'P0001';
  end if;

  select p.*
    into v_patient
  from public.patients p
  where p.id = p_patient_record_id
    and p.registration_token = p_registration_token
  for update;

  if not found then
    raise exception 'The provisional Patient registration could not be found.'
      using errcode = 'P0002';
  end if;

  select coalesce(nullif(pg_catalog.btrim(dpi.full_name), ''), nullif(pg_catalog.btrim(p.full_name), ''), p.email, 'Doctor')
    into v_doctor_name
  from public.profiles p
  left join public.doctor_personal_information dpi
    on dpi.auth_user_id = p.id
  where p.id = v_reservation.doctor_id;

  v_slot_start := (v_reservation.slot_date::timestamp + v_reservation.slot_time) at time zone 'Asia/Manila';
  v_slot_end := v_slot_start + interval '1 hour';
  v_day_of_week := extract(dow from v_reservation.slot_date)::smallint;

  select ua.*
    into v_availability
  from public.user_availability ua
  where ua.profile_id = v_reservation.doctor_id
    and ua.day_of_week = v_day_of_week
    and ua.is_available is true
    and v_reservation.slot_time >= ua.start_time
    and v_reservation.slot_time < ua.end_time
  limit 1;

  if not found then
    raise exception 'The selected slot is outside the Doctor availability.'
      using errcode = '22023';
  end if;

  with candidate_times as (
    select configured_slots.slot_time as configured_slot_time
    from public.get_walkin_registration_slot_times() as configured_slots
  )
  select count(*)::integer
    into v_daily_capacity
  from candidate_times as candidate
  where candidate.configured_slot_time >= v_availability.start_time
    and candidate.configured_slot_time < v_availability.end_time;

  if v_daily_capacity <= 0 then
    raise exception 'No walk-in capacity is configured for this Doctor and date.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.schedule s
    where s.doctor_id = v_reservation.doctor_id
      and s.start_time = v_slot_start
      and pg_catalog.lower(pg_catalog.btrim(coalesce(s.status, 'scheduled'))) not in (
        'cancel',
        'cancelled',
        'canceled',
        'no_show',
        'no show'
      )
  ) then
    raise exception 'This walk-in slot is already occupied.'
      using errcode = '23505';
  end if;

  select count(*)::integer
    into v_scheduled_count
  from public.schedule s
  where s.doctor_id = v_reservation.doctor_id
    and (s.start_time at time zone 'Asia/Manila')::date = v_reservation.slot_date
    and pg_catalog.lower(pg_catalog.btrim(coalesce(s.status, 'scheduled'))) not in (
      'cancel',
      'cancelled',
      'canceled',
      'no_show',
      'no show'
    );

  select count(*)::integer
    into v_active_reservation_count
  from public.staff_walkin_registration_reservations r
  where r.doctor_id = v_reservation.doctor_id
    and r.slot_date = v_reservation.slot_date
    and r.status = 'reserved'
    and r.expires_at > pg_catalog.now()
    and r.id <> v_reservation.id;

  if v_scheduled_count + v_active_reservation_count >= v_daily_capacity then
    raise exception 'The Doctor daily capacity has been reached.'
      using errcode = '23505';
  end if;

  select *
    into v_finished
  from public.finish_patient_registration(
    p_patient_record_id,
    p_registration_token,
    p_access_handoff_confirmed
  );

  insert into public.schedule (
    patient_id,
    doctor_id,
    patient_name,
    doctor_name,
    title,
    description,
    start_time,
    end_time,
    status
  ) values (
    v_patient.id,
    v_reservation.doctor_id,
    v_patient.full_name,
    v_doctor_name,
    'Initial Prenatal Check-up',
    pg_catalog.jsonb_build_object(
      'category', 'checkup',
      'source', 'staff_walkin_registration',
      'reservationId', v_reservation.id
    )::text,
    v_slot_start,
    v_slot_end,
    'scheduled'
  )
  returning * into v_schedule;

  perform public.create_appointment_patient_reminder(v_schedule.id);

  update public.staff_walkin_registration_reservations r
  set status = 'completed',
      patient_record_id = v_patient.id,
      schedule_id = v_schedule.id,
      updated_at = pg_catalog.now()
  where r.id = v_reservation.id;

  return query
  select
    v_finished.id,
    v_finished.full_name,
    v_finished.patient_id,
    v_finished.control_number,
    v_finished.date_of_birth,
    v_finished.age,
    v_finished.contact_number,
    v_finished.email,
    v_finished.address,
    v_finished.status,
    v_finished.account_status,
    v_finished.registration_status,
    v_finished.user_id,
    v_finished.control_used_at,
    v_finished.created_at,
    v_finished.registration_data;
end;
$function$;

revoke all on function public.get_walkin_registration_slot_times() from public, anon;
grant execute on function public.get_walkin_registration_slot_times() to authenticated;

revoke all on function public.get_walkin_registration_availability(date) from public, anon;
grant execute on function public.get_walkin_registration_availability(date) to authenticated;

revoke all on function public.reserve_walkin_registration_slot(uuid, date, time) from public, anon;
grant execute on function public.reserve_walkin_registration_slot(uuid, date, time) to authenticated;

revoke all on function public.release_walkin_registration_slot(uuid) from public, anon;
grant execute on function public.release_walkin_registration_slot(uuid) to authenticated;

revoke all on function public.finish_walkin_patient_registration(uuid, uuid, uuid, boolean) from public, anon;
grant execute on function public.finish_walkin_patient_registration(uuid, uuid, uuid, boolean) to authenticated;

notify pgrst, 'reload schema';

commit;
