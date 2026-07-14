-- Run this in Supabase SQL Editor.
-- This creates/updates public.patient_login for the 3 patient-side screens:
-- 1. Submit control number
-- 2. Sign up / create account
-- 3. Login
--
-- It does not delete doctor, staff, or admin default data.

begin;

create extension if not exists pgcrypto;

create table if not exists public.patient_login (
  id uuid primary key default gen_random_uuid(),
  row_type text not null default 'credential',
  sort_order integer not null default 1,
  screen_key text not null default 'control_number',
  screen_title text,
  button_label text,
  field_labels jsonb not null default '{}'::jsonb,
  patient_record_id uuid,
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
  status text not null default 'Pending Activation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.patient_login
  add column if not exists row_type text not null default 'credential',
  add column if not exists sort_order integer not null default 1,
  add column if not exists screen_key text not null default 'control_number',
  add column if not exists screen_title text,
  add column if not exists button_label text,
  add column if not exists field_labels jsonb not null default '{}'::jsonb,
  add column if not exists patient_record_id uuid,
  add column if not exists full_name text,
  add column if not exists patient_id text,
  add column if not exists control_number text,
  add column if not exists control_used_at timestamptz,
  add column if not exists user_id uuid,
  add column if not exists email text,
  add column if not exists date_of_birth date,
  add column if not exists age integer,
  add column if not exists address text,
  add column if not exists contact_number text,
  add column if not exists status text not null default 'Pending Activation',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table public.profiles
  add column if not exists patient_id text,
  add column if not exists control_number text;

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

create table if not exists public.patient_personal_information (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  patient_record_id text,
  patient_code text,
  full_name text,
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
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

drop index if exists public.patient_login_control_number_unique;
create unique index patient_login_control_number_unique
  on public.patient_login (control_number);

drop index if exists public.patient_login_patient_id_unique;
create unique index patient_login_patient_id_unique
  on public.patient_login (patient_id);

create unique index if not exists patient_login_screen_key_unique
  on public.patient_login (screen_key)
  where row_type = 'screen';

insert into public.patient_login (
  row_type,
  sort_order,
  screen_key,
  screen_title,
  button_label,
  field_labels,
  status
)
values  
  (
    'screen',
    1,
    'control_number',
    'Enter Control Number',
    'Submit',
    '{"control_number":"Enter Control Number:"}'::jsonb,
    'Template'
  ),
  (
    'screen',
    2,
    'signup',
    'Create Patient Account',
    'Create Account',
    '{"patient_id":"Patient ID:","email":"Email:","password":"Password:","confirm_password":"Confirm Password:"}'::jsonb,
    'Template'
  ),
  (
    'screen',
    3,
    'login',
    'Patient Login',
    'Login',
    '{"email":"Email:","password":"Password:","forgot_password":"Forgot Password?"}'::jsonb,
    'Template'
  )
on conflict (screen_key)
where row_type = 'screen'
do update set
  sort_order = excluded.sort_order,
  screen_title = excluded.screen_title,
  button_label = excluded.button_label,
  field_labels = excluded.field_labels,
  updated_at = now();

insert into public.patient_login (
  row_type,
  sort_order,
  screen_key,
  screen_title,
  button_label,
  patient_record_id,
  full_name,
  patient_id,
  control_number,
  control_used_at,
  user_id,
  email,
  date_of_birth,
  age,
  address,
  contact_number,
  status
)
select
  'credential',
  1,
  case
    when p.user_id is not null or p.control_used_at is not null then 'login'
    else 'control_number'
  end,
  'Enter Control Number',
  'Submit',
  p.id,
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
  coalesce(p.status, 'Pending Activation')
from public.patients p
where p.control_number is not null
on conflict (control_number)
do update set
  patient_record_id = excluded.patient_record_id,
  full_name = excluded.full_name,
  patient_id = excluded.patient_id,
  control_used_at = excluded.control_used_at,
  user_id = excluded.user_id,
  email = excluded.email,
  date_of_birth = excluded.date_of_birth,
  age = excluded.age,
  address = excluded.address,
  contact_number = excluded.contact_number,
  status = excluded.status,
  updated_at = now();

create or replace function public.get_patient_login_access_record(
  login_patient_id text,
  login_control_number text
)
returns table (
  id uuid,
  patient_record_id uuid,
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
    pl.id,
    pl.patient_record_id,
    pl.full_name,
    pl.patient_id,
    pl.control_number,
    pl.control_used_at,
    pl.user_id,
    pl.email,
    pl.date_of_birth,
    pl.age,
    pl.address,
    pl.contact_number,
    pl.status
  from public.patient_login pl
  where pl.row_type = 'credential'
    and pl.control_number = login_control_number
    and (
      login_patient_id is null
      or login_patient_id = ''
      or pl.patient_id = login_patient_id
    )
  order by pl.created_at desc
  limit 1;
$$;

create or replace function public.upsert_patient_login_credential(
  credential_patient_record_id uuid,
  credential_full_name text,
  credential_patient_id text,
  credential_control_number text,
  credential_email text,
  credential_date_of_birth date,
  credential_age integer,
  credential_address text,
  credential_contact_number text,
  credential_status text
)
returns table (
  id uuid,
  patient_record_id uuid,
  full_name text,
  patient_id text,
  control_number text,
  email text,
  status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  saved_id uuid;
  requester_role text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.'
      using errcode = '42501';
  end if;

  select lower(profiles.role)
    into requester_role
  from public.profiles
  where profiles.id = auth.uid()
  limit 1;

  if coalesce(requester_role, '') not in ('admin', 'doctor', 'staff') then
    raise exception 'Only clinic users can save patient login credentials.'
      using errcode = '42501';
  end if;

  update public.patient_login
  set
    row_type = 'credential',
    sort_order = 1,
    screen_key = 'control_number',
    screen_title = 'Enter Control Number',
    button_label = 'Submit',
    patient_record_id = coalesce(credential_patient_record_id, patient_login.patient_record_id),
    full_name = coalesce(credential_full_name, patient_login.full_name),
    patient_id = credential_patient_id,
    control_number = credential_control_number,
    email = credential_email,
    date_of_birth = credential_date_of_birth,
    age = credential_age,
    address = credential_address,
    contact_number = credential_contact_number,
    status = coalesce(credential_status, 'Pending Activation'),
    updated_at = now()
  where row_type = 'credential'
    and (
      control_number = credential_control_number
      or patient_id = credential_patient_id
    )
  returning patient_login.id into saved_id;

  if saved_id is null then
    insert into public.patient_login (
      row_type,
      sort_order,
      screen_key,
      screen_title,
      button_label,
      patient_record_id,
      full_name,
      patient_id,
      control_number,
      email,
      date_of_birth,
      age,
      address,
      contact_number,
      status
    )
    values (
      'credential',
      1,
      'control_number',
      'Enter Control Number',
      'Submit',
      credential_patient_record_id,
      credential_full_name,
      credential_patient_id,
      credential_control_number,
      credential_email,
      credential_date_of_birth,
      credential_age,
      credential_address,
      credential_contact_number,
      coalesce(credential_status, 'Pending Activation')
    )
    returning patient_login.id into saved_id;
  end if;

  return query
    select
      patient_login.id,
      patient_login.patient_record_id,
      patient_login.full_name,
      patient_login.patient_id,
      patient_login.control_number,
      patient_login.email,
      patient_login.status,
      patient_login.created_at
    from public.patient_login
    where patient_login.id = saved_id;
end;
$$;

grant usage on schema public to anon, authenticated;
grant execute on function public.get_patient_login_access_record(text, text) to anon, authenticated;
grant execute on function public.upsert_patient_login_credential(uuid, text, text, text, text, date, integer, text, text, text) to authenticated;
grant select on public.patient_login to anon;
grant select, insert, update, delete on public.patient_login to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.patients to authenticated;
grant select, insert, update, delete on public.patient_personal_information to authenticated;

alter table public.patient_login enable row level security;
alter table public.profiles enable row level security;
alter table public.patients enable row level security;
alter table public.patient_personal_information enable row level security;

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

drop policy if exists "Anon can read patient login screen templates" on public.patient_login;
drop policy if exists "Anon can verify patient login control number" on public.patient_login;
drop policy if exists "Clinic users can manage patient login rows" on public.patient_login;
drop policy if exists "Patients can read own patient login row" on public.patient_login;
drop policy if exists "Patients can update own patient login row" on public.patient_login;

create policy "Anon can read patient login screen templates"
on public.patient_login
for select
to anon
using (row_type = 'screen');

create policy "Clinic users can manage patient login rows"
on public.patient_login
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

create policy "Patients can read own patient login row"
on public.patient_login
for select
to authenticated
using (user_id = auth.uid());

create policy "Patients can update own patient login row"
on public.patient_login
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

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

notify pgrst, 'reload schema';

commit;
