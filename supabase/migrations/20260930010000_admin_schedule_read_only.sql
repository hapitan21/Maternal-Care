-- Admin schedule read-only authorization.
-- Targets the verified live split schedule policies, not the historical ALL
-- policy in the manual setup scripts. SELECT, table grants, and triggers stay
-- unchanged. Apply manually after review; this file does not deploy itself.
begin;

do $preflight$
begin
  if not exists (
    select 1 from pg_catalog.pg_class
    where oid = pg_catalog.to_regclass('public.schedule')
      and relrowsecurity
  ) then
    raise exception 'Admin schedule hardening requires schedule RLS to be enabled.';
  end if;

  -- An additional permissive ALL/mutation policy could still admit Admin.
  -- Abort on drift rather than remove an unreviewed policy or change SELECT.
  if exists (
    select 1 from pg_catalog.pg_policy
    where polrelid = 'public.schedule'::pg_catalog.regclass
      and polcmd <> 'r'
      and not (
        polname = 'Clinic users can insert schedule' and polcmd = 'a'
        or polname = 'Clinic users can update schedule' and polcmd = 'w'
        or polname = 'Clinic users can delete schedule' and polcmd = 'd'
      )
  ) or (
    select pg_catalog.count(*) from pg_catalog.pg_policy
    where polrelid = 'public.schedule'::pg_catalog.regclass
      and polcmd <> 'r'
  ) <> 3 then
    raise exception 'Unexpected schedule mutation policies; review the live catalog before applying.';
  end if;

  if exists (
    select 1 from pg_catalog.pg_policy
    where polrelid = 'public.schedule'::pg_catalog.regclass
      and polcmd <> 'r'
      and (
        not polpermissive
        or polroles <> array['authenticated'::pg_catalog.regrole::oid]
      )
  ) then
    raise exception 'Expected permissive schedule mutation policies targeting authenticated only.';
  end if;

  if pg_catalog.to_regprocedure('public.is_active_schedule_operator()') is not null then
    raise exception 'is_active_schedule_operator already exists; review before replacing it.';
  end if;
end;
$preflight$;

-- SECURITY DEFINER makes this fixed auth.uid()-based lookup independent of
-- profiles RLS. No caller-supplied identity or role is accepted.
create function public.is_active_schedule_operator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text)))
          in ('doctor', 'staff')
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text)))
          = 'active'
  );
$function$;

revoke all on function public.is_active_schedule_operator() from public, anon;
grant execute on function public.is_active_schedule_operator() to authenticated;

drop policy if exists "Clinic users can insert schedule" on public.schedule;
create policy "Clinic users can insert schedule"
on public.schedule for insert to authenticated
with check ((select public.is_active_schedule_operator()));

drop policy if exists "Clinic users can update schedule" on public.schedule;
create policy "Clinic users can update schedule"
on public.schedule for update to authenticated
using ((select public.is_active_schedule_operator()))
with check ((select public.is_active_schedule_operator()));

drop policy if exists "Clinic users can delete schedule" on public.schedule;
create policy "Clinic users can delete schedule"
on public.schedule for delete to authenticated
using ((select public.is_active_schedule_operator()));

-- Preserve the DEPLOYED RPC bodies, including manual walk-in hardening and
-- any subsequent workflow fixes. Replace only the known role predicate and
-- its denial text, never reconstruct the workflow from an older migration.
-- pg_get_functiondef emits CREATE OR REPLACE: signatures, defaults, return
-- types, settings, ownership, and existing EXECUTE ACLs are retained.
-- Unknown definitions fail atomically; no partially applied hardening.
do $harden_rpcs$
declare
  v_target record;
  v_function record;
  v_oid oid;
  v_pattern text;
  v_body text;
  v_definition text;
  v_matches bigint;
begin
  for v_target in
    select * from (values
      (
        'public.accept_patient_appointment_request(bigint,uuid)',
        'accept_patient_appointment_request',
        $roles$'staff'[[:space:]]*,[[:space:]]*'admin'$roles$,
        $roles$('staff')$roles$,
        'Only active Staff or Admin users can approve appointment requests.',
        'Only active Staff users can approve appointment requests.'
      ),
      (
        'public.decline_patient_appointment_request(bigint)',
        'decline_patient_appointment_request',
        $roles$'staff'[[:space:]]*,[[:space:]]*'admin'$roles$,
        $roles$('staff')$roles$,
        'Only active Staff or Admin users can decline appointment requests.',
        'Only active Staff users can decline appointment requests.'
      ),
      (
        'public.finish_walkin_patient_registration(uuid,uuid,uuid,boolean)',
        'finish_walkin_patient_registration',
        $roles$'staff'[[:space:]]*,[[:space:]]*'admin'$roles$,
        $roles$('staff')$roles$,
        'Only active Staff or Admin users can finish walk-in registration.',
        'Only active Staff users can finish walk-in registration.'
      ),
      (
        'public.reschedule_appointment(uuid,timestamptz,timestamptz,text,boolean,uuid,text,uuid,text,text)',
        'reschedule_appointment',
        $roles$'doctor'[[:space:]]*,[[:space:]]*'staff'[[:space:]]*,[[:space:]]*'admin'$roles$,
        $roles$('doctor', 'staff')$roles$,
        'Only an active Doctor, Staff member, or Admin can reschedule appointments.',
        'Only an active Doctor or Staff member can reschedule appointments.'
      )
    ) as targets(signature, function_name, old_roles, new_roles, old_message, new_message)
  loop
    v_oid := pg_catalog.to_regprocedure(v_target.signature);
    if v_oid is null or (
      select pg_catalog.count(*) from pg_catalog.pg_proc as p
      join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_target.function_name
    ) <> 1 then
      raise exception 'Missing or unexpected overload for %; review the live definition.', v_target.signature;
    end if;

    select p.*, l.lanname into v_function
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_language as l on l.oid = p.prolang
    where p.oid = v_oid;

    if v_function.lanname <> 'plpgsql'
      or not v_function.prosecdef
      or not coalesce(v_function.proconfig @> array['search_path=""'], false)
      or not pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
      or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE') then
      raise exception 'Unexpected security settings or EXECUTE grants for %.', v_target.signature;
    end if;

    -- Match the complete known profile.role predicate, allowing whitespace
    -- and the optional ::text used by the hardened walk-in facade.
    v_pattern := $pattern$(pg_catalog\.lower\([[:space:]]*pg_catalog\.btrim\([[:space:]]*coalesce\(profile\.role,[[:space:]]*''(::text)?\)[[:space:]]*\)[[:space:]]*\)[[:space:]]+in[[:space:]]*)\([[:space:]]*$pattern$
      || v_target.old_roles || $pattern$[[:space:]]*\)$pattern$;

    select pg_catalog.count(*) into v_matches
    from pg_catalog.regexp_matches(v_function.prosrc, v_pattern, 'g');

    if v_matches <> 1
      or pg_catalog.strpos(v_function.prosrc, v_target.old_message) = 0
      or pg_catalog.strpos(v_function.prosrc, 'auth.uid()') = 0
      or pg_catalog.strpos(v_function.prosrc, 'profile.account_status') = 0 then
      raise exception 'Expected one known active-role authorization block in %; review drift.', v_target.signature;
    end if;

    v_body := pg_catalog.regexp_replace(
      v_function.prosrc, v_pattern, E'\\1' || v_target.new_roles
    );
    v_body := pg_catalog.replace(v_body, v_target.old_message, v_target.new_message);
    v_definition := pg_catalog.pg_get_functiondef(v_oid);
    execute pg_catalog.replace(v_definition, v_function.prosrc, v_body);

    -- CREATE OR REPLACE must retain the same function object and grants.
    if not exists (
      select 1 from pg_catalog.pg_proc as p
      where p.oid = v_oid
        and p.prosrc = v_body
        and p.proowner = v_function.proowner
        and p.proacl is not distinct from v_function.proacl
        and p.proconfig is not distinct from v_function.proconfig
        and p.prosecdef = v_function.prosecdef
    ) then
      raise exception 'RPC metadata preservation failed for %.', v_target.signature;
    end if;
  end loop;

  -- The public walk-in facade delegates to this private implementation.
  -- It must not remain a browser-callable route around the Staff-only guard.
  -- Inspect only: its body/ACL and all registration behavior stay unchanged.
  v_oid := pg_catalog.to_regprocedure(
    'public.finish_walkin_patient_registration_unchecked_v1(uuid,uuid,uuid,boolean)'
  );
  if v_oid is null
    or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
    or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE') then
    raise exception 'Expected private walk-in implementation; review its live EXECUTE grants.';
  end if;
end;
$harden_rpcs$;

notify pgrst, 'reload schema';
commit;
