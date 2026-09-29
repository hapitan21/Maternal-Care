-- ============================================================================
-- Stage 2 profiles security lockdown
--
-- Purpose:
--   Remove direct browser authority over sensitive public.profiles columns
--   now that trusted SECURITY DEFINER RPCs handle:
--     - Patient profile creation/repair
--     - Auth-derived email synchronization
--     - Avatar updates
--     - Admin Patient/Doctor/Staff account-status transitions
--
-- Preserve:
--   - authenticated SELECT, still constrained by existing RLS
--   - authenticated self UPDATE of full_name/contact_number only
--     for the existing Doctor shared-profile synchronization workflow
--
-- Do NOT modify public.is_current_admin().
-- ============================================================================

alter table public.profiles enable row level security;

-- --------------------------------------------------------------------------
-- 1. Remove broad table privileges.
-- --------------------------------------------------------------------------

revoke all privileges
on table public.profiles
from anon;

revoke all privileges
on table public.profiles
from authenticated;

-- Defensive cleanup in case privileges were ever inherited from PUBLIC.
revoke all privileges
on table public.profiles
from public;

-- --------------------------------------------------------------------------
-- 2. Explicitly remove independently granted column privileges.
--
-- Table-level REVOKE is not enough if a role has independent column grants,
-- so clear INSERT / UPDATE / REFERENCES on every current profiles column.
--
-- Also remove any anonymous column SELECT grants.
-- --------------------------------------------------------------------------

do $$
declare
  v_column record;
begin
  for v_column in
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
  loop
    execute format(
      'revoke insert (%I) on table public.profiles from anon',
      v_column.column_name
    );

    execute format(
      'revoke update (%I) on table public.profiles from anon',
      v_column.column_name
    );

    execute format(
      'revoke references (%I) on table public.profiles from anon',
      v_column.column_name
    );

    execute format(
      'revoke select (%I) on table public.profiles from anon',
      v_column.column_name
    );

    execute format(
      'revoke insert (%I) on table public.profiles from authenticated',
      v_column.column_name
    );

    execute format(
      'revoke update (%I) on table public.profiles from authenticated',
      v_column.column_name
    );

    execute format(
      'revoke references (%I) on table public.profiles from authenticated',
      v_column.column_name
    );
  end loop;
end;
$$;

-- --------------------------------------------------------------------------
-- 3. Remove browser INSERT policies.
--
-- Patient profile creation now goes through:
--   public.ensure_current_patient_profile()
-- --------------------------------------------------------------------------

drop policy if exists
  "Users can insert own profile"
on public.profiles;

drop policy if exists
  "Users can insert their own profile"
on public.profiles;

-- --------------------------------------------------------------------------
-- 4. Remove broad / duplicate UPDATE policies.
--
-- In particular, remove the Admin direct profiles UPDATE policy because
-- Admin status transitions must go through the audited Admin RPCs.
-- --------------------------------------------------------------------------

drop policy if exists
  "Users can update own profile"
on public.profiles;

drop policy if exists
  "Users can update their own profile"
on public.profiles;

drop policy if exists
  "Admins can update profile account access"
on public.profiles;

-- --------------------------------------------------------------------------
-- 5. Restore only the direct privileges still required by the frontend.
--
-- SELECT:
-- Existing SELECT RLS policies remain unchanged.
--
-- UPDATE:
-- Doctor Settings still synchronizes its own display name/contact number
-- into public.profiles. No other direct profile columns are writable.
-- --------------------------------------------------------------------------

grant select
on table public.profiles
to authenticated;

grant update (
  full_name,
  contact_number
)
on table public.profiles
to authenticated;

-- --------------------------------------------------------------------------
-- 6. Recreate exactly one own-row UPDATE policy.
--
-- Column security is enforced by the UPDATE column grants above.
-- Row security ensures the authenticated user can only affect their own row.
-- --------------------------------------------------------------------------

create policy
  "Users can update own safe profile fields"
on public.profiles
for update
to authenticated
using (
  id = auth.uid()
)
with check (
  id = auth.uid()
);

-- --------------------------------------------------------------------------
-- 7. Explicitly keep anonymous direct profiles access disabled.
-- --------------------------------------------------------------------------

revoke all privileges
on table public.profiles
from anon;

-- --------------------------------------------------------------------------
-- 8. Ask PostgREST to reload privileges/schema metadata.
-- --------------------------------------------------------------------------

notify pgrst, 'reload schema';