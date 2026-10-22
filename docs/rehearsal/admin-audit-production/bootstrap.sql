-- SYNTHETIC ONLY. Never run on an existing Supabase project.
begin;
do $identity$ begin
  if current_user <> 'postgres' or inet_server_addr() is not null
    or current_setting('audit_rehearsal.nonce',true) !~ '^[a-f0-9]{32}$'
    or current_database() is distinct from 'mc_audit_' || left(current_setting('audit_rehearsal.nonce',true),12)
    or current_setting('audit_rehearsal.major',true) is null
    or current_setting('server_version_num')::integer / 10000 <> current_setting('audit_rehearsal.major')::integer then
    raise exception 'STOP: not the approved isolated socket/database/version/nonce';
  end if;
end $identity$;
do $empty$ begin
  if exists(select 1 from pg_namespace where nspname in ('auth','realtime','s4audit_private','rehearsal_control'))
    or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public')
    or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public') then
    raise exception 'STOP: bootstrap requires a new empty database';
  end if;
end $empty$;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema realtime;
create schema rehearsal_control;
revoke all on schema rehearsal_control from public,anon,authenticated,service_role;
create table rehearsal_control.identity(nonce text primary key);
insert into rehearsal_control.identity values(current_setting('audit_rehearsal.nonce'));
-- Explicit test double: no gateway signature/expiry validation is performed here.
create function auth.uid() returns uuid language sql stable as $uid$
  select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid;
$uid$;
grant usage on schema auth to anon,authenticated,service_role;
create table public.profiles (
 id uuid primary key, full_name text not null, email text, role text not null,
 account_status text not null, created_at timestamptz default now(), updated_at timestamptz default now(),
 deactivated_at timestamptz,deactivated_by uuid,reactivated_at timestamptz,reactivated_by uuid
);
create table public.patients (
 id uuid primary key,user_id uuid references public.profiles(id),account_status text,status text,
 archived_at timestamptz,activated_at timestamptz,activated_by uuid,
 deactivated_at timestamptz,deactivated_by uuid,updated_at timestamptz default now()
);
insert into public.profiles(id,full_name,email,role,account_status) values
 ('11111111-1111-4111-8111-111111111111','Synthetic Admin','admin@audit.invalid','admin','active'),
 ('22222222-2222-4222-8222-222222222222','Synthetic Doctor','doctor@audit.invalid','doctor','active'),
 ('33333333-3333-4333-8333-333333333333','Synthetic Staff','staff@audit.invalid','staff','active'),
 ('44444444-4444-4444-8444-444444444444','Synthetic Patient','patient@audit.invalid','patient','active'),
 ('66666666-6666-4666-8666-666666666666','Synthetic Inactive','inactive@audit.invalid','admin','inactive');
insert into public.patients(id,user_id,account_status,status) values
 ('55555555-5555-4555-8555-555555555555','44444444-4444-4444-8444-444444444444','active','active');
create table if not exists public.audit_logs (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  actor_user_id uuid,
  actor_name text not null default 'System',
  actor_role text not null default 'system',
  module text not null,
  action text not null,
  status text not null default 'success',
  entity_type text,
  entity_id text,
  description text not null,
  metadata jsonb not null default '{}'::jsonb,
  ip_address inet,
  user_agent text,
  request_id uuid,
  created_at timestamptz not null default pg_catalog.now()
);
do $constraints$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint as constraint_record
    where constraint_record.conrelid = 'public.audit_logs'::pg_catalog.regclass
      and constraint_record.contype = 'p'
  ) then
    alter table public.audit_logs
      add constraint audit_logs_pkey primary key (id);
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'audit_logs_actor_user_id_fkey'
      and conrelid = 'public.audit_logs'::pg_catalog.regclass
  ) then
    alter table public.audit_logs
      add constraint audit_logs_actor_user_id_fkey
      foreign key (actor_user_id)
      references public.profiles(id)
      on delete restrict;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'audit_logs_actor_check'
      and conrelid = 'public.audit_logs'::pg_catalog.regclass
  ) then
    alter table public.audit_logs
      add constraint audit_logs_actor_check check (
        actor_name = pg_catalog.btrim(actor_name)
        and pg_catalog.char_length(actor_name) between 1 and 160
        and actor_role = pg_catalog.lower(pg_catalog.btrim(actor_role))
        and pg_catalog.char_length(actor_role) between 1 and 50
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'audit_logs_module_check'
      and conrelid = 'public.audit_logs'::pg_catalog.regclass
  ) then
    alter table public.audit_logs
      add constraint audit_logs_module_check check (
        module in (
          'authentication', 'user_management', 'patient_management',
          'appointment_management', 'reminder_management', 'visit_records',
          'reports', 'system_settings'
        )
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'audit_logs_action_check'
      and conrelid = 'public.audit_logs'::pg_catalog.regclass
  ) then
    alter table public.audit_logs
      add constraint audit_logs_action_check check (
        action in (
          'create', 'update', 'delete', 'login', 'logout', 'activate',
          'deactivate', 'reactivate', 'cancel', 'reschedule', 'check_in',
          'complete', 'export', 'print', 'archive', 'link', 'register',
          'finish', 'acknowledge', 'reassign', 'role_change',
          'settings_update'
        )
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'audit_logs_content_check'
      and conrelid = 'public.audit_logs'::pg_catalog.regclass
  ) then
    alter table public.audit_logs
      add constraint audit_logs_content_check check (
        status in ('success', 'failure', 'rejected')
        and description = pg_catalog.btrim(description)
        and pg_catalog.char_length(description) between 1 and 500
        and (entity_type is null or pg_catalog.char_length(entity_type) between 1 and 80)
        and (entity_id is null or pg_catalog.char_length(entity_id) between 1 and 160)
        and pg_catalog.jsonb_typeof(metadata) = 'object'
        and pg_catalog.octet_length(metadata::text) <= 4096
        and (user_agent is null or pg_catalog.char_length(user_agent) <= 500)
      );
  end if;
end;
$constraints$;
create or replace function public.is_active_admin_realtime()
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
      and pg_catalog.lower(
        pg_catalog.btrim(
          coalesce(profile.role, ''::text)
        )
      ) = 'admin'
      and pg_catalog.lower(
        pg_catalog.btrim(
          coalesce(profile.account_status, ''::text)
        )
      ) = 'active'
  );
$function$;
create or replace function public.admin_user_management_assert_active_admin()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select
    pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))),
    pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text)))
  into v_role, v_status
  from public.profiles as profile
  where profile.id = auth.uid();

  if not found or v_role is distinct from 'admin' or v_status is distinct from 'active' then
    raise exception 'An active Admin account is required.' using errcode = '42501';
  end if;
end;
$function$;
create or replace function public.admin_resolve_patient_status(
  p_user_id uuid,
  p_account_status text,
  p_record_status text,
  p_archived_at timestamp with time zone
)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when p_archived_at is not null
      or pg_catalog.lower(pg_catalog.btrim(coalesce(p_record_status, ''::text)))
        in ('archived', 'deleted')
      then 'archived'
    when p_user_id is null then 'not_linked'
    when pg_catalog.lower(pg_catalog.btrim(coalesce(p_account_status, ''::text)))
      in ('inactive', 'deactivated', 'suspended', 'disabled', 'blocked')
      then 'inactive'
    else 'active'
  end;
$function$;
create or replace function public.record_audit_event(
  p_module text,
  p_action text,
  p_entity_type text default null,
  p_entity_id text default null,
  p_description text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_request_id uuid default null
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

  if v_actor_role = '' then
    raise exception 'The authenticated profile role is unavailable.' using errcode = '42501';
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
    'success',
    v_entity_type,
    v_entity_id,
    v_description,
    v_metadata,
    v_ip,
    v_user_agent,
    p_request_id,
    pg_catalog.now()
  )
  returning id into v_id;

  return v_id;
end;
$function$;

create or replace function public.admin_set_patient_account_status(
  p_patient_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_patient public.patients%rowtype;
  v_profile public.profiles%rowtype;
  v_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_action, ''::text)));
  v_current text;
  v_next text;
begin
  perform public.admin_user_management_assert_active_admin();

  select * into v_patient
  from public.patients
  where id = p_patient_id
  for update;

  if not found then
    raise exception 'The selected Patient record was not found.' using errcode = 'P0002';
  end if;
  if v_patient.archived_at is not null
     or pg_catalog.lower(pg_catalog.btrim(coalesce(v_patient.status, ''::text)))
       in ('archived', 'deleted') then
    raise exception 'Archived Patient records cannot receive login-status changes.' using errcode = '22023';
  end if;
  if v_patient.user_id is null then
    raise exception 'This Patient does not have a linked login account.' using errcode = '22023';
  end if;

  select * into v_profile
  from public.profiles
  where id = v_patient.user_id
  for update;

  if not found
     or pg_catalog.lower(pg_catalog.btrim(coalesce(v_profile.role, ''::text))) <> 'patient' then
    raise exception 'This Patient does not have a linked Patient profile.' using errcode = '22023';
  end if;
  if v_profile.id = auth.uid() then
    raise exception 'You cannot change your own privileged account status.' using errcode = '22023';
  end if;

  v_current := public.admin_resolve_patient_status(
    v_patient.user_id,
    v_patient.account_status,
    v_patient.status,
    v_patient.archived_at
  );

  if v_action = 'deactivate' and v_current = 'active' then
    v_next := 'inactive';
  elsif v_action = 'reactivate' and v_current = 'inactive' then
    v_next := 'active';
  else
    raise exception 'The requested Patient account-status transition is not allowed.' using errcode = '22023';
  end if;

  update public.profiles as profile
  set account_status = v_next,
    deactivated_at = case when v_next = 'inactive' then pg_catalog.now() else null end,
    deactivated_by = case when v_next = 'inactive' then auth.uid() else null end,
    reactivated_at = case when v_next = 'active' then pg_catalog.now() else profile.reactivated_at end,
    reactivated_by = case when v_next = 'active' then auth.uid() else profile.reactivated_by end
  where profile.id = v_profile.id;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'updated_at'
  ) then
    execute 'update public.profiles set updated_at = pg_catalog.now() where id = $1'
      using v_profile.id;
  end if;

  update public.patients as patient
  set account_status = v_next,
    activated_at = case when v_next = 'active' then pg_catalog.now() else patient.activated_at end,
    activated_by = case when v_next = 'active' then auth.uid() else patient.activated_by end,
    deactivated_at = case when v_next = 'inactive' then pg_catalog.now() else null end,
    deactivated_by = case when v_next = 'inactive' then auth.uid() else null end,
    updated_at = pg_catalog.now()
  where patient.id = v_patient.id;

  perform public.record_audit_event(
    'user_management',
    v_action,
    'patient_account',
    v_patient.id::text,
    'Patient account access status changed by an Administrator.',
    pg_catalog.jsonb_build_object('previous_status', v_current, 'new_status', v_next),
    null
  );

  return pg_catalog.jsonb_build_object(
    'id', v_patient.id,
    'profile_id', v_profile.id,
    'role', 'patient',
    'account_status', v_next,
    'action', v_action
  );
end;
$function$;

create or replace function public.admin_set_doctor_account_status(p_profile_id uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_profile public.profiles%rowtype; v_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_action, ''::text))); v_current text; v_next text;
begin
  perform public.admin_user_management_assert_active_admin();
  select * into v_profile from public.profiles where id = p_profile_id for update;
  if not found or pg_catalog.lower(pg_catalog.btrim(coalesce(v_profile.role, ''::text))) <> 'doctor' then raise exception 'The selected Doctor profile was not found.' using errcode = 'P0002'; end if;
  if v_profile.id = auth.uid() then raise exception 'You cannot change your own privileged account status.' using errcode = '22023'; end if;
  v_current := pg_catalog.lower(pg_catalog.btrim(coalesce(v_profile.account_status, ''::text)));
  if v_action = 'deactivate' and v_current = 'active' then v_next := 'inactive'; elsif v_action = 'reactivate' and v_current in ('inactive', 'deactivated', 'suspended') then v_next := 'active'; else raise exception 'The requested Doctor account-status transition is not allowed.' using errcode = '22023'; end if;
  update public.profiles as profile set account_status = v_next,
    deactivated_at = case when v_next = 'inactive' then pg_catalog.now() else null end,
    deactivated_by = case when v_next = 'inactive' then auth.uid() else null end,
    reactivated_at = case when v_next = 'active' then pg_catalog.now() else profile.reactivated_at end,
    reactivated_by = case when v_next = 'active' then auth.uid() else profile.reactivated_by end
  where profile.id = v_profile.id;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'updated_at') then
    execute 'update public.profiles set updated_at = pg_catalog.now() where id = $1' using v_profile.id;
  end if;
  perform public.record_audit_event('user_management', v_action, 'doctor_account', v_profile.id::text, 'Doctor account access status changed by an Administrator.', pg_catalog.jsonb_build_object('previous_status', v_current, 'new_status', v_next), null);
  return pg_catalog.jsonb_build_object('id', v_profile.id, 'role', 'doctor', 'account_status', v_next, 'action', v_action);
end;
$function$;

create or replace function public.admin_set_staff_account_status(p_profile_id uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_profile public.profiles%rowtype; v_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_action, ''::text))); v_current text; v_next text;
begin
  perform public.admin_user_management_assert_active_admin();
  select * into v_profile from public.profiles where id = p_profile_id for update;
  if not found or pg_catalog.lower(pg_catalog.btrim(coalesce(v_profile.role, ''::text))) <> 'staff' then raise exception 'The selected Staff profile was not found.' using errcode = 'P0002'; end if;
  if v_profile.id = auth.uid() then raise exception 'You cannot change your own privileged account status.' using errcode = '22023'; end if;
  v_current := pg_catalog.lower(pg_catalog.btrim(coalesce(v_profile.account_status, ''::text)));
  if v_action = 'deactivate' and v_current = 'active' then v_next := 'inactive'; elsif v_action = 'reactivate' and v_current in ('inactive', 'deactivated', 'suspended') then v_next := 'active'; else raise exception 'The requested Staff account-status transition is not allowed.' using errcode = '22023'; end if;
  update public.profiles as profile set account_status = v_next,
    deactivated_at = case when v_next = 'inactive' then pg_catalog.now() else null end,
    deactivated_by = case when v_next = 'inactive' then auth.uid() else null end,
    reactivated_at = case when v_next = 'active' then pg_catalog.now() else profile.reactivated_at end,
    reactivated_by = case when v_next = 'active' then auth.uid() else profile.reactivated_by end
  where profile.id = v_profile.id;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'updated_at') then
    execute 'update public.profiles set updated_at = pg_catalog.now() where id = $1' using v_profile.id;
  end if;
  perform public.record_audit_event('user_management', v_action, 'staff_account', v_profile.id::text, 'Staff account access status changed by an Administrator.', pg_catalog.jsonb_build_object('previous_status', v_current, 'new_status', v_next), null);
  return pg_catalog.jsonb_build_object('id', v_profile.id, 'role', 'staff', 'account_status', v_next, 'action', v_action);
end;
$function$;
alter table public.audit_logs enable row level security;
create policy "Active admins can read audit logs" on public.audit_logs for select to authenticated
 using ((select public.is_active_admin_realtime()));
revoke all on public.audit_logs from public,anon,authenticated;
grant select on public.audit_logs to authenticated;
alter table public.profiles enable row level security;
create policy "Own synthetic profile" on public.profiles for select to authenticated using(id=(select auth.uid()));
grant select on public.profiles to authenticated;
revoke all on public.patients from public,anon,authenticated;
revoke all on function public.admin_user_management_assert_active_admin() from public,anon,authenticated,service_role;
revoke all on function public.record_audit_event(text,text,text,text,text,jsonb,uuid) from public,anon,service_role;
grant execute on function public.record_audit_event(text,text,text,text,text,jsonb,uuid) to authenticated;
revoke all on function public.admin_set_patient_account_status(uuid,text) from public,anon,service_role;
grant execute on function public.admin_set_patient_account_status(uuid,text) to authenticated;
revoke all on function public.admin_set_doctor_account_status(uuid,text) from public,anon,service_role;
grant execute on function public.admin_set_doctor_account_status(uuid,text) to authenticated;
revoke all on function public.admin_set_staff_account_status(uuid,text) from public,anon,service_role;
grant execute on function public.admin_set_staff_account_status(uuid,text) to authenticated;
-- Transactional trace double; NOT a real Realtime service or external message.
create table rehearsal_control.broadcast_trace(payload jsonb,event text,topic text,is_private boolean);
create function realtime.send(payload jsonb,event text,topic text,is_private boolean) returns void
 language sql as $send$ insert into rehearsal_control.broadcast_trace values(payload,event,topic,is_private); $send$;
create or replace function public.broadcast_admin_audit_log_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  begin
    perform realtime.send(
      pg_catalog.jsonb_build_object(
        'operation', TG_OP
      ),
      'audit_log_changed',
      'admin:audit-logs',
      true
    );

  exception
    when others then
      -- Realtime delivery must never cause the underlying
      -- audit_logs INSERT to fail.
      raise warning
        'Admin audit-log broadcast failed: %',
        SQLERRM;
  end;

  return NEW;
end;
$function$;
revoke all on function public.broadcast_admin_audit_log_change() from public;
create trigger broadcast_admin_audit_log_change_trigger after insert on public.audit_logs
 for each row execute function public.broadcast_admin_audit_log_change();
insert into public.audit_logs(id,actor_user_id,actor_name,actor_role,module,action,status,description,created_at) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','Synthetic Admin','admin','authentication','login','success','Synthetic historical success.','2026-10-01T00:00:00Z'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','11111111-1111-4111-8111-111111111111','Synthetic Admin','admin','reports','export','failure','Synthetic historical failure.','2026-10-02T00:00:00Z');
create table rehearsal_control.history as select * from public.audit_logs;
create table rehearsal_control.constraints_before as select conname,contype,convalidated,pg_get_constraintdef(oid) as definition
 from pg_constraint where conrelid='public.audit_logs'::regclass;
create table rehearsal_control.functions_before as select p.oid,p.proname,p.prosrc,p.proacl,p.proowner,
 p.prosecdef,p.proconfig,p.proargnames,p.pronargdefaults,p.proargtypes,p.prorettype,
 pg_get_expr(p.proargdefaults,0) as defaults_expression,pg_get_functiondef(p.oid) as definition
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
 and p.proname in ('record_audit_event','admin_set_patient_account_status','admin_set_doctor_account_status','admin_set_staff_account_status');
-- These snapshots inspect only synthetic objects, not production data.
create function rehearsal_control.catalog_signature() returns jsonb language sql stable as $signature$
 select jsonb_build_object(
 'table',(select jsonb_build_object('rls',relrowsecurity,'force',relforcerowsecurity,'owner',relowner,'acl',relacl) from pg_class where oid='public.audit_logs'::regclass),
 'columns',(select jsonb_agg(jsonb_build_object('name',attname,'type',atttypid,'required',attnotnull,'acl',attacl) order by attnum) from pg_attribute where attrelid='public.audit_logs'::regclass and attnum>0 and not attisdropped),
 'policies',(select jsonb_agg(to_jsonb(p) order by policyname) from pg_policies p where schemaname='public' and tablename='audit_logs'),
 'triggers',(select jsonb_agg(jsonb_build_object('name',tgname,'enabled',tgenabled,'definition',pg_get_triggerdef(oid)) order by tgname) from pg_trigger where tgrelid='public.audit_logs'::regclass and not tgisinternal));
$signature$;
create table rehearsal_control.catalog_before as select rehearsal_control.catalog_signature() as signature;
commit;
