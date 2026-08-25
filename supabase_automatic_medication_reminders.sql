-- ============================================================
-- Maternal Care - Automatic medication reminders (Phase 4B)
-- ============================================================
-- Review and run this file manually in the Supabase SQL Editor.
-- This file does not execute Cron setup, does not create a Database Webhook,
-- and does not call the send-patient-web-push Edge Function directly.
--
-- Existing flow after this setup:
--   Supabase Cron
--   -> public.process_due_medication_reminders()
--   -> public.medication_reminder_occurrences
--   -> public.patient_notifications INSERT
--   -> existing Database Webhook
--   -> existing send-patient-web-push Edge Function
--
-- Reviewed application contracts:
--   public.medication_reminders.id, patient_id: uuid
--   public.medication_reminders.reminder_times: time without time zone[]
--   public.medication_reminders.start_date, end_date: date
--   public.medication_reminders.status: text
--   public.patients.id, user_id: uuid
--   public.patient_notifications.id: uuid
--   public.patient_notifications.related_reminder_id currently references
--     public.reminders(id), so medication reminder notifications keep that
--     column null unless the relationship is later reviewed and changed.
-- ============================================================

-- ============================================================
-- READ-ONLY PRE-FLIGHT QUERIES
-- Run these separately before applying the transaction.
-- ============================================================

-- Confirm medication_reminders column types.
-- select
--   column_name,
--   data_type,
--   udt_schema,
--   udt_name,
--   is_nullable,
--   column_default
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name = 'medication_reminders'
--   and column_name in (
--     'id',
--     'patient_id',
--     'medication_name',
--     'dosage',
--     'frequency',
--     'duration',
--     'reminder_times',
--     'instructions',
--     'start_date',
--     'end_date',
--     'status',
--     'created_by',
--     'created_at',
--     'updated_at'
--   )
-- order by ordinal_position;

-- Confirm medication reminder primary-key type.
-- select
--   constraint_row.conname as constraint_name,
--   pg_catalog.pg_get_constraintdef(constraint_row.oid) as definition
-- from pg_catalog.pg_constraint as constraint_row
-- where constraint_row.conrelid = 'public.medication_reminders'::pg_catalog.regclass
--   and constraint_row.contype = 'p';

-- Review medication reminder status distribution.
-- select
--   lower(trim(coalesce(status, ''))) as normalized_status,
--   count(*)
-- from public.medication_reminders
-- group by lower(trim(coalesce(status, '')))
-- order by normalized_status;

-- Review recurrence/frequency value distribution.
-- select
--   lower(trim(coalesce(frequency, ''))) as normalized_frequency,
--   count(*)
-- from public.medication_reminders
-- group by lower(trim(coalesce(frequency, '')))
-- order by normalized_frequency;

-- Review active/inactive value distribution.
-- select
--   status,
--   count(*)
-- from public.medication_reminders
-- group by status
-- order by status;

-- Inspect schedule-time storage and format.
-- select
--   id,
--   pg_catalog.pg_typeof(reminder_times) as reminder_times_type,
--   reminder_times,
--   start_date,
--   end_date,
--   frequency,
--   status
-- from public.medication_reminders
-- order by created_at desc nulls last
-- limit 50;

-- Confirm Patient linkage and lifecycle columns.
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
--     'status',
--     'account_status',
--     'archived_at'
--   )
-- order by ordinal_position;

-- Confirm patient_notifications relationship types.
-- select
--   column_name,
--   data_type,
--   udt_schema,
--   udt_name,
--   is_nullable
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name = 'patient_notifications'
--   and column_name in (
--     'id',
--     'patient_id',
--     'user_id',
--     'type',
--     'target_path',
--     'priority',
--     'related_reminder_id',
--     'related_appointment_id',
--     'related_medical_record_id'
--   )
-- order by ordinal_position;

-- Confirm related_reminder_id foreign-key target.
-- select
--   constraint_row.conname as constraint_name,
--   pg_catalog.pg_get_constraintdef(constraint_row.oid) as definition
-- from pg_catalog.pg_constraint as constraint_row
-- where constraint_row.conrelid = 'public.patient_notifications'::pg_catalog.regclass
--   and constraint_row.contype = 'f'
--   and pg_catalog.pg_get_constraintdef(constraint_row.oid) ilike '%related_reminder_id%';

-- Check for an existing occurrence-table conflict.
-- select pg_catalog.to_regclass(
--   'public.medication_reminder_occurrences'
-- ) as existing_occurrence_table;

-- Check for an existing processor-function conflict.
-- select
--   namespace.nspname as function_schema,
--   procedure.proname as function_name,
--   pg_catalog.pg_get_function_identity_arguments(procedure.oid) as arguments,
--   pg_catalog.pg_get_function_result(procedure.oid) as result_type
-- from pg_catalog.pg_proc as procedure
-- join pg_catalog.pg_namespace as namespace
--   on namespace.oid = procedure.pronamespace
-- where namespace.nspname = 'public'
--   and procedure.proname = 'process_due_medication_reminders';

-- Check for an existing Patient-action RPC conflict.
-- select
--   namespace.nspname as function_schema,
--   procedure.proname as function_name,
--   pg_catalog.pg_get_function_identity_arguments(procedure.oid) as arguments,
--   pg_catalog.pg_get_function_result(procedure.oid) as result_type
-- from pg_catalog.pg_proc as procedure
-- join pg_catalog.pg_namespace as namespace
--   on namespace.oid = procedure.pronamespace
-- where namespace.nspname = 'public'
--   and procedure.proname = 'mark_medication_reminder_occurrence';

-- Confirm existing Cron jobs without changing them.
-- select
--   job.jobid,
--   job.jobname,
--   job.schedule,
--   job.command,
--   job.active
-- from cron.job as job
-- where job.jobname in (
--   'process-due-appointment-reminders',
--   'process-due-medication-reminders'
-- );

-- Review existing medication_reminders and patient_notifications RLS policies.
-- select
--   schemaname,
--   tablename,
--   policyname,
--   cmd,
--   roles,
--   qual,
--   with_check
-- from pg_catalog.pg_policies
-- where schemaname = 'public'
--   and tablename in (
--     'medication_reminders',
--     'patient_notifications',
--     'medication_reminder_occurrences'
--   )
-- order by tablename, policyname;

-- Confirm whether the occurrence table is already in Realtime.
-- select
--   pubname,
--   schemaname,
--   tablename
-- from pg_catalog.pg_publication_tables
-- where pubname = 'supabase_realtime'
--   and schemaname = 'public'
--   and tablename = 'medication_reminder_occurrences';

begin;

create table public.medication_reminder_occurrences (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  medication_reminder_id uuid not null,
  patient_id uuid not null,
  scheduled_for timestamptz not null,
  status text not null default 'processing',
  notification_id uuid,
  claimed_at timestamptz not null default pg_catalog.now(),
  notified_at timestamptz,
  action_at timestamptz,
  missed_at timestamptz,
  error_code text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint medication_reminder_occurrences_reminder_id_fkey
    foreign key (medication_reminder_id)
    references public.medication_reminders(id)
    on delete restrict,
  constraint medication_reminder_occurrences_patient_id_fkey
    foreign key (patient_id)
    references public.patients(id)
    on delete cascade,
  constraint medication_reminder_occurrences_notification_id_fkey
    foreign key (notification_id)
    references public.patient_notifications(id)
    on delete set null,
  constraint medication_reminder_occurrences_status_check
    check (
      status in (
        'processing',
        'notified',
        'taken',
        'skipped',
        'missed',
        'failed'
      )
    ),
  constraint medication_reminder_occurrences_error_code_check
    check (
      error_code is null
      or (
        error_code = pg_catalog.btrim(error_code)
        and pg_catalog.char_length(error_code) between 1 and 80
      )
    ),
  constraint medication_reminder_occurrences_reminder_scheduled_key
    unique (medication_reminder_id, scheduled_for)
);

comment on table public.medication_reminder_occurrences is
  'Server-controlled idempotency and Patient adherence ledger for automatic medication reminders.';
comment on column public.medication_reminder_occurrences.medication_reminder_id is
  'The source public.medication_reminders row. Historical occurrences remain when future reminder settings are edited.';
comment on column public.medication_reminder_occurrences.scheduled_for is
  'Concrete clinic-local medication date/time stored as timestamptz.';
comment on column public.medication_reminder_occurrences.error_code is
  'Short privacy-safe processing code. Raw SQL or clinical information is never stored.';

create index medication_reminder_occurrences_patient_scheduled_idx
  on public.medication_reminder_occurrences (patient_id, scheduled_for desc);

create index medication_reminder_occurrences_status_scheduled_idx
  on public.medication_reminder_occurrences (status, scheduled_for);

create index medication_reminder_occurrences_notification_idx
  on public.medication_reminder_occurrences (notification_id)
  where notification_id is not null;

create function public.set_medication_reminder_occurrences_updated_at()
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
  public.set_medication_reminder_occurrences_updated_at()
  from public, anon, authenticated;

create trigger medication_reminder_occurrences_set_updated_at
before update on public.medication_reminder_occurrences
for each row
execute function public.set_medication_reminder_occurrences_updated_at();

alter table public.medication_reminder_occurrences
  enable row level security;

revoke all on public.medication_reminder_occurrences
  from public, anon, authenticated;
grant select on public.medication_reminder_occurrences
  to authenticated;

create policy "Patients can read own medication reminder occurrences"
on public.medication_reminder_occurrences
for select
to authenticated
using (
  exists (
    select 1
    from public.patients as patient
    where patient.id = medication_reminder_occurrences.patient_id
      and patient.user_id = auth.uid()
      and pg_catalog.lower(
        pg_catalog.btrim(
          coalesce(patient.account_status, ''::text)
        )
      ) = 'active'
      and patient.archived_at is null
      and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.status, '')))
          not in ('inactive', 'archived', 'deleted')
  )
);

create function public.process_due_medication_reminders()
returns table (
  examined integer,
  claimed integer,
  notifications_created integer,
  missed_marked integer,
  skipped integer,
  failed integer
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := pg_catalog.now();
  v_clinic_timezone text := 'Asia/Manila';
  v_candidate record;
  v_occurrence_id uuid;
  v_notification_id uuid;
begin
  examined := 0;
  claimed := 0;
  notifications_created := 0;
  missed_marked := 0;
  skipped := 0;
  failed := 0;

  update public.medication_reminder_occurrences as occurrence
  set
    status = 'missed',
    missed_at = v_now,
    error_code = null
  where occurrence.status = 'notified'
    and occurrence.scheduled_for <= v_now - interval '2 hours'
    and occurrence.action_at is null;

  get diagnostics missed_marked = row_count;

  for v_candidate in
    with clinic_dates as (
      select generate_series(
        ((v_now - interval '15 minutes') at time zone v_clinic_timezone)::date,
        (v_now at time zone v_clinic_timezone)::date,
        interval '1 day'
      )::date as clinic_date
    ),
    due_candidates as (
      select
        medication.id as medication_reminder_id,
        medication.patient_id,
        patient.user_id,
        (
          clinic_dates.clinic_date
          + medication_time.time_value
        ) at time zone v_clinic_timezone as scheduled_for
      from public.medication_reminders as medication
      join public.patients as patient
        on patient.id = medication.patient_id
      cross join clinic_dates
      cross join lateral pg_catalog.unnest(medication.reminder_times) as medication_time(time_value)
      where medication.id is not null
        and medication.patient_id is not null
        and medication.reminder_times is not null
        and pg_catalog.cardinality(medication.reminder_times) > 0
        and pg_catalog.lower(pg_catalog.btrim(coalesce(medication.status, '')))
            = 'active'
        and medication.start_date is not null
        and clinic_dates.clinic_date >= medication.start_date
        and (
          medication.end_date is null
          or clinic_dates.clinic_date <= medication.end_date
        )
        and patient.user_id is not null
        and pg_catalog.lower(
          pg_catalog.btrim(
            coalesce(patient.account_status, ''::text)
          )
        ) = 'active'
        and patient.archived_at is null
        and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.status, '')))
            not in ('inactive', 'archived', 'deleted')
    )
    select
      due.medication_reminder_id,
      due.patient_id,
      due.user_id,
      due.scheduled_for
    from due_candidates as due
    where due.scheduled_for <= v_now
      and due.scheduled_for > v_now - interval '15 minutes'
    order by due.scheduled_for, due.medication_reminder_id
  loop
    examined := examined + 1;
    v_occurrence_id := null;
    v_notification_id := null;

    begin
      insert into public.medication_reminder_occurrences (
        medication_reminder_id,
        patient_id,
        scheduled_for,
        status
      )
      values (
        v_candidate.medication_reminder_id,
        v_candidate.patient_id,
        v_candidate.scheduled_for,
        'processing'
      )
      on conflict on constraint
        medication_reminder_occurrences_reminder_scheduled_key
      do nothing
      returning id into v_occurrence_id;
    exception
      when others then
        failed := failed + 1;
        continue;
    end;

    if v_occurrence_id is null then
      update public.medication_reminder_occurrences as occurrence
      set
        status = 'processing',
        claimed_at = v_now,
        notified_at = null,
        action_at = null,
        missed_at = null,
        error_code = null
      where occurrence.medication_reminder_id =
            v_candidate.medication_reminder_id
        and occurrence.scheduled_for = v_candidate.scheduled_for
        and occurrence.status = 'failed'
        and occurrence.notification_id is null
        and occurrence.scheduled_for <= v_now
        and occurrence.scheduled_for > v_now - interval '15 minutes'
      returning occurrence.id into v_occurrence_id;
    end if;

    if v_occurrence_id is null then
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
        'medication_reminder',
        'Medication Reminder',
        'It is time for a scheduled medication reminder.',
        '/patient/reminders',
        null,
        null,
        null,
        'important'
      )
      returning id into v_notification_id;

      update public.medication_reminder_occurrences as occurrence
      set
        status = 'notified',
        notification_id = v_notification_id,
        notified_at = v_now,
        error_code = null
      where occurrence.id = v_occurrence_id;

      notifications_created := notifications_created + 1;
    exception
      when others then
        update public.medication_reminder_occurrences as occurrence
        set
          status = 'failed',
          notification_id = null,
          notified_at = null,
          error_code = 'notification_insert_failed'
        where occurrence.id = v_occurrence_id;

        failed := failed + 1;
    end;
  end loop;

  return next;
  return;
end;
$function$;

comment on function public.process_due_medication_reminders() is
  'Claims due medication reminder occurrences, inserts privacy-safe Patient notifications, and marks unanswered notified occurrences missed after two hours. Intended for Supabase Cron.';

revoke all on function public.process_due_medication_reminders()
  from public, anon, authenticated;

create function public.mark_medication_reminder_occurrence(
  p_occurrence_id uuid,
  p_action text
)
returns table (
  success boolean,
  status text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_action, '')));
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;

  if v_action not in ('taken', 'skipped') then
    raise exception 'Unsupported medication reminder action.'
      using errcode = '22023';
  end if;

  update public.medication_reminder_occurrences as occurrence
  set
    status = v_action,
    action_at = pg_catalog.now(),
    missed_at = null,
    error_code = null
  where occurrence.id = p_occurrence_id
    and occurrence.status = 'notified'
    and exists (
      select 1
      from public.patients as patient
      where patient.id = occurrence.patient_id
        and patient.user_id = auth.uid()
        and pg_catalog.lower(
          pg_catalog.btrim(
            coalesce(patient.account_status, ''::text)
          )
        ) = 'active'
        and patient.archived_at is null
        and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.status, '')))
            not in ('inactive', 'archived', 'deleted')
    )
  returning occurrence.status into v_status;

  if v_status is null then
    raise exception 'Medication reminder occurrence is not available for this action.'
      using errcode = '42501';
  end if;

  success := true;
  status := v_status;
  return next;
  return;
end;
$function$;

comment on function public.mark_medication_reminder_occurrence(uuid, text) is
  'Allows an authenticated linked Patient to mark one notified medication occurrence as taken or skipped.';

revoke all on function public.mark_medication_reminder_occurrence(uuid, text)
  from public, anon;
grant execute on function public.mark_medication_reminder_occurrence(uuid, text)
  to authenticated;

-- Realtime is intentionally not modified here. The Patient UI refreshes the
-- occurrence query after RPC actions. If live occurrence updates are later
-- required, review this manually before running:
--
-- alter publication supabase_realtime
--   add table public.medication_reminder_occurrences;

notify pgrst, 'reload schema';

commit;

-- ============================================================
-- POST-FLIGHT VERIFICATION QUERIES
-- Run these separately after manually applying the transaction.
-- ============================================================

-- Confirm table presence.
-- select pg_catalog.to_regclass(
--   'public.medication_reminder_occurrences'
-- ) as occurrence_table;

-- Confirm RLS is enabled.
-- select
--   namespace.nspname as table_schema,
--   relation.relname as table_name,
--   relation.relrowsecurity as rls_enabled
-- from pg_catalog.pg_class as relation
-- join pg_catalog.pg_namespace as namespace
--   on namespace.oid = relation.relnamespace
-- where namespace.nspname = 'public'
--   and relation.relname = 'medication_reminder_occurrences';

-- Confirm Patient SELECT policy.
-- select
--   policyname,
--   cmd,
--   roles,
--   qual,
--   with_check
-- from pg_catalog.pg_policies
-- where schemaname = 'public'
--   and tablename = 'medication_reminder_occurrences'
--   and policyname = 'Patients can read own medication reminder occurrences';

-- Confirm absence of direct Patient write policies (expected: no rows).
-- select
--   policyname,
--   cmd,
--   roles
-- from pg_catalog.pg_policies
-- where schemaname = 'public'
--   and tablename = 'medication_reminder_occurrences'
--   and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');

-- Confirm direct write privileges are revoked (expected: no rows).
-- select
--   grantee,
--   privilege_type
-- from information_schema.role_table_grants
-- where table_schema = 'public'
--   and table_name = 'medication_reminder_occurrences'
--   and grantee in ('PUBLIC', 'anon', 'authenticated')
--   and privilege_type in ('INSERT', 'UPDATE', 'DELETE');

-- Confirm function presence.
-- select
--   namespace.nspname as function_schema,
--   procedure.proname as function_name,
--   pg_catalog.pg_get_function_identity_arguments(procedure.oid) as arguments,
--   pg_catalog.pg_get_function_result(procedure.oid) as result_type,
--   procedure.prosecdef as security_definer
-- from pg_catalog.pg_proc as procedure
-- join pg_catalog.pg_namespace as namespace
--   on namespace.oid = procedure.pronamespace
-- where namespace.nspname = 'public'
--   and procedure.proname in (
--     'process_due_medication_reminders',
--     'mark_medication_reminder_occurrence'
--   );

-- Confirm processor privileges (expected: no public/anon/authenticated rows).
-- select
--   privilege.grantee,
--   privilege.privilege_type
-- from information_schema.routine_privileges as privilege
-- where privilege.specific_schema = 'public'
--   and privilege.routine_name = 'process_due_medication_reminders'
--   and privilege.grantee in ('PUBLIC', 'anon', 'authenticated');

-- Confirm Patient RPC privileges.
-- select
--   privilege.grantee,
--   privilege.privilege_type
-- from information_schema.routine_privileges as privilege
-- where privilege.specific_schema = 'public'
--   and privilege.routine_name = 'mark_medication_reminder_occurrence'
-- order by privilege.grantee;

-- Confirm the unique occurrence constraint.
-- select
--   constraint_row.conname as constraint_name,
--   pg_catalog.pg_get_constraintdef(constraint_row.oid) as definition
-- from pg_catalog.pg_constraint as constraint_row
-- where constraint_row.conrelid =
--       'public.medication_reminder_occurrences'::pg_catalog.regclass
--   and constraint_row.contype = 'u';

-- Review recent occurrences without Patient names or clinical details.
-- select
--   id,
--   medication_reminder_id,
--   patient_id,
--   scheduled_for,
--   status,
--   notification_id,
--   claimed_at,
--   notified_at,
--   action_at,
--   missed_at,
--   error_code,
--   created_at,
--   updated_at
-- from public.medication_reminder_occurrences
-- order by created_at desc
-- limit 100;

-- Confirm successful occurrences link to privacy-safe notifications.
-- select
--   occurrence.id as occurrence_id,
--   occurrence.medication_reminder_id,
--   occurrence.scheduled_for,
--   occurrence.status,
--   notification.id as notification_id,
--   notification.type,
--   notification.title,
--   notification.message,
--   notification.target_path,
--   notification.priority,
--   notification.related_reminder_id,
--   notification.created_at
-- from public.medication_reminder_occurrences as occurrence
-- join public.patient_notifications as notification
--   on notification.id = occurrence.notification_id
-- order by notification.created_at desc
-- limit 100;

-- Duplicate check (expected: no rows).
-- select
--   medication_reminder_id,
--   scheduled_for,
--   count(*)
-- from public.medication_reminder_occurrences
-- group by medication_reminder_id, scheduled_for
-- having count(*) > 1;

-- Occurrence status distribution.
-- select
--   status,
--   count(*)
-- from public.medication_reminder_occurrences
-- group by status
-- order by status;

-- Failed occurrence inspection.
-- select
--   id,
--   medication_reminder_id,
--   patient_id,
--   scheduled_for,
--   status,
--   error_code,
--   claimed_at,
--   updated_at
-- from public.medication_reminder_occurrences
-- where status in ('failed', 'processing')
-- order by scheduled_for desc
-- limit 100;

-- Cron job and run history.
-- select
--   jobid,
--   jobname,
--   schedule,
--   command,
--   active
-- from cron.job
-- where jobname = 'process-due-medication-reminders';
--
-- select
--   runid,
--   jobid,
--   status,
--   return_message,
--   start_time,
--   end_time
-- from cron.job_run_details
-- where jobid = (
--   select jobid
--   from cron.job
--   where jobname = 'process-due-medication-reminders'
-- )
-- order by start_time desc
-- limit 100;

-- ============================================================
-- MANUAL TEST HELPERS - REVIEW BEFORE USE WITH TEST DATA ONLY
-- ============================================================

-- Manual administrator-only invocation after creating a reviewed test reminder.
-- select * from public.process_due_medication_reminders();

-- Test F missed-reminder setup approach:
-- In an isolated test database or with a confirmed test Patient only, create
-- a notified occurrence scheduled more than two hours in the past, or adjust
-- only that test occurrence's scheduled_for under administrator review. Then
-- run the processor and confirm only that unanswered test occurrence changes
-- to missed. Do not alter real Patient medication history.
