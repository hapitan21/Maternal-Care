-- ============================================================
-- Maternal Care - Strict notification idempotency (Phase 1)
-- ============================================================
-- Server-controlled delivery ledger only. This migration does not send SMS,
-- change current notification producers, or replace patient_notifications.
--
-- Deterministic dispatch-key examples (the channel is part of the key):
--   appointment:<schedule_uuid>:<reminder_timestamp>:sms
--   appointment:<schedule_uuid>:<reminder_timestamp>:in_app
--   medication:<occurrence_uuid>:sms
--   medication:<occurrence_uuid>:in_app
-- ============================================================

begin;

create table public.notification_dispatches (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  dispatch_key text not null,
  patient_id uuid not null,
  channel text not null,
  notification_type text not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  provider text,
  provider_message_id text,
  related_notification_id uuid,
  related_schedule_id uuid,
  related_medication_reminder_id uuid,
  related_medication_occurrence_id uuid,
  scheduled_for timestamptz,
  processing_started_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  last_error text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint notification_dispatches_dispatch_key_key
    unique (dispatch_key),
  constraint notification_dispatches_patient_id_fkey
    foreign key (patient_id)
    references public.patients(id)
    on delete restrict,
  constraint notification_dispatches_notification_id_fkey
    foreign key (related_notification_id)
    references public.patient_notifications(id)
    on delete set null,
  constraint notification_dispatches_schedule_id_fkey
    foreign key (related_schedule_id)
    references public.schedule(id)
    on delete set null,
  constraint notification_dispatches_medication_reminder_id_fkey
    foreign key (related_medication_reminder_id)
    references public.medication_reminders(id)
    on delete set null,
  constraint notification_dispatches_medication_occurrence_id_fkey
    foreign key (related_medication_occurrence_id)
    references public.medication_reminder_occurrences(id)
    on delete set null,
  constraint notification_dispatches_channel_check
    check (channel in ('in_app', 'sms')),
  constraint notification_dispatches_status_check
    check (
      status in (
        'pending',
        'processing',
        'sent',
        'delivered',
        'failed',
        'cancelled'
      )
    ),
  constraint notification_dispatches_attempt_count_check
    check (attempt_count >= 0),
  constraint notification_dispatches_dispatch_key_check
    check (
      dispatch_key = pg_catalog.btrim(dispatch_key)
      and pg_catalog.char_length(dispatch_key) between 1 and 500
    ),
  constraint notification_dispatches_notification_type_check
    check (
      notification_type = pg_catalog.btrim(notification_type)
      and pg_catalog.char_length(notification_type) between 1 and 100
    ),
  constraint notification_dispatches_provider_check
    check (
      provider is null
      or (
        provider = pg_catalog.btrim(provider)
        and pg_catalog.char_length(provider) between 1 and 80
      )
    ),
  constraint notification_dispatches_provider_message_id_check
    check (
      provider_message_id is null
      or (
        provider_message_id = pg_catalog.btrim(provider_message_id)
        and pg_catalog.char_length(provider_message_id) between 1 and 255
      )
    ),
  constraint notification_dispatches_last_error_check
    check (
      last_error is null
      or (
        last_error = pg_catalog.btrim(last_error)
        and pg_catalog.char_length(last_error) between 1 and 1000
      )
    )
);

comment on table public.notification_dispatches is
  'Server-controlled idempotency and delivery ledger for Patient notification channels. Complements patient_notifications.';
comment on column public.notification_dispatches.dispatch_key is
  'Deterministic logical-delivery key that includes its channel and is globally unique.';
comment on column public.notification_dispatches.patient_id is
  'Patient relationship; phone numbers and other sensitive delivery details are intentionally not duplicated here.';
comment on column public.notification_dispatches.last_error is
  'Privacy-safe failure summary only. Provider secrets, credentials, and sensitive Patient data must never be stored here.';

create index notification_dispatches_patient_created_idx
  on public.notification_dispatches (patient_id, created_at desc);

create index notification_dispatches_status_scheduled_idx
  on public.notification_dispatches (status, scheduled_for);

create index notification_dispatches_scheduled_idx
  on public.notification_dispatches (scheduled_for)
  where scheduled_for is not null;

create index notification_dispatches_provider_message_idx
  on public.notification_dispatches (provider_message_id)
  where provider_message_id is not null;

create function public.set_notification_dispatches_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;

revoke all on function public.set_notification_dispatches_updated_at()
  from public, anon, authenticated;

create trigger notification_dispatches_set_updated_at
before update on public.notification_dispatches
for each row
execute function public.set_notification_dispatches_updated_at();

alter table public.notification_dispatches
  enable row level security;

-- Server-internal ledger: intentionally no RLS policies and no browser-client
-- privileges. service_role is granted only the operations required by future
-- server-side dispatch code; deletion remains migration/owner controlled.
revoke all on public.notification_dispatches
  from public, anon, authenticated;
grant select, insert, update on public.notification_dispatches
  to service_role;

create function public.claim_notification_dispatch(
  p_dispatch_key text,
  p_patient_id uuid,
  p_channel text,
  p_notification_type text,
  p_related_notification_id uuid default null,
  p_related_schedule_id uuid default null,
  p_related_medication_reminder_id uuid default null,
  p_related_medication_occurrence_id uuid default null,
  p_scheduled_for timestamptz default null
)
returns table (
  dispatch_id uuid,
  dispatch_status text,
  newly_claimed boolean,
  may_send boolean,
  retry_eligible boolean
)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_dispatch_key text := pg_catalog.btrim(coalesce(p_dispatch_key, ''));
  v_channel text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_channel, '')));
  v_notification_type text := pg_catalog.btrim(coalesce(p_notification_type, ''));
  v_dispatch public.notification_dispatches;
begin
  if pg_catalog.char_length(v_dispatch_key) < 1
     or pg_catalog.char_length(v_dispatch_key) > 500 then
    raise exception 'Dispatch key must contain 1 to 500 characters.'
      using errcode = '22023';
  end if;

  if p_patient_id is null then
    raise exception 'Patient ID is required.'
      using errcode = '22023';
  end if;

  if v_channel not in ('in_app', 'sms') then
    raise exception 'Unsupported notification dispatch channel.'
      using errcode = '22023';
  end if;

  if pg_catalog.char_length(v_notification_type) < 1
     or pg_catalog.char_length(v_notification_type) > 100 then
    raise exception 'Notification type must contain 1 to 100 characters.'
      using errcode = '22023';
  end if;

  insert into public.notification_dispatches (
    dispatch_key,
    patient_id,
    channel,
    notification_type,
    status,
    attempt_count,
    processing_started_at,
    related_notification_id,
    related_schedule_id,
    related_medication_reminder_id,
    related_medication_occurrence_id,
    scheduled_for
  )
  values (
    v_dispatch_key,
    p_patient_id,
    v_channel,
    v_notification_type,
    'processing',
    1,
    pg_catalog.now(),
    p_related_notification_id,
    p_related_schedule_id,
    p_related_medication_reminder_id,
    p_related_medication_occurrence_id,
    p_scheduled_for
  )
  on conflict on constraint notification_dispatches_dispatch_key_key
  do nothing
  returning * into v_dispatch;

  if v_dispatch.id is not null then
    return query
    select
      v_dispatch.id,
      v_dispatch.status,
      true,
      true,
      false;
    return;
  end if;

  select dispatch.*
  into v_dispatch
  from public.notification_dispatches as dispatch
  where dispatch.dispatch_key = v_dispatch_key;

  if v_dispatch.id is null then
    raise exception 'The notification dispatch claim could not be resolved.'
      using errcode = '40001';
  end if;

  if v_dispatch.patient_id is distinct from p_patient_id
     or v_dispatch.channel is distinct from v_channel
     or v_dispatch.notification_type is distinct from v_notification_type
     or v_dispatch.related_notification_id
        is distinct from p_related_notification_id
     or v_dispatch.related_schedule_id
        is distinct from p_related_schedule_id
     or v_dispatch.related_medication_reminder_id
        is distinct from p_related_medication_reminder_id
     or v_dispatch.related_medication_occurrence_id
        is distinct from p_related_medication_occurrence_id
     or v_dispatch.scheduled_for is distinct from p_scheduled_for then
    raise exception 'Dispatch key is already associated with different delivery metadata.'
      using errcode = '23505';
  end if;

  return query
  select
    v_dispatch.id,
    v_dispatch.status,
    false,
    false,
    v_dispatch.status = 'failed';
end;
$function$;

comment on function public.claim_notification_dispatch(
  text, uuid, text, text, uuid, uuid, uuid, uuid, timestamptz
) is
  'Atomically claims one deterministic notification delivery. Only a newly inserted row may be sent; failed rows are reported as retry-eligible but are not automatically reclaimed.';

revoke all on function public.claim_notification_dispatch(
  text, uuid, text, text, uuid, uuid, uuid, uuid, timestamptz
) from public, anon, authenticated;
grant execute on function public.claim_notification_dispatch(
  text, uuid, text, text, uuid, uuid, uuid, uuid, timestamptz
) to service_role;

notify pgrst, 'reload schema';

commit;
