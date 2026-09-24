-- Phase 3 appointment-reminder SMS bridge.
--
-- This migration deliberately does not create or change a Cron job. The
-- existing process-due-appointment-reminders job remains the only scheduler.
-- The bridge is disabled unless all three named Vault entries exist and the
-- enable entry is exactly "true". No Vault values are created by this file.

create or replace function public.enqueue_claimed_appointment_reminder_sms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_dispatch jsonb := pg_catalog.to_jsonb(new);
  v_enabled text;
  v_function_url text;
  v_server_secret text;
  v_schedule_id uuid;
  v_reminder_id uuid;
  v_reminder_offset_minutes integer;
  v_scheduled_for timestamptz;
  v_body jsonb;
begin
  -- Enqueue only once, after the existing processor has successfully created
  -- the in-app notification for this claimed occurrence.
  if new.status is distinct from 'created' then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if old.status is not distinct from new.status then
      return new;
    end if;
  end if;

  begin
    select secret.decrypted_secret
    into v_enabled
    from vault.decrypted_secrets as secret
    where secret.name = 'appointment_sms_bridge_enabled'
    limit 1;

    if pg_catalog.lower(pg_catalog.btrim(coalesce(v_enabled, ''))) <> 'true' then
      return new;
    end if;

    select secret.decrypted_secret
    into v_function_url
    from vault.decrypted_secrets as secret
    where secret.name = 'appointment_sms_function_url'
    limit 1;

    select secret.decrypted_secret
    into v_server_secret
    from vault.decrypted_secrets as secret
    where secret.name = 'appointment_sms_server_secret'
    limit 1;

    v_function_url := pg_catalog.btrim(coalesce(v_function_url, ''));
    v_server_secret := pg_catalog.btrim(coalesce(v_server_secret, ''));

    if v_function_url = ''
       or v_function_url !~ '^https://'
       or v_server_secret !~ '^sb_secret_' then
      return new;
    end if;

    v_schedule_id := nullif(v_dispatch ->> 'schedule_id', '')::uuid;
    v_reminder_id := nullif(v_dispatch ->> 'reminder_id', '')::uuid;
    v_reminder_offset_minutes :=
      nullif(v_dispatch ->> 'reminder_offset_minutes', '')::integer;
    v_scheduled_for := nullif(v_dispatch ->> 'scheduled_for', '')::timestamptz;

    -- Older fallback-ledger rows may not carry scheduled_for explicitly. Its
    -- canonical occurrence is the appointment start minus the claimed offset.
    if v_scheduled_for is null
       and v_reminder_id is null
       and v_reminder_offset_minutes in (1440, 120) then
      v_scheduled_for :=
        nullif(v_dispatch ->> 'appointment_start_time', '')::timestamptz
        - pg_catalog.make_interval(mins => v_reminder_offset_minutes);
    end if;

    if v_schedule_id is null or v_scheduled_for is null then
      return new;
    end if;

    v_body := pg_catalog.jsonb_build_object(
      'event', 'appointment_reminder',
      'schedule_id', v_schedule_id,
      'scheduled_for', v_scheduled_for
    );

    if v_reminder_id is not null then
      v_body := v_body || pg_catalog.jsonb_build_object(
        'reminder_id', v_reminder_id
      );
    elsif v_reminder_offset_minutes in (1440, 120) then
      v_body := v_body || pg_catalog.jsonb_build_object(
        'reminder_offset_minutes', v_reminder_offset_minutes
      );
    else
      return new;
    end if;

    perform net.http_post(
      url => v_function_url,
      headers => pg_catalog.jsonb_build_object(
        'apikey', v_server_secret,
        'content-type', 'application/json'
      ),
      body => v_body,
      timeout_milliseconds => 5000
    );
  exception
    when others then
      -- SMS is secondary delivery. Missing Vault configuration, pg_net enqueue
      -- errors, and malformed legacy rows must never roll back the in-app
      -- notification or its existing occurrence claim.
      return new;
  end;

  return new;
end;
$function$;

comment on function public.enqueue_claimed_appointment_reminder_sms() is
  'Queues a claimed appointment reminder occurrence for Phase 3 SMS through pg_net when explicitly enabled in Vault.';

revoke all on function public.enqueue_claimed_appointment_reminder_sms()
  from public, anon, authenticated;

drop trigger if exists appointment_reminder_dispatches_enqueue_sms
  on public.appointment_reminder_dispatches;

create trigger appointment_reminder_dispatches_enqueue_sms
after insert or update on public.appointment_reminder_dispatches
for each row
execute function public.enqueue_claimed_appointment_reminder_sms();
