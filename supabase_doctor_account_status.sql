-- ============================================================
-- REVIEW ONLY: Doctor account-access status on public.profiles
-- Do not run automatically from the frontend.
-- ============================================================
--
-- Purpose:
-- - Store Doctor login/access state on public.profiles, where the
--   authenticated role already lives.
-- - Preserve doctor_personal_information, doctor_professional_information,
--   schedules, appointments, medical records, and auth.users rows.
-- - Deactivation is enforced by application access checks and, after
--   review, RLS policies that require an active Doctor profile.

begin;

alter table public.profiles
  add column if not exists account_status text not null default 'active',
  add column if not exists deactivated_at timestamptz,
  add column if not exists deactivated_by uuid,
  add column if not exists reactivated_at timestamptz,
  add column if not exists reactivated_by uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_account_status_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_account_status_check
      check (account_status in ('active', 'inactive'));
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_deactivated_by_fkey'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_deactivated_by_fkey
      foreign key (deactivated_by)
      references auth.users(id)
      on delete set null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_reactivated_by_fkey'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_reactivated_by_fkey
      foreign key (reactivated_by)
      references auth.users(id)
      on delete set null;
  end if;
end;
$$;

create index if not exists profiles_role_account_status_idx
on public.profiles (lower(role), account_status);

-- Suggested manual review query before running:
-- select role, account_status, count(*)
-- from public.profiles
-- group by role, account_status
-- order by role, account_status;

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

create or replace function public.is_active_doctor_profile(user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from public.profiles
    where public.profiles.id = user_id
      and lower(trim(coalesce(public.profiles.role, ''))) = 'doctor'
      and public.profiles.account_status = 'active'
  );
$$;

revoke execute on function public.is_active_doctor_profile(uuid) from public;
grant execute on function public.is_active_doctor_profile(uuid) to authenticated;

alter table public.profiles enable row level security;

grant select, update
on public.profiles
to authenticated;

-- Additive Admin-only update policy for profile account access.
-- This avoids recursive RLS by calling public.is_current_admin()
-- instead of selecting public.profiles inside a public.profiles policy.
drop policy if exists "Admins can update profile account access" on public.profiles;
create policy "Admins can update profile account access"
on public.profiles
for update
to authenticated
using ((select public.is_current_admin()))
with check ((select public.is_current_admin()));

-- Optional Doctor-owned RLS hardening examples:
-- For tables where Doctors can read or update their own clinical data,
-- add this predicate to the existing Doctor policies:
--
-- public.is_active_doctor_profile(auth.uid())
--
-- Example:
-- alter policy "Doctors can view schedules"
-- on public.schedule
-- using (
--   public.is_active_doctor_profile(auth.uid())
--   and <existing doctor ownership predicate>
-- );
--
-- Apply the same active-Doctor predicate to Doctor-owned policies on
-- schedule, maternal_appointments, reminders, patients, medical_records,
-- and any Doctor profile information tables that currently permit
-- inactive Doctors through authenticated access.

notify pgrst, 'reload schema';

-- Verification queries, for manual use after applying:
-- select
--   id,
--   full_name,
--   role,
--   account_status,
--   deactivated_at,
--   reactivated_at
-- from public.profiles
-- where lower(trim(role)) = 'doctor'
-- order by full_name;
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

commit;
