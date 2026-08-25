-- ============================================================
-- Maternal Care - Patient Web Push subscriptions (Phase 3A)
-- ============================================================
-- Review this file and run it manually in the Supabase SQL Editor.
-- It creates the device-subscription foundation only. It does not
-- send Web Push messages, create an Edge Function, or add a webhook.
--
-- Read-only preflight queries:
--
-- select column_name, data_type, udt_schema, udt_name
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name = 'patients'
--   and column_name in ('id', 'user_id', 'account_status', 'archived_at', 'status')
-- order by ordinal_position;
--
-- select to_regclass('public.patient_push_subscriptions') as existing_table;
--
-- select n.nspname as function_schema, p.proname, pg_get_function_identity_arguments(p.oid)
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public'
--   and p.proname in (
--     'upsert_my_patient_push_subscription',
--     'deactivate_my_patient_push_subscription'
--   );
--
-- Expected relationship and types:
--   public.patients.id      uuid
--   public.patients.user_id uuid -> auth.users.id
-- ============================================================

begin;

create table if not exists public.patient_push_subscriptions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  patient_id uuid not null,
  user_id uuid not null,
  endpoint text not null,
  p256dh text not null,
  auth_key text not null,
  expiration_time bigint,
  user_agent text,
  device_label text,
  is_active boolean not null default true,
  last_seen_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint patient_push_subscriptions_patient_id_fkey
    foreign key (patient_id)
    references public.patients(id)
    on delete cascade,
  constraint patient_push_subscriptions_user_id_fkey
    foreign key (user_id)
    references auth.users(id)
    on delete cascade,
  constraint patient_push_subscriptions_endpoint_check
    check (
      endpoint = pg_catalog.btrim(endpoint)
      and pg_catalog.char_length(endpoint) between 12 and 2048
      and endpoint ~ '^https://'
    ),
  constraint patient_push_subscriptions_p256dh_check
    check (
      p256dh = pg_catalog.btrim(p256dh)
      and pg_catalog.char_length(p256dh) between 16 and 512
    ),
  constraint patient_push_subscriptions_auth_key_check
    check (
      auth_key = pg_catalog.btrim(auth_key)
      and pg_catalog.char_length(auth_key) between 8 and 256
    ),
  constraint patient_push_subscriptions_expiration_check
    check (expiration_time is null or expiration_time >= 0),
  constraint patient_push_subscriptions_user_agent_check
    check (
      user_agent is null
      or (
        user_agent = pg_catalog.btrim(user_agent)
        and pg_catalog.char_length(user_agent) between 1 and 1024
      )
    ),
  constraint patient_push_subscriptions_device_label_check
    check (
      device_label is null
      or (
        device_label = pg_catalog.btrim(device_label)
        and pg_catalog.char_length(device_label) between 1 and 120
      )
    )
);

comment on table public.patient_push_subscriptions is
  'Patient-owned Web Push device subscriptions. Endpoints and encryption keys are sensitive.';
comment on column public.patient_push_subscriptions.endpoint is
  'Push-service endpoint for one browser subscription. Never expose it to other users.';
comment on column public.patient_push_subscriptions.p256dh is
  'Browser PushSubscription p256dh public encryption key.';
comment on column public.patient_push_subscriptions.auth_key is
  'Browser PushSubscription authentication secret.';

create unique index if not exists patient_push_subscriptions_endpoint_uidx
  on public.patient_push_subscriptions (endpoint);

create index if not exists patient_push_subscriptions_patient_active_idx
  on public.patient_push_subscriptions (patient_id, is_active, updated_at desc);

create index if not exists patient_push_subscriptions_user_active_idx
  on public.patient_push_subscriptions (user_id, is_active, updated_at desc);

create or replace function public.set_patient_push_subscriptions_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;

drop trigger if exists patient_push_subscriptions_set_updated_at
  on public.patient_push_subscriptions;

create trigger patient_push_subscriptions_set_updated_at
before update on public.patient_push_subscriptions
for each row
execute function public.set_patient_push_subscriptions_updated_at();

alter table public.patient_push_subscriptions enable row level security;

drop policy if exists "Patients can read own push subscriptions"
  on public.patient_push_subscriptions;

create policy "Patients can read own push subscriptions"
on public.patient_push_subscriptions
for select
to authenticated
using (
  patient_push_subscriptions.user_id = auth.uid()
  and exists (
    select 1
    from public.patients as patient
    where patient.id = patient_push_subscriptions.patient_id
      and patient.user_id = auth.uid()
      and patient.account_status = 'active'
      and patient.archived_at is null
      and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.status, '')))
        not in ('archived', 'deleted')
  )
);

revoke all on public.patient_push_subscriptions from public, anon, authenticated;
grant select on public.patient_push_subscriptions to authenticated;

create or replace function public.upsert_my_patient_push_subscription(
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
  v_patient_id uuid;
  v_endpoint text := pg_catalog.btrim(coalesce(p_endpoint, ''));
  v_p256dh text := pg_catalog.btrim(coalesce(p_p256dh, ''));
  v_auth_key text := pg_catalog.btrim(coalesce(p_auth_key, ''));
  v_user_agent text := nullif(
    pg_catalog.btrim(coalesce(p_user_agent, '')),
    ''
  );
  v_device_label text := nullif(
    pg_catalog.btrim(coalesce(p_device_label, '')),
    ''
  );
  v_subscription_id uuid;
  v_last_seen_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;

  begin
    select patient.id
    into strict v_patient_id
    from public.patients as patient
    where patient.user_id = auth.uid()
      and patient.account_status = 'active'
      and patient.archived_at is null
      and pg_catalog.lower(pg_catalog.btrim(coalesce(patient.status, '')))
        not in ('archived', 'deleted');
  exception
    when no_data_found then
      raise exception 'An active linked Patient account is required.'
        using errcode = '42501';
    when too_many_rows then
      raise exception 'Multiple active Patient records are linked to this account.'
        using errcode = 'P0001';
  end;

  if pg_catalog.char_length(v_endpoint) < 12
     or pg_catalog.char_length(v_endpoint) > 2048
     or v_endpoint !~ '^https://' then
    raise exception 'A valid HTTPS push endpoint is required.'
      using errcode = '22023';
  end if;

  if pg_catalog.char_length(v_p256dh) < 16
     or pg_catalog.char_length(v_p256dh) > 512 then
    raise exception 'The p256dh subscription key is invalid.'
      using errcode = '22023';
  end if;

  if pg_catalog.char_length(v_auth_key) < 8
     or pg_catalog.char_length(v_auth_key) > 256 then
    raise exception 'The auth subscription key is invalid.'
      using errcode = '22023';
  end if;

  if p_expiration_time is not null and p_expiration_time < 0 then
    raise exception 'The subscription expiration time is invalid.'
      using errcode = '22023';
  end if;

  if v_user_agent is not null
     and pg_catalog.char_length(v_user_agent) > 1024 then
    raise exception 'The user agent is too long.'
      using errcode = '22023';
  end if;

  if v_device_label is not null
     and pg_catalog.char_length(v_device_label) > 120 then
    raise exception 'The device label is too long.'
      using errcode = '22023';
  end if;

  insert into public.patient_push_subscriptions (
    patient_id,
    user_id,
    endpoint,
    p256dh,
    auth_key,
    expiration_time,
    user_agent,
    device_label,
    is_active,
    last_seen_at
  )
  values (
    v_patient_id,
    auth.uid(),
    v_endpoint,
    v_p256dh,
    v_auth_key,
    p_expiration_time,
    v_user_agent,
    v_device_label,
    true,
    pg_catalog.now()
  )
  on conflict (endpoint)
  do update set
    patient_id = excluded.patient_id,
    user_id = excluded.user_id,
    p256dh = excluded.p256dh,
    auth_key = excluded.auth_key,
    expiration_time = excluded.expiration_time,
    user_agent = excluded.user_agent,
    device_label = excluded.device_label,
    is_active = true,
    last_seen_at = pg_catalog.now()
  returning id, last_seen_at
  into v_subscription_id, v_last_seen_at;

  return pg_catalog.jsonb_build_object(
    'enabled', true,
    'subscription_id', v_subscription_id,
    'last_seen_at', v_last_seen_at
  );
end;
$function$;

create or replace function public.deactivate_my_patient_push_subscription(
  p_endpoint text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_endpoint text := pg_catalog.btrim(coalesce(p_endpoint, ''));
  v_subscription_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;

  if pg_catalog.char_length(v_endpoint) < 12
     or pg_catalog.char_length(v_endpoint) > 2048
     or v_endpoint !~ '^https://' then
    raise exception 'A valid HTTPS push endpoint is required.'
      using errcode = '22023';
  end if;

  update public.patient_push_subscriptions as subscription
  set
    is_active = false,
    updated_at = pg_catalog.now()
  where subscription.endpoint = v_endpoint
    and subscription.user_id = auth.uid()
  returning subscription.id
  into v_subscription_id;

  return pg_catalog.jsonb_build_object(
    'enabled', false,
    'found', v_subscription_id is not null
  );
end;
$function$;

revoke all on function public.upsert_my_patient_push_subscription(
  text,
  text,
  text,
  bigint,
  text,
  text
) from public, anon, authenticated;
grant execute on function public.upsert_my_patient_push_subscription(
  text,
  text,
  text,
  bigint,
  text,
  text
) to authenticated;

revoke all on function public.deactivate_my_patient_push_subscription(text)
  from public, anon, authenticated;
grant execute on function public.deactivate_my_patient_push_subscription(text)
  to authenticated;

revoke all on function public.set_patient_push_subscriptions_updated_at()
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
