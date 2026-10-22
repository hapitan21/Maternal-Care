-- DRAFT ONLY. Not a migration. Review installed definitions/owner/grants first.
-- Do not execute without separate approval. Does not create or enable a flag.
-- A new helper name must be unused: CREATE FUNCTION deliberately fails on collision.
-- Prerequisites: Supabase Vault, postgres ownership and the standard API roles.
begin;

create function public.is_appointment_event_sms_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    count(*) = 1 and bool_and(secret.decrypted_secret = 'true'),
    false
  )
  from vault.decrypted_secrets as secret
  where secret.name = 'appointment_event_sms_enabled';
$function$;

alter function public.is_appointment_event_sms_enabled() owner to postgres;
revoke all on function public.is_appointment_event_sms_enabled()
  from public, anon, authenticated;
grant execute on function public.is_appointment_event_sms_enabled()
  to service_role;
comment on function public.is_appointment_event_sms_enabled() is
  'Service-only transactional appointment SMS control; absent, duplicate or non-true configuration is disabled. Does not control scheduled reminder bridges.';

commit;
