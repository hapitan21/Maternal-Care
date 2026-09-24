begin;

do $preflight$
begin
  if pg_catalog.to_regclass('public.patients') is null then
    raise exception
      'public.patients does not exist; apply the Patient schema before enabling status Realtime.';
  end if;

  if pg_catalog.to_regclass('public.profiles') is null then
    raise exception
      'public.profiles does not exist; Staff Realtime authorization cannot be installed.';
  end if;

  if pg_catalog.to_regclass('realtime.messages') is null
     or pg_catalog.to_regprocedure(
       'realtime.send(jsonb,text,text,boolean)'
     ) is null
     or pg_catalog.to_regprocedure(
       'realtime.topic()'
     ) is null then
    raise exception
      'The required Supabase Realtime Broadcast objects are unavailable.';
  end if;
end;
$preflight$;


create or replace function public.broadcast_staff_patient_account_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform realtime.send(
    pg_catalog.jsonb_build_object(
      'id', new.id,
      'user_id', new.user_id,
      'account_status', new.account_status,
      'status', new.status,
      'archived_at', new.archived_at,
      'archived_by', new.archived_by
    ),
    'patient_account_status_updated',
    'staff:patient-account-status',
    true
  );

  return new;
end;
$function$;


revoke all
on function public.broadcast_staff_patient_account_status()
from public, anon, authenticated;


drop trigger if exists broadcast_staff_patient_account_status
on public.patients;


create trigger broadcast_staff_patient_account_status
after update of
  user_id,
  account_status,
  status,
  archived_at,
  archived_by,
  control_used_at
on public.patients
for each row
when (
  old.user_id is distinct from new.user_id
  or old.account_status is distinct from new.account_status
  or old.status is distinct from new.status
  or old.archived_at is distinct from new.archived_at
  or old.archived_by is distinct from new.archived_by
  or old.control_used_at is distinct from new.control_used_at
)
execute function public.broadcast_staff_patient_account_status();


drop policy if exists
  "Active Staff can receive patient account status broadcasts"
on realtime.messages;


create policy
  "Active Staff can receive patient account status broadcasts"
on realtime.messages
for select
to authenticated
using (
  extension = 'broadcast'
  and (select realtime.topic()) = 'staff:patient-account-status'
  and exists (
    select 1
    from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(
        pg_catalog.btrim(
          coalesce(profile.role, ''::text)
        )
      ) = 'staff'
      and pg_catalog.lower(
        pg_catalog.btrim(
          coalesce(profile.account_status, ''::text)
        )
      ) = 'active'
  )
);


commit;