-- Phase 5: conservative SMS dispatch reconciliation and explicit safe retry.
--
-- This migration creates no Cron job and sends no notification. It does not
-- alter Phase 1 claim semantics, the dispatch status constraint, or the Phase 2
-- Semaphore reservation. Only service_role can read the report or claim a
-- proven-safe retry.

create or replace function public.classify_notification_dispatch(
  p_status text,
  p_provider text,
  p_processing_started_at timestamptz,
  p_failed_at timestamptz,
  p_provider_message_id text,
  p_sent_at timestamptz,
  p_delivered_at timestamptz,
  p_as_of timestamptz default pg_catalog.now(),
  p_stale_after interval default interval '30 minutes'
)
returns text
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_status text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_status, '')));
  v_provider text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_provider, '')));
  v_as_of timestamptz := coalesce(p_as_of, pg_catalog.now());
begin
  if p_stale_after is null or p_stale_after < interval '30 minutes' then
    raise exception 'The retry stale threshold must be at least 30 minutes.'
      using errcode = '22023';
  end if;

  if v_status in ('sent', 'delivered') then
    return 'terminal_success';
  end if;

  if v_status = 'cancelled' then
    return 'terminal_cancelled';
  end if;

  if v_status = 'processing' then
    if v_provider <> '' then
      return 'manual_review_transport_started';
    end if;

    if p_provider_message_id is not null
       or p_sent_at is not null
       or p_delivered_at is not null then
      return 'failed_requires_review';
    end if;

    if p_failed_at is not null then
      return 'failed_requires_review';
    end if;

    if p_processing_started_at is null then
      return 'failed_requires_review';
    end if;

    if p_processing_started_at <= v_as_of - p_stale_after then
      return 'safe_retry_candidate';
    end if;

    return 'recent_processing';
  end if;

  if v_status = 'failed' then
    if v_provider <> '' then
      return 'failed_requires_review';
    end if;

    if p_provider_message_id is not null
       or p_sent_at is not null
       or p_delivered_at is not null then
      return 'failed_requires_review';
    end if;

    if p_failed_at is null then
      return 'failed_requires_review';
    end if;

    if p_failed_at <= v_as_of - p_stale_after then
      return 'safe_retry_candidate';
    end if;

    return 'recent_failed';
  end if;

  if v_status = 'pending' then
    return 'pending_requires_review';
  end if;

  return 'unsupported_state';
end;
$function$;

comment on function public.classify_notification_dispatch(
  text, text, timestamptz, timestamptz, text,
  timestamptz, timestamptz, timestamptz, interval
) is
  'Classifies dispatch state without changing it. Provider-reserved dispatches are never safe automatic retry candidates.';

revoke all on function public.classify_notification_dispatch(
  text, text, timestamptz, timestamptz, text,
  timestamptz, timestamptz, timestamptz, interval
) from public, anon, authenticated;

grant execute on function public.classify_notification_dispatch(
  text, text, timestamptz, timestamptz, text,
  timestamptz, timestamptz, timestamptz, interval
) to service_role;

create or replace view public.notification_dispatch_reconciliation
with (security_invoker = true)
as
select
  dispatch.id,
  dispatch.dispatch_key,
  dispatch.patient_id,
  dispatch.channel,
  dispatch.notification_type,
  dispatch.status,
  dispatch.provider,
  dispatch.provider_message_id,
  dispatch.attempt_count,
  dispatch.processing_started_at,
  dispatch.sent_at,
  dispatch.delivered_at,
  dispatch.failed_at,
  dispatch.last_error,
  dispatch.related_notification_id,
  dispatch.related_schedule_id,
  dispatch.related_medication_reminder_id,
  dispatch.related_medication_occurrence_id,
  dispatch.scheduled_for,
  dispatch.created_at,
  dispatch.updated_at,
  public.classify_notification_dispatch(
    dispatch.status,
    dispatch.provider,
    dispatch.processing_started_at,
    dispatch.failed_at,
    dispatch.provider_message_id,
    dispatch.sent_at,
    dispatch.delivered_at,
    pg_catalog.now(),
    interval '30 minutes'
  ) as reconciliation_classification
from public.notification_dispatches as dispatch
where dispatch.channel = 'sms';

comment on view public.notification_dispatch_reconciliation is
  'Service-only SMS reconciliation report. It contains dispatch metadata but no phone numbers or provider credentials.';

revoke all on public.notification_dispatch_reconciliation
  from public, anon, authenticated;
grant select on public.notification_dispatch_reconciliation
  to service_role;

create or replace function public.claim_notification_dispatch_retry(
  p_dispatch_id uuid,
  p_expected_dispatch_key text,
  p_stale_after interval default interval '30 minutes'
)
returns table (
  dispatch_id uuid,
  dispatch_key text,
  dispatch_status text,
  retry_claimed boolean,
  may_send boolean,
  reconciliation_classification text,
  attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := pg_catalog.now();
  v_expected_dispatch_key text := pg_catalog.btrim(
    coalesce(p_expected_dispatch_key, '')
  );
  v_dispatch public.notification_dispatches;
begin
  if p_dispatch_id is null then
    raise exception 'Dispatch ID is required.'
      using errcode = '22023';
  end if;

  if pg_catalog.char_length(v_expected_dispatch_key) < 1
     or pg_catalog.char_length(v_expected_dispatch_key) > 500 then
    raise exception 'Expected dispatch key must contain 1 to 500 characters.'
      using errcode = '22023';
  end if;

  if p_stale_after is null or p_stale_after < interval '30 minutes' then
    raise exception 'The retry stale threshold must be at least 30 minutes.'
      using errcode = '22023';
  end if;

  with retry_candidate as (
    select candidate.id
    from public.notification_dispatches as candidate
    where candidate.id = p_dispatch_id
      and candidate.dispatch_key = v_expected_dispatch_key
      and candidate.channel = 'sms'
      and candidate.provider is null
      and candidate.provider_message_id is null
      and candidate.sent_at is null
      and candidate.delivered_at is null
      and (
        (
          candidate.status = 'processing'
          and candidate.failed_at is null
          and candidate.processing_started_at is not null
          and candidate.processing_started_at <= v_now - p_stale_after
        )
        or
        (
          candidate.status = 'failed'
          and candidate.failed_at is not null
          and candidate.failed_at <= v_now - p_stale_after
        )
      )
    for update skip locked
  )
  update public.notification_dispatches as dispatch
  set
    status = 'processing',
    attempt_count = dispatch.attempt_count + 1,
    provider = null,
    provider_message_id = null,
    processing_started_at = v_now,
    sent_at = null,
    delivered_at = null,
    failed_at = null,
    last_error = null,
    updated_at = v_now
  from retry_candidate
  where dispatch.id = retry_candidate.id
  returning dispatch.* into v_dispatch;

  if v_dispatch.id is not null then
    return query
    select
      v_dispatch.id,
      v_dispatch.dispatch_key,
      v_dispatch.status,
      true,
      true,
      'retry_claimed'::text,
      v_dispatch.attempt_count;
    return;
  end if;

  select dispatch.*
  into v_dispatch
  from public.notification_dispatches as dispatch
  where dispatch.id = p_dispatch_id;

  if v_dispatch.id is null then
    return query
    select
      null::uuid,
      null::text,
      null::text,
      false,
      false,
      'not_found'::text,
      null::integer;
    return;
  end if;

  if v_dispatch.dispatch_key is distinct from v_expected_dispatch_key then
    return query
    select
      v_dispatch.id,
      v_dispatch.dispatch_key,
      v_dispatch.status,
      false,
      false,
      'dispatch_key_mismatch'::text,
      v_dispatch.attempt_count;
    return;
  end if;

  return query
  select
    v_dispatch.id,
    v_dispatch.dispatch_key,
    v_dispatch.status,
    false,
    false,
    public.classify_notification_dispatch(
      v_dispatch.status,
      v_dispatch.provider,
      v_dispatch.processing_started_at,
      v_dispatch.failed_at,
      v_dispatch.provider_message_id,
      v_dispatch.sent_at,
      v_dispatch.delivered_at,
      v_now,
      p_stale_after
    ),
    v_dispatch.attempt_count;
end;
$function$;

comment on function public.claim_notification_dispatch_retry(
  uuid, text, interval
) is
  'Atomically claims an explicit retry only for stale SMS dispatches with no provider reservation. It preserves the dispatch row and key and increments attempt_count once.';

revoke all on function public.claim_notification_dispatch_retry(
  uuid, text, interval
) from public, anon, authenticated;

grant execute on function public.claim_notification_dispatch_retry(
  uuid, text, interval
) to service_role;

notify pgrst, 'reload schema';
