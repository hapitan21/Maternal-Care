-- Maternal Care Patient Web Push delivery ledger.
--
-- PRE-FLIGHT CHECKLIST (review manually before running):
-- 1. Confirm public.patient_notifications exists and its id/patient_id columns are uuid.
-- 2. Confirm public.patient_push_subscriptions exists and its id/patient_id columns are uuid.
-- 3. Confirm no application code grants browser clients access to server delivery metadata.
-- 4. Confirm no table or trigger named below exists with an incompatible definition.
--
-- This script is intentionally not executed by the application. Run it manually only after review.

begin;

create table if not exists public.patient_notification_push_deliveries (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  notification_id uuid not null,
  subscription_id uuid not null,
  status text not null default 'processing',
  attempt_count integer not null default 1,
  push_service_status integer,
  error_code text,
  error_message text,
  attempted_at timestamp with time zone not null default pg_catalog.now(),
  sent_at timestamp with time zone,
  created_at timestamp with time zone not null default pg_catalog.now(),
  updated_at timestamp with time zone not null default pg_catalog.now(),

  constraint patient_notification_push_deliveries_notification_fk
    foreign key (notification_id)
    references public.patient_notifications (id)
    on delete cascade,
  constraint patient_notification_push_deliveries_subscription_fk
    foreign key (subscription_id)
    references public.patient_push_subscriptions (id)
    on delete cascade,
  constraint patient_notification_push_deliveries_notification_subscription_key
    unique (notification_id, subscription_id),
  constraint patient_notification_push_deliveries_status_check
    check (status in ('processing', 'sent', 'failed', 'expired')),
  constraint patient_notification_push_deliveries_attempt_count_check
    check (attempt_count >= 1),
  constraint patient_notification_push_deliveries_push_service_status_check
    check (
      push_service_status is null
      or push_service_status between 100 and 599
    ),
  constraint patient_notification_push_deliveries_error_code_check
    check (
      error_code is null
      or (
        error_code = pg_catalog.btrim(error_code)
        and pg_catalog.char_length(error_code) between 1 and 80
      )
    ),
  constraint patient_notification_push_deliveries_error_message_check
    check (
      error_message is null
      or (
        error_message = pg_catalog.btrim(error_message)
        and pg_catalog.char_length(error_message) between 1 and 240
      )
    )
);

comment on table public.patient_notification_push_deliveries is
  'Server-only idempotency and result ledger for Patient Web Push delivery attempts.';
comment on column public.patient_notification_push_deliveries.error_message is
  'Sanitized operational summary only; never store endpoints, keys, notification text, or provider response bodies.';

create index if not exists patient_notification_push_deliveries_notification_status_idx
  on public.patient_notification_push_deliveries (notification_id, status);

create or replace function public.set_patient_notification_push_deliveries_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

revoke all on function public.set_patient_notification_push_deliveries_updated_at()
  from public, anon, authenticated;

drop trigger if exists set_patient_notification_push_deliveries_updated_at
  on public.patient_notification_push_deliveries;

create trigger set_patient_notification_push_deliveries_updated_at
before update on public.patient_notification_push_deliveries
for each row
execute function public.set_patient_notification_push_deliveries_updated_at();

alter table public.patient_notification_push_deliveries enable row level security;

-- No RLS policies are created. Only the trusted Edge Function service-role client
-- should access this table.
revoke all on table public.patient_notification_push_deliveries
  from public, anon, authenticated;

select pg_catalog.pg_notify('pgrst', 'reload schema');

commit;

-- POST-FLIGHT CHECKLIST (run manually after the transaction succeeds):
-- 1. Confirm RLS is enabled and the table has no policies.
-- 2. Confirm anon/authenticated cannot select, insert, update, or delete rows.
-- 3. Confirm the unique constraint rejects a duplicate notification/subscription pair.
-- 4. Confirm deleting a notification or subscription cascades its delivery rows.
