-- ============================================================
-- Maternal Care - Patient PWA in-app notifications (Phase 1)
-- ============================================================
-- Review and run this file manually in the Supabase SQL Editor.
-- This file does not implement Web Push, service-worker push,
-- Edge Functions, VAPID, Firebase, or scheduled delivery.
--
-- Existing relationship verified by the application and setup SQL:
--   auth.uid() -> public.patients.user_id -> public.patients.id
-- Existing related ID types verified as uuid:
--   public.schedule.id
--   public.medical_records.id
--   public.reminders.id
-- ============================================================

begin;

create table if not exists public.patient_notifications (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null,
  user_id uuid,
  created_by uuid,
  created_by_role text,
  type text not null,
  title text not null,
  message text not null,
  target_path text,
  related_appointment_id uuid,
  related_medical_record_id uuid,
  related_reminder_id uuid,
  priority text not null default 'normal',
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint patient_notifications_patient_id_fkey
    foreign key (patient_id)
    references public.patients(id)
    on delete cascade,
  constraint patient_notifications_user_id_fkey
    foreign key (user_id)
    references auth.users(id)
    on delete set null,
  constraint patient_notifications_created_by_fkey
    foreign key (created_by)
    references auth.users(id)
    on delete set null,
  constraint patient_notifications_appointment_id_fkey
    foreign key (related_appointment_id)
    references public.schedule(id)
    on delete set null,
  constraint patient_notifications_medical_record_id_fkey
    foreign key (related_medical_record_id)
    references public.medical_records(id)
    on delete set null,
  constraint patient_notifications_reminder_id_fkey
    foreign key (related_reminder_id)
    references public.reminders(id)
    on delete set null,
  constraint patient_notifications_type_check
    check (
      type in (
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
      )
    ),
  constraint patient_notifications_priority_check
    check (priority in ('normal', 'important', 'urgent')),
  constraint patient_notifications_created_by_role_check
    check (
      created_by_role is null
      or created_by_role in ('admin', 'doctor', 'staff')
    ),
  constraint patient_notifications_title_check
    check (
      char_length(btrim(title)) between 1 and 120
      and title = btrim(title)
    ),
  constraint patient_notifications_message_check
    check (
      char_length(btrim(message)) between 1 and 500
      and message = btrim(message)
    ),
  constraint patient_notifications_target_path_check
    check (
      target_path is null
      or (
        char_length(target_path) <= 255
        and target_path in (
          '/patient/dashboard',
          '/patient/appointments',
          '/patient/reminders',
          '/patient/medical-records',
          '/patient/profile',
          '/patient/settings'
        )
      )
    )
);

comment on table public.patient_notifications is
  'Patient-owned in-app notification inbox. Preview messages must not contain sensitive clinical details.';
comment on column public.patient_notifications.user_id is
  'Snapshot of the linked Patient auth user. Ownership is always verified through patients.user_id.';
comment on column public.patient_notifications.message is
  'Privacy-safe preview only; detailed clinical data belongs on the authenticated target page.';

create index if not exists patient_notifications_patient_created_idx
  on public.patient_notifications (patient_id, created_at desc);

create index if not exists patient_notifications_user_created_idx
  on public.patient_notifications (user_id, created_at desc)
  where user_id is not null;

create index if not exists patient_notifications_patient_read_idx
  on public.patient_notifications (patient_id, read_at);

create index if not exists patient_notifications_unread_idx
  on public.patient_notifications (patient_id, created_at desc)
  where read_at is null;

create or replace function public.set_patient_notifications_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;

drop trigger if exists patient_notifications_set_updated_at
  on public.patient_notifications;

create trigger patient_notifications_set_updated_at
before update on public.patient_notifications
for each row
execute function public.set_patient_notifications_updated_at();

alter table public.patient_notifications enable row level security;

drop policy if exists "Patients can read own notifications"
  on public.patient_notifications;
create policy "Patients can read own notifications"
on public.patient_notifications
for select
to authenticated
using (
  exists (
    select 1
    from public.patients as patient
    where patient.id = patient_notifications.patient_id
      and patient.user_id = auth.uid()
      and patient.account_status = 'active'
      and patient.archived_at is null
      and lower(trim(coalesce(patient.status, ''))) not in ('archived', 'deleted')
  )
);

-- No broad clinic SELECT policy is created in Phase 1.
-- Doctor, Staff, and Admin users create notifications only through
-- public.create_patient_notification(...).

-- No INSERT, UPDATE, or DELETE policy is intentionally created.
-- Patients receive SELECT only and can change read state only through
-- the ownership-verifying SECURITY DEFINER RPCs below.
revoke all on public.patient_notifications from public, anon, authenticated;
grant select on public.patient_notifications to authenticated;

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

create or replace function public.mark_patient_notification_read(
  p_notification_id uuid
)
returns public.patient_notifications
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_notification public.patient_notifications;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;

  update public.patient_notifications as notification
  set read_at = coalesce(notification.read_at, pg_catalog.now())
  where notification.id = p_notification_id
    and exists (
      select 1
      from public.patients as patient
      where patient.id = notification.patient_id
        and patient.user_id = auth.uid()
        and patient.account_status = 'active'
        and patient.archived_at is null
        and lower(pg_catalog.btrim(coalesce(patient.status, ''))) not in ('archived', 'deleted')
    )
  returning notification.* into v_notification;

  if v_notification.id is null then
    raise exception 'Notification was not found for the authenticated Patient.'
      using errcode = '42501';
  end if;

  return v_notification;
end;
$function$;

create or replace function public.mark_all_patient_notifications_read()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_updated_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;

  update public.patient_notifications as notification
  set read_at = pg_catalog.now()
  where notification.read_at is null
    and exists (
      select 1
      from public.patients as patient
      where patient.id = notification.patient_id
        and patient.user_id = auth.uid()
        and patient.account_status = 'active'
        and patient.archived_at is null
        and lower(pg_catalog.btrim(coalesce(patient.status, ''))) not in ('archived', 'deleted')
    );

  get diagnostics v_updated_count = row_count;
  return v_updated_count;
end;
$function$;

revoke all on function public.set_patient_notifications_updated_at()
  from public, anon, authenticated;

revoke all on function public.create_patient_notification(
  uuid, text, text, text, text, text, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.create_patient_notification(
  uuid, text, text, text, text, text, uuid, uuid, uuid
) to authenticated;

revoke all on function public.mark_patient_notification_read(uuid)
  from public, anon, authenticated;
grant execute on function public.mark_patient_notification_read(uuid)
  to authenticated;

revoke all on function public.mark_all_patient_notifications_read()
  from public, anon, authenticated;
grant execute on function public.mark_all_patient_notifications_read()
  to authenticated;

do $realtime$
begin
  if exists (
    select 1
    from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'patient_notifications'
  ) then
    alter publication supabase_realtime
      add table public.patient_notifications;
  end if;
end;
$realtime$;

notify pgrst, 'reload schema';

commit;

-- ============================================================
-- Manual Phase 1 test - DO NOT run with placeholder values.
-- ============================================================
-- 1. Sign in to the application as an active Doctor, Staff, or Admin.
-- 2. From that authenticated Supabase client/session, call:
--
-- select public.create_patient_notification(
--   p_patient_id := 'REPLACE-WITH-PATIENT-UUID'::uuid,
--   p_type := 'appointment_reminder',
--   p_title := 'Upcoming appointment',
--   p_message := 'You have an upcoming clinic appointment.',
--   p_target_path := '/patient/appointments',
--   p_priority := 'important',
--   p_related_appointment_id := null,
--   p_related_medical_record_id := null,
--   p_related_reminder_id := null
-- );
--
-- Do not put diagnoses, laboratory values, medication names, or confidential
-- assessment text in title/message previews.
--
-- 3. With the linked Patient PWA already open, confirm Realtime adds the row.
-- 4. Click the item and confirm read_at is set and the safe target opens.
-- 5. Verify isolation with a second Patient and an unauthenticated session.
