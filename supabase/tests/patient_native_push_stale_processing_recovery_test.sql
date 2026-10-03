-- Disposable Docker PostgreSQL only. No linked project or production credentials.
\set ON_ERROR_STOP on
\if :{?allow_isolated_test}
  \if :allow_isolated_test
  \else
    select 1 / 0;
  \endif
\else
  select 1 / 0;
\endif
select :'HOST' = '/var/run/postgresql' as local_host \gset
\if :local_host
\else
  select 1 / 0;
\endif
do $guard$
begin
  if current_database() <> 'maternal_native_push_stale_test'
     or current_setting('cron.launch_active_jobs') <> 'off'
     or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind in ('r','p')) then
    raise exception 'Refusing: require the empty disposable stale-test database with cron disabled.';
  end if;
end;
$guard$;
create extension if not exists pg_cron;
create table public.patient_notifications(id uuid primary key, patient_id uuid not null, type text default 'general');
create table public.patient_native_push_devices(
  id uuid primary key, patient_id uuid not null, platform text default 'android', enabled boolean default true,
  push_token text, updated_at timestamptz default now(), disabled_at timestamptz
);
create function public.test_uuid(n integer) returns uuid language sql immutable
as $$select ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid$$;
create schema net;
create table net.test_calls(body jsonb);
create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 1000)
returns bigint language plpgsql as $$begin insert into net.test_calls values(body); return 1; end$$;
\ir ../migrations/20261002120000_patient_notification_native_push_deliveries.sql
insert into public.patient_notifications values(public.test_uuid(1),public.test_uuid(100),'general');
insert into public.patient_native_push_devices(id,patient_id,push_token) values(public.test_uuid(2),public.test_uuid(100),'synthetic-local-target');
insert into public.patient_notification_native_push_deliveries(notification_id,device_id,attempted_at,status,attempt_count,fcm_http_status,error_code,error_message,provider_message_id)
values(public.test_uuid(1),public.test_uuid(2),clock_timestamp()-interval '1 hour','processing',7,500,'INTERNAL','Historical evidence.','synthetic-historical-message');
\ir ../migrations/20261003130000_patient_native_push_bounded_retries.sql

create table public.test_constraint_snapshot as select conname as name,pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='public.patient_notification_native_push_deliveries'::regclass and conname in ('patient_native_push_deliveries_status_check','patient_native_push_failure_class_check','patient_native_push_deliveries_sent_state_check');
-- Capability installation does not resolve even genuinely stale existing rows.
create table public.test_install_snapshot as select id,to_jsonb(d) as original from public.patient_notification_native_push_deliveries d;
create table public.test_rpc_snapshot as select oid,pg_get_functiondef(oid) as definition from pg_proc
where oid in ('public.claim_patient_native_push_delivery(uuid,uuid,text)'::regprocedure,
'public.finalize_patient_native_push_delivery(uuid,uuid,integer,text,integer,text,text,timestamptz,bigint)'::regprocedure,
'public.list_due_patient_native_push_deliveries()'::regprocedure);
create table public.test_retry_job_snapshot as select to_jsonb(j) as original from cron.job j where jobname='patient-native-push-retry-tick';
\ir ../migrations/20261003150000_patient_native_push_stale_processing_recovery.sql
create table public.test_assertions(label text);
create function pg_temp.assert_true(ok boolean,label text) returns void language plpgsql as $$begin
  if ok is distinct from true then raise exception 'Stale recovery SQL regression failed: %',label; end if;
  insert into public.test_assertions values(label);
end$$;
create function public.test_seed(n integer,age interval,state text default 'processing') returns void language plpgsql as $$begin
  insert into public.patient_notifications(id,patient_id) values(public.test_uuid(n),public.test_uuid(100));
  insert into public.patient_notification_native_push_deliveries(id,notification_id,device_id,status,claim_token,attempted_at,sent_at,recovery_at,recovery_reason)
  values(public.test_uuid(n+10000),public.test_uuid(n),public.test_uuid(2),state,gen_random_uuid(),clock_timestamp()-age,
    case when state='sent' then clock_timestamp() end,
    case when state='delivery_unknown' then clock_timestamp() end,
    case when state='delivery_unknown' then 'stale_processing_unknown_outcome' end);
end$$;
select pg_temp.assert_true(not exists(select 1 from public.test_install_snapshot s full join public.patient_notification_native_push_deliveries d using(id)
where s.original is distinct from (to_jsonb(d)-'recovery_at'-'recovery_reason')),'migration preserves all historical row evidence and executes no recovery');
select pg_temp.assert_true(not exists(select 1 from public.test_rpc_snapshot s where pg_get_functiondef(s.oid)<>s.definition),'all three Phase 8B RPC definitions remain identical');
select pg_temp.assert_true((select to_jsonb(j)=s.original from cron.job j cross join public.test_retry_job_snapshot s where j.jobname='patient-native-push-retry-tick'),'Phase 8B retry scheduler remains identical');
select pg_temp.assert_true((select count(*)=1 and bool_and(not active and username=current_user and database=current_database()
  and schedule='* * * * *' and command='select public.recover_stale_patient_native_push_deliveries();') from cron.job where jobname='patient-native-push-stale-recovery'),'real pg_cron creates exactly one inactive recovery job');
select pg_temp.assert_true(exists(select 1 from pg_index i where i.indexrelid='public.patient_native_push_stale_processing_idx'::regclass and i.indisvalid
and pg_get_indexdef(i.indexrelid,1,true)='attempted_at' and pg_get_indexdef(i.indexrelid,2,true)='id'
and pg_get_expr(i.indpred,i.indrelid) like '%processing%'),'narrow ordered processing index exists');
select pg_temp.assert_true(not has_function_privilege('anon','public.recover_stale_patient_native_push_deliveries()','EXECUTE')
and not has_function_privilege('authenticated','public.recover_stale_patient_native_push_deliveries()','EXECUTE')
and not has_function_privilege('service_role','public.recover_stale_patient_native_push_deliveries()','EXECUTE')
and has_function_privilege('postgres','public.recover_stale_patient_native_push_deliveries()','EXECUTE'),'recovery privilege is restricted to cron database role');
select pg_temp.assert_true(not has_table_privilege('service_role','public.patient_notification_native_push_deliveries','INSERT,UPDATE'),'direct ledger write revocations retained');

-- Real boundary, preserved identities and ignored terminal states.
do $contracts$
declare original jsonb; devices jsonb; notifications jsonb; n integer; recovered integer; before_row jsonb; current_row record;
begin
  perform public.test_seed(9,interval '9 minutes 59 seconds');
  perform pg_sleep(0.05); -- now() is frozen at this transaction's start; wall clock is required.
  perform public.test_seed(10,interval '10 minutes');
  perform public.test_seed(11,interval '11 minutes');
  perform public.test_seed(12,interval '1 hour','sent');
  perform public.test_seed(13,interval '1 hour','failed');
  perform public.test_seed(14,interval '1 hour','disabled_token');
  perform public.test_seed(15,interval '1 hour','delivery_unknown');
  select jsonb_agg(to_jsonb(d) order by id) into devices from public.patient_native_push_devices d;
  select jsonb_agg(to_jsonb(p) order by id) into notifications from public.patient_notifications p;
  create temporary table boundary_snapshot as select id,to_jsonb(d) as original from public.patient_notification_native_push_deliveries d;
  recovered:=public.recover_stale_patient_native_push_deliveries();
  perform pg_temp.assert_true(recovered=3,'exactly three stale rows including legacy are resolved');
  perform pg_temp.assert_true((select status='processing' from public.patient_notification_native_push_deliveries where notification_id=public.test_uuid(9)),'9m59s processing is not recovered');
  foreach n in array array[10,11] loop
    select * into current_row from public.patient_notification_native_push_deliveries where notification_id=public.test_uuid(n);
    perform pg_temp.assert_true(current_row.status='delivery_unknown','exact ten-minute and older rows become terminal unknown using wall clock');
    select s.original into original from boundary_snapshot s where s.id=current_row.id;
    perform pg_temp.assert_true((to_jsonb(current_row)-'status'-'next_attempt_at'-'recovery_at'-'recovery_reason'-'updated_at')=
      (original-'status'-'next_attempt_at'-'recovery_at'-'recovery_reason'-'updated_at'),'recovery preserves every identity, fence, count, creation/attempt timestamp and provider field');
    perform pg_temp.assert_true(current_row.next_attempt_at is null and current_row.recovery_at is not null
      and current_row.recovery_reason='stale_processing_unknown_outcome','recovery records bounded metadata and no deadline');
    perform pg_temp.assert_true(not exists(select 1 from public.claim_patient_native_push_delivery(public.test_uuid(n),public.test_uuid(2),'notification')),'unknown cannot be initially claimed');
    perform pg_temp.assert_true(not exists(select 1 from public.claim_patient_native_push_delivery(public.test_uuid(n),public.test_uuid(2),'retry')),'unknown cannot be retry claimed');
  end loop;
  foreach n in array array[12,13,14,15] loop
    perform pg_temp.assert_true((select to_jsonb(d)=s.original from public.patient_notification_native_push_deliveries d join boundary_snapshot s using(id)
      where notification_id=public.test_uuid(n)),'sent/failed/disabled/already-unknown states are ignored byte-for-byte');
  end loop;
  perform pg_temp.assert_true((select claim_token is null and attempt_count=7 and status='delivery_unknown' and fcm_http_status=500
    and error_code='INTERNAL' and error_message='Historical evidence.' and provider_message_id='synthetic-historical-message'
    and sent_at is null and last_failure_class is null from public.patient_notification_native_push_deliveries where notification_id=public.test_uuid(1)),
    'legacy NULL-fence stale row preserves historical FCM/error evidence and count above four');
  perform pg_temp.assert_true((select jsonb_agg(to_jsonb(d) order by id)=devices from public.patient_native_push_devices d),'all device fields including token/version/enabled state remain unchanged');
  perform pg_temp.assert_true((select jsonb_agg(to_jsonb(p) order by id)=notifications from public.patient_notifications p),'all notification rows remain unchanged');
  perform pg_temp.assert_true(not exists(select 1 from public.list_due_patient_native_push_deliveries()),'recovery creates no due retry or restarted window');
  select to_jsonb(d) into before_row from public.patient_notification_native_push_deliveries d where notification_id=public.test_uuid(10);
  perform pg_temp.assert_true(public.recover_stale_patient_native_push_deliveries()=0,'second recovery invocation is idempotent');
  perform pg_temp.assert_true((select to_jsonb(d)=before_row from public.patient_notification_native_push_deliveries d where notification_id=public.test_uuid(10)),'second invocation preserves recovery timestamp and evidence');
  -- Finish the young fixture through the real finalizer before later batch tests.
  select * into current_row from public.patient_notification_native_push_deliveries where notification_id=public.test_uuid(9);
  perform public.finalize_patient_native_push_delivery(current_row.id,current_row.claim_token,current_row.attempt_count,'success',200,null,'synthetic-message',null,null);
end;
$contracts$;

-- Fault-injection ONLY: processing/non-NULL sent_at or failure class is not legal
-- under current Phase 8B constraints. Temporarily remove those two checks AFTER
-- migration preflight, inject legacy evidence, recover, then restore exact checks.
-- This proves preservation even for damaged history; never weakens deployment preflight.
do $historical_evidence$
declare sent_check text; failure_check text; prior_sent timestamptz; current_row record;
begin
  select pg_get_constraintdef(oid) into sent_check from pg_constraint where conrelid='public.patient_notification_native_push_deliveries'::regclass and conname='patient_native_push_deliveries_sent_state_check';
  select pg_get_constraintdef(oid) into failure_check from pg_constraint where conrelid='public.patient_notification_native_push_deliveries'::regclass and conname='patient_native_push_failure_class_check';
  alter table public.patient_notification_native_push_deliveries drop constraint patient_native_push_deliveries_sent_state_check;
  alter table public.patient_notification_native_push_deliveries drop constraint patient_native_push_failure_class_check;
  perform public.test_seed(16,interval '31 minutes');
  prior_sent:=clock_timestamp()-interval '2 hours';
  update public.patient_notification_native_push_deliveries set claim_token=null,sent_at=prior_sent,last_failure_class='permanent_device',
    fcm_http_status=404,error_code='UNREGISTERED',error_message='Preserve historical evidence.',provider_message_id='synthetic-earlier-message'
    where notification_id=public.test_uuid(16);
  perform pg_temp.assert_true(public.recover_stale_patient_native_push_deliveries()=1,'damaged historical evidence can be terminally resolved without replay');
  select * into current_row from public.patient_notification_native_push_deliveries where notification_id=public.test_uuid(16);
  perform pg_temp.assert_true(current_row.sent_at=prior_sent and current_row.last_failure_class='permanent_device'
    and current_row.fcm_http_status=404 and current_row.error_code='UNREGISTERED' and current_row.provider_message_id='synthetic-earlier-message','non-NULL historical sent_at and stronger failure evidence are preserved');
  execute 'alter table public.patient_notification_native_push_deliveries add constraint patient_native_push_deliveries_sent_state_check '||sent_check;
  execute 'alter table public.patient_notification_native_push_deliveries add constraint patient_native_push_failure_class_check '||failure_check;
  perform pg_temp.assert_true(not exists(select 1 from public.claim_patient_native_push_delivery(public.test_uuid(16),public.test_uuid(2),'retry')),'old-window historical unknown is never retried');
end;
$historical_evidence$;

do $batch$
declare n integer; common_time timestamptz:=clock_timestamp()-interval '1 hour';
begin
  for n in reverse 260..200 loop
    perform public.test_seed(n,interval '1 hour');
  end loop;
  update public.patient_notification_native_push_deliveries set attempted_at=common_time where notification_id between public.test_uuid(200) and public.test_uuid(260);
  perform pg_temp.assert_true(public.recover_stale_patient_native_push_deliveries()=50,'recovery respects batch limit fifty');
  perform pg_temp.assert_true((select count(*)=50 from public.patient_notification_native_push_deliveries where notification_id between public.test_uuid(200) and public.test_uuid(249) and status='delivery_unknown'),'equal-age ordering uses stable ascending delivery id');
  perform pg_temp.assert_true((select count(*)=11 from public.patient_notification_native_push_deliveries where notification_id between public.test_uuid(250) and public.test_uuid(260) and status='processing'),'remaining batch rows are untouched');
  perform pg_temp.assert_true(public.recover_stale_patient_native_push_deliveries()=11,'next batch resolves remaining rows');
  perform pg_temp.assert_true(public.recover_stale_patient_native_push_deliveries()=0,'completed batches stay idempotent');
end;
$batch$;
select pg_temp.assert_true((select count(*)=0 from net.test_calls),'recovery and inactive cron invoke no network transport');
select 'STALE_SQL_ASSERTIONS_PASSED='||count(*) from public.test_assertions;
