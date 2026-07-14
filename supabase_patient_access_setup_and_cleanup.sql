-- Run this in the Supabase SQL Editor.
-- It prepares patient QR activation/login and clears old patient data only.
-- Doctor, staff, and admin profiles are preserved.

begin;

create extension if not exists pgcrypto;

alter table public.patients
  add column if not exists patient_id text,
  add column if not exists control_number text,
  add column if not exists control_used_at timestamptz,
  add column if not exists user_id uuid,
  add column if not exists email text,
  add column if not exists expected_delivery_date date,
  add column if not exists gestational_age text,
  add column if not exists trimester text,
  add column if not exists blood_type text,
  add column if not exists updated_at timestamptz default now();

alter table public.profiles
  add column if not exists patient_id text,
  add column if not exists control_number text;

create table if not exists public.patient_personal_information (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  patient_record_id text,
  patient_code text,
  full_name text not null,
  gender text default 'Female',
  birthdate date,
  nationality text,
  email text,
  address text,
  blood_type text,
  civil_status text,
  contact_number text,
  age integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.patient_personal_information
  add column if not exists user_id uuid,
  add column if not exists patient_record_id text,
  add column if not exists patient_code text,
  add column if not exists full_name text,
  add column if not exists gender text default 'Female',
  add column if not exists birthdate date,
  add column if not exists nationality text,
  add column if not exists email text,
  add column if not exists address text,
  add column if not exists blood_type text,
  add column if not exists civil_status text,
  add column if not exists contact_number text,
  add column if not exists age integer,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

create table if not exists public.patient_emergency_contact (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid,
  contact_person text,
  relationship text,
  contact_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Patient-only cleanup. This intentionally does not delete doctor/staff/admin defaults.
create temp table cleanup_patient_users as
select id
from public.profiles
where lower(coalesce(role, '')) = 'patient'
union
select user_id as id
from public.patients
where user_id is not null;

delete from public.medical_records mr
using public.patients p
where mr.patient_id::text = p.id::text
   or mr.patient_name = p.full_name
   or mr.patient_name = p.email
   or mr.patient_name = p.patient_id;

delete from public.schedule s
using public.patients p
where s.patient_name = p.full_name
   or s.patient_name = p.email
   or s.patient_name = p.patient_id;

delete from public.patient_emergency_contact pec
where pec.patient_id::text in (
  select ppi.id::text
  from public.patient_personal_information ppi
);

delete from public.patient_personal_information;
delete from public.patients;
delete from public.profiles where lower(coalesce(role, '')) = 'patient';
delete from auth.users where id in (select id from cleanup_patient_users);

create unique index if not exists patients_patient_id_unique
  on public.patients (patient_id)
  where patient_id is not null;

create unique index if not exists patients_control_number_unique
  on public.patients (control_number)
  where control_number is not null;

create unique index if not exists patient_personal_information_user_unique
  on public.patient_personal_information (user_id)
  where user_id is not null;

create or replace function public.get_patient_access_record(
  access_patient_id text,
  access_control_number text
)
returns table (
  id text,
  full_name text,
  patient_id text,
  control_number text,
  control_used_at timestamptz,
  user_id uuid,
  email text,
  date_of_birth date,
  age integer,
  address text,
  contact_number text,
  status text
)
language sql
security definer
set search_path = public
as $$
  select
    p.id::text,
    p.full_name,
    p.patient_id,
    p.control_number,
    p.control_used_at,
    p.user_id,
    p.email,
    p.date_of_birth,
    p.age,
    p.address,
    p.contact_number,
    p.status
  from public.patients p
  where p.control_number = access_control_number
    and (
      access_patient_id is null
      or access_patient_id = ''
      or p.patient_id = access_patient_id
    )
  limit 1;
$$;

grant usage on schema public to anon, authenticated;
grant execute on function public.get_patient_access_record(text, text) to anon, authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.patients to authenticated;
grant select, insert, update, delete on public.patient_personal_information to authenticated;
grant select, insert, update, delete on public.patient_emergency_contact to authenticated;
grant select, insert, update, delete on public.schedule to authenticated;

alter table public.patients enable row level security;
alter table public.patient_personal_information enable row level security;
alter table public.patient_emergency_contact enable row level security;
alter table public.schedule enable row level security;

drop policy if exists "Users can read own profile" on public.profiles;
drop policy if exists "Users can insert own profile" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;

create policy "Users can read own profile"
on public.profiles
for select
to authenticated
using (id = auth.uid() or email = auth.jwt() ->> 'email');

create policy "Users can insert own profile"
on public.profiles
for insert
to authenticated
with check (id = auth.uid());

create policy "Users can update own profile"
on public.profiles
for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

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

drop policy if exists "Clinic users can manage patient personal information" on public.patient_personal_information;
drop policy if exists "Patients can manage own personal information" on public.patient_personal_information;

create policy "Clinic users can manage patient personal information"
on public.patient_personal_information
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

create policy "Patients can manage own personal information"
on public.patient_personal_information
for all
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "Clinic users can manage schedules" on public.schedule;
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

notify pgrst, 'reload schema';

commit;
