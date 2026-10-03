-- ISOLATED disposable Docker PostgreSQL ONLY. Never use a linked project.
-- The real migration and pg_cron execute; SMS/native transports are offline recorders.
\set ON_ERROR_STOP on
\if :{?allow_isolated_test}
  \if :allow_isolated_test
  \else
    select 1 / 0;
  \endif
\else
  select 1 / 0;
\endif
select :'HOST' = '/var/run/postgresql' as local_test_host \gset
\if :local_test_host
\else
  select 1 / 0;
\endif

do $guard$
begin
  if pg_catalog.current_database() <> 'maternal_appointment_reminder_test'
     or pg_catalog.current_setting('cron.launch_active_jobs') <> 'off' then
    raise exception 'Refusing: use the dedicated disposable database with autonomous cron disabled.';
  end if;
  if exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p')) then
    raise exception 'Refusing: fixture requires an empty application schema.';
  end if;
end;
$guard$;
create extension if not exists pg_cron;
create function public.test_uuid(n integer) returns uuid language sql immutable
as $$ select ('00000000-0000-4000-8000-' || pg_catalog.lpad(n::text,12,'0'))::uuid $$;
create table public.profiles(id uuid primary key, role text);
create table public.patients(id uuid primary key, user_id uuid, account_status text default 'active', archived_at timestamptz, status text default 'active');
create table public.schedule(id uuid primary key default pg_catalog.gen_random_uuid(), patient_id uuid references public.patients, title text default 'Synthetic appointment', start_time timestamptz, end_time timestamptz, status text default 'scheduled');
create table public.reminders(
  id uuid primary key default pg_catalog.gen_random_uuid(), patient_id uuid references public.patients,
  schedule_id uuid references public.schedule, created_by uuid, reminder_type text default 'appointment',
  title text default 'Synthetic reminder', message text default 'Synthetic test message', remind_at timestamptz,
  status text default 'pending', sent_at timestamptz, next_trigger_at timestamptz,
  repeat_mode text default 'none' check(repeat_mode in ('none','hourly','daily')), repeat_until timestamptz,
  constraint reminders_valid_status check(lower(status)=any(array['sent','cancelled','pending','completed']))
);
create unique index reminders_one_appointment_per_schedule_idx on public.reminders(schedule_id)
where schedule_id is not null and lower(coalesce(reminder_type,''))='appointment';
create index reminders_appointment_next_trigger_idx on public.reminders(next_trigger_at)
where reminder_type='appointment' and status='pending';
create table public.patient_notifications(
  id uuid primary key default pg_catalog.gen_random_uuid(), patient_id uuid references public.patients,
  user_id uuid, created_by uuid, created_by_role text, type text, title text, message text,
  target_path text, related_appointment_id uuid references public.schedule,
  related_medical_record_id uuid, related_reminder_id uuid references public.reminders, priority text
);
create table public.appointment_reminder_dispatches(
  id uuid primary key default pg_catalog.gen_random_uuid(), reminder_id uuid references public.reminders,
  schedule_id uuid references public.schedule, patient_id uuid references public.patients,
  notification_id uuid references public.patient_notifications, reminder_offset_minutes integer,
  appointment_start_time timestamptz, scheduled_for timestamptz,
  status text, claimed_at timestamptz,
  constraint appointment_reminder_dispatches_status_check check(status in ('processing','created','skipped','failed')),
  notification_created_at timestamptz, error_code text check(error_code is null or length(error_code) between 1 and 80),
  constraint appointment_reminder_dispatches_schedule_offset_key unique(schedule_id,reminder_offset_minutes)
);
create unique index appointment_reminder_dispatches_reminder_scheduled_key
on public.appointment_reminder_dispatches(reminder_id,scheduled_for)
where reminder_id is not null and scheduled_for is not null;
create schema net;
create table net.test_calls(id bigint generated always as identity, body jsonb);
create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 1000)
returns bigint language plpgsql as $$ declare n bigint; begin
  insert into net.test_calls(body) values(body) returning id into n; return n;
end $$;
-- Actual Vault extension, synthetic local entries; no secret values are selected or printed.
do $$ begin
  perform vault.create_secret('true','appointment_sms_bridge_enabled');
  perform vault.create_secret('https://appointment-reminder.invalid','appointment_sms_function_url');
  perform vault.create_secret('sb_secret_SYNTHETIC_LOCAL_ONLY','appointment_sms_server_secret');
end $$;
\ir ../migrations/20260923140000_appointment_reminder_sms_bridge.sql
create table public.test_native_enqueues(notification_id uuid);
create function public.test_native_capture() returns trigger language plpgsql as $$ begin
  insert into public.test_native_enqueues values(new.id); return new;
end $$;
create trigger test_native_capture after insert on public.patient_notifications
for each row execute function public.test_native_capture();
\ir fixtures/appointment_reminder_deployed_baseline.sql
revoke all on function public.process_due_appointment_reminders() from public,anon,authenticated;
grant execute on function public.create_appointment_patient_reminder(uuid) to authenticated;
insert into public.profiles values(public.test_uuid(101),'patient'),(public.test_uuid(102),'doctor'),
  (public.test_uuid(103),'staff'),(public.test_uuid(104),'admin');
insert into public.patients(id,user_id) values(public.test_uuid(1),public.test_uuid(101)),(public.test_uuid(2),public.test_uuid(105));
-- Old rows genuinely precede the timing trigger. Dormant cases are activated individually.
insert into public.schedule(id,patient_id,start_time,end_time)
select public.test_uuid(n),public.test_uuid(1),clock_timestamp()+interval '3 hours',clock_timestamp()+interval '4 hours'
from generate_series(10,100) n;
insert into public.reminders(id,patient_id,schedule_id,remind_at,next_trigger_at,status)
select public.test_uuid(n),public.test_uuid(1),public.test_uuid(n),clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '10 minutes','cancelled'
from generate_series(10,100) n;
update public.reminders set repeat_mode='hourly' where id=public.test_uuid(30);
update public.reminders set repeat_mode='daily' where id=public.test_uuid(31);
update public.reminders set repeat_mode='hourly',sent_at=clock_timestamp()-interval '1 day' where id=public.test_uuid(32);
update public.reminders set repeat_mode='hourly' where id=public.test_uuid(33);
update public.reminders set repeat_mode='hourly',repeat_until=clock_timestamp()+interval '10 minutes' where id=public.test_uuid(34);
update public.reminders set patient_id=public.test_uuid(2) where id=public.test_uuid(24);
update public.schedule set patient_id=public.test_uuid(2) where id=public.test_uuid(24);
insert into public.schedule(id,patient_id,start_time,end_time) values
  (public.test_uuid(901),public.test_uuid(1),clock_timestamp()-interval '1 day',clock_timestamp()-interval '23 hours'),
  (public.test_uuid(902),public.test_uuid(1),clock_timestamp()-interval '1 day',clock_timestamp()-interval '23 hours');
insert into public.reminders(id,patient_id,schedule_id,remind_at,next_trigger_at) values
  (public.test_uuid(901),public.test_uuid(1),public.test_uuid(901),clock_timestamp()-interval '2 days',clock_timestamp()-interval '2 days'),
  (public.test_uuid(902),public.test_uuid(1),public.test_uuid(902),clock_timestamp()-interval '2 days',clock_timestamp()-interval '2 days');
insert into public.appointment_reminder_dispatches(reminder_id,schedule_id,patient_id,appointment_start_time,scheduled_for,status)
select id,schedule_id,patient_id,remind_at,remind_at,'failed' from public.reminders where id=public.test_uuid(902);
create table public.test_history_snapshot as select to_jsonb(r) as original from public.reminders r where id=public.test_uuid(902);
select cron.schedule('process-due-appointment-reminders','*/5 * * * *','select * from public.process_due_appointment_reminders();') as test_jobid \gset
create table public.test_cron_snapshot as select jobid,command,database,active,username from cron.job where jobname='process-due-appointment-reminders';
create table public.test_dispatch_constraint_snapshot as select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='public.appointment_reminder_dispatches'::regclass and conname='appointment_reminder_dispatches_status_check';
\ir ../migrations/20261003140000_appointment_reminder_reliability.sql
create table public.test_assertions(label text);
create function pg_temp.assert_true(ok boolean,label text) returns void language plpgsql as $$ begin
  if ok is distinct from true then raise exception 'Reminder SQL regression failed: %',label; end if;
  insert into public.test_assertions values(label);
end $$;
create function pg_temp.expect_timing_error(command text,label text) returns void language plpgsql as $$ begin
  begin execute command;
    raise exception 'Reminder SQL regression failed: expected timing rejection: %',label;
  exception when sqlstate '22023' then
    insert into public.test_assertions values(label);
  end;
end $$;
create table public.test_controls(action text primary key);
create function public.test_dispatch_gate() returns trigger language plpgsql as $$ begin
  if new.reminder_id is not null and new.status='processing' then
    if exists(select 1 from public.test_controls where action='delay_claim') then perform pg_sleep(1); end if;
    if exists(select 1 from public.test_controls where action='cancel_claim') then update public.schedule set status='cancelled' where id=new.schedule_id; end if;
    if exists(select 1 from public.test_controls where action='complete_claim') then update public.schedule set status='completed' where id=new.schedule_id; end if;
  end if;
  return new;
end $$;
create trigger test_dispatch_gate before insert or update on public.appointment_reminder_dispatches
for each row execute function public.test_dispatch_gate();
create function public.test_notification_gate() returns trigger language plpgsql as $$ begin
  if exists(select 1 from public.test_controls where action='fail_notification') then raise exception 'Synthetic local insertion failure'; end if;
  if exists(select 1 from public.test_controls where action='delay_notification') then perform pg_sleep(1); end if;
  return new;
end $$;
create trigger test_notification_gate before insert on public.patient_notifications
for each row execute function public.test_notification_gate();

select pg_temp.assert_true((select status='expired' and next_trigger_at is null and sent_at is null from public.reminders where id=public.test_uuid(901)), 'historical never-dispatched row expires truthfully');
select pg_temp.assert_true((select to_jsonb(r)=s.original from public.reminders r cross join public.test_history_snapshot s where r.id=public.test_uuid(902)), 'historical ANY dispatch history remains unchanged by migration');
-- Keep historical review case dormant while other processor contracts execute.
update public.reminders set status='cancelled' where id=public.test_uuid(902);
select pg_temp.assert_true((select count(*)=1 from cron.job where jobname='process-due-appointment-reminders'), 'cron has exactly one named job');
select pg_temp.assert_true((select j.jobid=s.jobid and j.schedule='* * * * *' and j.command=s.command and j.database=s.database and j.active=s.active and j.username=s.username from cron.job j cross join public.test_cron_snapshot s where j.jobname='process-due-appointment-reminders'), 'cron alters cadence and preserves identity/configuration');
select pg_temp.assert_true((select count(*)=0 from public.patient_notifications), 'historical expiry creates no notification');
select pg_temp.assert_true((select count(*)=1 from public.appointment_reminder_dispatches), 'historical expiry fabricates no dispatch');
select pg_temp.assert_true((select count(*)=0 from net.test_calls) and (select count(*)=0 from public.test_native_enqueues), 'historical expiry enqueues no SMS/native transport');

select pg_temp.assert_true(exists(select 1 from pg_constraint where conrelid='public.reminders'::regclass and conname='reminders_valid_status' and pg_get_constraintdef(oid) like '%expired%'), 'reviewed reordered four-state reminder contract passes preflight and gains expired');
select pg_temp.assert_true((select pg_get_constraintdef(c.oid)=s.definition from pg_constraint c cross join public.test_dispatch_constraint_snapshot s where c.conrelid='public.appointment_reminder_dispatches'::regclass and c.conname='appointment_reminder_dispatches_status_check'), 'reviewed four-state dispatch contract passes preflight without replacement');

-- Direct DML is the authoritative path, not a browser model.
do $timing_contracts$
declare s uuid; r uuid; base timestamptz := clock_timestamp();
begin
  insert into public.schedule(patient_id,start_time,end_time) values(public.test_uuid(1),base+interval '2 hours',base+interval '3 hours') returning id into s;
  insert into public.reminders(patient_id,schedule_id,remind_at) values(public.test_uuid(1),s,base+interval '110 minutes') returning id into r;
  perform pg_temp.assert_true((select next_trigger_at=remind_at from public.reminders where id=r),'exact ten-minute boundary accepted and canonical trigger initialized');
  perform pg_temp.expect_timing_error(format('update public.reminders set remind_at=%L where id=%L',base+interval '110 minutes 1 second',r),'9m59s scheduling UPDATE rejected');
  perform pg_temp.expect_timing_error(format('update public.reminders set remind_at=%L where id=%L',base-interval '1 second',r),'past scheduling UPDATE rejected');
  update public.reminders set next_trigger_at=base+interval '115 minutes' where id=r;
  update public.reminders set remind_at=base+interval '100 minutes' where id=r;
  perform pg_temp.assert_true((select next_trigger_at=remind_at and remind_at=base+interval '100 minutes' from public.reminders where id=r),'genuine remind_at reschedule resets progressed next trigger');
  insert into public.schedule(patient_id,start_time,end_time) values(public.test_uuid(1),base+interval '105 minutes',base+interval '3 hours') returning id into s;
  perform pg_temp.expect_timing_error(format('update public.reminders set schedule_id=%L where id=%L',s,r),'schedule_id change revalidates the appointment lead time');
  perform pg_temp.assert_true((select next_trigger_at=remind_at and schedule_id<>s from public.reminders where id=r),'rejected schedule_id change preserves the original occurrence');
  update public.schedule set status='cancelled' where id=s;
  -- A running repeat has a historical origin but a future progressed occurrence.
  update public.reminders set status='pending',sent_at=base-interval '2 minutes',next_trigger_at=base+interval '1 hour' where id=public.test_uuid(42);
  update public.reminders set repeat_mode='hourly' where id=public.test_uuid(42);
  perform pg_temp.assert_true((select remind_at<base and next_trigger_at=base+interval '1 hour' and sent_at=base-interval '2 minutes' and status='pending' and repeat_mode='hourly' from public.reminders where id=public.test_uuid(42)),'repeat_mode-only historical edit preserves repeat progression and sent_at');
  update public.reminders set repeat_until=base+interval '2 hours' where id=public.test_uuid(42);
  perform pg_temp.assert_true((select remind_at<base and next_trigger_at=base+interval '1 hour' and sent_at=base-interval '2 minutes' and status='pending' and repeat_until=base+interval '2 hours' from public.reminders where id=public.test_uuid(42)),'repeat_until-only historical edit preserves repeat progression and sent_at');
  update public.reminders set remind_at=remind_at,repeat_mode='daily' where id=public.test_uuid(42);
  perform pg_temp.assert_true((select next_trigger_at=base+interval '1 hour' from public.reminders where id=public.test_uuid(42)),'unchanged scheduling field with repeat-only edit does not revalidate historical origin');
  update public.reminders set next_trigger_at=base+interval '90 minutes' where id=public.test_uuid(42);
  perform pg_temp.assert_true((select next_trigger_at=base+interval '90 minutes' from public.reminders where id=public.test_uuid(42)),'processor advancement remains independent after repeat edits');
  update public.reminders set status='cancelled' where id=public.test_uuid(42);
  update public.reminders set next_trigger_at=base-interval '1 minute',sent_at=base-interval '2 minutes' where id=r;
  update public.reminders set status='sent',next_trigger_at=null where id=r;
  perform pg_temp.assert_true((select status='sent' from public.reminders where id=r),'processor next-trigger/sent_at/status updates bypass historical-time revalidation');
  update public.reminders set status='sent',sent_at=base,next_trigger_at=null where id=public.test_uuid(41);
  perform pg_temp.assert_true((select status='sent' and remind_at<clock_timestamp() from public.reminders where id=public.test_uuid(41)),'status-only UPDATE of historical remind_at is not blocked');
  update public.reminders set next_trigger_at=base+interval '1 hour' where id=public.test_uuid(41);
  perform pg_temp.assert_true(found,'next-trigger advancement of historical remind_at is not blocked');
  update public.reminders set status='cancelled' where id=public.test_uuid(41);
  update public.reminders set status='expired' where id=r;
  perform pg_temp.assert_true((select status='expired' from public.reminders where id=r),'expired status constraint accepts processor update');
  for s in select id from public.schedule where id=public.test_uuid(40) loop
    -- Existing configured row conflict must not mask timing validation.
    perform pg_temp.expect_timing_error(format('insert into public.reminders(patient_id,schedule_id,remind_at) values(%L,%L,%L)',public.test_uuid(1),s,clock_timestamp()-interval '1 second'),'invalid direct INSERT rejected before uniqueness');
  end loop;
  insert into public.schedule(patient_id,start_time,end_time) values(public.test_uuid(1),base+interval '2 hours',base+interval '3 hours') returning id into s;
  perform pg_temp.expect_timing_error(format('insert into public.reminders(patient_id,schedule_id,remind_at) values(%L,%L,%L)',public.test_uuid(1),s,base+interval '115 minutes'),'five-minute new INSERT rejected');
  perform pg_temp.expect_timing_error(format('insert into public.reminders(patient_id,schedule_id,remind_at) values(%L,%L,%L)',public.test_uuid(1),s,base+interval '119 minutes'),'one-minute new INSERT rejected');
  update public.schedule set status='cancelled' where id=s;
  -- Medication DML is unaffected by appointment-only timing validation.
  insert into public.reminders(patient_id,reminder_type,remind_at) values(public.test_uuid(1),'medication',base-interval '1 day');
  perform pg_temp.assert_true(found,'non-appointment historical INSERT remains unaffected');
end;
$timing_contracts$;


-- Real authenticated direct writes still invoke the privileged timing trigger.
insert into public.schedule(id,patient_id,start_time,end_time) values(public.test_uuid(1001),public.test_uuid(1),clock_timestamp()+interval '20 minutes',clock_timestamp()+interval '80 minutes');
grant usage on schema public to authenticated;
grant select,insert,update on public.reminders to authenticated;
grant insert on public.test_assertions to authenticated;
set role authenticated;
do $direct_role$
begin
  begin
    insert into public.reminders(patient_id,schedule_id,remind_at) values(public.test_uuid(1),public.test_uuid(1001),clock_timestamp()+interval '15 minutes');
    raise exception 'Expected authenticated timing rejection';
  exception when sqlstate '22023' then
    insert into public.test_assertions values('authenticated direct INSERT cannot bypass the timing trigger');
  end;
  insert into public.reminders(patient_id,schedule_id,remind_at,next_trigger_at)
  values(public.test_uuid(1),public.test_uuid(1001),clock_timestamp()+interval '5 minutes',clock_timestamp()-interval '1 minute');
  if not exists(select 1 from public.reminders where schedule_id=public.test_uuid(1001) and next_trigger_at=remind_at) then
    raise exception 'Authenticated INSERT did not canonicalize the selected occurrence';
  end if;
  insert into public.test_assertions values('authenticated valid direct INSERT works despite revoked direct trigger-function execute');
end;
$direct_role$;
reset role;
update public.reminders set status='cancelled' where schedule_id=public.test_uuid(1001);
select pg_temp.assert_true(not has_function_privilege('authenticated','public.process_due_appointment_reminders()','EXECUTE'),'Patient/client roles cannot execute the cron processor');

-- RPC security/idempotency and each timing branch.
do $rpc_contracts$
declare s uuid; row_result public.reminders; base timestamptz; uid uuid;
begin
  perform set_config('request.jwt.claim.sub',public.test_uuid(102)::text,false);
  base:=clock_timestamp();
  insert into public.schedule(patient_id,start_time,end_time) values(public.test_uuid(1),base+interval '25 hours',base+interval '26 hours') returning id into s;
  row_result:=public.create_appointment_patient_reminder(s);
  perform pg_temp.assert_true(row_result.remind_at=base+interval '1 hour','RPC 24h slot preserved');
  row_result:=public.create_appointment_patient_reminder(s);
  perform pg_temp.assert_true((select count(*)=1 from public.reminders where schedule_id=s),'RPC existing-reminder idempotency');
  base:=clock_timestamp();
  insert into public.schedule(patient_id,start_time,end_time) values(public.test_uuid(1),base+interval '2 hours',base+interval '3 hours') returning id into s;
  row_result:=public.create_appointment_patient_reminder(s);
  perform pg_temp.assert_true(row_result.remind_at=base+interval '1 hour','RPC 1h slot preserved');
  base:=clock_timestamp();
  insert into public.schedule(patient_id,start_time,end_time) values(public.test_uuid(1),base+interval '30 minutes',base+interval '90 minutes') returning id into s;
  row_result:=public.create_appointment_patient_reminder(s);
  perform pg_temp.assert_true(row_result.remind_at=base+interval '20 minutes' and row_result.remind_at>clock_timestamp(),'RPC short-lead slot is future and exactly ten minutes before start');
  update public.schedule set start_time=clock_timestamp()-interval '1 minute' where id=s;
  perform pg_temp.assert_true((public.create_appointment_patient_reminder(s)).id=row_result.id,'RPC existing reminder returns before elapsed-time validation');
  for uid in select public.test_uuid(n) from generate_series(103,104) n loop
    perform set_config('request.jwt.claim.sub',uid::text,false);
    perform pg_temp.assert_true((public.create_appointment_patient_reminder(s)).id=row_result.id,'RPC Staff/Admin role contract preserved');
  end loop;
  perform set_config('request.jwt.claim.sub',public.test_uuid(102)::text,false);
  foreach base in array array[clock_timestamp()+interval '9 minutes',clock_timestamp()+interval '10 minutes',clock_timestamp()-interval '1 minute'] loop
    insert into public.schedule(patient_id,start_time,end_time) values(public.test_uuid(1),base,base+interval '1 hour') returning id into s;
    perform pg_temp.expect_timing_error(format('select public.create_appointment_patient_reminder(%L)',s),'RPC rejects <=10-minute remaining or already-started appointment');
    perform pg_temp.assert_true(not exists(select 1 from public.reminders where schedule_id=s),'rejected RPC creates no reminder');
    update public.schedule set status='cancelled' where id=s;
  end loop;
  perform set_config('request.jwt.claim.sub',public.test_uuid(101)::text,false);
  begin perform public.create_appointment_patient_reminder(s); raise exception 'Expected role denial';
  exception when sqlstate '42501' then perform pg_temp.assert_true(true,'Patient role cannot call clinic reminder RPC'); end;
  perform set_config('request.jwt.claim.sub','',false);
  begin perform public.create_appointment_patient_reminder(s); raise exception 'Expected authentication denial';
  exception when sqlstate '42501' then perform pg_temp.assert_true(true,'unauthenticated RPC denied'); end;
end;
$rpc_contracts$;

-- Delivery, retry, expiry, eligibility, timing and anti-flood contracts.
do $processor_contracts$
declare result record; n integer; before_sms bigint; previous_sent timestamptz; original_due timestamptz;
begin
  update public.schedule set start_time=clock_timestamp()+interval '1 minute' where id=public.test_uuid(10);
  update public.reminders set status='pending' where id=public.test_uuid(10);
  select coalesce(next_trigger_at,remind_at) into original_due from public.reminders where id=public.test_uuid(10);
  select * into result from public.process_due_appointment_reminders();
  perform pg_temp.assert_true(result.notifications_created=1,'legacy near-start overdue occurrence delivers once before cutoff');
  perform pg_temp.assert_true((select scheduled_for=original_due from public.appointment_reminder_dispatches d join public.reminders r on r.id=d.reminder_id where r.id=public.test_uuid(10)),'configured identity is original occurrence, not execution time');
  perform pg_temp.assert_true((select count(*)=1 from net.test_calls where body->>'reminder_id'=public.test_uuid(10)::text),'successful configured occurrence enqueues SMS once');
  select * into result from public.process_due_appointment_reminders();
  perform pg_temp.assert_true(result.notifications_created=0,'duplicate processor invocation creates no duplicate');
  update public.reminders set status='pending',next_trigger_at=original_due where id=public.test_uuid(10);
  select * into result from public.process_due_appointment_reminders();
  perform pg_temp.assert_true(result.notifications_created=0 and (select count(*)=1 from public.patient_notifications where related_reminder_id=public.test_uuid(10)),'existing created configured dispatch is not duplicated');
  update public.reminders set status='sent',next_trigger_at=null where id=public.test_uuid(10);

  insert into public.test_controls values('fail_notification');
  update public.reminders set status='pending' where id=public.test_uuid(11);
  select * into result from public.process_due_appointment_reminders();
  perform pg_temp.assert_true(result.failed=1 and (select status='failed' and notification_id is null and notification_created_at is null and error_code='notification_insert_failed' from public.appointment_reminder_dispatches where reminder_id=public.test_uuid(11)),'notification failure records recoverable configured failed dispatch');
  delete from public.test_controls;
  select * into result from public.process_due_appointment_reminders();
  perform pg_temp.assert_true(result.notifications_created=1 and (select count(*)=1 from public.appointment_reminder_dispatches where reminder_id=public.test_uuid(11)),'failed configured dispatch is reclaimed without new ledger identity');
  perform pg_temp.assert_true((select count(*)=1 from net.test_calls where body->>'reminder_id'=public.test_uuid(11)::text),'failed retry enqueues SMS only on one created transition');

  foreach n in array array[20,21,32] loop
    update public.schedule set start_time=clock_timestamp()-interval '1 minute',end_time=clock_timestamp()-interval '30 seconds' where id=public.test_uuid(n);
    update public.reminders set status='pending' where id=public.test_uuid(n);
    select sent_at into previous_sent from public.reminders where id=public.test_uuid(n);
    select count(*) into before_sms from net.test_calls;
    select * into result from public.process_due_appointment_reminders();
    perform pg_temp.assert_true((select count(*)=before_sms from net.test_calls),'expiry makes no SMS enqueue at all');
    perform pg_temp.assert_true((select status='expired' and next_trigger_at is null and sent_at is not distinct from previous_sent from public.reminders where id=public.test_uuid(n)),'cutoff/ended expiry preserves sent_at and clears next trigger');
    perform pg_temp.assert_true(not exists(select 1 from public.appointment_reminder_dispatches where reminder_id=public.test_uuid(n)) and not exists(select 1 from public.patient_notifications where related_reminder_id=public.test_uuid(n)),'expiry creates no fabricated dispatch or notification');
    perform pg_temp.assert_true(not exists(select 1 from net.test_calls where body->>'reminder_id'=public.test_uuid(n)::text),'expiry enqueues no SMS');
    perform pg_temp.assert_true(result.examined>=1 and result.skipped>=1 and result.claimed=0,'expiry uses existing examined/skipped counters');
  end loop;

  foreach n in array array[22,23] loop
    update public.schedule set status=case n when 22 then 'cancelled' else 'completed' end where id=public.test_uuid(n);
    update public.reminders set status='pending' where id=public.test_uuid(n);
    select * into result from public.process_due_appointment_reminders();
    perform pg_temp.assert_true(result.notifications_created=0,'cancelled/completed appointments never deliver configured notification');
    update public.reminders set status='cancelled' where id=public.test_uuid(n);
  end loop;
  update public.patients set account_status='inactive' where id=public.test_uuid(2);
  update public.reminders set status='pending' where id=public.test_uuid(24);
  select * into result from public.process_due_appointment_reminders();
  perform pg_temp.assert_true(result.notifications_created=0,'inactive Patient delivery blocked');
  update public.reminders set status='cancelled' where id=public.test_uuid(24);

  foreach n in array array[25,26] loop
    insert into public.test_controls values(case n when 25 then 'cancel_claim' else 'complete_claim' end);
    update public.reminders set status='pending' where id=public.test_uuid(n);
    select * into result from public.process_due_appointment_reminders();
    perform pg_temp.assert_true(result.notifications_created=0 and (select status='skipped' from public.appointment_reminder_dispatches where reminder_id=public.test_uuid(n)),'fresh cancellation/completion after real claim prevents notification');
    perform pg_temp.assert_true(not exists(select 1 from net.test_calls where body->>'reminder_id'=public.test_uuid(n)::text),'ineligible claimed dispatch does not enqueue SMS');
    update public.reminders set status='cancelled' where id=public.test_uuid(n);
    delete from public.test_controls;
  end loop;

  foreach n in array array[27,28] loop
    insert into public.test_controls values(case n when 27 then 'delay_claim' else 'delay_notification' end);
    update public.schedule set start_time=clock_timestamp()+interval '400 milliseconds' where id=public.test_uuid(n);
    update public.reminders set status='pending' where id=public.test_uuid(n);
    select * into result from public.process_due_appointment_reminders();
    perform pg_temp.assert_true(result.notifications_created=0 and result.claimed=1 and (select status='skipped' and error_code='appointment_started_before_notification' from public.appointment_reminder_dispatches where reminder_id=public.test_uuid(n)),'wall-clock crossing resolves legitimate claim as skipped');
    perform pg_temp.assert_true((select status='expired' and sent_at is null and next_trigger_at is null from public.reminders where id=public.test_uuid(n)),'wall-clock crossing expires never-sent reminder');
    perform pg_temp.assert_true(not exists(select 1 from public.patient_notifications where related_reminder_id=public.test_uuid(n)) and not exists(select 1 from net.test_calls where body->>'reminder_id'=public.test_uuid(n)::text),'cutoff before/during INSERT persists no notification or SMS');
    delete from public.test_controls;
  end loop;

  foreach n in array array[30,31,33,34] loop
    update public.schedule set start_time=clock_timestamp()+case n when 31 then interval '8 days' when 33 then interval '5 minutes' else interval '5 hours' end where id=public.test_uuid(n);
    update public.reminders set status='pending',next_trigger_at=clock_timestamp()-case n when 31 then interval '4 days' when 33 then interval '30 minutes' else interval '10 hours' end where id=public.test_uuid(n);
    select next_trigger_at into original_due from public.reminders where id=public.test_uuid(n);
    select * into result from public.process_due_appointment_reminders();
    perform pg_temp.assert_true(result.notifications_created=1 and (select count(*)=1 from public.patient_notifications where related_reminder_id=public.test_uuid(n)),'hourly/daily outage/boundary produces at most one catch-up');
    perform pg_temp.assert_true((select r.next_trigger_at is null or (r.next_trigger_at>clock_timestamp() and r.next_trigger_at<s.start_time) from public.reminders r join public.schedule s on s.id=r.schedule_id where r.id=public.test_uuid(n)),'repeat advances future and never schedules at/after start');
    perform pg_temp.assert_true((select scheduled_for=original_due from public.appointment_reminder_dispatches where reminder_id=public.test_uuid(n)),'repeat claim retains original overdue occurrence');
    if n=34 then
      perform pg_temp.assert_true((select status='sent' and next_trigger_at is null from public.reminders where id=public.test_uuid(n)),'repeat_until boundary stops future scheduling');
    end if;
    update public.reminders set status='cancelled' where id=public.test_uuid(n);
  end loop;
  perform pg_temp.assert_true((select count(*) from public.test_native_enqueues)=(select count(*) from public.patient_notifications),'cutoff rollback and expiry leave no orphaned native enqueue');
end;
$processor_contracts$;

-- Fallback windows and one-minute repeated evaluation keep their separate claim.
do $fallback_contracts$
declare s uuid; result record; offset_minutes integer;
begin
  foreach offset_minutes in array array[1440,120] loop
    insert into public.schedule(patient_id,start_time,end_time) values(public.test_uuid(1),clock_timestamp()+make_interval(mins=>offset_minutes)-interval '1 minute',clock_timestamp()+make_interval(mins=>offset_minutes)+interval '1 hour') returning id into s;
    select * into result from public.process_due_appointment_reminders();
    perform pg_temp.assert_true(result.notifications_created=1 and (select count(*)=1 from public.appointment_reminder_dispatches where schedule_id=s and reminder_id is null and reminder_offset_minutes=offset_minutes),'automatic 24h/2h fallback window creates one offset claim');
    select * into result from public.process_due_appointment_reminders();
    perform pg_temp.assert_true(result.notifications_created=0 and (select count(*)=1 from public.patient_notifications where related_appointment_id=s),'more frequent fallback evaluation never duplicates occurrence');
    update public.schedule set status='cancelled' where id=s;
  end loop;
  update public.schedule set start_time=clock_timestamp()+interval '23 hours 59 minutes' where id=public.test_uuid(20);
  select * into result from public.process_due_appointment_reminders();
  perform pg_temp.assert_true(result.notifications_created=0 and not exists(select 1 from public.appointment_reminder_dispatches where schedule_id=public.test_uuid(20)),'expired configured row continues suppressing automatic fallback');
end;
$fallback_contracts$;
select 'SQL_ASSERTIONS_PASSED=' || count(*) from public.test_assertions;
