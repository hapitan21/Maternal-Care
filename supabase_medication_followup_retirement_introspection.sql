-- ============================================================
-- Medication follow-up retirement: deployed-state introspection
-- ============================================================
-- READ ONLY. Run in the Supabase SQL Editor before reviewing or applying
-- supabase_retire_medication_followup_pipeline.sql.

-- 1. Exact legacy relations and retained medication relations.
select requested.object_name,
       pg_catalog.to_regclass(requested.object_name) as deployed_relation
from (values
  ('public.medication_adherence_followups'),
  ('public.medication_adherence_followup_events'),
  ('public.medication_adherence_followup_assignment_audits'),
  ('public.doctor_notifications'),
  ('public.medication_followup_alert_dispatches'),
  ('public.doctor_push_subscriptions'),
  ('public.doctor_notification_push_deliveries'),
  ('public.medication_reminders'),
  ('public.medication_reminder_occurrences'),
  ('public.schedule'),
  ('public.medical_records'),
  ('public.system_settings')
) as requested(object_name)
order by requested.object_name;

-- 2. Legacy and retained RPC signatures, ownership, security, and definitions.
select routine.oid::pg_catalog.regprocedure as signature,
       pg_catalog.pg_get_function_result(routine.oid) as result_type,
       routine.prosecdef as security_definer,
       routine.proconfig,
       pg_catalog.pg_get_userbyid(routine.proowner) as owner,
       pg_catalog.pg_get_functiondef(routine.oid) as definition
from pg_catalog.pg_proc as routine
join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
where namespace.nspname = 'public'
  and routine.proname in (
    'start_medication_adherence_followup',
    'add_medication_adherence_followup_event',
    'update_medication_adherence_followup_status',
    'get_admin_followup_oversight_queue',
    'get_admin_followup_oversight_detail',
    'get_admin_followup_oversight_summary',
    'admin_acknowledge_medication_followup_review',
    'admin_reassign_medication_followup',
    'get_doctor_notifications',
    'mark_doctor_notification_read',
    'mark_all_doctor_notifications_read',
    'upsert_my_doctor_push_subscription',
    'deactivate_my_doctor_push_subscription',
    'process_due_medication_followup_alerts',
    'claim_doctor_notification_push_delivery',
    'set_medication_adherence_followup_updated_at',
    'set_doctor_notification_updated_at',
    'set_medication_followup_alert_dispatch_updated_at',
    'set_doctor_push_subscriptions_updated_at',
    'set_doctor_notification_push_deliveries_updated_at',
    'get_admin_dashboard_summary',
    'get_admin_system_settings',
    'update_admin_system_settings'
  )
order by routine.proname, pg_catalog.pg_get_function_identity_arguments(routine.oid);

-- 3. Foreign keys that point into a legacy table. Any row whose source_table
-- is not one of the seven legacy tables is an unexpected dependency and must
-- be audited before cleanup.
select constraint_record.oid as constraint_oid,
       constraint_record.conname,
       constraint_record.conrelid::pg_catalog.regclass as source_table,
       constraint_record.confrelid::pg_catalog.regclass as referenced_table,
       pg_catalog.pg_get_constraintdef(constraint_record.oid) as definition
from pg_catalog.pg_constraint as constraint_record
where constraint_record.contype = 'f'
  and constraint_record.confrelid in (
    pg_catalog.to_regclass('public.medication_adherence_followups'),
    pg_catalog.to_regclass('public.medication_adherence_followup_events'),
    pg_catalog.to_regclass('public.medication_adherence_followup_assignment_audits'),
    pg_catalog.to_regclass('public.doctor_notifications'),
    pg_catalog.to_regclass('public.medication_followup_alert_dispatches'),
    pg_catalog.to_regclass('public.doctor_push_subscriptions'),
    pg_catalog.to_regclass('public.doctor_notification_push_deliveries')
  )
order by source_table::text, constraint_record.conname;

-- 4. Non-internal dependency records involving legacy relations/functions.
with legacy_objects as (
  select 'pg_catalog.pg_class'::pg_catalog.regclass as catalog_oid,
         relation.oid, 'relation'::text as object_kind
  from pg_catalog.pg_class as relation
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relname in (
      'medication_adherence_followups',
      'medication_adherence_followup_events',
      'medication_adherence_followup_assignment_audits',
      'doctor_notifications',
      'medication_followup_alert_dispatches',
      'doctor_push_subscriptions',
      'doctor_notification_push_deliveries'
    )
  union all
  select 'pg_catalog.pg_proc'::pg_catalog.regclass,
         routine.oid, 'function'
  from pg_catalog.pg_proc as routine
  join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
  where namespace.nspname = 'public'
    and routine.proname ~ '(medication.*followup|followup.*medication|doctor_notification|doctor_push)'
)
select dependency.deptype,
       dependency.classid::pg_catalog.regclass as dependent_catalog,
       dependency.objid,
       dependency.refclassid::pg_catalog.regclass as referenced_catalog,
       dependency.refobjid,
       legacy.object_kind,
       legacy.oid as legacy_oid
from pg_catalog.pg_depend as dependency
join legacy_objects as legacy
  on (dependency.classid = legacy.catalog_oid and dependency.objid = legacy.oid)
  or (dependency.refclassid = legacy.catalog_oid and dependency.refobjid = legacy.oid)
where dependency.deptype <> 'i'
order by legacy.object_kind, legacy.oid, dependency.deptype;

-- 5. Triggers on legacy tables or triggers whose function body/name mentions
-- the retired pipeline. Unexpected triggers must be removed from the proposed
-- migration only after manual review.
select trigger_record.oid,
       trigger_record.tgrelid::pg_catalog.regclass as table_name,
       trigger_record.tgname,
       trigger_record.tgfoid::pg_catalog.regprocedure as trigger_function,
       pg_catalog.pg_get_triggerdef(trigger_record.oid, true) as definition
from pg_catalog.pg_trigger as trigger_record
join pg_catalog.pg_proc as routine on routine.oid = trigger_record.tgfoid
where not trigger_record.tgisinternal
  and (
    trigger_record.tgrelid in (
      pg_catalog.to_regclass('public.medication_adherence_followups'),
      pg_catalog.to_regclass('public.medication_adherence_followup_events'),
      pg_catalog.to_regclass('public.medication_adherence_followup_assignment_audits'),
      pg_catalog.to_regclass('public.doctor_notifications'),
      pg_catalog.to_regclass('public.medication_followup_alert_dispatches'),
      pg_catalog.to_regclass('public.doctor_push_subscriptions'),
      pg_catalog.to_regclass('public.doctor_notification_push_deliveries')
    )
    or routine.proname ~ '(medication.*followup|followup.*medication|doctor_notification|doctor_push)'
    or pg_catalog.pg_get_functiondef(routine.oid) ~* '(medication[_ -].*followup|doctor_notifications|doctor_push_subscriptions)'
  )
order by table_name::text, trigger_record.tgname;

-- 6. RLS policies and table grants on the legacy relations.
select policy.schemaname, policy.tablename, policy.policyname,
       policy.roles, policy.cmd, policy.qual, policy.with_check
from pg_catalog.pg_policies as policy
where policy.schemaname = 'public'
  and policy.tablename in (
    'medication_adherence_followups',
    'medication_adherence_followup_events',
    'medication_adherence_followup_assignment_audits',
    'doctor_notifications',
    'medication_followup_alert_dispatches',
    'doctor_push_subscriptions',
    'doctor_notification_push_deliveries'
  )
order by policy.tablename, policy.policyname;

select grant_record.table_name, grant_record.grantee, grant_record.privilege_type
from information_schema.role_table_grants as grant_record
where grant_record.table_schema = 'public'
  and grant_record.table_name in (
    'medication_adherence_followups',
    'medication_adherence_followup_events',
    'medication_adherence_followup_assignment_audits',
    'doctor_notifications',
    'medication_followup_alert_dispatches',
    'doctor_push_subscriptions',
    'doctor_notification_push_deliveries'
  )
order by grant_record.table_name, grant_record.grantee, grant_record.privilege_type;

-- 7. Function grants for every legacy RPC/helper.
select routine.oid::pg_catalog.regprocedure as signature,
       case when privilege.grantee = 0 then 'PUBLIC'
            else pg_catalog.pg_get_userbyid(privilege.grantee) end as grantee,
       privilege.privilege_type
from pg_catalog.pg_proc as routine
join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
cross join lateral pg_catalog.aclexplode(
  coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
) as privilege
where namespace.nspname = 'public'
  and routine.proname ~ '(medication.*followup|followup.*medication|doctor_notification|doctor_push)'
order by signature::text, grantee;

-- 8. Realtime publication membership. doctor_notifications must be removed
-- from the publication before its table is dropped.
select publication.pubname,
       publication_relation.prrelid::pg_catalog.regclass as published_table
from pg_catalog.pg_publication as publication
join pg_catalog.pg_publication_rel as publication_relation
  on publication_relation.prpubid = publication.oid
where publication_relation.prrelid = pg_catalog.to_regclass('public.doctor_notifications');

-- 9. Cron and recent executions. First confirm pg_cron/cron.job exists. Run
-- the second and third queries only when cron.job is present.
select extension.extname, extension.extversion,
       pg_catalog.to_regclass('cron.job') as cron_job_table
from pg_catalog.pg_extension as extension
where extension.extname = 'pg_cron';

-- select jobid, jobname, schedule, command, active, database, username
-- from cron.job
-- where jobname = 'process-medication-followup-alerts'
--    or command ~* '(medication[_ -].*followup|process_due_medication_followup_alerts)';

-- select runid, jobid, status, return_message, start_time, end_time
-- from cron.job_run_details
-- where jobid in (
--   select jobid from cron.job
--   where jobname = 'process-medication-followup-alerts'
--      or command ~* '(medication[_ -].*followup|process_due_medication_followup_alerts)'
-- )
-- order by start_time desc limit 100;

-- 10. pg_net, Database Webhook, and URL-bearing trigger/function clues.
select extension.extname, extension.extversion
from pg_catalog.pg_extension as extension
where extension.extname in ('pg_net', 'http');

select routine.oid::pg_catalog.regprocedure as signature,
       pg_catalog.pg_get_functiondef(routine.oid) as definition
from pg_catalog.pg_proc as routine
join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
where routine.prokind in ('f', 'p')
  and pg_catalog.pg_get_functiondef(routine.oid) ~* '(send-doctor-followup-web-push|net\.http|doctor_notifications)'
order by signature::text;

-- 11. Dashboard/settings compatibility fields and dependencies.
select column_record.column_name, column_record.udt_name
from information_schema.columns as column_record
where column_record.table_schema = 'public'
  and column_record.table_name = 'system_settings'
  and column_record.column_name in (
    'medication_adherence_alerts_enabled',
    'doctor_followup_alerts_enabled'
  )
order by column_record.column_name;

select routine.oid::pg_catalog.regprocedure as signature,
       pg_catalog.pg_get_functiondef(routine.oid) as definition
from pg_catalog.pg_proc as routine
join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
where namespace.nspname = 'public'
  and routine.proname in (
    'get_admin_dashboard_summary',
    'get_admin_system_settings',
    'update_admin_system_settings'
  )
order by routine.proname;

-- Edge Functions are not catalog objects. Verify them separately with:
--   supabase functions list --project-ref <project-ref>
-- and confirm all Database Webhooks in Supabase Dashboard > Database > Webhooks.
