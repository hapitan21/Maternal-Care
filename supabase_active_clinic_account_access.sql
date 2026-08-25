-- ============================================================
-- REVIEW ONLY: Active Doctor and Staff account RLS enforcement
-- Do not execute automatically from the application.
-- ============================================================
--
-- Repository policy inventory used as the source of truth:
-- - supabase_schedule_policies.sql
-- - supabase_patient_archive_cleanup.sql
-- - supabase_patient_login_flow.sql
-- - supabase_patient_history_tables.sql
-- - supabase_staff_appointment_reminder.sql
-- - supabase_medication_reminders_policies.sql
-- - supabase_doctor_information_tables.sql
-- - supabase_staff_account_status.sql
-- - supabase_doctor_medication_adherence_read.sql
-- - supabase_staff_preconsultation_intake.sql
-- - supabase_staff_walkin_registration.sql
-- - supabase_staff_account_settings_email_change.sql
--
-- Proven role/ownership policies changed below:
-- schedule: Clinic users can manage schedules (ALL)
-- patients: Clinic users can manage patients (legacy ALL), plus canonical
--   Clinic users can read/insert/update patients policies
-- patient_login: Clinic users can manage patient login rows (ALL)
-- patient_personal_information:
--   Clinic users can manage patient personal information (ALL)
-- patient_obstetric_history:
--   Clinic users can manage patient obstetric history (ALL)
-- patient_medical_history:
--   Clinic users can manage patient medical history (ALL)
-- patient_initial_assessment:
--   Clinic users can manage patient initial assessment (ALL)
-- reminders: all clinic-role SELECT/INSERT/UPDATE/DELETE policies listed below
-- medication_reminders: Clinic users can manage medication reminders (ALL)
-- doctor_personal_information:
--   Doctor users can manage own personal information (ALL)
-- doctor_professional_information:
--   Doctor users can manage own professional information (ALL)
-- medication_reminder_occurrences:
--   Doctors can read medication reminder occurrences (SELECT)
-- staff_visit_intake: clinic read, Staff insert, and Staff update policies
-- staff_walkin_registration_reservations:
--   Staff can read own walk-in reservations (SELECT)
-- doctor_account_settings: Staff own SELECT/INSERT/UPDATE policies
--
-- Before: Doctor/Staff access depended on normalized role or row ownership.
-- After: the same operation and ownership predicates remain, while every
-- Doctor/Staff branch also requires normalized account_status = 'active'.
-- Admin branches are preserved. Patient-owned policies are not dropped.
--
-- Definitions unavailable in the repository and intentionally not modified:
-- - public.medical_records: no CREATE POLICY definition was found.
-- - appointment tables: no CREATE POLICY definition was found.
-- Review live pg_policies output for those tables before creating a separate,
-- schema-confirmed migration. This file does not guess their policy names.

-- Pre-install inventory (run manually before applying):
-- select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
-- from pg_catalog.pg_policies
-- where schemaname = 'public'
--   and tablename in (
--     'schedule', 'patients', 'patient_login', 'patient_personal_information',
--     'patient_obstetric_history', 'patient_medical_history',
--     'patient_initial_assessment', 'reminders', 'medication_reminders',
--     'doctor_personal_information', 'doctor_professional_information',
--     'staff_personal_information', 'staff_professional_information',
--     'medication_reminder_occurrences', 'staff_visit_intake',
--     'staff_walkin_registration_reservations', 'doctor_account_settings',
--     'medical_records'
--   )
-- order by tablename, policyname;

begin;

do $preflight$
declare
  missing_objects text;
begin
  with required_tables(table_name) as (
    values
      ('profiles'), ('schedule'), ('patients'), ('patient_login'),
      ('patient_personal_information'), ('patient_obstetric_history'),
      ('patient_medical_history'), ('patient_initial_assessment'),
      ('reminders'), ('medication_reminders'),
      ('doctor_personal_information'), ('doctor_professional_information'),
      ('medication_reminder_occurrences'), ('staff_visit_intake'),
      ('staff_walkin_registration_reservations'), ('doctor_account_settings')
  ), missing_tables as (
    select 'table public.' || required.table_name as object_name
    from required_tables as required
    where pg_catalog.to_regclass('public.' || required.table_name) is null
  ), required_columns(table_name, column_name) as (
    values
      ('profiles', 'id'), ('profiles', 'role'), ('profiles', 'account_status'),
      ('schedule', 'id'), ('schedule', 'status'),
      ('patients', 'user_id'),
      ('doctor_personal_information', 'auth_user_id'),
      ('doctor_professional_information', 'auth_user_id'),
      ('reminders', 'reminder_type'), ('reminders', 'status'),
      ('reminders', 'schedule_id'),
      ('staff_walkin_registration_reservations', 'reserved_by'),
      ('doctor_account_settings', 'user_id')
  ), missing_columns as (
    select 'column public.' || required.table_name || '.' || required.column_name as object_name
    from required_columns as required
    where not exists (
      select 1
      from information_schema.columns as columns
      where columns.table_schema = 'public'
        and columns.table_name = required.table_name
        and columns.column_name = required.column_name
    )
  ), missing as (
    select object_name from missing_tables
    union all
    select object_name from missing_columns
  )
  select pg_catalog.string_agg(missing.object_name, ', ' order by missing.object_name)
  into missing_objects
  from missing;

  if missing_objects is not null then
    raise exception 'Active clinic account RLS preflight failed. Missing objects: %', missing_objects;
  end if;
end;
$preflight$;

-- Schedule. Patient-owned SELECT policy remains untouched.
drop policy if exists "Clinic users can manage schedules" on public.schedule;
create policy "Clinic users can manage schedules"
on public.schedule for all to authenticated
using (
  exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and (
        pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
        or (
          pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) in ('doctor', 'staff')
          and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
        )
      )
  )
)
with check (
  exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and (
        pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
        or (
          pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) in ('doctor', 'staff')
          and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
        )
      )
  )
);

-- Patients. Replace either known role-only generation with the canonical
-- SELECT/INSERT/UPDATE split. Patient-own SELECT/UPDATE policies are preserved.
drop policy if exists "Clinic users can manage patients" on public.patients;
drop policy if exists "Clinic users can read patients" on public.patients;
drop policy if exists "Clinic users can insert patients" on public.patients;
drop policy if exists "Clinic users can update patients" on public.patients;

create policy "Clinic users can read patients"
on public.patients for select to authenticated
using (
  exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and (
        pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
        or (
          pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) in ('doctor', 'staff')
          and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
        )
      )
  )
);

create policy "Clinic users can insert patients"
on public.patients for insert to authenticated
with check (
  exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and (
        pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
        or (
          pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) in ('doctor', 'staff')
          and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
        )
      )
  )
);

create policy "Clinic users can update patients"
on public.patients for update to authenticated
using (
  exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and (
        pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
        or (
          pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) in ('doctor', 'staff')
          and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
        )
      )
  )
)
with check (
  exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and (
        pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
        or (
          pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) in ('doctor', 'staff')
          and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
        )
      )
  )
);

-- Clinic-managed Patient support tables. Patient-own policies remain intact.
drop policy if exists "Clinic users can manage patient login rows" on public.patient_login;
create policy "Clinic users can manage patient login rows"
on public.patient_login for all to authenticated
using (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) in ('doctor', 'staff')
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
)
with check (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) in ('doctor', 'staff')
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
);

drop policy if exists "Clinic users can manage patient personal information" on public.patient_personal_information;
create policy "Clinic users can manage patient personal information"
on public.patient_personal_information for all to authenticated
using (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) in ('doctor', 'staff')
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
)
with check (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) in ('doctor', 'staff')
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
);

drop policy if exists "Clinic users can manage patient obstetric history" on public.patient_obstetric_history;
create policy "Clinic users can manage patient obstetric history"
on public.patient_obstetric_history for all to authenticated
using (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) in ('doctor', 'staff')
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
)
with check (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) in ('doctor', 'staff')
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
);

drop policy if exists "Clinic users can manage patient medical history" on public.patient_medical_history;
create policy "Clinic users can manage patient medical history"
on public.patient_medical_history for all to authenticated
using (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) in ('doctor', 'staff')
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
)
with check (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) in ('doctor', 'staff')
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
);

drop policy if exists "Clinic users can manage patient initial assessment" on public.patient_initial_assessment;
create policy "Clinic users can manage patient initial assessment"
on public.patient_initial_assessment for all to authenticated
using (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) in ('doctor', 'staff')
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
)
with check (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) in ('doctor', 'staff')
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
);

-- Reminders. Patient-owned SELECT remains untouched.
drop policy if exists "Clinic users can manage reminders" on public.reminders;
drop policy if exists "Clinic users can read reminders" on public.reminders;
drop policy if exists "Doctors and admins can insert reminders" on public.reminders;
drop policy if exists "Only Doctors and admins can directly insert reminders" on public.reminders;
drop policy if exists "Doctors and admins can update reminders" on public.reminders;
drop policy if exists "Doctors and admins can delete reminders" on public.reminders;
drop policy if exists "Staff can cancel appointment reminders" on public.reminders;
drop policy if exists "Reminder updates must follow clinic roles" on public.reminders;
drop policy if exists "Only Doctors and admins can delete reminders" on public.reminders;

create policy "Clinic users can read reminders"
on public.reminders for select to authenticated
using (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) in ('doctor', 'staff')
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
);

create policy "Doctors and admins can insert reminders"
on public.reminders for insert to authenticated
with check (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
);

create policy "Only Doctors and admins can directly insert reminders"
on public.reminders as restrictive for insert to authenticated
with check (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
);

create policy "Doctors and admins can update reminders"
on public.reminders for update to authenticated
using (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
)
with check (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
);

create policy "Doctors and admins can delete reminders"
on public.reminders for delete to authenticated
using (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
);

create policy "Staff can cancel appointment reminders"
on public.reminders for update to authenticated
using (
  pg_catalog.lower(coalesce(reminders.reminder_type, '')) = 'appointment'
  and exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'staff'
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')
)
with check (
  pg_catalog.lower(coalesce(reminders.reminder_type, '')) = 'appointment'
  and pg_catalog.lower(coalesce(reminders.status, '')) = 'cancelled'
  and exists (select 1 from public.schedule as schedule
    where schedule.id = reminders.schedule_id
      and pg_catalog.lower(coalesce(schedule.status, '')) in ('cancelled', 'canceled', 'cancel'))
  and exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'staff'
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')
);

create policy "Reminder updates must follow clinic roles"
on public.reminders as restrictive for update to authenticated
using (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
  or (
    pg_catalog.lower(coalesce(reminders.reminder_type, '')) = 'appointment'
    and exists (select 1 from public.profiles as profile where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'staff'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')
  )
)
with check (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
  or (
    pg_catalog.lower(coalesce(reminders.reminder_type, '')) = 'appointment'
    and pg_catalog.lower(coalesce(reminders.status, '')) = 'cancelled'
    and exists (select 1 from public.schedule as schedule
      where schedule.id = reminders.schedule_id
        and pg_catalog.lower(coalesce(schedule.status, '')) in ('cancelled', 'canceled', 'cancel'))
    and exists (select 1 from public.profiles as profile where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'staff'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')
  )
);

create policy "Only Doctors and admins can delete reminders"
on public.reminders as restrictive for delete to authenticated
using (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
);

-- Medication reminders. Patient-own SELECT remains untouched.
drop policy if exists "Clinic users can manage medication reminders" on public.medication_reminders;
create policy "Clinic users can manage medication reminders"
on public.medication_reminders for all to authenticated
using (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
)
with check (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
);

-- Doctor-owned profile information. Admin policies remain untouched.
drop policy if exists "Doctor users can manage own personal information" on public.doctor_personal_information;
create policy "Doctor users can manage own personal information"
on public.doctor_personal_information for all to authenticated
using (
  auth_user_id = auth.uid()
  and exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')
)
with check (
  auth_user_id = auth.uid()
  and exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')
);

drop policy if exists "Doctor users can manage own professional information" on public.doctor_professional_information;
create policy "Doctor users can manage own professional information"
on public.doctor_professional_information for all to authenticated
using (
  auth_user_id = auth.uid()
  and exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')
)
with check (
  auth_user_id = auth.uid()
  and exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')
);

drop policy if exists "Doctors can read medication reminder occurrences" on public.medication_reminder_occurrences;
create policy "Doctors can read medication reminder occurrences"
on public.medication_reminder_occurrences for select to authenticated
using (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')
);

-- Staff clinical intake policies.
drop policy if exists staff_visit_intake_clinic_read on public.staff_visit_intake;
create policy staff_visit_intake_clinic_read
on public.staff_visit_intake for select to authenticated
using (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) in ('doctor', 'staff')
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
);

drop policy if exists staff_visit_intake_staff_insert on public.staff_visit_intake;
create policy staff_visit_intake_staff_insert
on public.staff_visit_intake for insert to authenticated
with check (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'staff'
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
);

drop policy if exists staff_visit_intake_staff_update on public.staff_visit_intake;
create policy staff_visit_intake_staff_update
on public.staff_visit_intake for update to authenticated
using (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'staff'
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
)
with check (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'staff'
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')))
);

-- Staff-owned administrative support data.
drop policy if exists "Staff can read own walk-in reservations" on public.staff_walkin_registration_reservations;
create policy "Staff can read own walk-in reservations"
on public.staff_walkin_registration_reservations for select to authenticated
using (
  exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and (
      pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      or (
        reserved_by = auth.uid()
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'staff'
        and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
      )
    ))
);

drop policy if exists "Staff can read own account settings" on public.doctor_account_settings;
create policy "Staff can read own account settings"
on public.doctor_account_settings for select to authenticated
using (
  user_id = auth.uid()
  and exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'staff'
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')
);

drop policy if exists "Staff can insert own account settings" on public.doctor_account_settings;
create policy "Staff can insert own account settings"
on public.doctor_account_settings for insert to authenticated
with check (
  user_id = auth.uid()
  and exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'staff'
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')
);

drop policy if exists "Staff can update own account settings" on public.doctor_account_settings;
create policy "Staff can update own account settings"
on public.doctor_account_settings for update to authenticated
using (
  user_id = auth.uid()
  and exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'staff'
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')
)
with check (
  user_id = auth.uid()
  and exists (select 1 from public.profiles as profile where profile.id = auth.uid()
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'staff'
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active')
);

notify pgrst, 'reload schema';
commit;

-- Post-install inventory and verification (run manually):
-- select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
-- from pg_catalog.pg_policies
-- where schemaname = 'public'
-- order by tablename, policyname;
--
-- Verify an inactive Doctor cannot SELECT/INSERT/UPDATE/DELETE through the
-- policies above, while the same active Doctor can perform the prior operation.
-- Verify the same inactive/active behavior for Staff.
-- Verify Admin access is unchanged.
-- Verify Patient-own schedule, Patient record, personal information, history,
-- medication reminder, and reminder SELECT policies still exist and work.
-- Verify no policy on public.profiles queries public.profiles (no recursion).
-- Verify public.medical_records separately after obtaining its live definition.

-- Rollback guidance:
-- Run inside a transaction and restore each changed policy from the exact
-- repository source file listed at the top of this migration. For patients,
-- restore either the legacy ALL policy from supabase_patient_login_flow.sql or
-- the canonical SELECT/INSERT/UPDATE policies from
-- supabase_patient_archive_cleanup.sql, matching the deployment baseline.
-- Restore reminders from supabase_staff_appointment_reminder.sql. Do not drop
-- Patient-own or Admin policies during rollback. Compare pg_policies before
-- commit and issue notify pgrst, 'reload schema' after restoration.
