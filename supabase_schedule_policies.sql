-- Run this in Supabase SQL Editor.
-- It lets clinic users manage schedules and lets patients read only schedules
-- linked through their patient database row.
--
-- Required relationship:
--   auth.uid() -> public.patients.user_id -> public.patients.id -> public.schedule.patient_id

begin;

alter table public.schedule enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.schedule to authenticated;

drop policy if exists "Doctors and admins can create schedules" on public.schedule;
drop policy if exists "Doctors and admins can view schedules" on public.schedule;
drop policy if exists "Doctors and admins can update schedules" on public.schedule;
drop policy if exists "Clinic users can manage schedules" on public.schedule;
drop policy if exists "Patients can view their schedules" on public.schedule;
drop policy if exists "Patients can view own schedules" on public.schedule;

create policy "Clinic users can manage schedules"
on public.schedule
for all
to authenticated
using (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and lower(coalesce(profiles.role, '')) in ('doctor', 'admin', 'staff')
  )
)
with check (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and lower(coalesce(profiles.role, '')) in ('doctor', 'admin', 'staff')
  )
);

create policy "Patients can view own schedules"
on public.schedule
for select
to authenticated
using (
  exists (
    select 1
    from public.patients
    where patients.user_id = auth.uid()
      and schedule.patient_id::text = patients.id::text
  )
);

do $$
begin
  alter publication supabase_realtime add table public.schedule;
exception
  when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';

commit;
