-- ============================================================
-- SAFE PATIENT SOFT-ARCHIVE SETUP
-- Preserves patients and all connected clinical history
-- ============================================================

begin;

-- ============================================================
-- 1. Add archive metadata
-- ============================================================

alter table public.patients
  add column if not exists status text default 'active',
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid;

-- Repair existing rows that have a null or blank status
update public.patients
set status = 'active'
where status is null
   or trim(status) = '';

alter table public.patients
  alter column status set default 'active',
  alter column status set not null;


-- ============================================================
-- 2. Add archived_by foreign key
-- ============================================================

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'patients_archived_by_fkey'
      and conrelid = 'public.patients'::regclass
  ) then
    alter table public.patients
      add constraint patients_archived_by_fkey
      foreign key (archived_by)
      references auth.users(id)
      on delete set null;
  end if;
end;
$$;


-- ============================================================
-- 3. Add indexes
-- ============================================================

create index if not exists patients_status_idx
on public.patients (lower(status));

create index if not exists patients_archived_at_idx
on public.patients (archived_at)
where archived_at is not null;


-- ============================================================
-- 4. Enable RLS and permissions
-- ============================================================

alter table public.patients
enable row level security;

grant select, insert, update
on public.patients
to authenticated;


-- ============================================================
-- 5. Replace clinic-user policies
-- ============================================================

drop policy if exists
  "Clinic users can manage patients"
  on public.patients;

drop policy if exists
  "Clinic users can read patients"
  on public.patients;

drop policy if exists
  "Clinic users can insert patients"
  on public.patients;

drop policy if exists
  "Clinic users can update patients"
  on public.patients;

-- Remove the older permanent-delete policy if it exists
drop policy if exists
  "Admins can delete unlinked test patients"
  on public.patients;


create policy "Clinic users can read patients"
on public.patients
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and lower(coalesce(profiles.role, ''))
          in ('admin', 'doctor', 'staff')
  )
);


create policy "Clinic users can insert patients"
on public.patients
for insert
to authenticated
with check (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and lower(coalesce(profiles.role, ''))
          in ('admin', 'doctor', 'staff')
  )
);


create policy "Clinic users can update patients"
on public.patients
for update
to authenticated
using (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and lower(coalesce(profiles.role, ''))
          in ('admin', 'doctor', 'staff')
  )
)
with check (
  exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and lower(coalesce(profiles.role, ''))
          in ('admin', 'doctor', 'staff')
  )
);


notify pgrst, 'reload schema';

commit;