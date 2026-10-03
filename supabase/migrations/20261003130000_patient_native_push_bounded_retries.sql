-- Phase 8B: bounded retries of confirmed FCM rejections only. No processing reclaim.
begin;

do $preflight$
begin
  if pg_catalog.to_regclass('public.patient_notification_native_push_deliveries') is null
     or pg_catalog.to_regclass('vault.decrypted_secrets') is null
     or pg_catalog.to_regclass('cron.job') is null
     or pg_catalog.to_regprocedure('cron.schedule(text,text,text)') is null
     or pg_catalog.to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception 'Native retry prerequisites are missing; review Vault, pg_cron and pg_net before applying. No extensions were installed.';
  end if;
end;
$preflight$;

alter table public.patient_notification_native_push_deliveries
  add column claim_token uuid,
  add column last_failure_class text,
  add column next_attempt_at timestamptz,
  add constraint patient_native_push_failure_class_check check (
    last_failure_class is null or (
      status in ('failed', 'disabled_token') and last_failure_class in (
        'permanent_device', 'confirmed_transient', 'non_retryable', 'unknown_outcome'
      )
    )
  ),
  add constraint patient_native_push_retry_deadline_check check (
    next_attempt_at is null or (
      status = 'failed' and last_failure_class is not null and last_failure_class = 'confirmed_transient'
      and claim_token is not null and attempt_count < 4
      and next_attempt_at > attempted_at
      and next_attempt_at < created_at + interval '30 minutes'
    )
  ),
  add constraint patient_native_push_active_result_check check (
    claim_token is null or status <> 'processing' or (
      last_failure_class is null and next_attempt_at is null
      and fcm_http_status is null and error_code is null and error_message is null
      and provider_message_id is null and sent_at is null
    )
  );

create index patient_native_push_due_retry_idx
on public.patient_notification_native_push_deliveries (next_attempt_at, id)
where status = 'failed' and last_failure_class = 'confirmed_transient'
  and next_attempt_at is not null;

comment on column public.patient_notification_native_push_deliveries.claim_token is
  'Server-generated attempt fencing token. Never log or expose to clients. Historical claims remain NULL.';
comment on column public.patient_notification_native_push_deliveries.last_failure_class is
  'Only confirmed_transient may schedule a retry. Unknown provider outcomes never auto-retry.';
comment on column public.patient_notification_native_push_deliveries.next_attempt_at is
  'Persisted retry deadline; NULL means no automatic retry. Historical rows are not inferred retryable.';
comment on column public.patient_notification_native_push_deliveries.attempted_at is
  'Database start time of latest claimed attempt; created_at remains the original delivery start.';
comment on column public.patient_notification_native_push_deliveries.attempt_count is
  'Total claimed attempts including initial send. New retry claims are capped at four.';

create function public.claim_patient_native_push_delivery(
  p_notification_id uuid, p_device_id uuid, p_mode text
)
returns table(delivery_id uuid, claim_token uuid, attempt_count integer, attempted_at timestamptz)
language plpgsql security definer set search_path = ''
as $function$
declare
  v_now timestamptz := pg_catalog.now();
begin
  if p_mode = 'notification' then
    -- Duplicate webhooks NEVER retry, regardless of existing status.
    return query
    insert into public.patient_notification_native_push_deliveries as delivery (
      notification_id, device_id, status, attempt_count, claim_token, attempted_at
    )
    select notification.id, device.id, 'processing', 1, pg_catalog.gen_random_uuid(), v_now
    from public.patient_notifications as notification
    join public.patient_native_push_devices as device on device.patient_id = notification.patient_id
    where notification.id = p_notification_id and device.id = p_device_id
      and device.platform = 'android' and device.enabled
    on conflict (notification_id, device_id) do nothing
    returning delivery.id, delivery.claim_token, delivery.attempt_count, delivery.attempted_at;
  elsif p_mode = 'retry' then
    -- One guarded UPDATE grants ownership. No read/decide/update claim race.
    return query
    update public.patient_notification_native_push_deliveries as delivery
    set status = 'processing', attempt_count = delivery.attempt_count + 1,
      claim_token = pg_catalog.gen_random_uuid(), attempted_at = v_now,
      last_failure_class = null, next_attempt_at = null, fcm_http_status = null,
      error_code = null, error_message = null, provider_message_id = null, sent_at = null
    from public.patient_notifications as notification, public.patient_native_push_devices as device
    where delivery.notification_id = p_notification_id and delivery.device_id = p_device_id
      and notification.id = delivery.notification_id and device.id = delivery.device_id
      and device.patient_id = notification.patient_id and device.platform = 'android' and device.enabled
      and delivery.status = 'failed' and delivery.last_failure_class = 'confirmed_transient'
      and delivery.next_attempt_at <= v_now and delivery.attempt_count < 4
      and v_now < delivery.created_at + interval '30 minutes'
    returning delivery.id, delivery.claim_token, delivery.attempt_count, delivery.attempted_at;
  else
    raise exception 'Invalid native delivery claim mode.' using errcode = '22023';
  end if;
end;
$function$;

create function public.list_due_patient_native_push_deliveries()
returns table(notification_id uuid, device_id uuid)
language sql stable security definer set search_path = ''
as $function$
  select delivery.notification_id, delivery.device_id
  from public.patient_notification_native_push_deliveries as delivery
  join public.patient_notifications as notification on notification.id = delivery.notification_id
  join public.patient_native_push_devices as device on device.id = delivery.device_id
    and device.patient_id = notification.patient_id and device.platform = 'android' and device.enabled
  where delivery.status = 'failed' and delivery.last_failure_class = 'confirmed_transient'
    and delivery.next_attempt_at <= pg_catalog.now() and delivery.attempt_count < 4
    and pg_catalog.now() < delivery.created_at + interval '30 minutes'
  order by delivery.next_attempt_at, delivery.id
  limit 10;
$function$;

create function public.finalize_patient_native_push_delivery(
  p_delivery_id uuid, p_claim_token uuid, p_attempt_count integer,
  p_failure_class text, p_http_status integer, p_error_code text,
  p_provider_message_id text, p_device_updated_at timestamptz,
  p_retry_after_ms bigint default null
)
returns table(result text, status text)
language plpgsql security definer set search_path = ''
as $function$
declare
  v_delivery public.patient_notification_native_push_deliveries%rowtype;
  v_now timestamptz := pg_catalog.now();
  v_status text := 'failed';
  v_code text;
  v_message text;
  v_deadline timestamptz;
  v_disabled uuid;
  v_delay_ms double precision;
begin
  select delivery.* into v_delivery
  from public.patient_notification_native_push_deliveries as delivery
  where delivery.id = p_delivery_id for update;

  if not found or p_claim_token is null
     or v_delivery.claim_token is distinct from p_claim_token
     or v_delivery.attempt_count is distinct from p_attempt_count then
    return query select 'stale_claim'::text, null::text;
    return;
  end if;
  if v_delivery.status <> 'processing' then
    return query select 'already_finalized'::text, v_delivery.status;
    return;
  end if;
  if p_failure_class is null or p_failure_class not in (
    'success', 'permanent_device', 'confirmed_transient', 'non_retryable', 'unknown_outcome'
  ) or (p_http_status is not null and p_http_status not between 100 and 599)
     or (p_retry_after_ms is not null and p_retry_after_ms < 0) then
    raise exception 'Invalid native delivery result.' using errcode = '22023';
  end if;
  if p_failure_class = 'success' and not coalesce(p_http_status between 200 and 299, false) then
    raise exception 'Invalid native delivery success result.' using errcode = '22023';
  end if;
  -- Do not accept arbitrary raw provider text, even from the server caller.
  v_code := case when p_error_code in (
    'UNREGISTERED', 'INVALID_ARGUMENT', 'QUOTA_EXCEEDED', 'RESOURCE_EXHAUSTED',
    'INTERNAL', 'UNAVAILABLE', 'UNAUTHENTICATED', 'PERMISSION_DENIED',
    'SENDER_ID_MISMATCH', 'THIRD_PARTY_AUTH_ERROR', 'NOT_FOUND', 'ABORTED',
    'FCM_OUTCOME_UNKNOWN', 'FCM_RESPONSE_UNKNOWN', 'FCM_REQUEST_FAILED'
  ) or p_error_code ~ '^HTTP_[1-5][0-9][0-9]$' then p_error_code else 'FCM_REQUEST_FAILED' end;

  if p_failure_class = 'success' then
    v_status := 'sent';
    v_code := null;
    v_message := null;
  elsif p_failure_class = 'permanent_device' then
    v_message := 'FCM registration token is no longer valid.';
    -- Claim lock is held BEFORE cleanup. A stale worker cannot disable any device.
    begin
      update public.patient_native_push_devices as device
      set enabled = false, disabled_at = v_now, updated_at = v_now
      from public.patient_notifications as notification
      where device.id = v_delivery.device_id and device.updated_at = p_device_updated_at
        and device.enabled and device.platform = 'android'
        and notification.id = v_delivery.notification_id and device.patient_id = notification.patient_id
      returning device.id into v_disabled;
    exception when others then
      v_disabled := null;
    end;
    if v_disabled is not null then
      v_status := 'disabled_token';
    else
      v_code := 'DEVICE_DISABLE_FAILED';
      v_message := 'Invalid FCM token cleanup did not match the selected registration or could not complete.';
    end if;
  elsif p_failure_class = 'confirmed_transient' then
    -- A server caller may not promote arbitrary outcomes into the retry class.
    if not coalesce(p_http_status = 429 or (p_http_status = 500 and p_error_code = 'INTERNAL')
        or (p_http_status = 503 and p_error_code = 'UNAVAILABLE'), false) then
      raise exception 'Invalid confirmed transient result.' using errcode = '22023';
    end if;
    v_message := 'FCM temporarily rejected delivery.';
    if v_delivery.attempt_count < 4 then
      v_delay_ms := 60000 * pg_catalog.power(2::double precision, v_delivery.attempt_count - 1)
        * (1 + pg_catalog.random() * 0.25);
      -- Oversized provider waits terminate scheduling, never shorten the required wait.
      if coalesce(p_retry_after_ms, 0) < 1800000 then
        v_deadline := v_now + pg_catalog.make_interval(secs =>
          greatest(v_delay_ms, coalesce(p_retry_after_ms, 0)::double precision) / 1000);
        if v_deadline >= v_delivery.created_at + interval '30 minutes' then
          v_deadline := null;
        end if;
      end if;
    end if;
  elsif p_failure_class = 'unknown_outcome' then
    v_message := 'FCM delivery outcome is unknown; automatic replay is disabled.';
  else
    v_message := 'FCM rejected delivery; payload or server configuration requires review.';
  end if;

  update public.patient_notification_native_push_deliveries as delivery
  set status = v_status, fcm_http_status = p_http_status, error_code = v_code,
    error_message = v_message,
    provider_message_id = case when v_status = 'sent' then
      nullif(pg_catalog.left(pg_catalog.btrim(p_provider_message_id), 512), '') else null end,
    sent_at = case when v_status = 'sent' then v_now else null end,
    last_failure_class = case when v_status = 'sent' then null else p_failure_class end,
    next_attempt_at = v_deadline
  where delivery.id = v_delivery.id and delivery.status = 'processing'
    and delivery.claim_token = p_claim_token and delivery.attempt_count = p_attempt_count;
  return query select 'finalized'::text, v_status;
end;
$function$;

revoke all on function public.claim_patient_native_push_delivery(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.list_due_patient_native_push_deliveries()
  from public, anon, authenticated;
revoke all on function public.finalize_patient_native_push_delivery(uuid, uuid, integer, text, integer, text, text, timestamptz, bigint)
  from public, anon, authenticated;
grant execute on function public.claim_patient_native_push_delivery(uuid, uuid, text) to service_role;
grant execute on function public.list_due_patient_native_push_deliveries() to service_role;
grant execute on function public.finalize_patient_native_push_delivery(uuid, uuid, integer, text, integer, text, text, timestamptz, bigint) to service_role;
revoke insert, update on public.patient_notification_native_push_deliveries from service_role;
-- SELECT and RLS remain unchanged. All new ledger writes go through fenced RPCs.

create function public.enqueue_patient_native_push_retry_tick()
returns void language plpgsql security definer set search_path = ''
as $function$
declare
  v_enabled text;
  v_url text;
  v_project_url text;
  v_secret text;
begin
  select secret.decrypted_secret into v_enabled from vault.decrypted_secrets as secret
    where secret.name = 'native_push_retry_enabled';
  if v_enabled is distinct from 'true' then return; end if;
  select secret.decrypted_secret into v_url from vault.decrypted_secrets as secret
    where secret.name = 'native_push_retry_url';
  select secret.decrypted_secret into v_project_url from vault.decrypted_secrets as secret
    where secret.name = 'native_push_retry_project_url';
  select secret.decrypted_secret into v_secret from vault.decrypted_secrets as secret
    where secret.name = 'native_push_retry_secret';
  -- Trusted project base is configured separately; query strings/custom paths are refused.
  if v_project_url is null or v_project_url !~ '^https://[a-z0-9]{20}[.]supabase[.]co$'
     or v_url is distinct from v_project_url || '/functions/v1/send-patient-native-push'
     or v_secret is null or pg_catalog.length(v_secret) not between 32 and 256
     or v_secret !~ '^[A-Za-z0-9_-]+$' then return; end if;
  perform net.http_post(url => v_url,
    headers => pg_catalog.jsonb_build_object('content-type', 'application/json', 'x-retry-secret', v_secret, 'x-native-push-mode', 'retry'),
    body => pg_catalog.jsonb_build_object('mode', 'retry'), timeout_milliseconds => 60000);
exception when others then
  -- Missing/invalid config and transport problems must not leak decrypted values.
  return;
end;
$function$;
revoke all on function public.enqueue_patient_native_push_retry_tick()
  from public, anon, authenticated, service_role;
grant execute on function public.enqueue_patient_native_push_retry_tick() to postgres;

-- No Vault values are provisioned. Every tick is a no-op until explicitly enabled.
select cron.schedule('patient-native-push-retry-tick', '* * * * *',
  'select public.enqueue_patient_native_push_retry_tick();');
notify pgrst, 'reload schema';
commit;
