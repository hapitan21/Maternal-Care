-- ============================================================
-- Maternal Care - Admin Medication Follow-up Oversight (Phase 5C.1)
-- ============================================================
-- REVIEW ONLY. Run manually in the Supabase SQL Editor only after the
-- installed follow-up schema and Phase 5B.4 snooze rules are reviewed.
-- This file does not change follow-up data, RLS policies, Cron, Realtime,
-- notifications, Web Push, webhooks, medication reminders, or occurrences.
--
-- Read-only preflight queries:
--
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name in (
--     'profiles',
--     'patients',
--     'medication_adherence_followups',
--     'medication_adherence_followup_events',
--     'medication_followup_alert_dispatches',
--     'doctor_notifications'
--   )
-- order by table_name, ordinal_position;
--
-- select conrelid::regclass::text as table_name, conname,
--        pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid in (
--   'public.medication_adherence_followups'::regclass,
--   'public.medication_adherence_followup_events'::regclass
-- )
-- order by table_name, conname;
--
-- select schemaname, tablename, policyname, roles, cmd, qual, with_check
-- from pg_policies
-- where schemaname = 'public'
--   and tablename in (
--     'medication_adherence_followups',
--     'medication_adherence_followup_events'
--   )
-- order by tablename, policyname;
--
-- select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
--        p.prosecdef, p.proconfig, r.rolname as owner
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- join pg_roles r on r.oid = p.proowner
-- where n.nspname = 'public'
--   and p.proname like '%medication%followup%'
-- order by p.proname, pg_get_function_identity_arguments(p.oid);
--
-- select indexname, indexdef
-- from pg_indexes
-- where schemaname = 'public'
--   and tablename in (
--     'medication_adherence_followups',
--     'medication_adherence_followup_events'
--   )
-- order by tablename, indexname;
-- ============================================================

begin;

create or replace function public.get_admin_followup_oversight_summary(
  p_start_date date default null,
  p_end_date date default null
)
returns table (
  active_cases bigint,
  due_today bigint,
  overdue bigint,
  critical bigint,
  resolved bigint,
  doctor_options jsonb,
  generated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_account_status text;
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

  if p_start_date is not null and p_end_date is not null
     and p_start_date > p_end_date then
    raise exception 'The start date must not be after the end date.'
      using errcode = '22023';
  end if;

  return query
  with followup_state as materialized (
    select
      followup.id,
      followup.assigned_doctor_id,
      pg_catalog.lower(
        pg_catalog.btrim(coalesce(followup.status, ''::text))
      ) as normalized_status,
      pg_catalog.lower(
        pg_catalog.btrim(coalesce(followup.severity_snapshot, ''::text))
      ) as normalized_severity,
      followup.next_follow_up_at,
      followup.resolved_at,
      (
        latest_snooze.id is not null
        and latest_snooze.next_follow_up_at > v_now
        and not exists (
          select 1
          from public.medication_adherence_followup_events as invalidator
          where invalidator.followup_id = followup.id
            and (invalidator.created_at, invalidator.id)
              > (latest_snooze.created_at, latest_snooze.id)
            and (
              invalidator.event_type in ('resolved', 'status_changed', 'doctor_reassigned')
              or (
                invalidator.event_type in ('followup_scheduled', 'patient_contacted')
                and invalidator.next_follow_up_at is not null
              )
            )
        )
      ) as is_snoozed
    from public.medication_adherence_followups as followup
    left join lateral (
      select event.id, event.next_follow_up_at, event.created_at
      from public.medication_adherence_followup_events as event
      where event.followup_id = followup.id
        and event.event_type = 'attention_snoozed'
      order by event.created_at desc, event.id desc
      limit 1
    ) as latest_snooze on true
  ),
  classified as (
    select
      state.*,
      case
        when state.normalized_status not in ('open', 'contacted', 'monitoring')
          or state.is_snoozed
          or state.next_follow_up_at is null
          then 'not_due'
        when state.next_follow_up_at > v_now
          and (state.next_follow_up_at at time zone 'Asia/Manila')::date
            = (v_now at time zone 'Asia/Manila')::date
          then 'due_today'
        when state.next_follow_up_at <= v_now
          and v_now - state.next_follow_up_at < interval '24 hours'
          then 'recently_overdue'
        when state.next_follow_up_at <= v_now
          and v_now - state.next_follow_up_at < interval '72 hours'
          then 'high'
        when state.next_follow_up_at <= v_now then 'critical'
        else 'not_due'
      end as escalation,
      (
        state.resolved_at is not null
        and (p_start_date is null or (state.resolved_at at time zone 'Asia/Manila')::date >= p_start_date)
        and (p_end_date is null or (state.resolved_at at time zone 'Asia/Manila')::date <= p_end_date)
      ) as resolved_in_period
    from followup_state as state
  ),
  counts as (
    select
      pg_catalog.count(*) filter (
        where classified.normalized_status in ('open', 'contacted', 'monitoring')
      ) as active_cases,
      pg_catalog.count(*) filter (
        where classified.normalized_status in ('open', 'contacted', 'monitoring')
          and classified.escalation = 'due_today'
      ) as due_today,
      pg_catalog.count(*) filter (
        where classified.normalized_status in ('open', 'contacted', 'monitoring')
          and not classified.is_snoozed
          and classified.next_follow_up_at <= v_now
      ) as overdue,
      pg_catalog.count(*) filter (
        where classified.normalized_status in ('open', 'contacted', 'monitoring')
          and (
            classified.normalized_severity = 'critical'
            or classified.escalation = 'critical'
          )
      ) as critical,
      pg_catalog.count(*) filter (
        where classified.normalized_status = 'resolved'
          and classified.resolved_in_period
      ) as resolved
    from classified
  ),
  doctors as (
    select profile.id, pg_catalog.btrim(profile.full_name) as full_name
    from public.profiles as profile
    where pg_catalog.lower(
      pg_catalog.btrim(coalesce(profile.role, ''::text))
    ) = 'doctor'
      and pg_catalog.lower(
        pg_catalog.btrim(coalesce(profile.account_status, ''::text))
      ) = 'active'
  )
  select
    counts.active_cases,
    counts.due_today,
    counts.overdue,
    counts.critical,
    counts.resolved,
    coalesce(
      (
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', doctor.id,
            'full_name', coalesce(nullif(doctor.full_name, ''), 'Doctor')
          )
          order by coalesce(nullif(doctor.full_name, ''), 'Doctor'), doctor.id
        )
        from doctors as doctor
      ),
      '[]'::jsonb
    ) as doctor_options,
    v_now as generated_at
  from counts;
end;
$function$;

create or replace function public.get_admin_followup_oversight_queue(
  p_search text default null,
  p_status text default null,
  p_severity text default null,
  p_escalation text default null,
  p_doctor_id uuid default null,
  p_start_date date default null,
  p_end_date date default null,
  p_sort text default 'most_urgent',
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  id uuid,
  patient_id uuid,
  patient_name text,
  patient_display_id text,
  status text,
  severity text,
  escalation text,
  is_snoozed boolean,
  snoozed_until timestamptz,
  assigned_doctor_id uuid,
  assigned_doctor_name text,
  adherence_rate numeric,
  taken_count integer,
  skipped_count integer,
  missed_count integer,
  maximum_missed_streak integer,
  analysis_window_start date,
  analysis_window_end date,
  created_at timestamptz,
  last_contacted_at timestamptz,
  next_follow_up_at timestamptz,
  resolved_at timestamptz,
  updated_at timestamptz,
  seconds_from_due numeric,
  total_count bigint,
  generated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_account_status text;
  v_search text := nullif(pg_catalog.btrim(coalesce(p_search, ''::text)), '');
  v_status text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_status, ''::text))), '');
  v_severity text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_severity, ''::text))), '');
  v_escalation text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_escalation, ''::text))), '');
  v_sort text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_sort, 'most_urgent'::text)));
  v_limit integer := least(100, greatest(1, coalesce(p_limit, 25)));
  v_offset integer := least(100000, greatest(0, coalesce(p_offset, 0)));
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

  if v_search is not null and pg_catalog.char_length(v_search) > 120 then
    raise exception 'Search text must not exceed 120 characters.' using errcode = '22023';
  end if;
  if v_status is not null and v_status not in ('open', 'contacted', 'monitoring', 'resolved') then
    raise exception 'Unsupported follow-up status filter.' using errcode = '22023';
  end if;
  if v_severity is not null and v_severity not in ('warning', 'high', 'critical') then
    raise exception 'Unsupported severity filter.' using errcode = '22023';
  end if;
  if v_escalation is not null and v_escalation not in (
    'not_due', 'due_today', 'recently_overdue', 'high', 'critical'
  ) then
    raise exception 'Unsupported escalation filter.' using errcode = '22023';
  end if;
  if v_sort not in (
    'most_urgent', 'oldest_case', 'newest_case',
    'next_follow_up_earliest', 'recently_updated'
  ) then
    raise exception 'Unsupported follow-up sort.' using errcode = '22023';
  end if;
  if p_start_date is not null and p_end_date is not null
     and p_start_date > p_end_date then
    raise exception 'The start date must not be after the end date.' using errcode = '22023';
  end if;

  return query
  with followup_state as materialized (
    select
      followup.id,
      followup.patient_id,
      coalesce(nullif(pg_catalog.btrim(patient.full_name), ''), 'Patient') as patient_name,
      coalesce(nullif(pg_catalog.btrim(patient.patient_id), ''), 'Not assigned') as patient_display_id,
      pg_catalog.lower(pg_catalog.btrim(followup.status)) as status,
      pg_catalog.lower(pg_catalog.btrim(followup.severity_snapshot)) as severity,
      followup.assigned_doctor_id,
      coalesce(nullif(pg_catalog.btrim(doctor.full_name), ''), 'Doctor') as assigned_doctor_name,
      followup.adherence_rate_snapshot as adherence_rate,
      followup.taken_count_snapshot as taken_count,
      followup.skipped_count_snapshot as skipped_count,
      followup.missed_count_snapshot as missed_count,
      followup.maximum_missed_streak_snapshot as maximum_missed_streak,
      followup.analysis_window_start,
      followup.analysis_window_end,
      followup.created_at,
      followup.last_contacted_at,
      followup.next_follow_up_at,
      followup.resolved_at,
      followup.updated_at,
      latest_snooze.next_follow_up_at as snoozed_until,
      (
        latest_snooze.id is not null
        and latest_snooze.next_follow_up_at > v_now
        and not exists (
          select 1
          from public.medication_adherence_followup_events as invalidator
          where invalidator.followup_id = followup.id
            and (invalidator.created_at, invalidator.id)
              > (latest_snooze.created_at, latest_snooze.id)
            and (
              invalidator.event_type in ('resolved', 'status_changed', 'doctor_reassigned')
              or (
                invalidator.event_type in ('followup_scheduled', 'patient_contacted')
                and invalidator.next_follow_up_at is not null
              )
            )
        )
      ) as is_snoozed
    from public.medication_adherence_followups as followup
    join public.patients as patient on patient.id = followup.patient_id
    join public.profiles as doctor on doctor.id = followup.assigned_doctor_id
    left join lateral (
      select event.id, event.next_follow_up_at, event.created_at
      from public.medication_adherence_followup_events as event
      where event.followup_id = followup.id
        and event.event_type = 'attention_snoozed'
      order by event.created_at desc, event.id desc
      limit 1
    ) as latest_snooze on true
  ),
  classified as (
    select
      state.*,
      case
        when state.status not in ('open', 'contacted', 'monitoring')
          or state.is_snoozed
          or state.next_follow_up_at is null
          then 'not_due'
        when state.next_follow_up_at > v_now
          and (state.next_follow_up_at at time zone 'Asia/Manila')::date
            = (v_now at time zone 'Asia/Manila')::date
          then 'due_today'
        when state.next_follow_up_at <= v_now
          and v_now - state.next_follow_up_at < interval '24 hours'
          then 'recently_overdue'
        when state.next_follow_up_at <= v_now
          and v_now - state.next_follow_up_at < interval '72 hours'
          then 'high'
        when state.next_follow_up_at <= v_now then 'critical'
        else 'not_due'
      end as escalation,
      case
        when state.status in ('open', 'contacted', 'monitoring')
          and state.next_follow_up_at is not null
          then extract(epoch from (v_now - state.next_follow_up_at))::numeric
        else null
      end as seconds_from_due
    from followup_state as state
  ),
  filtered as (
    select classified.*
    from classified
    where (
      v_search is null
      or classified.patient_name ilike '%' || v_search || '%'
      or classified.patient_display_id ilike '%' || v_search || '%'
    )
      and (v_status is null or classified.status = v_status)
      and (v_severity is null or classified.severity = v_severity)
      and (v_escalation is null or classified.escalation = v_escalation)
      and (p_doctor_id is null or classified.assigned_doctor_id = p_doctor_id)
      and (
        p_start_date is null
        or (classified.created_at at time zone 'Asia/Manila')::date >= p_start_date
      )
      and (
        p_end_date is null
        or (classified.created_at at time zone 'Asia/Manila')::date <= p_end_date
      )
  )
  select
    filtered.id,
    filtered.patient_id,
    filtered.patient_name,
    filtered.patient_display_id,
    filtered.status,
    filtered.severity,
    filtered.escalation,
    filtered.is_snoozed,
    filtered.snoozed_until,
    filtered.assigned_doctor_id,
    filtered.assigned_doctor_name,
    filtered.adherence_rate,
    filtered.taken_count,
    filtered.skipped_count,
    filtered.missed_count,
    filtered.maximum_missed_streak,
    filtered.analysis_window_start,
    filtered.analysis_window_end,
    filtered.created_at,
    filtered.last_contacted_at,
    filtered.next_follow_up_at,
    filtered.resolved_at,
    filtered.updated_at,
    filtered.seconds_from_due,
    pg_catalog.count(*) over() as total_count,
    v_now as generated_at
  from filtered
  order by
    case when v_sort = 'most_urgent' then
      case filtered.escalation
        when 'critical' then 4
        when 'high' then 3
        when 'recently_overdue' then 2
        when 'due_today' then 1
        else 0
      end
    end desc,
    case when v_sort = 'most_urgent'
      and filtered.escalation in ('critical', 'high', 'recently_overdue')
      then filtered.next_follow_up_at end asc nulls last,
    case when v_sort = 'most_urgent' then
      case filtered.severity
        when 'critical' then 3
        when 'high' then 2
        when 'warning' then 1
        else 0
      end
    end desc,
    case when v_sort = 'oldest_case' then filtered.created_at end asc,
    case when v_sort = 'newest_case' then filtered.created_at end desc,
    case when v_sort = 'next_follow_up_earliest' then filtered.next_follow_up_at end asc nulls last,
    case when v_sort = 'recently_updated' then filtered.updated_at end desc,
    filtered.id
  limit v_limit
  offset v_offset;
end;
$function$;

create or replace function public.get_admin_followup_oversight_detail(
  p_followup_id uuid
)
returns table (
  id uuid,
  patient_id uuid,
  patient_name text,
  patient_display_id text,
  status text,
  severity text,
  escalation text,
  is_snoozed boolean,
  snoozed_until timestamptz,
  assigned_doctor_id uuid,
  assigned_doctor_name text,
  adherence_rate numeric,
  total_outcomes integer,
  taken_count integer,
  skipped_count integer,
  missed_count integer,
  maximum_missed_streak integer,
  analysis_window_start date,
  analysis_window_end date,
  latest_completed_dose_at timestamptz,
  created_at timestamptz,
  last_contacted_at timestamptz,
  next_follow_up_at timestamptz,
  resolved_at timestamptz,
  updated_at timestamptz,
  resolution_summary text,
  timeline jsonb,
  generated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_account_status text;
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

  return query
  with followup_state as materialized (
    select
      followup.*,
      coalesce(nullif(pg_catalog.btrim(patient.full_name), ''), 'Patient') as patient_name,
      coalesce(nullif(pg_catalog.btrim(patient.patient_id), ''), 'Not assigned') as patient_display_id,
      coalesce(nullif(pg_catalog.btrim(doctor.full_name), ''), 'Doctor') as assigned_doctor_name,
      latest_snooze.next_follow_up_at as snoozed_until,
      (
        latest_snooze.id is not null
        and latest_snooze.next_follow_up_at > v_now
        and not exists (
          select 1
          from public.medication_adherence_followup_events as invalidator
          where invalidator.followup_id = followup.id
            and (invalidator.created_at, invalidator.id)
              > (latest_snooze.created_at, latest_snooze.id)
            and (
              invalidator.event_type in ('resolved', 'status_changed', 'doctor_reassigned')
              or (
                invalidator.event_type in ('followup_scheduled', 'patient_contacted')
                and invalidator.next_follow_up_at is not null
              )
            )
        )
      ) as is_snoozed
    from public.medication_adherence_followups as followup
    join public.patients as patient on patient.id = followup.patient_id
    join public.profiles as doctor on doctor.id = followup.assigned_doctor_id
    left join lateral (
      select event.id, event.next_follow_up_at, event.created_at
      from public.medication_adherence_followup_events as event
      where event.followup_id = followup.id
        and event.event_type = 'attention_snoozed'
      order by event.created_at desc, event.id desc
      limit 1
    ) as latest_snooze on true
    where followup.id = p_followup_id
  ),
  classified as (
    select
      state.*,
      case
        when pg_catalog.lower(pg_catalog.btrim(state.status))
          not in ('open', 'contacted', 'monitoring')
          or state.is_snoozed
          or state.next_follow_up_at is null
          then 'not_due'
        when state.next_follow_up_at > v_now
          and (state.next_follow_up_at at time zone 'Asia/Manila')::date
            = (v_now at time zone 'Asia/Manila')::date
          then 'due_today'
        when state.next_follow_up_at <= v_now
          and v_now - state.next_follow_up_at < interval '24 hours'
          then 'recently_overdue'
        when state.next_follow_up_at <= v_now
          and v_now - state.next_follow_up_at < interval '72 hours'
          then 'high'
        when state.next_follow_up_at <= v_now then 'critical'
        else 'not_due'
      end as escalation
    from followup_state as state
  ),
  safe_events as (
    select
      event.id,
      event.event_type,
      event.from_status,
      event.to_status,
      event.contact_method,
      event.next_follow_up_at,
      event.created_at,
      coalesce(nullif(pg_catalog.btrim(actor.full_name), ''), 'Clinic user') as actor_name,
      coalesce(nullif(pg_catalog.btrim(previous_doctor.full_name), ''), 'Previous Doctor')
        as previous_doctor_name,
      coalesce(nullif(pg_catalog.btrim(new_doctor.full_name), ''), 'New Doctor')
        as new_doctor_name
    from public.medication_adherence_followup_events as event
    left join public.profiles as actor on actor.id = event.created_by
    left join public.profiles as previous_doctor on previous_doctor.id = event.previous_doctor_id
    left join public.profiles as new_doctor on new_doctor.id = event.new_doctor_id
    where event.followup_id = p_followup_id
    order by event.created_at desc, event.id desc
    limit 100
  ),
  event_timeline as (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', event.id,
          'event_type', event.event_type,
          'from_status', event.from_status,
          'to_status', event.to_status,
          'contact_method', event.contact_method,
          'next_follow_up_at', event.next_follow_up_at,
          'created_at', event.created_at,
          'actor_name', event.actor_name,
          'previous_doctor_name', case
            when event.event_type = 'doctor_reassigned' then event.previous_doctor_name
            else null
          end,
          'new_doctor_name', case
            when event.event_type = 'doctor_reassigned' then event.new_doctor_name
            else null
          end
        ) order by event.created_at desc, event.id desc
      ),
      '[]'::jsonb
    ) as timeline
    from safe_events as event
  )
  select
    classified.id,
    classified.patient_id,
    classified.patient_name,
    classified.patient_display_id,
    pg_catalog.lower(pg_catalog.btrim(classified.status)) as status,
    pg_catalog.lower(pg_catalog.btrim(classified.severity_snapshot)) as severity,
    classified.escalation,
    classified.is_snoozed,
    classified.snoozed_until,
    classified.assigned_doctor_id,
    classified.assigned_doctor_name,
    classified.adherence_rate_snapshot as adherence_rate,
    classified.total_outcomes_snapshot as total_outcomes,
    classified.taken_count_snapshot as taken_count,
    classified.skipped_count_snapshot as skipped_count,
    classified.missed_count_snapshot as missed_count,
    classified.maximum_missed_streak_snapshot as maximum_missed_streak,
    classified.analysis_window_start,
    classified.analysis_window_end,
    classified.latest_completed_dose_at,
    classified.created_at,
    classified.last_contacted_at,
    classified.next_follow_up_at,
    classified.resolved_at,
    classified.updated_at,
    classified.resolution_summary,
    event_timeline.timeline,
    v_now as generated_at
  from classified
  cross join event_timeline;
end;
$function$;

revoke all on function public.get_admin_followup_oversight_summary(date, date)
  from public, anon, authenticated;
grant execute on function public.get_admin_followup_oversight_summary(date, date)
  to authenticated;

revoke all on function public.get_admin_followup_oversight_queue(
  text, text, text, text, uuid, date, date, text, integer, integer
) from public, anon, authenticated;
grant execute on function public.get_admin_followup_oversight_queue(
  text, text, text, text, uuid, date, date, text, integer, integer
) to authenticated;

revoke all on function public.get_admin_followup_oversight_detail(uuid)
  from public, anon, authenticated;
grant execute on function public.get_admin_followup_oversight_detail(uuid)
  to authenticated;

select pg_catalog.pg_notify('pgrst', 'reload schema');

commit;

-- ============================================================
-- Commented verification queries (run manually after installation)
-- ============================================================
-- 1. Confirm signatures, SECURITY DEFINER, empty search_path, owner, and grants.
-- select p.proname, pg_get_function_identity_arguments(p.oid),
--        pg_get_function_result(p.oid), p.prosecdef, p.proconfig,
--        r.rolname as owner
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- join pg_roles r on r.oid = p.proowner
-- where n.nspname = 'public'
--   and p.proname in (
--     'get_admin_followup_oversight_summary',
--     'get_admin_followup_oversight_queue',
--     'get_admin_followup_oversight_detail'
--   )
-- order by p.proname;
--
-- select routine_name, grantee, privilege_type
-- from information_schema.role_routine_grants
-- where routine_schema = 'public'
--   and routine_name in (
--     'get_admin_followup_oversight_summary',
--     'get_admin_followup_oversight_queue',
--     'get_admin_followup_oversight_detail'
--   )
-- order by routine_name, grantee;
--
-- 2. As an active Admin, verify summary and bounded pagination.
-- select * from public.get_admin_followup_oversight_summary(null, null);
-- Confirm Active Cases, Due Today, Overdue, and Critical are identical when
-- this RPC is called with a narrow date range; only Resolved should change.
-- select * from public.get_admin_followup_oversight_summary(
--   current_date - 7, current_date
-- );
-- Confirm an unresolved case created before that range remains included in
-- the four live operational metrics.
-- select * from public.get_admin_followup_oversight_queue(
--   null, null, null, null, null, null, null, 'most_urgent', 25, 0
-- );
--
-- 3. Confirm detail contains no event notes or Patient contact fields.
-- select * from public.get_admin_followup_oversight_detail(
--   '00000000-0000-0000-0000-000000000000'::uuid
-- );
--
-- 4. As Doctor, Staff, Patient, inactive Admin, and anon, confirm all three
-- RPCs fail with SQLSTATE 42501.
--
-- 5. Confirm Due Today uses a future time on today's Asia/Manila date;
-- <24 hours overdue is recently_overdue, 24-<72 is high, and >=72 is critical.
-- Confirm resolved, upcoming, unscheduled, and actively snoozed cases are not_due.
--
-- 6. Confirm a latest unexpired attention_snoozed event suppresses escalation.
-- Confirm newer resolved/status_changed/doctor_reassigned always invalidates it, and newer
-- followup_scheduled/patient_contacted invalidates it only with a schedule.
--
-- 7. Confirm most_urgent places critical first and the longest-overdue case
-- first within the same overdue escalation.
--
-- 8. Confirm queue/detail responses contain no endpoint, p256dh, auth_key,
-- medication name, dosage, Patient phone/email, diagnosis, note, or assessment.
--
-- Rollback guidance (manual, after dependency review):
-- begin;
-- drop function if exists public.get_admin_followup_oversight_detail(uuid);
-- drop function if exists public.get_admin_followup_oversight_queue(
--   text, text, text, text, uuid, date, date, text, integer, integer
-- );
-- drop function if exists public.get_admin_followup_oversight_summary(date, date);
-- commit;
