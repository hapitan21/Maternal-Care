begin;

-- ============================================================
-- Only active Admins may receive the private audit-log topic
-- ============================================================

drop policy if exists
  "Active admins can receive audit log refresh broadcasts"
on realtime.messages;

create policy
  "Active admins can receive audit log refresh broadcasts"
on realtime.messages
for select
to authenticated
using (
  (select realtime.topic()) = 'admin:audit-logs'
  and realtime.messages.extension = 'broadcast'
  and (select public.is_active_admin_realtime())
);


-- ============================================================
-- Broadcast audit-log invalidation to Admin clients
-- ============================================================

create or replace function public.broadcast_admin_audit_log_change()
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
      'audit_log_changed',
      'admin:audit-logs',
      true
    );

  exception
    when others then
      -- Realtime delivery must never cause the underlying
      -- audit_logs INSERT to fail.
      raise warning
        'Admin audit-log broadcast failed: %',
        SQLERRM;
  end;

  return NEW;
end;
$function$;

revoke all
on function public.broadcast_admin_audit_log_change()
from public;


-- ============================================================
-- Attach Broadcast trigger to new audit-log rows only
-- ============================================================

drop trigger if exists
  broadcast_admin_audit_log_change_trigger
on public.audit_logs;

create trigger broadcast_admin_audit_log_change_trigger
after insert
on public.audit_logs
for each row
execute function public.broadcast_admin_audit_log_change();

commit;
