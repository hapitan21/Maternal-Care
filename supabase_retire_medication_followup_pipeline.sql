-- ============================================================================
-- PROPOSED ONLY: retire the legacy medication follow-up/escalation pipeline
-- ============================================================================
-- This file is intentionally fail-closed. Run the companion read-only
-- introspection script first, disable every matching Database Webhook, and
-- take a database backup. Then uncomment the set_config line below in the SAME
-- session immediately before review/execution.
--
-- select pg_catalog.set_config(
--   'app.medication_followup_retirement_dependencies_verified', 'true', false
-- );
--
-- This migration does not touch medication_reminders,
-- medication_reminder_occurrences, schedule, medical_records, Patient push,
-- or ordinary appointment Follow-up Visit objects.

begin;

-- Phase 0: operator gate and retained-object preflight.
do $retirement_preflight$
declare
  v_missing text;
  v_external_fks text;
begin
  if pg_catalog.current_setting(
       'app.medication_followup_retirement_dependencies_verified', true
     ) is distinct from 'true' then
    raise exception using
      message = 'Medication follow-up retirement is blocked by the safety gate.',
      detail = 'Run the introspection SQL, disable matching Database Webhooks, confirm the Edge Function is not invoked by any database/external process, and explicitly set app.medication_followup_retirement_dependencies_verified=true.',
      hint = 'Do not enable the gate from application code.';
  end if;

  select pg_catalog.string_agg(required.object_name, ', ' order by required.object_name)
  into v_missing
  from (values
    ('public.medication_reminders'),
    ('public.medication_reminder_occurrences'),
    ('public.schedule'),
    ('public.medical_records'),
    ('public.system_settings')
  ) as required(object_name)
  where pg_catalog.to_regclass(required.object_name) is null;

  if v_missing is not null then
    raise exception 'Retirement preflight failed. Retained relations are missing: %', v_missing;
  end if;

  select pg_catalog.string_agg(
    pg_catalog.format('%s (%I)', foreign_key.conrelid::pg_catalog.regclass, foreign_key.conname),
    ', ' order by foreign_key.conrelid::pg_catalog.regclass::text, foreign_key.conname
  )
  into v_external_fks
  from pg_catalog.pg_constraint as foreign_key
  where foreign_key.contype = 'f'
    and foreign_key.confrelid in (
      pg_catalog.to_regclass('public.medication_adherence_followups'),
      pg_catalog.to_regclass('public.medication_adherence_followup_events'),
      pg_catalog.to_regclass('public.medication_adherence_followup_assignment_audits'),
      pg_catalog.to_regclass('public.doctor_notifications'),
      pg_catalog.to_regclass('public.medication_followup_alert_dispatches'),
      pg_catalog.to_regclass('public.doctor_push_subscriptions'),
      pg_catalog.to_regclass('public.doctor_notification_push_deliveries')
    )
    and foreign_key.conrelid not in (
      pg_catalog.to_regclass('public.medication_adherence_followups'),
      pg_catalog.to_regclass('public.medication_adherence_followup_events'),
      pg_catalog.to_regclass('public.medication_adherence_followup_assignment_audits'),
      pg_catalog.to_regclass('public.doctor_notifications'),
      pg_catalog.to_regclass('public.medication_followup_alert_dispatches'),
      pg_catalog.to_regclass('public.doctor_push_subscriptions'),
      pg_catalog.to_regclass('public.doctor_notification_push_deliveries')
    );

  if v_external_fks is not null then
    raise exception 'Retirement preflight failed. External foreign keys still depend on legacy tables: %', v_external_fks;
  end if;
end;
$retirement_preflight$;

-- Phase 1: stop the exact legacy Cron job. Refuse similarly named jobs because
-- they require separate human review instead of a name-pattern deletion.
do $retire_cron$
declare
  v_job record;
  v_unexpected text;
begin
  if pg_catalog.to_regclass('cron.job') is not null then
    execute $sql$
      select pg_catalog.string_agg(jobid::text || ':' || coalesce(jobname, '<unnamed>'), ', ')
      from cron.job
      where (coalesce(jobname, '') ~* '(medication.*followup|followup.*medication)'
          or coalesce(command, '') ~* '(medication[_ -].*followup|process_due_medication_followup_alerts)')
        and coalesce(jobname, '') <> 'process-medication-followup-alerts'
    $sql$ into v_unexpected;

    if v_unexpected is not null then
      raise exception 'Unexpected medication follow-up Cron jobs require review: %', v_unexpected;
    end if;

    for v_job in execute $sql$
      select jobid from cron.job where jobname = 'process-medication-followup-alerts'
    $sql$
    loop
      execute 'select cron.unschedule($1)' using v_job.jobid;
    end loop;
  end if;
end;
$retire_cron$;

-- Phase 2: stop Realtime delivery from doctor_notifications before removal.
do $retire_realtime$
declare
  v_publication text;
begin
  for v_publication in
    select publication.pubname
    from pg_catalog.pg_publication as publication
    join pg_catalog.pg_publication_rel as membership
      on membership.prpubid = publication.oid
    where membership.prrelid = pg_catalog.to_regclass('public.doctor_notifications')
  loop
    execute pg_catalog.format(
      'alter publication %I drop table public.doctor_notifications',
      v_publication
    );
  end loop;
end;
$retire_realtime$;

-- Phase 3: replace the retained Admin Dashboard RPC with the audited definition
-- that has no dependency on get_admin_followup_oversight_summary.
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

-- Phase 4: remove dead settings compatibility fields and replace the retained
-- settings RPC contract. Drop both known update signatures explicitly; no
-- pattern-based overload deletion is used.
drop function if exists public.get_admin_system_settings();
drop function if exists public.update_admin_system_settings(
  text, text, text, text, text, text, text,
  time without time zone, time without time zone,
  integer, integer, integer, integer,
  boolean, boolean, boolean, boolean, boolean,
  integer, integer, text, text, integer, integer
);
drop function if exists public.update_admin_system_settings(
  text, text, text, text, text, text, text,
  time without time zone, time without time zone,
  integer, integer, integer, integer,
  boolean, boolean, boolean,
  integer, integer, text, text, integer, integer
);

alter table public.system_settings
  drop column if exists medication_adherence_alerts_enabled,
  drop column if exists doctor_followup_alerts_enabled;

create or replace function public.get_admin_system_settings()
returns table (
  system_name text,
  clinic_name text,
  clinic_email text,
  contact_number text,
  clinic_address text,
  timezone text,
  clinic_opening_time time without time zone,
  clinic_closing_time time without time zone,
  default_appointment_duration_minutes integer,
  booking_interval_minutes integer,
  cancellation_window_hours integer,
  maximum_daily_appointments integer,
  appointment_reminders_enabled boolean,
  medication_reminder_alerts_enabled boolean,
  browser_push_notifications_enabled boolean,
  appointment_reminder_hours_before integer,
  second_reminder_hours_before integer,
  date_format text,
  time_format text,
  records_per_page integer,
  dashboard_refresh_seconds integer
)
language plpgsql
security definer
stable
set search_path to ''
as $function$
declare
  v_role text;
  v_account_status text;
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

  return query
  select
    settings.system_name,
    settings.clinic_name,
    settings.clinic_email,
    settings.contact_number,
    settings.clinic_address,
    settings.timezone,
    settings.clinic_opening_time,
    settings.clinic_closing_time,
    settings.default_appointment_duration_minutes,
    settings.booking_interval_minutes,
    settings.cancellation_window_hours,
    settings.maximum_daily_appointments,
    settings.appointment_reminders_enabled,
    settings.medication_reminder_alerts_enabled,
    settings.browser_push_notifications_enabled,
    settings.appointment_reminder_hours_before,
    settings.second_reminder_hours_before,
    settings.date_format,
    settings.time_format,
    settings.records_per_page,
    settings.dashboard_refresh_seconds
  from public.system_settings as settings
  where settings.singleton_guard = true;
end;
$function$;

create or replace function public.update_admin_system_settings(
  p_section text,
  p_system_name text,
  p_clinic_name text,
  p_clinic_email text,
  p_contact_number text,
  p_clinic_address text,
  p_timezone text,
  p_clinic_opening_time time without time zone,
  p_clinic_closing_time time without time zone,
  p_default_appointment_duration_minutes integer,
  p_booking_interval_minutes integer,
  p_cancellation_window_hours integer,
  p_maximum_daily_appointments integer,
  p_appointment_reminders_enabled boolean,
  p_medication_reminder_alerts_enabled boolean,
  p_browser_push_notifications_enabled boolean,
  p_appointment_reminder_hours_before integer,
  p_second_reminder_hours_before integer,
  p_date_format text,
  p_time_format text,
  p_records_per_page integer,
  p_dashboard_refresh_seconds integer
)
returns table (
  system_name text,
  clinic_name text,
  clinic_email text,
  contact_number text,
  clinic_address text,
  timezone text,
  clinic_opening_time time without time zone,
  clinic_closing_time time without time zone,
  default_appointment_duration_minutes integer,
  booking_interval_minutes integer,
  cancellation_window_hours integer,
  maximum_daily_appointments integer,
  appointment_reminders_enabled boolean,
  medication_reminder_alerts_enabled boolean,
  browser_push_notifications_enabled boolean,
  appointment_reminder_hours_before integer,
  second_reminder_hours_before integer,
  date_format text,
  time_format text,
  records_per_page integer,
  dashboard_refresh_seconds integer
)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_role text;
  v_account_status text;
  v_section text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_section, ''::text)));
  v_system_name text := pg_catalog.btrim(coalesce(p_system_name, ''::text));
  v_clinic_name text := pg_catalog.btrim(coalesce(p_clinic_name, ''::text));
  v_clinic_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_clinic_email, ''::text)));
  v_contact_number text := pg_catalog.btrim(coalesce(p_contact_number, ''::text));
  v_clinic_address text := pg_catalog.btrim(coalesce(p_clinic_address, ''::text));
  v_timezone text := pg_catalog.btrim(coalesce(p_timezone, ''::text));
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

  if v_section not in ('general', 'appointments', 'notifications', 'preferences') then
    raise exception 'Unsupported settings section.' using errcode = '22023';
  end if;

  if pg_catalog.char_length(v_system_name) not between 1 and 160 then
    raise exception 'System name must contain between 1 and 160 characters.' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_clinic_name) not between 1 and 160 then
    raise exception 'Clinic name must contain between 1 and 160 characters.' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_clinic_email) > 254
     or (v_clinic_email <> '' and v_clinic_email !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$') then
    raise exception 'Clinic email is invalid.' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_contact_number) > 50 then
    raise exception 'Contact number cannot exceed 50 characters.' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_clinic_address) > 500 then
    raise exception 'Clinic address cannot exceed 500 characters.' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_timezone) not between 1 and 80 then
    raise exception 'Timezone must contain between 1 and 80 characters.' using errcode = '22023';
  end if;

  if p_clinic_opening_time is null or p_clinic_closing_time is null
     or p_clinic_closing_time <= p_clinic_opening_time then
    raise exception 'Clinic closing time must be later than opening time.' using errcode = '22023';
  end if;
  if p_default_appointment_duration_minutes is null
     or p_default_appointment_duration_minutes not between 15 and 240 then
    raise exception 'Default appointment duration must be between 15 and 240 minutes.' using errcode = '22023';
  end if;
  if p_booking_interval_minutes is null or p_booking_interval_minutes not between 5 and 240 then
    raise exception 'Booking interval must be between 5 and 240 minutes.' using errcode = '22023';
  end if;
  if p_cancellation_window_hours is null or p_cancellation_window_hours not between 0 and 168 then
    raise exception 'Cancellation window must be between 0 and 168 hours.' using errcode = '22023';
  end if;
  if p_maximum_daily_appointments is null or p_maximum_daily_appointments not between 1 and 500 then
    raise exception 'Maximum daily appointments must be between 1 and 500.' using errcode = '22023';
  end if;

  if p_appointment_reminders_enabled is null
     or p_medication_reminder_alerts_enabled is null
     or p_browser_push_notifications_enabled is null then
    raise exception 'Notification enabled values are required.' using errcode = '22023';
  end if;
  if p_appointment_reminder_hours_before is null
     or p_appointment_reminder_hours_before not between 1 and 168 then
    raise exception 'Appointment reminder timing must be between 1 and 168 hours.' using errcode = '22023';
  end if;
  if p_second_reminder_hours_before is not null
     and (
       p_second_reminder_hours_before not between 1 and 168
       or p_second_reminder_hours_before >= p_appointment_reminder_hours_before
     ) then
    raise exception 'Second reminder timing must be positive and earlier than the primary reminder window.' using errcode = '22023';
  end if;

  if p_date_format is null or p_date_format not in ('MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD') then
    raise exception 'Unsupported date format.' using errcode = '22023';
  end if;
  if p_time_format is null or p_time_format not in ('12-hour', '24-hour') then
    raise exception 'Unsupported time format.' using errcode = '22023';
  end if;
  if p_records_per_page is null or p_records_per_page not in (10, 20, 50, 100) then
    raise exception 'Unsupported records-per-page value.' using errcode = '22023';
  end if;
  if p_dashboard_refresh_seconds is null or p_dashboard_refresh_seconds not in (30, 60, 300) then
    raise exception 'Unsupported dashboard refresh interval.' using errcode = '22023';
  end if;

  return query
  update public.system_settings as settings
  set
    system_name = case when v_section = 'general' then v_system_name else settings.system_name end,
    clinic_name = case when v_section = 'general' then v_clinic_name else settings.clinic_name end,
    clinic_email = case when v_section = 'general' then v_clinic_email else settings.clinic_email end,
    contact_number = case when v_section = 'general' then v_contact_number else settings.contact_number end,
    clinic_address = case when v_section = 'general' then v_clinic_address else settings.clinic_address end,
    timezone = case when v_section = 'general' then v_timezone else settings.timezone end,
    clinic_opening_time = case when v_section = 'appointments' then p_clinic_opening_time else settings.clinic_opening_time end,
    clinic_closing_time = case when v_section = 'appointments' then p_clinic_closing_time else settings.clinic_closing_time end,
    default_appointment_duration_minutes = case when v_section = 'appointments' then p_default_appointment_duration_minutes else settings.default_appointment_duration_minutes end,
    booking_interval_minutes = case when v_section = 'appointments' then p_booking_interval_minutes else settings.booking_interval_minutes end,
    cancellation_window_hours = case when v_section = 'appointments' then p_cancellation_window_hours else settings.cancellation_window_hours end,
    maximum_daily_appointments = case when v_section = 'appointments' then p_maximum_daily_appointments else settings.maximum_daily_appointments end,
    appointment_reminders_enabled = case when v_section = 'notifications' then p_appointment_reminders_enabled else settings.appointment_reminders_enabled end,
    medication_reminder_alerts_enabled = case when v_section = 'notifications' then p_medication_reminder_alerts_enabled else settings.medication_reminder_alerts_enabled end,
    browser_push_notifications_enabled = case when v_section = 'notifications' then p_browser_push_notifications_enabled else settings.browser_push_notifications_enabled end,
    appointment_reminder_hours_before = case when v_section = 'notifications' then p_appointment_reminder_hours_before else settings.appointment_reminder_hours_before end,
    second_reminder_hours_before = case when v_section = 'notifications' then p_second_reminder_hours_before else settings.second_reminder_hours_before end,
    date_format = case when v_section = 'preferences' then p_date_format else settings.date_format end,
    time_format = case when v_section = 'preferences' then p_time_format else settings.time_format end,
    records_per_page = case when v_section = 'preferences' then p_records_per_page else settings.records_per_page end,
    dashboard_refresh_seconds = case when v_section = 'preferences' then p_dashboard_refresh_seconds else settings.dashboard_refresh_seconds end,
    updated_at = pg_catalog.now(),
    updated_by = auth.uid()
  where settings.singleton_guard = true
  returning
    settings.system_name,
    settings.clinic_name,
    settings.clinic_email,
    settings.contact_number,
    settings.clinic_address,
    settings.timezone,
    settings.clinic_opening_time,
    settings.clinic_closing_time,
    settings.default_appointment_duration_minutes,
    settings.booking_interval_minutes,
    settings.cancellation_window_hours,
    settings.maximum_daily_appointments,
    settings.appointment_reminders_enabled,
    settings.medication_reminder_alerts_enabled,
    settings.browser_push_notifications_enabled,
    settings.appointment_reminder_hours_before,
    settings.second_reminder_hours_before,
    settings.date_format,
    settings.time_format,
    settings.records_per_page,
    settings.dashboard_refresh_seconds;

  if not found then
    raise exception 'The authoritative settings record is unavailable.' using errcode = '55000';
  end if;
end;
$function$;

alter function public.get_admin_system_settings() owner to postgres;
alter function public.update_admin_system_settings(
  text, text, text, text, text, text, text,
  time without time zone, time without time zone,
  integer, integer, integer, integer,
  boolean, boolean, boolean,
  integer, integer, text, text, integer, integer
) owner to postgres;

revoke all on function public.get_admin_system_settings()
  from public, anon, authenticated;
grant execute on function public.get_admin_system_settings()
  to authenticated, service_role;

revoke all on function public.update_admin_system_settings(
  text, text, text, text, text, text, text,
  time without time zone, time without time zone,
  integer, integer, integer, integer,
  boolean, boolean, boolean,
  integer, integer, text, text, integer, integer
) from public, anon, authenticated;
grant execute on function public.update_admin_system_settings(
  text, text, text, text, text, text, text,
  time without time zone, time without time zone,
  integer, integer, integer, integer,
  boolean, boolean, boolean,
  integer, integer, text, text, integer, integer
) to authenticated, service_role;

comment on function public.get_admin_system_settings() is
  'Returns approved operational settings to an authenticated active Admin.';
comment on function public.update_admin_system_settings(
  text, text, text, text, text, text, text,
  time without time zone, time without time zone,
  integer, integer, integer, integer,
  boolean, boolean, boolean,
  integer, integer, text, text, integer, integer
) is 'Updates one approved settings section for an authenticated active Admin and returns the safe settings record.';

-- Phase 5: remove the explicitly audited legacy RPCs before their composite
-- table return types disappear. DROP ... CASCADE is intentionally not used.
drop function if exists public.start_medication_adherence_followup(
  uuid, text, numeric, integer, integer, integer, integer, integer,
  date, date, timestamptz, text, timestamptz
);
drop function if exists public.add_medication_adherence_followup_event(
  uuid, text, text, text, timestamptz, uuid
);
drop function if exists public.update_medication_adherence_followup_status(
  uuid, text, text, text, timestamptz, text
);
drop function if exists public.get_admin_followup_oversight_queue(
  text, text, text, text, uuid, date, date, text, integer, integer
);
drop function if exists public.get_admin_followup_oversight_detail(uuid);
drop function if exists public.admin_acknowledge_medication_followup_review(uuid);
drop function if exists public.admin_reassign_medication_followup(uuid, uuid, text, timestamptz);
drop function if exists public.get_doctor_notifications(integer);
drop function if exists public.mark_doctor_notification_read(uuid);
drop function if exists public.mark_all_doctor_notifications_read();
drop function if exists public.upsert_my_doctor_push_subscription(text, text, text, bigint, text, text);
drop function if exists public.deactivate_my_doctor_push_subscription(text);
drop function if exists public.get_admin_followup_oversight_summary(date, date);
drop function if exists public.process_due_medication_followup_alerts();
drop function if exists public.claim_doctor_notification_push_delivery(uuid, uuid, integer);

-- Phase 6: explicitly remove policies and browser/service grants from retiring
-- tables. Table drops would remove policies implicitly, but keeping this phase
-- explicit makes the privilege retirement auditable.
do $retire_table_security$
declare
  v_policy record;
  v_table_name text;
begin
  for v_policy in
    select policy.schemaname, policy.tablename, policy.policyname
    from pg_catalog.pg_policies as policy
    where policy.schemaname = 'public'
      and policy.tablename in (
        'medication_adherence_followups',
        'medication_adherence_followup_events',
        'medication_adherence_followup_assignment_audits',
        'doctor_notifications',
        'medication_followup_alert_dispatches',
        'doctor_push_subscriptions',
        'doctor_notification_push_deliveries'
      )
  loop
    execute pg_catalog.format(
      'drop policy %I on %I.%I',
      v_policy.policyname, v_policy.schemaname, v_policy.tablename
    );
  end loop;

  foreach v_table_name in array array[
    'medication_adherence_followups',
    'medication_adherence_followup_events',
    'medication_adherence_followup_assignment_audits',
    'doctor_notifications',
    'medication_followup_alert_dispatches',
    'doctor_push_subscriptions',
    'doctor_notification_push_deliveries'
  ]
  loop
    if pg_catalog.to_regclass('public.' || v_table_name) is not null then
      execute pg_catalog.format(
        'revoke all privileges on table public.%I from public, anon, authenticated, service_role',
        v_table_name
      );
    end if;
  end loop;
end;
$retire_table_security$;

-- Phase 7: drop leaf notification/push/dispatch tables first, then event and
-- case tables last. Any unreviewed dependency aborts the transaction.
drop table if exists public.doctor_notification_push_deliveries;
drop table if exists public.medication_followup_alert_dispatches;
drop table if exists public.medication_adherence_followup_assignment_audits;
drop table if exists public.doctor_notifications;
drop table if exists public.doctor_push_subscriptions;
drop table if exists public.medication_adherence_followup_events;
drop table if exists public.medication_adherence_followups;

-- Trigger helpers are dropped last so a trigger outside the retired tables
-- fails this transaction instead of being removed implicitly.
drop function if exists public.set_medication_adherence_followup_updated_at();
drop function if exists public.set_doctor_notification_updated_at();
drop function if exists public.set_medication_followup_alert_dispatch_updated_at();
drop function if exists public.set_doctor_push_subscriptions_updated_at();
drop function if exists public.set_doctor_notification_push_deliveries_updated_at();

-- Phase 8: transactional verification.
do $retirement_verify$
declare
  v_remaining_relations text;
  v_remaining_functions text;
  v_dashboard_definition text;
  v_cron_matches text;
begin
  select pg_catalog.string_agg(requested.object_name, ', ' order by requested.object_name)
  into v_remaining_relations
  from (values
    ('public.medication_adherence_followups'),
    ('public.medication_adherence_followup_events'),
    ('public.medication_adherence_followup_assignment_audits'),
    ('public.doctor_notifications'),
    ('public.medication_followup_alert_dispatches'),
    ('public.doctor_push_subscriptions'),
    ('public.doctor_notification_push_deliveries')
  ) as requested(object_name)
  where pg_catalog.to_regclass(requested.object_name) is not null;

  if v_remaining_relations is not null then
    raise exception 'Retirement verification failed. Legacy relations remain: %', v_remaining_relations;
  end if;

  select pg_catalog.string_agg(routine.oid::pg_catalog.regprocedure::text, ', ' order by routine.oid::pg_catalog.regprocedure::text)
  into v_remaining_functions
  from pg_catalog.pg_proc as routine
  join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
  where namespace.nspname = 'public'
    and routine.proname in (
      'start_medication_adherence_followup',
      'add_medication_adherence_followup_event',
      'update_medication_adherence_followup_status',
      'get_admin_followup_oversight_queue',
      'get_admin_followup_oversight_detail',
      'admin_acknowledge_medication_followup_review',
      'admin_reassign_medication_followup',
      'get_doctor_notifications',
      'mark_doctor_notification_read',
      'mark_all_doctor_notifications_read',
      'upsert_my_doctor_push_subscription',
      'deactivate_my_doctor_push_subscription',
      'get_admin_followup_oversight_summary',
      'process_due_medication_followup_alerts',
      'claim_doctor_notification_push_delivery',
      'set_medication_adherence_followup_updated_at',
      'set_doctor_notification_updated_at',
      'set_medication_followup_alert_dispatch_updated_at',
      'set_doctor_push_subscriptions_updated_at',
      'set_doctor_notification_push_deliveries_updated_at'
    );

  if v_remaining_functions is not null then
    raise exception 'Retirement verification failed. Legacy functions remain: %', v_remaining_functions;
  end if;

  select pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure('public.get_admin_dashboard_summary(date,date,text)')
  ) into v_dashboard_definition;

  if v_dashboard_definition is null
     or v_dashboard_definition ~* '(get_admin_followup_oversight_summary|active_followup_alerts|critical-followups)' then
    raise exception 'Retirement verification failed. Admin Dashboard RPC still contains a legacy dependency.';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_settings'
      and column_name in ('medication_adherence_alerts_enabled', 'doctor_followup_alerts_enabled')
  ) then
    raise exception 'Retirement verification failed. Dead settings columns remain.';
  end if;

  if pg_catalog.to_regclass('cron.job') is not null then
    execute $sql$
      select pg_catalog.string_agg(jobid::text || ':' || coalesce(jobname, '<unnamed>'), ', ')
      from cron.job
      where coalesce(jobname, '') ~* '(medication.*followup|followup.*medication)'
         or coalesce(command, '') ~* '(medication[_ -].*followup|process_due_medication_followup_alerts)'
    $sql$ into v_cron_matches;

    if v_cron_matches is not null then
      raise exception 'Retirement verification failed. Matching Cron jobs remain: %', v_cron_matches;
    end if;
  end if;

  if exists (
    select 1
    from pg_catalog.pg_publication_rel as membership
    where membership.prrelid = pg_catalog.to_regclass('public.doctor_notifications')
  ) then
    raise exception 'Retirement verification failed. doctor_notifications is still published.';
  end if;

  if pg_catalog.to_regclass('public.medication_reminders') is null
     or pg_catalog.to_regclass('public.medication_reminder_occurrences') is null
     or pg_catalog.to_regclass('public.schedule') is null
     or pg_catalog.to_regclass('public.medical_records') is null then
    raise exception 'Retirement verification failed. A retained relation is missing.';
  end if;
end;
$retirement_verify$;

select pg_catalog.pg_notify('pgrst', 'reload schema');
commit;

-- Edge Function cleanup is deliberately outside SQL. Only after this migration
-- commits and external callers are confirmed absent:
--   supabase functions delete send-doctor-followup-web-push --project-ref <ref>
-- Do not delete send-patient-web-push.

-- COMMENTED rollback strategy:
-- 1. Before execution, take a restorable database backup and export the seven
--    legacy tables if history retention is required.
-- 2. Cron unscheduling, publication membership, and RPC definitions can be
--    recreated from the pre-retirement Git revision.
-- 3. Dropped table data cannot be reconstructed by a down migration. Restore
--    the backup or the exported rows, then redeploy the prior Edge Function.
-- 4. The two removed settings booleans can be re-added with their previous
--    defaults, followed by reinstating the previous RPC signatures.

