-- Maternal Care - review-only clinical RLS hardening v2.
-- Authoritative policy source: live 42-row Supabase RLS export, 2026-08-06.
-- DO NOT execute until this file and supabase_patients_operational_rls_hardening.sql
-- have been reviewed as one controlled installation.
--
-- This supersedes supabase_patient_clinical_rls_hardening.sql. It does not
-- change public.is_clinic_user().

-- Duplicate proof from the live export (whitespace-insensitive lower-case MD5):
-- medication_reminders Patient pair:       02f75677b767e00f36e239612c22e585
-- patient_initial_assessment Patient pair:  7e2e5c964e3c2d596389c59b51841ff8
-- patient_medical_history Patient pair:     8e9d1ac72e57c02d798d4150b621f121
-- patient_obstetric_history Patient pair:   b447211b31b1468e052ab0344954ce02
-- Each pair is equivalent in the live CSV. One canonical active-Patient policy
-- is retained per table; rollback restores both original names exactly.
-- Reviewed original RPC ACL: PUBLIC=false, anon=false, authenticated=true,
-- service_role=true, with no additional non-owner EXECUTE grantees.

begin;

do $preflight$
declare
  v_issues text[] := array[]::text[];
  v_new_issues text[];
begin
  with required(table_name, column_name, expected_type) as (
    values
      ('profiles', 'id', 'uuid'),
      ('profiles', 'role', 'text'),
      ('profiles', 'account_status', 'text'),
      ('patients', 'id', 'uuid'),
      ('patients', 'user_id', 'uuid'),
      ('patients', 'account_status', 'text'),
      ('patients', 'status', 'text'),
      ('patients', 'archived_at', 'timestamp with time zone'),
      ('medical_records', 'patient_id', 'uuid'),
      ('patient_initial_assessment', 'patient_id', 'uuid'),
      ('patient_medical_history', 'patient_id', 'uuid'),
      ('patient_obstetric_history', 'patient_id', 'uuid'),
      ('medication_reminders', 'patient_id', 'uuid'),
      ('medication_reminder_occurrences', 'patient_id', 'uuid'),
      ('staff_visit_intake', 'id', 'uuid')
  )
  select pg_catalog.array_agg(
    case when actual.column_name is null then
      pg_catalog.format('missing public.%I.%I', required.table_name, required.column_name)
    else
      pg_catalog.format(
        'type mismatch public.%I.%I: expected %s, found %s',
        required.table_name, required.column_name,
        required.expected_type, actual.data_type
      )
    end order by required.table_name, required.column_name
  ) into v_new_issues
  from required
  left join information_schema.columns as actual
    on actual.table_schema = 'public'
   and actual.table_name = required.table_name
   and actual.column_name = required.column_name
  where actual.column_name is null or actual.data_type <> required.expected_type;

  v_issues := v_issues || coalesce(v_new_issues, array[]::text[]);

  if pg_catalog.to_regprocedure('public.is_clinic_user()') is null then
    v_issues := pg_catalog.array_append(v_issues, 'missing public.is_clinic_user()');
  elsif (
    select routine.prorettype <> 'pg_catalog.bool'::pg_catalog.regtype
    from pg_catalog.pg_proc as routine
    where routine.oid = pg_catalog.to_regprocedure('public.is_clinic_user()')
  ) then
    v_issues := pg_catalog.array_append(v_issues, 'public.is_clinic_user() must return boolean');
  elsif not (
    select routine.prosecdef
       and coalesce(routine.proconfig, array[]::text[]) @> array['search_path=""']
       and pg_catalog.lower(pg_catalog.pg_get_functiondef(routine.oid)) like '%account_status%'
    from pg_catalog.pg_proc as routine
    where routine.oid = pg_catalog.to_regprocedure('public.is_clinic_user()')
  ) then
    v_issues := pg_catalog.array_append(
      v_issues,
      'public.is_clinic_user() must be the active-account SECURITY DEFINER helper with empty search_path'
    );
  end if;

  with required(table_name) as (
    values
      ('medical_records'),
      ('patient_initial_assessment'),
      ('patient_medical_history'),
      ('patient_obstetric_history'),
      ('medication_reminders'),
      ('medication_reminder_occurrences'),
      ('staff_visit_intake')
  )
  select pg_catalog.array_agg(
    pg_catalog.format('RLS is not enabled on public.%I', required.table_name)
    order by required.table_name
  ) into v_new_issues
  from required
  left join pg_catalog.pg_class as relation
    on relation.oid = pg_catalog.to_regclass('public.' || required.table_name)
  where relation.oid is null or not relation.relrowsecurity;

  v_issues := v_issues || coalesce(v_new_issues, array[]::text[]);

  -- These are exact fingerprints of all 33 non-patients policies in the live
  -- 42-row CSV. No missing, extra, renamed, or expression-drifted policy is
  -- accepted. Fingerprints normalize only letter case and whitespace.
  with expected(table_name, policy_name, command_name, qual_md5, check_md5) as (
    values
      ('medical_records', 'Clinic users can delete medical records', 'DELETE', '59abf4e1fdebd637d55cb7379e69cb6e', null),
      ('medical_records', 'Clinic users can insert medical records', 'INSERT', null, '59abf4e1fdebd637d55cb7379e69cb6e'),
      ('medical_records', 'Clinic users can read medical records', 'SELECT', '59abf4e1fdebd637d55cb7379e69cb6e', null),
      ('medical_records', 'Clinic users can update medical records', 'UPDATE', '59abf4e1fdebd637d55cb7379e69cb6e', '59abf4e1fdebd637d55cb7379e69cb6e'),
      ('medical_records', 'Patients read own medical records', 'SELECT', 'd6bdd3f996e1209b153fc7c4380d5934', null),
      ('medication_reminder_occurrences', 'Doctors can read medication reminder occurrences', 'SELECT', 'd074cfa73a2bed04e6dee0d48dc8bb01', null),
      ('medication_reminder_occurrences', 'Patients can read own medication reminder occurrences', 'SELECT', '380ffac0a783c5a2edb28ae90e09b98d', null),
      ('medication_reminders', 'Clinic users can manage medication reminders', 'ALL', '75e957d2cfce11590332d5218c0f94d0', '75e957d2cfce11590332d5218c0f94d0'),
      ('medication_reminders', 'Patients can read own medication reminders', 'SELECT', '02f75677b767e00f36e239612c22e585', null),
      ('medication_reminders', 'Patients read own medication reminders', 'SELECT', '02f75677b767e00f36e239612c22e585', null),
      ('patient_initial_assessment', 'Clinic users can delete initial assessment', 'DELETE', 'e9058dd0143851e3a72cfa3a5342a88d', null),
      ('patient_initial_assessment', 'Clinic users can insert initial assessment', 'INSERT', null, 'e9058dd0143851e3a72cfa3a5342a88d'),
      ('patient_initial_assessment', 'Clinic users can read initial assessment', 'SELECT', 'e9058dd0143851e3a72cfa3a5342a88d', null),
      ('patient_initial_assessment', 'Clinic users can update initial assessment', 'UPDATE', 'e9058dd0143851e3a72cfa3a5342a88d', 'e9058dd0143851e3a72cfa3a5342a88d'),
      ('patient_initial_assessment', 'Patients can read own initial assessment', 'SELECT', '7e2e5c964e3c2d596389c59b51841ff8', null),
      ('patient_initial_assessment', 'Patients read own initial assessment', 'SELECT', '7e2e5c964e3c2d596389c59b51841ff8', null),
      ('patient_medical_history', 'Clinic users can delete medical history', 'DELETE', 'e9058dd0143851e3a72cfa3a5342a88d', null),
      ('patient_medical_history', 'Clinic users can insert medical history', 'INSERT', null, 'e9058dd0143851e3a72cfa3a5342a88d'),
      ('patient_medical_history', 'Clinic users can read medical history', 'SELECT', 'e9058dd0143851e3a72cfa3a5342a88d', null),
      ('patient_medical_history', 'Clinic users can update medical history', 'UPDATE', 'e9058dd0143851e3a72cfa3a5342a88d', 'e9058dd0143851e3a72cfa3a5342a88d'),
      ('patient_medical_history', 'Patients can read own medical history', 'SELECT', '8e9d1ac72e57c02d798d4150b621f121', null),
      ('patient_medical_history', 'Patients read own medical history', 'SELECT', '8e9d1ac72e57c02d798d4150b621f121', null),
      ('patient_obstetric_history', 'Clinic users can delete obstetric history', 'DELETE', 'e9058dd0143851e3a72cfa3a5342a88d', null),
      ('patient_obstetric_history', 'Clinic users can insert obstetric history', 'INSERT', null, 'e9058dd0143851e3a72cfa3a5342a88d'),
      ('patient_obstetric_history', 'Clinic users can read obstetric history', 'SELECT', 'e9058dd0143851e3a72cfa3a5342a88d', null),
      ('patient_obstetric_history', 'Clinic users can update obstetric history', 'UPDATE', 'e9058dd0143851e3a72cfa3a5342a88d', 'e9058dd0143851e3a72cfa3a5342a88d'),
      ('patient_obstetric_history', 'Patients can read own obstetric history', 'SELECT', 'b447211b31b1468e052ab0344954ce02', null),
      ('patient_obstetric_history', 'Patients read own obstetric history', 'SELECT', 'b447211b31b1468e052ab0344954ce02', null),
      ('staff_visit_intake', 'staff_visit_intake_clinic_read', 'SELECT', 'fddb9fa2ae8c0ca7f2daf4a4418432cd', null),
      ('staff_visit_intake', 'staff_visit_intake_staff_insert', 'INSERT', null, '11a25e021f1e9ab191b4711d0ae82c5d'),
      ('staff_visit_intake', 'staff_visit_intake_staff_update', 'UPDATE', '11a25e021f1e9ab191b4711d0ae82c5d', '11a25e021f1e9ab191b4711d0ae82c5d')
  ), actual as (
    select
      policy.tablename as table_name,
      policy.policyname as policy_name,
      policy.cmd as command_name,
      policy.permissive,
      policy.roles,
      case when policy.qual is null then null else pg_catalog.md5(
        pg_catalog.regexp_replace(pg_catalog.lower(policy.qual), '[[:space:]]+', '', 'g')
      ) end as qual_md5,
      case when policy.with_check is null then null else pg_catalog.md5(
        pg_catalog.regexp_replace(pg_catalog.lower(policy.with_check), '[[:space:]]+', '', 'g')
      ) end as check_md5
    from pg_catalog.pg_policies as policy
    where policy.schemaname = 'public'
      and policy.tablename in (
        'medical_records', 'patient_initial_assessment',
        'patient_medical_history', 'patient_obstetric_history',
        'medication_reminders', 'medication_reminder_occurrences',
        'staff_visit_intake'
      )
  ), drift as (
    select
      coalesce(expected.table_name, actual.table_name) as table_name,
      coalesce(expected.policy_name, actual.policy_name) as policy_name
    from expected
    full join actual using (table_name, policy_name)
    where expected.policy_name is null
       or actual.policy_name is null
       or actual.command_name <> expected.command_name
       or actual.permissive <> 'PERMISSIVE'
       or actual.roles <> array['authenticated'::name]
       or actual.qual_md5 is distinct from expected.qual_md5
       or actual.check_md5 is distinct from expected.check_md5
  )
  select pg_catalog.array_agg(
    pg_catalog.format('live policy drift public.%I.%I', drift.table_name, drift.policy_name)
    order by drift.table_name, drift.policy_name
  ) into v_new_issues
  from drift;

  v_issues := v_issues || coalesce(v_new_issues, array[]::text[]);

  with required(signature, argument_names, return_type, returns_set, volatility) as (
    values
      ('public.get_appointment_visit_form_type(uuid)', array['p_appointment_id','appointment_id','patient_id','visit_form_type','has_completed_initial_visit','appointment_status']::text[], 'pg_catalog.record'::pg_catalog.regtype, true, 'v'::"char"),
      ('public.save_appointment_visit_record(uuid,text,jsonb)', array['p_appointment_id','p_visit_form_type','p_form_data']::text[], 'public.medical_records'::pg_catalog.regtype, false, 'v'::"char"),
      ('public.get_staff_visit_intake(uuid)', array['p_appointment_id']::text[], 'public.staff_visit_intake'::pg_catalog.regtype, false, 'v'::"char"),
      ('public.save_staff_visit_intake(uuid,text,jsonb)', array['p_appointment_id','p_visit_form_type','p_intake_data']::text[], 'public.staff_visit_intake'::pg_catalog.regtype, false, 'v'::"char")
  )
  select pg_catalog.array_agg('incompatible protected function ' || required.signature)
  into v_new_issues
  from required
  left join pg_catalog.pg_proc as routine
    on routine.oid = pg_catalog.to_regprocedure(required.signature)
  where routine.oid is null
     or not routine.prosecdef
     or routine.proargnames is distinct from required.argument_names
     or routine.prorettype <> required.return_type
     or routine.proretset <> required.returns_set
     or routine.provolatile <> required.volatility
     or not (coalesce(routine.proconfig, array[]::text[]) @> array['search_path=""'])
     or pg_catalog.pg_get_userbyid(routine.proowner) <> 'postgres'
     or exists (
       select 1
       from pg_catalog.aclexplode(coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))) as acl
       left join pg_catalog.pg_roles as grantee on grantee.oid = acl.grantee
       where acl.privilege_type = 'EXECUTE'
         and coalesce(grantee.rolname, 'PUBLIC') not in ('postgres', 'authenticated', 'service_role')
     )
     or not pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', routine.oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE');

  v_issues := v_issues || coalesce(v_new_issues, array[]::text[]);

  if pg_catalog.to_regprocedure('public.get_appointment_visit_form_type_unchecked_v1(uuid)') is not null
     or pg_catalog.to_regprocedure('public.save_appointment_visit_record_unchecked_v1(uuid,text,jsonb)') is not null
     or pg_catalog.to_regprocedure('public.get_staff_visit_intake_unchecked_v1(uuid)') is not null
     or pg_catalog.to_regprocedure('public.save_staff_visit_intake_unchecked_v1(uuid,text,jsonb)') is not null then
    v_issues := pg_catalog.array_append(v_issues, 'reserved unchecked_v1 function name already exists');
  end if;

  if pg_catalog.cardinality(v_issues) > 0 then
    raise exception 'Clinical RLS hardening v2 preflight failed: %',
      pg_catalog.array_to_string(v_issues, '; ');
  end if;
end;
$preflight$;

-- Preserve the complete established function bodies behind non-callable names.
-- The facades below enforce current account authorization before invoking them.
alter function public.get_appointment_visit_form_type(uuid)
  rename to get_appointment_visit_form_type_unchecked_v1;
alter function public.save_appointment_visit_record(uuid, text, jsonb)
  rename to save_appointment_visit_record_unchecked_v1;
alter function public.get_staff_visit_intake(uuid)
  rename to get_staff_visit_intake_unchecked_v1;
alter function public.save_staff_visit_intake(uuid, text, jsonb)
  rename to save_staff_visit_intake_unchecked_v1;

revoke all on function public.get_appointment_visit_form_type_unchecked_v1(uuid)
  from public, anon, authenticated;
revoke all on function public.save_appointment_visit_record_unchecked_v1(uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.get_staff_visit_intake_unchecked_v1(uuid)
  from public, anon, authenticated;
revoke all on function public.save_staff_visit_intake_unchecked_v1(uuid, text, jsonb)
  from public, anon, authenticated;

create function public.get_appointment_visit_form_type(p_appointment_id uuid)
returns table (
  appointment_id uuid,
  patient_id uuid,
  visit_form_type text,
  has_completed_initial_visit boolean,
  appointment_status text
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text)))
          in ('doctor', 'staff')
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text)))
          = 'active'
  ) then
    raise exception 'Only active Doctors and Staff can route appointment visit forms.'
      using errcode = '42501';
  end if;

  return query
  select * from public.get_appointment_visit_form_type_unchecked_v1(p_appointment_id);
end;
$function$;

create function public.save_appointment_visit_record(
  p_appointment_id uuid,
  p_visit_form_type text,
  p_form_data jsonb
)
returns public.medical_records
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  ) then
    raise exception 'Only active Doctors can save completed medical records.'
      using errcode = '42501';
  end if;

  return public.save_appointment_visit_record_unchecked_v1(
    p_appointment_id, p_visit_form_type, p_form_data
  );
end;
$function$;

create function public.get_staff_visit_intake(p_appointment_id uuid)
returns public.staff_visit_intake
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text)))
          in ('doctor', 'staff')
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text)))
          = 'active'
  ) then
    raise exception 'Only active Doctors and Staff can read Staff intake.'
      using errcode = '42501';
  end if;

  return public.get_staff_visit_intake_unchecked_v1(p_appointment_id);
end;
$function$;

create function public.save_staff_visit_intake(
  p_appointment_id uuid,
  p_visit_form_type text,
  p_intake_data jsonb
)
returns public.staff_visit_intake
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'staff'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  ) then
    raise exception 'Only active Staff can save Staff intake.' using errcode = '42501';
  end if;

  return public.save_staff_visit_intake_unchecked_v1(
    p_appointment_id, p_visit_form_type, p_intake_data
  );
end;
$function$;

revoke all on function public.get_appointment_visit_form_type(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_appointment_visit_form_type(uuid) to authenticated, service_role;
revoke all on function public.save_appointment_visit_record(uuid, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.save_appointment_visit_record(uuid, text, jsonb) to authenticated, service_role;
revoke all on function public.get_staff_visit_intake(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_staff_visit_intake(uuid) to authenticated, service_role;
revoke all on function public.save_staff_visit_intake(uuid, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.save_staff_visit_intake(uuid, text, jsonb) to authenticated, service_role;

-- Replace the live broad clinical policies. Policy creation is generated only
-- from this fixed table/label list; no caller-controlled SQL is used.
drop policy "Clinic users can manage medication reminders" on public.medication_reminders;

do $doctor_policies$
declare
  target record;
begin
  for target in
    select * from (values
      ('medical_records', 'medical records'),
      ('patient_initial_assessment', 'initial assessment'),
      ('patient_medical_history', 'medical history'),
      ('patient_obstetric_history', 'obstetric history')
    ) as targets(table_name, label)
  loop
    execute pg_catalog.format(
      'drop policy %I on public.%I',
      'Clinic users can read ' || target.label,
      target.table_name
    );
    execute pg_catalog.format(
      'drop policy %I on public.%I',
      'Clinic users can insert ' || target.label,
      target.table_name
    );
    execute pg_catalog.format(
      'drop policy %I on public.%I',
      'Clinic users can update ' || target.label,
      target.table_name
    );
    execute pg_catalog.format(
      'drop policy %I on public.%I',
      'Clinic users can delete ' || target.label,
      target.table_name
    );
  end loop;

  for target in
    select * from (values
      ('medical_records', 'medical records'),
      ('patient_initial_assessment', 'initial assessment'),
      ('patient_medical_history', 'medical history'),
      ('patient_obstetric_history', 'obstetric history'),
      ('medication_reminders', 'medication reminders')
    ) as targets(table_name, label)
  loop
    execute pg_catalog.format($policy$
      create policy %I on public.%I
      for select to authenticated
      using (
        exists (
          select 1 from public.profiles as profile
          where profile.id = auth.uid()
            and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
            and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
        )
      )
    $policy$, 'Active Doctors can read ' || target.label, target.table_name);

    execute pg_catalog.format($policy$
      create policy %I on public.%I
      for insert to authenticated
      with check (
        exists (
          select 1 from public.profiles as profile
          where profile.id = auth.uid()
            and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
            and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
        )
      )
    $policy$, 'Active Doctors can insert ' || target.label, target.table_name);

    execute pg_catalog.format($policy$
      create policy %I on public.%I
      for update to authenticated
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
      )
    $policy$, 'Active Doctors can update ' || target.label, target.table_name);

    execute pg_catalog.format($policy$
      create policy %I on public.%I
      for delete to authenticated
      using (
        exists (
          select 1 from public.profiles as profile
          where profile.id = auth.uid()
            and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
            and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
        )
      )
    $policy$, 'Active Doctors can delete ' || target.label, target.table_name);
  end loop;
end;
$doctor_policies$;

-- Remove proven duplicate Patient policies, then recreate one canonical policy
-- per table with ownership plus strict active/non-archived eligibility.
drop policy "Patients can read own medication reminders" on public.medication_reminders;
drop policy "Patients read own medication reminders" on public.medication_reminders;
create policy "Patients can read own medication reminders"
on public.medication_reminders for select to authenticated
using (
  exists (
    select 1 from public.patients as patient
    where patient.id = medication_reminders.patient_id
      and patient.user_id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.account_status, ''::text))) = 'active'
      and patient.archived_at is null
      and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.status, ''::text)))
          not in ('inactive', 'archived', 'deleted')
  )
);

drop policy "Patients can read own initial assessment" on public.patient_initial_assessment;
drop policy "Patients read own initial assessment" on public.patient_initial_assessment;
create policy "Patients can read own initial assessment"
on public.patient_initial_assessment for select to authenticated
using (
  exists (
    select 1 from public.patients as patient
    where patient.id = patient_initial_assessment.patient_id
      and patient.user_id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.account_status, ''::text))) = 'active'
      and patient.archived_at is null
      and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.status, ''::text)))
          not in ('inactive', 'archived', 'deleted')
  )
);

drop policy "Patients can read own medical history" on public.patient_medical_history;
drop policy "Patients read own medical history" on public.patient_medical_history;
create policy "Patients can read own medical history"
on public.patient_medical_history for select to authenticated
using (
  exists (
    select 1 from public.patients as patient
    where patient.id = patient_medical_history.patient_id
      and patient.user_id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.account_status, ''::text))) = 'active'
      and patient.archived_at is null
      and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.status, ''::text)))
          not in ('inactive', 'archived', 'deleted')
  )
);

drop policy "Patients can read own obstetric history" on public.patient_obstetric_history;
drop policy "Patients read own obstetric history" on public.patient_obstetric_history;
create policy "Patients can read own obstetric history"
on public.patient_obstetric_history for select to authenticated
using (
  exists (
    select 1 from public.patients as patient
    where patient.id = patient_obstetric_history.patient_id
      and patient.user_id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.account_status, ''::text))) = 'active'
      and patient.archived_at is null
      and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.status, ''::text)))
          not in ('inactive', 'archived', 'deleted')
  )
);

-- medical_records has only one Patient policy in the live export.
drop policy "Patients read own medical records" on public.medical_records;
create policy "Patients read own medical records"
on public.medical_records for select to authenticated
using (
  exists (
    select 1 from public.patients as patient
    where patient.id = medical_records.patient_id
      and patient.user_id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.account_status, ''::text))) = 'active'
      and patient.archived_at is null
      and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.status, ''::text)))
          not in ('inactive', 'archived', 'deleted')
  )
);

-- Existing Patient occurrence access is already strict and is preserved.
drop policy "Doctors can read medication reminder occurrences"
  on public.medication_reminder_occurrences;
create policy "Active Doctors can read medication reminder occurrences"
on public.medication_reminder_occurrences for select to authenticated
using (
  exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  )
);

drop policy staff_visit_intake_clinic_read on public.staff_visit_intake;
drop policy staff_visit_intake_staff_insert on public.staff_visit_intake;
drop policy staff_visit_intake_staff_update on public.staff_visit_intake;

create policy "Active Doctors and Staff can read Staff visit intake"
on public.staff_visit_intake for select to authenticated
using (
  exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text)))
          in ('doctor', 'staff')
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  )
);

create policy "Active Staff can insert Staff visit intake"
on public.staff_visit_intake for insert to authenticated
with check (
  exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'staff'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  )
);

create policy "Active Staff can update Staff visit intake"
on public.staff_visit_intake for update to authenticated
using (
  exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'staff'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  )
)
with check (
  exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'staff'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  )
);

notify pgrst, 'reload schema';
commit;

-- ============================================================================
-- COMMENTED VERIFICATION
-- ============================================================================

-- 1. RLS and exact installed policy inventory.
-- select n.nspname, c.relname, c.relrowsecurity
-- from pg_catalog.pg_class as c
-- join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
-- where n.nspname = 'public' and c.relname in (
--   'medical_records', 'patient_initial_assessment', 'patient_medical_history',
--   'patient_obstetric_history', 'medication_reminders',
--   'medication_reminder_occurrences', 'medication_adherence_followups',
--   'medication_adherence_followup_events', 'staff_visit_intake'
-- ) order by c.relname;
--
-- select tablename, policyname, permissive, roles, cmd, qual, with_check
-- from pg_catalog.pg_policies
-- where schemaname = 'public' and tablename in (
--   'medical_records', 'patient_initial_assessment', 'patient_medical_history',
--   'patient_obstetric_history', 'medication_reminders',
--   'medication_reminder_occurrences', 'medication_adherence_followups',
--   'medication_adherence_followup_events', 'staff_visit_intake'
-- ) order by tablename, cmd, policyname;

-- 2. No direct clinical policy may mention Staff, Admin, is_clinic_user(), or
-- use account_status with the unsafe fallback value 'active'. Strict empty
-- fallbacks are intentionally not matched. Expect zero.
-- select tablename, policyname, qual, with_check
-- from pg_catalog.pg_policies
-- where schemaname = 'public'
--   and tablename <> 'staff_visit_intake'
--   and tablename in (
--     'medical_records', 'patient_initial_assessment', 'patient_medical_history',
--     'patient_obstetric_history', 'medication_reminders',
--     'medication_reminder_occurrences', 'medication_adherence_followups',
--     'medication_adherence_followup_events'
--   )
--   and (
--     pg_catalog.lower(coalesce(qual, '') || ' ' || coalesce(with_check, ''))
--       similar to '%(staff|admin|is_clinic_user)%'
--     or pg_catalog.regexp_replace(
--       pg_catalog.lower(coalesce(qual, '') || ' ' || coalesce(with_check, '')),
--       '[[:space:]]+', '', 'g'
--     ) ~ 'coalesce\([^,]*account_status,''active''(::text)?\)'
--   );

-- 3. The old unchecked function bodies must not be executable by browser roles.
-- select p.oid::pg_catalog.regprocedure as signature,
--        p.prosecdef as security_definer,
--        p.proconfig,
--        pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
--          as authenticated_can_execute
-- from pg_catalog.pg_proc as p
-- where p.oid in (
--   pg_catalog.to_regprocedure('public.get_appointment_visit_form_type_unchecked_v1(uuid)'),
--   pg_catalog.to_regprocedure('public.save_appointment_visit_record_unchecked_v1(uuid,text,jsonb)'),
--   pg_catalog.to_regprocedure('public.get_staff_visit_intake_unchecked_v1(uuid)'),
--   pg_catalog.to_regprocedure('public.save_staff_visit_intake_unchecked_v1(uuid,text,jsonb)')
-- );

-- 4. The guarded public facades must remain SECURITY DEFINER with an empty
-- protected search_path. Argument names, owner, volatility, return contract,
-- and the relevant caller privileges are displayed for review.
-- select p.oid::pg_catalog.regprocedure as signature, p.proargnames,
--        pg_catalog.pg_get_function_result(p.oid) as return_type,
--        p.proretset, p.prosecdef, p.provolatile,
--        pg_catalog.pg_get_userbyid(p.proowner) as owner_name,
--        p.proconfig, p.proacl,
--        pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
--        pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
--        pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute
-- from pg_catalog.pg_proc as p
-- where p.oid in (
--   pg_catalog.to_regprocedure('public.get_appointment_visit_form_type(uuid)'),
--   pg_catalog.to_regprocedure('public.save_appointment_visit_record(uuid,text,jsonb)'),
--   pg_catalog.to_regprocedure('public.get_staff_visit_intake(uuid)'),
--   pg_catalog.to_regprocedure('public.save_staff_visit_intake(uuid,text,jsonb)')
-- );

-- 5. Patient policy deduplication. Expect one row per listed table.
-- select tablename, pg_catalog.count(*)
-- from pg_catalog.pg_policies
-- where schemaname = 'public'
--   and tablename in (
--     'medication_reminders', 'patient_initial_assessment',
--     'patient_medical_history', 'patient_obstetric_history'
--   )
--   and policyname ilike 'Patients%read own%'
-- group by tablename order by tablename;

-- Manual role/status matrix, using dedicated non-production rows:
-- Actor             Doctor clinical tables   staff_visit_intake   Patient own rows
-- Active Doctor     required CRUD             SELECT               no ownership path
-- Inactive Doctor   denied                    denied               denied
-- Active Staff      denied                    SELECT/INSERT/UPDATE  no ownership path
-- Inactive Staff    denied                    denied               denied
-- Active Admin      denied                    denied               no ownership path
-- Inactive Admin    denied                    denied               denied
-- Active Patient    own SELECT only           denied               own SELECT
-- Inactive Patient  denied                    denied               denied
-- Unauthenticated   denied                    denied               denied
--
-- Also verify that Active Staff can call save_staff_visit_intake, cannot call
-- save_appointment_visit_record, and cannot SELECT public.medical_records.

-- ============================================================================
-- COMMENTED EMERGENCY ROLLBACK
-- WARNING: This restores the exact known broad live policies, inactive-account
-- gaps, duplicate Patient policies, and Staff/Admin medical-record access.
-- Renaming each _unchecked_v1 object back restores its original owner and ACL;
-- do not recreate those original functions from guessed grants.
-- ============================================================================
-- begin;
--
-- drop function public.get_appointment_visit_form_type(uuid);
-- drop function public.save_appointment_visit_record(uuid, text, jsonb);
-- drop function public.get_staff_visit_intake(uuid);
-- drop function public.save_staff_visit_intake(uuid, text, jsonb);
-- alter function public.get_appointment_visit_form_type_unchecked_v1(uuid)
--   rename to get_appointment_visit_form_type;
-- alter function public.save_appointment_visit_record_unchecked_v1(uuid, text, jsonb)
--   rename to save_appointment_visit_record;
-- alter function public.get_staff_visit_intake_unchecked_v1(uuid)
--   rename to get_staff_visit_intake;
-- alter function public.save_staff_visit_intake_unchecked_v1(uuid, text, jsonb)
--   rename to save_staff_visit_intake;
-- revoke all on function public.get_appointment_visit_form_type(uuid) from public, anon, authenticated, service_role;
-- grant execute on function public.get_appointment_visit_form_type(uuid) to authenticated, service_role;
-- revoke all on function public.save_appointment_visit_record(uuid, text, jsonb) from public, anon, authenticated, service_role;
-- grant execute on function public.save_appointment_visit_record(uuid, text, jsonb) to authenticated, service_role;
-- revoke all on function public.get_staff_visit_intake(uuid) from public, anon, authenticated, service_role;
-- grant execute on function public.get_staff_visit_intake(uuid) to authenticated, service_role;
-- revoke all on function public.save_staff_visit_intake(uuid, text, jsonb) from public, anon, authenticated, service_role;
-- grant execute on function public.save_staff_visit_intake(uuid, text, jsonb) to authenticated, service_role;
--
-- do $rollback_doctor_policies$
-- declare target record;
-- begin
--   for target in select * from (values
--     ('medical_records', 'medical records'),
--     ('patient_initial_assessment', 'initial assessment'),
--     ('patient_medical_history', 'medical history'),
--     ('patient_obstetric_history', 'obstetric history'),
--     ('medication_reminders', 'medication reminders')
--   ) as targets(table_name, label)
--   loop
--     execute pg_catalog.format('drop policy %I on public.%I',
--       'Active Doctors can read ' || target.label, target.table_name);
--     execute pg_catalog.format('drop policy %I on public.%I',
--       'Active Doctors can insert ' || target.label, target.table_name);
--     execute pg_catalog.format('drop policy %I on public.%I',
--       'Active Doctors can update ' || target.label, target.table_name);
--     execute pg_catalog.format('drop policy %I on public.%I',
--       'Active Doctors can delete ' || target.label, target.table_name);
--   end loop;
-- end;
-- $rollback_doctor_policies$;
-- drop policy "Patients read own medical records" on public.medical_records;
-- drop policy "Patients can read own initial assessment" on public.patient_initial_assessment;
-- drop policy "Patients can read own medical history" on public.patient_medical_history;
-- drop policy "Patients can read own obstetric history" on public.patient_obstetric_history;
-- drop policy "Patients can read own medication reminders" on public.medication_reminders;
-- drop policy "Active Doctors can read medication reminder occurrences" on public.medication_reminder_occurrences;
-- drop policy "Active Doctors can read medication adherence followups" on public.medication_adherence_followups;
-- drop policy "Active Doctors can read medication adherence followup events" on public.medication_adherence_followup_events;
-- drop policy "Active Doctors and Staff can read Staff visit intake" on public.staff_visit_intake;
-- drop policy "Active Staff can insert Staff visit intake" on public.staff_visit_intake;
-- drop policy "Active Staff can update Staff visit intake" on public.staff_visit_intake;
--
-- create policy "Clinic users can delete medical records"
-- on public.medical_records for delete to authenticated using (public.is_clinic_user());
-- create policy "Clinic users can insert medical records"
-- on public.medical_records for insert to authenticated with check (public.is_clinic_user());
-- create policy "Clinic users can read medical records"
-- on public.medical_records for select to authenticated using (public.is_clinic_user());
-- create policy "Clinic users can update medical records"
-- on public.medical_records for update to authenticated
-- using (public.is_clinic_user()) with check (public.is_clinic_user());
-- create policy "Patients read own medical records"
-- on public.medical_records for select to authenticated
-- using (exists (select 1 from public.patients
--   where patients.id = medical_records.patient_id and patients.user_id = auth.uid()));
--
-- do $rollback_history_policies$
-- declare target record;
-- begin
--   for target in select * from (values
--     ('patient_initial_assessment', 'initial assessment'),
--     ('patient_medical_history', 'medical history'),
--     ('patient_obstetric_history', 'obstetric history')
--   ) as targets(table_name, label)
--   loop
--     execute pg_catalog.format('create policy %I on public.%I for select to authenticated using ((select public.is_clinic_user()))',
--       'Clinic users can read ' || target.label, target.table_name);
--     execute pg_catalog.format('create policy %I on public.%I for insert to authenticated with check ((select public.is_clinic_user()))',
--       'Clinic users can insert ' || target.label, target.table_name);
--     execute pg_catalog.format('create policy %I on public.%I for update to authenticated using ((select public.is_clinic_user())) with check ((select public.is_clinic_user()))',
--       'Clinic users can update ' || target.label, target.table_name);
--     execute pg_catalog.format('create policy %I on public.%I for delete to authenticated using ((select public.is_clinic_user()))',
--       'Clinic users can delete ' || target.label, target.table_name);
--   end loop;
-- end;
-- $rollback_history_policies$;
-- create policy "Patients can read own initial assessment"
-- on public.patient_initial_assessment for select to authenticated
-- using (exists (select 1 from public.patients
--   where patients.id = patient_initial_assessment.patient_id and patients.user_id = auth.uid()));
-- create policy "Patients read own initial assessment"
-- on public.patient_initial_assessment for select to authenticated
-- using (exists (select 1 from public.patients
--   where patients.id = patient_initial_assessment.patient_id and patients.user_id = auth.uid()));
-- create policy "Patients can read own medical history"
-- on public.patient_medical_history for select to authenticated
-- using (exists (select 1 from public.patients
--   where patients.id = patient_medical_history.patient_id and patients.user_id = auth.uid()));
-- create policy "Patients read own medical history"
-- on public.patient_medical_history for select to authenticated
-- using (exists (select 1 from public.patients
--   where patients.id = patient_medical_history.patient_id and patients.user_id = auth.uid()));
-- create policy "Patients can read own obstetric history"
-- on public.patient_obstetric_history for select to authenticated
-- using (exists (select 1 from public.patients
--   where patients.id = patient_obstetric_history.patient_id and patients.user_id = auth.uid()));
-- create policy "Patients read own obstetric history"
-- on public.patient_obstetric_history for select to authenticated
-- using (exists (select 1 from public.patients
--   where patients.id = patient_obstetric_history.patient_id and patients.user_id = auth.uid()));
--
-- create policy "Clinic users can manage medication reminders"
-- on public.medication_reminders for all to authenticated
-- using (exists (select 1 from public.profiles
--   where profiles.id = auth.uid()
--     and lower(coalesce(profiles.role, '')) in ('admin', 'doctor')))
-- with check (exists (select 1 from public.profiles
--   where profiles.id = auth.uid()
--     and lower(coalesce(profiles.role, '')) in ('admin', 'doctor')));
-- create policy "Patients can read own medication reminders"
-- on public.medication_reminders for select to authenticated
-- using (exists (select 1 from public.patients
--   where patients.id = medication_reminders.patient_id and patients.user_id = auth.uid()));
-- create policy "Patients read own medication reminders"
-- on public.medication_reminders for select to authenticated
-- using (exists (select 1 from public.patients
--   where patients.id = medication_reminders.patient_id and patients.user_id = auth.uid()));
--
-- create policy "Doctors can read medication reminder occurrences"
-- on public.medication_reminder_occurrences for select to authenticated
-- using (exists (select 1 from public.profiles as profile
--   where profile.id = auth.uid()
--     and lower(btrim(coalesce(profile.role, ''::text))) = 'doctor'));
--
-- create policy "Doctors and admins can read medication adherence followups"
-- on public.medication_adherence_followups for select to authenticated
-- using (exists (select 1 from public.profiles as profile
--   where profile.id = auth.uid()
--     and lower(btrim(coalesce(profile.role, ''::text))) in ('doctor', 'admin')
--     and lower(btrim(coalesce(profile.account_status, 'active'::text))) = 'active'));
-- create policy "Doctors and admins can read medication adherence followup event"
-- on public.medication_adherence_followup_events for select to authenticated
-- using (exists (select 1 from public.profiles as profile
--   where profile.id = auth.uid()
--     and lower(btrim(coalesce(profile.role, ''::text))) in ('doctor', 'admin')
--     and lower(btrim(coalesce(profile.account_status, 'active'::text))) = 'active'));
--
-- create policy staff_visit_intake_clinic_read
-- on public.staff_visit_intake for select to authenticated
-- using (exists (select 1 from public.profiles as p
--   where p.id = auth.uid() and lower(btrim(coalesce(p.role, '')))
--     in ('doctor', 'staff', 'admin')));
-- create policy staff_visit_intake_staff_insert
-- on public.staff_visit_intake for insert to authenticated
-- with check (exists (select 1 from public.profiles as p
--   where p.id = auth.uid() and lower(btrim(coalesce(p.role, '')))
--     in ('staff', 'admin')));
-- create policy staff_visit_intake_staff_update
-- on public.staff_visit_intake for update to authenticated
-- using (exists (select 1 from public.profiles as p
--   where p.id = auth.uid() and lower(btrim(coalesce(p.role, '')))
--     in ('staff', 'admin')))
-- with check (exists (select 1 from public.profiles as p
--   where p.id = auth.uid() and lower(btrim(coalesce(p.role, '')))
--     in ('staff', 'admin')));
--
-- notify pgrst, 'reload schema';
-- commit;
