-- ============================================================
-- Maternal Care - Allow Patient medication schedule target
-- ============================================================
-- REVIEW ONLY: Run manually in the Supabase SQL Editor only after review.
--
-- Scope:
--   - Preserve the existing patient_notifications target-path CHECK expression.
--   - Add /patient/reminders/medications to that CHECK expression.
--   - Add the same route to create_patient_notification(...) validation.
--
-- This migration does not change RLS, grants, roles, Cron, webhooks,
-- notification delivery, Web Push, service-worker logic, or React code.
-- ============================================================

/*
Preflight: inspect the matching CHECK constraint.

select
  constraint_row.conname as constraint_name,
  pg_catalog.pg_get_constraintdef(constraint_row.oid, true) as constraint_definition
from pg_catalog.pg_constraint as constraint_row
where constraint_row.conrelid =
      pg_catalog.to_regclass('public.patient_notifications')
  and constraint_row.contype = 'c'
  and constraint_row.conname = 'patient_notifications_target_path_check';

Preflight: inspect the RPC signature, result, security setting, search_path,
owner, and current grants.

select
  procedure_row.oid::pg_catalog.regprocedure as function_signature,
  pg_catalog.pg_get_function_result(procedure_row.oid) as return_type,
  procedure_row.prosecdef as security_definer,
  procedure_row.proconfig as function_settings,
  pg_catalog.pg_get_userbyid(procedure_row.proowner) as function_owner,
  procedure_row.proacl as function_acl
from pg_catalog.pg_proc as procedure_row
where procedure_row.oid = pg_catalog.to_regprocedure(
  'public.create_patient_notification(uuid,text,text,text,text,text,uuid,uuid,uuid)'
);

Preflight: inspect the complete current RPC definition.

select pg_catalog.pg_get_functiondef(
  pg_catalog.to_regprocedure(
    'public.create_patient_notification(uuid,text,text,text,text,text,uuid,uuid,uuid)'
  )
);

Preflight: list target paths currently present in the CHECK definition.

with target_constraint as (
  select pg_catalog.pg_get_constraintdef(constraint_row.oid, true) as definition
  from pg_catalog.pg_constraint as constraint_row
  where constraint_row.conrelid =
        pg_catalog.to_regclass('public.patient_notifications')
    and constraint_row.contype = 'c'
    and constraint_row.conname = 'patient_notifications_target_path_check'
),
allowed_paths as (
  select target_match[1] as target_path
  from target_constraint
  cross join lateral pg_catalog.regexp_matches(
    target_constraint.definition,
    '''(/patient/[^'']+)''',
    'g'
  ) as target_match
)
select distinct target_path
from allowed_paths
order by target_path;
*/

begin;

do $constraint_update$
declare
  v_constraint_expression text;
begin
  if pg_catalog.to_regclass('public.patient_notifications') is null then
    raise exception
      'public.patient_notifications does not exist. Apply the reviewed base notification schema first.';
  end if;

  if pg_catalog.to_regprocedure(
    'public.create_patient_notification(uuid,text,text,text,text,text,uuid,uuid,uuid)'
  ) is null then
    raise exception
      'The expected create_patient_notification(uuid,text,text,text,text,text,uuid,uuid,uuid) function was not found. Review the live schema before applying this migration.';
  end if;

  select pg_catalog.pg_get_expr(
    constraint_row.conbin,
    constraint_row.conrelid,
    true
  )
  into v_constraint_expression
  from pg_catalog.pg_constraint as constraint_row
  where constraint_row.conrelid =
        'public.patient_notifications'::pg_catalog.regclass
    and constraint_row.contype = 'c'
    and constraint_row.conname = 'patient_notifications_target_path_check';

  if v_constraint_expression is null then
    raise exception
      'patient_notifications_target_path_check was not found. Review the live schema before applying this migration.';
  end if;

  if pg_catalog.strpos(
    v_constraint_expression,
    '/patient/reminders/medications'
  ) = 0 then
    alter table public.patient_notifications
      drop constraint patient_notifications_target_path_check;

    execute pg_catalog.format(
      'alter table public.patient_notifications add constraint %I check ((%s) or target_path = %L)',
      'patient_notifications_target_path_check',
      v_constraint_expression,
      '/patient/reminders/medications'
    );
  end if;
end;
$constraint_update$;

create or replace function public.create_patient_notification(
  p_patient_id uuid,
  p_type text,
  p_title text,
  p_message text,
  p_target_path text default null,
  p_priority text default 'normal',
  p_related_appointment_id uuid default null,
  p_related_medical_record_id uuid default null,
  p_related_reminder_id uuid default null
)
returns public.patient_notifications
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_type text := lower(pg_catalog.btrim(coalesce(p_type, '')));
  v_title text := pg_catalog.btrim(coalesce(p_title, ''));
  v_message text := pg_catalog.btrim(coalesce(p_message, ''));
  v_target_path text := nullif(pg_catalog.btrim(coalesce(p_target_path, '')), '');
  v_priority text := lower(pg_catalog.btrim(coalesce(p_priority, 'normal')));
  v_patient_user_id uuid;
  v_notification public.patient_notifications;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;

  select lower(pg_catalog.btrim(coalesce(profile.role, '')))
  into v_role
  from public.profiles as profile
  where profile.id = auth.uid();

  if v_role is null or v_role not in ('admin', 'doctor', 'staff') then
    raise exception 'Only authenticated Doctors, Staff, or Admins can create Patient notifications.'
      using errcode = '42501';
  end if;

  select patient.user_id
  into v_patient_user_id
  from public.patients as patient
  where patient.id = p_patient_id
    and patient.user_id is not null
    and patient.account_status = 'active'
    and patient.archived_at is null
    and lower(pg_catalog.btrim(coalesce(patient.status, '')))
        not in ('archived', 'deleted');

  if not found then
    raise exception 'The selected Patient must be active and linked to a Patient account.'
      using errcode = 'P0002';
  end if;

  if v_type not in (
    'appointment_created',
    'appointment_reminder',
    'appointment_rescheduled',
    'appointment_cancelled',
    'medication_reminder',
    'doctor_reminder',
    'health_tip',
    'medical_record_available',
    'laboratory_result_available',
    'prescription_available',
    'account_notification',
    'general'
  ) then
    raise exception 'Unsupported Patient notification type.'
      using errcode = '22023';
  end if;

  if char_length(v_title) < 1 or char_length(v_title) > 120 then
    raise exception 'Notification title must contain 1 to 120 characters.'
      using errcode = '22023';
  end if;

  if char_length(v_message) < 1 or char_length(v_message) > 500 then
    raise exception 'Notification message must contain 1 to 500 characters.'
      using errcode = '22023';
  end if;

  if v_priority not in ('normal', 'important', 'urgent') then
    raise exception 'Unsupported Patient notification priority.'
      using errcode = '22023';
  end if;

  if v_target_path is null then
    v_target_path := case
      when v_type in (
        'appointment_created',
        'appointment_reminder',
        'appointment_rescheduled',
        'appointment_cancelled'
      ) then '/patient/appointments'
      when v_type in ('medication_reminder', 'doctor_reminder', 'health_tip')
        then '/patient/reminders'
      when v_type in (
        'medical_record_available',
        'laboratory_result_available',
        'prescription_available'
      ) then '/patient/medical-records'
      when v_type = 'account_notification' then '/patient/profile'
      else '/patient/reminders'
    end;
  end if;

  if v_target_path not in (
    '/patient/dashboard',
    '/patient/appointments',
    '/patient/reminders',
    '/patient/reminders/medications',
    '/patient/medical-records',
    '/patient/profile',
    '/patient/settings'
  ) then
    raise exception 'Notification target must be an allowed internal Patient route.'
      using errcode = '22023';
  end if;

  if p_related_appointment_id is not null and not exists (
    select 1
    from public.schedule as appointment
    where appointment.id = p_related_appointment_id
      and appointment.patient_id = p_patient_id
  ) then
    raise exception 'The related appointment does not belong to the selected Patient.'
      using errcode = '23503';
  end if;

  if p_related_medical_record_id is not null and not exists (
    select 1
    from public.medical_records as medical_record
    where medical_record.id = p_related_medical_record_id
      and medical_record.patient_id = p_patient_id
  ) then
    raise exception 'The related medical record does not belong to the selected Patient.'
      using errcode = '23503';
  end if;

  if p_related_reminder_id is not null and not exists (
    select 1
    from public.reminders as reminder
    where reminder.id = p_related_reminder_id
      and reminder.patient_id = p_patient_id
  ) then
    raise exception 'The related reminder does not belong to the selected Patient.'
      using errcode = '23503';
  end if;

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
    p_patient_id,
    v_patient_user_id,
    auth.uid(),
    v_role,
    v_type,
    v_title,
    v_message,
    v_target_path,
    p_related_appointment_id,
    p_related_medical_record_id,
    p_related_reminder_id,
    v_priority
  )
  returning * into v_notification;

  return v_notification;
end;
$function$;

commit;

/*
Verification: confirm the named CHECK and exact RPC signature still exist.

select
  constraint_row.conname as constraint_name,
  pg_catalog.pg_get_constraintdef(constraint_row.oid, true) as constraint_definition
from pg_catalog.pg_constraint as constraint_row
where constraint_row.conrelid =
      pg_catalog.to_regclass('public.patient_notifications')
  and constraint_row.contype = 'c'
  and constraint_row.conname = 'patient_notifications_target_path_check';

select
  procedure_row.oid::pg_catalog.regprocedure as function_signature,
  pg_catalog.pg_get_function_result(procedure_row.oid) as return_type,
  procedure_row.prosecdef as security_definer,
  procedure_row.proconfig as function_settings,
  pg_catalog.pg_get_userbyid(procedure_row.proowner) as function_owner,
  procedure_row.proacl as function_acl
from pg_catalog.pg_proc as procedure_row
where procedure_row.oid = pg_catalog.to_regprocedure(
  'public.create_patient_notification(uuid,text,text,text,text,text,uuid,uuid,uuid)'
);

Verification: inspect both updated definitions.

select pg_catalog.pg_get_functiondef(
  pg_catalog.to_regprocedure(
    'public.create_patient_notification(uuid,text,text,text,text,text,uuid,uuid,uuid)'
  )
);

Verification: verify every old route and the new medication route are listed,
while an arbitrary external URL is not listed. This does not insert a
notification.

with target_constraint as (
  select pg_catalog.pg_get_constraintdef(constraint_row.oid, true) as definition
  from pg_catalog.pg_constraint as constraint_row
  where constraint_row.conrelid =
        pg_catalog.to_regclass('public.patient_notifications')
    and constraint_row.contype = 'c'
    and constraint_row.conname = 'patient_notifications_target_path_check'
),
allowed_paths as (
  select target_match[1] as target_path
  from target_constraint
  cross join lateral pg_catalog.regexp_matches(
    target_constraint.definition,
    '''(/patient/[^'']+)''',
    'g'
  ) as target_match
),
candidates(target_path, expected_allowed) as (
  values
    ('/patient/dashboard', true),
    ('/patient/appointments', true),
    ('/patient/reminders', true),
    ('/patient/reminders/medications', true),
    ('/patient/medical-records', true),
    ('/patient/profile', true),
    ('/patient/settings', true),
    ('https://example.com/unsafe', false)
)
select
  candidates.target_path,
  candidates.expected_allowed,
  exists (
    select 1
    from allowed_paths
    where allowed_paths.target_path = candidates.target_path
  ) as listed_by_target_path_check
from candidates
order by candidates.target_path;

Verification: confirm the RPC definition contains the new route and still
contains every old route. This does not execute the RPC.

with rpc_definition as (
  select pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure(
      'public.create_patient_notification(uuid,text,text,text,text,text,uuid,uuid,uuid)'
    )
  ) as definition
),
candidates(target_path, expected_allowed) as (
  values
    ('/patient/dashboard', true),
    ('/patient/appointments', true),
    ('/patient/reminders', true),
    ('/patient/reminders/medications', true),
    ('/patient/medical-records', true),
    ('/patient/profile', true),
    ('/patient/settings', true),
    ('https://example.com/unsafe', false)
)
select
  candidates.target_path,
  candidates.expected_allowed,
  pg_catalog.strpos(rpc_definition.definition, candidates.target_path) > 0
    as listed_by_create_patient_notification
from candidates
cross join rpc_definition
order by candidates.target_path;
*/
