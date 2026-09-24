-- Phase 4 medication-reminder SMS bridge.
--
-- This migration does not create or modify a Cron job. The existing
-- process-due-medication-reminders job remains the only scheduler. The bridge
-- is disabled unless all three named Vault entries exist and the enable entry
-- is exactly "true". No Vault values are created by this file.

create or replace function public.enqueue_notified_medication_reminder_sms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_enabled text;
  v_function_url text;
  v_server_secret text;
begin
  -- The existing processor reaches notified only after its in-app Patient
  -- notification has been inserted successfully.
  if new.status is distinct from 'notified'
     or new.notification_id is null
     or new.notified_at is null then
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
    where secret.name = 'medication_sms_bridge_enabled'
    limit 1;

    if pg_catalog.lower(pg_catalog.btrim(coalesce(v_enabled, ''))) <> 'true' then
      return new;
    end if;

    select secret.decrypted_secret
    into v_function_url
    from vault.decrypted_secrets as secret
    where secret.name = 'medication_sms_function_url'
    limit 1;

    select secret.decrypted_secret
    into v_server_secret
    from vault.decrypted_secrets as secret
    where secret.name = 'medication_sms_server_secret'
    limit 1;

    v_function_url := pg_catalog.btrim(coalesce(v_function_url, ''));
    v_server_secret := pg_catalog.btrim(coalesce(v_server_secret, ''));

    if v_function_url = ''
       or v_function_url !~ '^https://'
       or v_server_secret !~ '^sb_secret_' then
      return new;
    end if;

    perform net.http_post(
      url => v_function_url,
      headers => pg_catalog.jsonb_build_object(
        'apikey', v_server_secret,
        'content-type', 'application/json'
      ),
      body => pg_catalog.jsonb_build_object(
        'event', 'medication_reminder',
        'medication_occurrence_id', new.id
      ),
      timeout_milliseconds => 5000
    );
  exception
    when others then
      -- SMS is secondary delivery. Missing Vault configuration and pg_net
      -- enqueue errors must never roll back the occurrence or in-app reminder.
      return new;
  end;

  return new;
end;
$function$;

comment on function public.enqueue_notified_medication_reminder_sms() is
  'Queues one successfully notified medication occurrence for Phase 4 SMS through pg_net when explicitly enabled in Vault.';

revoke all on function public.enqueue_notified_medication_reminder_sms()
  from public, anon, authenticated;

drop trigger if exists medication_reminder_occurrences_enqueue_sms
  on public.medication_reminder_occurrences;

create trigger medication_reminder_occurrences_enqueue_sms
after insert or update on public.medication_reminder_occurrences
for each row
execute function public.enqueue_notified_medication_reminder_sms();
