do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'medication_reminder_occurrences'
  ) then
    alter publication supabase_realtime
      add table public.medication_reminder_occurrences;
  end if;
end;
$$;