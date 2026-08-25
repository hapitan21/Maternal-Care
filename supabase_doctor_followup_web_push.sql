-- ============================================================
-- Maternal Care - Doctor follow-up Web Push (Phase 5B.5)
-- ============================================================
-- REVIEW ONLY. Run this file manually in the Supabase SQL Editor only
-- after reviewing the installed Phase 5B.4 and Patient Web Push schemas.
-- This migration does not create a Database Webhook, deploy an Edge
-- Function, configure secrets, send notifications, or change Patient data.
--
-- Read-only preflight queries:
--
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name in ('profiles', 'doctor_notifications')
-- order by table_name, ordinal_position;
--
-- select conname, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid in (
--   'public.profiles'::regclass,
--   'public.doctor_notifications'::regclass
-- )
-- order by conrelid::regclass::text, conname;
--
-- select to_regclass('public.patient_push_subscriptions') as patient_subscriptions,
--        to_regclass('public.patient_notification_push_deliveries') as patient_deliveries,
--        to_regclass('public.doctor_push_subscriptions') as doctor_subscriptions,
--        to_regclass('public.doctor_notification_push_deliveries') as doctor_deliveries;
--
-- select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
--        p.prosecdef, p.proconfig
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public'
--   and p.proname in (
--     'upsert_my_patient_push_subscription',
--     'deactivate_my_patient_push_subscription',
--     'upsert_my_doctor_push_subscription',
--     'deactivate_my_doctor_push_subscription',
--     'claim_doctor_notification_push_delivery'
--   )
-- order by p.proname;
-- ============================================================

begin;

create table if not exists public.doctor_push_subscriptions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  doctor_id uuid not null,
  endpoint text not null,
  p256dh text not null,
  auth_key text not null,
  expiration_time bigint,
  user_agent text,
  device_label text,
  is_active boolean not null default true,
  last_seen_at timestamptz not null default pg_catalog.now(),
  last_success_at timestamptz,
  failure_count integer not null default 0,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint doctor_push_subscriptions_doctor_id_fkey
    foreign key (doctor_id)
    references public.profiles(id)
    on delete cascade,
  constraint doctor_push_subscriptions_endpoint_check
    check (
      endpoint = pg_catalog.btrim(endpoint)
      and pg_catalog.char_length(endpoint) between 12 and 2048
      and endpoint ~ '^https://'
    ),
  constraint doctor_push_subscriptions_p256dh_check
    check (
      p256dh = pg_catalog.btrim(p256dh)
      and pg_catalog.char_length(p256dh) between 16 and 512
    ),
  constraint doctor_push_subscriptions_auth_key_check
    check (
      auth_key = pg_catalog.btrim(auth_key)
      and pg_catalog.char_length(auth_key) between 8 and 256
    ),
  constraint doctor_push_subscriptions_expiration_check
    check (expiration_time is null or expiration_time >= 0),
  constraint doctor_push_subscriptions_user_agent_check
    check (
      user_agent is null
      or (
        user_agent = pg_catalog.btrim(user_agent)
        and pg_catalog.char_length(user_agent) between 1 and 1024
      )
    ),
  constraint doctor_push_subscriptions_device_label_check
    check (
      device_label is null
      or (
        device_label = pg_catalog.btrim(device_label)
        and pg_catalog.char_length(device_label) between 1 and 120
      )
    ),
  constraint doctor_push_subscriptions_failure_count_check
    check (failure_count >= 0)
);

comment on table public.doctor_push_subscriptions is
  'Doctor-owned Web Push device subscriptions. Endpoints and encryption keys are sensitive.';
comment on column public.doctor_push_subscriptions.endpoint is
  'Unique push-service endpoint for one Doctor browser subscription.';
comment on column public.doctor_push_subscriptions.p256dh is
  'Browser PushSubscription p256dh public encryption key.';
comment on column public.doctor_push_subscriptions.auth_key is
  'Browser PushSubscription authentication secret.';

create unique index if not exists doctor_push_subscriptions_endpoint_uidx
  on public.doctor_push_subscriptions (endpoint);

create index if not exists doctor_push_subscriptions_doctor_active_idx
  on public.doctor_push_subscriptions (
    doctor_id,
    is_active,
    updated_at desc
  );

create or replace function public.set_doctor_push_subscriptions_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;

drop trigger if exists doctor_push_subscriptions_set_updated_at
  on public.doctor_push_subscriptions;

create trigger doctor_push_subscriptions_set_updated_at
before update on public.doctor_push_subscriptions
for each row
execute function public.set_doctor_push_subscriptions_updated_at();

alter table public.doctor_push_subscriptions enable row level security;

drop policy if exists "Active Doctors can read own push subscriptions"
  on public.doctor_push_subscriptions;
create policy "Active Doctors can read own push subscriptions"
on public.doctor_push_subscriptions
for select
to authenticated
using (
  doctor_push_subscriptions.doctor_id = auth.uid()
  and exists (
    select 1
    from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(
        pg_catalog.btrim(coalesce(profile.role, ''::text))
      ) = 'doctor'
      and pg_catalog.lower(
        pg_catalog.btrim(coalesce(profile.account_status, ''::text))
      ) = 'active'
  )
);

-- Direct writes remain revoked. These ownership policies are defense in depth
-- if table privileges are ever changed; normal writes use the secure RPCs.
drop policy if exists "Active Doctors can insert own push subscriptions"
  on public.doctor_push_subscriptions;
create policy "Active Doctors can insert own push subscriptions"
on public.doctor_push_subscriptions
for insert
to authenticated
with check (
  doctor_push_subscriptions.doctor_id = auth.uid()
  and exists (
    select 1
    from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  )
);

drop policy if exists "Active Doctors can update own push subscriptions"
  on public.doctor_push_subscriptions;
create policy "Active Doctors can update own push subscriptions"
on public.doctor_push_subscriptions
for update
to authenticated
using (
  doctor_push_subscriptions.doctor_id = auth.uid()
  and exists (
    select 1
    from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  )
)
with check (doctor_push_subscriptions.doctor_id = auth.uid());

drop policy if exists "Active Doctors can delete own push subscriptions"
  on public.doctor_push_subscriptions;
create policy "Active Doctors can delete own push subscriptions"
on public.doctor_push_subscriptions
for delete
to authenticated
using (
  doctor_push_subscriptions.doctor_id = auth.uid()
  and exists (
    select 1
    from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  )
);

revoke all on public.doctor_push_subscriptions
  from public, anon, authenticated;
grant select on public.doctor_push_subscriptions to authenticated;
grant select, update on public.doctor_push_subscriptions to service_role;

create or replace function public.upsert_my_doctor_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth_key text,
  p_expiration_time bigint default null,
  p_user_agent text default null,
  p_device_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_doctor_id uuid;
  v_endpoint text := pg_catalog.btrim(coalesce(p_endpoint, ''::text));
  v_p256dh text := pg_catalog.btrim(coalesce(p_p256dh, ''::text));
  v_auth_key text := pg_catalog.btrim(coalesce(p_auth_key, ''::text));
  v_user_agent text := nullif(pg_catalog.btrim(coalesce(p_user_agent, ''::text)), '');
  v_device_label text := nullif(pg_catalog.btrim(coalesce(p_device_label, ''::text)), '');
  v_subscription_id uuid;
  v_last_seen_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select profile.id
  into v_doctor_id
  from public.profiles as profile
  where profile.id = auth.uid()
    and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
    and pg_catalog.lower(
      pg_catalog.btrim(coalesce(profile.account_status, ''::text))
    ) = 'active';

  if v_doctor_id is null then
    raise exception 'An active Doctor account is required.' using errcode = '42501';
  end if;

  if pg_catalog.char_length(v_endpoint) < 12
     or pg_catalog.char_length(v_endpoint) > 2048
     or v_endpoint !~ '^https://' then
    raise exception 'A valid HTTPS push endpoint is required.' using errcode = '22023';
  end if;

  if pg_catalog.char_length(v_p256dh) < 16
     or pg_catalog.char_length(v_p256dh) > 512 then
    raise exception 'The p256dh subscription key is invalid.' using errcode = '22023';
  end if;

  if pg_catalog.char_length(v_auth_key) < 8
     or pg_catalog.char_length(v_auth_key) > 256 then
    raise exception 'The auth subscription key is invalid.' using errcode = '22023';
  end if;

  if p_expiration_time is not null and p_expiration_time < 0 then
    raise exception 'The subscription expiration time is invalid.' using errcode = '22023';
  end if;

  if v_user_agent is not null and pg_catalog.char_length(v_user_agent) > 1024 then
    raise exception 'The user agent is too long.' using errcode = '22023';
  end if;

  if v_device_label is not null and pg_catalog.char_length(v_device_label) > 120 then
    raise exception 'The device label is too long.' using errcode = '22023';
  end if;

  insert into public.doctor_push_subscriptions (
    doctor_id,
    endpoint,
    p256dh,
    auth_key,
    expiration_time,
    user_agent,
    device_label,
    is_active,
    last_seen_at,
    failure_count
  )
  values (
    v_doctor_id,
    v_endpoint,
    v_p256dh,
    v_auth_key,
    p_expiration_time,
    v_user_agent,
    v_device_label,
    true,
    pg_catalog.now(),
    0
  )
  on conflict (endpoint)
  do update set
    p256dh = excluded.p256dh,
    auth_key = excluded.auth_key,
    expiration_time = excluded.expiration_time,
    user_agent = excluded.user_agent,
    device_label = excluded.device_label,
    is_active = true,
    last_seen_at = pg_catalog.now(),
    failure_count = 0
  where doctor_push_subscriptions.doctor_id = auth.uid()
  returning id, last_seen_at
  into v_subscription_id, v_last_seen_at;

  if v_subscription_id is null then
    raise exception 'This push endpoint belongs to another Doctor account.'
      using errcode = '42501';
  end if;

  return pg_catalog.jsonb_build_object(
    'enabled', true,
    'subscription_id', v_subscription_id,
    'last_seen_at', v_last_seen_at
  );
end;
$function$;

create or replace function public.deactivate_my_doctor_push_subscription(
  p_endpoint text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_endpoint text := pg_catalog.btrim(coalesce(p_endpoint, ''::text));
  v_subscription_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
      and pg_catalog.lower(
        pg_catalog.btrim(coalesce(profile.account_status, ''::text))
      ) = 'active'
  ) then
    raise exception 'An active Doctor account is required.' using errcode = '42501';
  end if;

  if pg_catalog.char_length(v_endpoint) < 12
     or pg_catalog.char_length(v_endpoint) > 2048
     or v_endpoint !~ '^https://' then
    raise exception 'A valid HTTPS push endpoint is required.' using errcode = '22023';
  end if;

  update public.doctor_push_subscriptions as subscription
  set is_active = false
  where subscription.endpoint = v_endpoint
    and subscription.doctor_id = auth.uid()
  returning subscription.id into v_subscription_id;

  return pg_catalog.jsonb_build_object(
    'enabled', false,
    'found', v_subscription_id is not null
  );
end;
$function$;

revoke all on function public.upsert_my_doctor_push_subscription(
  text, text, text, bigint, text, text
) from public, anon, authenticated;
grant execute on function public.upsert_my_doctor_push_subscription(
  text, text, text, bigint, text, text
) to authenticated;

revoke all on function public.deactivate_my_doctor_push_subscription(text)
  from public, anon, authenticated;
grant execute on function public.deactivate_my_doctor_push_subscription(text)
  to authenticated;

revoke all on function public.set_doctor_push_subscriptions_updated_at()
  from public, anon, authenticated;

create table if not exists public.doctor_notification_push_deliveries (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  doctor_notification_id uuid not null,
  doctor_push_subscription_id uuid not null,
  doctor_id uuid not null,
  status text not null default 'processing',
  attempt_count integer not null default 1,
  provider_status integer,
  error_code text,
  error_message text,
  last_attempted_at timestamptz not null default pg_catalog.now(),
  sent_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint doctor_notification_push_deliveries_notification_fkey
    foreign key (doctor_notification_id)
    references public.doctor_notifications(id)
    on delete cascade,
  constraint doctor_notification_push_deliveries_subscription_fkey
    foreign key (doctor_push_subscription_id)
    references public.doctor_push_subscriptions(id)
    on delete restrict,
  constraint doctor_notification_push_deliveries_doctor_id_fkey
    foreign key (doctor_id)
    references public.profiles(id)
    on delete restrict,
  constraint doctor_notification_push_deliveries_unique
    unique (doctor_notification_id, doctor_push_subscription_id),
  constraint doctor_notification_push_deliveries_status_check
    check (
      status in (
        'processing',
        'sent',
        'retryable_failure',
        'permanent_failure',
        'expired'
      )
    ),
  constraint doctor_notification_push_deliveries_attempt_count_check
    check (attempt_count between 1 and 10),
  constraint doctor_notification_push_deliveries_provider_status_check
    check (provider_status is null or provider_status between 100 and 599),
  constraint doctor_notification_push_deliveries_error_code_check
    check (
      error_code is null
      or (
        error_code = pg_catalog.btrim(error_code)
        and pg_catalog.char_length(error_code) between 1 and 80
      )
    ),
  constraint doctor_notification_push_deliveries_error_message_check
    check (
      error_message is null
      or (
        error_message = pg_catalog.btrim(error_message)
        and pg_catalog.char_length(error_message) between 1 and 240
      )
    )
);

comment on table public.doctor_notification_push_deliveries is
  'Server-only idempotency and result ledger for Doctor follow-up Web Push attempts.';
comment on column public.doctor_notification_push_deliveries.error_message is
  'Sanitized operational summary only; never store endpoints, keys, clinical text, or provider response bodies.';

create index if not exists doctor_notification_push_deliveries_notification_status_idx
  on public.doctor_notification_push_deliveries (
    doctor_notification_id,
    status
  );

create index if not exists doctor_notification_push_deliveries_doctor_created_idx
  on public.doctor_notification_push_deliveries (
    doctor_id,
    created_at desc
  );

create or replace function public.set_doctor_notification_push_deliveries_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;

drop trigger if exists doctor_notification_push_deliveries_set_updated_at
  on public.doctor_notification_push_deliveries;

create trigger doctor_notification_push_deliveries_set_updated_at
before update on public.doctor_notification_push_deliveries
for each row
execute function public.set_doctor_notification_push_deliveries_updated_at();

alter table public.doctor_notification_push_deliveries enable row level security;

-- No browser RLS policy exists. Only service_role receives table privileges.
revoke all on public.doctor_notification_push_deliveries
  from public, anon, authenticated;
grant select, insert, update on public.doctor_notification_push_deliveries
  to service_role;

create or replace function public.claim_doctor_notification_push_delivery(
  p_notification_id uuid,
  p_subscription_id uuid,
  p_max_attempts integer default 5
)
returns table (
  delivery_id uuid,
  attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 10 then
    raise exception 'The delivery attempt limit must be between 1 and 10.'
      using errcode = '22023';
  end if;

  return query
  insert into public.doctor_notification_push_deliveries as delivery (
    doctor_notification_id,
    doctor_push_subscription_id,
    doctor_id,
    status,
    attempt_count,
    last_attempted_at
  )
  select
    notification.id,
    subscription.id,
    notification.doctor_id,
    'processing',
    1,
    pg_catalog.now()
  from public.doctor_notifications as notification
  join public.doctor_push_subscriptions as subscription
    on subscription.doctor_id = notification.doctor_id
   and subscription.id = p_subscription_id
   and subscription.is_active = true
  where notification.id = p_notification_id
    and notification.notification_type in (
      'medication_followup_due_today',
      'medication_followup_recently_overdue',
      'medication_followup_high',
      'medication_followup_critical'
    )
  on conflict (doctor_notification_id, doctor_push_subscription_id)
  do update set
    status = 'processing',
    attempt_count = delivery.attempt_count + 1,
    provider_status = null,
    error_code = null,
    error_message = null,
    last_attempted_at = pg_catalog.now()
  where delivery.status = 'retryable_failure'
    and delivery.attempt_count < p_max_attempts
  returning delivery.id, delivery.attempt_count;
end;
$function$;

revoke all on function public.claim_doctor_notification_push_delivery(
  uuid, uuid, integer
) from public, anon, authenticated;
grant execute on function public.claim_doctor_notification_push_delivery(
  uuid, uuid, integer
) to service_role;

revoke all on function public.set_doctor_notification_push_deliveries_updated_at()
  from public, anon, authenticated;

select pg_catalog.pg_notify('pgrst', 'reload schema');

commit;

-- ============================================================
-- Commented verification queries (run manually after installation)
-- ============================================================
-- 1. Confirm table ownership, RLS, policies, and privileges.
-- select c.relname, c.relrowsecurity
-- from pg_class c
-- join pg_namespace n on n.oid = c.relnamespace
-- where n.nspname = 'public'
--   and c.relname in (
--     'doctor_push_subscriptions',
--     'doctor_notification_push_deliveries'
--   );
--
-- select schemaname, tablename, policyname, roles, cmd, qual, with_check
-- from pg_policies
-- where schemaname = 'public'
--   and tablename in (
--     'doctor_push_subscriptions',
--     'doctor_notification_push_deliveries'
--   )
-- order by tablename, policyname;
--
-- select grantee, table_name, privilege_type
-- from information_schema.role_table_grants
-- where table_schema = 'public'
--   and table_name in (
--     'doctor_push_subscriptions',
--     'doctor_notification_push_deliveries'
--   )
-- order by table_name, grantee, privilege_type;
--
-- 2. Confirm endpoint uniqueness and multi-device support. Multiple distinct
-- endpoints may share one doctor_id; the same endpoint cannot be inserted twice.
-- select indexname, indexdef
-- from pg_indexes
-- where schemaname = 'public'
--   and tablename = 'doctor_push_subscriptions';
--
-- 3. Confirm the browser RPCs and server-only claim RPC retain protected paths.
-- select p.proname, pg_get_function_identity_arguments(p.oid), p.prosecdef,
--        p.proconfig, r.rolname as owner
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- join pg_roles r on r.oid = p.proowner
-- where n.nspname = 'public'
--   and p.proname in (
--     'upsert_my_doctor_push_subscription',
--     'deactivate_my_doctor_push_subscription',
--     'claim_doctor_notification_push_delivery'
--   )
-- order by p.proname;
--
-- 4. Confirm one delivery per notification/subscription and retry state support.
-- select conname, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid = 'public.doctor_notification_push_deliveries'::regclass
-- order by conname;
--
-- 5. As Doctor A, upsert two different browser endpoints and confirm both rows
-- are visible. As Doctor B, Staff, and Patient, confirm Doctor A's rows are not
-- visible and the upsert/deactivate RPCs reject non-Doctor callers.
--
-- 6. Confirm authenticated/anon cannot read or write delivery rows and cannot
-- execute claim_doctor_notification_push_delivery().
--
-- 7. Confirm sent and processing claims return zero rows on repeat. Change a
-- test row to retryable_failure below five attempts and confirm one reclaim;
-- confirm attempt five cannot be reclaimed.
--
-- 8. Confirm 404/410 handling from the Edge Function sets only the matching
-- subscription inactive and records expired. Confirm 429/5xx records
-- retryable_failure and leaves the subscription active.
--
-- 9. Confirm Phase 5B.4 behavior remains the eligibility source: an active
-- snooze or resolved follow-up creates no doctor_notifications row, therefore
-- there is no notification identifier for this delivery layer to claim.
-- Rescheduling creates a new dispatch cycle and notification ID; progression
-- to a new escalation level likewise creates a new eligible notification ID.
--
-- 10. Confirm no Patient table or notification was changed.
-- select to_regclass('public.patient_push_subscriptions'),
--        to_regclass('public.patient_notification_push_deliveries');
--
-- Rollback guidance (manual, only after impact review):
-- begin;
-- drop function if exists public.claim_doctor_notification_push_delivery(uuid, uuid, integer);
-- drop function if exists public.deactivate_my_doctor_push_subscription(text);
-- drop function if exists public.upsert_my_doctor_push_subscription(text, text, text, bigint, text, text);
-- drop table if exists public.doctor_notification_push_deliveries;
-- drop table if exists public.doctor_push_subscriptions;
-- drop function if exists public.set_doctor_notification_push_deliveries_updated_at();
-- drop function if exists public.set_doctor_push_subscriptions_updated_at();
-- commit;
