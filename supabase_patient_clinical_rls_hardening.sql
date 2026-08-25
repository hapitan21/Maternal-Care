-- SUPERSEDED: Do not install this first-pass migration. The authoritative live
-- policy export is implemented by supabase_patient_clinical_rls_hardening_v2.sql.
-- Retained only for review history.
--
-- Maternal Care - review-only Patient clinical-table RLS hardening.
-- DO NOT execute without comparing the commented live inventory queries with
-- the target Supabase project.
--
-- This migration narrows only policies whose complete definitions are present
-- in this repository. It does not change public.is_clinic_user(), grants,
-- Patient-owned policies, RPCs, tables, columns, triggers, or application code.
--
-- In scope:
--   public.patient_obstetric_history
--   public.patient_medical_history
--   public.patient_initial_assessment
--   public.medication_reminders
--   public.medication_reminder_occurrences
--   public.medication_adherence_followups
--   public.medication_adherence_followup_events
--
-- Not changed because the required live contract is incomplete or conflicts
-- with an established Staff workflow:
--   public.medical_records
--   public.staff_visit_intake
--   public.patients (mixed operational and pregnancy-risk columns)
--   public.get_appointment_visit_form_type(uuid)
--   public.save_appointment_visit_record(uuid, text, jsonb)
--   public.get_staff_visit_intake(uuid)
--   public.save_staff_visit_intake(uuid, text, jsonb)

-- ================================================================
-- COMMENTED LIVE INVENTORY - RUN BEFORE MANUAL INSTALLATION
-- ================================================================

-- Retrieve every live clinical policy, including definitions absent locally.
-- select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
-- from pg_catalog.pg_policies
-- where schemaname = 'public'
--   and tablename in (
--     'medical_records',
--     'patient_obstetric_history',
--     'patient_medical_history',
--     'patient_initial_assessment',
--     'medication_reminders',
--     'medication_reminder_occurrences',
--     'medication_adherence_followups',
--     'medication_adherence_followup_events',
--     'staff_visit_intake',
--     'patients'
--   )
-- order by tablename, policyname;

-- Retrieve the SECURITY DEFINER functions that can bypass table RLS.
-- select
--   routine.oid::pg_catalog.regprocedure as signature,
--   routine.prosecdef as security_definer,
--   pg_catalog.pg_get_userbyid(routine.proowner) as owner,
--   routine.proconfig,
--   pg_catalog.pg_get_functiondef(routine.oid) as definition
-- from pg_catalog.pg_proc as routine
-- where routine.oid in (
--   pg_catalog.to_regprocedure('public.get_appointment_visit_form_type(uuid)'),
--   pg_catalog.to_regprocedure('public.save_appointment_visit_record(uuid,text,jsonb)'),
--   pg_catalog.to_regprocedure('public.get_staff_visit_intake(uuid)'),
--   pg_catalog.to_regprocedure('public.save_staff_visit_intake(uuid,text,jsonb)')
-- )
-- order by signature::text;

begin;

do $preflight$
declare
  v_issues text[] := array[]::text[];
  v_new_issues text[];
begin
  -- Required table/column contract.
  with required(table_name, column_name, expected_type) as (
    values
      ('profiles', 'id', 'uuid'),
      ('profiles', 'role', 'text'),
      ('profiles', 'account_status', 'text'),
      ('patients', 'id', 'uuid'),
      ('patients', 'user_id', 'uuid'),
      ('patients', 'account_status', 'text'),
      ('patients', 'archived_at', 'timestamp with time zone'),
      ('patient_obstetric_history', 'id', 'uuid'),
      ('patient_obstetric_history', 'patient_id', 'uuid'),
      ('patient_medical_history', 'id', 'uuid'),
      ('patient_medical_history', 'patient_id', 'uuid'),
      ('patient_initial_assessment', 'id', 'uuid'),
      ('patient_initial_assessment', 'patient_id', 'uuid'),
      ('medication_reminders', 'id', 'uuid'),
      ('medication_reminders', 'patient_id', 'uuid'),
      ('medication_reminder_occurrences', 'id', 'uuid'),
      ('medication_reminder_occurrences', 'patient_id', 'uuid'),
      ('medication_adherence_followups', 'id', 'uuid'),
      ('medication_adherence_followups', 'patient_id', 'uuid'),
      ('medication_adherence_followups', 'assigned_doctor_id', 'uuid'),
      ('medication_adherence_followup_events', 'id', 'uuid'),
      ('medication_adherence_followup_events', 'followup_id', 'uuid')
  )
  select pg_catalog.array_agg(
    case
      when actual.column_name is null then
        pg_catalog.format('missing column public.%I.%I', required.table_name, required.column_name)
      else
        pg_catalog.format(
          'incompatible type public.%I.%I: expected %s, found %s',
          required.table_name,
          required.column_name,
          required.expected_type,
          actual.data_type
        )
    end
    order by required.table_name, required.column_name
  )
  into v_new_issues
  from required
  left join information_schema.columns as actual
    on actual.table_schema = 'public'
   and actual.table_name = required.table_name
   and actual.column_name = required.column_name
  where actual.column_name is null
     or actual.data_type <> required.expected_type;

  v_issues := v_issues || coalesce(v_new_issues, array[]::text[]);

  -- The helper is not changed, but its live contract must remain known because
  -- helper-based policies are specifically rejected below.
  if pg_catalog.to_regprocedure('public.is_clinic_user()') is null then
    v_issues := pg_catalog.array_append(v_issues, 'missing function public.is_clinic_user()');
  elsif (
    select function_row.prorettype <> 'pg_catalog.bool'::pg_catalog.regtype
    from pg_catalog.pg_proc as function_row
    where function_row.oid = pg_catalog.to_regprocedure('public.is_clinic_user()')
  ) then
    v_issues := pg_catalog.array_append(
      v_issues,
      'public.is_clinic_user() must return boolean'
    );
  end if;

  -- RLS must already be enabled. This migration does not silently enable it.
  with required(table_name) as (
    values
      ('patient_obstetric_history'),
      ('patient_medical_history'),
      ('patient_initial_assessment'),
      ('medication_reminders'),
      ('medication_reminder_occurrences'),
      ('medication_adherence_followups'),
      ('medication_adherence_followup_events')
  )
  select pg_catalog.array_agg(
    pg_catalog.format('RLS is not enabled on public.%I', required.table_name)
    order by required.table_name
  )
  into v_new_issues
  from required
  left join pg_catalog.pg_class as table_row
    on table_row.oid = pg_catalog.to_regclass('public.' || required.table_name)
  where table_row.oid is null or not table_row.relrowsecurity;

  v_issues := v_issues || coalesce(v_new_issues, array[]::text[]);

  -- Each transition requires either the known legacy name or the secure name.
  with transitions(table_name, old_name, new_name, expected_command, requires_check) as (
    values
      (
        'patient_obstetric_history',
        'Clinic users can manage patient obstetric history',
        'Active Doctors can manage patient obstetric history',
        'ALL',
        true
      ),
      (
        'patient_medical_history',
        'Clinic users can manage patient medical history',
        'Active Doctors can manage patient medical history',
        'ALL',
        true
      ),
      (
        'patient_initial_assessment',
        'Clinic users can manage patient initial assessment',
        'Active Doctors can manage patient initial assessment',
        'ALL',
        true
      ),
      (
        'medication_reminders',
        'Clinic users can manage medication reminders',
        'Active Doctors can manage medication reminders',
        'ALL',
        true
      ),
      (
        'medication_reminder_occurrences',
        'Doctors can read medication reminder occurrences',
        'Active Doctors can read medication reminder occurrences',
        'SELECT',
        false
      ),
      (
        'medication_adherence_followups',
        'Doctors and admins can read medication adherence followups',
        'Active Doctors can read medication adherence followups',
        'SELECT',
        false
      ),
      (
        'medication_adherence_followup_events',
        'Doctors and admins can read medication adherence followup events',
        'Active Doctors can read medication adherence followup events',
        'SELECT',
        false
      )
  )
  select pg_catalog.array_agg(
    pg_catalog.format(
      'missing target policy on public.%I: expected %L or %L',
      transition.table_name,
      transition.old_name,
      transition.new_name
    )
    order by transition.table_name
  )
  into v_new_issues
  from transitions as transition
  where not exists (
    select 1
    from pg_catalog.pg_policies as policy
    where policy.schemaname = 'public'
      and policy.tablename = transition.table_name
      and policy.policyname in (transition.old_name, transition.new_name)
  );

  v_issues := v_issues || coalesce(v_new_issues, array[]::text[]);

  -- Validate operation, role target, permissiveness, and expression shape for
  -- every old/new policy that will be replaced.
  with transitions(table_name, old_name, new_name, expected_command, requires_check) as (
    values
      ('patient_obstetric_history', 'Clinic users can manage patient obstetric history', 'Active Doctors can manage patient obstetric history', 'ALL', true),
      ('patient_medical_history', 'Clinic users can manage patient medical history', 'Active Doctors can manage patient medical history', 'ALL', true),
      ('patient_initial_assessment', 'Clinic users can manage patient initial assessment', 'Active Doctors can manage patient initial assessment', 'ALL', true),
      ('medication_reminders', 'Clinic users can manage medication reminders', 'Active Doctors can manage medication reminders', 'ALL', true),
      ('medication_reminder_occurrences', 'Doctors can read medication reminder occurrences', 'Active Doctors can read medication reminder occurrences', 'SELECT', false),
      ('medication_adherence_followups', 'Doctors and admins can read medication adherence followups', 'Active Doctors can read medication adherence followups', 'SELECT', false),
      ('medication_adherence_followup_events', 'Doctors and admins can read medication adherence followup events', 'Active Doctors can read medication adherence followup events', 'SELECT', false)
  )
  select pg_catalog.array_agg(
    pg_catalog.format('incompatible policy public.%I.%I', policy.tablename, policy.policyname)
    order by policy.tablename, policy.policyname
  )
  into v_new_issues
  from transitions as transition
  join pg_catalog.pg_policies as policy
    on policy.schemaname = 'public'
   and policy.tablename = transition.table_name
   and policy.policyname in (transition.old_name, transition.new_name)
  where policy.cmd <> transition.expected_command
     or policy.permissive <> 'PERMISSIVE'
     or policy.roles <> array['authenticated'::name]
     or policy.qual is null
     or (transition.requires_check and policy.with_check is null);

  v_issues := v_issues || coalesce(v_new_issues, array[]::text[]);

  -- If this is a repeated installation, the secure policy must still contain
  -- exact active-Doctor checks and no Admin, Staff, or shared-helper access.
  with secure_names(table_name, policy_name) as (
    values
      ('patient_obstetric_history', 'Active Doctors can manage patient obstetric history'),
      ('patient_medical_history', 'Active Doctors can manage patient medical history'),
      ('patient_initial_assessment', 'Active Doctors can manage patient initial assessment'),
      ('medication_reminders', 'Active Doctors can manage medication reminders'),
      ('medication_reminder_occurrences', 'Active Doctors can read medication reminder occurrences'),
      ('medication_adherence_followups', 'Active Doctors can read medication adherence followups'),
      ('medication_adherence_followup_events', 'Active Doctors can read medication adherence followup events')
  ), secure_policies as (
    select
      policy.*,
      pg_catalog.lower(coalesce(policy.qual, '') || ' ' || coalesce(policy.with_check, ''))
        as expression_text
    from secure_names
    join pg_catalog.pg_policies as policy
      on policy.schemaname = 'public'
     and policy.tablename = secure_names.table_name
     and policy.policyname = secure_names.policy_name
  )
  select pg_catalog.array_agg(
    pg_catalog.format('secure policy drift detected: public.%I.%I', tablename, policyname)
    order by tablename, policyname
  )
  into v_new_issues
  from secure_policies
  where expression_text not like '%account_status%'
     or expression_text not like '%doctor%'
     or expression_text like '%is_clinic_user%'
     or expression_text like '%staff%'
     or expression_text like '%admin%';

  v_issues := v_issues || coalesce(v_new_issues, array[]::text[]);

  -- Patient-owned SELECT policies are required and are never dropped below.
  with preserved(table_name, policy_name) as (
    values
      ('patient_obstetric_history', 'Patients can read own obstetric history'),
      ('patient_medical_history', 'Patients can read own medical history'),
      ('patient_initial_assessment', 'Patients can read own initial assessment'),
      ('medication_reminders', 'Patients can read own medication reminders'),
      ('medication_reminder_occurrences', 'Patients can read own medication reminder occurrences')
  )
  select pg_catalog.array_agg(
    pg_catalog.format('missing or incompatible Patient policy public.%I.%I', preserved.table_name, preserved.policy_name)
    order by preserved.table_name, preserved.policy_name
  )
  into v_new_issues
  from preserved
  left join pg_catalog.pg_policies as policy
    on policy.schemaname = 'public'
   and policy.tablename = preserved.table_name
   and policy.policyname = preserved.policy_name
  where policy.policyname is null
     or policy.cmd <> 'SELECT'
     or policy.permissive <> 'PERMISSIVE'
     or policy.roles <> array['authenticated'::name]
     or policy.qual is null
     or pg_catalog.lower(policy.qual) not like '%auth.uid%'
     or pg_catalog.lower(policy.qual) not like '%patient%';

  v_issues := v_issues || coalesce(v_new_issues, array[]::text[]);

  -- Refuse installation for every additional live policy. Its exact definition
  -- must be reviewed and added explicitly rather than trusted or dropped by
  -- pattern.
  with affected(table_name) as (
    values
      ('patient_obstetric_history'),
      ('patient_medical_history'),
      ('patient_initial_assessment'),
      ('medication_reminders'),
      ('medication_reminder_occurrences'),
      ('medication_adherence_followups'),
      ('medication_adherence_followup_events')
  ), known(policy_name) as (
    values
      ('Clinic users can manage patient obstetric history'),
      ('Active Doctors can manage patient obstetric history'),
      ('Clinic users can manage patient medical history'),
      ('Active Doctors can manage patient medical history'),
      ('Clinic users can manage patient initial assessment'),
      ('Active Doctors can manage patient initial assessment'),
      ('Clinic users can manage medication reminders'),
      ('Active Doctors can manage medication reminders'),
      ('Doctors can read medication reminder occurrences'),
      ('Active Doctors can read medication reminder occurrences'),
      ('Doctors and admins can read medication adherence followups'),
      ('Active Doctors can read medication adherence followups'),
      ('Doctors and admins can read medication adherence followup events'),
      ('Active Doctors can read medication adherence followup events'),
      ('Patients can read own obstetric history'),
      ('Patients can read own medical history'),
      ('Patients can read own initial assessment'),
      ('Patients can read own medication reminders'),
      ('Patients can read own medication reminder occurrences')
  ), unknown_policies as (
    select
      policy.tablename,
      policy.policyname
    from affected
    join pg_catalog.pg_policies as policy
      on policy.schemaname = 'public'
     and policy.tablename = affected.table_name
    where not exists (
      select 1 from known where known.policy_name = policy.policyname
    )
  )
  select pg_catalog.array_agg(
    pg_catalog.format('unreviewed clinical policy public.%I.%I', tablename, policyname)
    order by tablename, policyname
  )
  into v_new_issues
  from unknown_policies;

  v_issues := v_issues || coalesce(v_new_issues, array[]::text[]);

  if pg_catalog.cardinality(v_issues) > 0 then
    raise exception
      'Patient clinical RLS hardening preflight failed: %',
      pg_catalog.array_to_string(v_issues, '; ');
  end if;
end;
$preflight$;

-- Patient obstetric history.
drop policy if exists "Clinic users can manage patient obstetric history"
  on public.patient_obstetric_history;
drop policy if exists "Active Doctors can manage patient obstetric history"
  on public.patient_obstetric_history;
create policy "Active Doctors can manage patient obstetric history"
on public.patient_obstetric_history
for all to authenticated
using (
  exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  )
)
with check (
  exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  )
);

-- Patient medical history.
drop policy if exists "Clinic users can manage patient medical history"
  on public.patient_medical_history;
drop policy if exists "Active Doctors can manage patient medical history"
  on public.patient_medical_history;
create policy "Active Doctors can manage patient medical history"
on public.patient_medical_history
for all to authenticated
using (
  exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  )
)
with check (
  exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  )
);

-- Patient initial assessment.
drop policy if exists "Clinic users can manage patient initial assessment"
  on public.patient_initial_assessment;
drop policy if exists "Active Doctors can manage patient initial assessment"
  on public.patient_initial_assessment;
create policy "Active Doctors can manage patient initial assessment"
on public.patient_initial_assessment
for all to authenticated
using (
  exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  )
)
with check (
  exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  )
);

-- Medication prescriptions/reminders.
drop policy if exists "Clinic users can manage medication reminders"
  on public.medication_reminders;
drop policy if exists "Active Doctors can manage medication reminders"
  on public.medication_reminders;
create policy "Active Doctors can manage medication reminders"
on public.medication_reminders
for all to authenticated
using (
  exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  )
)
with check (
  exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  )
);

-- Medication adherence occurrence ledger. Patient-owned SELECT is untouched.
drop policy if exists "Doctors can read medication reminder occurrences"
  on public.medication_reminder_occurrences;
drop policy if exists "Active Doctors can read medication reminder occurrences"
  on public.medication_reminder_occurrences;
create policy "Active Doctors can read medication reminder occurrences"
on public.medication_reminder_occurrences
for select to authenticated
using (
  exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  )
);

-- Medication adherence follow-up cases.
drop policy if exists "Doctors and admins can read medication adherence followups"
  on public.medication_adherence_followups;
drop policy if exists "Active Doctors can read medication adherence followups"
  on public.medication_adherence_followups;
create policy "Active Doctors can read medication adherence followups"
on public.medication_adherence_followups
for select to authenticated
using (
  exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  )
);

-- Medication adherence follow-up event history and private notes.
drop policy if exists "Doctors and admins can read medication adherence followup events"
  on public.medication_adherence_followup_events;
drop policy if exists "Active Doctors can read medication adherence followup events"
  on public.medication_adherence_followup_events;
create policy "Active Doctors can read medication adherence followup events"
on public.medication_adherence_followup_events
for select to authenticated
using (
  exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  )
);

notify pgrst, 'reload schema';

commit;

-- ================================================================
-- COMMENTED READ-ONLY VERIFICATION
-- ================================================================

-- 1. RLS must remain enabled on every in-scope table.
-- select namespace_row.nspname as schema_name, table_row.relname as table_name,
--        table_row.relrowsecurity as rls_enabled,
--        table_row.relforcerowsecurity as rls_forced
-- from pg_catalog.pg_class as table_row
-- join pg_catalog.pg_namespace as namespace_row
--   on namespace_row.oid = table_row.relnamespace
-- where namespace_row.nspname = 'public'
--   and table_row.relname in (
--     'patient_obstetric_history', 'patient_medical_history',
--     'patient_initial_assessment', 'medication_reminders',
--     'medication_reminder_occurrences', 'medication_adherence_followups',
--     'medication_adherence_followup_events'
--   )
-- order by table_row.relname;

-- 2. Exact names, operations, roles, USING, and WITH CHECK expressions.
-- select tablename, policyname, permissive, roles, cmd, qual, with_check
-- from pg_catalog.pg_policies
-- where schemaname = 'public'
--   and tablename in (
--     'patient_obstetric_history', 'patient_medical_history',
--     'patient_initial_assessment', 'medication_reminders',
--     'medication_reminder_occurrences', 'medication_adherence_followups',
--     'medication_adherence_followup_events'
--   )
-- order by tablename, policyname;

-- 3. Active Staff, Admin, and the broad helper must be absent from all new
-- clinical-role expressions. Expect zero rows.
-- select tablename, policyname, qual, with_check
-- from pg_catalog.pg_policies
-- where schemaname = 'public'
--   and policyname like 'Active Doctors%'
--   and (
--     pg_catalog.lower(coalesce(qual, '') || ' ' || coalesce(with_check, ''))
--       like '%staff%'
--     or pg_catalog.lower(coalesce(qual, '') || ' ' || coalesce(with_check, ''))
--       like '%admin%'
--     or pg_catalog.lower(coalesce(qual, '') || ' ' || coalesce(with_check, ''))
--       like '%is_clinic_user%'
--   );

-- 4. Every new policy must require both Doctor role and active status.
-- Expect seven rows with both booleans true.
-- select tablename, policyname,
--   pg_catalog.lower(coalesce(qual, '') || ' ' || coalesce(with_check, ''))
--     like '%doctor%' as requires_doctor,
--   pg_catalog.lower(coalesce(qual, '') || ' ' || coalesce(with_check, ''))
--     like '%account_status%' as requires_active_status
-- from pg_catalog.pg_policies
-- where schemaname = 'public' and policyname like 'Active Doctors%'
-- order by tablename, policyname;

-- 5. Patient-owned policies must still exist unchanged. Expect five rows.
-- select tablename, policyname, cmd, roles, qual, with_check
-- from pg_catalog.pg_policies
-- where schemaname = 'public'
--   and policyname in (
--     'Patients can read own obstetric history',
--     'Patients can read own medical history',
--     'Patients can read own initial assessment',
--     'Patients can read own medication reminders',
--     'Patients can read own medication reminder occurrences'
--   )
-- order by tablename, policyname;

-- 6. Read-only actor probes. Replace both placeholders with test UUIDs, then
-- run each block separately. The active Doctor must see the known test row;
-- Active Staff and the inactive Doctor must see zero rows. The Patient probe
-- must see only that Patient's own permitted row.
-- begin;
-- set local role authenticated;
-- select pg_catalog.set_config(
--   'request.jwt.claim.sub', '<active-doctor-auth-uuid>', true
-- );
-- select id from public.patient_medical_history
-- where id = '<known-test-history-uuid>'::uuid;
-- rollback;
--
-- begin;
-- set local role authenticated;
-- select pg_catalog.set_config(
--   'request.jwt.claim.sub', '<active-staff-auth-uuid>', true
-- );
-- select id from public.patient_medical_history
-- where id = '<known-test-history-uuid>'::uuid;
-- rollback;
--
-- begin;
-- set local role authenticated;
-- select pg_catalog.set_config(
--   'request.jwt.claim.sub', '<inactive-doctor-auth-uuid>', true
-- );
-- select id from public.patient_medical_history
-- where id = '<known-test-history-uuid>'::uuid;
-- rollback;
--
-- begin;
-- set local role authenticated;
-- select pg_catalog.set_config(
--   'request.jwt.claim.sub', '<patient-auth-uuid>', true
-- );
-- select history.id
-- from public.patient_medical_history as history
-- join public.patients as patient on patient.id = history.patient_id
-- where patient.user_id = auth.uid();
-- rollback;

-- ================================================================
-- MANUAL ROLE / STATUS TEST MATRIX
-- ================================================================
-- Use dedicated test accounts and non-production rows. Test SELECT on all seven
-- tables and INSERT/UPDATE/DELETE on the four ALL-policy tables. Wrap mutation
-- tests in BEGIN/ROLLBACK.
--
-- Actor                         SELECT    INSERT/UPDATE/DELETE
-- Active Doctor                 allowed   allowed where policy command is ALL
-- Inactive Doctor               denied    denied
-- Active Staff                  denied    denied
-- Inactive Staff                denied    denied
-- Active Admin                  denied    denied
-- Inactive Admin                denied    denied
-- Patient, own permitted row    allowed only through preserved SELECT policies
-- Patient, another Patient row  denied    denied
-- Unauthenticated               denied    denied
--
-- Also call the four excluded SECURITY DEFINER visit/intake RPCs as Staff.
-- Their current local definitions permit Staff and therefore require a separate
-- reviewed workflow decision; this policy migration does not claim to block them.

-- ================================================================
-- COMMENTED EMERGENCY ROLLBACK
-- ================================================================
-- WARNING: This rollback restores known broad Admin/Staff and inactive-account
-- access. Use only for an explicitly approved emergency, then restore the secure
-- policies immediately. Patient-owned policies are not changed by rollback.
--
-- begin;
--
-- drop policy if exists "Active Doctors can manage patient obstetric history" on public.patient_obstetric_history;
-- create policy "Clinic users can manage patient obstetric history"
-- on public.patient_obstetric_history for all to authenticated
-- using (exists (select 1 from public.profiles as profile where profile.id = auth.uid() and pg_catalog.lower(coalesce(profile.role, '')) in ('admin', 'doctor', 'staff')))
-- with check (exists (select 1 from public.profiles as profile where profile.id = auth.uid() and pg_catalog.lower(coalesce(profile.role, '')) in ('admin', 'doctor', 'staff')));
--
-- drop policy if exists "Active Doctors can manage patient medical history" on public.patient_medical_history;
-- create policy "Clinic users can manage patient medical history"
-- on public.patient_medical_history for all to authenticated
-- using (exists (select 1 from public.profiles as profile where profile.id = auth.uid() and pg_catalog.lower(coalesce(profile.role, '')) in ('admin', 'doctor', 'staff')))
-- with check (exists (select 1 from public.profiles as profile where profile.id = auth.uid() and pg_catalog.lower(coalesce(profile.role, '')) in ('admin', 'doctor', 'staff')));
--
-- drop policy if exists "Active Doctors can manage patient initial assessment" on public.patient_initial_assessment;
-- create policy "Clinic users can manage patient initial assessment"
-- on public.patient_initial_assessment for all to authenticated
-- using (exists (select 1 from public.profiles as profile where profile.id = auth.uid() and pg_catalog.lower(coalesce(profile.role, '')) in ('admin', 'doctor', 'staff')))
-- with check (exists (select 1 from public.profiles as profile where profile.id = auth.uid() and pg_catalog.lower(coalesce(profile.role, '')) in ('admin', 'doctor', 'staff')));
--
-- drop policy if exists "Active Doctors can manage medication reminders" on public.medication_reminders;
-- create policy "Clinic users can manage medication reminders"
-- on public.medication_reminders for all to authenticated
-- using (exists (select 1 from public.profiles as profile where profile.id = auth.uid() and pg_catalog.lower(coalesce(profile.role, '')) in ('admin', 'doctor')))
-- with check (exists (select 1 from public.profiles as profile where profile.id = auth.uid() and pg_catalog.lower(coalesce(profile.role, '')) in ('admin', 'doctor')));
--
-- drop policy if exists "Active Doctors can read medication reminder occurrences" on public.medication_reminder_occurrences;
-- create policy "Doctors can read medication reminder occurrences"
-- on public.medication_reminder_occurrences for select to authenticated
-- using (exists (select 1 from public.profiles as profile where profile.id = auth.uid() and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'));
--
-- drop policy if exists "Active Doctors can read medication adherence followups" on public.medication_adherence_followups;
-- create policy "Doctors and admins can read medication adherence followups"
-- on public.medication_adherence_followups for select to authenticated
-- using (exists (select 1 from public.profiles as profile where profile.id = auth.uid() and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) in ('doctor', 'admin') and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, 'active'::text))) = 'active'));
--
-- drop policy if exists "Active Doctors can read medication adherence followup events" on public.medication_adherence_followup_events;
-- create policy "Doctors and admins can read medication adherence followup events"
-- on public.medication_adherence_followup_events for select to authenticated
-- using (exists (select 1 from public.profiles as profile where profile.id = auth.uid() and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) in ('doctor', 'admin') and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, 'active'::text))) = 'active'));
--
-- notify pgrst, 'reload schema';
-- commit;
