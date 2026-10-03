-- ISOLATED LOCAL POSTGRESQL ONLY. This file never connects to a linked project.
-- psql --host=127.0.0.1 --dbname=maternal_native_push_retry_test --username=postgres \
--   --set=allow_isolated_test=true --file=supabase/tests/patient_native_push_delivery_retry_test.sql
-- Requires a disposable EMPTY database and pre-existing anon/authenticated/service_role roles.
-- Claims/finalization use the REAL migrations and PostgreSQL engine.
-- Vault/cron/pg_net below are local transport fixtures, NOT real extension execution.
-- Scheduler fixture coverage does NOT prove production scheduler configuration.
\set ON_ERROR_STOP on
\if :{?allow_isolated_test}
  \if :allow_isolated_test
  \else
    select 1 / 0;
  \endif
\else
  select 1 / 0;
\endif
select :'HOST' in ('127.0.0.1', 'localhost', '::1') as local_test_host \gset
\if :local_test_host
\else
  select 1 / 0;
\endif

do $guard$
begin
  if pg_catalog.current_database() <> 'maternal_native_push_retry_test' then
    raise exception 'Refusing: use the dedicated local retry-test database.';
  end if;
  if exists (select 1 from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname in ('public', 'vault', 'net', 'cron')) then
    raise exception 'Refusing: retry-test database must be empty.';
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname='anon')
    or not exists (select 1 from pg_catalog.pg_roles where rolname='authenticated')
    or not exists (select 1 from pg_catalog.pg_roles where rolname='service_role') then
    raise exception 'Local Supabase test roles must already exist.';
  end if;
end;
$guard$;

create table public.patient_notifications(id uuid primary key, patient_id uuid not null, type text default 'general');
create table public.patient_native_push_devices(
  id uuid primary key, patient_id uuid not null, platform text default 'android',
  enabled boolean default true, push_token text, updated_at timestamptz default now(), disabled_at timestamptz
);
-- Exact production registration-version trigger from 20261001120000.
create or replace function public.set_patient_native_push_devices_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;

create trigger patient_native_push_devices_set_updated_at
before update on public.patient_native_push_devices
for each row
execute function public.set_patient_native_push_devices_updated_at();

grant usage on schema public to anon, authenticated, service_role;
create schema vault;
create table vault.decrypted_secrets(name text primary key, decrypted_secret text);
create schema net;
create table net.test_calls(url text, headers jsonb, body jsonb);
create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 1000)
returns bigint language plpgsql as $transport$
begin
  insert into net.test_calls values(url, headers, body);
  return 1;
end;
$transport$;
create schema cron;
create table cron.job(jobname text primary key, schedule text, command text);
create function cron.schedule(job_name text, schedule text, command text) returns bigint
language plpgsql as $cron$
begin
  insert into cron.job values(job_name, schedule, command)
  on conflict(jobname) do update set schedule=excluded.schedule, command=excluded.command;
  return 1;
end;
$cron$;

\ir ../migrations/20261002120000_patient_notification_native_push_deliveries.sql
-- Seed historical rows BEFORE the new metadata migration; preserve complete snapshots.
insert into public.patient_notifications
select ('00000000-0000-4000-8000-' || pg_catalog.lpad(value::text,12,'0'))::uuid,
  '00000000-0000-4000-8000-000000000001'::uuid, 'general'
from pg_catalog.generate_series(101,106) as value;
insert into public.patient_native_push_devices(id, patient_id, push_token) values
 ('00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000001','synthetic-local-target');
insert into public.patient_notification_native_push_deliveries(
  notification_id,device_id,status,attempt_count,fcm_http_status,error_code,error_message,provider_message_id,sent_at)
values
 ('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','processing',1,null,null,null,null,null),
 ('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000201','sent',1,200,null,null,'synthetic-historical-message',pg_catalog.now()),
 ('00000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-000000000201','failed',1,503,'UNAVAILABLE','FCM is temporarily unavailable.',null,null),
 ('00000000-0000-4000-8000-000000000104','00000000-0000-4000-8000-000000000201','disabled_token',1,404,'UNREGISTERED','FCM registration token is no longer valid.',null,null),
 -- The old schema accepts attempt_count > 4, even with existing result metadata.
 ('00000000-0000-4000-8000-000000000105','00000000-0000-4000-8000-000000000201','failed',6,429,'QUOTA_EXCEEDED','FCM temporarily rate limited delivery.',null,null),
 ('00000000-0000-4000-8000-000000000106','00000000-0000-4000-8000-000000000201','processing',7,500,'INTERNAL','FCM reported a temporary internal error.',null,null);
create table public.test_historical_snapshot as
select delivery.id, pg_catalog.to_jsonb(delivery) as original
from public.patient_notification_native_push_deliveries as delivery;
\ir ../migrations/20261003130000_patient_native_push_bounded_retries.sql

create function pg_temp.assert_true(ok boolean, label text) returns void language plpgsql as $assert$
begin
  if ok is distinct from true then raise exception 'Native retry SQL regression failed: %', label; end if;
end;
$assert$;

begin;
do $contracts$
declare
  n uuid := '00000000-0000-4000-8000-000000000101';
  d uuid := '00000000-0000-4000-8000-000000000201';
  claim record; old_claim record; outcome record;
  row_before public.patient_notification_native_push_deliveries%rowtype;
  row_after public.patient_notification_native_push_deliveries%rowtype;
  category text; state text; http integer; version timestamptz;
begin
  perform pg_temp.assert_true((select count(*)=6 from public.patient_notification_native_push_deliveries),
    'all historical rows survived migration');
  perform pg_temp.assert_true(not exists(
    select 1 from public.patient_notification_native_push_deliveries
    where claim_token is not null or last_failure_class is not null or next_attempt_at is not null),
    'all historical metadata remains NULL; no processing fence or retry deadline fabricated');
  perform pg_temp.assert_true(not exists(
    select 1 from public.test_historical_snapshot as snapshot
    full join public.patient_notification_native_push_deliveries as delivery using(id)
    where snapshot.original is distinct from
      pg_catalog.to_jsonb(delivery) - 'claim_token' - 'last_failure_class' - 'next_attempt_at'),
    'every historical status, attempt_count, timestamp and nullable/non-null result is unchanged');
  for row_before in select * from public.patient_notification_native_push_deliveries loop
    perform pg_temp.assert_true(not exists(select 1 from public.claim_patient_native_push_delivery(
      row_before.notification_id,row_before.device_id,'retry')), 'no historical row becomes retryable or reclaimed');
  end loop;
  perform pg_temp.assert_true(not exists(select 1 from public.list_due_patient_native_push_deliveries()),
    'historical rows do not enter due discovery');
  delete from public.patient_notification_native_push_deliveries;

  select * into claim from public.claim_patient_native_push_delivery(n,d,'notification');
  perform pg_temp.assert_true(claim.attempt_count=1 and claim.claim_token is not null, 'initial claim attempt 1');
  for state in select unnest(array['processing','failed','sent','disabled_token']) loop
    update public.patient_notification_native_push_deliveries set status=state,
      sent_at=case when state='sent' then now() else null end;
    perform pg_temp.assert_true(not exists(select 1 from public.claim_patient_native_push_delivery(n,d,'notification')), 'webhook always skips existing ' || state);
    if state in ('sent','disabled_token','processing') then
      perform pg_temp.assert_true(not exists(select 1 from public.claim_patient_native_push_delivery(n,d,'retry')), 'retry skips ' || state);
    end if;
  end loop;
  update public.patient_notification_native_push_deliveries set status='failed', sent_at=null, claim_token=null;
  perform pg_temp.assert_true(not exists(select 1 from public.claim_patient_native_push_delivery(n,d,'retry')), 'historical failed cannot retry');
  delete from public.patient_notification_native_push_deliveries;

  for category in select unnest(array['non_retryable','unknown_outcome']) loop
    select * into claim from public.claim_patient_native_push_delivery(n,d,'notification');
    perform public.finalize_patient_native_push_delivery(claim.delivery_id,claim.claim_token,claim.attempt_count,
      category,400,'INVALID_ARGUMENT',null,null,null);
    perform pg_temp.assert_true(not exists(select 1 from public.claim_patient_native_push_delivery(n,d,'retry')), category || ' cannot retry');
    delete from public.patient_notification_native_push_deliveries;
  end loop;
  for http in select unnest(array[429,500,503]) loop
    select * into claim from public.claim_patient_native_push_delivery(n,d,'notification');
    perform public.finalize_patient_native_push_delivery(claim.delivery_id,claim.claim_token,1,
      'confirmed_transient',http,case http when 500 then 'INTERNAL' when 503 then 'UNAVAILABLE' else 'QUOTA_EXCEEDED' end,null,null,null);
    select * into row_after from public.patient_notification_native_push_deliveries;
    perform pg_temp.assert_true(row_after.next_attempt_at >= now()+interval '60 seconds'
      and row_after.next_attempt_at <= now()+interval '75 seconds', 'transient backoff and nonnegative jitter');
    perform pg_temp.assert_true(not exists(select 1 from public.claim_patient_native_push_delivery(n,d,'retry')), 'not due');
    delete from public.patient_notification_native_push_deliveries;
  end loop;

  select * into old_claim from public.claim_patient_native_push_delivery(n,d,'notification');
  perform public.finalize_patient_native_push_delivery(old_claim.delivery_id,old_claim.claim_token,1,
    'confirmed_transient',503,'UNAVAILABLE',null,null,null);
  update public.patient_notification_native_push_deliveries set attempted_at=now()-interval '70 seconds',
    next_attempt_at=now()-interval '1 second';
  select * into row_before from public.patient_notification_native_push_deliveries;
  select * into claim from public.claim_patient_native_push_delivery(n,d,'retry');
  select * into row_after from public.patient_notification_native_push_deliveries;
  perform pg_temp.assert_true(claim.attempt_count=2 and claim.claim_token<>old_claim.claim_token, 'retry increments once and rotates fence');
  perform pg_temp.assert_true(row_after.created_at=row_before.created_at, 'original created_at preserved');
  perform pg_temp.assert_true(row_after.last_failure_class is null and row_after.next_attempt_at is null
    and row_after.fcm_http_status is null and row_after.error_code is null and row_after.error_message is null
    and row_after.provider_message_id is null and row_after.sent_at is null, 'retry clears all previous result metadata');
  perform pg_temp.assert_true(not exists(select 1 from public.claim_patient_native_push_delivery(n,d,'notification')),
    'webhook during retry cannot claim');
  select updated_at into version from public.patient_native_push_devices where id=d;
  select * into outcome from public.finalize_patient_native_push_delivery(old_claim.delivery_id,old_claim.claim_token,1,
    'permanent_device',404,'UNREGISTERED',null,version,null);
  perform pg_temp.assert_true(outcome.result='stale_claim' and (select enabled from public.patient_native_push_devices where id=d), 'stale claim cannot finalize or disable');
  perform public.finalize_patient_native_push_delivery(claim.delivery_id,claim.claim_token,2,'success',200,null,'synthetic-provider-message',version,null);
  select * into outcome from public.finalize_patient_native_push_delivery(claim.delivery_id,claim.claim_token,2,
    'permanent_device',404,'UNREGISTERED',null,version,null);
  perform pg_temp.assert_true(outcome.result='already_finalized' and outcome.status='sent'
    and (select enabled from public.patient_native_push_devices where id=d), 'duplicate finalization safe without repeated cleanup');
  delete from public.patient_notification_native_push_deliveries;

  select * into claim from public.claim_patient_native_push_delivery(n,d,'notification');
  perform public.finalize_patient_native_push_delivery(claim.delivery_id,claim.claim_token,1,'permanent_device',404,'UNREGISTERED',null,version,null);
  perform pg_temp.assert_true((select not enabled from public.patient_native_push_devices where id=d)
    and (select status='disabled_token' and next_attempt_at is null from public.patient_notification_native_push_deliveries), 'matching-version permanent cleanup and terminalization');
  delete from public.patient_notification_native_push_deliveries;
  update public.patient_native_push_devices set enabled=true,disabled_at=null where id=d;

  select * into claim from public.claim_patient_native_push_delivery(n,d,'notification');
  begin
    perform public.finalize_patient_native_push_delivery(claim.delivery_id,claim.claim_token,1,'success',null,null,null,null,null);
    raise exception 'Missing HTTP success status was accepted.';
  exception when invalid_parameter_value then null; end;
  perform public.finalize_patient_native_push_delivery(claim.delivery_id,claim.claim_token,1,'non_retryable',400,repeat('synthetic-private-detail',100),null,null,null);
  perform pg_temp.assert_true((select error_code='FCM_REQUEST_FAILED' and length(error_message)<=240 from public.patient_notification_native_push_deliveries), 'arbitrary error text is bounded and never recorded');
  delete from public.patient_notification_native_push_deliveries;
  select * into claim from public.claim_patient_native_push_delivery(n,d,'notification');
  update public.patient_notification_native_push_deliveries set attempt_count=4;
  perform public.finalize_patient_native_push_delivery(claim.delivery_id,claim.claim_token,4,'confirmed_transient',429,'QUOTA_EXCEEDED',null,null,null);
  perform pg_temp.assert_true((select status='failed' and last_failure_class='confirmed_transient' and next_attempt_at is null from public.patient_notification_native_push_deliveries), 'attempt four finalization schedules nothing');
  perform pg_temp.assert_true(not exists(select 1 from public.claim_patient_native_push_delivery(n,d,'retry')), 'no fifth claim after finalization');
  delete from public.patient_notification_native_push_deliveries;
  select * into claim from public.claim_patient_native_push_delivery(n,d,'notification');
  perform public.finalize_patient_native_push_delivery(claim.delivery_id,claim.claim_token,1,'confirmed_transient',429,'QUOTA_EXCEEDED',null,null,1800000);
  perform pg_temp.assert_true((select next_attempt_at is null from public.patient_notification_native_push_deliveries), 'provider delay beyond window has no retry');
  delete from public.patient_notification_native_push_deliveries;
  select * into claim from public.claim_patient_native_push_delivery(n,d,'notification');
  perform public.finalize_patient_native_push_delivery(claim.delivery_id,claim.claim_token,1,'confirmed_transient',429,'QUOTA_EXCEEDED',null,null,300000);
  perform pg_temp.assert_true((select next_attempt_at >= now()+interval '5 minutes' from public.patient_notification_native_push_deliveries), 'provider delay wins');
  update public.patient_notification_native_push_deliveries set attempt_count=4,next_attempt_at=null;
  perform pg_temp.assert_true(not exists(select 1 from public.claim_patient_native_push_delivery(n,d,'retry')), 'no fifth attempt');
  update public.patient_notification_native_push_deliveries set attempt_count=1,created_at=now()-interval '31 minutes',
    attempted_at=now()-interval '31 minutes',next_attempt_at=now()-interval '2 minutes';
  perform pg_temp.assert_true(not exists(select 1 from public.claim_patient_native_push_delivery(n,d,'retry')), 'expired window');
  delete from public.patient_notification_native_push_deliveries;
  select * into claim from public.claim_patient_native_push_delivery(n,d,'notification');
  perform public.finalize_patient_native_push_delivery(claim.delivery_id,claim.claim_token,1,'confirmed_transient',503,'UNAVAILABLE',null,null,null);
  update public.patient_notification_native_push_deliveries set attempted_at=now()-interval '70 seconds',next_attempt_at=now()-interval '1 second';
  update public.patient_native_push_devices set enabled=false,disabled_at=now() where id=d;
  perform pg_temp.assert_true(not exists(select 1 from public.claim_patient_native_push_delivery(n,d,'retry'))
    and not exists(select 1 from public.list_due_patient_native_push_deliveries()), 'disabled device cannot retry');

  perform pg_temp.assert_true(not pg_catalog.has_function_privilege('anon','public.claim_patient_native_push_delivery(uuid,uuid,text)','execute'), 'anon cannot claim');
  perform pg_temp.assert_true(not pg_catalog.has_function_privilege('authenticated','public.finalize_patient_native_push_delivery(uuid,uuid,integer,text,integer,text,text,timestamptz,bigint)','execute'), 'client cannot finalize');
  perform pg_temp.assert_true(pg_catalog.has_function_privilege('service_role','public.claim_patient_native_push_delivery(uuid,uuid,text)','execute'), 'server can claim');
  perform pg_temp.assert_true(not pg_catalog.has_table_privilege('service_role','public.patient_notification_native_push_deliveries','insert')
    and not pg_catalog.has_table_privilege('service_role','public.patient_notification_native_push_deliveries','update'), 'direct server ledger writes removed');
  perform public.enqueue_patient_native_push_retry_tick();
  perform pg_temp.assert_true((select count(*)=0 from net.test_calls), 'scheduler absent configuration is inert');
  insert into vault.decrypted_secrets values('native_push_retry_enabled','true');
  perform public.enqueue_patient_native_push_retry_tick();
  perform pg_temp.assert_true((select count(*)=0 from net.test_calls), 'scheduler incomplete configuration is inert');
  insert into vault.decrypted_secrets values
    ('native_push_retry_project_url','https://abcdefghijklmnopqrst.supabase.co'),
    ('native_push_retry_url','https://anotherprojectxxxxxx.supabase.co/functions/v1/send-patient-native-push'),
    ('native_push_retry_secret','synthetic_retry_secret_32_characters_only');
  perform public.enqueue_patient_native_push_retry_tick();
  perform pg_temp.assert_true((select count(*)=0 from net.test_calls), 'wrong project cannot receive secret');
  update vault.decrypted_secrets set decrypted_secret='https://abcdefghijklmnopqrst.supabase.co/functions/v1/send-patient-native-push' where name='native_push_retry_url';
  perform public.enqueue_patient_native_push_retry_tick();
  perform pg_temp.assert_true((select count(*)=1 from net.test_calls), 'fully configured scheduler enqueues transport fixture');
  raise notice 'PASS: isolated PostgreSQL serial retry, fencing, guards, privileges and scheduler-fixture contracts.';
end;
$contracts$;
rollback;
delete from public.patient_notification_native_push_deliveries;

-- pg_catalog.now() is transaction-start time in production. Capture and rotate
-- in separate committed transactions so the real BEFORE UPDATE trigger advances.
begin;
create temporary table test_rotation_claim as
select claim.*, device.updated_at as selected_device_updated_at
from public.claim_patient_native_push_delivery(
  '00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','notification') as claim
cross join public.patient_native_push_devices as device
where device.id='00000000-0000-4000-8000-000000000201';
commit;

begin;
update public.patient_native_push_devices
set push_token='synthetic-rotated-local-target'
where id='00000000-0000-4000-8000-000000000201';
commit;

begin;
do $rotation$
declare
  selected record;
  outcome record;
begin
  perform pg_temp.assert_true((select count(*)=1 from test_rotation_claim), 'rotation fixture obtained one claim');
  select * into selected from test_rotation_claim;
  perform pg_temp.assert_true((select updated_at > selected.selected_device_updated_at
    and enabled and push_token='synthetic-rotated-local-target' from public.patient_native_push_devices
    where id='00000000-0000-4000-8000-000000000201'), 'production trigger advanced registration version in separate transaction');
  select * into outcome from public.finalize_patient_native_push_delivery(
    selected.delivery_id,selected.claim_token,selected.attempt_count,'permanent_device',404,'UNREGISTERED',
    null,selected.selected_device_updated_at,null);
  perform pg_temp.assert_true(outcome.result='finalized' and outcome.status='failed', 'stale selected version safely terminalized');
  perform pg_temp.assert_true((select enabled and push_token='synthetic-rotated-local-target'
    from public.patient_native_push_devices where id='00000000-0000-4000-8000-000000000201'),
    'refreshed registration must remain enabled');
  perform pg_temp.assert_true((select status='failed' and error_code='DEVICE_DISABLE_FAILED'
    and last_failure_class='permanent_device' and next_attempt_at is null
    from public.patient_notification_native_push_deliveries where id=selected.delivery_id),
    'changed-version cleanup records designed safe terminal result without retry');
  raise notice 'PASS: real updated_at trigger and transaction-separated registration rotation protection.';
end;
$rotation$;
commit;
drop table test_rotation_claim;
-- Leave canonical fixtures for the separate real concurrency runner.
delete from public.patient_notification_native_push_deliveries;
