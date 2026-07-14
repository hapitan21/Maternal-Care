-- Run this in Supabase SQL Editor.
-- Purpose: fix Doctor-to-Patient appointment visibility without comparing
-- schedule.patient_id directly to auth.uid().
--
-- Required relationship:
--   auth.uid() -> public.patients.user_id -> public.patients.id -> public.schedule.patient_id

begin;

alter table public.profiles enable row level security;
alter table public.patients enable row level security;
alter table public.schedule enable row level security;

grant usage on schema public to authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.patients to authenticated;
grant select, insert, update, delete on public.schedule to authenticated;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
on public.profiles
for select
to authenticated
using (id = auth.uid() or email = auth.jwt() ->> 'email');

drop policy if exists "Clinic users can manage patients" on public.patients;
drop policy if exists "Patients can read own patient record" on public.patients;
drop policy if exists "Patients can update own patient record" on public.patients;

create policy "Clinic users can manage patients"
on public.patients
for all
to authenticated
using (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and lower(coalesce(profiles.role, '')) in ('admin', 'doctor', 'staff')
  )
)
with check (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and lower(coalesce(profiles.role, '')) in ('admin', 'doctor', 'staff')
  )
);

create policy "Patients can read own patient record"
on public.patients
for select
to authenticated
using (user_id = auth.uid());

create policy "Patients can update own patient record"
on public.patients
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

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
      and lower(coalesce(profiles.role, '')) in ('admin', 'doctor', 'staff')
  )
)
with check (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and lower(coalesce(profiles.role, '')) in ('admin', 'doctor', 'staff')
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
