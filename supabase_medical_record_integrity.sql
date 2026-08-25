-- Manual migration: review in a non-production environment before applying.
-- Historical rows remain valid because both relationship columns are nullable.
-- This migration intentionally performs no backfill and changes no RLS policies.

begin;

alter table public.medical_records
  add column if not exists schedule_id uuid,
  add column if not exists doctor_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'medical_records_schedule_id_fkey'
      and conrelid = 'public.medical_records'::regclass
  ) then
    alter table public.medical_records
      add constraint medical_records_schedule_id_fkey
      foreign key (schedule_id)
      references public.schedule(id)
      on delete restrict;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'medical_records_doctor_id_fkey'
      and conrelid = 'public.medical_records'::regclass
  ) then
    alter table public.medical_records
      add constraint medical_records_doctor_id_fkey
      foreign key (doctor_id)
      references public.profiles(id)
      on delete restrict;
  end if;
end
$$;

create unique index if not exists medical_records_schedule_id_unique
  on public.medical_records (schedule_id)
  where schedule_id is not null;

create index if not exists medical_records_doctor_id_idx
  on public.medical_records (doctor_id)
  where doctor_id is not null;

comment on column public.medical_records.schedule_id is
  'Nullable exact schedule UUID. Historical records are intentionally not backfilled.';

comment on column public.medical_records.doctor_id is
  'Nullable authenticated Doctor UUID linked to public.profiles.id.';

commit;
