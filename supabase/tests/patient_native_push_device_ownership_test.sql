-- ISOLATED TEST ONLY. Never use a production server, linked Supabase URL, or real data.
-- Requires psql, a dedicated empty local database named maternal_native_push_ownership_test,
-- and local anon/authenticated/service_role roles. No roles or databases are created here.
-- Run from the repo root after creating that disposable database on a LOCAL test server:
-- psql --host=127.0.0.1 --dbname=maternal_native_push_ownership_test --username=postgres \
--   --set=allow_isolated_test=true --file=supabase/tests/patient_native_push_device_ownership_test.sql
-- Minimal identity fixtures model only the columns used by the real migrations/RPC.
-- The real table, grants, trigger and RPC definitions are loaded below, not copied/mocked.
-- Test data rolls back; the schema remains in the disposable database for inspection.
-- This script checks serial authorization. It does not claim to test concurrent sessions.

\set ON_ERROR_STOP on
\if :{?allow_isolated_test}
  \if :allow_isolated_test
  \else
    \echo 'Refusing: explicit isolated-test opt-in is required.'
    select 1 / 0;
  \endif
\else
  \echo 'Refusing: explicit isolated-test opt-in is required.'
  select 1 / 0;
\endif

select :'HOST' in ('127.0.0.1', 'localhost', '::1') as local_test_host \gset
\if :local_test_host
\else
  \echo 'Refusing: the connection must explicitly use a loopback host.'
  select 1 / 0;
\endif

do $guard$
begin
  if pg_catalog.current_database() <> 'maternal_native_push_ownership_test' then
    raise exception 'Refusing: use the dedicated disposable ownership-test database.';
  end if;
  if pg_catalog.to_regnamespace('auth') is not null or exists (
    select 1 from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
  ) then
    raise exception 'Refusing: the ownership-test database must be empty.';
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    raise exception 'Refusing: the local test server must already have Supabase test roles.';
  end if;
end;
$guard$;

begin;
create schema auth;
create table auth.users (id uuid primary key);
create table public.profiles (id uuid primary key, role text, account_status text);
create table public.patients (
  id uuid primary key, user_id uuid, account_status text, status text, archived_at timestamptz
);
create function auth.uid() returns uuid language sql stable set search_path = '' as $uid$
  select nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid;
$uid$;
grant usage on schema auth, public to anon, authenticated, service_role;
commit;

\ir ../migrations/20261001120000_patient_native_push_devices.sql
\ir ../migrations/20261002001500_harden_native_push_device_service_role.sql
\ir ../migrations/20261002012000_fix_native_push_rpc_sql_expressions.sql
\ir ../migrations/20261003120000_secure_patient_native_push_device_ownership.sql

begin;
create function pg_temp.assert_true(ok boolean, label text) returns void
language plpgsql as $assert$
begin
  if ok is distinct from true then raise exception 'Ownership regression failed: %', label; end if;
end;
$assert$;
create function pg_temp.expect_error(statement text, expected_code text, expected_message text default null)
returns void language plpgsql as $error$
declare
  actual_code text;
  actual_message text;
  actual_detail text;
begin
  begin
    execute statement;
  exception when others then
    get stacked diagnostics actual_code = returned_sqlstate,
      actual_message = message_text, actual_detail = pg_exception_detail;
    if actual_code <> expected_code then raise exception 'Unexpected error class in ownership test.'; end if;
    if expected_message is not null and
       (actual_message <> expected_message or coalesce(actual_detail, '') <> '') then
      raise exception 'Ownership conflict error must be generic and omit private detail.';
    end if;
    return;
  end;
  raise exception 'Expected ownership rejection did not occur.';
end;
$error$;

insert into auth.users (id)
select ('00000000-0000-4000-8000-' || pg_catalog.lpad(n::text, 12, '0'))::uuid
from pg_catalog.generate_series(1, 17) as n;
insert into public.profiles (id, role, account_status)
select id,
  case pg_catalog.right(id::text, 2) when '03' then 'doctor' when '04' then 'staff'
    when '05' then 'admin' when '06' then null else 'patient' end,
  case pg_catalog.right(id::text, 2) when '07' then 'inactive' else 'active' end
from auth.users;
insert into public.patients (id, user_id, account_status, status, archived_at)
select ('00000000-0000-4000-8000-' || pg_catalog.lpad((100 + n)::text, 12, '0'))::uuid,
  ('00000000-0000-4000-8000-' || pg_catalog.lpad(n::text, 12, '0'))::uuid,
  case n when 8 then 'inactive' when 9 then 'pending_activation'
    when 13 then 'suspended' when 14 then 'blocked' when 15 then 'deactivated'
    when 16 then 'disabled' when 17 then 'deleted' else 'active' end,
  case n when 11 then 'deleted' else 'active' end,
  case n when 10 then pg_catalog.now() else null end
from pg_catalog.generate_series(1, 17) as n where n <> 12;

-- Legacy inactive status is the ONLY disqualifying field in this independent fixture.
insert into auth.users (id) values ('00000000-0000-4000-8000-000000000018');
insert into public.profiles (id, role, account_status)
values ('00000000-0000-4000-8000-000000000018', 'patient', 'active');
insert into public.patients (id, user_id, account_status, status, archived_at)
values ('00000000-0000-4000-8000-000000000118',
  '00000000-0000-4000-8000-000000000018', 'active', 'inactive', null);
select pg_temp.assert_true(profile.role = 'patient' and profile.account_status = 'active'
  and patient.account_status = 'active' and patient.archived_at is null and patient.status = 'inactive',
  'legacy inactive fixture has no other eligibility blocker')
from public.profiles as profile join public.patients as patient on patient.user_id = profile.id
where profile.id = '00000000-0000-4000-8000-000000000018';

set local role authenticated;
select pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
do $new$
declare result jsonb;
begin
  result := public.upsert_my_patient_native_push_device(
    'synthetic-installation-A1', repeat('a', 64), 'android', 'test-v1');
  perform pg_temp.assert_true((result->>'enabled')::boolean, 'new installation is enabled');
  perform pg_temp.assert_true(not (result ? 'push_token') and not (result ? 'patient_id')
    and not (result ? 'user_id'), 'RPC result does not reveal token or ownership');
  perform public.upsert_my_patient_native_push_device('synthetic-installation-A2', repeat('c', 64));
end;
$new$;
reset role;
select pg_temp.assert_true(count(*) = 2 and bool_and(
  user_id = '00000000-0000-4000-8000-000000000001'::uuid and
  patient_id = '00000000-0000-4000-8000-000000000101'::uuid), 'server derives ownership for multiple devices')
from public.patient_native_push_devices;
create temp table initial_identity as select id, created_at from public.patient_native_push_devices
where installation_id = 'synthetic-installation-A1';
update public.patient_native_push_devices set last_seen_at = '2000-01-01', app_version = 'test-v0'
where installation_id = 'synthetic-installation-A1';
set local role authenticated;
select public.upsert_my_patient_native_push_device('synthetic-installation-A1', repeat('d', 64), 'android', 'test-v2');
select public.deactivate_my_patient_native_push_device('synthetic-installation-A1');
select public.upsert_my_patient_native_push_device('synthetic-installation-A1', repeat('e', 64), 'android', 'test-v3');
reset role;
select pg_temp.assert_true(device.id = first.id and device.created_at = first.created_at
  and device.push_token = repeat('e', 64) and device.enabled and device.disabled_at is null
  and device.app_version = 'test-v3' and device.last_seen_at > '2000-01-01'::timestamptz,
  'same-owner rotation and re-enable preserve identity and refresh registration fields')
from public.patient_native_push_devices as device cross join initial_identity as first
where device.installation_id = 'synthetic-installation-A1';
create temp table before_conflicts as select installation_id, to_jsonb(device) as row_data
from public.patient_native_push_devices as device;

set local role authenticated;
select pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
select pg_temp.expect_error($call$select public.upsert_my_patient_native_push_device(
  'synthetic-installation-A1', repeat('b', 64))$call$, '42501',
  'The native push registration conflicts with another app installation.');
select pg_temp.expect_error($call$select public.upsert_my_patient_native_push_device(
  'synthetic-installation-A1', repeat('e', 64))$call$, '42501',
  'The native push registration conflicts with another app installation.');
select pg_temp.expect_error($call$select public.upsert_my_patient_native_push_device(
  'synthetic-installation-B1', repeat('e', 64))$call$, '23505',
  'The native push registration conflicts with another app installation.');
reset role;
select pg_temp.assert_true(count(*) = 2 and bool_and(to_jsonb(device) = before.row_data),
  'failed installation/token takeover changes no original field or timestamp')
from public.patient_native_push_devices as device join before_conflicts as before using (installation_id);
select pg_temp.assert_true(count(*) = 2, 'failed token conflict creates no row') from public.patient_native_push_devices;

set local role authenticated;
select public.upsert_my_patient_native_push_device('synthetic-installation-B1', repeat('b', 64));
select pg_temp.expect_error($call$select public.upsert_my_patient_native_push_device(
  'synthetic-installation-B1', repeat('e', 64))$call$, '23505',
  'The native push registration conflicts with another app installation.');
select pg_temp.assert_true(not (public.get_my_patient_native_push_device_status(
  'synthetic-installation-A1')->>'found')::boolean, 'status lookup does not disclose another owner');
select public.deactivate_my_patient_native_push_device('synthetic-installation-A1');
reset role;
select pg_temp.assert_true(push_token = repeat('b', 64) and enabled, 'token conflict preserves requesting device')
from public.patient_native_push_devices where installation_id = 'synthetic-installation-B1';
select pg_temp.assert_true(to_jsonb(device) = before.row_data, 'cross-owner deactivation does not mutate owner')
from public.patient_native_push_devices as device join before_conflicts as before using (installation_id)
where installation_id = 'synthetic-installation-A1';

set local role authenticated;
select pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select public.deactivate_my_patient_native_push_device('synthetic-installation-A1');
reset role;
create temp table disabled_identity as select to_jsonb(device) as row_data
from public.patient_native_push_devices as device where installation_id = 'synthetic-installation-A1';
set local role authenticated;
select pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
select pg_temp.expect_error($call$select public.upsert_my_patient_native_push_device(
  'synthetic-installation-A1', repeat('f', 64))$call$, '42501',
  'The native push registration conflicts with another app installation.');
reset role;
select pg_temp.assert_true(to_jsonb(device) = before.row_data, 'disabled row cannot be transferred or re-enabled by another owner')
from public.patient_native_push_devices as device cross join disabled_identity as before
where device.installation_id = 'synthetic-installation-A1';

-- Independently require BOTH fields, including inconsistent historical ownership.
insert into public.patient_native_push_devices (patient_id, user_id, installation_id, push_token)
values ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000002',
  'synthetic-user-mismatch', repeat('g', 64)),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000001',
  'synthetic-patient-mismatch', repeat('h', 64));
create temp table mismatched_identity as select installation_id, to_jsonb(device) as row_data
from public.patient_native_push_devices as device where installation_id like 'synthetic-%-mismatch';
set local role authenticated;
select pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select pg_temp.expect_error($call$select public.upsert_my_patient_native_push_device(
  'synthetic-user-mismatch', repeat('i', 64))$call$, '42501',
  'The native push registration conflicts with another app installation.');
select pg_temp.expect_error($call$select public.upsert_my_patient_native_push_device(
  'synthetic-patient-mismatch', repeat('j', 64))$call$, '42501',
  'The native push registration conflicts with another app installation.');
reset role;
select pg_temp.assert_true(count(*) = 2 and bool_and(to_jsonb(device) = before.row_data), 'both ownership mismatches leave the row intact')
from public.patient_native_push_devices as device join mismatched_identity as before using (installation_id);

set local role authenticated;
select pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000018', true);
select pg_temp.expect_error($call$select public.upsert_my_patient_native_push_device(
  'synthetic-legacy-inactive', repeat('l', 64))$call$, '42501',
  'An active linked Patient account is required.');
do $roles$
declare n integer;
begin
  for n in 3..17 loop
    perform pg_catalog.set_config('request.jwt.claim.sub',
      '00000000-0000-4000-8000-' || pg_catalog.lpad(n::text, 12, '0'), true);
    perform pg_temp.expect_error($call$select public.upsert_my_patient_native_push_device(
      'synthetic-invalid-account', repeat('k', 64))$call$, '42501',
      'An active linked Patient account is required.');
  end loop;
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_temp.expect_error($call$select public.upsert_my_patient_native_push_device(
    'synthetic-invalid-account', repeat('k', 64))$call$, '42501', 'Authentication is required.');
end;
$roles$;
select pg_temp.assert_true(not pg_catalog.has_table_privilege(current_user,
  'public.patient_native_push_devices', 'INSERT') and not pg_catalog.has_table_privilege(current_user,
  'public.patient_native_push_devices', 'UPDATE') and not pg_catalog.has_table_privilege(current_user,
  'public.patient_native_push_devices', 'SELECT'), 'browser direct table access remains revoked');
select pg_temp.expect_error('update public.patient_native_push_devices set enabled = true', '42501');
reset role;
set local role anon;
select pg_temp.expect_error($call$select public.upsert_my_patient_native_push_device(
  'synthetic-invalid-account', repeat('k', 64))$call$, '42501');
reset role;
select pg_temp.assert_true(relation.relrowsecurity, 'RLS stays enabled')
from pg_catalog.pg_class as relation where relation.oid = 'public.patient_native_push_devices'::regclass;
select pg_temp.assert_true(function.prosecdef and exists (
  select 1 from unnest(function.proconfig) as config
  where split_part(config, '=', 1) = 'search_path' and btrim(split_part(config, '=', 2), '" ') = ''
), 'RPC retains SECURITY DEFINER with an empty search path')
from pg_catalog.pg_proc as function
where function.oid = 'public.upsert_my_patient_native_push_device(text,text,text,text)'::regprocedure;

rollback;
\echo 'PASS: isolated real SQL ownership, conflicts, account authorization, grants and definer checks.'
