-- SELECT ONLY. Run on explicitly identified staging, save results privately, review before approval.
-- Definitions may differ from production/repository; no application RPC is invoked.
select current_database(), current_user, statement_timestamp(),
  c.relrowsecurity, c.relforcerowsecurity, pg_catalog.pg_get_userbyid(c.relowner) as owner
from pg_catalog.pg_class c where c.oid=pg_catalog.to_regclass('public.audit_logs');

select ordinal_position,column_name,data_type,is_nullable,column_default
from information_schema.columns where table_schema='public' and table_name='audit_logs' order by ordinal_position;

select p.oid::regprocedure as signature,pg_catalog.pg_get_userbyid(p.proowner) as owner,
  p.prosecdef,p.proconfig,p.proacl,
  pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\r\n',E'\n')) as body_md5,
  pg_catalog.pg_get_functiondef(p.oid) as definition
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
where p.prokind='f' and ((n.nspname='public' and p.proname in (
  'record_audit_event','record_internal_audit_event','admin_set_patient_account_status',
  'admin_set_doctor_account_status','admin_set_staff_account_status',
  'admin_user_management_assert_active_admin','is_active_admin_realtime'))
  or (n.nspname='s4audit_private' and p.proname='record_account_status'))
order by signature;

select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_catalog.pg_policies
where (schemaname='public' and tablename='audit_logs')
   or (schemaname='realtime' and tablename='messages')
order by schemaname,tablename,policyname;

select r.rolname,c.relacl,
  pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT') as can_select,
  pg_catalog.has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') as any_table_write,
  pg_catalog.has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE') as any_column_write
from pg_catalog.pg_class c cross join pg_catalog.pg_roles r
where c.oid=pg_catalog.to_regclass('public.audit_logs') and r.rolname in ('anon','authenticated','service_role');

select p.oid::regprocedure as signature,r.rolname,
  pg_catalog.has_schema_privilege(r.oid,n.oid,'USAGE') as schema_usage,
  pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE') as can_execute
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
cross join pg_catalog.pg_roles r
where ((n.nspname='public' and p.proname in ('record_audit_event','record_internal_audit_event',
    'admin_set_patient_account_status','admin_set_doctor_account_status','admin_set_staff_account_status'))
    or (n.nspname='s4audit_private' and p.proname='record_account_status'))
  and r.rolname in ('anon','authenticated','service_role') order by signature,r.rolname;

select conname,pg_catalog.pg_get_constraintdef(oid) as definition from pg_catalog.pg_constraint
where conrelid=pg_catalog.to_regclass('public.audit_logs') order by conname;

select t.tgname,t.tgenabled,t.tgisinternal,pg_catalog.pg_get_triggerdef(t.oid,true) as definition,
  pg_catalog.pg_get_functiondef(t.tgfoid) as function_definition
from pg_catalog.pg_trigger t where t.tgrelid=pg_catalog.to_regclass('public.audit_logs');

-- Run only after confirming these columns exist. Counts contain no identifying payloads.
with safe_sources as (
select a.module,a.action,a.actor_role,a.status,
  pg_catalog.to_jsonb(a)->>'event_origin' as event_origin,
  case when a.metadata->>'event_source' in ('client_reported','server_transaction')
    then a.metadata->>'event_source'
    when a.metadata->>'event_source' is null then 'not_recorded'
    else 'unrecognized' end as metadata_source
from public.audit_logs a where a.created_at>=statement_timestamp()-interval '30 days'
)
select module,action,actor_role,status,event_origin,metadata_source,count(*) as events
from safe_sources group by module,action,actor_role,status,event_origin,metadata_source
order by module,action,actor_role,status,event_origin,metadata_source;

-- Catalog only: no subscription, message send, application RPC or session mutation.
-- No rows from pg_policies alone does not establish effective Realtime access.
select c.oid::regclass as relation,c.relrowsecurity,c.relforcerowsecurity,
  pg_catalog.pg_get_userbyid(c.relowner) as owner,r.rolname,r.rolbypassrls,
  pg_catalog.has_schema_privilege(r.oid,n.oid,'USAGE') as schema_usage,
  pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT') as select_permission
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
cross join pg_catalog.pg_roles r
where c.oid=pg_catalog.to_regclass('realtime.messages')
  and r.rolname in ('anon','authenticated','service_role');
