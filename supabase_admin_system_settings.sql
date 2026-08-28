-- ============================================================
-- Maternal Care - Admin System Settings persistence
-- ============================================================
-- REVIEW ONLY. Do not execute automatically from the application.
-- This migration stores approved operational settings only. It does not
-- modify Supabase Auth, account-status enforcement, Patient/Doctor clinical
-- security, Cron, Edge Functions, Web Push, or reminder processing.

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

create table if not exists public.system_settings (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  singleton_guard boolean not null default true,

  system_name text not null default 'Maternal Care Reminder & Appointment Management System',
  clinic_name text not null default 'Maternal Care Clinic',
  clinic_email text not null default '',
  contact_number text not null default '',
  clinic_address text not null default '',
  timezone text not null default 'Asia/Manila',

  clinic_opening_time time without time zone not null default '08:00'::time,
  clinic_closing_time time without time zone not null default '17:00'::time,
  default_appointment_duration_minutes integer not null default 30,
  booking_interval_minutes integer not null default 30,
  cancellation_window_hours integer not null default 24,
  maximum_daily_appointments integer not null default 30,

  appointment_reminders_enabled boolean not null default true,
  medication_reminder_alerts_enabled boolean not null default true,
  browser_push_notifications_enabled boolean not null default false,
  appointment_reminder_hours_before integer not null default 24,
  second_reminder_hours_before integer default 2,

  date_format text not null default 'MM/DD/YYYY',
  time_format text not null default '12-hour',
  records_per_page integer not null default 20,
  dashboard_refresh_seconds integer not null default 60,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  updated_by uuid,

  constraint system_settings_singleton_guard_check check (singleton_guard),
  constraint system_settings_singleton_guard_key unique (singleton_guard),
  constraint system_settings_updated_by_fkey
    foreign key (updated_by) references public.profiles(id) on delete set null,
  constraint system_settings_values_check check (
    system_name = pg_catalog.btrim(system_name)
    and pg_catalog.char_length(system_name) between 1 and 160
    and clinic_name = pg_catalog.btrim(clinic_name)
    and pg_catalog.char_length(clinic_name) between 1 and 160
    and clinic_email = pg_catalog.btrim(clinic_email)
    and pg_catalog.char_length(clinic_email) <= 254
    and (
      clinic_email = ''
      or clinic_email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'
    )
    and contact_number = pg_catalog.btrim(contact_number)
    and pg_catalog.char_length(contact_number) <= 50
    and clinic_address = pg_catalog.btrim(clinic_address)
    and pg_catalog.char_length(clinic_address) <= 500
    and timezone = pg_catalog.btrim(timezone)
    and pg_catalog.char_length(timezone) between 1 and 80
    and clinic_closing_time > clinic_opening_time
    and default_appointment_duration_minutes between 15 and 240
    and booking_interval_minutes between 5 and 240
    and cancellation_window_hours between 0 and 168
    and maximum_daily_appointments between 1 and 500
    and appointment_reminder_hours_before between 1 and 168
    and (
      second_reminder_hours_before is null
      or second_reminder_hours_before between 1 and 168
    )
    and (
      second_reminder_hours_before is null
      or second_reminder_hours_before < appointment_reminder_hours_before
    )
    and date_format in ('MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD')
    and time_format in ('12-hour', '24-hour')
    and records_per_page in (10, 20, 50, 100)
    and dashboard_refresh_seconds in (30, 60, 300)
    and updated_at >= created_at
  )
);

comment on table public.system_settings is
  'Singleton operational settings record. Browser access is restricted to active-Admin SECURITY DEFINER RPCs.';
comment on column public.system_settings.singleton_guard is
  'Always true and unique, enforcing at most one authoritative settings record.';
comment on column public.system_settings.updated_by is
  'Authenticated Admin profile that last updated the persisted settings.';

-- Fail safely if an incompatible object already occupies this table name.
do $settings_schema_preflight$
declare
  v_column record;
  v_actual text;
begin
  for v_column in
    select *
    from (values
      ('id', 'uuid'),
      ('singleton_guard', 'bool'),
      ('system_name', 'text'),
      ('clinic_name', 'text'),
      ('clinic_email', 'text'),
      ('contact_number', 'text'),
      ('clinic_address', 'text'),
      ('timezone', 'text'),
      ('clinic_opening_time', 'time'),
      ('clinic_closing_time', 'time'),
      ('default_appointment_duration_minutes', 'int4'),
      ('booking_interval_minutes', 'int4'),
      ('cancellation_window_hours', 'int4'),
      ('maximum_daily_appointments', 'int4'),
      ('appointment_reminders_enabled', 'bool'),
      ('medication_reminder_alerts_enabled', 'bool'),
      ('browser_push_notifications_enabled', 'bool'),
      ('appointment_reminder_hours_before', 'int4'),
      ('second_reminder_hours_before', 'int4'),
      ('date_format', 'text'),
      ('time_format', 'text'),
      ('records_per_page', 'int4'),
      ('dashboard_refresh_seconds', 'int4'),
      ('created_at', 'timestamptz'),
      ('updated_at', 'timestamptz'),
      ('updated_by', 'uuid')
    ) as expected(column_name, expected_type)
  loop
    select columns.udt_name
    into v_actual
    from information_schema.columns
    where columns.table_schema = 'public'
      and columns.table_name = 'system_settings'
      and columns.column_name = v_column.column_name;

    if v_actual is null or v_actual <> v_column.expected_type then
      raise exception 'Preflight failed: public.system_settings.% expected % but found %.',
        v_column.column_name,
        v_column.expected_type,
        coalesce(v_actual, 'missing');
    end if;
  end loop;
end;
$settings_schema_preflight$;

alter table public.system_settings enable row level security;

-- Browser roles receive no raw table privileges and no table policies.
-- SECURITY DEFINER RPCs owned by postgres are the only browser-facing path.
revoke all on table public.system_settings from public, anon, authenticated;
grant select, insert, update, delete on table public.system_settings to service_role;

-- The unique true guard makes this initialization idempotent and prevents
-- accidental duplicate authoritative rows. Existing settings are untouched.
insert into public.system_settings (singleton_guard)
values (true)
on conflict (singleton_guard) do nothing;

create or replace function public.get_admin_system_settings()
returns table (
  system_name text,
  clinic_name text,
  clinic_email text,
  contact_number text,
  clinic_address text,
  timezone text,
  clinic_opening_time time without time zone,
  clinic_closing_time time without time zone,
  default_appointment_duration_minutes integer,
  booking_interval_minutes integer,
  cancellation_window_hours integer,
  maximum_daily_appointments integer,
  appointment_reminders_enabled boolean,
  medication_reminder_alerts_enabled boolean,
  browser_push_notifications_enabled boolean,
  appointment_reminder_hours_before integer,
  second_reminder_hours_before integer,
  date_format text,
  time_format text,
  records_per_page integer,
  dashboard_refresh_seconds integer
)
language plpgsql
security definer
stable
set search_path to ''
as $function$
declare
  v_role text;
  v_account_status text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select
    pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))),
    pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text)))
  into v_role, v_account_status
  from public.profiles as profile
  where profile.id = auth.uid();

  if v_role is distinct from 'admin' or v_account_status is distinct from 'active' then
    raise exception 'An active Admin account is required.' using errcode = '42501';
  end if;

  return query
  select
    settings.system_name,
    settings.clinic_name,
    settings.clinic_email,
    settings.contact_number,
    settings.clinic_address,
    settings.timezone,
    settings.clinic_opening_time,
    settings.clinic_closing_time,
    settings.default_appointment_duration_minutes,
    settings.booking_interval_minutes,
    settings.cancellation_window_hours,
    settings.maximum_daily_appointments,
    settings.appointment_reminders_enabled,
    settings.medication_reminder_alerts_enabled,
    settings.browser_push_notifications_enabled,
    settings.appointment_reminder_hours_before,
    settings.second_reminder_hours_before,
    settings.date_format,
    settings.time_format,
    settings.records_per_page,
    settings.dashboard_refresh_seconds
  from public.system_settings as settings
  where settings.singleton_guard = true;
end;
$function$;

create or replace function public.update_admin_system_settings(
  p_section text,
  p_system_name text,
  p_clinic_name text,
  p_clinic_email text,
  p_contact_number text,
  p_clinic_address text,
  p_timezone text,
  p_clinic_opening_time time without time zone,
  p_clinic_closing_time time without time zone,
  p_default_appointment_duration_minutes integer,
  p_booking_interval_minutes integer,
  p_cancellation_window_hours integer,
  p_maximum_daily_appointments integer,
  p_appointment_reminders_enabled boolean,
  p_medication_reminder_alerts_enabled boolean,
  p_browser_push_notifications_enabled boolean,
  p_appointment_reminder_hours_before integer,
  p_second_reminder_hours_before integer,
  p_date_format text,
  p_time_format text,
  p_records_per_page integer,
  p_dashboard_refresh_seconds integer
)
returns table (
  system_name text,
  clinic_name text,
  clinic_email text,
  contact_number text,
  clinic_address text,
  timezone text,
  clinic_opening_time time without time zone,
  clinic_closing_time time without time zone,
  default_appointment_duration_minutes integer,
  booking_interval_minutes integer,
  cancellation_window_hours integer,
  maximum_daily_appointments integer,
  appointment_reminders_enabled boolean,
  medication_reminder_alerts_enabled boolean,
  browser_push_notifications_enabled boolean,
  appointment_reminder_hours_before integer,
  second_reminder_hours_before integer,
  date_format text,
  time_format text,
  records_per_page integer,
  dashboard_refresh_seconds integer
)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_role text;
  v_account_status text;
  v_section text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_section, ''::text)));
  v_system_name text := pg_catalog.btrim(coalesce(p_system_name, ''::text));
  v_clinic_name text := pg_catalog.btrim(coalesce(p_clinic_name, ''::text));
  v_clinic_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_clinic_email, ''::text)));
  v_contact_number text := pg_catalog.btrim(coalesce(p_contact_number, ''::text));
  v_clinic_address text := pg_catalog.btrim(coalesce(p_clinic_address, ''::text));
  v_timezone text := pg_catalog.btrim(coalesce(p_timezone, ''::text));
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select
    pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))),
    pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text)))
  into v_role, v_account_status
  from public.profiles as profile
  where profile.id = auth.uid();

  if v_role is distinct from 'admin' or v_account_status is distinct from 'active' then
    raise exception 'An active Admin account is required.' using errcode = '42501';
  end if;

  if v_section not in ('general', 'appointments', 'notifications', 'preferences') then
    raise exception 'Unsupported settings section.' using errcode = '22023';
  end if;

  if pg_catalog.char_length(v_system_name) not between 1 and 160 then
    raise exception 'System name must contain between 1 and 160 characters.' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_clinic_name) not between 1 and 160 then
    raise exception 'Clinic name must contain between 1 and 160 characters.' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_clinic_email) > 254
     or (v_clinic_email <> '' and v_clinic_email !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$') then
    raise exception 'Clinic email is invalid.' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_contact_number) > 50 then
    raise exception 'Contact number cannot exceed 50 characters.' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_clinic_address) > 500 then
    raise exception 'Clinic address cannot exceed 500 characters.' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_timezone) not between 1 and 80 then
    raise exception 'Timezone must contain between 1 and 80 characters.' using errcode = '22023';
  end if;

  if p_clinic_opening_time is null or p_clinic_closing_time is null
     or p_clinic_closing_time <= p_clinic_opening_time then
    raise exception 'Clinic closing time must be later than opening time.' using errcode = '22023';
  end if;
  if p_default_appointment_duration_minutes is null
     or p_default_appointment_duration_minutes not between 15 and 240 then
    raise exception 'Default appointment duration must be between 15 and 240 minutes.' using errcode = '22023';
  end if;
  if p_booking_interval_minutes is null or p_booking_interval_minutes not between 5 and 240 then
    raise exception 'Booking interval must be between 5 and 240 minutes.' using errcode = '22023';
  end if;
  if p_cancellation_window_hours is null or p_cancellation_window_hours not between 0 and 168 then
    raise exception 'Cancellation window must be between 0 and 168 hours.' using errcode = '22023';
  end if;
  if p_maximum_daily_appointments is null or p_maximum_daily_appointments not between 1 and 500 then
    raise exception 'Maximum daily appointments must be between 1 and 500.' using errcode = '22023';
  end if;

  if p_appointment_reminders_enabled is null
     or p_medication_reminder_alerts_enabled is null
     or p_browser_push_notifications_enabled is null then
    raise exception 'Notification enabled values are required.' using errcode = '22023';
  end if;
  if p_appointment_reminder_hours_before is null
     or p_appointment_reminder_hours_before not between 1 and 168 then
    raise exception 'Appointment reminder timing must be between 1 and 168 hours.' using errcode = '22023';
  end if;
  if p_second_reminder_hours_before is not null
     and (
       p_second_reminder_hours_before not between 1 and 168
       or p_second_reminder_hours_before >= p_appointment_reminder_hours_before
     ) then
    raise exception 'Second reminder timing must be positive and earlier than the primary reminder window.' using errcode = '22023';
  end if;

  if p_date_format is null or p_date_format not in ('MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD') then
    raise exception 'Unsupported date format.' using errcode = '22023';
  end if;
  if p_time_format is null or p_time_format not in ('12-hour', '24-hour') then
    raise exception 'Unsupported time format.' using errcode = '22023';
  end if;
  if p_records_per_page is null or p_records_per_page not in (10, 20, 50, 100) then
    raise exception 'Unsupported records-per-page value.' using errcode = '22023';
  end if;
  if p_dashboard_refresh_seconds is null or p_dashboard_refresh_seconds not in (30, 60, 300) then
    raise exception 'Unsupported dashboard refresh interval.' using errcode = '22023';
  end if;

  return query
  update public.system_settings as settings
  set
    system_name = case when v_section = 'general' then v_system_name else settings.system_name end,
    clinic_name = case when v_section = 'general' then v_clinic_name else settings.clinic_name end,
    clinic_email = case when v_section = 'general' then v_clinic_email else settings.clinic_email end,
    contact_number = case when v_section = 'general' then v_contact_number else settings.contact_number end,
    clinic_address = case when v_section = 'general' then v_clinic_address else settings.clinic_address end,
    timezone = case when v_section = 'general' then v_timezone else settings.timezone end,
    clinic_opening_time = case when v_section = 'appointments' then p_clinic_opening_time else settings.clinic_opening_time end,
    clinic_closing_time = case when v_section = 'appointments' then p_clinic_closing_time else settings.clinic_closing_time end,
    default_appointment_duration_minutes = case when v_section = 'appointments' then p_default_appointment_duration_minutes else settings.default_appointment_duration_minutes end,
    booking_interval_minutes = case when v_section = 'appointments' then p_booking_interval_minutes else settings.booking_interval_minutes end,
    cancellation_window_hours = case when v_section = 'appointments' then p_cancellation_window_hours else settings.cancellation_window_hours end,
    maximum_daily_appointments = case when v_section = 'appointments' then p_maximum_daily_appointments else settings.maximum_daily_appointments end,
    appointment_reminders_enabled = case when v_section = 'notifications' then p_appointment_reminders_enabled else settings.appointment_reminders_enabled end,
    medication_reminder_alerts_enabled = case when v_section = 'notifications' then p_medication_reminder_alerts_enabled else settings.medication_reminder_alerts_enabled end,
    browser_push_notifications_enabled = case when v_section = 'notifications' then p_browser_push_notifications_enabled else settings.browser_push_notifications_enabled end,
    appointment_reminder_hours_before = case when v_section = 'notifications' then p_appointment_reminder_hours_before else settings.appointment_reminder_hours_before end,
    second_reminder_hours_before = case when v_section = 'notifications' then p_second_reminder_hours_before else settings.second_reminder_hours_before end,
    date_format = case when v_section = 'preferences' then p_date_format else settings.date_format end,
    time_format = case when v_section = 'preferences' then p_time_format else settings.time_format end,
    records_per_page = case when v_section = 'preferences' then p_records_per_page else settings.records_per_page end,
    dashboard_refresh_seconds = case when v_section = 'preferences' then p_dashboard_refresh_seconds else settings.dashboard_refresh_seconds end,
    updated_at = pg_catalog.now(),
    updated_by = auth.uid()
  where settings.singleton_guard = true
  returning
    settings.system_name,
    settings.clinic_name,
    settings.clinic_email,
    settings.contact_number,
    settings.clinic_address,
    settings.timezone,
    settings.clinic_opening_time,
    settings.clinic_closing_time,
    settings.default_appointment_duration_minutes,
    settings.booking_interval_minutes,
    settings.cancellation_window_hours,
    settings.maximum_daily_appointments,
    settings.appointment_reminders_enabled,
    settings.medication_reminder_alerts_enabled,
    settings.browser_push_notifications_enabled,
    settings.appointment_reminder_hours_before,
    settings.second_reminder_hours_before,
    settings.date_format,
    settings.time_format,
    settings.records_per_page,
    settings.dashboard_refresh_seconds;

  if not found then
    raise exception 'The authoritative settings record is unavailable.' using errcode = '55000';
  end if;
end;
$function$;

alter function public.get_admin_system_settings() owner to postgres;
alter function public.update_admin_system_settings(
  text, text, text, text, text, text, text,
  time without time zone, time without time zone,
  integer, integer, integer, integer,
  boolean, boolean, boolean,
  integer, integer, text, text, integer, integer
) owner to postgres;

revoke all on function public.get_admin_system_settings()
  from public, anon, authenticated;
grant execute on function public.get_admin_system_settings()
  to authenticated, service_role;

revoke all on function public.update_admin_system_settings(
  text, text, text, text, text, text, text,
  time without time zone, time without time zone,
  integer, integer, integer, integer,
  boolean, boolean, boolean,
  integer, integer, text, text, integer, integer
) from public, anon, authenticated;
grant execute on function public.update_admin_system_settings(
  text, text, text, text, text, text, text,
  time without time zone, time without time zone,
  integer, integer, integer, integer,
  boolean, boolean, boolean,
  integer, integer, text, text, integer, integer
) to authenticated, service_role;

comment on function public.get_admin_system_settings() is
  'Returns approved operational settings to an authenticated active Admin.';
comment on function public.update_admin_system_settings(
  text, text, text, text, text, text, text,
  time without time zone, time without time zone,
  integer, integer, integer, integer,
  boolean, boolean, boolean,
  integer, integer, text, text, integer, integer
) is 'Updates one approved settings section for an authenticated active Admin and returns the safe settings record.';

select pg_catalog.pg_notify('pgrst', 'reload schema');

commit;

-- ============================================================
-- Commented verification queries (read-only; run after review/install)
-- ============================================================
-- 1. Confirm the table exists and RLS is enabled.
-- select relation.oid::pg_catalog.regclass as table_name,
--        relation.relrowsecurity,
--        relation.relforcerowsecurity
-- from pg_catalog.pg_class as relation
-- where relation.oid = 'public.system_settings'::pg_catalog.regclass;
--
-- 2. Inspect effective table grants. anon/authenticated must have no direct
--    INSERT, SELECT, UPDATE, or DELETE privilege.
-- select grantee, privilege_type
-- from information_schema.role_table_grants
-- where table_schema = 'public' and table_name = 'system_settings'
-- order by grantee, privilege_type;
--
-- select
--   pg_catalog.has_table_privilege('anon', 'public.system_settings', 'select,insert,update,delete') as anon_has_crud,
--   pg_catalog.has_table_privilege('authenticated', 'public.system_settings', 'select,insert,update,delete') as authenticated_has_crud;
--
-- 3. Inspect policies. Expect no browser-facing table policies.
-- select schemaname, tablename, policyname, roles, cmd, qual, with_check
-- from pg_catalog.pg_policies
-- where schemaname = 'public' and tablename = 'system_settings';
--
-- 4. Confirm both exact signatures, postgres ownership, SECURITY DEFINER,
--    and an empty search_path.
-- select routine.oid::pg_catalog.regprocedure as signature,
--        pg_catalog.pg_get_function_result(routine.oid) as result_type,
--        routine.prosecdef,
--        routine.proconfig,
--        pg_catalog.pg_get_userbyid(routine.proowner) as owner
-- from pg_catalog.pg_proc as routine
-- join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
-- where namespace.nspname = 'public'
--   and routine.proname in ('get_admin_system_settings', 'update_admin_system_settings')
-- order by routine.proname;
--
-- 5. Inspect function execution privileges. PUBLIC and anon must not have
--    EXECUTE; authenticated and service_role may execute, with authorization
--    still enforced inside each function.
-- select routine.oid::pg_catalog.regprocedure as signature,
--        case
--          when privilege.grantee = 0 then 'PUBLIC'
--          else pg_catalog.pg_get_userbyid(privilege.grantee)
--        end as grantee,
--        privilege.privilege_type
-- from pg_catalog.pg_proc as routine
-- join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
-- cross join lateral pg_catalog.aclexplode(
--   coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
-- ) as privilege
-- where namespace.nspname = 'public'
--   and routine.proname in ('get_admin_system_settings', 'update_admin_system_settings')
-- order by routine.proname, privilege.grantee;
--
-- 6. Inspect the function definitions for the explicit auth.uid(), normalized
--    Admin role/account_status checks, and typed update assignments.
-- select routine.oid::pg_catalog.regprocedure as signature,
--        pg_catalog.pg_get_functiondef(routine.oid) as definition
-- from pg_catalog.pg_proc as routine
-- join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
-- where namespace.nspname = 'public'
--   and routine.proname in ('get_admin_system_settings', 'update_admin_system_settings');
--
-- 7. Confirm exactly one authoritative row and a true singleton guard.
-- select pg_catalog.count(*) as settings_record_count,
--        pg_catalog.bool_and(singleton_guard) as all_guards_true
-- from public.system_settings;
