begin;

-- ============================================================
-- Active Admin authorization for private Realtime Broadcast
-- ============================================================

create or replace function public.is_active_admin_realtime()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(
        pg_catalog.btrim(
          coalesce(profile.role, ''::text)
        )
      ) = 'admin'
      and pg_catalog.lower(
        pg_catalog.btrim(
          coalesce(profile.account_status, ''::text)
        )
      ) = 'active'
  );
$function$;

revoke all
on function public.is_active_admin_realtime()
from public;

grant execute
on function public.is_active_admin_realtime()
to authenticated;


-- ============================================================
-- Only active Admins may receive the private schedule topic
-- ============================================================

drop policy if exists
  "Active admins can receive schedule refresh broadcasts"
on realtime.messages;

create policy
  "Active admins can receive schedule refresh broadcasts"
on realtime.messages
for select
to authenticated
using (
  (select realtime.topic()) = 'admin:schedule'
  and realtime.messages.extension = 'broadcast'
  and (select public.is_active_admin_realtime())
);


-- ============================================================
-- Broadcast schedule changes to Admin clients
-- ============================================================

create or replace function public.broadcast_admin_schedule_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  begin
    perform realtime.send(
      pg_catalog.jsonb_build_object(
        'operation', TG_OP
      ),
      'schedule_changed',
      'admin:schedule',
      true
    );

  exception
    when others then
      -- Realtime delivery must never cause the underlying
      -- appointment INSERT/UPDATE/DELETE to fail.
      raise warning
        'Admin schedule broadcast failed: %',
        SQLERRM;
  end;

  return coalesce(NEW, OLD);
end;
$function$;

revoke all
on function public.broadcast_admin_schedule_change()
from public;


-- ============================================================
-- Attach Broadcast trigger to schedule
-- ============================================================

drop trigger if exists
  broadcast_admin_schedule_change_trigger
on public.schedule;

create trigger broadcast_admin_schedule_change_trigger
after insert or update or delete
on public.schedule
for each row
execute function public.broadcast_admin_schedule_change();

commit;