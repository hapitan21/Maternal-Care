-- Review-only security hotfix for public.is_clinic_user().
--
-- This migration intentionally replaces only the existing no-argument helper.
-- It does not alter grants, policies, profile rows, or application behavior
-- outside the helper's active-account eligibility decision.
--
-- IMPORTANT: Review this file before manually installing it in Supabase.

begin;

do $preflight$
declare
  v_issues text;
begin
  with column_requirements(column_name, expected_type) as (
    values
      ('id', 'uuid'),
      ('role', 'text'),
      ('account_status', 'text')
  ), checks(issue) as (
    select case
      when pg_catalog.to_regclass('public.profiles') is null
        then 'missing table public.profiles'
      else null
    end

    union all

    select case
      when actual.column_name is null
        then 'missing column public.profiles.' || required.column_name
      when actual.data_type <> required.expected_type
        then pg_catalog.format(
          'incompatible type public.profiles.%s: expected %s, found %s',
          required.column_name,
          required.expected_type,
          actual.data_type
        )
      else null
    end
    from column_requirements as required
    left join information_schema.columns as actual
      on actual.table_schema = 'public'
     and actual.table_name = 'profiles'
     and actual.column_name = required.column_name

    union all

    select case
      when function_contract.function_oid is null
        then 'missing function public.is_clinic_user()'
      when function_contract.return_type <> 'boolean'
        then pg_catalog.format(
          'incompatible return type public.is_clinic_user(): expected boolean, found %s',
          function_contract.return_type
        )
      else null
    end
    from (
      select
        existing.oid as function_oid,
        pg_catalog.format_type(existing.prorettype, null) as return_type
      from (values (pg_catalog.to_regprocedure('public.is_clinic_user()'))) as expected(oid)
      left join pg_catalog.pg_proc as existing
        on existing.oid = expected.oid
    ) as function_contract
  )
  select pg_catalog.string_agg(checks.issue, '; ' order by checks.issue)
  into v_issues
  from checks
  where checks.issue is not null;

  if v_issues is not null then
    raise exception 'is_clinic_user active-account hotfix preflight failed: %', v_issues;
  end if;
end;
$preflight$;

create or replace function public.is_clinic_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(
        pg_catalog.btrim(
          coalesce(profile.role, ''::text)
        )
      ) in ('admin', 'doctor', 'staff')
      and pg_catalog.lower(
        pg_catalog.btrim(
          coalesce(profile.account_status, ''::text)
        )
      ) = 'active'
  );
$function$;

notify pgrst, 'reload schema';

commit;

-- ================================================================
-- READ-ONLY PREFLIGHT / VERIFICATION QUERIES
-- Run the function and grant snapshots before and after installation.
-- ================================================================

-- 1-5. Verify the exact signature, boolean return type, SECURITY DEFINER,
-- trusted owner, empty search_path, and account_status validation.
-- select
--   function_row.oid::pg_catalog.regprocedure as signature,
--   pg_catalog.format_type(function_row.prorettype, null) as return_type,
--   function_row.prosecdef as security_definer,
--   function_row.provolatile = 's' as stable,
--   pg_catalog.pg_get_userbyid(function_row.proowner) as owner,
--   function_row.proconfig as function_config,
--   coalesce('search_path=""' = any(function_row.proconfig), false)
--     as search_path_is_empty,
--   pg_catalog.pg_get_functiondef(function_row.oid) like '%account_status%'
--     as validates_account_status,
--   pg_catalog.pg_get_functiondef(function_row.oid) as function_definition
-- from pg_catalog.pg_proc as function_row
-- where function_row.oid = pg_catalog.to_regprocedure('public.is_clinic_user()');

-- 6. Capture this grant snapshot before and after installation. CREATE OR
-- REPLACE must leave every row unchanged.
-- select
--   function_row.oid::pg_catalog.regprocedure as signature,
--   case
--     when privilege.grantee = 0 then 'PUBLIC'
--     else pg_catalog.pg_get_userbyid(privilege.grantee)
--   end as grantee,
--   pg_catalog.pg_get_userbyid(privilege.grantor) as grantor,
--   privilege.privilege_type,
--   privilege.is_grantable
-- from pg_catalog.pg_proc as function_row
-- cross join lateral pg_catalog.aclexplode(
--   coalesce(
--     function_row.proacl,
--     pg_catalog.acldefault('f', function_row.proowner)
--   )
-- ) as privilege
-- where function_row.oid = pg_catalog.to_regprocedure('public.is_clinic_user()')
-- order by grantee, privilege.privilege_type, grantor;

-- 7. Verify the count and names of every RLS policy that references the helper.
-- The confirmed live count before installation is 24; the after result must
-- have the same count and names.
-- select pg_catalog.count(*) as helper_policy_count
-- from pg_catalog.pg_policies as policy
-- where coalesce(policy.qual, '') like '%is_clinic_user%'
--    or coalesce(policy.with_check, '') like '%is_clinic_user%';
--
-- select
--   policy.schemaname,
--   policy.tablename,
--   policy.policyname,
--   policy.cmd,
--   policy.roles,
--   policy.qual,
--   policy.with_check
-- from pg_catalog.pg_policies as policy
-- where coalesce(policy.qual, '') like '%is_clinic_user%'
--    or coalesce(policy.with_check, '') like '%is_clinic_user%'
-- order by policy.schemaname, policy.tablename, policy.policyname;

-- 8. Verify RLS remains enabled on every table with a helper-based policy.
-- Every row must report rls_enabled = true.
-- with helper_tables as (
--   select distinct policy.schemaname, policy.tablename
--   from pg_catalog.pg_policies as policy
--   where coalesce(policy.qual, '') like '%is_clinic_user%'
--      or coalesce(policy.with_check, '') like '%is_clinic_user%'
-- )
-- select
--   helper_tables.schemaname,
--   helper_tables.tablename,
--   table_row.relrowsecurity as rls_enabled,
--   table_row.relforcerowsecurity as rls_forced
-- from helper_tables
-- join pg_catalog.pg_namespace as namespace_row
--   on namespace_row.nspname = helper_tables.schemaname
-- join pg_catalog.pg_class as table_row
--   on table_row.relnamespace = namespace_row.oid
--  and table_row.relname = helper_tables.tablename
-- order by helper_tables.schemaname, helper_tables.tablename;

-- 9. Capture this policy identity/fingerprint snapshot before and after.
-- Identical OIDs and fingerprints confirm no policy was dropped or recreated.
-- select
--   policy_row.oid as policy_oid,
--   namespace_row.nspname as schema_name,
--   table_row.relname as table_name,
--   policy_row.polname as policy_name,
--   pg_catalog.md5(
--     pg_catalog.concat_ws(
--       '|',
--       policy_row.polcmd::text,
--       policy_row.polpermissive::text,
--       policy_row.polroles::text,
--       pg_catalog.pg_get_expr(policy_row.polqual, policy_row.polrelid),
--       pg_catalog.pg_get_expr(policy_row.polwithcheck, policy_row.polrelid)
--     )
--   ) as policy_fingerprint
-- from pg_catalog.pg_policy as policy_row
-- join pg_catalog.pg_class as table_row on table_row.oid = policy_row.polrelid
-- join pg_catalog.pg_namespace as namespace_row
--   on namespace_row.oid = table_row.relnamespace
-- where coalesce(
--         pg_catalog.pg_get_expr(policy_row.polqual, policy_row.polrelid),
--         ''
--       ) like '%is_clinic_user%'
--    or coalesce(
--         pg_catalog.pg_get_expr(policy_row.polwithcheck, policy_row.polrelid),
--         ''
--       ) like '%is_clinic_user%'
-- order by namespace_row.nspname, table_row.relname, policy_row.polname;

-- ================================================================
-- MANUAL TEST PLAN AFTER INSTALLATION
-- ================================================================
-- Use dedicated non-production test accounts and existing authenticated
-- sessions. Confirm this matrix by calling public.is_clinic_user() and by
-- exercising one representative helper-protected SELECT for each clinic role:
--
--   active Admin       -> true
--   inactive Admin     -> false
--   active Doctor      -> true
--   inactive Doctor    -> false
--   active Staff       -> true
--   inactive Staff     -> false
--   Patient            -> false
--   unauthenticated    -> false
--
-- Session-revocation behavior:
-- 1. Sign in as an active Doctor or Staff member and confirm the existing
--    helper-protected access succeeds.
-- 2. From a separate trusted Admin session, deactivate that same profile.
-- 3. Without signing out or refreshing the access token, retry the protected
--    operation. It must now be denied because the helper reads profiles on
--    every policy evaluation.
-- 4. Reactivate the profile from the trusted Admin session.
-- 5. Retry from the original Doctor or Staff session. The same previous access
--    must be restored without changing any policy or grant.

-- ================================================================
-- EMERGENCY ROLLBACK GUIDANCE - DO NOT USE AS A NORMAL ROLLBACK
-- ================================================================
-- WARNING: The previous definition below restores the known vulnerability in
-- which inactive Admin, Doctor, and Staff accounts retain helper-based RLS
-- access. Use only for a reviewed emergency where that risk is explicitly
-- accepted, then restore the secure definition immediately.
--
-- begin;
--
-- create or replace function public.is_clinic_user()
-- returns boolean
-- language sql
-- stable
-- security definer
-- set search_path to 'public'
-- as $function$
--   select exists (
--     select 1
--     from public.profiles as profile
--     where profile.id = auth.uid()
--       and profile.role in ('admin', 'doctor', 'staff')
--   );
-- $function$;
--
-- notify pgrst, 'reload schema';
--
-- commit;
