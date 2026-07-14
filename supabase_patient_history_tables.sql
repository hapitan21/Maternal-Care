-- Run this in the Supabase SQL Editor.
-- Allows each patient to have multiple obstetric, medical history, and
-- initial assessment records.

create extension if not exists pgcrypto;

-- =====================================================
-- 1. PATIENT OBSTETRIC HISTORY
-- Stores Step 2: Reproductive and Obstetric Information
-- =====================================================

create table if not exists public.patient_obstetric_history (
  id uuid primary key default gen_random_uuid(),

  patient_id uuid not null
    references public.patients(id)
    on delete cascade,

  age_at_menarche integer,
  menstrual_pattern text,
  cycle_length_days integer,
  menstruation_duration_days integer,
  sexually_active boolean,
  contraceptive_method text,

  gravida integer default 0,
  para integer default 0,

  last_menstrual_period date,
  expected_delivery_date date,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint valid_age_at_menarche
    check (
      age_at_menarche is null
      or age_at_menarche between 8 and 25
    ),

  constraint valid_cycle_length
    check (
      cycle_length_days is null
      or cycle_length_days between 15 and 60
    ),

  constraint valid_menstruation_duration
    check (
      menstruation_duration_days is null
      or menstruation_duration_days between 1 and 15
    ),

  constraint valid_gravida
    check (gravida >= 0),

  constraint valid_para
    check (para >= 0)
);

-- If the table was created from the old SQL, remove the generated UNIQUE
-- constraint that blocks multiple records per patient.
alter table public.patient_obstetric_history
  drop constraint if exists patient_obstetric_history_patient_id_key;


-- =====================================================
-- 2. PATIENT MEDICAL HISTORY
-- Stores Step 3: Medical and Family History
-- =====================================================

create table if not exists public.patient_medical_history (
  id uuid primary key default gen_random_uuid(),

  patient_id uuid not null
    references public.patients(id)
    on delete cascade,

  allergies text[] not null default '{}'::text[],
  medical_conditions text[] not null default '{}'::text[],
  other_medical_condition text,

  family_history text[] not null default '{}'::text[],
  other_family_history text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.patient_medical_history
  drop constraint if exists patient_medical_history_patient_id_key;


-- =====================================================
-- 3. PATIENT INITIAL ASSESSMENT
-- Stores Step 4: Initial Assessment
-- =====================================================

create table if not exists public.patient_initial_assessment (
  id uuid primary key default gen_random_uuid(),

  patient_id uuid not null
    references public.patients(id)
    on delete cascade,

  hpv_vaccinated boolean,
  last_pap_smear date,
  assessment_others text,

  height_cm numeric(6,2),
  weight_kg numeric(6,2),
  blood_pressure text,
  temperature_celsius numeric(4,1),
  respiratory_rate integer,
  oxygen_saturation numeric(5,2),
  remarks text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint valid_height
    check (height_cm is null or height_cm > 0),

  constraint valid_weight
    check (weight_kg is null or weight_kg > 0),

  constraint valid_temperature
    check (
      temperature_celsius is null
      or temperature_celsius between 30 and 45
    ),

  constraint valid_respiratory_rate
    check (
      respiratory_rate is null
      or respiratory_rate between 1 and 100
    ),

  constraint valid_oxygen_saturation
    check (
      oxygen_saturation is null
      or oxygen_saturation between 0 and 100
    )
);

alter table public.patient_initial_assessment
  drop constraint if exists patient_initial_assessment_patient_id_key;


-- =====================================================
-- INDEXES
-- =====================================================

create index if not exists idx_obstetric_history_patient_id
  on public.patient_obstetric_history(patient_id);

create index if not exists idx_medical_history_patient_id
  on public.patient_medical_history(patient_id);

create index if not exists idx_initial_assessment_patient_id
  on public.patient_initial_assessment(patient_id);


-- =====================================================
-- GRANTS AND RLS POLICIES
-- =====================================================

grant usage on schema public to authenticated;

grant select, insert, update, delete on public.patient_obstetric_history
  to authenticated;

grant select, insert, update, delete on public.patient_medical_history
  to authenticated;

grant select, insert, update, delete on public.patient_initial_assessment
  to authenticated;

alter table public.patient_obstetric_history enable row level security;
alter table public.patient_medical_history enable row level security;
alter table public.patient_initial_assessment enable row level security;

drop policy if exists "Clinic users can manage patient obstetric history"
  on public.patient_obstetric_history;

create policy "Clinic users can manage patient obstetric history"
on public.patient_obstetric_history
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

drop policy if exists "Clinic users can manage patient medical history"
  on public.patient_medical_history;

create policy "Clinic users can manage patient medical history"
on public.patient_medical_history
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

drop policy if exists "Clinic users can manage patient initial assessment"
  on public.patient_initial_assessment;

create policy "Clinic users can manage patient initial assessment"
on public.patient_initial_assessment
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

drop policy if exists "Patients can read own obstetric history"
  on public.patient_obstetric_history;

create policy "Patients can read own obstetric history"
on public.patient_obstetric_history
for select
to authenticated
using (
  exists (
    select 1
    from public.patients
    where patients.id = patient_obstetric_history.patient_id
      and patients.user_id = auth.uid()
  )
);

drop policy if exists "Patients can read own medical history"
  on public.patient_medical_history;

create policy "Patients can read own medical history"
on public.patient_medical_history
for select
to authenticated
using (
  exists (
    select 1
    from public.patients
    where patients.id = patient_medical_history.patient_id
      and patients.user_id = auth.uid()
  )
);

drop policy if exists "Patients can read own initial assessment"
  on public.patient_initial_assessment;

create policy "Patients can read own initial assessment"
on public.patient_initial_assessment
for select
to authenticated
using (
  exists (
    select 1
    from public.patients
    where patients.id = patient_initial_assessment.patient_id
      and patients.user_id = auth.uid()
  )
);

notify pgrst, 'reload schema';
