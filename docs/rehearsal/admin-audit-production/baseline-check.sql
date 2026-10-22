\ir guard.sql
do $baseline$
declare b record; p pg_proc%rowtype;
begin
  if to_regprocedure('public.record_internal_audit_event(text,text,text,text,text,jsonb,uuid,text)') is not null
    or rehearsal_control.catalog_signature() is distinct from (select signature from rehearsal_control.catalog_before)
    or (select jsonb_agg(to_jsonb(a) order by id) from public.audit_logs a) is distinct from
       (select jsonb_agg(to_jsonb(h) order by id) from rehearsal_control.history h) then
    raise exception 'FAIL: baseline/history/catalog not restored';
  end if;
  for b in select * from rehearsal_control.functions_before loop
    select * into strict p from pg_proc where oid=b.oid;
    if p.prosrc<>b.prosrc or p.proacl is distinct from b.proacl or p.proowner<>b.proowner
      or p.prosecdef<>b.prosecdef or p.proconfig is distinct from b.proconfig then
      raise exception 'FAIL: baseline function not restored %',b.proname;
    end if;
  end loop;
  if (select count(*) from pg_constraint where conrelid='public.audit_logs'::regclass)<>6
    or exists(select 1 from rehearsal_control.constraints_before saved_constraint where not exists(
      select 1 from pg_constraint c where c.conrelid='public.audit_logs'::regclass and c.conname=saved_constraint.conname
        and c.convalidated=saved_constraint.convalidated and pg_get_constraintdef(c.oid)=saved_constraint.definition)) then
    raise exception 'FAIL: baseline constraints not restored';
  end if;
end $baseline$;
select 'PASS: exact synthetic baseline restored; no migrated writer or reported history' as result;
