-- ============================================================
-- Maternal Care - Admin Dashboard Aggregate Summary
-- ============================================================
-- REVIEW ONLY. Do not execute automatically from the application.
-- This migration adds one read-only aggregate RPC. It does not change data,
-- RLS, Cron, Realtime, notifications, Edge Functions, Web Push, or VAPID.
--
-- Read-only preflight queries:
-- select table_name, column_name, data_type
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name in ('profiles', 'patients', 'schedule', 'audit_logs')
-- order by table_name, ordinal_position;
--
begin;

do $preflight$
declare
  v_missing text;
begin
  select pg_catalog.string_agg(required.table_name || '.' || required.column_name, ', ')
  into v_missing
  from (
    values
      ('profiles', 'id'),
      ('profiles', 'role'),
      ('profiles', 'account_status'),
      ('profiles', 'created_at'),
      ('patients', 'id'),
      ('patients', 'user_id'),
      ('patients', 'account_status'),
      ('patients', 'archived_at'),
      ('patients', 'created_at'),
      ('schedule', 'id'),
      ('schedule', 'maternal_appointment_id'),
      ('schedule', 'status'),
      ('schedule', 'start_time'),
      ('schedule', 'end_time'),
      ('schedule', 'doctor_id'),
      ('schedule', 'created_at')
  ) as required(table_name, column_name)
  left join information_schema.columns as actual
    on actual.table_schema = 'public'
   and actual.table_name = required.table_name
   and actual.column_name = required.column_name
  where actual.column_name is null;

  if v_missing is not null then
    raise exception 'Admin Dashboard preflight failed. Missing columns: %', v_missing;
  end if;
end;
$preflight$;

create or replace function public.get_admin_dashboard_summary(
  p_start_date date,
  p_end_date date,
  p_trend_mode text default 'daily'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_account_status text;
  v_trend_mode text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_trend_mode, ''::text)));
  v_start_at timestamptz;
  v_end_at timestamptz;
  v_now timestamptz := pg_catalog.now();
  v_today_start_at timestamptz;
  v_today_end_at timestamptz;
  v_result jsonb;
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

  if p_start_date is null or p_end_date is null then
    raise exception 'Dashboard start and end dates are required.' using errcode = '22023';
  end if;
  if p_start_date > p_end_date then
    raise exception 'The start date must not be after the end date.' using errcode = '22023';
  end if;
  if p_end_date - p_start_date > 366 then
    raise exception 'Dashboard date ranges cannot exceed 367 calendar days.' using errcode = '22023';
  end if;
  if v_trend_mode not in ('daily', 'weekly', 'monthly') then
    raise exception 'Dashboard trend mode must be daily, weekly, or monthly.' using errcode = '22023';
  end if;

  v_start_at := p_start_date::timestamp without time zone at time zone 'Asia/Manila';
  v_end_at := (p_end_date + 1)::timestamp without time zone at time zone 'Asia/Manila';
  v_today_start_at := (v_now at time zone 'Asia/Manila')::date::timestamp without time zone at time zone 'Asia/Manila';
  v_today_end_at := v_today_start_at + interval '1 day';

  with profile_users as materialized (
    select
      profile.id,
      pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) as role,
      profile.created_at
    from public.profiles as profile
    where pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text)))
            in ('admin', 'doctor', 'staff')
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  ),
  patient_users as materialized (
    select patient.user_id, pg_catalog.min(patient.created_at) as created_at
    from public.patients as patient
    join public.profiles as patient_profile on patient_profile.id = patient.user_id
    where patient.archived_at is null
      and patient.user_id is not null
      and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.account_status, ''::text))) = 'active'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(patient_profile.role, ''::text))) = 'patient'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(patient_profile.account_status, ''::text))) = 'active'
    group by patient.user_id
  ),
  appointment_source as materialized (
    select
      schedule.id,
      schedule.doctor_id,
      schedule.start_time,
      schedule.end_time,
      schedule.created_at,
      coalesce(
        nullif(pg_catalog.btrim(schedule.maternal_appointment_id::text), ''::text),
        schedule.id::text
      ) as appointment_key,
      case
        when pg_catalog.regexp_replace(
          pg_catalog.lower(pg_catalog.btrim(coalesce(schedule.status, ''::text))),
          '[[:space:]-]+', '_', 'g'
        ) in ('scheduled', 'pending', 'upcoming') then 'pending'
        when pg_catalog.regexp_replace(
          pg_catalog.lower(pg_catalog.btrim(coalesce(schedule.status, ''::text))),
          '[[:space:]-]+', '_', 'g'
        ) = 'checked_in' then 'checked_in'
        when pg_catalog.regexp_replace(
          pg_catalog.lower(pg_catalog.btrim(coalesce(schedule.status, ''::text))),
          '[[:space:]-]+', '_', 'g'
        ) in ('completed', 'complete', 'done') then 'completed'
        when pg_catalog.regexp_replace(
          pg_catalog.lower(pg_catalog.btrim(coalesce(schedule.status, ''::text))),
          '[[:space:]-]+', '_', 'g'
        ) in ('cancel', 'cancelled', 'canceled') then 'cancelled'
        when pg_catalog.regexp_replace(
          pg_catalog.lower(pg_catalog.btrim(coalesce(schedule.status, ''::text))),
          '[[:space:]-]+', '_', 'g'
        ) in ('rescheduled', 'reschedule') then 'rescheduled'
        when pg_catalog.regexp_replace(
          pg_catalog.lower(pg_catalog.btrim(coalesce(schedule.status, ''::text))),
          '[[:space:]-]+', '_', 'g'
        ) in ('missed', 'no_show', 'absent') then 'missed'
        else 'other'
      end as normalized_status
    from public.schedule as schedule
  ),
  appointments as materialized (
    select distinct on (source.appointment_key)
      source.*
    from appointment_source as source
    order by source.appointment_key, source.created_at desc nulls last, source.id desc
  ),
  period_appointments as materialized (
    select appointment.*
    from appointments as appointment
    where appointment.start_time >= v_start_at
      and appointment.start_time < v_end_at
  ),
  today_appointments as materialized (
    select appointment.*
    from appointments as appointment
    where appointment.start_time >= v_today_start_at
      and appointment.start_time < v_today_end_at
  ),
  appointment_counts as (
    select appointment.normalized_status as status, pg_catalog.count(*) as value
    from period_appointments as appointment
    group by appointment.normalized_status
  ),
  registrations as materialized (
    select profile.created_at
    from profile_users as profile
    where profile.created_at >= v_start_at and profile.created_at < v_end_at
    union all
    select patient.created_at
    from patient_users as patient
    where patient.created_at >= v_start_at and patient.created_at < v_end_at
  ),
  registration_counts as (
    select
      case v_trend_mode
        when 'monthly' then pg_catalog.to_char(
          pg_catalog.date_trunc('month', registration.created_at at time zone 'Asia/Manila'),
          'YYYY-MM'
        )
        when 'weekly' then pg_catalog.to_char(
          pg_catalog.date_trunc('week', registration.created_at at time zone 'Asia/Manila'),
          'YYYY-MM-DD'
        )
        else pg_catalog.to_char(
          registration.created_at at time zone 'Asia/Manila',
          'YYYY-MM-DD'
        )
      end as key,
      pg_catalog.count(*) as value
    from registrations as registration
    group by 1
  ),
  user_counts as (
    select
      (select pg_catalog.count(*) from patient_users) as patients,
      pg_catalog.count(*) filter (where profile.role = 'doctor') as doctors,
      pg_catalog.count(*) filter (where profile.role = 'staff') as staff,
      pg_catalog.count(*) filter (where profile.role = 'admin') as admins
    from profile_users as profile
  ),
  appointment_metrics as (
    select
      (select pg_catalog.count(*) from period_appointments) as total_appointments,
      (
        select pg_catalog.count(*)
        from period_appointments as appointment
        where appointment.normalized_status in ('pending', 'checked_in', 'rescheduled')
      ) as pending_appointments,
      (select pg_catalog.count(*) from today_appointments) as todays_appointments
  ),
  alert_counts as (
    select
      (
        select pg_catalog.count(*)
        from public.patients as patient
        where patient.archived_at is null and patient.user_id is null
      ) as unlinked_patients,
      (
        select pg_catalog.count(*)
        from public.profiles as profile
        where pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) in ('doctor', 'staff')
          and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) <> 'active'
      ) as inactive_professionals,
      pg_catalog.count(*) filter (
        where appointment.normalized_status in ('pending', 'checked_in', 'rescheduled')
          and appointment.doctor_id is null
      ) as unassigned_appointments,
      pg_catalog.count(*) filter (
        where appointment.normalized_status in ('pending', 'checked_in', 'rescheduled')
          and appointment.doctor_id is not null
          and coalesce(appointment.end_time, appointment.start_time) < v_now
      ) as overdue_appointments
    from appointments as appointment
  )
  select pg_catalog.jsonb_build_object(
    'totals', pg_catalog.jsonb_build_object(
      'total_users', users.patients + users.doctors + users.staff + users.admins,
      'patients', users.patients,
      'doctors', users.doctors,
      'staff', users.staff,
      'admins', users.admins,
      'total_appointments', metrics.total_appointments,
      'pending_appointments', metrics.pending_appointments,
      'todays_appointments', metrics.todays_appointments
    ),
    'appointment_overview', (
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('status', status_list.status, 'value', coalesce(counts.value, 0))
        order by status_list.ordinal
      )
      from (
        values
          (1, 'pending'), (2, 'checked_in'), (3, 'completed'),
          (4, 'rescheduled'), (5, 'cancelled'), (6, 'missed'), (7, 'other')
      ) as status_list(ordinal, status)
      left join appointment_counts as counts on counts.status = status_list.status
    ),
    'registration_trend', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('key', trend.key, 'value', trend.value)
        order by trend.key
      )
      from registration_counts as trend
    ), '[]'::jsonb),
    'system_alerts', (
      select coalesce(pg_catalog.jsonb_agg(alert.item order by alert.ordinal), '[]'::jsonb)
      from (
        select 1 as ordinal, pg_catalog.jsonb_build_object(
          'id', 'overdue-appointments', 'icon', 'solar:calendar-minimalistic-linear',
          'count', alerts.overdue_appointments, 'severity', 'High',
          'title', 'Overdue appointments unresolved',
          'detail', 'Past assigned appointments still have an active status.', 'target', 'appointments'
        ) as item where alerts.overdue_appointments > 0
        union all
        select 2, pg_catalog.jsonb_build_object(
          'id', 'unassigned-appointments', 'icon', 'solar:user-cross-rounded-linear',
          'count', alerts.unassigned_appointments, 'severity', 'High',
          'title', 'Appointments without a Doctor',
          'detail', 'Active appointments require a Doctor assignment.', 'target', 'appointments'
        ) where alerts.unassigned_appointments > 0
        union all
        select 3, pg_catalog.jsonb_build_object(
          'id', 'unlinked-patients', 'icon', 'solar:link-broken-minimalistic-linear',
          'count', alerts.unlinked_patients, 'severity', 'Review',
          'title', 'Patient accounts not linked',
          'detail', 'Non-archived Patient records are missing an account link.', 'target', 'users'
        ) where alerts.unlinked_patients > 0
        union all
        select 4, pg_catalog.jsonb_build_object(
          'id', 'inactive-professionals', 'icon', 'solar:user-block-rounded-linear',
          'count', alerts.inactive_professionals, 'severity', 'Review',
          'title', 'Inactive clinic professionals',
          'detail', 'Doctor or Staff accounts are currently inactive.', 'target', 'users'
        ) where alerts.inactive_professionals > 0
      ) as alert
    ),
    'generated_at', v_now
  )
  into v_result
  from user_counts as users
  cross join appointment_metrics as metrics
  cross join alert_counts as alerts;

  return v_result;
end;
$function$;

revoke all on function public.get_admin_dashboard_summary(date, date, text)
  from public, anon, authenticated;
grant execute on function public.get_admin_dashboard_summary(date, date, text)
  to authenticated;

comment on function public.get_admin_dashboard_summary(date, date, text) is
  'Returns privacy-safe aggregate Admin Dashboard metrics for an active Admin account.';

select pg_catalog.pg_notify('pgrst', 'reload schema');

commit;

-- ============================================================
-- Commented verification queries (run manually after installation)
-- ============================================================
-- 1. Confirm signature, return type, SECURITY DEFINER, protected search_path,
--    owner, and grants.
-- select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid),
--        pg_catalog.pg_get_function_result(p.oid), p.prosecdef, p.proconfig,
--        r.rolname as owner, pg_catalog.aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))
-- from pg_catalog.pg_proc as p
-- join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
-- join pg_catalog.pg_roles as r on r.oid = p.proowner
-- where n.nspname = 'public' and p.proname = 'get_admin_dashboard_summary';
--
-- 2. As an active Admin, verify a short Manila date range.
-- select public.get_admin_dashboard_summary(current_date, current_date, 'daily');
--
-- 3. Verify grouped appointment values equal total_appointments.
-- with result as (
--   select public.get_admin_dashboard_summary(current_date - 30, current_date, 'weekly') as payload
-- )
-- select
--   (payload #>> '{totals,total_appointments}')::bigint as total_appointments,
--   (select pg_catalog.sum((item ->> 'value')::bigint)
--    from pg_catalog.jsonb_array_elements(payload -> 'appointment_overview') as item) as grouped_total
-- from result;
--
-- 4. As Doctor, Staff, Patient, anon, and unauthenticated sessions, confirm
--    the RPC rejects access with SQLSTATE 42501.
--
-- 5. Confirm the payload contains no names, contact information, medication
--    details, clinical notes, audit metadata, IP addresses, or push data.
--
-- Rollback (manual review required):
-- begin;
-- drop function if exists public.get_admin_dashboard_summary(date, date, text);
-- select pg_catalog.pg_notify('pgrst', 'reload schema');
-- commit;
