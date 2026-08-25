-- ============================================================
-- Maternal Care - Doctor read access for medication adherence
-- ============================================================
-- Review and run this file manually in the Supabase SQL Editor.
--
-- Purpose:
--   Allow authenticated Doctor users to read
--   public.medication_reminder_occurrences so the Doctor Reminders medication
--   table can display Patient adherence status from the occurrence ledger.
--
-- This script does not grant INSERT, UPDATE, or DELETE access.
-- It does not add the occurrence table to Supabase Realtime.
-- It does not create or change Cron jobs, webhooks, or processing functions.
-- ============================================================

begin;

alter table public.medication_reminder_occurrences
  enable row level security;

grant select on public.medication_reminder_occurrences
  to authenticated;

drop policy if exists "Doctors can read medication reminder occurrences"
  on public.medication_reminder_occurrences;

create policy "Doctors can read medication reminder occurrences"
on public.medication_reminder_occurrences
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(
        pg_catalog.btrim(
          coalesce(profile.role, ''::text)
        )
      ) = 'doctor'
  )
);

revoke insert, update, delete on public.medication_reminder_occurrences
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;

