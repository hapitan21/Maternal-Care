-- READ-ONLY. Run only after separately reviewing the installed audit RPC restriction.
-- No row data, clinical payloads, function bodies, trigger arguments or secrets returned.
-- The fingerprint is a drift guard, NOT evidence that permissions are safe.
-- Save results privately; review installed definitions/permissions before approving a hash.

-- BEGIN CATALOG FINGERPRINT
with source_relations as (
  select c.oid, n.nspname, c.relname, c.relowner, c.relacl, c.relrowsecurity, c.relforcerowsecurity
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in (
    'audit_logs','profiles','patients','schedule','appointment_events','staff_visit_intake',
    'medical_records','reminders','medication_reminders','create_patient_appointment_request',
    'medication_reminder_occurrences')
), catalog_entries as (
  select 'relation:'||r.relname as key, pg_catalog.to_jsonb(r)::text as value from source_relations r
  union all
  select 'column:'||r.relname||':'||a.attname,
    pg_catalog.jsonb_build_array(a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attacl,
      pg_catalog.pg_get_expr(d.adbin,d.adrelid))::text
  from source_relations r join pg_catalog.pg_attribute a on a.attrelid=r.oid
  left join pg_catalog.pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where a.attnum>0 and not a.attisdropped
  union all
  select 'constraint:'||r.relname||':'||c.conname,
    pg_catalog.jsonb_build_array(c.convalidated,pg_catalog.pg_get_constraintdef(c.oid))::text
  from source_relations r join pg_catalog.pg_constraint c on c.conrelid=r.oid
  union all
  select 'policy:'||r.relname||':'||p.polname,
    pg_catalog.jsonb_build_array(p.polcmd,p.polpermissive,p.polroles,
      pg_catalog.pg_get_expr(p.polqual,p.polrelid),pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid))::text
  from source_relations r join pg_catalog.pg_policy p on p.polrelid=r.oid
  union all
  select 'trigger:'||r.relname||':'||t.tgname,
    pg_catalog.jsonb_build_array(t.tgenabled,pg_catalog.pg_get_triggerdef(t.oid))::text
  from source_relations r join pg_catalog.pg_trigger t on t.tgrelid=r.oid where not t.tgisinternal
  union all
  select 'function:'||p.oid::pg_catalog.regprocedure::text,
    pg_catalog.jsonb_build_array(p.proowner,p.proacl,p.prosecdef,p.proconfig,
      pg_catalog.replace(pg_catalog.pg_get_functiondef(p.oid),E'\r\n',E'\n'))::text
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prokind='f'
  union all
  select 'schema:'||n.nspname, pg_catalog.jsonb_build_array(n.nspowner,n.nspacl)::text
  from pg_catalog.pg_namespace n where n.nspname in ('public','auth')
  union all
  select 'role:'||r.rolname, pg_catalog.to_jsonb(r)::text from pg_catalog.pg_roles r
  where r.rolname in ('postgres','anon','authenticated','service_role','authenticator')
  union all
  select 'membership:'||m.roleid::text||':'||m.member::text, pg_catalog.to_jsonb(m)::text
  from pg_catalog.pg_auth_members m
)
select pg_catalog.md5(pg_catalog.string_agg(key||'='||value,E'\n' order by key)) as catalog_md5
from catalog_entries;
-- END CATALOG FINGERPRINT

-- Structural inventory: repository definitions must NOT be assumed installed.
select table_name,column_name,udt_name,is_nullable
from information_schema.columns where table_schema='public' and table_name in (
  'audit_logs','profiles','patients','schedule','appointment_events','staff_visit_intake','medical_records',
  'reminders','medication_reminders','create_patient_appointment_request','medication_reminder_occurrences')
order by table_name,ordinal_position;

select p.oid::pg_catalog.regprocedure::text as function_signature,
  pg_catalog.pg_get_userbyid(p.proowner) as owner,p.prosecdef as security_definer,p.proconfig,
  pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\r\n',E'\n')) as body_md5,
  pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
  pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
  pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('record_audit_event','record_internal_audit_event',
  'create_standard_appointment','reschedule_appointment','accept_patient_appointment_request',
  'create_patient_appointment_request','save_staff_visit_intake','save_appointment_visit_record',
  'get_appointment_visit_form_type','get_staff_visit_intake',
  'save_appointment_visit_record_unchecked_v1','save_staff_visit_intake_unchecked_v1',
  'get_appointment_visit_form_type_unchecked_v1','get_staff_visit_intake_unchecked_v1',
  'sync_doctor_visit_pregnancy_state','finish_patient_registration','finish_walkin_patient_registration',
  'mark_medication_reminder_occurrence') order by function_signature;

select t.tgrelid::pg_catalog.regclass::text as table_name,t.tgname,t.tgenabled,
  t.tgfoid::pg_catalog.regprocedure::text as function_signature,
  pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\r\n',E'\n')) as body_md5
from pg_catalog.pg_trigger t join pg_catalog.pg_proc p on p.oid=t.tgfoid
where not t.tgisinternal and t.tgrelid in (select c.oid from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in (
    'audit_logs','schedule','appointment_events','staff_visit_intake','medical_records','patients',
    'reminders','medication_reminders','create_patient_appointment_request','medication_reminder_occurrences'))
order by table_name,t.tgname;

select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
from pg_catalog.pg_policies where schemaname='public' and tablename in (
  'audit_logs','profiles','patients','schedule','appointment_events','staff_visit_intake','medical_records',
  'reminders','medication_reminders','create_patient_appointment_request','medication_reminder_occurrences')
order by tablename,policyname;

select grantee,table_name,privilege_type from information_schema.table_privileges
where table_schema='public' and table_name in ('audit_logs','profiles','patients','schedule',
  'appointment_events','staff_visit_intake','medical_records','reminders','medication_reminders',
  'create_patient_appointment_request','medication_reminder_occurrences') order by table_name,grantee,privilege_type;
