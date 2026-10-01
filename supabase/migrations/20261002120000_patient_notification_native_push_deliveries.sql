-- Server-only delivery claims and outcomes for Patient native Android push.

begin;

do $preflight$
begin
  if pg_catalog.to_regclass('public.patient_notifications') is null then
    raise exception 'Preflight failed: public.patient_notifications does not exist.';
  end if;

  if pg_catalog.to_regclass('public.patient_native_push_devices') is null then
    raise exception 'Preflight failed: public.patient_native_push_devices does not exist.';
  end if;

  if pg_catalog.to_regclass('public.patient_notification_native_push_deliveries') is not null then
    raise exception 'Preflight failed: public.patient_notification_native_push_deliveries already exists.';
  end if;
end;
$preflight$;

create table public.patient_notification_native_push_deliveries (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  notification_id uuid not null,
  device_id uuid not null,
  status text not null default 'processing',
  attempt_count integer not null default 1,
  fcm_http_status integer,
  error_code text,
  error_message text,
  provider_message_id text,
  attempted_at timestamptz not null default pg_catalog.now(),
  sent_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint patient_native_push_deliveries_notification_fkey
    foreign key (notification_id)
    references public.patient_notifications(id)
    on delete cascade,
  constraint patient_native_push_deliveries_device_fkey
    foreign key (device_id)
    references public.patient_native_push_devices(id)
    on delete cascade,
  constraint patient_native_push_deliveries_notification_device_key
    unique (notification_id, device_id),
  constraint patient_native_push_deliveries_status_check
    check (status in ('processing', 'sent', 'failed', 'disabled_token')),
  constraint patient_native_push_deliveries_attempt_count_check
    check (attempt_count >= 1),
  constraint patient_native_push_deliveries_fcm_http_status_check
    check (fcm_http_status is null or fcm_http_status between 100 and 599),
  constraint patient_native_push_deliveries_error_code_check
    check (
      error_code is null
      or (
        error_code = pg_catalog.btrim(error_code)
        and pg_catalog.char_length(error_code) between 1 and 80
      )
    ),
  constraint patient_native_push_deliveries_error_message_check
    check (
      error_message is null
      or (
        error_message = pg_catalog.btrim(error_message)
        and pg_catalog.char_length(error_message) between 1 and 240
      )
    ),
  constraint patient_native_push_deliveries_provider_message_id_check
    check (
      provider_message_id is null
      or (
        provider_message_id = pg_catalog.btrim(provider_message_id)
        and pg_catalog.char_length(provider_message_id) between 1 and 512
      )
    ),
  constraint patient_native_push_deliveries_sent_state_check
    check (
      (status = 'sent' and sent_at is not null)
      or (status <> 'sent' and sent_at is null)
    )
);

comment on table public.patient_notification_native_push_deliveries is
  'Server-only idempotency and result ledger for Patient native Android push delivery.';
comment on column public.patient_notification_native_push_deliveries.error_message is
  'Sanitized operational summary only; never store tokens, Patient data, notification content, credentials, or raw provider responses.';

create index patient_native_push_deliveries_notification_status_idx
  on public.patient_notification_native_push_deliveries (notification_id, status);

create or replace function public.set_patient_native_push_deliveries_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;

revoke all on function public.set_patient_native_push_deliveries_updated_at()
  from public, anon, authenticated;

create trigger patient_native_push_deliveries_set_updated_at
before update on public.patient_notification_native_push_deliveries
for each row
execute function public.set_patient_native_push_deliveries_updated_at();

alter table public.patient_notification_native_push_deliveries enable row level security;

revoke all privileges
on table public.patient_notification_native_push_deliveries
from public, anon, authenticated, service_role;

grant select, insert, update
on table public.patient_notification_native_push_deliveries
to service_role;

notify pgrst, 'reload schema';

commit;
