-- ============================================================
-- Maternal Care - Automatic appointment reminders (Phase 4A)
-- ============================================================
-- Review and run this file manually in the Supabase SQL Editor.
-- It creates no Cron job and calls no Edge Function directly.
--
-- Existing flow after this setup:
--   Supabase Cron
--   -> public.process_due_appointment_reminders()
--   -> public.patient_notifications INSERT
--   -> existing Database Webhook
--   -> existing send-patient-web-push Edge Function
--
-- This script assumes the reviewed application contracts:
--   public.schedule.id, patient_id: uuid
--   public.schedule.start_time: timestamptz
--   public.patients.id, user_id: uuid
--   public.patient_notifications.id, related_appointment_id: uuid
-- ============================================================

-- ============================================================
-- READ-ONLY PRE-FLIGHT QUERIES
-- Run these separately before applying the transaction.
-- ============================================================

-- Confirm schedule column types.
-- select
--   column_name,
--   data_type,
--   udt_schema,
--   udt_name,
--   is_nullable
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name = 'schedule'
--   and column_name in ('id', 'patient_id', 'start_time', 'status')
-- order by ordinal_position;

-- Confirm Patient linkage and lifecycle column types.
-- select
--   column_name,
--   data_type,
--   udt_schema,
--   udt_name,
--   is_nullable
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name = 'patients'
--   and column_name in (
--     'id',
--     'user_id',
--     'account_status',
--     'archived_at',
--     'status'
--   )
-- order by ordinal_position;

-- Confirm notification relationship column types.
-- select
--   column_name,
--   data_type,
--   udt_schema,
--   udt_name,
--   is_nullable
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name = 'patient_notifications'
--   and column_name in ('id', 'related_appointment_id')
-- order by ordinal_position;

-- Confirm whether pg_cron is already installed (expected: zero or one row).
-- select
--   extension.extname,
--   extension.extversion
-- from pg_catalog.pg_extension as extension
-- where extension.extname = 'pg_cron';

-- If pg_cron is installed, confirm the target job does not already exist.
-- select
--   job.jobid,
--   job.jobname,
--   job.schedule,
--   job.command,
--   job.active
-- from cron.job as job
-- where job.jobname = 'process-due-appointment-reminders';

-- Check for an existing ledger table conflict.
-- select pg_catalog.to_regclass(
--   'public.appointment_reminder_dispatches'
-- ) as existing_ledger_table;

-- Check for an existing processing-function conflict.
-- select
--   namespace.nspname as function_schema,
--   procedure.proname as function_name,
--   pg_catalog.pg_get_function_identity_arguments(procedure.oid) as arguments,
--   pg_catalog.pg_get_function_result(procedure.oid) as result_type
-- from pg_catalog.pg_proc as procedure
-- join pg_catalog.pg_namespace as namespace
--   on namespace.oid = procedure.pronamespace
-- where namespace.nspname = 'public'
--   and procedure.proname = 'process_due_appointment_reminders';

-- Review every stored appointment status before applying the active allowlist.
-- select
--   lower(trim(coalesce(status, ''))) as normalized_status,
--   count(*)
-- from public.schedule
-- group by lower(trim(coalesce(status, '')))
-- order by normalized_status;

begin;

create table public.appointment_reminder_dispatches (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  schedule_id uuid not null,
  patient_id uuid not null,
  notification_id uuid,
  reminder_offset_minutes integer not null,
  appointment_start_time timestamptz not null,
  status text not null default 'processing',
  claimed_at timestamptz not null default pg_catalog.now(),
  notification_created_at timestamptz,
  error_code text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint appointment_reminder_dispatches_schedule_id_fkey
    foreign key (schedule_id)
    references public.schedule(id)
    on delete cascade,
  constraint appointment_reminder_dispatches_patient_id_fkey
    foreign key (patient_id)
    references public.patients(id)
    on delete cascade,
  constraint appointment_reminder_dispatches_notification_id_fkey
    foreign key (notification_id)
    references public.patient_notifications(id)
    on delete set null,
  constraint appointment_reminder_dispatches_offset_check
    check (reminder_offset_minutes in (1440, 120)),
  constraint appointment_reminder_dispatches_status_check
    check (status in ('processing', 'created', 'skipped', 'failed')),
  constraint appointment_reminder_dispatches_error_code_check
    check (
      error_code is null
      or (
        error_code = pg_catalog.btrim(error_code)
        and pg_catalog.char_length(error_code) between 1 and 80
      )
    ),
  constraint appointment_reminder_dispatches_schedule_offset_key
    unique (schedule_id, reminder_offset_minutes)
);

comment on table public.appointment_reminder_dispatches is
  'Server-internal idempotency ledger for automatic Patient appointment reminders.';
comment on column public.appointment_reminder_dispatches.reminder_offset_minutes is
  'Reminder window claimed for this appointment: 1440 minutes or 120 minutes.';
comment on column public.appointment_reminder_dispatches.error_code is
  'Short privacy-safe processing code. Raw database errors are never stored.';

create index appointment_reminder_dispatches_status_claimed_idx
  on public.appointment_reminder_dispatches (status, claimed_at desc);

create index appointment_reminder_dispatches_patient_created_idx
  on public.appointment_reminder_dispatches (patient_id, created_at desc);

create function public.set_appointment_reminder_dispatches_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;

revoke all on function
  public.set_appointment_reminder_dispatches_updated_at()
  from public, anon, authenticated;

create trigger appointment_reminder_dispatches_set_updated_at
before update on public.appointment_reminder_dispatches
for each row
execute function public.set_appointment_reminder_dispatches_updated_at();

alter table public.appointment_reminder_dispatches
  enable row level security;

-- This is a server-internal table. No RLS policies are intentionally created.
revoke all on public.appointment_reminder_dispatches
  from public, anon, authenticated;

create function public.process_due_appointment_reminders()
returns table (
  examined integer,
  claimed integer,
  notifications_created integer,
  skipped integer,
  failed integer
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := pg_catalog.now();
  v_candidate record;
  v_dispatch_id uuid;
  v_notification_id uuid;
begin
  examined := 0;
  claimed := 0;
  notifications_created := 0;
  skipped := 0;
  failed := 0;

  for v_candidate in
    with eligible_appointments as materialized (
      select
        appointment.id as schedule_id,
        appointment.patient_id,
        patient.user_id,
        appointment.start_time
      from public.schedule as appointment
      join public.patients as patient
        on patient.id = appointment.patient_id
      where appointment.id is not null
        and appointment.patient_id is not null
        and appointment.start_time is not null
        and appointment.start_time > v_now
        and appointment.start_time <= v_now + interval '24 hours'
        and pg_catalog.lower(
          pg_catalog.btrim(coalesce(appointment.status, ''))
        ) in ('scheduled', 'pending', 'accepted', 'rescheduled')
        and patient.user_id is not null
        and pg_catalog.lower(
          pg_catalog.btrim(coalesce(patient.account_status, ''))
        ) = 'active'
        and patient.archived_at is null
        and pg_catalog.lower(
          pg_catalog.btrim(coalesce(patient.status, ''))
        ) not in ('inactive', 'archived', 'deleted')
      for update of appointment skip locked
    ),
    due_reminders as (
      select
        eligible.schedule_id,
        eligible.patient_id,
        eligible.user_id,
        eligible.start_time,
        1440::integer as reminder_offset_minutes
      from eligible_appointments as eligible
      where eligible.start_time
              > v_now + interval '2 hours'
        and eligible.start_time
              <= v_now + interval '24 hours'

      union all

      select
        eligible.schedule_id,
        eligible.patient_id,
        eligible.user_id,
        eligible.start_time,
        120::integer as reminder_offset_minutes
      from eligible_appointments as eligible
      where eligible.start_time
              > v_now
        and eligible.start_time
              <= v_now + interval '2 hours'
    )
    select
      due.schedule_id,
      due.patient_id,
      due.user_id,
      due.start_time,
      due.reminder_offset_minutes
    from due_reminders as due
    order by
      due.start_time,
      due.reminder_offset_minutes desc,
      due.schedule_id
  loop
    examined := examined + 1;
    v_dispatch_id := null;

    begin
      insert into public.appointment_reminder_dispatches (
        schedule_id,
        patient_id,
        reminder_offset_minutes,
        appointment_start_time,
        status
      )
      values (
        v_candidate.schedule_id,
        v_candidate.patient_id,
        v_candidate.reminder_offset_minutes,
        v_candidate.start_time,
        'processing'
      )
      on conflict on constraint
        appointment_reminder_dispatches_schedule_offset_key
      do nothing
      returning id into v_dispatch_id;
    exception
      when others then
        failed := failed + 1;
        continue;
    end;

    if v_dispatch_id is null then
      skipped := skipped + 1;
      continue;
    end if;

    claimed := claimed + 1;

    begin
      insert into public.patient_notifications (
        patient_id,
        user_id,
        created_by,
        created_by_role,
        type,
        title,
        message,
        target_path,
        related_appointment_id,
        related_medical_record_id,
        related_reminder_id,
        priority
      )
      values (
        v_candidate.patient_id,
        v_candidate.user_id,
        null,
        null,
        'appointment_reminder',
        case v_candidate.reminder_offset_minutes
          when 1440 then 'Appointment Tomorrow'
          else 'Appointment Soon'
        end,
        case v_candidate.reminder_offset_minutes
          when 1440 then
            'You have a clinic appointment scheduled within the next 24 hours.'
          else
            'You have a clinic appointment scheduled within the next 2 hours.'
        end,
        '/patient/appointments',
        v_candidate.schedule_id,
        null,
        null,
        'important'
      )
      returning id into v_notification_id;

      update public.appointment_reminder_dispatches as dispatch
      set
        status = 'created',
        notification_id = v_notification_id,
        notification_created_at = pg_catalog.now(),
        error_code = null
      where dispatch.id = v_dispatch_id;

      notifications_created := notifications_created + 1;
    exception
      when others then
        update public.appointment_reminder_dispatches as dispatch
        set
          status = 'failed',
          notification_id = null,
          notification_created_at = null,
          error_code = 'notification_insert_failed'
        where dispatch.id = v_dispatch_id;

        failed := failed + 1;
    end;
  end loop;

  return next;
  return;
end;
$function$;

comment on function public.process_due_appointment_reminders() is
  'Claims and creates privacy-safe 24-hour and 2-hour Patient appointment reminders. Intended for Supabase Cron.';

revoke all on function public.process_due_appointment_reminders()
  from public, anon, authenticated;

commit;

-- ============================================================
-- POST-FLIGHT VERIFICATION QUERIES
-- Run these separately after manually applying the transaction.
-- ============================================================

-- Confirm table presence.
-- select pg_catalog.to_regclass(
--   'public.appointment_reminder_dispatches'
-- ) as ledger_table;

-- Confirm RLS is enabled.
-- select
--   namespace.nspname as table_schema,
--   relation.relname as table_name,
--   relation.relrowsecurity as rls_enabled
-- from pg_catalog.pg_class as relation
-- join pg_catalog.pg_namespace as namespace
--   on namespace.oid = relation.relnamespace
-- where namespace.nspname = 'public'
--   and relation.relname = 'appointment_reminder_dispatches';

-- Confirm no RLS policies exist (expected policy_count: 0).
-- select count(*) as policy_count
-- from pg_catalog.pg_policies
-- where schemaname = 'public'
--   and tablename = 'appointment_reminder_dispatches';

-- Confirm function presence.
-- select
--   namespace.nspname as function_schema,
--   procedure.proname as function_name,
--   pg_catalog.pg_get_function_result(procedure.oid) as result_type,
--   procedure.prosecdef as security_definer
-- from pg_catalog.pg_proc as procedure
-- join pg_catalog.pg_namespace as namespace
--   on namespace.oid = procedure.pronamespace
-- where namespace.nspname = 'public'
--   and procedure.proname = 'process_due_appointment_reminders';

-- Confirm public, anon, and authenticated have no function privileges
-- (expected: no rows).
-- select
--   privilege.grantee,
--   privilege.privilege_type
-- from information_schema.routine_privileges as privilege
-- where privilege.specific_schema = 'public'
--   and privilege.routine_name = 'process_due_appointment_reminders'
--   and privilege.grantee in ('PUBLIC', 'anon', 'authenticated');

-- Confirm the unique appointment/offset constraint.
-- select
--   constraint_row.conname as constraint_name,
--   pg_catalog.pg_get_constraintdef(constraint_row.oid) as definition
-- from pg_catalog.pg_constraint as constraint_row
-- where constraint_row.conrelid =
--       'public.appointment_reminder_dispatches'::pg_catalog.regclass
--   and constraint_row.contype = 'u';

-- Review recent dispatches without Patient names or clinical content.
-- select
--   dispatch.id,
--   dispatch.schedule_id,
--   dispatch.patient_id,
--   dispatch.notification_id,
--   dispatch.reminder_offset_minutes,
--   dispatch.appointment_start_time,
--   dispatch.status,
--   dispatch.error_code,
--   dispatch.claimed_at,
--   dispatch.notification_created_at
-- from public.appointment_reminder_dispatches as dispatch
-- order by dispatch.created_at desc
-- limit 100;

-- Confirm successful dispatches link to the expected notification contract.
-- select
--   dispatch.id as dispatch_id,
--   dispatch.reminder_offset_minutes,
--   notification.id as notification_id,
--   notification.type,
--   notification.target_path,
--   notification.priority,
--   notification.related_appointment_id,
--   notification.created_at
-- from public.appointment_reminder_dispatches as dispatch
-- join public.patient_notifications as notification
--   on notification.id = dispatch.notification_id
-- order by notification.created_at desc
-- limit 100;

-- Duplicate check (expected: no rows).
-- select
--   schedule_id,
--   reminder_offset_minutes,
--   count(*)
-- from public.appointment_reminder_dispatches
-- group by schedule_id, reminder_offset_minutes
-- having count(*) > 1;

-- Manual administrator-only invocation. Do not run until a reviewed test
-- appointment and existing webhook delivery path are ready.
-- select * from public.process_due_appointment_reminders();
