begin;

do $realtime$
begin
  if pg_catalog.to_regclass('public.patient_notifications') is null then
    raise exception
      'public.patient_notifications does not exist; apply the notification schema before enabling Realtime.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  ) then
    raise exception 'supabase_realtime publication does not exist.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'patient_notifications'
  ) then
    alter publication supabase_realtime
      add table public.patient_notifications;
  end if;
end;
$realtime$;

commit;
