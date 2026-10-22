-- ORIGINAL PRODUCTION AUDIT DIAGNOSTICS — SELECT ONLY, manual SQL Editor batch.
-- No application RPC is invoked. No configuration or data changes occur.
-- Returns aggregate counts and catalog metadata, not actor identities, patient
-- records, clinical payloads, IPs, request headers, tokens or trigger arguments.
-- Run section 01 first; audit_logs and its repository columns must exist before
-- continuing. Use an authorized SQL Editor session; it may bypass RLS and therefore
-- cannot prove what an authenticated Admin/Doctor/Staff/Patient JWT can SELECT.
-- Inspect every result set. Concurrent new inserts can change counts between SELECTs.

-- 01. Existence and installed structure (15/16-column compatibility).
select '01_relations' as diagnostic, n.nspname as schema_name, c.relname,
       c.relrowsecurity as rls_enabled, c.relforcerowsecurity as force_rls,
       pg_catalog.pg_get_userbyid(c.relowner) as owner
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where (n.nspname, c.relname) in (('public','audit_logs'), ('realtime','messages'))
order by n.nspname, c.relname;

select '01_columns' as diagnostic, a.attnum as ordinal, a.attname as column_name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type, a.attnotnull as not_null
from pg_catalog.pg_attribute a
where a.attrelid = pg_catalog.to_regclass('public.audit_logs')
  and a.attnum > 0 and not a.attisdropped order by a.attnum;

-- 02. All-time coverage; do not infer coverage from a seven-day window alone.
select '02_all_time' as diagnostic, module, action, actor_role, status,
       count(*) as event_count, min(created_at) as first_event_at, max(created_at) as last_event_at
from public.audit_logs group by module, action, actor_role, status
order by module, action, actor_role, status;

select '02_bounds' as diagnostic, count(*) as all_time_events,
       min(created_at) as first_event_at, max(created_at) as latest_event_at,
       count(distinct actor_user_id) as distinct_actor_count
from public.audit_logs;

-- 03. Match the frontend's inclusive Manila Oct 13–19 range using an exclusive
-- Oct 20 bound. Compare with All Users / All Modules / All Actions selected.
select '03_selected_range' as diagnostic, module, action, actor_role, status, count(*) as event_count
from public.audit_logs
where created_at >= timestamptz '2026-10-13 00:00:00+08'
  and created_at <  timestamptz '2026-10-20 00:00:00+08'
group by module, action, actor_role, status order by module, action, actor_role, status;

select '03_cards' as diagnostic, count(*) as total_activity,
       count(*) filter (where action in ('login','logout')) as authentication_card,
       count(*) filter (where action in ('activate','deactivate','reactivate','role_change')) as account_access_card,
       count(*) filter (where module = 'reports') as reports_module,
       count(*) filter (where module = 'authentication') as authentication_module
from public.audit_logs
where created_at >= timestamptz '2026-10-13 00:00:00+08'
  and created_at <  timestamptz '2026-10-20 00:00:00+08';

select '03_daily_manila' as diagnostic, (created_at at time zone 'Asia/Manila')::date as day,
       module, action, count(*) as event_count
from public.audit_logs
where created_at >= timestamptz '2026-10-13 00:00:00+08'
  and created_at <  timestamptz '2026-10-20 00:00:00+08'
group by (created_at at time zone 'Asia/Manila')::date, module, action
order by day, module, action;

-- 04. Dashboard is GLOBAL latest eight, independent of its summary date selector.
-- Same sort/limit, but aggregate to avoid returning identities/descriptions/IDs.
select '04_dashboard_latest_eight' as diagnostic, module, action, actor_role,
       count(*) as event_count, min(created_at) as first_at, max(created_at) as last_at
from (select module, action, actor_role, created_at from public.audit_logs
      order by created_at desc, id desc limit 8) recent
group by module, action, actor_role order by module, action, actor_role;

-- 05. Source classifications only. Optional event_origin is read through to_jsonb
-- so this query also works on the original 15-column schema. Never output metadata.
select '05_event_origins' as diagnostic, source_class, status, count(*) as event_count
from (
  select status, case
    when pg_catalog.to_jsonb(a)->>'event_origin' = 'client_reported' then 'client_reported'
    when pg_catalog.to_jsonb(a)->>'event_origin' = 'server_verified' and status = 'reported' then 'conflicting_source_markers'
    when pg_catalog.to_jsonb(a)->>'event_origin' = 'server_verified' then 'dedicated_server_verified'
    when pg_catalog.to_jsonb(a)->>'event_origin' is not null then 'unrecognized_dedicated_origin'
    when status = 'reported' or metadata->>'event_source' = 'client_reported' then 'client_reported'
    when metadata->>'event_source' = 'server_transaction' then 'legacy_metadata_server_marker'
    else 'legacy_unspecified' end as source_class
  from public.audit_logs a
) classified group by source_class, status order by source_class, status;

-- 06. Direct/indirect audit writer and publisher CANDIDATES, not proof of execution.
-- prosrc searches can match comments; dynamic SQL/external publishers may be missed.
-- Function bodies and security configuration values are deliberately not returned.
select '06_functions' as diagnostic, n.nspname as schema_name, p.oid::regprocedure as signature,
       pg_catalog.pg_get_userbyid(p.proowner) as owner, l.lanname as language,
       p.prosecdef as security_definer, p.provolatile as volatility,
       pg_catalog.md5(p.prosrc) as body_md5,
       array(select setting from unnest(coalesce(p.proconfig, array[]::text[])) setting
             where setting like 'search_path=%') as search_path,
       p.prosrc ~* '(insert[[:space:]]+into|update|delete[[:space:]]+from)[[:space:]]+public[.]audit_logs' as mentions_direct_audit_write,
       p.prosrc ~* 'record_audit_event|record_account_status|record_internal_audit_event' as mentions_audit_writer,
       p.prosrc ~* 'audit_log_changed|admin:audit-logs|realtime[.]send' as mentions_broadcast,
       p.prosrc ~* 'auth[.]uid' as mentions_actor_auth_uid,
       p.prosrc ~* 'client_reported|reported' as mentions_client_report,
       pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
       pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
       pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute,
       pg_catalog.has_schema_privilege('anon', n.oid, 'USAGE') as anon_schema_usage,
       pg_catalog.has_schema_privilege('authenticated', n.oid, 'USAGE') as authenticated_schema_usage,
       pg_catalog.has_schema_privilege('service_role', n.oid, 'USAGE') as service_schema_usage
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
join pg_catalog.pg_language l on l.oid = p.prolang
where p.prokind = 'f' and n.nspname not in ('pg_catalog','information_schema')
  and (p.proname in ('record_audit_event','record_account_status','record_internal_audit_event',
                    'broadcast_admin_audit_log_change','is_active_admin_realtime')
       or p.prosrc ~* 'audit_logs|record_audit_event|record_account_status|record_internal_audit_event|audit_log_changed')
order by n.nspname, p.proname, p.oid;

-- PUBLIC default/inherited grants matter even if an explicit role grant is absent.
select '06_function_acl' as diagnostic, n.nspname as schema_name, p.oid::regprocedure as signature,
       case when acl.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(acl.grantee) end as grantee,
       acl.privilege_type, acl.is_grantable
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
where p.prokind = 'f' and p.proname in ('record_audit_event','record_account_status','record_internal_audit_event',
  'admin_set_patient_account_status','admin_set_doctor_account_status','admin_set_staff_account_status',
  'broadcast_admin_audit_log_change','is_active_admin_realtime')
order by n.nspname, p.proname, grantee;

-- 07. Attached trigger inventory: no tgargs / trigger definitions / webhook headers.
select '07_triggers' as diagnostic, n.nspname as table_schema, c.relname as table_name,
       t.tgname, t.tgenabled, pn.nspname as function_schema, p.oid::regprocedure as function_signature,
       p.prosecdef as function_security_definer, pg_catalog.md5(p.prosrc) as function_body_md5,
       (t.tgtype::integer & 1) <> 0 as per_row,
       (t.tgtype::integer & 4) <> 0 as on_insert,
       (t.tgtype::integer & 16) <> 0 as on_update,
       (t.tgtype::integer & 8) <> 0 as on_delete,
       p.prosrc ~* 'audit_logs|record_audit_event|record_account_status|record_internal_audit_event' as mentions_audit,
       p.prosrc ~* 'audit_log_changed|admin:audit-logs' as mentions_audit_broadcast
from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_proc p on p.oid = t.tgfoid
join pg_catalog.pg_namespace pn on pn.oid = p.pronamespace
where not t.tgisinternal and (c.oid = pg_catalog.to_regclass('public.audit_logs')
  or p.prosrc ~* 'audit_logs|record_audit_event|record_account_status|record_internal_audit_event|audit_log_changed')
order by n.nspname, c.relname, t.tgname;

-- 08. ALL applicable table policies, not just policies with audit-like names.
-- Redact string literals in policy expressions; show logic/functions and hashes.
select '08_policies' as diagnostic, schemaname, tablename, policyname, permissive, roles, cmd,
       pg_catalog.regexp_replace(qual, '''[^'']*''', '''[literal]''', 'g') as using_expression_redacted,
       pg_catalog.regexp_replace(with_check, '''[^'']*''', '''[literal]''', 'g') as check_expression_redacted,
       position('''admin''' in coalesce(qual,'')) > 0 as mentions_admin_literal,
       position('''active''' in coalesce(qual,'')) > 0 as mentions_active_literal,
       position('admin:audit-logs' in coalesce(qual,'')) > 0 as mentions_audit_topic,
       pg_catalog.md5(coalesce(qual,'') || '|' || coalesce(with_check,'')) as expression_md5
from pg_catalog.pg_policies
where (schemaname, tablename) in (('public','audit_logs'), ('realtime','messages'))
order by schemaname, tablename, policyname;

select '08_effective_table_privileges' as diagnostic, r.rolname, n.nspname as schema_name, c.relname,
       r.rolsuper as superuser, r.rolbypassrls as bypass_rls, r.rolinherit as inherits_privileges,
       pg_catalog.has_schema_privilege(r.oid, n.oid, 'USAGE') as schema_usage,
       pg_catalog.has_table_privilege(r.oid, c.oid, 'SELECT') as can_select,
       pg_catalog.has_table_privilege(r.oid, c.oid, 'INSERT') as can_insert,
       pg_catalog.has_table_privilege(r.oid, c.oid, 'UPDATE') as can_update,
       pg_catalog.has_table_privilege(r.oid, c.oid, 'DELETE') as can_delete,
       pg_catalog.has_table_privilege(r.oid, c.oid, 'TRUNCATE') as can_truncate
from pg_catalog.pg_roles r cross join pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where r.rolname in ('anon','authenticated','service_role')
  and (n.nspname, c.relname) in (('public','audit_logs'), ('realtime','messages'))
order by n.nspname, c.relname, r.rolname;

select '08_column_grants' as diagnostic, table_schema, table_name, grantee, column_name, privilege_type
from information_schema.column_privileges
where table_schema = 'public' and table_name = 'audit_logs'
order by grantee, column_name, privilege_type;

-- 09. Postgres Changes publication inventory. This is NOT a prerequisite for the
-- current private Broadcast + realtime.send path; do not add a publication to fix it.
select '09_publication_status' as diagnostic, p.pubname, p.puballtables,
       p.pubinsert, p.pubupdate, p.pubdelete, p.pubtruncate,
       exists(select 1 from pg_catalog.pg_publication_tables pt
              where pt.pubname = p.pubname and pt.schemaname = 'public'
                and pt.tablename = 'audit_logs') as includes_audit_logs
from pg_catalog.pg_publication p order by p.pubname;

-- 10. Independent stores exist, but no contents are exposed or merged into audit_logs.
select '10_other_stores' as diagnostic, n.nspname, c.relname
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r','p','v') and n.nspname not in ('pg_catalog','information_schema')
  and (c.relname ilike '%audit%' or c.relname in ('appointment_events','medication_reminder_occurrences',
       'medication_adherence_followups','patient_notifications'))
order by n.nspname, c.relname;

-- Interpretation:
-- * All-time non-auth/report rows + no rows in section 03 => date-window evidence,
--   not proof of missing instrumentation. Compare section 03 with unfiltered UI.
-- * Section 04 explains a login-heavy latest-eight widget without inventing data.
-- * Zero historical counts plus no installed writer/trigger candidates supports a
--   producer gap; inspect candidate bodies privately before concluding anything.
-- * Normal authenticated SELECT grant + active-Admin RLS can be correct. Direct
--   audit write grants, disabled RLS or unrestricted public writer claims need review.
-- * A broad legacy record_audit_event may permit forged business-success claims;
--   signatures/hashes alone cannot certify its body. Compare the installed definition
--   with the existing guarded production security proposal; do not bypass its guards.
-- * Enabled INSERT publisher + matching topic/event + authorized private JWT join
--   are required for Broadcast delivery. SUBSCRIBED alone does not prove publishing.
-- * Realtime service settings and actual WebSocket join/delivery errors require
--   separate runtime inspection. Never paste JWTs, secrets or full payloads.
