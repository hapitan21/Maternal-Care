-- PRODUCTION-ONLY CANDIDATE. NOT EXECUTED. NOT APPROVED FOR APPLICATION.
-- Original production: 15 columns, metadata source, existing Broadcast trigger.
-- Rehearse only on a separately approved clone matching PRODUCTION, never verified staging.
-- Body hashes below remain the original repository guards. Installed production bodies,
-- ACLs and CHECK must be reviewed first; a mismatch is a STOP, not permission to relax guards.
-- No staging writer, event_origin column, Realtime policy or migration is changed.
-- Preserves public signature, RLS, historical rows and business RPC bodies.
-- Exact body hashes are repository baselines (LF line endings), not assumed production facts.
-- October 18 continuation: user supplied direct production MATCH results for all four.
-- Require matching columns/types and all six validated constraints as well as the hashes.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
declare v record; f pg_catalog.pg_proc%rowtype;
begin
  if current_user <> 'postgres' then
    raise exception 'Apply only as the reviewed postgres migration owner.';
  end if;
  if pg_catalog.to_regclass('public.audit_logs') is null then raise exception 'audit_logs missing'; end if;

  -- Production-only shape. Do not weaken this to accept the verified staging schema.
  if (select count(*) from pg_catalog.pg_attribute
      where attrelid='public.audit_logs'::regclass and attnum>0 and not attisdropped) <> 15
     or exists(select 1 from pg_catalog.pg_attribute where attrelid='public.audit_logs'::regclass
       and attname='event_origin' and attnum>0 and not attisdropped)
     or pg_catalog.to_regnamespace('s4audit_private') is not null then
    raise exception 'Not the reviewed 15-column production baseline. Never apply to Maternal-Care-Staging.';
  end if;
  for v in select * from (values
    ('id','uuid'),('actor_user_id','uuid'),('actor_name','text'),('actor_role','text'),
    ('module','text'),('action','text'),('status','text'),('entity_type','text'),
    ('entity_id','text'),('description','text'),('metadata','jsonb'),('ip_address','inet'),
    ('user_agent','text'),('request_id','uuid'),('created_at','timestamptz')
  ) as expected(column_name,udt_name) loop
    if not exists(select 1 from information_schema.columns c
      where c.table_schema='public' and c.table_name='audit_logs'
        and c.column_name=v.column_name and c.udt_name=v.udt_name) then
      raise exception 'Production audit column/type mismatch: %',v.column_name;
    end if;
  end loop;
  if (select count(*) from pg_catalog.pg_constraint
      where conrelid='public.audit_logs'::regclass) <> 6
     or exists(select 1 from pg_catalog.pg_constraint
       where conrelid='public.audit_logs'::regclass and not convalidated) then
    raise exception 'Expected exactly six validated production audit constraints.';
  end if;
  if not exists(select 1 from pg_catalog.pg_trigger
      where tgrelid='public.audit_logs'::regclass and not tgisinternal and tgenabled in ('O','A')
        and tgname='broadcast_admin_audit_log_change_trigger') then
    raise exception 'Expected production audit Broadcast trigger missing; review installed definitions.';
  end if;
  if exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='record_internal_audit_event') then
    raise exception 'Internal writer already exists; do not overwrite it.';
  end if;
  if not (select relrowsecurity from pg_catalog.pg_class where oid='public.audit_logs'::regclass)
     or pg_catalog.has_table_privilege('authenticated','public.audit_logs','INSERT,UPDATE,DELETE,TRUNCATE')
     or pg_catalog.has_any_column_privilege('authenticated','public.audit_logs','INSERT,UPDATE')
     or pg_catalog.has_table_privilege('anon','public.audit_logs','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     or pg_catalog.has_any_column_privilege('anon','public.audit_logs','SELECT,INSERT,UPDATE') then
    raise exception 'Audit RLS/browser privileges differ from the reviewed baseline.';
  end if;
  if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='record_audit_event') <> 1 then
    raise exception 'Unexpected audit RPC overloads; review before proceeding.';
  end if;
  for v in select * from (values
    ('public.record_audit_event(text,text,text,text,text,jsonb,uuid)', 'a8589348a66eaf55796e3d217d98b29a'),
    ('public.admin_set_patient_account_status(uuid,text)', '644d99b03aeb2da0b4d4c8a7016aaf53'),
    ('public.admin_set_doctor_account_status(uuid,text)', 'c255a40c685ac48f61ddb9f2fea666dc'),
    ('public.admin_set_staff_account_status(uuid,text)', 'bd7fac0ad786a9d5f55c9751f27806a4')
  ) as expected(signature, body_md5) loop
    select * into f from pg_catalog.pg_proc where oid=pg_catalog.to_regprocedure(v.signature);
    if not found or pg_catalog.pg_get_userbyid(f.proowner) <> 'postgres' or not f.prosecdef
       or not coalesce(f.proconfig @> array['search_path=""'],false)
       or pg_catalog.md5(pg_catalog.replace(f.prosrc,E'\r\n',E'\n')) <> v.body_md5 then
      raise exception 'Definition mismatch: %. Compare installed production definitions; do not bypass this guard.',v.signature;
    end if;
  end loop;
end;
$preflight$;

-- Expand only the status list in the installed CHECK; preserve every other check verbatim.
do $outcome$
declare v_check text; v_old text := 'ARRAY[''success''::text, ''failure''::text, ''rejected''::text]';
begin
  select pg_catalog.pg_get_constraintdef(oid) into v_check from pg_catalog.pg_constraint
    where conrelid='public.audit_logs'::regclass and conname='audit_logs_content_check' and contype='c' and convalidated;
  if v_check is null or pg_catalog.array_length(pg_catalog.string_to_array(v_check,v_old),1) <> 2 then
    raise exception 'Unexpected audit content CHECK. Review it before changing anything.';
  end if;
  v_check := pg_catalog.replace(v_check,v_old,'ARRAY[''success''::text, ''failure''::text, ''rejected''::text, ''reported''::text]');
  alter table public.audit_logs drop constraint audit_logs_content_check;
  execute pg_catalog.format('alter table public.audit_logs add constraint audit_logs_content_check %s',v_check);
end;
$outcome$;

create or replace function public.record_internal_audit_event(
  p_module text,
  p_action text,
  p_entity_type text default null,
  p_entity_id text default null,
  p_description text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_request_id uuid default null,
  p_status text default 'success'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_name text;
  v_actor_role text;
  v_actor_status text;
  v_module text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_module, ''::text)));
  v_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_action, ''::text)));
  v_entity_type text := nullif(pg_catalog.btrim(coalesce(p_entity_type, ''::text)), '');
  v_entity_id text := nullif(pg_catalog.btrim(coalesce(p_entity_id, ''::text)), '');
  v_description text := pg_catalog.btrim(coalesce(p_description, ''::text));
  v_metadata jsonb := coalesce(p_metadata, '{}'::jsonb);
  v_headers jsonb := '{}'::jsonb;
  v_ip_text text;
  v_ip inet;
  v_user_agent text;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select
    pg_catalog.left(
      coalesce(nullif(pg_catalog.btrim(profile.full_name), ''), 'Unknown user'),
      160
    ),
    pg_catalog.left(
      pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))),
      50
    ),
    pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text)))
  into v_actor_name, v_actor_role, v_actor_status
  from public.profiles as profile
  where profile.id = auth.uid();

  if not found or v_actor_status is distinct from 'active' then
    raise exception 'An active authenticated profile is required.' using errcode = '42501';
  end if;

  if v_actor_role not in ('admin', 'doctor', 'staff', 'patient') then
    raise exception 'The authenticated profile role is unavailable.' using errcode = '42501';
  end if;

  if p_status is null or p_status not in ('success', 'reported') then
    raise exception 'Unsupported internal audit outcome.' using errcode = '22023';
  end if;
  if p_status = 'success' and (v_actor_role <> 'admin' or v_module <> 'user_management'
      or v_action not in ('deactivate', 'reactivate')) then
    raise exception 'Unsupported authoritative audit event.' using errcode = '42501';
  end if;

  if v_module = 'user_management' and v_actor_role <> 'admin' then
    raise exception 'Only an active Admin can record User Management audit events.'
      using errcode = '42501';
  end if;

  if v_module not in (
    'authentication', 'user_management', 'patient_management',
    'appointment_management', 'reminder_management', 'visit_records',
    'reports', 'system_settings'
  ) then
    raise exception 'Unsupported audit module.' using errcode = '22023';
  end if;

  if v_action not in (
    'create', 'update', 'delete', 'login', 'logout', 'activate',
    'deactivate', 'reactivate', 'cancel', 'reschedule', 'check_in',
    'complete', 'export', 'print', 'archive', 'link', 'register',
    'finish', 'acknowledge', 'reassign', 'role_change', 'settings_update'
  ) then
    raise exception 'Unsupported audit action.' using errcode = '22023';
  end if;

  if v_description = '' or pg_catalog.char_length(v_description) > 500 then
    raise exception 'Audit description must contain between 1 and 500 characters.'
      using errcode = '22023';
  end if;

  if v_entity_type is not null and pg_catalog.char_length(v_entity_type) > 80 then
    raise exception 'Audit entity type is too long.' using errcode = '22023';
  end if;
  if v_entity_id is not null and pg_catalog.char_length(v_entity_id) > 160 then
    raise exception 'Audit entity identifier is too long.' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(v_metadata) <> 'object'
     or pg_catalog.octet_length(v_metadata::text) > 4096 then
    raise exception 'Audit metadata must be a JSON object no larger than 4096 bytes.'
      using errcode = '22023';
  end if;

  if pg_catalog.lower(v_metadata::text) ~
       '"[^"]*(password|passcode|pwd|token|secret|api[_-]?key|apikey|otp|cookie|authorization|session|diagnosis|medication|dosage|clinical|medical|form_data|reassignment_reason)[^"]*"[[:space:]]*:'
     or v_metadata::text ~* 'bearer[[:space:]]+[a-z0-9._~+/-]+={0,2}'
     or v_metadata::text ~* 'eyj[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+'
     or v_description ~* 'bearer[[:space:]]+[a-z0-9._~+/-]+={0,2}'
     or v_description ~* 'eyj[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+' then
    raise exception 'Audit content contains prohibited sensitive information.'
      using errcode = '22023';
  end if;

  begin
    v_headers := coalesce(
      nullif(pg_catalog.current_setting('request.headers', true), '')::jsonb,
      '{}'::jsonb
    );
  exception when others then
    v_headers := '{}'::jsonb;
  end;

  v_ip_text := pg_catalog.btrim(pg_catalog.split_part(coalesce(
    v_headers ->> 'cf-connecting-ip',
    v_headers ->> 'x-real-ip',
    v_headers ->> 'x-forwarded-for',
    ''
  ), ',', 1));

  begin
    v_ip := nullif(v_ip_text, '')::inet;
  exception when invalid_text_representation then
    v_ip := null;
  end;

  v_user_agent := pg_catalog.left(nullif(v_headers ->> 'user-agent', ''), 500);

  insert into public.audit_logs (
    actor_user_id,
    actor_name,
    actor_role,
    module,
    action,
    status,
    entity_type,
    entity_id,
    description,
    metadata,
    ip_address,
    user_agent,
    request_id,
    created_at
  )
  values (
    auth.uid(),
    v_actor_name,
    v_actor_role,
    v_module,
    v_action,
    p_status,
    v_entity_type,
    v_entity_id,
    v_description,
    v_metadata || pg_catalog.jsonb_build_object('event_source',
      case when p_status = 'reported' then 'client_reported' else 'server_transaction' end),
    v_ip,
    v_user_agent,
    p_request_id,
    pg_catalog.now()
  )
  returning id into v_id;

  return v_id;
end;
$function$;


-- Only postgres-owned trusted code may call the internal writer.
alter function public.record_internal_audit_event(text,text,text,text,text,jsonb,uuid,text) owner to postgres;
revoke all on function public.record_internal_audit_event(text,text,text,text,text,jsonb,uuid,text)
  from public, anon, authenticated, service_role;

create or replace function public.record_audit_event(
  p_module text, p_action text, p_entity_type text default null,
  p_entity_id text default null, p_description text default null,
  p_metadata jsonb default '{}'::jsonb, p_request_id uuid default null
)
returns uuid language plpgsql security definer set search_path = ''
as $client$
declare
  v_role text; v_status text; v_module text := lower(btrim(coalesce(p_module,'')));
  v_action text := lower(btrim(coalesce(p_action,'')));
  v_type text := nullif(btrim(coalesce(p_entity_type,'')),'');
  v_target text := nullif(btrim(coalesce(p_entity_id,'')),'');
  v_metadata jsonb := coalesce(p_metadata,'{}'::jsonb);
  v_prefix text; v_description text;
begin
  if auth.uid() is null then raise exception 'Authentication is required.' using errcode='42501'; end if;
  select lower(btrim(coalesce(role,''))),lower(btrim(coalesce(account_status,''))) into v_role,v_status
    from public.profiles where id=auth.uid();
  if not found or v_status <> 'active' or v_role not in ('admin','doctor','staff','patient') then
    raise exception 'An active authenticated profile is required.' using errcode='42501';
  end if;
  if pg_catalog.jsonb_typeof(v_metadata) <> 'object' or pg_catalog.octet_length(v_metadata::text)>4096 then
    raise exception 'Invalid audit metadata.' using errcode='22023';
  end if;
  if v_module='authentication' and v_action in ('login','logout') then
    if v_type is distinct from 'auth_user' or (v_target is not null and v_target <> auth.uid()::text)
       or v_metadata <> '{}'::jsonb then
      raise exception 'Only own-account authentication reports are supported.' using errcode='42501';
    end if;
    v_target := auth.uid()::text;
    v_description := case when v_action='login' then 'User reported a login.' else 'User reported a logout.' end;
  elsif v_module='reports' and v_role='admin' and v_action in ('export','print') then
    if v_type is distinct from 'report'
       or exists(select 1 from pg_catalog.jsonb_object_keys(v_metadata) as keys(key) where keys.key not in ('format','report'))
       or v_metadata->>'format' is null or v_metadata->>'report' is null
       or not ((v_action='print' and v_metadata->>'format'='print')
           or (v_action='export' and v_metadata->>'format' in ('pdf','excel'))) then
      raise exception 'Unsupported report claim.' using errcode='42501';
    end if;
    v_prefix := case v_metadata->>'report'
      when 'Appointment Summary Report' then 'appointment-summary'
      when 'Patient Summary Report' then 'patient-summary'
      when 'Registration & Appointment Trends' then 'registration-appointment-trends'
      else null end;
    if v_prefix is null or v_target is null
       or v_target !~ ('^' || v_prefix || '-[0-9]{4}-[0-9]{2}-[0-9]{2}-to-[0-9]{4}-[0-9]{2}-[0-9]{2}$') then
      raise exception 'Unsupported report target.' using errcode='42501';
    end if;
    v_description := case when v_action='print' then 'User reported preparing a report for printing.'
      else 'User reported a report export.' end;
  else
    raise exception 'Business success events may only be recorded by trusted transactional writers.' using errcode='42501';
  end if;
  -- Validate the original description too; it is never stored as arbitrary client text.
  if p_description is null or btrim(p_description)='' or length(p_description)>500
     or p_description ~* '(bearer[[:space:]]+|eyj[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+)' then
    raise exception 'Invalid or sensitive audit description.' using errcode='22023';
  end if;
  return public.record_internal_audit_event(v_module,v_action,v_type,v_target,v_description,v_metadata,p_request_id,'reported');
end;
$client$;
alter function public.record_audit_event(text,text,text,text,text,jsonb,uuid) owner to postgres;
revoke all on function public.record_audit_event(text,text,text,text,text,jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.record_audit_event(text,text,text,text,text,jsonb,uuid) to authenticated;

-- Change only the audit call in each verified Admin status transaction.
do $trusted_callers$
declare v_signature text; v_oid oid; v_definition text; v_old text := 'public.record_audit_event(';
begin
  foreach v_signature in array array[
    'public.admin_set_patient_account_status(uuid,text)',
    'public.admin_set_doctor_account_status(uuid,text)',
    'public.admin_set_staff_account_status(uuid,text)'
  ] loop
    v_oid := pg_catalog.to_regprocedure(v_signature);
    v_definition := pg_catalog.pg_get_functiondef(v_oid);
    if pg_catalog.array_length(pg_catalog.string_to_array(v_definition,v_old),1) <> 2 then
      raise exception 'Expected exactly one trusted audit call in %',v_signature;
    end if;
    execute pg_catalog.replace(v_definition,v_old,'public.record_internal_audit_event(');
  end loop;
  if pg_catalog.has_function_privilege('authenticated','public.record_internal_audit_event(text,text,text,text,text,jsonb,uuid,text)','EXECUTE')
     or pg_catalog.has_function_privilege('anon','public.record_internal_audit_event(text,text,text,text,text,jsonb,uuid,text)','EXECUTE')
     or pg_catalog.has_function_privilege('service_role','public.record_internal_audit_event(text,text,text,text,text,jsonb,uuid,text)','EXECUTE') then
    raise exception 'Unexpected inherited access to internal audit writer; rolling back patch.';
  end if;
end;
$trusted_callers$;
notify pgrst, 'reload schema';
commit;
