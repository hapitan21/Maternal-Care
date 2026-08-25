-- ============================================================
-- Maternal Care - Admin audit logs
-- ============================================================
-- REVIEW BEFORE MANUAL INSTALLATION. This migration creates no Cron job,
-- webhook, Edge Function, Web Push integration, or automatic table trigger.

begin;

do $preflight$
declare
  v_column record;
  v_actual text;
begin
  if pg_catalog.to_regclass('public.profiles') is null then
    raise exception 'Preflight failed: public.profiles does not exist.';
  end if;

  for v_column in
    select *
    from (values
      ('id', 'uuid'),
      ('full_name', 'text'),
      ('role', 'text'),
      ('account_status', 'text')
    ) as expected(column_name, expected_type)
  loop
    select columns.udt_name
    into v_actual
    from information_schema.columns
    where columns.table_schema = 'public'
      and columns.table_name = 'profiles'
      and columns.column_name = v_column.column_name;

    if v_actual is null or v_actual <> v_column.expected_type then
      raise exception 'Preflight failed: public.profiles.% expected % but found %.',
        v_column.column_name,
        v_column.expected_type,
        coalesce(v_actual, 'missing');
    end if;
  end loop;
end;
$preflight$;

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

-- Complete a compatible pre-existing table without dropping data or columns.
alter table public.audit_logs add column if not exists id uuid default pg_catalog.gen_random_uuid();
alter table public.audit_logs add column if not exists actor_user_id uuid;
alter table public.audit_logs add column if not exists actor_name text default 'System';
alter table public.audit_logs add column if not exists actor_role text default 'system';
alter table public.audit_logs add column if not exists module text;
alter table public.audit_logs add column if not exists action text;
alter table public.audit_logs add column if not exists status text default 'success';
alter table public.audit_logs add column if not exists entity_type text;
alter table public.audit_logs add column if not exists entity_id text;
alter table public.audit_logs add column if not exists description text;
alter table public.audit_logs add column if not exists metadata jsonb default '{}'::jsonb;
alter table public.audit_logs add column if not exists ip_address inet;
alter table public.audit_logs add column if not exists user_agent text;
alter table public.audit_logs add column if not exists request_id uuid;
alter table public.audit_logs add column if not exists created_at timestamptz default pg_catalog.now();

do $audit_schema_preflight$
declare
  v_column record;
  v_actual text;
begin
  for v_column in
    select *
    from (values
      ('id', 'uuid'),
      ('actor_user_id', 'uuid'),
      ('actor_name', 'text'),
      ('actor_role', 'text'),
      ('module', 'text'),
      ('action', 'text'),
      ('status', 'text'),
      ('entity_type', 'text'),
      ('entity_id', 'text'),
      ('description', 'text'),
      ('metadata', 'jsonb'),
      ('ip_address', 'inet'),
      ('user_agent', 'text'),
      ('request_id', 'uuid'),
      ('created_at', 'timestamptz')
    ) as expected(column_name, expected_type)
  loop
    select columns.udt_name
    into v_actual
    from information_schema.columns
    where columns.table_schema = 'public'
      and columns.table_name = 'audit_logs'
      and columns.column_name = v_column.column_name;

    if v_actual is null or v_actual <> v_column.expected_type then
      raise exception 'Preflight failed: public.audit_logs.% expected % but found %.',
        v_column.column_name,
        v_column.expected_type,
        coalesce(v_actual, 'missing');
    end if;
  end loop;
end;
$audit_schema_preflight$;

-- Only repair nulls introduced by missing columns on a compatible old table.
update public.audit_logs
set
  id = coalesce(id, pg_catalog.gen_random_uuid()),
  actor_name = pg_catalog.left(
    coalesce(nullif(pg_catalog.btrim(actor_name), ''), 'System'),
    160
  ),
  actor_role = pg_catalog.left(
    coalesce(nullif(pg_catalog.lower(pg_catalog.btrim(actor_role)), ''), 'system'),
    50
  ),
  module = coalesce(nullif(pg_catalog.lower(pg_catalog.btrim(module)), ''), 'system_settings'),
  action = coalesce(nullif(pg_catalog.lower(pg_catalog.btrim(action)), ''), 'update'),
  status = coalesce(nullif(pg_catalog.lower(pg_catalog.btrim(status)), ''), 'success'),
  description = coalesce(nullif(pg_catalog.btrim(description), ''), 'Historical audit event.'),
  metadata = coalesce(metadata, '{}'::jsonb),
  created_at = coalesce(created_at, pg_catalog.now())
where id is null
   or nullif(pg_catalog.btrim(actor_name), '') is null
   or nullif(pg_catalog.btrim(actor_role), '') is null
   or nullif(pg_catalog.btrim(module), '') is null
   or nullif(pg_catalog.btrim(action), '') is null
   or nullif(pg_catalog.btrim(status), '') is null
   or nullif(pg_catalog.btrim(description), '') is null
   or metadata is null
   or created_at is null;

alter table public.audit_logs alter column id set default pg_catalog.gen_random_uuid();
alter table public.audit_logs alter column id set not null;
alter table public.audit_logs alter column actor_name set default 'System';
alter table public.audit_logs alter column actor_name set not null;
alter table public.audit_logs alter column actor_role set default 'system';
alter table public.audit_logs alter column actor_role set not null;
alter table public.audit_logs alter column module set not null;
alter table public.audit_logs alter column action set not null;
alter table public.audit_logs alter column status set default 'success';
alter table public.audit_logs alter column status set not null;
alter table public.audit_logs alter column description set not null;
alter table public.audit_logs alter column metadata set default '{}'::jsonb;
alter table public.audit_logs alter column metadata set not null;
alter table public.audit_logs alter column created_at set default pg_catalog.now();
alter table public.audit_logs alter column created_at set not null;

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

create index if not exists audit_logs_created_at_idx
  on public.audit_logs (created_at desc, id desc);
create index if not exists audit_logs_actor_user_id_idx
  on public.audit_logs (actor_user_id, created_at desc);
create index if not exists audit_logs_actor_role_idx
  on public.audit_logs (actor_role, created_at desc);
create index if not exists audit_logs_module_idx
  on public.audit_logs (module, created_at desc);
create index if not exists audit_logs_action_idx
  on public.audit_logs (action, created_at desc);
create index if not exists audit_logs_entity_type_idx
  on public.audit_logs (entity_type, created_at desc);
create index if not exists audit_logs_status_idx
  on public.audit_logs (status, created_at desc);

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

comment on table public.audit_logs is
  'Append-only security and administrative activity history. Browser writes are allowed only through record_audit_event().';
comment on column public.audit_logs.metadata is
  'Bounded non-clinical JSON metadata. Authentication secrets, private clinical data, and reassignment reasons are prohibited.';

alter table public.audit_logs enable row level security;

drop policy if exists "Active Admins can read audit logs" on public.audit_logs;
drop policy if exists "Admins can read audit logs" on public.audit_logs;
create policy "Active Admins can read audit logs"
on public.audit_logs
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(
        pg_catalog.btrim(coalesce(profile.role, ''::text))
      ) = 'admin'
      and pg_catalog.lower(
        pg_catalog.btrim(coalesce(profile.account_status, ''::text))
      ) = 'active'
  )
);

revoke all on table public.audit_logs from public, anon, authenticated;
grant select on table public.audit_logs to authenticated;

revoke all on function public.record_audit_event(text, text, text, text, text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.record_audit_event(text, text, text, text, text, jsonb, uuid)
  to authenticated;

notify pgrst, 'reload schema';

commit;

-- ============================================================
-- Commented verification queries (read-only unless explicitly noted)
-- ============================================================
-- 1. Table existence.
-- select pg_catalog.to_regclass('public.audit_logs') as audit_logs_table;
--
-- 2. Column list.
-- select column_name, udt_name, is_nullable, column_default
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'audit_logs'
-- order by ordinal_position;
--
-- 3. RLS status. relrowsecurity must be true.
-- select relation.relname, relation.relrowsecurity
-- from pg_catalog.pg_class as relation
-- where relation.oid = 'public.audit_logs'::pg_catalog.regclass;
--
-- 4. Policies. Expect the active-Admin SELECT policy only.
-- select schemaname, tablename, policyname, roles, cmd, qual, with_check
-- from pg_catalog.pg_policies
-- where schemaname = 'public' and tablename = 'audit_logs';
--
-- 5. Function signature and protected configuration.
-- select routine.oid::pg_catalog.regprocedure as signature,
--        pg_catalog.pg_get_function_result(routine.oid) as result_type,
--        routine.prosecdef, routine.proconfig,
--        pg_catalog.pg_get_userbyid(routine.proowner) as owner
-- from pg_catalog.pg_proc as routine
-- where routine.oid =
--   'public.record_audit_event(text,text,text,text,text,jsonb,uuid)'::pg_catalog.regprocedure;
--
-- 6. Browser grants. authenticated must have SELECT only on the table;
-- record creation must occur through the RPC.
-- select grantee, privilege_type
-- from information_schema.role_table_grants
-- where table_schema = 'public' and table_name = 'audit_logs'
-- order by grantee, privilege_type;
--
-- select grantee, privilege_type
-- from information_schema.routine_privileges
-- where specific_schema = 'public'
--   and routine_name = 'record_audit_event'
-- order by grantee, privilege_type;
--
-- 7. Latest audit rows.
-- select *
-- from public.audit_logs
-- order by created_at desc
-- limit 20;
--
-- 8. As an authenticated active Admin, the query above returns permitted rows.
-- Confirm actor identity comes from auth.uid() by recording a controlled event
-- through the RPC and comparing actor_user_id with auth.uid().
--
-- 9. As Doctor, Staff, Patient, inactive Admin, or anon, SELECT must return no
-- rows through RLS. Direct INSERT, UPDATE, and DELETE must be denied.
--
-- 10. Sensitive metadata check. Expect zero rows.
-- select id, created_at
-- from public.audit_logs
-- where pg_catalog.lower(metadata::text) ~
--   '"[^"]*(password|passcode|pwd|token|secret|api[_-]?key|apikey|otp|cookie|authorization|session|diagnosis|medication|dosage|clinical|medical|form_data|reassignment_reason)[^"]*"[[:space:]]*:'
--    or metadata::text ~* 'bearer[[:space:]]+[a-z0-9._~+/-]+={0,2}'
--    or metadata::text ~* 'eyj[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+';
