-- ============================================================
-- REVIEW ONLY: Patient account-access status separation
-- Do not run automatically from the frontend.
-- ============================================================
--
-- Purpose:
-- - Preserve public.patients.status for patient record lifecycle
--   such as active or archived.
-- - Add public.patients.account_status for application login/access:
--   pending_activation, active, inactive.
-- - Keep Supabase Auth users intact. Deactivation is enforced by
--   application access checks and RLS, not by deleting auth.users rows.
-- - Patient activation states are stored in public.patients.account_status.
--   public.profiles.account_status keeps its existing valid values and must not
--   receive pending_activation.

begin;

alter table public.patients
  add column if not exists account_status text not null default 'pending_activation',
  add column if not exists activated_at timestamptz,
  add column if not exists activated_by uuid,
  add column if not exists deactivated_at timestamptz,
  add column if not exists deactivated_by uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'patients_account_status_check'
      and conrelid = 'public.patients'::regclass
  ) then
    alter table public.patients
      add constraint patients_account_status_check
      check (account_status in ('pending_activation', 'active', 'inactive'));
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'patients_activated_by_fkey'
      and conrelid = 'public.patients'::regclass
  ) then
    alter table public.patients
      add constraint patients_activated_by_fkey
      foreign key (activated_by)
      references auth.users(id)
      on delete set null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'patients_deactivated_by_fkey'
      and conrelid = 'public.patients'::regclass
  ) then
    alter table public.patients
      add constraint patients_deactivated_by_fkey
      foreign key (deactivated_by)
      references auth.users(id)
      on delete set null;
  end if;
end;
$$;

create index if not exists patients_account_status_idx
on public.patients (account_status);

create or replace function public.is_current_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from public.profiles
    where public.profiles.id = auth.uid()
      and lower(trim(coalesce(public.profiles.role, ''))) = 'admin'
  );
$$;

revoke execute on function public.is_current_admin() from public;
grant execute on function public.is_current_admin() to authenticated;

-- Classify existing rows before patient-owned policies require account_status = 'active'.
-- This only updates rows still holding the newly added default and does not overwrite
-- already explicit active or inactive account_status values.
-- A linked Auth user is not automatically active; Admin activation is required.
update public.patients
set account_status = case
  when lower(trim(coalesce(status, ''))) in ('archived', 'deleted') then 'pending_activation'
  when lower(trim(coalesce(status, ''))) in ('inactive', 'deactivated', 'disabled') then 'inactive'
  else 'pending_activation'
end
where account_status = 'pending_activation';

alter table public.patients enable row level security;

grant select, insert, update
on public.patients
to authenticated;

drop policy if exists "Patients can read own patient record" on public.patients;
create policy "Patients can read own patient record"
on public.patients
for select
to authenticated
using (
  user_id = auth.uid()
  and account_status = 'active'
  and lower(trim(coalesce(status, ''))) not in ('archived', 'deleted')
);

drop policy if exists "Patients can update own patient record" on public.patients;
create policy "Patients can update own patient record"
on public.patients
for update
to authenticated
using (
  user_id = auth.uid()
  and account_status = 'active'
  and lower(trim(coalesce(status, ''))) not in ('archived', 'deleted')
)
with check (
  user_id = auth.uid()
  and account_status = 'active'
  and lower(trim(coalesce(status, ''))) not in ('archived', 'deleted')
);

-- The existing clinic policy may already allow admin/doctor/staff updates.
-- This Admin-specific policy is additive and keeps account-status changes
-- available to authenticated Admin users if clinic policies are tightened.
drop policy if exists "Admins can update patient account access" on public.patients;
create policy "Admins can update patient account access"
on public.patients
for update
to authenticated
using ((select public.is_current_admin()))
with check ((select public.is_current_admin()));

-- Optional clinical-data RLS hardening for patient-owned reads.
-- Review existing policy names before running in a shared database.
--
-- For policies such as "Patients can view own schedules", add:
-- exists (
--   select 1
--   from public.patients
--   where patients.user_id = auth.uid()
--     and patients.account_status = 'active'
--     and lower(trim(coalesce(patients.status, ''))) not in ('archived', 'deleted')
--     and schedule.patient_id::text = patients.id::text
-- )
--
-- Apply the same active-account predicate to patient-owned reminders,
-- medication_reminders, patient_obstetric_history, patient_medical_history,
-- patient_initial_assessment, and medical_records policies where present.

notify pgrst, 'reload schema';

-- Verification queries, for manual use after applying:
-- select
--   id,
--   full_name,
--   patient_id,
--   user_id,
--   status,
--   account_status,
--   activated_at,
--   deactivated_at
-- from public.patients
-- order by created_at desc nulls last;
--
-- select role, account_status, count(*)
-- from public.profiles
-- group by role, account_status
-- order by role, account_status;
--
-- select status, account_status, count(*)
-- from public.patients
-- group by status, account_status
-- order by status, account_status;
--
-- Manual review for linked Patient accounts that are already marked active.
-- Do not bulk-update these rows without confirming Admin activation history.
-- select
--   patients.id,
--   patients.patient_id,
--   patients.full_name,
--   patients.user_id,
--   patients.account_status,
--   patients.registration_status,
--   patients.control_used_at,
--   patients.created_at
-- from public.patients as patients
-- where patients.user_id is not null
--   and patients.account_status = 'active'
-- order by patients.created_at desc nulls last;

commit;
