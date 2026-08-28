-- ============================================================
-- Maternal Care - Admin Follow-up Management (Phase 5C.2)
-- ============================================================
-- REVIEW ONLY. Do not execute until this file and the updated
-- supabase_admin_followup_oversight.sql have been reviewed together.
-- This migration creates no Cron job, webhook, publication, broad table
-- privilege, Patient notification, or Doctor Web Push invocation.
--
-- Read-only preflight:
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name in (
--     'profiles', 'medication_adherence_followups',
--     'medication_adherence_followup_events', 'doctor_notifications',
--     'medication_followup_alert_dispatches',
--     'medication_adherence_followup_assignment_audits'
--   )
-- order by table_name, ordinal_position;
--
-- select constraint_record.conname,
--        pg_catalog.pg_get_constraintdef(constraint_record.oid)
-- from pg_catalog.pg_constraint as constraint_record
-- where constraint_record.conrelid in (
--   'public.medication_adherence_followups'::pg_catalog.regclass,
--   'public.medication_adherence_followup_events'::pg_catalog.regclass,
--   'public.medication_followup_alert_dispatches'::pg_catalog.regclass,
--   pg_catalog.to_regclass('public.medication_adherence_followup_assignment_audits')
-- )
-- order by constraint_record.conrelid::pg_catalog.regclass::text,
--          constraint_record.conname;
--
-- select routine.oid::pg_catalog.regprocedure as signature,
--        pg_catalog.pg_get_function_result(routine.oid) as result_type,
--        routine.prosecdef, routine.proconfig,
--        pg_catalog.pg_get_userbyid(routine.proowner) as owner
-- from pg_catalog.pg_proc as routine
-- join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
-- where namespace.nspname = 'public'
--   and routine.proname in (
--     'add_medication_adherence_followup_event',
--     'process_due_medication_followup_alerts',
--     'get_admin_followup_oversight_summary',
--     'get_admin_followup_oversight_queue',
--     'get_admin_followup_oversight_detail'
--   )
-- order by routine.proname;
--
-- select policyname, tablename, cmd, roles, qual, with_check
-- from pg_catalog.pg_policies
-- where schemaname = 'public'
--   and tablename in (
--     'medication_adherence_followups',
--     'medication_adherence_followup_events',
--     'doctor_notifications',
--     'medication_adherence_followup_assignment_audits'
--   )
-- order by tablename, policyname;
-- ============================================================

begin;

alter table public.medication_adherence_followups
  add column if not exists assignment_revision bigint not null default 1;

alter table public.medication_adherence_followups
  drop constraint if exists medication_adherence_followups_assignment_revision_check;

alter table public.medication_adherence_followups
  add constraint medication_adherence_followups_assignment_revision_check
    check (assignment_revision >= 1);

alter table public.medication_followup_alert_dispatches
  add column if not exists assignment_revision_snapshot bigint not null default 1;

alter table public.medication_followup_alert_dispatches
  drop constraint if exists medication_followup_alert_dispatches_assignment_revision_check,
  drop constraint if exists medication_followup_alert_dispatches_cycle_key;

alter table public.medication_followup_alert_dispatches
  add constraint medication_followup_alert_dispatches_assignment_revision_check
    check (assignment_revision_snapshot >= 1),
  add constraint medication_followup_alert_dispatches_cycle_key
    unique (
      followup_id,
      assigned_doctor_id,
      assignment_revision_snapshot,
      next_follow_up_at_snapshot,
      alert_level
    );

alter table public.medication_adherence_followup_events
  add column if not exists previous_doctor_id uuid,
  add column if not exists new_doctor_id uuid;

alter table public.medication_adherence_followup_events
  drop constraint if exists medication_adherence_followup_events_previous_doctor_id_fkey,
  drop constraint if exists medication_adherence_followup_events_new_doctor_id_fkey,
  drop constraint if exists medication_adherence_followup_events_assignment_check;

alter table public.medication_adherence_followup_events
  add constraint medication_adherence_followup_events_previous_doctor_id_fkey
    foreign key (previous_doctor_id)
    references public.profiles(id)
    on delete restrict,
  add constraint medication_adherence_followup_events_new_doctor_id_fkey
    foreign key (new_doctor_id)
    references public.profiles(id)
    on delete restrict,
  add constraint medication_adherence_followup_events_assignment_check
    check (
      (
        event_type = 'doctor_reassigned'
        and previous_doctor_id is not null
        and new_doctor_id is not null
        and previous_doctor_id <> new_doctor_id
        and from_status is null
        and to_status is null
        and contact_method is null
        and note is null
        and resolution_summary is null
        and next_follow_up_at is null
        and related_notification_id is null
      )
      or
      (
        event_type <> 'doctor_reassigned'
        and previous_doctor_id is null
        and new_doctor_id is null
      )
    );

alter table public.medication_adherence_followup_events
  drop constraint if exists medication_adherence_followup_events_type_check;

alter table public.medication_adherence_followup_events
  add constraint medication_adherence_followup_events_type_check
  check (
    event_type in (
      'followup_started',
      'note_added',
      'contact_attempt',
      'patient_contacted',
      'notification_sent',
      'status_changed',
      'followup_scheduled',
      'resolved',
      'reopened',
      'attention_acknowledged',
      'attention_snoozed',
      'doctor_reassigned'
    )
  );

create table if not exists public.medication_adherence_followup_assignment_audits (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  followup_event_id uuid not null,
  followup_id uuid not null,
  previous_doctor_id uuid not null,
  new_doctor_id uuid not null,
  reassignment_reason text not null,
  created_by uuid not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint medication_followup_assignment_audits_event_key
    unique (followup_event_id),
  constraint medication_followup_assignment_audits_event_id_fkey
    foreign key (followup_event_id)
    references public.medication_adherence_followup_events(id)
    on delete restrict,
  constraint medication_followup_assignment_audits_followup_id_fkey
    foreign key (followup_id)
    references public.medication_adherence_followups(id)
    on delete restrict,
  constraint medication_followup_assignment_audits_previous_doctor_id_fkey
    foreign key (previous_doctor_id)
    references public.profiles(id)
    on delete restrict,
  constraint medication_followup_assignment_audits_new_doctor_id_fkey
    foreign key (new_doctor_id)
    references public.profiles(id)
    on delete restrict,
  constraint medication_followup_assignment_audits_created_by_fkey
    foreign key (created_by)
    references public.profiles(id)
    on delete restrict,
  constraint medication_followup_assignment_audits_doctors_check
    check (previous_doctor_id <> new_doctor_id),
  constraint medication_followup_assignment_audits_reason_check
    check (
      reassignment_reason = pg_catalog.btrim(reassignment_reason)
      and pg_catalog.char_length(reassignment_reason) between 5 and 500
    )
);

comment on table public.medication_adherence_followup_assignment_audits is
  'Private append-only Admin audit records for Doctor reassignment reasons. Browser roles have no direct access.';

alter table public.medication_adherence_followup_assignment_audits
  enable row level security;

revoke all on public.medication_adherence_followup_assignment_audits
  from public, anon, authenticated;

create or replace function public.admin_acknowledge_medication_followup_review(
  p_followup_id uuid
)
returns table (
  event_id uuid,
  followup_id uuid,
  actor_id uuid,
  acknowledged_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_account_status text;
  v_followup public.medication_adherence_followups;
  v_event public.medication_adherence_followup_events;
  v_now timestamptz := pg_catalog.now();
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select
    pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))),
    pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text)))
  into v_role, v_account_status
  from public.profiles as profile
  where profile.id = auth.uid();

  if v_role is distinct from 'admin' or v_account_status is distinct from 'active' then
    raise exception 'An active Admin account is required.' using errcode = '42501';
  end if;
  if p_followup_id is null then
    raise exception 'A follow-up identifier is required.' using errcode = '22023';
  end if;

  select followup.*
  into v_followup
  from public.medication_adherence_followups as followup
  where followup.id = p_followup_id
  for update;

  if not found then
    raise exception 'Medication adherence follow-up was not found.' using errcode = 'P0002';
  end if;
  if pg_catalog.lower(pg_catalog.btrim(coalesce(v_followup.status, ''::text)))
     not in ('open', 'contacted', 'monitoring') then
    raise exception 'Resolved follow-ups cannot be administratively acknowledged.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.medication_adherence_followup_events as recent_event
    where recent_event.followup_id = v_followup.id
      and recent_event.event_type = 'attention_acknowledged'
      and recent_event.created_by = auth.uid()
      and recent_event.created_at > v_now - interval '30 seconds'
  ) then
    raise exception 'This follow-up was just acknowledged. Review the refreshed timeline before acknowledging it again.'
      using errcode = '22023';
  end if;

  insert into public.medication_adherence_followup_events (
    followup_id,
    event_type,
    created_by,
    created_at
  )
  values (
    v_followup.id,
    'attention_acknowledged',
    auth.uid(),
    v_now
  )
  returning * into v_event;

  return query
  select v_event.id, v_event.followup_id, v_event.created_by, v_event.created_at;
end;
$function$;

comment on function public.admin_acknowledge_medication_followup_review(uuid) is
  'Appends an Admin review acknowledgement without changing clinical follow-up state, schedule, assignment, snooze, or notifications.';

create or replace function public.admin_reassign_medication_followup(
  p_followup_id uuid,
  p_new_doctor_id uuid,
  p_reason text,
  p_expected_updated_at timestamptz default null
)
returns table (
  followup_id uuid,
  event_id uuid,
  previous_doctor_id uuid,
  previous_doctor_name text,
  new_doctor_id uuid,
  new_doctor_name text,
  changed_by uuid,
  changed_at timestamptz,
  assignment_revision bigint,
  updated_at timestamptz,
  former_doctor_notifications_cleared integer
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_account_status text;
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, ''::text)), '');
  v_followup public.medication_adherence_followups;
  v_event public.medication_adherence_followup_events;
  v_new_doctor_role text;
  v_new_doctor_status text;
  v_previous_doctor_name text;
  v_new_doctor_name text;
  v_assignment_revision bigint;
  v_updated_at timestamptz;
  v_notifications_cleared integer := 0;
  v_now timestamptz := pg_catalog.now();
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select
    pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))),
    pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text)))
  into v_role, v_account_status
  from public.profiles as profile
  where profile.id = auth.uid();

  if v_role is distinct from 'admin' or v_account_status is distinct from 'active' then
    raise exception 'An active Admin account is required.' using errcode = '42501';
  end if;
  if p_followup_id is null or p_new_doctor_id is null then
    raise exception 'Follow-up and new Doctor identifiers are required.' using errcode = '22023';
  end if;
  if p_expected_updated_at is null then
    raise exception 'The current follow-up version is required. Refresh the case and retry.'
      using errcode = '22023';
  end if;
  if v_reason is null or pg_catalog.char_length(v_reason) not between 5 and 500 then
    raise exception 'Reassignment reason must contain between 5 and 500 characters.'
      using errcode = '22023';
  end if;

  select followup.*
  into v_followup
  from public.medication_adherence_followups as followup
  where followup.id = p_followup_id
  for update;

  if not found then
    raise exception 'Medication adherence follow-up was not found.' using errcode = 'P0002';
  end if;
  if pg_catalog.lower(pg_catalog.btrim(coalesce(v_followup.status, ''::text)))
     not in ('open', 'contacted', 'monitoring') then
    raise exception 'Resolved follow-ups cannot be reassigned.' using errcode = '22023';
  end if;
  if v_followup.assigned_doctor_id = p_new_doctor_id then
    raise exception 'Select a different active Doctor for reassignment.' using errcode = '22023';
  end if;
  if v_followup.updated_at is distinct from p_expected_updated_at then
    raise exception 'This follow-up changed after it was opened. Refresh the case before reassigning it.'
      using errcode = '40001';
  end if;

  select
    pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))),
    pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))),
    coalesce(nullif(pg_catalog.btrim(profile.full_name), ''), 'Doctor')
  into v_new_doctor_role, v_new_doctor_status, v_new_doctor_name
  from public.profiles as profile
  where profile.id = p_new_doctor_id
  for share;

  if not found
     or v_new_doctor_role is distinct from 'doctor'
     or v_new_doctor_status is distinct from 'active' then
    raise exception 'The selected account is not an active Doctor.' using errcode = '22023';
  end if;

  select coalesce(nullif(pg_catalog.btrim(profile.full_name), ''), 'Doctor')
  into v_previous_doctor_name
  from public.profiles as profile
  where profile.id = v_followup.assigned_doctor_id;

  update public.medication_adherence_followups as followup
  set
    assigned_doctor_id = p_new_doctor_id,
    assignment_revision = followup.assignment_revision + 1
  where followup.id = v_followup.id
  returning followup.assignment_revision, followup.updated_at
  into v_assignment_revision, v_updated_at;

  insert into public.medication_adherence_followup_events (
    followup_id,
    event_type,
    previous_doctor_id,
    new_doctor_id,
    created_by,
    created_at
  )
  values (
    v_followup.id,
    'doctor_reassigned',
    v_followup.assigned_doctor_id,
    p_new_doctor_id,
    auth.uid(),
    v_now
  )
  returning * into v_event;

  insert into public.medication_adherence_followup_assignment_audits (
    followup_event_id,
    followup_id,
    previous_doctor_id,
    new_doctor_id,
    reassignment_reason,
    created_by,
    created_at
  )
  values (
    v_event.id,
    v_followup.id,
    v_followup.assigned_doctor_id,
    p_new_doctor_id,
    v_reason,
    auth.uid(),
    v_event.created_at
  );

  update public.doctor_notifications as notification
  set read_at = coalesce(notification.read_at, v_now)
  where notification.followup_id = v_followup.id
    and notification.doctor_id = v_followup.assigned_doctor_id
    and notification.read_at is null;

  get diagnostics v_notifications_cleared = row_count;

  return query
  select
    v_followup.id,
    v_event.id,
    v_followup.assigned_doctor_id,
    coalesce(v_previous_doctor_name, 'Doctor'),
    p_new_doctor_id,
    v_new_doctor_name,
    auth.uid(),
    v_event.created_at,
    v_assignment_revision,
    v_updated_at,
    v_notifications_cleared;
end;
$function$;

comment on function public.admin_reassign_medication_followup(uuid, uuid, text, timestamptz) is
  'Atomically increments the assignment revision, reassigns an active follow-up, appends safe and private audit records, invalidates prior snooze state, and clears only the former Doctor''s stale unread alerts.';

-- Replace only the processor definition. Its signature, return type,
-- SECURITY DEFINER setting, grants, alert content, and schedule are unchanged.
-- The dispatch key gains assignment_revision_snapshot, and doctor_reassigned
-- remains the only new snooze invalidator.
create or replace function public.process_due_medication_followup_alerts()
returns table (
  examined integer,
  eligible integer,
  suppressed_by_snooze integer,
  claimed integer,
  notifications_created integer,
  duplicates_skipped integer,
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
  v_patient_name text;
  v_patient_label text;
  v_title text;
  v_message text;
  v_priority text;
  v_notification_type text;
  v_target_path text;
begin
  examined := 0;
  eligible := 0;
  suppressed_by_snooze := 0;
  claimed := 0;
  notifications_created := 0;
  duplicates_skipped := 0;
  failed := 0;

  for v_candidate in
    with active_cases as materialized (
      select
        followup.id as followup_id,
        followup.patient_id,
        followup.assigned_doctor_id,
        followup.assignment_revision,
        followup.next_follow_up_at,
        patient.patient_id as patient_display_id,
        patient.full_name as patient_full_name,
        patient.archived_at as patient_archived_at,
        patient.status as patient_status,
        latest_snooze.id as latest_snooze_id,
        latest_snooze.next_follow_up_at as snoozed_until,
        latest_snooze.created_at as snooze_created_at
      from public.medication_adherence_followups as followup
      join public.profiles as doctor on doctor.id = followup.assigned_doctor_id
      left join public.patients as patient on patient.id = followup.patient_id
      left join lateral (
        select event.id, event.next_follow_up_at, event.created_at
        from public.medication_adherence_followup_events as event
        where event.followup_id = followup.id
          and event.event_type = 'attention_snoozed'
        order by event.created_at desc, event.id desc
        limit 1
      ) as latest_snooze on true
      where pg_catalog.lower(pg_catalog.btrim(coalesce(followup.status, ''::text)))
          in ('open', 'contacted', 'monitoring')
        and followup.assigned_doctor_id is not null
        and followup.next_follow_up_at is not null
        and (
          followup.next_follow_up_at <= v_now
          or (followup.next_follow_up_at at time zone 'Asia/Manila')::date
            = (v_now at time zone 'Asia/Manila')::date
        )
        and pg_catalog.lower(pg_catalog.btrim(coalesce(doctor.role, ''::text))) = 'doctor'
        and pg_catalog.lower(pg_catalog.btrim(coalesce(doctor.account_status, ''::text))) = 'active'
      order by followup.next_follow_up_at, followup.id
      limit 200
      for update of followup skip locked
    ),
    classified_cases as (
      select
        active_case.*,
        case
          when active_case.next_follow_up_at > v_now
            and (active_case.next_follow_up_at at time zone 'Asia/Manila')::date
              = (v_now at time zone 'Asia/Manila')::date
            then 'due_today'
          when active_case.next_follow_up_at <= v_now
            and v_now - active_case.next_follow_up_at < interval '24 hours'
            then 'recently_overdue'
          when active_case.next_follow_up_at <= v_now
            and v_now - active_case.next_follow_up_at < interval '72 hours'
            then 'high'
          else 'critical'
        end as alert_level,
        (
          active_case.latest_snooze_id is not null
          and active_case.snoozed_until > v_now
          and not exists (
            select 1
            from public.medication_adherence_followup_events as invalidator
            where invalidator.followup_id = active_case.followup_id
              and (invalidator.created_at, invalidator.id)
                > (active_case.snooze_created_at, active_case.latest_snooze_id)
              and (
                invalidator.event_type in ('resolved', 'status_changed', 'doctor_reassigned')
                or (
                  invalidator.event_type in ('followup_scheduled', 'patient_contacted')
                  and invalidator.next_follow_up_at is not null
                )
              )
          )
        ) as is_snoozed
      from active_cases as active_case
    )
    select classified.*
    from classified_cases as classified
    order by classified.is_snoozed, classified.next_follow_up_at, classified.followup_id
    limit 200
  loop
    examined := examined + 1;

    if v_candidate.is_snoozed then
      suppressed_by_snooze := suppressed_by_snooze + 1;
      continue;
    end if;

    eligible := eligible + 1;
    v_dispatch_id := null;
    v_notification_id := null;

    begin
      insert into public.medication_followup_alert_dispatches (
        followup_id, assigned_doctor_id, assignment_revision_snapshot,
        next_follow_up_at_snapshot, alert_level, dispatch_status,
        attempt_count, error_message
      )
      values (
        v_candidate.followup_id, v_candidate.assigned_doctor_id,
        v_candidate.assignment_revision, v_candidate.next_follow_up_at,
        v_candidate.alert_level, 'processing', 1, null
      )
      on conflict on constraint medication_followup_alert_dispatches_cycle_key
      do update
      set
        dispatch_status = 'processing',
        attempt_count = medication_followup_alert_dispatches.attempt_count + 1,
        error_message = null,
        updated_at = pg_catalog.now()
      where medication_followup_alert_dispatches.dispatch_status = 'failed'
      returning id into v_dispatch_id;
    exception
      when others then
        failed := failed + 1;
        continue;
    end;

    if v_dispatch_id is null then
      duplicates_skipped := duplicates_skipped + 1;
      continue;
    end if;

    claimed := claimed + 1;
    v_patient_name := case
      when v_candidate.patient_archived_at is not null
        or pg_catalog.lower(pg_catalog.btrim(coalesce(v_candidate.patient_status, ''::text)))
          in ('archived', 'deleted') then 'Archived Patient'
      when nullif(pg_catalog.btrim(coalesce(v_candidate.patient_full_name, ''::text)), '')
        is null then 'Patient record unavailable'
      else pg_catalog.left(pg_catalog.btrim(v_candidate.patient_full_name), 120)
    end;
    v_patient_label := v_patient_name || case
      when nullif(pg_catalog.btrim(coalesce(v_candidate.patient_display_id, ''::text)), '')
        is null then ''
      else ' (' || pg_catalog.left(pg_catalog.btrim(v_candidate.patient_display_id), 50) || ')'
    end;
    v_notification_type := 'medication_followup_' || v_candidate.alert_level;
    v_priority := case
      when v_candidate.alert_level in ('high', 'critical') then 'urgent'
      else 'important'
    end;
    v_target_path := '/doctor/follow-ups?escalation=' || v_candidate.alert_level
      || '&followupId=' || v_candidate.followup_id::text;

    case v_candidate.alert_level
      when 'due_today' then
        v_title := 'Medication Follow-up Due Today';
        v_message := 'A medication-adherence follow-up for ' || v_patient_label
          || ' is scheduled today at '
          || pg_catalog.to_char(
            v_candidate.next_follow_up_at at time zone 'Asia/Manila',
            'FMHH12:MI AM'
          ) || '.';
      when 'recently_overdue' then
        v_title := 'Medication Follow-up Overdue';
        v_message := 'A medication-adherence follow-up for ' || v_patient_label
          || ' is overdue and requires review.';
      when 'high' then
        v_title := 'High Medication Follow-up Escalation';
        v_message := 'A medication-adherence follow-up for ' || v_patient_label
          || ' has been overdue for at least 24 hours.';
      else
        v_title := 'Critical Medication Follow-up Escalation';
        v_message := 'A medication-adherence follow-up for ' || v_patient_label
          || ' has been overdue for at least 72 hours and requires immediate review.';
    end case;

    begin
      insert into public.doctor_notifications (
        doctor_id, followup_id, patient_id, notification_type,
        title, message, priority, target_path
      )
      values (
        v_candidate.assigned_doctor_id, v_candidate.followup_id,
        v_candidate.patient_id, v_notification_type,
        v_title, v_message, v_priority, v_target_path
      )
      returning id into v_notification_id;

      update public.medication_followup_alert_dispatches as dispatch
      set notification_id = v_notification_id,
          dispatch_status = 'created',
          error_message = null
      where dispatch.id = v_dispatch_id;

      notifications_created := notifications_created + 1;
    exception
      when others then
        update public.medication_followup_alert_dispatches as dispatch
        set notification_id = null,
            dispatch_status = 'failed',
            error_message = 'Doctor notification creation failed.'
        where dispatch.id = v_dispatch_id;
        failed := failed + 1;
    end;
  end loop;

  return next;
  return;
end;
$function$;

comment on function public.process_due_medication_followup_alerts() is
  'Creates deduplicated, reassignment-aware, snooze-aware private Doctor follow-up alerts. It never writes Patient notifications, medication reminders, occurrences, follow-up status, or follow-up events.';

-- Reassert append-only/browser isolation without changing existing SELECT RLS.
revoke all on public.medication_adherence_followup_events
  from public, anon, authenticated;
grant select on public.medication_adherence_followup_events to authenticated;

revoke all on function public.admin_acknowledge_medication_followup_review(uuid)
  from public, anon, authenticated;
grant execute on function public.admin_acknowledge_medication_followup_review(uuid)
  to authenticated;

revoke all on function public.admin_reassign_medication_followup(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.admin_reassign_medication_followup(uuid, uuid, text, timestamptz)
  to authenticated;

revoke all on function public.process_due_medication_followup_alerts()
  from public, anon, authenticated;

select pg_catalog.pg_notify('pgrst', 'reload schema');

commit;

-- ============================================================
-- Commented verification (run manually only after installation)
-- ============================================================
-- 1. Apply this file first, then apply the reviewed
-- supabase_admin_followup_oversight.sql so all three Admin read RPCs compile
-- against the new assignment columns and use doctor_reassigned as an
-- unconditional snooze invalidator.
--
-- 2. Confirm revision, safe-event, private-audit columns, constraints,
-- function security, and grants. Existing follow-ups and dispatches are
-- backfilled to revision 1 by the NOT NULL DEFAULT 1 column additions.
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public'
--   and (
--     (table_name = 'medication_adherence_followups'
--       and column_name = 'assignment_revision')
--     or (table_name = 'medication_followup_alert_dispatches'
--       and column_name = 'assignment_revision_snapshot')
--     or (table_name = 'medication_adherence_followup_events'
--       and column_name in ('previous_doctor_id', 'new_doctor_id'))
--     or table_name = 'medication_adherence_followup_assignment_audits'
--   )
-- order by table_name, ordinal_position;
--
-- select routine.oid::pg_catalog.regprocedure, routine.prosecdef,
--        routine.proconfig, pg_catalog.pg_get_userbyid(routine.proowner)
-- from pg_catalog.pg_proc as routine
-- where routine.oid in (
--   'public.admin_acknowledge_medication_followup_review(uuid)'::pg_catalog.regprocedure,
--   'public.admin_reassign_medication_followup(uuid,uuid,text,timestamptz)'::pg_catalog.regprocedure,
--   'public.process_due_medication_followup_alerts()'::pg_catalog.regprocedure
-- );
--
-- select relation.relrowsecurity
-- from pg_catalog.pg_class as relation
-- where relation.oid =
--   'public.medication_adherence_followup_assignment_audits'::pg_catalog.regclass;
--
-- select grantee, privilege_type
-- from information_schema.role_table_grants
-- where table_schema = 'public'
--   and table_name = 'medication_adherence_followup_assignment_audits'
--   and grantee in ('PUBLIC', 'anon', 'authenticated');
-- Expect no rows. No RLS policy is created for browser roles.
--
-- 3. As an active Admin with controlled test data, acknowledge an active case.
-- Confirm exactly one attention_acknowledged event, auth.uid() as created_by,
-- and no changes to status, assigned_doctor_id, or next_follow_up_at. A repeat
-- within 30 seconds must be rejected with 22023.
--
-- 4. Reassign an active case using its exact updated_at value. Confirm exactly
-- one doctor_reassigned event with previous/new Doctor IDs, Admin actor, server
-- timestamp, and no reason column. Confirm one linked private audit row contains
-- the trimmed reason. Confirm assignment_revision increments exactly once while
-- status, Patient, schedule, resolution, and every adherence snapshot column
-- are unchanged.
--
-- 5. Confirm resolved cases, same-Doctor selection, inactive/non-Doctor target
-- profiles, null IDs, short/long reasons, and stale updated_at are rejected.
-- The stale version must return SQLSTATE 40001.
--
-- 6. As Doctor, Staff, Patient, inactive Admin, and anon, confirm both Admin
-- RPCs return 42501. Confirm authenticated still has no direct INSERT, UPDATE,
-- or DELETE privilege on either follow-up table and no privilege of any kind on
-- medication_adherence_followup_assignment_audits.
--
-- 7. Confirm an active snooze followed by doctor_reassigned is invalidated in
-- the Doctor queue, Admin summary/queue/detail, and automatic processor while
-- resolved/status_changed and scheduled patient_contacted rules are unchanged.
--
-- 8. Confirm old Doctor notification rows remain present, all formerly unread
-- rows for this follow-up have read_at populated, and unrelated rows are
-- unchanged. Confirm no Patient notification is created.
--
-- 9. Confirm dispatch uniqueness is:
-- unique (followup_id, assigned_doctor_id, assignment_revision_snapshot,
--         next_follow_up_at_snapshot, alert_level).
-- With unchanged schedule and escalation, test Doctor A -> Doctor B -> Doctor A.
-- Each revision must create one fresh notification, while repeated processor
-- runs within the same revision must remain deduplicated. Historical successful
-- dispatch rows must remain unchanged.
--
-- 10. Confirm reassignment_reason exists only in the private audit table and is
-- absent from the generally selectable event table, Admin general timeline,
-- Doctor notifications, Patient notifications, and Web Push payloads.
--
-- Rollback guidance (manual and dependency-reviewed):
-- Dropping revision or private-audit data destroys operational history and is
-- intentionally not included. Disable the Admin UI first, preserve events and
-- audit rows, and replace the processor/read RPCs with their prior reviewed
-- definitions before removing the two Admin management functions.
