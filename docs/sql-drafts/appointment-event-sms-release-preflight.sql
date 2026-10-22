-- READ-ONLY MANUAL REVIEW ONLY. No SMS/RPC invocation, Vault values or patient rows returned.
-- Run section 1 first. STOP before section 2 if Vault/view or dispatch table is absent.
-- A source/body hash match is not proof of effective authorization or deployed Edge parity.

-- 1. Installed prerequisites and definitions (body hashes only).
select current_database() as database_name,current_setting('server_version') as postgres_version,
  pg_catalog.to_regclass('vault.decrypted_secrets') is not null as vault_view_exists,
  pg_catalog.to_regclass('public.notification_dispatches') is not null as dispatch_table_exists;

select e.extname,e.extversion from pg_catalog.pg_extension e
where e.extname in ('supabase_vault','pgsodium','pg_net') order by e.extname;

select p.oid::pg_catalog.regprocedure::text as signature,pg_catalog.pg_get_userbyid(p.proowner) as owner,
  p.prosecdef as security_definer,p.proconfig,
  pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\r\n',E'\n')) as body_md5,
  pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
  pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
  pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in (
  'is_appointment_event_sms_enabled','claim_notification_dispatch','claim_notification_dispatch_retry',
  'reschedule_appointment','accept_patient_appointment_request') order by signature;

select column_name,udt_name,is_nullable from information_schema.columns
where table_schema='public' and table_name='notification_dispatches' order by ordinal_position;

select c.conname,c.contype,c.convalidated,pg_catalog.pg_get_constraintdef(c.oid) as definition
from pg_catalog.pg_constraint c where c.conrelid=pg_catalog.to_regclass('public.notification_dispatches')
order by c.conname;

select t.tgname,t.tgenabled,t.tgfoid::pg_catalog.regprocedure::text as trigger_function,
  pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\r\n',E'\n')) as body_md5
from pg_catalog.pg_trigger t join pg_catalog.pg_proc p on p.oid=t.tgfoid
where t.tgrelid=pg_catalog.to_regclass('public.notification_dispatches') and not t.tgisinternal order by t.tgname;

select role_name,
  pg_catalog.has_table_privilege(role_name,'public.notification_dispatches','INSERT,UPDATE,DELETE') as table_write,
  pg_catalog.has_any_column_privilege(role_name,'public.notification_dispatches','INSERT,UPDATE') as column_write,
  pg_catalog.has_schema_privilege(role_name,'public','CREATE') as public_schema_create,
  pg_catalog.has_schema_privilege(role_name,'vault','USAGE') as vault_schema_usage
from (values('anon'),('authenticated'),('service_role')) as roles(role_name);

-- 2. Only configuration CLASSIFICATIONS, never decrypted values. Event switch must be absent/OFF.
-- Both reminder bridges must also be absent/OFF; this release never enables them.
select expected.name,count(secret.name) as entry_count,
  case when count(secret.name)=0 then 'ABSENT_OFF'
    when count(secret.name)<>1 then 'DUPLICATE_OFF'
    when bool_and(secret.decrypted_secret='true') then 'ENABLED'
    when bool_and(secret.decrypted_secret='false') then 'EXPLICIT_OFF'
    else 'INVALID_OFF' end as state
from (values('appointment_event_sms_enabled'),('appointment_sms_bridge_enabled'),
  ('medication_sms_bridge_enabled')) as expected(name)
left join vault.decrypted_secrets secret on secret.name=expected.name group by expected.name order by expected.name;

-- Aggregate history/queue evidence. No dispatch IDs, phones, message text or provider receipts.
select notification_type,status,provider,count(*) as dispatch_count,
  count(*) filter(where status='processing' and provider is null) as unreserved_processing,
  count(*) filter(where status='processing' and provider is not null) as reserved_processing
from public.notification_dispatches where channel='sms'
group by notification_type,status,provider order by notification_type,status,provider;
