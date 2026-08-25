-- ============================================================
-- Maternal Care - Automatic Doctor medication follow-up alerts
-- ============================================================
-- REVIEW ONLY. Run manually only after preflight review and controlled testing.
-- This migration creates private Doctor in-app notifications. It does not
-- create Patient notifications, Web Push deliveries, medication reminders,
-- medication occurrences, follow-up events, or follow-up status changes.

-- ============================================================
-- COMMENTED PREFLIGHT QUERIES (READ ONLY)
-- ============================================================

-- Confirm required relations and detect naming conflicts.
-- select
--   pg_catalog.to_regclass('public.medication_adherence_followups') as followups,
--   pg_catalog.to_regclass('public.medication_adherence_followup_events') as events,
--   pg_catalog.to_regclass('public.profiles') as profiles,
--   pg_catalog.to_regclass('public.patients') as patients,
--   pg_catalog.to_regclass('public.doctor_notifications') as existing_doctor_notifications,
--   pg_catalog.to_regclass('public.medication_followup_alert_dispatches') as existing_dispatch_ledger;

-- Confirm required column types and lifecycle fields.
-- select table_name, column_name, data_type, udt_schema, udt_name, is_nullable
-- from information_schema.columns
-- where table_schema = 'public'
--   and (
--     (table_name = 'medication_adherence_followups' and column_name in (
--       'id', 'patient_id', 'assigned_doctor_id', 'status', 'next_follow_up_at'
--     ))
--     or (table_name = 'medication_adherence_followup_events' and column_name in (
--       'id', 'followup_id', 'event_type', 'next_follow_up_at', 'created_at'
--     ))
--     or (table_name = 'profiles' and column_name in (
--       'id', 'role', 'account_status', 'full_name'
--     ))
--     or (table_name = 'patients' and column_name in (
--       'id', 'patient_id', 'full_name', 'status', 'archived_at'
--     ))
--   )
-- order by table_name, ordinal_position;

-- Confirm active follow-up statuses and the current event allowlist.
-- select
--   pg_catalog.lower(pg_catalog.btrim(coalesce(status, ''::text))) as normalized_status,
--   pg_catalog.count(*)
-- from public.medication_adherence_followups
-- group by 1
-- order by 1;
--
-- select constraint_record.conname,
--        pg_catalog.pg_get_constraintdef(constraint_record.oid) as definition
-- from pg_catalog.pg_constraint as constraint_record
-- where constraint_record.conrelid =
--       'public.medication_adherence_followup_events'::pg_catalog.regclass
--   and constraint_record.contype = 'c';

-- Review existing RLS, grants, processor ownership, and pg_cron state.
-- select schemaname, tablename, policyname, roles, cmd, qual, with_check
-- from pg_catalog.pg_policies
-- where schemaname = 'public'
--   and tablename in (
--     'medication_adherence_followups',
--     'medication_adherence_followup_events'
--   )
-- order by tablename, policyname;
--
-- select privilege.grantee, privilege.table_name, privilege.privilege_type
-- from information_schema.role_table_grants as privilege
-- where privilege.table_schema = 'public'
--   and privilege.table_name in (
--     'medication_adherence_followups',
--     'medication_adherence_followup_events'
--   )
-- order by privilege.table_name, privilege.grantee, privilege.privilege_type;
--
-- select
--   namespace.nspname as function_schema,
--   procedure.proname,
--   pg_catalog.pg_get_userbyid(procedure.proowner) as owner,
--   procedure.prosecdef as security_definer,
--   procedure.proconfig as configuration
-- from pg_catalog.pg_proc as procedure
-- join pg_catalog.pg_namespace as namespace
--   on namespace.oid = procedure.pronamespace
-- where namespace.nspname = 'public'
--   and procedure.proname in (
--     'process_due_appointment_reminders',
--     'process_due_medication_reminders'
--   );
--
-- select extension.extname, extension.extversion
-- from pg_catalog.pg_extension as extension
-- where extension.extname = 'pg_cron';
--
-- select job.jobid, job.jobname, job.schedule, job.command, job.active
-- from cron.job as job
-- where job.jobname = 'process-medication-followup-alerts';

begin;

create table if not exists public.doctor_notifications (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  doctor_id uuid not null,
  followup_id uuid,
  patient_id uuid,
  notification_type text not null,
  title text not null,
  message text not null,
  priority text not null,
  target_path text not null,
  read_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint doctor_notifications_doctor_id_fkey
    foreign key (doctor_id)
    references public.profiles(id)
    on delete restrict,
  constraint doctor_notifications_followup_id_fkey
    foreign key (followup_id)
    references public.medication_adherence_followups(id)
    on delete set null,
  constraint doctor_notifications_patient_id_fkey
    foreign key (patient_id)
    references public.patients(id)
    on delete set null,
  constraint doctor_notifications_type_check
    check (
      notification_type in (
        'medication_followup_due_today',
        'medication_followup_recently_overdue',
        'medication_followup_high',
        'medication_followup_critical'
      )
    ),
  constraint doctor_notifications_priority_check
    check (priority in ('important', 'urgent')),
  constraint doctor_notifications_title_check
    check (
      pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 120
      and title = pg_catalog.btrim(title)
    ),
  constraint doctor_notifications_message_check
    check (
      pg_catalog.char_length(pg_catalog.btrim(message)) between 1 and 500
      and message = pg_catalog.btrim(message)
    ),
  constraint doctor_notifications_target_path_check
    check (
      pg_catalog.char_length(target_path) between 1 and 255
      and (
        target_path = '/doctor/follow-ups'
        or target_path ~ '^/doctor/follow-ups\?escalation=(due_today|recently_overdue|high|critical)&followupId=[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      )
    )
);

comment on table public.doctor_notifications is
  'Private Doctor operational inbox. Rows contain privacy-safe follow-up alert previews and never trigger Patient Web Push.';
comment on column public.doctor_notifications.message is
  'Privacy-safe operational preview without medication, dosage, contact, or follow-up-note content.';

create index if not exists doctor_notifications_doctor_created_idx
  on public.doctor_notifications (doctor_id, created_at desc);

create index if not exists doctor_notifications_doctor_unread_idx
  on public.doctor_notifications (doctor_id, created_at desc)
  where read_at is null;

create table if not exists public.medication_followup_alert_dispatches (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  followup_id uuid not null,
  assigned_doctor_id uuid not null,
  assignment_revision_snapshot bigint not null default 1,
  next_follow_up_at_snapshot timestamptz not null,
  alert_level text not null,
  notification_id uuid,
  dispatch_status text not null default 'processing',
  attempt_count integer not null default 1,
  error_message text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint medication_followup_alert_dispatches_followup_id_fkey
    foreign key (followup_id)
    references public.medication_adherence_followups(id)
    on delete restrict,
  constraint medication_followup_alert_dispatches_doctor_id_fkey
    foreign key (assigned_doctor_id)
    references public.profiles(id)
    on delete restrict,
  constraint medication_followup_alert_dispatches_notification_id_fkey
    foreign key (notification_id)
    references public.doctor_notifications(id)
    on delete set null,
  constraint medication_followup_alert_dispatches_level_check
    check (alert_level in ('due_today', 'recently_overdue', 'high', 'critical')),
  constraint medication_followup_alert_dispatches_status_check
    check (dispatch_status in ('processing', 'created', 'failed')),
  constraint medication_followup_alert_dispatches_attempt_count_check
    check (attempt_count >= 1),
  constraint medication_followup_alert_dispatches_assignment_revision_check
    check (assignment_revision_snapshot >= 1),
  constraint medication_followup_alert_dispatches_error_check
    check (
      error_message is null
      or error_message = 'Doctor notification creation failed.'
    ),
  constraint medication_followup_alert_dispatches_cycle_key
    unique (
      followup_id,
      assigned_doctor_id,
      assignment_revision_snapshot,
      next_follow_up_at_snapshot,
      alert_level
    )
);

comment on table public.medication_followup_alert_dispatches is
  'Concurrency-safe delivery ledger keyed by follow-up, assigned Doctor, assignment revision, schedule snapshot, and alert level.';

create index if not exists medication_followup_alert_dispatches_status_idx
  on public.medication_followup_alert_dispatches (dispatch_status, updated_at);

create index if not exists medication_followup_alert_dispatches_followup_idx
  on public.medication_followup_alert_dispatches (followup_id, created_at desc);

create index if not exists medication_followup_control_events_lookup_idx
  on public.medication_adherence_followup_events (
    followup_id,
    event_type,
    created_at desc
  );

create or replace function public.set_doctor_notification_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;

drop trigger if exists doctor_notifications_set_updated_at
  on public.doctor_notifications;
create trigger doctor_notifications_set_updated_at
before update on public.doctor_notifications
for each row
execute function public.set_doctor_notification_updated_at();

create or replace function public.set_medication_followup_alert_dispatch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;

drop trigger if exists medication_followup_alert_dispatches_set_updated_at
  on public.medication_followup_alert_dispatches;
create trigger medication_followup_alert_dispatches_set_updated_at
before update on public.medication_followup_alert_dispatches
for each row
execute function public.set_medication_followup_alert_dispatch_updated_at();

alter table public.doctor_notifications enable row level security;
alter table public.medication_followup_alert_dispatches enable row level security;

drop policy if exists "Doctors read own notifications and admins read all"
  on public.doctor_notifications;
create policy "Doctors read own notifications and admins read all"
on public.doctor_notifications
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(
        pg_catalog.btrim(coalesce(profile.account_status, ''::text))
      ) = 'active'
      and (
        (
          pg_catalog.lower(
            pg_catalog.btrim(coalesce(profile.role, ''::text))
          ) = 'doctor'
          and doctor_notifications.doctor_id = auth.uid()
        )
        or pg_catalog.lower(
          pg_catalog.btrim(coalesce(profile.role, ''::text))
        ) = 'admin'
      )
  )
);

-- No INSERT, UPDATE, or DELETE policies are created. Browser roles may only
-- read permitted rows and use ownership-verifying read-state RPCs.
revoke all on public.doctor_notifications from public, anon, authenticated;
grant select on public.doctor_notifications to authenticated;

-- The processor alone owns ledger writes; no browser policy or privilege is
-- created for this operational table.
revoke all on public.medication_followup_alert_dispatches
  from public, anon, authenticated;

create or replace function public.get_doctor_notifications(
  p_limit integer default 50
)
returns table (
  id uuid,
  doctor_id uuid,
  followup_id uuid,
  patient_id uuid,
  notification_type text,
  title text,
  message text,
  priority text,
  target_path text,
  read_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  unread_count bigint
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_limit integer := least(
    50,
    greatest(1, coalesce(p_limit, 50))
  );
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text)))
  into v_role
  from public.profiles as profile
  where profile.id = auth.uid()
    and pg_catalog.lower(
      pg_catalog.btrim(coalesce(profile.account_status, ''::text))
    ) = 'active';

  if v_role is distinct from 'doctor' then
    raise exception 'Only an active Doctor can read Doctor notifications.'
      using errcode = '42501';
  end if;

  return query
  with unread_summary as (
    select pg_catalog.count(*) as unread_count
    from public.doctor_notifications as notification
    where notification.doctor_id = auth.uid()
      and notification.read_at is null
  ),
  latest_notifications as materialized (
    select
      notification.id,
      notification.doctor_id,
      notification.followup_id,
      notification.patient_id,
      notification.notification_type,
      notification.title,
      notification.message,
      notification.priority,
      notification.target_path,
      notification.read_at,
      notification.created_at,
      notification.updated_at
    from public.doctor_notifications as notification
    where notification.doctor_id = auth.uid()
    order by notification.created_at desc, notification.id desc
    limit v_limit
  )
  select latest.*, unread.unread_count
  from latest_notifications as latest
  cross join unread_summary as unread
  order by latest.created_at desc, latest.id desc;
end;
$function$;

create or replace function public.mark_doctor_notification_read(
  p_notification_id uuid
)
returns public.doctor_notifications
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_notification public.doctor_notifications;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text)))
  into v_role
  from public.profiles as profile
  where profile.id = auth.uid()
    and pg_catalog.lower(
      pg_catalog.btrim(coalesce(profile.account_status, ''::text))
    ) = 'active';

  if v_role is distinct from 'doctor' then
    raise exception 'Only an active Doctor can update Doctor notifications.'
      using errcode = '42501';
  end if;

  update public.doctor_notifications as notification
  set read_at = coalesce(notification.read_at, pg_catalog.now())
  where notification.id = p_notification_id
    and notification.doctor_id = auth.uid()
  returning notification.* into v_notification;

  if not found then
    raise exception 'Doctor notification was not found or is not available to this account.'
      using errcode = '42501';
  end if;

  return v_notification;
end;
$function$;

create or replace function public.mark_all_doctor_notifications_read()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_updated integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text)))
  into v_role
  from public.profiles as profile
  where profile.id = auth.uid()
    and pg_catalog.lower(
      pg_catalog.btrim(coalesce(profile.account_status, ''::text))
    ) = 'active';

  if v_role is distinct from 'doctor' then
    raise exception 'Only an active Doctor can update Doctor notifications.'
      using errcode = '42501';
  end if;

  update public.doctor_notifications as notification
  set read_at = pg_catalog.now()
  where notification.doctor_id = auth.uid()
    and notification.read_at is null;

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$function$;

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
      join public.profiles as doctor
        on doctor.id = followup.assigned_doctor_id
      left join public.patients as patient
        on patient.id = followup.patient_id
      left join lateral (
        select event.id, event.next_follow_up_at, event.created_at
        from public.medication_adherence_followup_events as event
        where event.followup_id = followup.id
          and event.event_type = 'attention_snoozed'
        order by event.created_at desc, event.id desc
        limit 1
      ) as latest_snooze on true
      where pg_catalog.lower(
        pg_catalog.btrim(coalesce(followup.status, ''::text))
      ) in ('open', 'contacted', 'monitoring')
        and followup.assigned_doctor_id is not null
        and followup.next_follow_up_at is not null
        and (
          followup.next_follow_up_at <= v_now
          or (
            followup.next_follow_up_at at time zone 'Asia/Manila'
          )::date = (v_now at time zone 'Asia/Manila')::date
        )
        and pg_catalog.lower(
          pg_catalog.btrim(coalesce(doctor.role, ''::text))
        ) = 'doctor'
        and pg_catalog.lower(
          pg_catalog.btrim(coalesce(doctor.account_status, ''::text))
        ) = 'active'
      order by followup.next_follow_up_at, followup.id
      limit 200
      for update of followup skip locked
    ),
    classified_cases as (
      select
        active_case.*,
        case
          when active_case.next_follow_up_at > v_now
            and (
              active_case.next_follow_up_at at time zone 'Asia/Manila'
            )::date = (v_now at time zone 'Asia/Manila')::date
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
              and (
                invalidator.created_at,
                invalidator.id
              ) > (
                active_case.snooze_created_at,
                active_case.latest_snooze_id
              )
              and (
                invalidator.event_type in ('resolved', 'status_changed', 'doctor_reassigned')
                or (
                  invalidator.event_type in (
                    'followup_scheduled',
                    'patient_contacted'
                  )
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
        followup_id,
        assigned_doctor_id,
        assignment_revision_snapshot,
        next_follow_up_at_snapshot,
        alert_level,
        dispatch_status,
        attempt_count,
        error_message
      )
      values (
        v_candidate.followup_id,
        v_candidate.assigned_doctor_id,
        v_candidate.assignment_revision,
        v_candidate.next_follow_up_at,
        v_candidate.alert_level,
        'processing',
        1,
        null
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
        or pg_catalog.lower(
          pg_catalog.btrim(coalesce(v_candidate.patient_status, ''::text))
        ) in ('archived', 'deleted')
        then 'Archived Patient'
      when nullif(
        pg_catalog.btrim(coalesce(v_candidate.patient_full_name, ''::text)),
        ''
      ) is null
        then 'Patient record unavailable'
      else pg_catalog.left(pg_catalog.btrim(v_candidate.patient_full_name), 120)
    end;

    v_patient_label := v_patient_name || case
      when nullif(
        pg_catalog.btrim(coalesce(v_candidate.patient_display_id, ''::text)),
        ''
      ) is null
        then ''
      else ' (' || pg_catalog.left(
        pg_catalog.btrim(v_candidate.patient_display_id),
        50
      ) || ')'
    end;

    v_notification_type := 'medication_followup_' || v_candidate.alert_level;
    v_priority := case
      when v_candidate.alert_level in ('high', 'critical') then 'urgent'
      else 'important'
    end;
    v_target_path := '/doctor/follow-ups?escalation=' ||
      v_candidate.alert_level || '&followupId=' ||
      v_candidate.followup_id::text;

    case v_candidate.alert_level
      when 'due_today' then
        v_title := 'Medication Follow-up Due Today';
        v_message := 'A medication-adherence follow-up for ' ||
          v_patient_label || ' is scheduled today at ' ||
          pg_catalog.to_char(
            v_candidate.next_follow_up_at at time zone 'Asia/Manila',
            'FMHH12:MI AM'
          ) || '.';
      when 'recently_overdue' then
        v_title := 'Medication Follow-up Overdue';
        v_message := 'A medication-adherence follow-up for ' ||
          v_patient_label || ' is overdue and requires review.';
      when 'high' then
        v_title := 'High Medication Follow-up Escalation';
        v_message := 'A medication-adherence follow-up for ' ||
          v_patient_label || ' has been overdue for at least 24 hours.';
      else
        v_title := 'Critical Medication Follow-up Escalation';
        v_message := 'A medication-adherence follow-up for ' ||
          v_patient_label ||
          ' has been overdue for at least 72 hours and requires immediate review.';
    end case;

    begin
      insert into public.doctor_notifications (
        doctor_id,
        followup_id,
        patient_id,
        notification_type,
        title,
        message,
        priority,
        target_path
      )
      values (
        v_candidate.assigned_doctor_id,
        v_candidate.followup_id,
        v_candidate.patient_id,
        v_notification_type,
        v_title,
        v_message,
        v_priority,
        v_target_path
      )
      returning id into v_notification_id;

      update public.medication_followup_alert_dispatches as dispatch
      set
        notification_id = v_notification_id,
        dispatch_status = 'created',
        error_message = null
      where dispatch.id = v_dispatch_id;

      notifications_created := notifications_created + 1;
    exception
      when others then
        update public.medication_followup_alert_dispatches as dispatch
        set
          notification_id = null,
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
  'Creates deduplicated, snooze-aware private Doctor follow-up alerts. It never writes Patient notifications, medication reminders, occurrences, follow-up status, or follow-up events.';

revoke all on function public.get_doctor_notifications(integer)
  from public, anon, authenticated;
grant execute on function public.get_doctor_notifications(integer)
  to authenticated;

revoke all on function public.set_doctor_notification_updated_at()
  from public, anon, authenticated;

revoke all on function public.set_medication_followup_alert_dispatch_updated_at()
  from public, anon, authenticated;

revoke all on function public.mark_doctor_notification_read(uuid)
  from public, anon, authenticated;
grant execute on function public.mark_doctor_notification_read(uuid)
  to authenticated;

revoke all on function public.mark_all_doctor_notifications_read()
  from public, anon, authenticated;
grant execute on function public.mark_all_doctor_notifications_read()
  to authenticated;

revoke all on function public.process_due_medication_followup_alerts()
  from public, anon, authenticated;

-- Publish only the private Doctor notification table for authenticated,
-- row-filtered Realtime delivery. No Web Push table or webhook is changed.
do $realtime$
begin
  if not exists (
    select 1
    from pg_catalog.pg_publication as publication
    join pg_catalog.pg_publication_rel as publication_relation
      on publication_relation.prpubid = publication.oid
    where publication.pubname = 'supabase_realtime'
      and publication_relation.prrelid =
        'public.doctor_notifications'::pg_catalog.regclass
  ) then
    alter publication supabase_realtime
      add table public.doctor_notifications;
  end if;
end;
$realtime$;

-- Idempotently replace only the exact Phase 5B.4 Cron job.
do $cron$
declare
  v_job record;
begin
  for v_job in
    select job.jobid
    from cron.job as job
    where job.jobname = 'process-medication-followup-alerts'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;

  perform cron.schedule(
    'process-medication-followup-alerts',
    '*/5 * * * *',
    'select public.process_due_medication_followup_alerts();'
  );
end;
$cron$;

notify pgrst, 'reload schema';

commit;

-- ============================================================
-- COMMENTED VERIFICATION QUERIES (READ ONLY)
-- ============================================================

-- 1. Doctor notification RLS status.
-- select namespace.nspname, relation.relname, relation.relrowsecurity
-- from pg_catalog.pg_class as relation
-- join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
-- where namespace.nspname = 'public'
--   and relation.relname in ('doctor_notifications', 'medication_followup_alert_dispatches');

-- 2. Doctor notification policies. Expect the own-Doctor/Admin SELECT policy only.
-- select policyname, roles, cmd, qual, with_check
-- from pg_catalog.pg_policies
-- where schemaname = 'public' and tablename = 'doctor_notifications';

-- 3. Dispatch duplicate-prevention key.
-- select constraint_record.conname,
--        pg_catalog.pg_get_constraintdef(constraint_record.oid) as definition
-- from pg_catalog.pg_constraint as constraint_record
-- where constraint_record.conrelid =
--       'public.medication_followup_alert_dispatches'::pg_catalog.regclass
--   and constraint_record.conname = 'medication_followup_alert_dispatches_cycle_key';

-- 4-5. Processor signature, protected settings, owner, and grants.
-- select
--   procedure.oid::pg_catalog.regprocedure as signature,
--   pg_catalog.pg_get_function_result(procedure.oid) as result_type,
--   pg_catalog.pg_get_userbyid(procedure.proowner) as owner,
--   procedure.prosecdef as security_definer,
--   procedure.proconfig as configuration
-- from pg_catalog.pg_proc as procedure
-- where procedure.oid =
--   'public.process_due_medication_followup_alerts()'::pg_catalog.regprocedure;
--
-- select grantee, privilege_type
-- from information_schema.routine_privileges
-- where specific_schema = 'public'
--   and routine_name = 'process_due_medication_followup_alerts';

-- 6-7. Cron installation and recent executions.
-- select jobid, jobname, schedule, command, active
-- from cron.job
-- where jobname = 'process-medication-followup-alerts';
--
-- select runid, jobid, status, return_message, start_time, end_time
-- from cron.job_run_details
-- where jobid in (
--   select jobid from cron.job
--   where jobname = 'process-medication-followup-alerts'
-- )
-- order by start_time desc
-- limit 100;

-- 8. Notifications for one test Doctor. Replace the placeholder UUID.
-- select id, doctor_id, followup_id, patient_id, notification_type,
--        title, priority, target_path, read_at, created_at
-- from public.doctor_notifications
-- where doctor_id = '00000000-0000-0000-0000-000000000000'::uuid
-- order by created_at desc
-- limit 50;

-- 9-10. Dispatches and duplicate audit. The duplicate query must return no rows.
-- select followup_id, assigned_doctor_id, assignment_revision_snapshot,
--        next_follow_up_at_snapshot, alert_level, dispatch_status,
--        attempt_count, notification_id, created_at
-- from public.medication_followup_alert_dispatches
-- where followup_id = '00000000-0000-0000-0000-000000000000'::uuid
-- order by created_at;
--
-- select followup_id, assigned_doctor_id, assignment_revision_snapshot,
--        next_follow_up_at_snapshot, alert_level,
--        pg_catalog.count(*) as duplicate_count
-- from public.medication_followup_alert_dispatches
-- group by followup_id, assigned_doctor_id, assignment_revision_snapshot,
--          next_follow_up_at_snapshot, alert_level
-- having pg_catalog.count(*) > 1;

-- 11-12. Static processor isolation. All four results must be zero.
-- select
--   pg_catalog.strpos(definition, 'insert into public.patient_notifications') as patient_notification_insert,
--   pg_catalog.strpos(definition, 'update public.medication_reminders') as medication_reminder_update,
--   pg_catalog.strpos(definition, 'update public.medication_reminder_occurrences') as occurrence_update,
--   pg_catalog.strpos(definition, 'update public.medication_adherence_followups') as followup_update
-- from (
--   select pg_catalog.lower(pg_catalog.pg_get_functiondef(
--     'public.process_due_medication_followup_alerts()'::pg_catalog.regprocedure
--   )) as definition
-- ) as processor;

-- 13-17. Review current control state and alert cycles without creating rows.
-- Replace the placeholder follow-up UUID with controlled test data.
-- select event_type, next_follow_up_at, created_at
-- from public.medication_adherence_followup_events
-- where followup_id = '00000000-0000-0000-0000-000000000000'::uuid
--   and event_type in (
--     'attention_acknowledged', 'attention_snoozed', 'followup_scheduled',
--     'status_changed', 'patient_contacted', 'resolved', 'doctor_reassigned'
--   )
-- order by created_at desc, id desc;
--
-- select followup.id, followup.status, followup.next_follow_up_at,
--        dispatch.alert_level, dispatch.next_follow_up_at_snapshot,
--        dispatch.dispatch_status
-- from public.medication_adherence_followups as followup
-- left join public.medication_followup_alert_dispatches as dispatch
--   on dispatch.followup_id = followup.id
-- where followup.id = '00000000-0000-0000-0000-000000000000'::uuid
-- order by dispatch.created_at;
-- Expected: an active future snooze has no dispatch for its suppressed run;
-- expiration permits only the then-current level; a changed schedule timestamp
-- creates a new cycle; resolved/inactive cases create no later dispatch;
-- acknowledgement events do not participate in suppression or uniqueness.
-- A newer status_changed event invalidates the snooze even when its
-- next_follow_up_at is null. A plain patient_contacted event without a new
-- next-follow-up schedule does not invalidate the snooze; patient_contacted
-- with a non-null next_follow_up_at does invalidate it.
-- A newer doctor_reassigned event always invalidates the snooze so the newly
-- assigned Doctor receives the current case without inherited suppression.
-- An A -> B -> A reassignment sequence with unchanged schedule/escalation must
-- create one alert for each assignment revision and remain deduplicated within
-- each revision. Historical successful dispatch rows must remain unchanged.

-- 18. Ownership isolation. Run as Doctor A using Doctor B's notification UUID;
-- SELECT returns no row and mark_doctor_notification_read raises 42501.
-- select * from public.doctor_notifications
-- where id = '00000000-0000-0000-0000-000000000000'::uuid;
-- select public.mark_doctor_notification_read(
--   '00000000-0000-0000-0000-000000000000'::uuid
-- );

-- ============================================================
-- OPTIONAL TEST-DATA CLEANUP (MUTATING; REVIEW AND TEST DATA ONLY)
-- ============================================================
-- Never run these against production records. Replace both placeholder UUIDs,
-- verify the selected rows first, and execute in one manually reviewed transaction.
-- begin;
-- delete from public.medication_followup_alert_dispatches
-- where followup_id = '00000000-0000-0000-0000-000000000000'::uuid
--   and assigned_doctor_id = '00000000-0000-0000-0000-000000000000'::uuid;
-- delete from public.doctor_notifications
-- where followup_id = '00000000-0000-0000-0000-000000000000'::uuid
--   and doctor_id = '00000000-0000-0000-0000-000000000000'::uuid;
-- rollback;

-- Remove only this Cron job if Phase 5B.4 must be rolled back manually:
-- select cron.unschedule(jobid)
-- from cron.job
-- where jobname = 'process-medication-followup-alerts';
