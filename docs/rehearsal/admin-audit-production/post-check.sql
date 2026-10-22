\ir guard.sql
-- Inspection assertions only; run as postgres after applying or within the rollback trial.
do $catalog$
declare b record; p pg_proc%rowtype; expected text;
begin
  if rehearsal_control.catalog_signature() is distinct from
      (select signature from rehearsal_control.catalog_before) then
    raise exception 'FAIL: audit columns, RLS, grants, policy or trigger changed';
  end if;
  if (select jsonb_agg(to_jsonb(a) order by id) from public.audit_logs a where id in
      (select id from rehearsal_control.history)) is distinct from
      (select jsonb_agg(to_jsonb(h) order by id) from rehearsal_control.history h) then
    raise exception 'FAIL: historical audit records changed';
  end if;
  if (select count(*) from pg_constraint where conrelid='public.audit_logs'::regclass)<>6 then
    raise exception 'FAIL: constraint count';
  end if;
  for b in select * from rehearsal_control.constraints_before loop
    expected:=case when b.conname='audit_logs_content_check' then replace(b.definition,
      'ARRAY[''success''::text, ''failure''::text, ''rejected''::text]',
      'ARRAY[''success''::text, ''failure''::text, ''rejected''::text, ''reported''::text]') else b.definition end;
    if not exists(select 1 from pg_constraint c where c.conrelid='public.audit_logs'::regclass
      and c.conname=b.conname and c.convalidated and pg_get_constraintdef(c.oid)=expected) then
      raise exception 'FAIL: constraint preservation %',b.conname;
    end if;
  end loop;
  for b in select * from rehearsal_control.functions_before loop
    select * into strict p from pg_proc where oid=b.oid;
    if p.proowner<>b.proowner or p.prosecdef<>b.prosecdef or p.proconfig is distinct from b.proconfig
      or pg_get_expr(p.proargdefaults,0) is distinct from b.defaults_expression
      or p.proargnames is distinct from b.proargnames or p.pronargdefaults<>b.pronargdefaults
      or p.proargtypes<>b.proargtypes or p.prorettype<>b.prorettype then
      raise exception 'FAIL: RPC API/security changed %',b.proname;
    end if;
    if b.proname like 'admin_set_%' and (p.proacl is distinct from b.proacl
      or p.prosrc<>replace(b.prosrc,'public.record_audit_event(','public.record_internal_audit_event(')) then
      raise exception 'FAIL: Admin business body/grants changed %',b.proname;
    end if;
  end loop;
  if exists(select 1 from pg_roles r where r.rolname in ('anon','authenticated','service_role')
    and has_function_privilege(r.oid,'public.record_internal_audit_event(text,text,text,text,text,jsonb,uuid,text)','EXECUTE')) then
    raise exception 'FAIL: internal writer exposed';
  end if;
  if has_function_privilege('anon','public.record_audit_event(text,text,text,text,text,jsonb,uuid)','EXECUTE')
    or not has_function_privilege('authenticated','public.record_audit_event(text,text,text,text,text,jsonb,uuid)','EXECUTE') then
    raise exception 'FAIL: public RPC grants';
  end if;
  if not exists(select 1 from pg_proc where oid='public.record_internal_audit_event(text,text,text,text,text,jsonb,uuid,text)'::regprocedure
    and prosecdef and pg_get_userbyid(proowner)='postgres' and proconfig @> array['search_path=""']) then
    raise exception 'FAIL: internal writer ownership/security';
  end if;
end $catalog$;
select 'PASS: migrated catalog, history, API and writer permissions' as result;
