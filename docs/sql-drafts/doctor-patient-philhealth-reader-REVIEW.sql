-- PROPOSAL ONLY. NOT APPROVED FOR INSTALLATION OR EXECUTION.
-- New selected-patient reader; does not replace the existing directory RPC.
-- Authorization scope and deployment prerequisites need approval: see
-- docs/doctor-patient-philhealth-reader-review.md.
-- This unconditional gate and final ROLLBACK intentionally prevent installation.
begin;

do $review_gate$
begin
  raise exception 'REVIEW ONLY: PhilHealth reader installation is not authorized.';
end;
$review_gate$;

-- No OR REPLACE: a conflicting installed function must be investigated.
-- Required existing columns (verify installed types, constraints and RLS first):
-- profiles(id uuid, role text, account_status text)
-- patients(id uuid, philhealth_member boolean, philhealth_pin text)
-- schedule(patient_id uuid, doctor_id uuid, status text)
create function public.get_doctor_patient_philhealth_status(p_patient_id uuid)
returns table (
  philhealth_member boolean,
  philhealth_pin_recorded boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid := auth.uid();
begin
  if v_actor_id is null or not exists (
    select 1
    from public.profiles as profile
    where profile.id = v_actor_id
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''))) = 'doctor'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''))) = 'active'
  ) then
    raise exception 'Clinical access is not authorized.' using errcode = '42501';
  end if;

  if p_patient_id is null then
    raise exception 'A selected patient is required.' using errcode = '22023';
  end if;

  return query
  select
    patient.philhealth_member,
    coalesce(patient.philhealth_pin ~ '[^[:space:]]', false)
  from public.patients as patient
  where patient.id = p_patient_id
    and exists (
      select 1
      from public.schedule as appointment
      where appointment.patient_id = patient.id
        and appointment.doctor_id = v_actor_id
        -- PROPOSED allowlist: approve against installed appointment semantics.
        -- Unknown, cancelled and missed/no-show states fail closed.
        and pg_catalog.regexp_replace(
          pg_catalog.lower(pg_catalog.btrim(coalesce(appointment.status, ''))),
          '[[:space:]-]+', '_', 'g'
        ) in ('pending', 'scheduled', 'checked_in', 'ready_for_doctor', 'completed')
    );

  if not found then
    -- Do not disclose whether an unrelated patient exists.
    raise exception 'Clinical access is not authorized.' using errcode = '42501';
  end if;
end;
$function$;

-- Proposed NEW-function ACL only. No table, schema, existing-function or RLS changes.
-- Trusted owner and role graph must be verified before any separate installation.
alter function public.get_doctor_patient_philhealth_status(uuid) owner to postgres;
revoke all on function public.get_doctor_patient_philhealth_status(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_doctor_patient_philhealth_status(uuid)
  to authenticated;

-- Proposed fail-closed checks, within the same transaction as creation and ACLs.
-- These do not replace the role-membership/SET ROLE and authorization tests.
do $postflight$
declare
  v_function oid := pg_catalog.to_regprocedure('public.get_doctor_patient_philhealth_status(uuid)');
begin
  if v_function is null or not exists (
    select 1 from pg_catalog.pg_proc as procedure
    where procedure.oid = v_function
      and procedure.prosecdef
      and procedure.provolatile = 's'
      and procedure.proowner = 'postgres'::pg_catalog.regrole
      and procedure.proconfig = array['search_path=""']::text[]
      and procedure.proretset
      and procedure.proargnames = array[
        'p_patient_id', 'philhealth_member', 'philhealth_pin_recorded'
      ]::text[]
      and procedure.proallargtypes = array[
        'uuid'::pg_catalog.regtype::oid,
        'boolean'::pg_catalog.regtype::oid,
        'boolean'::pg_catalog.regtype::oid
      ]
  ) then
    raise exception 'PhilHealth reader configuration is unexpected.';
  end if;

  if not pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
    or pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
    or pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE')
    or exists (
      select 1
      from pg_catalog.pg_proc as procedure,
        lateral pg_catalog.aclexplode(coalesce(
          procedure.proacl, pg_catalog.acldefault('f', procedure.proowner)
        )) as privilege
      where procedure.oid = v_function and privilege.grantee = 0
        and privilege.privilege_type = 'EXECUTE'
    ) then
    raise exception 'PhilHealth reader execution boundary is unexpected.';
  end if;
end;
$postflight$;

-- Intentionally NOT a deployable installation artifact.
rollback;
