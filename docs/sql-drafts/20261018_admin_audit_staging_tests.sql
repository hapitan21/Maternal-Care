-- OBSOLETE FIXTURE: targets the older proposal, NOT the verified staging implementation.
-- The original test body is retained for review. Use the current verification plan instead.
-- This transaction guard intentionally aborts before fixtures or audit RPCs execute.
begin;
do $superseded$ begin
  raise exception 'STOP: legacy test expects public internal writer/reported status; verified staging uses s4audit_private/event_origin. Review the current plan.';
end $superseded$;
-- NOT EXECUTED. PostgreSQL tests for ISOLATED STAGING after explicit approval.
-- psql variables: admin_id, doctor_id, staff_id, patient_id (Auth/profile UUIDs).
-- Existing dedicated synthetic active identities only; no device registrations.
-- All test writes are rolled back. Do not run against production.
begin;
select set_config('audit_test.admin', :'admin_id', true),
       set_config('audit_test.doctor', :'doctor_id', true),
       set_config('audit_test.staff', :'staff_id', true),
       set_config('audit_test.patient', :'patient_id', true),
       set_config('audit_test.request', pg_catalog.gen_random_uuid()::text, true);
do $fixtures$
declare v_role text; v_id uuid;
begin
  foreach v_role in array array['admin','doctor','staff','patient'] loop
    v_id:=current_setting('audit_test.'||v_role)::uuid;
    if not exists(select 1 from public.profiles where id=v_id and lower(role)=v_role and lower(account_status)='active') then
      raise exception 'Missing active synthetic % fixture',v_role;
    end if;
  end loop;
  if (select count(distinct current_setting('audit_test.'||roles.role_name)) from unnest(array['admin','doctor','staff','patient']) as roles(role_name))<>4 then
    raise exception 'Synthetic identities must be distinct';
  end if;
  if (select count(*) from public.patients where user_id=current_setting('audit_test.patient')::uuid and account_status='active' and archived_at is null)<>1 then
    raise exception 'Synthetic Patient must have exactly one active linked record';
  end if;
  if exists(select 1 from public.patient_native_push_devices where user_id=current_setting('audit_test.patient')::uuid) then
    raise exception 'Use a synthetic Patient with no native device registrations';
  end if;
  perform set_config('audit_test.patient_record',(select id::text from public.patients where user_id=current_setting('audit_test.patient')::uuid and account_status='active' and archived_at is null),true);
end;
$fixtures$;

set local role authenticated;
do $client_tests$
declare v_role text; v_id uuid; v_action text; v_module text; v_format text;
begin
  -- Missing authentication is denied even when SQL role has EXECUTE.
  perform set_config('request.jwt.claims','{}',true);
  begin
    perform public.record_audit_event('authentication','login','auth_user',null,'User logged in.');
    raise exception 'FAIL: missing authentication was accepted';
  exception when insufficient_privilege then null; end;

  foreach v_role in array array['admin','doctor','staff','patient'] loop
    v_id:=current_setting('audit_test.'||v_role)::uuid;
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_id,'role','authenticated')::text,true);
    if v_role <> 'admin' and exists(select 1 from public.audit_logs) then
      raise exception 'FAIL: % can read Admin audit rows',v_role;
    end if;
    foreach v_action in array array['login','logout'] loop
      perform public.record_audit_event('authentication',v_action,'auth_user',v_id::text,'Synthetic authentication report.','{}',current_setting('audit_test.request')::uuid);
    end loop;
    -- Every client role, including Admin, is denied business-success claims.
    foreach v_module in array array['visit_records','appointment_management','patient_management','system_settings','user_management','unknown'] loop
      begin
        perform public.record_audit_event(v_module,'complete','medical_record','synthetic-target','Synthetic forged claim.','{}',current_setting('audit_test.request')::uuid);
        raise exception 'FAIL: % forged %',v_role,v_module;
      exception when insufficient_privilege then null; end;
    end loop;
    begin
      perform public.record_audit_event('authentication','login','auth_user',pg_catalog.gen_random_uuid()::text,'Synthetic wrong actor.');
      raise exception 'FAIL: arbitrary authentication target';
    exception when insufficient_privilege then null; end;
    begin
      perform public.record_internal_audit_event('user_management','deactivate','staff_account',v_id::text,'Synthetic bypass.');
      raise exception 'FAIL: internal writer exposed';
    exception when insufficient_privilege then null; end;
    begin
      perform public.record_audit_event('authentication','login','auth_user',v_id::text,'Synthetic metadata.','{"token":"synthetic-never-real"}');
      raise exception 'FAIL: sensitive metadata accepted';
    exception when insufficient_privilege or invalid_parameter_value then null; end;
    begin
      perform public.record_audit_event('authentication','login','auth_user',v_id::text,'Bearer synthetic-never-real');
      raise exception 'FAIL: bearer description accepted';
    exception when invalid_parameter_value then null; end;
    if v_role <> 'admin' then
      begin
        perform public.record_audit_event('reports','export','report','appointment-summary-2026-10-01-to-2026-10-18','Synthetic export.','{"format":"pdf","report":"Appointment Summary Report"}');
        raise exception 'FAIL: non-Admin report accepted';
      exception when insufficient_privilege then null; end;
    end if;
  end loop;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('audit_test.admin'),'role','authenticated')::text,true);
  foreach v_format in array array['pdf','excel','print'] loop
    perform public.record_audit_event('reports',case when v_format='print' then 'print' else 'export' end,
      'report','appointment-summary-2026-10-01-to-2026-10-18','Synthetic report.',
      jsonb_build_object('format',v_format,'report','Appointment Summary Report'),current_setting('audit_test.request')::uuid);
  end loop;
  begin
    perform public.record_audit_event('reports','export','report','arbitrary-target','Synthetic report.','{"format":"pdf","report":"Appointment Summary Report"}');
    raise exception 'FAIL: arbitrary report target accepted';
  exception when insufficient_privilege then null; end;
end;
$client_tests$;
reset role;

do $receipt_tests$
begin
  if (select count(*) from public.audit_logs where request_id=current_setting('audit_test.request')::uuid)<>11
     or exists(select 1 from public.audit_logs where request_id=current_setting('audit_test.request')::uuid and (status<>'reported' or metadata->>'event_source' is distinct from 'client_reported')) then
    raise exception 'FAIL: expected exactly 11 low-trust reports and no fabricated success';
  end if;
end;
$receipt_tests$;

set local role authenticated;
do $business_tests$
declare v_action text; v_before bigint; v_role text;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('audit_test.admin'),'role','authenticated')::text,true);
  select count(*) into v_before from public.audit_logs;
  begin
    perform public.admin_set_doctor_account_status(current_setting('audit_test.doctor')::uuid,'deactivate');
    raise exception 'Synthetic rollback' using errcode='ZX001';
  exception when sqlstate 'ZX001' then null; end;
  if (select count(*) from public.audit_logs)<>v_before then raise exception 'FAIL: rolled-back operation left an audit event'; end if;
  begin
    perform public.admin_set_doctor_account_status(current_setting('audit_test.doctor')::uuid,'unsupported');
    raise exception 'FAIL: unsupported transition accepted';
  exception when invalid_parameter_value then null; end;
  if (select count(*) from public.audit_logs)<>v_before then raise exception 'FAIL: rejected operation left an audit event'; end if;
  foreach v_action in array array['deactivate','reactivate'] loop
    perform public.admin_set_doctor_account_status(current_setting('audit_test.doctor')::uuid,v_action);
    perform public.admin_set_staff_account_status(current_setting('audit_test.staff')::uuid,v_action);
    perform public.admin_set_patient_account_status(current_setting('audit_test.patient_record')::uuid,v_action);
    if v_action='deactivate' then
      foreach v_role in array array['doctor','staff','patient'] loop
        perform set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('audit_test.'||v_role),'role','authenticated')::text,true);
        begin
          perform public.record_audit_event('authentication','login','auth_user',null,'Synthetic inactive login.');
          raise exception 'FAIL: inactive % reported an event',v_role;
        exception when insufficient_privilege then null; end;
      end loop;
      perform set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('audit_test.admin'),'role','authenticated')::text,true);
    end if;
  end loop;
  if (select count(*) from public.audit_logs)<>v_before+6 then raise exception 'FAIL: expected six authoritative status events'; end if;
end;
$business_tests$;
reset role;

do $final_receipts$
begin
  if (select count(*) from public.audit_logs where actor_user_id=current_setting('audit_test.admin')::uuid
      and created_at>=transaction_timestamp() and module='user_management' and status='success'
      and metadata->>'event_source'='server_transaction')<>6 then
    raise exception 'FAIL: authoritative receipts missing';
  end if;
end;
$final_receipts$;

set local role anon;
do $anonymous$
begin
  perform set_config('request.jwt.claims','{}',true);
  begin
    perform public.record_audit_event('authentication','login','auth_user',null,'Synthetic anonymous claim.');
    raise exception 'FAIL: anonymous execution accepted';
  exception when insufficient_privilege then null; end;
end;
$anonymous$;
reset role;
select 'All staging assertions passed; rolling back every test write.' as result;
rollback;
