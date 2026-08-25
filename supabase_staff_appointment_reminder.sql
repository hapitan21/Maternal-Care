-- Manual review migration. Do not run automatically.
--
-- Read-only preflight queries for the Supabase SQL Editor:
--
-- 1. Appointment and reminder columns, types, nullability, and defaults.
-- select table_name, column_name, data_type, udt_name, is_nullable, column_default
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name in ('schedule', 'reminders')
-- order by table_name, ordinal_position;
--
-- 2. Reminder NOT NULL and CHECK constraints.
-- select c.conname, c.contype, pg_get_constraintdef(c.oid) as definition
-- from pg_constraint c
-- where c.conrelid = 'public.reminders'::regclass
-- order by c.contype, c.conname;
--
-- 3. Existing reminder RLS policies.
-- select policyname, permissive, roles, cmd, qual, with_check
-- from pg_policies
-- where schemaname = 'public' and tablename = 'reminders'
-- order by policyname;
--
-- 4. Duplicate appointment reminders that must be resolved before this migration.
-- select schedule_id, count(*)
-- from public.reminders
-- where schedule_id is not null
--   and lower(coalesce(reminder_type, '')) = 'appointment'
-- group by schedule_id
-- having count(*) > 1;
--
-- 5. Appointment primary-key type.
-- select pg_catalog.format_type(a.atttypid, a.atttypmod) as schedule_id_type
-- from pg_attribute a
-- where a.attrelid = 'public.schedule'::regclass
--   and a.attname = 'id'
--   and not a.attisdropped;
--
-- After this migration, verify the complete replacement policy set:
-- select policyname, permissive, roles, cmd, qual, with_check
-- from pg_policies
-- where schemaname = 'public' and tablename = 'reminders'
-- order by cmd, policyname;

begin;

do $preflight$
declare
  v_mismatches text;
  v_unhandled_required_columns text;
begin
  if to_regclass('public.schedule') is null then
    raise exception 'Preflight failed: public.schedule does not exist.';
  end if;

  if to_regclass('public.reminders') is null then
    raise exception 'Preflight failed: public.reminders does not exist.';
  end if;

  with expected(table_name, column_name, sql_type) as (
    values
      ('schedule', 'id', 'uuid'),
      ('schedule', 'patient_id', 'uuid'),
      ('schedule', 'doctor_id', 'uuid'),
      ('schedule', 'title', 'text'),
      ('schedule', 'start_time', 'timestamp with time zone'),
      ('schedule', 'status', 'text'),
      ('patients', 'id', 'uuid'),
      ('patients', 'user_id', 'uuid'),
      ('patients', 'account_status', 'text'),
      ('patients', 'archived_at', 'timestamp with time zone'),
      ('patients', 'status', 'text'),
      ('reminders', 'id', 'uuid'),
      ('reminders', 'patient_id', 'uuid'),
      ('reminders', 'schedule_id', 'uuid'),
      ('reminders', 'created_by', 'uuid'),
      ('reminders', 'reminder_type', 'text'),
      ('reminders', 'title', 'text'),
      ('reminders', 'message', 'text'),
      ('reminders', 'remind_at', 'timestamp with time zone'),
      ('reminders', 'status', 'text'),
      ('reminders', 'sent_at', 'timestamp with time zone')
  )
  select string_agg(
    format(
      'public.%I.%I expected %s but found %s',
      e.table_name,
      e.column_name,
      e.sql_type,
      coalesce(pg_catalog.format_type(a.atttypid, a.atttypmod), 'missing')
    ),
    '; '
  )
  into v_mismatches
  from expected e
  left join pg_namespace n on n.nspname = 'public'
  left join pg_class t on t.relnamespace = n.oid and t.relname = e.table_name
  left join pg_attribute a
    on a.attrelid = t.oid
   and a.attname = e.column_name
   and a.attnum > 0
   and not a.attisdropped
  where a.attname is null
     or pg_catalog.format_type(a.atttypid, a.atttypmod) <> e.sql_type;

  if v_mismatches is not null then
    raise exception 'Preflight failed: %', v_mismatches;
  end if;

  select string_agg(a.attname, ', ' order by a.attnum)
  into v_unhandled_required_columns
  from pg_attribute a
  left join pg_attrdef d
    on d.adrelid = a.attrelid
   and d.adnum = a.attnum
  where a.attrelid = 'public.reminders'::regclass
    and a.attnum > 0
    and not a.attisdropped
    and a.attnotnull
    and a.attgenerated = ''
    and d.adbin is null
    and a.attname not in (
      'patient_id',
      'schedule_id',
      'created_by',
      'reminder_type',
      'title',
      'message',
      'remind_at',
      'status',
      'sent_at'
    );

  if v_unhandled_required_columns is not null then
    raise exception
      'Preflight failed: reminder insert has unhandled required columns: %',
      v_unhandled_required_columns;
  end if;

  if exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'public.reminders'::regclass
      and c.contype = 'c'
      and lower(pg_get_constraintdef(c.oid)) like '%status%'
  ) and not exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'public.reminders'::regclass
      and c.contype = 'c'
      and lower(pg_get_constraintdef(c.oid)) like '%status%'
      and lower(pg_get_constraintdef(c.oid)) like '%pending%'
  ) then
    raise exception
      'Preflight failed: the reminders.status check constraint does not allow pending.';
  end if;

  if exists (
    select 1
    from public.reminders r
    where r.schedule_id is not null
      and lower(coalesce(r.reminder_type, '')) = 'appointment'
    group by r.schedule_id
    having count(*) > 1
  ) then
    raise exception
      'Preflight failed: duplicate appointment reminders exist. Run the commented duplicate query and resolve them first.';
  end if;
end;
$preflight$;

create unique index if not exists reminders_one_appointment_per_schedule_idx
  on public.reminders (schedule_id)
  where schedule_id is not null
    and lower(coalesce(reminder_type, '')) = 'appointment';

drop function if exists public.create_appointment_patient_reminder(uuid);

create function public.create_appointment_patient_reminder(
  p_appointment_id uuid
)
returns public.reminders
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_appointment public.schedule%rowtype;
  v_existing public.reminders%rowtype;
  v_created public.reminders%rowtype;
  v_remind_at timestamp with time zone;
  v_appointment_title text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(coalesce(p.role, '')) in ('staff', 'doctor', 'admin')
  ) then
    raise exception 'Only Staff, Doctors, and Admins can create appointment reminders.'
      using errcode = '42501';
  end if;

  select s.*
  into v_appointment
  from public.schedule s
  where s.id = p_appointment_id
  for share;

  if not found then
    raise exception 'The appointment was not found.' using errcode = 'P0002';
  end if;

  if lower(coalesce(v_appointment.status, '')) in (
    'cancelled',
    'canceled',
    'cancel',
    'no_show',
    'no show'
  ) then
    raise exception 'A reminder cannot be created for a cancelled appointment.'
      using errcode = '22023';
  end if;

  if v_appointment.patient_id is null then
    raise exception 'The appointment is not linked to a Patient record.'
      using errcode = '23502';
  end if;

  select r.*
  into v_existing
  from public.reminders r
  where r.schedule_id = p_appointment_id
    and lower(coalesce(r.reminder_type, '')) = 'appointment'
  limit 1;

  if found then
    return v_existing;
  end if;

  v_appointment_title := coalesce(
    nullif(btrim(v_appointment.title), ''),
    'maternal care appointment'
  );

  v_remind_at := case
    when v_appointment.start_time - interval '24 hours' > now()
      then v_appointment.start_time - interval '24 hours'
    when v_appointment.start_time - interval '1 hour' > now()
      then v_appointment.start_time - interval '1 hour'
    else now()
  end;

  insert into public.reminders (
    patient_id,
    schedule_id,
    created_by,
    reminder_type,
    title,
    message,
    remind_at,
    status,
    sent_at
  )
  values (
    v_appointment.patient_id,
    v_appointment.id,
    auth.uid(),
    'appointment',
    'Upcoming Maternal Care Appointment',
    format(
      'You have a scheduled %s on %s.',
      v_appointment_title,
      to_char(
        v_appointment.start_time at time zone 'Asia/Manila',
        'FMMonth DD, YYYY at FMHH12:MI AM'
      )
    ),
    v_remind_at,
    'pending',
    null
  )
  on conflict (schedule_id)
    where schedule_id is not null
      and lower(coalesce(reminder_type, '')) = 'appointment'
  do nothing
  returning * into v_created;

  if found then
    return v_created;
  end if;

  select r.*
  into v_existing
  from public.reminders r
  where r.schedule_id = p_appointment_id
    and lower(coalesce(r.reminder_type, '')) = 'appointment'
  limit 1;

  if not found then
    raise exception 'The appointment reminder could not be created.';
  end if;

  return v_existing;
end;
$function$;

alter table public.reminders enable row level security;

do $policies$
declare
  v_policy record;
begin
  for v_policy in
    select p.policyname
    from pg_policies p
    where p.schemaname = 'public'
      and p.tablename = 'reminders'
  loop
    execute format(
      'drop policy if exists %I on public.reminders',
      v_policy.policyname
    );
  end loop;
end;
$policies$;

create policy "Clinic users can read reminders"
on public.reminders
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(coalesce(p.role, '')) in ('admin', 'doctor', 'staff')
  )
);

create policy "Patients can read own reminders"
on public.reminders
for select
to authenticated
using (
  exists (
    select 1
    from public.patients p
    where p.id = reminders.patient_id
      and p.user_id = auth.uid()
      and lower(btrim(coalesce(p.account_status, ''))) = 'active'
      and p.archived_at is null
      and lower(btrim(coalesce(p.status, ''))) not in ('archived', 'deleted')
  )
);

create policy "Doctors and admins can insert reminders"
on public.reminders
for insert
to authenticated
with check (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(coalesce(p.role, '')) in ('admin', 'doctor')
  )
);

create policy "Only Doctors and admins can directly insert reminders"
on public.reminders
as restrictive
for insert
to authenticated
with check (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(coalesce(p.role, '')) in ('admin', 'doctor')
  )
);

create policy "Doctors and admins can update reminders"
on public.reminders
for update
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(coalesce(p.role, '')) in ('admin', 'doctor')
  )
)
with check (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(coalesce(p.role, '')) in ('admin', 'doctor')
  )
);

create policy "Doctors and admins can delete reminders"
on public.reminders
for delete
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(coalesce(p.role, '')) in ('admin', 'doctor')
  )
);

create policy "Staff can cancel appointment reminders"
on public.reminders
for update
to authenticated
using (
  lower(coalesce(reminders.reminder_type, '')) = 'appointment'
  and exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(coalesce(p.role, '')) = 'staff'
  )
)
with check (
  lower(coalesce(reminders.reminder_type, '')) = 'appointment'
  and lower(coalesce(reminders.status, '')) = 'cancelled'
  and exists (
    select 1
    from public.schedule s
    where s.id = reminders.schedule_id
      and lower(coalesce(s.status, '')) in ('cancelled', 'canceled', 'cancel')
  )
  and exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(coalesce(p.role, '')) = 'staff'
  )
);

create policy "Reminder updates must follow clinic roles"
on public.reminders
as restrictive
for update
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(coalesce(p.role, '')) in ('admin', 'doctor')
  )
  or (
    lower(coalesce(reminders.reminder_type, '')) = 'appointment'
    and exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and lower(coalesce(p.role, '')) = 'staff'
    )
  )
)
with check (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(coalesce(p.role, '')) in ('admin', 'doctor')
  )
  or (
    lower(coalesce(reminders.reminder_type, '')) = 'appointment'
    and lower(coalesce(reminders.status, '')) = 'cancelled'
    and exists (
      select 1
      from public.schedule s
      where s.id = reminders.schedule_id
        and lower(coalesce(s.status, '')) in ('cancelled', 'canceled', 'cancel')
    )
    and exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and lower(coalesce(p.role, '')) = 'staff'
    )
  )
);

create policy "Only Doctors and admins can delete reminders"
on public.reminders
as restrictive
for delete
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(coalesce(p.role, '')) in ('admin', 'doctor')
  )
);

revoke all on public.reminders from public, anon;
grant select, insert, update, delete on public.reminders to authenticated;

revoke all on function public.create_appointment_patient_reminder(uuid)
  from public, anon;
grant execute on function public.create_appointment_patient_reminder(uuid)
  to authenticated;

notify pgrst, 'reload schema';

commit;
