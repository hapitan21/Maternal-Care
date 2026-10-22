\ir guard.sql
-- Runner provides the transaction. Every test write is rolled back.
set local role anon;
do $anon$ begin
  begin
    perform public.record_audit_event('authentication','login','auth_user',null,'Synthetic login.');
    raise exception 'FAIL: anonymous audit RPC';
  exception when insufficient_privilege then null; end;
end $anon$;
reset role;
set local role authenticated;
do $claims$
declare actor uuid; module_name text; format_name text; report_title text; prefix text; rid uuid;
begin
  perform set_config('request.jwt.claims','{}',true);
  begin
    perform public.record_audit_event('authentication','login','auth_user',null,'Synthetic missing user.');
    raise exception 'FAIL: missing user';
  exception when insufficient_privilege then null; end;
  foreach actor in array array[
    '11111111-1111-4111-8111-111111111111'::uuid,'22222222-2222-4222-8222-222222222222'::uuid,
    '33333333-3333-4333-8333-333333333333'::uuid,'44444444-4444-4444-8444-444444444444'::uuid] loop
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
    if actor<>'11111111-1111-4111-8111-111111111111'::uuid and exists(select 1 from public.audit_logs) then
      raise exception 'FAIL: non-Admin audit SELECT';
    end if;
    rid:=public.record_audit_event('authentication','login','auth_user',actor::text,'Synthetic login.');
    if rid is null then raise exception 'FAIL: UUID receipt'; end if;
    -- Existing logout caller omits the target UUID.
    perform public.record_audit_event('authentication','logout','auth_user',null,'Synthetic logout.');
    foreach module_name in array array['visit_records','appointment_management','patient_management','system_settings','user_management'] loop
      begin
        perform public.record_audit_event(module_name,'complete','synthetic_target','synthetic','Synthetic forged success.');
        raise exception 'FAIL: forged business claim %',module_name;
      exception when insufficient_privilege then null; end;
    end loop;
    begin
      perform public.record_internal_audit_event('user_management','deactivate','staff_account',actor::text,'Synthetic bypass.');
      raise exception 'FAIL: direct internal writer';
    exception when insufficient_privilege then null; end;
    begin
      perform public.record_audit_event('authentication','login','auth_user','99999999-9999-4999-8999-999999999999','Synthetic wrong target.');
      raise exception 'FAIL: foreign actor';
    exception when insufficient_privilege then null; end;
    begin
      perform public.record_audit_event('authentication','login','auth_user',actor::text,'Synthetic metadata.','{"token":"synthetic-token"}');
      raise exception 'FAIL: sensitive metadata';
    exception when insufficient_privilege or invalid_parameter_value then null; end;
    begin
      perform public.record_audit_event('authentication','login','auth_user',actor::text,'Bearer synthetic-token');
      raise exception 'FAIL: sensitive original description';
    exception when invalid_parameter_value then null; end;
    begin
      insert into public.audit_logs(module,action,description) values('reports','export','Synthetic forbidden direct write.');
      raise exception 'FAIL: direct INSERT';
    exception when insufficient_privilege then null; end;
    begin
      update public.audit_logs set description='Synthetic forbidden update.';
      raise exception 'FAIL: direct UPDATE';
    exception when insufficient_privilege then null; end;
    begin delete from public.audit_logs; raise exception 'FAIL: direct DELETE';
    exception when insufficient_privilege then null; end;
    begin truncate public.audit_logs; raise exception 'FAIL: direct TRUNCATE';
    exception when insufficient_privilege then null; end;
    if actor<>'11111111-1111-4111-8111-111111111111'::uuid then
      begin
        perform public.record_audit_event('reports','export','report','appointment-summary-2026-10-01-to-2026-10-18','Synthetic export.','{"format":"pdf","report":"Appointment Summary Report"}');
        raise exception 'FAIL: non-Admin report';
      exception when insufficient_privilege then null; end;
      begin
        perform public.admin_set_staff_account_status('33333333-3333-4333-8333-333333333333','deactivate');
        raise exception 'FAIL: non-Admin status RPC';
      exception when insufficient_privilege then null; end;
    end if;
  end loop;
  perform set_config('request.jwt.claims','{"sub":"66666666-6666-4666-8666-666666666666","role":"authenticated"}',true);
  begin
    perform public.record_audit_event('authentication','login','auth_user',null,'Synthetic inactive.');
    raise exception 'FAIL: inactive user';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
  foreach report_title in array array['Appointment Summary Report','Patient Summary Report','Registration & Appointment Trends'] loop
    prefix:=case report_title when 'Appointment Summary Report' then 'appointment-summary'
      when 'Patient Summary Report' then 'patient-summary' else 'registration-appointment-trends' end;
    foreach format_name in array array['pdf','excel','print'] loop
      perform public.record_audit_event('reports',case when format_name='print' then 'print' else 'export' end,
        'report',prefix||'-2026-10-01-to-2026-10-18','Synthetic report.',jsonb_build_object('format',format_name,'report',report_title));
    end loop;
  end loop;
  begin
    perform public.record_audit_event('reports','export','report','arbitrary','Synthetic forged report.','{"format":"pdf","report":"Appointment Summary Report"}');
    raise exception 'FAIL: arbitrary report target';
  exception when insufficient_privilege then null; end;
end $claims$;
reset role;
do $receipts$ begin
  if (select count(*) from public.audit_logs where status='reported')<>17
    or exists(select 1 from public.audit_logs where status='reported'
      and (metadata->>'event_source' is distinct from 'client_reported' or actor_user_id is null))
    or exists(select 1 from public.audit_logs where status='reported' and module='authentication'
      and (entity_id is distinct from actor_user_id::text or entity_type is distinct from 'auth_user'))
    or exists(select 1 from public.profiles p where p.account_status='active'
      and (select count(*) from public.audit_logs a where a.status='reported' and a.module='authentication' and a.actor_user_id=p.id)<>2)
    or (select count(*) from public.audit_logs)<>19 then
    raise exception 'FAIL: expected exactly 17 client receipts and two unchanged historical rows';
  end if;
end $receipts$;
set local role service_role;
do $service$ begin
  begin
    perform public.record_internal_audit_event('user_management','deactivate','staff_account',null,'Synthetic bypass.');
    raise exception 'FAIL: service role internal writer';
  exception when insufficient_privilege then null; end;
end $service$;
reset role;
set local role authenticated;
do $status$
declare kind text; target uuid; action_name text; result jsonb; before_count bigint; expected_status text;
begin
  perform set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
  foreach kind in array array['patient','doctor','staff'] loop
    target:=case kind when 'patient' then '55555555-5555-4555-8555-555555555555'::uuid
      when 'doctor' then '22222222-2222-4222-8222-222222222222'::uuid else '33333333-3333-4333-8333-333333333333'::uuid end;
    foreach action_name in array array['deactivate','reactivate'] loop
      expected_status:=case when action_name='deactivate' then 'inactive' else 'active' end;
      select count(*) into before_count from public.audit_logs;
      execute format('select public.admin_set_%s_account_status($1,$2)',kind) into result using target,action_name;
      if result->>'action'<>action_name or result->>'account_status'<>expected_status then raise exception 'FAIL: RPC response'; end if;
      if (select count(*) from public.audit_logs)<>before_count+1 or not exists(select 1 from public.audit_logs
        where module='user_management' and action=action_name and entity_type=kind||'_account' and entity_id=target::text
          and status='success' and metadata->>'event_source'='server_transaction'
          and metadata->>'previous_status'=case when action_name='deactivate' then 'active' else 'inactive' end
          and metadata->>'new_status'=result->>'account_status' and actor_user_id=auth.uid() and actor_role='admin') then
        raise exception 'FAIL: authoritative status receipt % %',kind,action_name;
      end if;
      begin
        execute format('select public.admin_set_%s_account_status($1,$2)',kind) using target,action_name;
        raise exception 'FAIL: duplicate/no-op transition';
      exception when invalid_parameter_value then null; end;
      if (select count(*) from public.audit_logs)<>before_count+1 then raise exception 'FAIL: rejected transition audited'; end if;
    end loop;
    select count(*) into before_count from public.audit_logs;
    -- A controlled subtransaction exception rolls back both status writes and the audit insert.
    begin
      execute format('select public.admin_set_%s_account_status($1,$2)',kind) using target,'deactivate';
      raise exception 'Synthetic outer failure' using errcode='ZX001';
    exception when sqlstate 'ZX001' then null; end;
    if (select count(*) from public.audit_logs)<>before_count then
      raise exception 'FAIL: outer rollback %',kind;
    end if;
  end loop;
end $status$;
reset role;
do $state_after_rollback$ begin
  if exists(select 1 from public.profiles where id in
    ('22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444')
    and account_status is distinct from 'active')
    or (select account_status from public.patients where id='55555555-5555-4555-8555-555555555555') is distinct from 'active'
    or (select count(*) from rehearsal_control.broadcast_trace)<>(select count(*) from public.audit_logs)
    or exists(select 1 from rehearsal_control.broadcast_trace where topic<>'admin:audit-logs' or event<>'audit_log_changed' or not is_private) then
    raise exception 'FAIL: status or transactional Broadcast trace after outer rollback';
  end if;
end $state_after_rollback$;
-- Force failure at the audit INSERT after the business UPDATE. No writer guards are bypassed.
alter table public.audit_logs add constraint rehearsal_reject_success check(status<>'success') not valid;
do $audit_failure$
declare kind text; target uuid; profile_id uuid; n bigint; trace_count bigint;
begin
  foreach kind in array array['patient','doctor','staff'] loop
    target:=case kind when 'patient' then '55555555-5555-4555-8555-555555555555'::uuid
      when 'doctor' then '22222222-2222-4222-8222-222222222222'::uuid else '33333333-3333-4333-8333-333333333333'::uuid end;
    profile_id:=case when kind='patient' then '44444444-4444-4444-8444-444444444444'::uuid else target end;
    select count(*) into n from public.audit_logs;
    select count(*) into trace_count from rehearsal_control.broadcast_trace;
    begin
      execute format('select public.admin_set_%s_account_status($1,$2)',kind) using target,'deactivate';
      raise exception 'FAIL: audit failure swallowed';
    exception when check_violation then null; end;
    if (select count(*) from public.audit_logs)<>n or (select account_status from public.profiles where id=profile_id)<>'active'
      or (select count(*) from rehearsal_control.broadcast_trace)<>trace_count
      or (select account_status from public.patients where id='55555555-5555-4555-8555-555555555555')<>'active' then
      raise exception 'FAIL: audit INSERT failure failed to roll back %',kind;
    end if;
  end loop;
  if (select count(*) from public.audit_logs where status='success' and metadata->>'event_source'='server_transaction')<>6 then
    raise exception 'FAIL: six status successes expected';
  end if;
end $audit_failure$;
alter table public.audit_logs drop constraint rehearsal_reject_success;
select 'PASS: role simulation, claims, receipts, six status changes, rejection and rollback; all writes pending rollback' as result;
