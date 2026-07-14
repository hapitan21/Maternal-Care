-- Run this in Supabase SQL Editor.
-- It lets clinic users create/manage appointment reminders and lets patients
-- read reminders that belong to their own patient record.

alter table public.reminders enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.reminders to authenticated;

drop policy if exists "Clinic users can manage reminders" on public.reminders;
drop policy if exists "Patients can read own reminders" on public.reminders;

create policy "Clinic users can manage reminders"
on public.reminders
for all
to authenticated
using (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and lower(profiles.role) in ('admin', 'doctor', 'staff')
  )
)
with check (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and lower(profiles.role) in ('admin', 'doctor', 'staff')
  )
);

create policy "Patients can read own reminders"
on public.reminders
for select
to authenticated
using (
  exists (
    select 1
    from public.patients
    where patients.id = reminders.patient_id
      and patients.user_id = auth.uid()
  )
);

do $$
begin
  alter publication supabase_realtime add table public.reminders;
exception
  when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';
