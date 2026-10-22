\ir guard.sql
-- No application RPC is invoked. Only synthetic catalog facts and counts are returned.
select current_database(),current_user,current_setting('server_version') as server_version;
select ordinal_position,column_name,udt_name,is_nullable from information_schema.columns
 where table_schema='public' and table_name='audit_logs' order by ordinal_position;
select conname,convalidated,pg_get_constraintdef(oid) as definition from pg_constraint
 where conrelid='public.audit_logs'::regclass order by conname;
select r.rolname,has_table_privilege(r.oid,'public.audit_logs','SELECT') as can_select,
 has_table_privilege(r.oid,'public.audit_logs','INSERT,UPDATE,DELETE,TRUNCATE') as any_write,
 has_any_column_privilege(r.oid,'public.audit_logs','INSERT,UPDATE') as any_column_write
 from pg_roles r where rolname in ('anon','authenticated','service_role');
select p.oid::regprocedure as signature,pg_get_userbyid(proowner) as owner,prosecdef,proconfig,
 md5(replace(prosrc,E'\r\n',E'\n')) as body_md5,proacl
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
 and proname in ('record_audit_event','record_internal_audit_event','admin_set_patient_account_status','admin_set_doctor_account_status','admin_set_staff_account_status') order by signature;
select p.oid::regprocedure as signature,r.rolname,has_function_privilege(r.oid,p.oid,'EXECUTE') as executable
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join pg_roles r
 where n.nspname='public' and proname='record_internal_audit_event' and rolname in ('anon','authenticated','service_role');
select policyname,roles,cmd,qual,with_check from pg_policies where schemaname='public' and tablename='audit_logs';
select tgname,tgenabled,pg_get_triggerdef(oid) as definition from pg_trigger where tgrelid='public.audit_logs'::regclass and not tgisinternal;
select module,action,actor_role,status,count(*) from public.audit_logs group by module,action,actor_role,status order by module,action,actor_role,status;
