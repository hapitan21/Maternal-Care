-- Maternal Care - review-only public.patients operational RLS hardening.
-- Authoritative policy source: live 42-row Supabase RLS export, 2026-08-06.
-- DO NOT execute until reviewed together with
-- supabase_patient_clinical_rls_hardening_v2.sql.
--
-- public.patients mixes operational identity fields with pregnancy/risk fields.
-- Browser roles therefore receive fixed columns through role-scoped SECURITY
-- DEFINER RPCs; authenticated receives no direct SELECT privilege on the table.
-- Reviewed original registration RPC ACL: PUBLIC=false, anon=false,
-- authenticated=true, service_role=true, with no other non-owner grantees.

begin;

do $preflight$
declare
  v_issues text[] := array[]::text[];
  v_new_issues text[];
begin
  with required(column_name, expected_type) as (
    values
      ('id', 'uuid'),
      ('full_name', 'text'),
      ('patient_id', 'text'),
      ('control_number', 'text'),
      ('date_of_birth', 'date'),
      ('age', 'integer'),
      ('contact_number', 'text'),
      ('email', 'text'),
      ('address', 'text'),
      ('user_id', 'uuid'),
      ('status', 'text'),
      ('account_status', 'text'),
      ('expected_delivery_date', 'date'),
      ('gestational_age', 'text'),
      ('trimester', 'text'),
      ('risk_level', 'text'),
      ('allergies', 'text'),
      ('chronic_illness', 'text'),
      ('current_medications', 'text'),
      ('blood_type', 'text'),
      ('medical_notes', 'text'),
      ('archived_at', 'timestamp with time zone'),
      ('archived_by', 'uuid'),
      ('created_at', 'timestamp with time zone'),
      ('updated_at', 'timestamp with time zone')
  )
  select pg_catalog.array_agg(
    case when actual.column_name is null then
      'missing public.patients.' || required.column_name
    else pg_catalog.format(
      'type mismatch public.patients.%I: expected %s, found %s',
      required.column_name, required.expected_type, actual.data_type
    ) end order by required.column_name
  ) into v_new_issues
  from required
  left join information_schema.columns as actual
    on actual.table_schema = 'public'
   and actual.table_name = 'patients'
   and actual.column_name = required.column_name
  where actual.column_name is null or actual.data_type <> required.expected_type;

  v_issues := v_issues || coalesce(v_new_issues, array[]::text[]);

  with required(column_name, expected_type) as (
    values ('id', 'uuid'), ('role', 'text'), ('account_status', 'text')
  )
  select pg_catalog.array_agg(
    case when actual.column_name is null then
      'missing public.profiles.' || required.column_name
    else pg_catalog.format(
      'type mismatch public.profiles.%I: expected %s, found %s',
      required.column_name, required.expected_type, actual.data_type
    ) end order by required.column_name
  ) into v_new_issues
  from required
  left join information_schema.columns as actual
    on actual.table_schema = 'public'
   and actual.table_name = 'profiles'
   and actual.column_name = required.column_name
  where actual.column_name is null or actual.data_type <> required.expected_type;

  v_issues := v_issues || coalesce(v_new_issues, array[]::text[]);

  if not exists (
    select 1 from pg_catalog.pg_class as relation
    where relation.oid = pg_catalog.to_regclass('public.patients')
      and relation.relrowsecurity
  ) then
    v_issues := pg_catalog.array_append(v_issues, 'RLS is not enabled on public.patients');
  end if;

  if pg_catalog.to_regprocedure('public.is_clinic_user()') is null then
    v_issues := pg_catalog.array_append(v_issues, 'missing public.is_clinic_user()');
  elsif not (
    select routine.prorettype = 'pg_catalog.bool'::pg_catalog.regtype
       and routine.prosecdef
       and coalesce(routine.proconfig, array[]::text[]) @> array['search_path=""']
       and pg_catalog.lower(pg_catalog.pg_get_functiondef(routine.oid)) like '%account_status%'
    from pg_catalog.pg_proc as routine
    where routine.oid = pg_catalog.to_regprocedure('public.is_clinic_user()')
  ) then
    v_issues := pg_catalog.array_append(v_issues, 'public.is_clinic_user() active-account contract is incompatible');
  end if;

  if pg_catalog.to_regprocedure('public.is_current_admin()') is null then
    v_issues := pg_catalog.array_append(v_issues, 'missing public.is_current_admin()');
  end if;

  -- Exact fingerprints of all nine live public.patients policies.
  with expected(policy_name, command_name, qual_md5, check_md5) as (
    values
      ('Admins can update patient account access', 'UPDATE', 'a7892b7b9525bf30af37be7744170394', 'a7892b7b9525bf30af37be7744170394'),
      ('Allow patient deletes', 'DELETE', 'b326b5062b2f0e69046810717534cb09', null),
      ('Allow patient inserts', 'INSERT', null, 'b326b5062b2f0e69046810717534cb09'),
      ('Allow patient reads', 'SELECT', 'b326b5062b2f0e69046810717534cb09', null),
      ('Clinic users can insert patients', 'INSERT', null, '24fc0cf514b6a3b2517b775442845f5c'),
      ('Clinic users can read patients', 'SELECT', '24fc0cf514b6a3b2517b775442845f5c', null),
      ('Clinic users can update patients', 'UPDATE', '24fc0cf514b6a3b2517b775442845f5c', '24fc0cf514b6a3b2517b775442845f5c'),
      ('Patients can read own patient record', 'SELECT', '7789914c371d0d8c8f85d122c10c9292', null),
      ('Patients can update own patient record', 'UPDATE', '7789914c371d0d8c8f85d122c10c9292', '7789914c371d0d8c8f85d122c10c9292')
  ), actual as (
    select
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
    where policy.schemaname = 'public' and policy.tablename = 'patients'
  ), drift as (
    select coalesce(expected.policy_name, actual.policy_name) as policy_name
    from expected
    full join actual using (policy_name)
    where expected.policy_name is null
       or actual.policy_name is null
       or actual.command_name <> expected.command_name
       or actual.permissive <> 'PERMISSIVE'
       or actual.roles <> array['authenticated'::name]
       or actual.qual_md5 is distinct from expected.qual_md5
       or actual.check_md5 is distinct from expected.check_md5
  )
  select pg_catalog.array_agg('live patients policy drift: ' || drift.policy_name)
  into v_new_issues from drift;

  v_issues := v_issues || coalesce(v_new_issues, array[]::text[]);

  with required(signature, argument_names, return_type, returns_set, volatility) as (
    values
      ('public.save_patient_registration(uuid,uuid,jsonb)', array['p_registration_token','p_patient_record_id','p_registration_data','id','full_name','patient_id','control_number','date_of_birth','age','contact_number','email','address','status','account_status','registration_status','user_id','control_used_at','created_at','registration_data']::text[], 'pg_catalog.record'::pg_catalog.regtype, true, 'v'::"char"),
      ('public.finish_patient_registration(uuid,uuid,boolean)', array['p_patient_record_id','p_registration_token','p_access_handoff_confirmed','id','full_name','patient_id','control_number','date_of_birth','age','contact_number','email','address','status','account_status','registration_status','user_id','control_used_at','created_at','registration_data']::text[], 'pg_catalog.record'::pg_catalog.regtype, true, 'v'::"char"),
      ('public.get_patient_registration_draft(uuid,uuid)', array['p_patient_record_id','p_registration_token','id','full_name','patient_id','control_number','date_of_birth','age','contact_number','email','address','status','account_status','registration_status','user_id','control_used_at','created_at','registration_data']::text[], 'pg_catalog.record'::pg_catalog.regtype, true, 's'::"char"),
      ('public.finish_walkin_patient_registration(uuid,uuid,uuid,boolean)', array['p_patient_record_id','p_registration_token','p_reservation_id','p_access_handoff_confirmed','id','full_name','patient_id','control_number','date_of_birth','age','contact_number','email','address','status','account_status','registration_status','user_id','control_used_at','created_at','registration_data']::text[], 'pg_catalog.record'::pg_catalog.regtype, true, 'v'::"char")
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

  if pg_catalog.to_regprocedure('public.save_patient_registration_unchecked_v1(uuid,uuid,jsonb)') is not null
     or pg_catalog.to_regprocedure('public.finish_patient_registration_unchecked_v1(uuid,uuid,boolean)') is not null
     or pg_catalog.to_regprocedure('public.get_patient_registration_draft_unchecked_v1(uuid,uuid)') is not null
     or pg_catalog.to_regprocedure('public.finish_walkin_patient_registration_unchecked_v1(uuid,uuid,uuid,boolean)') is not null
     or pg_catalog.to_regprocedure('public.set_staff_patient_archive_state(uuid,boolean)') is not null
     or pg_catalog.to_regprocedure('public.get_staff_patient_directory()') is not null
     or pg_catalog.to_regprocedure('public.get_admin_patient_directory()') is not null
     or pg_catalog.to_regprocedure('public.get_doctor_patient_directory()') is not null
     or pg_catalog.to_regprocedure('public.get_patient_own_record()') is not null then
    v_issues := pg_catalog.array_append(v_issues, 'reserved operational hardening function name already exists');
  end if;

  if not pg_catalog.has_table_privilege('authenticated', 'public.patients', 'SELECT')
     or not pg_catalog.has_table_privilege('authenticated', 'public.patients', 'INSERT')
     or not pg_catalog.has_table_privilege('authenticated', 'public.patients', 'UPDATE')
     or not pg_catalog.has_table_privilege('authenticated', 'public.patients', 'DELETE') then
    v_issues := pg_catalog.array_append(v_issues, 'unexpected authenticated public.patients grant contract');
  end if;

  if pg_catalog.cardinality(v_issues) > 0 then
    raise exception 'Patients operational RLS hardening preflight failed: %',
      pg_catalog.array_to_string(v_issues, '; ');
  end if;
end;
$preflight$;

-- Keep complete registration implementations but remove browser access to the
-- unchecked bodies. Same-name facades enforce active Staff/Admin eligibility.
alter function public.save_patient_registration(uuid, uuid, jsonb)
  rename to save_patient_registration_unchecked_v1;
alter function public.finish_patient_registration(uuid, uuid, boolean)
  rename to finish_patient_registration_unchecked_v1;
alter function public.get_patient_registration_draft(uuid, uuid)
  rename to get_patient_registration_draft_unchecked_v1;
alter function public.finish_walkin_patient_registration(uuid, uuid, uuid, boolean)
  rename to finish_walkin_patient_registration_unchecked_v1;

revoke all on function public.save_patient_registration_unchecked_v1(uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.finish_patient_registration_unchecked_v1(uuid, uuid, boolean)
  from public, anon, authenticated;
revoke all on function public.get_patient_registration_draft_unchecked_v1(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.finish_walkin_patient_registration_unchecked_v1(uuid, uuid, uuid, boolean)
  from public, anon, authenticated;

create function public.save_patient_registration(
  p_registration_token uuid,
  p_patient_record_id uuid default null,
  p_registration_data jsonb default '{}'::jsonb
)
returns table (
  id uuid, full_name text, patient_id text, control_number text,
  date_of_birth date, age integer, contact_number text, email text,
  address text, status text, account_status text, registration_status text,
  user_id uuid, control_used_at timestamptz, created_at timestamptz,
  registration_data jsonb
)
language plpgsql security definer set search_path = ''
as $function$
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text)))
          in ('staff', 'admin')
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  ) then
    raise exception 'Only active Staff or Admin users can register Patients.'
      using errcode = '42501';
  end if;

  return query select * from public.save_patient_registration_unchecked_v1(
    p_registration_token, p_patient_record_id, p_registration_data
  );
end;
$function$;

create function public.finish_patient_registration(
  p_patient_record_id uuid,
  p_registration_token uuid,
  p_access_handoff_confirmed boolean
)
returns table (
  id uuid, full_name text, patient_id text, control_number text,
  date_of_birth date, age integer, contact_number text, email text,
  address text, status text, account_status text, registration_status text,
  user_id uuid, control_used_at timestamptz, created_at timestamptz,
  registration_data jsonb
)
language plpgsql security definer set search_path = ''
as $function$
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text)))
          in ('staff', 'admin')
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  ) then
    raise exception 'Only active Staff or Admin users can finish Patient registration.'
      using errcode = '42501';
  end if;

  return query select * from public.finish_patient_registration_unchecked_v1(
    p_patient_record_id, p_registration_token, p_access_handoff_confirmed
  );
end;
$function$;

create function public.get_patient_registration_draft(
  p_patient_record_id uuid,
  p_registration_token uuid
)
returns table (
  id uuid, full_name text, patient_id text, control_number text,
  date_of_birth date, age integer, contact_number text, email text,
  address text, status text, account_status text, registration_status text,
  user_id uuid, control_used_at timestamptz, created_at timestamptz,
  registration_data jsonb
)
language plpgsql stable security definer set search_path = ''
as $function$
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text)))
          in ('staff', 'admin')
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  ) then
    raise exception 'Only active Staff or Admin users can restore Patient registration.'
      using errcode = '42501';
  end if;

  return query select * from public.get_patient_registration_draft_unchecked_v1(
    p_patient_record_id, p_registration_token
  );
end;
$function$;

create function public.finish_walkin_patient_registration(
  p_patient_record_id uuid,
  p_registration_token uuid,
  p_reservation_id uuid,
  p_access_handoff_confirmed boolean
)
returns table (
  id uuid, full_name text, patient_id text, control_number text,
  date_of_birth date, age integer, contact_number text, email text,
  address text, status text, account_status text, registration_status text,
  user_id uuid, control_used_at timestamptz, created_at timestamptz,
  registration_data jsonb
)
language plpgsql security definer set search_path = ''
as $function$
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text)))
          in ('staff', 'admin')
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  ) then
    raise exception 'Only active Staff or Admin users can finish walk-in registration.'
      using errcode = '42501';
  end if;

  return query select * from public.finish_walkin_patient_registration_unchecked_v1(
    p_patient_record_id, p_registration_token, p_reservation_id,
    p_access_handoff_confirmed
  );
end;
$function$;

create function public.get_staff_patient_directory()
returns table (
  id uuid, full_name text, patient_id text, control_number text,
  date_of_birth date, age integer, contact_number text, email text,
  address text, status text, account_status text, user_id uuid,
  archived_at timestamptz, archived_by uuid, created_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $function$
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'staff'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  ) then
    raise exception 'Only active Staff can read the Patient directory.' using errcode = '42501';
  end if;

  return query select
    patient.id, patient.full_name, patient.patient_id, patient.control_number,
    patient.date_of_birth, patient.age, patient.contact_number, patient.email,
    patient.address, patient.status, patient.account_status, patient.user_id,
    patient.archived_at, patient.archived_by, patient.created_at
  from public.patients as patient;
end;
$function$;

create function public.get_admin_patient_directory()
returns table (
  id uuid, full_name text, patient_id text, date_of_birth date, age integer,
  contact_number text, status text, account_status text,
  archived_at timestamptz, created_at timestamptz, control_number text
)
language plpgsql stable security definer set search_path = ''
as $function$
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'admin'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  ) then
    raise exception 'Only active Admins can read the operational Patient directory.' using errcode = '42501';
  end if;

  return query select
    patient.id, patient.full_name, patient.patient_id, patient.date_of_birth,
    patient.age, patient.contact_number, patient.status, patient.account_status,
    patient.archived_at, patient.created_at, patient.control_number
  from public.patients as patient;
end;
$function$;

create function public.get_doctor_patient_directory()
returns table (
  id uuid, full_name text, patient_id text, control_number text, user_id uuid,
  date_of_birth date, age integer, contact_number text, email text, address text,
  status text, account_status text, archived_at timestamptz, archived_by uuid,
  expected_delivery_date date, gestational_age text, trimester text,
  risk_level text, allergies text, chronic_illness text,
  current_medications text, blood_type text, medical_notes text,
  created_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $function$
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  ) then
    raise exception 'Only active Doctors can read the clinical Patient directory.' using errcode = '42501';
  end if;

  return query select
    patient.id, patient.full_name, patient.patient_id, patient.control_number,
    patient.user_id, patient.date_of_birth, patient.age, patient.contact_number,
    patient.email, patient.address, patient.status, patient.account_status,
    patient.archived_at, patient.archived_by, patient.expected_delivery_date,
    patient.gestational_age, patient.trimester, patient.risk_level,
    patient.allergies, patient.chronic_illness, patient.current_medications,
    patient.blood_type, patient.medical_notes, patient.created_at
  from public.patients as patient;
end;
$function$;

create function public.get_patient_own_record()
returns table (
  id uuid, full_name text, patient_id text, user_id uuid, email text,
  date_of_birth date, age integer, address text, contact_number text,
  expected_delivery_date date, gestational_age text, trimester text,
  risk_level text, allergies text, chronic_illness text,
  current_medications text, blood_type text, medical_notes text,
  status text, account_status text, archived_at timestamptz, created_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $function$
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  return query select
    patient.id, patient.full_name, patient.patient_id, patient.user_id,
    patient.email, patient.date_of_birth, patient.age, patient.address,
    patient.contact_number, patient.expected_delivery_date,
    patient.gestational_age, patient.trimester, patient.risk_level,
    patient.allergies, patient.chronic_illness, patient.current_medications,
    patient.blood_type, patient.medical_notes, patient.status,
    patient.account_status, patient.archived_at, patient.created_at
  from public.patients as patient
  where patient.user_id = auth.uid()
    and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.account_status, ''::text))) = 'active'
    and patient.archived_at is null
    and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.status, ''::text)))
        not in ('inactive', 'archived', 'deleted')
  limit 1;
end;
$function$;

create function public.set_staff_patient_archive_state(
  p_patient_id uuid,
  p_archived boolean
)
returns table (
  patient_id uuid,
  archived_at timestamptz,
  archived_by uuid,
  record_status text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_patient public.patients%rowtype;
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'staff'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  ) then
    raise exception 'Only active Staff can archive or restore Patients.'
      using errcode = '42501';
  end if;

  if p_patient_id is null or p_archived is null then
    raise exception 'Patient and archive state are required.' using errcode = '22023';
  end if;

  select patient.* into v_patient
  from public.patients as patient
  where patient.id = p_patient_id
  for update;

  if not found then
    raise exception 'Patient record not found.' using errcode = 'P0002';
  end if;

  if p_archived and v_patient.archived_at is not null then
    raise exception 'Patient is already archived.' using errcode = '22023';
  end if;

  if not p_archived and v_patient.archived_at is null then
    raise exception 'Patient is already restored.' using errcode = '22023';
  end if;

  return query
  update public.patients as patient
  set archived_at = case when p_archived then pg_catalog.now() else null end,
      archived_by = case when p_archived then auth.uid() else null end,
      updated_at = pg_catalog.now()
  where patient.id = p_patient_id
  returning patient.id, patient.archived_at, patient.archived_by, patient.status;
end;
$function$;

revoke all on function public.save_patient_registration(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.save_patient_registration(uuid, uuid, jsonb) to authenticated, service_role;
revoke all on function public.finish_patient_registration(uuid, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.finish_patient_registration(uuid, uuid, boolean) to authenticated, service_role;
revoke all on function public.get_patient_registration_draft(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_patient_registration_draft(uuid, uuid) to authenticated, service_role;
revoke all on function public.finish_walkin_patient_registration(uuid, uuid, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.finish_walkin_patient_registration(uuid, uuid, uuid, boolean) to authenticated, service_role;
revoke all on function public.get_staff_patient_directory() from public, anon, authenticated, service_role;
grant execute on function public.get_staff_patient_directory() to authenticated, service_role;
revoke all on function public.get_admin_patient_directory() from public, anon, authenticated, service_role;
grant execute on function public.get_admin_patient_directory() to authenticated, service_role;
revoke all on function public.get_doctor_patient_directory() from public, anon, authenticated, service_role;
grant execute on function public.get_doctor_patient_directory() to authenticated, service_role;
revoke all on function public.get_patient_own_record() from public, anon, authenticated, service_role;
grant execute on function public.get_patient_own_record() to authenticated, service_role;
revoke all on function public.set_staff_patient_archive_state(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_staff_patient_archive_state(uuid, boolean) to authenticated, service_role;

-- Replace all nine exact live policies. Direct raw INSERT and DELETE are removed;
-- direct UPDATE remains only for an active Patient's own linked record.
drop policy "Admins can update patient account access" on public.patients;
drop policy "Allow patient deletes" on public.patients;
drop policy "Allow patient inserts" on public.patients;
drop policy "Allow patient reads" on public.patients;
drop policy "Clinic users can insert patients" on public.patients;
drop policy "Clinic users can read patients" on public.patients;
drop policy "Clinic users can update patients" on public.patients;
drop policy "Patients can read own patient record" on public.patients;
drop policy "Patients can update own patient record" on public.patients;

create policy "Active Patients can update own patient record"
on public.patients for update to authenticated
using (
  user_id = auth.uid()
  and pg_catalog.lower(pg_catalog.btrim(coalesce(account_status, ''::text))) = 'active'
  and archived_at is null
  and pg_catalog.lower(pg_catalog.btrim(coalesce(status, ''::text)))
      not in ('inactive', 'archived', 'deleted')
)
with check (
  user_id = auth.uid()
  and pg_catalog.lower(pg_catalog.btrim(coalesce(account_status, ''::text))) = 'active'
  and archived_at is null
  and pg_catalog.lower(pg_catalog.btrim(coalesce(status, ''::text)))
      not in ('inactive', 'archived', 'deleted')
);

revoke select, insert, delete on public.patients from public, anon, authenticated;
grant update on public.patients to authenticated;

notify pgrst, 'reload schema';
commit;

-- ============================================================================
-- COMMENTED VERIFICATION
-- ============================================================================
-- select c.relrowsecurity from pg_catalog.pg_class as c
-- where c.oid = 'public.patients'::pg_catalog.regclass;
--
-- select policyname, permissive, roles, cmd, qual, with_check
-- from pg_catalog.pg_policies
-- where schemaname = 'public' and tablename = 'patients'
-- order by cmd, policyname;
--
-- Unconditional true and direct INSERT/DELETE policies must be absent. Expect 0.
-- select * from pg_catalog.pg_policies
-- where schemaname = 'public' and tablename = 'patients'
--   and (
--     pg_catalog.lower(coalesce(qual, '')) = 'true'
--     or pg_catalog.lower(coalesce(with_check, '')) = 'true'
--     or cmd in ('INSERT', 'DELETE')
--   );
--
-- Browser grants: only UPDATE remains for the narrowly owned Patient policy.
-- SELECT/INSERT/DELETE must be false.
-- select privilege_type,
--        pg_catalog.has_table_privilege(
--          'authenticated', 'public.patients', privilege_type
--        ) as authenticated_has_privilege
-- from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(privilege_type);
--
-- Guarded, directory, archive, and unchecked function contracts/privileges.
-- select p.oid::pg_catalog.regprocedure as signature, p.proargnames,
--        pg_catalog.pg_get_function_result(p.oid) as return_type,
--        p.proretset, p.prosecdef, p.provolatile,
--        pg_catalog.pg_get_userbyid(p.proowner) as owner_name,
--        p.proconfig, p.proacl,
--        pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
--        pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
--        pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute
-- from pg_catalog.pg_proc as p
-- where p.proname like '%patient_registration%'
--    or p.proname in (
--      'set_staff_patient_archive_state', 'get_staff_patient_directory',
--      'get_admin_patient_directory', 'get_doctor_patient_directory',
--      'get_patient_own_record'
--    )
-- order by signature::text;
--
-- Manual role/status matrix:
-- Active Staff: Staff directory, registration, and archive RPCs work;
--               raw INSERT/UPDATE/DELETE fail.
-- Inactive Staff: directory and all guarded RPCs fail.
-- Active Doctor: Doctor clinical directory works; raw table SELECT/mutations fail.
-- Inactive Doctor: Doctor directory fails.
-- Active Admin: Admin operational directory and secure status RPCs remain usable;
--               raw INSERT/UPDATE/DELETE fail.
-- Inactive Admin: Admin directory and guarded registration RPCs fail.
-- Active Patient: own active non-archived RPC row; owned UPDATE policy only.
-- Inactive/archived Patient: denied.
-- Unauthenticated: denied.

-- ============================================================================
-- COMMENTED EMERGENCY ROLLBACK
-- WARNING: Restores unconditional authenticated SELECT/INSERT/DELETE and the
-- known inactive-account vulnerabilities from the live CSV.
-- Renaming each _unchecked_v1 object back restores its original owner and ACL;
-- do not recreate those original functions from guessed grants.
-- ============================================================================
-- begin;
-- drop policy "Active Patients can update own patient record" on public.patients;
--
-- drop function public.set_staff_patient_archive_state(uuid, boolean);
-- drop function public.get_staff_patient_directory();
-- drop function public.get_admin_patient_directory();
-- drop function public.get_doctor_patient_directory();
-- drop function public.get_patient_own_record();
-- drop function public.save_patient_registration(uuid, uuid, jsonb);
-- drop function public.finish_patient_registration(uuid, uuid, boolean);
-- drop function public.get_patient_registration_draft(uuid, uuid);
-- drop function public.finish_walkin_patient_registration(uuid, uuid, uuid, boolean);
-- alter function public.save_patient_registration_unchecked_v1(uuid, uuid, jsonb)
--   rename to save_patient_registration;
-- alter function public.finish_patient_registration_unchecked_v1(uuid, uuid, boolean)
--   rename to finish_patient_registration;
-- alter function public.get_patient_registration_draft_unchecked_v1(uuid, uuid)
--   rename to get_patient_registration_draft;
-- alter function public.finish_walkin_patient_registration_unchecked_v1(uuid, uuid, uuid, boolean)
--   rename to finish_walkin_patient_registration;
-- revoke all on function public.save_patient_registration(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
-- grant execute on function public.save_patient_registration(uuid, uuid, jsonb) to authenticated, service_role;
-- revoke all on function public.finish_patient_registration(uuid, uuid, boolean) from public, anon, authenticated, service_role;
-- grant execute on function public.finish_patient_registration(uuid, uuid, boolean) to authenticated, service_role;
-- revoke all on function public.get_patient_registration_draft(uuid, uuid) from public, anon, authenticated, service_role;
-- grant execute on function public.get_patient_registration_draft(uuid, uuid) to authenticated, service_role;
-- revoke all on function public.finish_walkin_patient_registration(uuid, uuid, uuid, boolean) from public, anon, authenticated, service_role;
-- grant execute on function public.finish_walkin_patient_registration(uuid, uuid, uuid, boolean) to authenticated, service_role;
--
-- grant select, insert, update, delete on public.patients to authenticated;
-- create policy "Admins can update patient account access"
-- on public.patients for update to authenticated
-- using ((select public.is_current_admin()))
-- with check ((select public.is_current_admin()));
-- create policy "Allow patient deletes"
-- on public.patients for delete to authenticated using (true);
-- create policy "Allow patient inserts"
-- on public.patients for insert to authenticated with check (true);
-- create policy "Allow patient reads"
-- on public.patients for select to authenticated using (true);
-- create policy "Clinic users can insert patients"
-- on public.patients for insert to authenticated
-- with check (exists (select 1 from public.profiles
--   where profiles.id = auth.uid()
--     and lower(coalesce(profiles.role, '')) in ('admin', 'doctor', 'staff')));
-- create policy "Clinic users can read patients"
-- on public.patients for select to authenticated
-- using (exists (select 1 from public.profiles
--   where profiles.id = auth.uid()
--     and lower(coalesce(profiles.role, '')) in ('admin', 'doctor', 'staff')));
-- create policy "Clinic users can update patients"
-- on public.patients for update to authenticated
-- using (exists (select 1 from public.profiles
--   where profiles.id = auth.uid()
--     and lower(coalesce(profiles.role, '')) in ('admin', 'doctor', 'staff')))
-- with check (exists (select 1 from public.profiles
--   where profiles.id = auth.uid()
--     and lower(coalesce(profiles.role, '')) in ('admin', 'doctor', 'staff')));
-- create policy "Patients can read own patient record"
-- on public.patients for select to authenticated
-- using (user_id = auth.uid() and account_status = 'active'
--   and lower(trim(coalesce(status, ''))) not in ('archived', 'deleted'));
-- create policy "Patients can update own patient record"
-- on public.patients for update to authenticated
-- using (user_id = auth.uid() and account_status = 'active'
--   and lower(trim(coalesce(status, ''))) not in ('archived', 'deleted'))
-- with check (user_id = auth.uid() and account_status = 'active'
--   and lower(trim(coalesce(status, ''))) not in ('archived', 'deleted'));
-- notify pgrst, 'reload schema';
-- commit;
