-- Run this in the Supabase SQL Editor.
-- Staff > Settings > Account support table.
-- This table stores only public account settings after Supabase Auth confirms
-- the login email. It does not store passwords, OTPs, or pending emails.

create extension if not exists pgcrypto;

create table if not exists public.doctor_account_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email_address text,
  contact_number text,
  two_factor_auth boolean not null default false,
  login_notifications boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint doctor_account_settings_email_format
    check (
      email_address is null
      or email_address ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'
    )
);

alter table public.doctor_account_settings
  add column if not exists user_id uuid,
  add column if not exists email_address text,
  add column if not exists contact_number text,
  add column if not exists two_factor_auth boolean not null default false,
  add column if not exists login_notifications boolean not null default false,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists doctor_account_settings_user_id_key
  on public.doctor_account_settings(user_id);

create index if not exists idx_doctor_account_settings_email_address
  on public.doctor_account_settings(lower(email_address));

create or replace function public.set_doctor_account_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_doctor_account_settings_updated_at
  on public.doctor_account_settings;

create trigger set_doctor_account_settings_updated_at
before update on public.doctor_account_settings
for each row
execute function public.set_doctor_account_settings_updated_at();

alter table public.doctor_account_settings enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update on public.doctor_account_settings to authenticated;

drop policy if exists "Staff can read own account settings"
  on public.doctor_account_settings;

create policy "Staff can read own account settings"
on public.doctor_account_settings
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Staff can insert own account settings"
  on public.doctor_account_settings;

create policy "Staff can insert own account settings"
on public.doctor_account_settings
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "Staff can update own account settings"
  on public.doctor_account_settings;

create policy "Staff can update own account settings"
on public.doctor_account_settings
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "Admins can manage staff account settings"
  on public.doctor_account_settings;

create policy "Admins can manage staff account settings"
on public.doctor_account_settings
for all
to authenticated
using (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and lower(profiles.role) = 'admin'
  )
)
with check (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and lower(profiles.role) = 'admin'
  )
);

notify pgrst, 'reload schema';
