-- Run this in Supabase SQL Editor after manual review.
-- Purpose: preserve the existing public.medication_reminders table and add
-- only nullable form metadata columns plus RLS for the confirmed relationship:
--
--   auth.uid() -> public.patients.user_id -> public.patients.id
--     -> public.medication_reminders.patient_id
--
-- Confirmed live schema keeps:
--   reminder_times time without time zone[] not null default '{}'::time without time zone[]
--
-- This migration does not recreate the table, convert reminder_times, delete
-- policies outside the named medication reminder policies below, or touch rows.

begin;

alter table public.medication_reminders
  add column if not exists prescription_reference text,
  add column if not exists duration text;

create or replace function public.set_medication_reminders_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_medication_reminders_updated_at
  on public.medication_reminders;

create trigger set_medication_reminders_updated_at
before update on public.medication_reminders
for each row
execute function public.set_medication_reminders_updated_at();

alter table public.medication_reminders enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.medication_reminders to authenticated;

drop policy if exists "Clinic users can manage medication reminders"
  on public.medication_reminders;
drop policy if exists "Patients can read own medication reminders"
  on public.medication_reminders;

create policy "Clinic users can manage medication reminders"
on public.medication_reminders
for all
to authenticated
using (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and lower(coalesce(profiles.role, '')) in ('admin', 'doctor')
  )
)
with check (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and lower(coalesce(profiles.role, '')) in ('admin', 'doctor')
  )
);

create policy "Patients can read own medication reminders"
on public.medication_reminders
for select
to authenticated
using (
  exists (
    select 1
    from public.patients
    where patients.id = medication_reminders.patient_id
      and patients.user_id = auth.uid()
  )
);

do $$
begin
  alter publication supabase_realtime add table public.medication_reminders;
exception
  when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';

commit;
