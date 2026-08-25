-- MANUAL REVIEW REQUIRED. Do not execute automatically.
-- Adds an idempotent, transactional Staff Patient registration workflow.

begin;

-- Fail before any function is created when the live schema differs from the
-- types verified through the project PostgREST API on 2026-07-20.
do $preflight$
declare
  type_mismatch text;
  pgcrypto_schema text;
  patient_status_checks text;
  patient_status_default text;
begin
  if pg_catalog.to_regprocedure('pg_catalog.gen_random_uuid()') is null then
    raise exception 'Required PostgreSQL function pg_catalog.gen_random_uuid() is unavailable.';
  end if;

  select namespaces.nspname
    into pgcrypto_schema
  from pg_catalog.pg_extension as extensions
  join pg_catalog.pg_namespace as namespaces
    on namespaces.oid = extensions.extnamespace
  where extensions.extname = 'pgcrypto';

  raise notice 'pgcrypto extension schema: %',
    coalesce(pgcrypto_schema, '<not installed; not required by this migration>');

  with expected_types(table_schema, table_name, column_name, expected_type) as (
    values
      ('public', 'patients', 'id', 'uuid'),
      ('public', 'patients', 'full_name', 'text'),
      ('public', 'patients', 'patient_id', 'text'),
      ('public', 'patients', 'control_number', 'text'),
      ('public', 'patients', 'date_of_birth', 'date'),
      ('public', 'patients', 'age', 'integer'),
      ('public', 'patients', 'address', 'text'),
      ('public', 'patients', 'contact_number', 'text'),
      ('public', 'patients', 'email', 'text'),
      ('public', 'patients', 'expected_delivery_date', 'date'),
      ('public', 'patients', 'blood_type', 'text'),
      ('public', 'patients', 'status', 'text'),
      ('public', 'patients', 'account_status', 'text'),
      ('public', 'patients', 'control_used_at', 'timestamp with time zone'),
      ('public', 'patients', 'user_id', 'uuid'),
      ('public', 'patients', 'created_at', 'timestamp with time zone'),
      ('public', 'patients', 'updated_at', 'timestamp with time zone'),
      ('public', 'patient_personal_information', 'id', 'uuid'),
      ('public', 'patient_personal_information', 'user_id', 'uuid'),
      ('public', 'patient_personal_information', 'patient_record_id', 'text'),
      ('public', 'patient_personal_information', 'patient_code', 'text'),
      ('public', 'patient_personal_information', 'full_name', 'text'),
      ('public', 'patient_personal_information', 'gender', 'text'),
      ('public', 'patient_personal_information', 'email', 'text'),
      ('public', 'patient_personal_information', 'birthdate', 'date'),
      ('public', 'patient_personal_information', 'age', 'integer'),
      ('public', 'patient_personal_information', 'address', 'text'),
      ('public', 'patient_personal_information', 'contact_number', 'text'),
      ('public', 'patient_personal_information', 'blood_type', 'text'),
      ('public', 'patient_personal_information', 'updated_at', 'timestamp with time zone'),
      ('public', 'patient_emergency_contact', 'id', 'uuid'),
      ('public', 'patient_emergency_contact', 'patient_id', 'uuid'),
      ('public', 'patient_emergency_contact', 'contact_person', 'text'),
      ('public', 'patient_emergency_contact', 'relationship', 'text'),
      ('public', 'patient_emergency_contact', 'contact_number', 'text'),
      ('public', 'patient_emergency_contact', 'updated_at', 'timestamp with time zone'),
      ('public', 'patient_obstetric_history', 'id', 'uuid'),
      ('public', 'patient_obstetric_history', 'patient_id', 'uuid'),
      ('public', 'patient_obstetric_history', 'age_at_menarche', 'integer'),
      ('public', 'patient_obstetric_history', 'menstrual_pattern', 'text'),
      ('public', 'patient_obstetric_history', 'cycle_length_days', 'integer'),
      ('public', 'patient_obstetric_history', 'menstruation_duration_days', 'integer'),
      ('public', 'patient_obstetric_history', 'sexually_active', 'boolean'),
      ('public', 'patient_obstetric_history', 'contraceptive_method', 'text'),
      ('public', 'patient_obstetric_history', 'gravida', 'integer'),
      ('public', 'patient_obstetric_history', 'para', 'integer'),
      ('public', 'patient_obstetric_history', 'last_menstrual_period', 'date'),
      ('public', 'patient_obstetric_history', 'expected_delivery_date', 'date'),
      ('public', 'patient_obstetric_history', 'updated_at', 'timestamp with time zone'),
      ('public', 'patient_medical_history', 'id', 'uuid'),
      ('public', 'patient_medical_history', 'patient_id', 'uuid'),
      ('public', 'patient_medical_history', 'allergies', 'text[]'),
      ('public', 'patient_medical_history', 'medical_conditions', 'text[]'),
      ('public', 'patient_medical_history', 'other_medical_condition', 'text'),
      ('public', 'patient_medical_history', 'family_history', 'text[]'),
      ('public', 'patient_medical_history', 'other_family_history', 'text'),
      ('public', 'patient_medical_history', 'updated_at', 'timestamp with time zone'),
      ('public', 'profiles', 'id', 'uuid'),
      ('public', 'profiles', 'role', 'text'),
      ('auth', 'users', 'id', 'uuid')
  ), actual_types as (
    select
      expected_types.*,
      pg_catalog.format_type(attributes.atttypid, attributes.atttypmod) as actual_type
    from expected_types
    left join pg_catalog.pg_namespace as namespaces
      on namespaces.nspname = expected_types.table_schema
    left join pg_catalog.pg_class as relations
      on relations.relnamespace = namespaces.oid
     and relations.relname = expected_types.table_name
     and relations.relkind in ('r', 'p')
    left join pg_catalog.pg_attribute as attributes
      on attributes.attrelid = relations.oid
     and attributes.attname = expected_types.column_name
     and attributes.attnum > 0
     and not attributes.attisdropped
  )
  select pg_catalog.string_agg(
    pg_catalog.format(
      '%I.%I.%I expected %s but found %s',
      table_schema,
      table_name,
      column_name,
      expected_type,
      coalesce(actual_type, '<missing>')
    ),
    '; '
  )
    into type_mismatch
  from actual_types
  where actual_type is distinct from expected_type;

  if type_mismatch is not null then
    raise exception 'Patient registration schema preflight failed: %', type_mismatch;
  end if;

  select pg_catalog.pg_get_expr(defaults.adbin, defaults.adrelid)
    into patient_status_default
  from pg_catalog.pg_attribute as attributes
  left join pg_catalog.pg_attrdef as defaults
    on defaults.adrelid = attributes.attrelid
   and defaults.adnum = attributes.attnum
  where attributes.attrelid = 'public.patients'::pg_catalog.regclass
    and attributes.attname = 'status'
    and attributes.attnum > 0
    and not attributes.attisdropped;

  if patient_status_default is null then
    raise exception 'public.patients.status must have a valid database default before applying this workflow.';
  end if;

  select pg_catalog.string_agg(
    constraints.conname || ': ' || pg_catalog.pg_get_constraintdef(constraints.oid, true),
    '; '
  )
    into patient_status_checks
  from pg_catalog.pg_constraint as constraints
  join pg_catalog.pg_attribute as status_attribute
    on status_attribute.attrelid = constraints.conrelid
   and status_attribute.attname = 'status'
  where constraints.conrelid = 'public.patients'::pg_catalog.regclass
    and constraints.contype = 'c'
    and status_attribute.attnum = any(constraints.conkey);

  raise notice 'patients.status default used for new registrations: %', patient_status_default;
  raise notice 'patients.status check constraints: %',
    coalesce(patient_status_checks, '<none; status is unconstrained text>');
end;
$preflight$;

alter table public.patients
  add column if not exists registration_token uuid,
  add column if not exists registration_status text not null default 'completed',
  add column if not exists registration_draft jsonb,
  add column if not exists access_handoff_confirmed_at timestamptz,
  add column if not exists access_handoff_confirmed_by uuid,
  add column if not exists account_status text not null default 'pending_activation',
  add column if not exists control_used_at timestamptz,
  add column if not exists user_id uuid,
  add column if not exists patient_id text,
  add column if not exists control_number text,
  add column if not exists expected_delivery_date date,
  add column if not exists blood_type text,
  add column if not exists updated_at timestamptz default pg_catalog.now();

alter table public.patient_personal_information
  add column if not exists occupation text,
  add column if not exists work_address text,
  add column if not exists company text,
  add column if not exists work_contact_number text;

alter table public.patient_obstetric_history
  add column if not exists pregnancy_records jsonb not null default '[]'::jsonb;

alter table public.patient_medical_history
  add column if not exists allergy_records jsonb not null default '[]'::jsonb;

update public.patient_medical_history
set allergy_records = '[]'::jsonb
where allergy_records is null;

alter table public.patient_medical_history
  alter column allergy_records set default '[]'::jsonb,
  alter column allergy_records set not null;

do $workflow_columns$
declare
  type_mismatch text;
begin
  with expected_types(table_schema, table_name, column_name, expected_type) as (
    values
      ('public', 'patients', 'registration_token', 'uuid'),
      ('public', 'patients', 'registration_status', 'text'),
      ('public', 'patients', 'registration_draft', 'jsonb'),
      ('public', 'patients', 'access_handoff_confirmed_at', 'timestamp with time zone'),
      ('public', 'patients', 'access_handoff_confirmed_by', 'uuid'),
      ('public', 'patient_personal_information', 'occupation', 'text'),
      ('public', 'patient_personal_information', 'work_address', 'text'),
      ('public', 'patient_personal_information', 'company', 'text'),
      ('public', 'patient_personal_information', 'work_contact_number', 'text'),
      ('public', 'patient_obstetric_history', 'pregnancy_records', 'jsonb'),
      ('public', 'patient_medical_history', 'allergy_records', 'jsonb')
  ), actual_types as (
    select
      expected_types.*,
      pg_catalog.format_type(attributes.atttypid, attributes.atttypmod) as actual_type
    from expected_types
    left join pg_catalog.pg_namespace as namespaces
      on namespaces.nspname = expected_types.table_schema
    left join pg_catalog.pg_class as relations
      on relations.relnamespace = namespaces.oid
     and relations.relname = expected_types.table_name
    left join pg_catalog.pg_attribute as attributes
      on attributes.attrelid = relations.oid
     and attributes.attname = expected_types.column_name
     and attributes.attnum > 0
     and not attributes.attisdropped
  )
  select pg_catalog.string_agg(
    pg_catalog.format(
      '%I.%I.%I expected %s but found %s',
      table_schema,
      table_name,
      column_name,
      expected_type,
      coalesce(actual_type, '<missing>')
    ),
    '; '
  )
    into type_mismatch
  from actual_types
  where actual_type is distinct from expected_type;

  if type_mismatch is not null then
    raise exception 'Patient registration workflow-column preflight failed: %', type_mismatch;
  end if;
end;
$workflow_columns$;

do $constraints$
declare
  existing_handoff_constraint pg_catalog.pg_constraint%rowtype;
  handoff_constraint_exists boolean := false;
begin
  alter table public.patients
    drop constraint if exists patients_registration_status_check;

  alter table public.patients
    add constraint patients_registration_status_check
    check (registration_status in ('awaiting_patient_access_confirmation', 'completed'));

  select constraints.*
    into existing_handoff_constraint
  from pg_catalog.pg_constraint as constraints
  where constraints.conname = 'patients_access_handoff_confirmed_by_fkey'
    and constraints.conrelid = 'public.patients'::pg_catalog.regclass;

  handoff_constraint_exists := found;

  if handoff_constraint_exists and not (
    existing_handoff_constraint.contype = 'f'
    and existing_handoff_constraint.confrelid = 'auth.users'::pg_catalog.regclass
    and existing_handoff_constraint.confdeltype = 'n'
    and existing_handoff_constraint.conkey = array[
      (
        select attributes.attnum
        from pg_catalog.pg_attribute as attributes
        where attributes.attrelid = 'public.patients'::pg_catalog.regclass
          and attributes.attname = 'access_handoff_confirmed_by'
          and attributes.attnum > 0
          and not attributes.attisdropped
      )
    ]::smallint[]
    and existing_handoff_constraint.confkey = array[
      (
        select attributes.attnum
        from pg_catalog.pg_attribute as attributes
        where attributes.attrelid = 'auth.users'::pg_catalog.regclass
          and attributes.attname = 'id'
          and attributes.attnum > 0
          and not attributes.attisdropped
      )
    ]::smallint[]
  ) then
    raise exception 'Existing patients_access_handoff_confirmed_by_fkey does not match auth.users(id) ON DELETE SET NULL.';
  end if;

  if not handoff_constraint_exists then
    alter table public.patients
      add constraint patients_access_handoff_confirmed_by_fkey
      foreign key (access_handoff_confirmed_by)
      references auth.users(id)
      on delete set null;
  end if;
end;
$constraints$;

create unique index if not exists patients_registration_token_unique
  on public.patients (registration_token)
  where registration_token is not null;

create unique index if not exists patients_patient_id_unique
  on public.patients (patient_id)
  where patient_id is not null;

create unique index if not exists patients_control_number_unique
  on public.patients (control_number)
  where control_number is not null;

-- Exact signatures only. This keeps the migration rerunnable when a return type
-- or the finish parameters change.
drop function if exists public.save_patient_registration(uuid, uuid, jsonb);
drop function if exists public.finish_patient_registration(uuid, uuid);
drop function if exists public.finish_patient_registration(uuid, uuid, boolean);
drop function if exists public.get_patient_registration_draft(uuid, uuid);

create function public.save_patient_registration(
  p_registration_token uuid,
  p_patient_record_id uuid default null,
  p_registration_data jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  full_name text,
  patient_id text,
  control_number text,
  date_of_birth date,
  age integer,
  contact_number text,
  email text,
  address text,
  status text,
  account_status text,
  registration_status text,
  user_id uuid,
  control_used_at timestamptz,
  created_at timestamptz,
  registration_data jsonb
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  registration_patient public.patients%rowtype;
  personal_information_id uuid;
  generated_patient_id text;
  generated_control_number text;
  random_uuid_characters text;
  registration_year text := pg_catalog.to_char(current_date, 'YYYY');
  next_patient_number integer;
  allergies text[];
  allergy_records jsonb := '[]'::jsonb;
  medical_conditions text[];
  family_history text[];
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profiles.role, ''))) in ('staff', 'admin')
  ) then
    raise exception 'Only authenticated Staff or Admin users can register Patients.'
      using errcode = '42501';
  end if;

  if p_registration_token is null then
    raise exception 'A registration token is required.' using errcode = '22023';
  end if;

  if nullif(pg_catalog.btrim(p_registration_data ->> 'name'), '') is null
     or nullif(pg_catalog.btrim(p_registration_data ->> 'age'), '') is null
     or nullif(pg_catalog.btrim(p_registration_data ->> 'birthdate'), '') is null
     or nullif(pg_catalog.btrim(p_registration_data ->> 'address'), '') is null
     or nullif(pg_catalog.btrim(p_registration_data ->> 'contactNumber'), '') is null
     or nullif(pg_catalog.btrim(p_registration_data ->> 'gravida'), '') is null
     or nullif(pg_catalog.btrim(p_registration_data ->> 'para'), '') is null then
    raise exception 'Required Patient registration fields are incomplete.'
      using errcode = '22023';
  end if;

  select coalesce(pg_catalog.array_agg(value), '{}'::text[])
    into medical_conditions
  from pg_catalog.jsonb_array_elements_text(
    coalesce(p_registration_data -> 'medicalConditions', '[]'::jsonb)
  ) as items(value);

  select coalesce(pg_catalog.array_agg(value), '{}'::text[])
    into family_history
  from pg_catalog.jsonb_array_elements_text(
    coalesce(p_registration_data -> 'familyHistory', '[]'::jsonb)
  ) as items(value);

  if p_registration_data ? 'allergies'
     and pg_catalog.jsonb_typeof(p_registration_data -> 'allergies') <> 'array' then
    raise exception 'Allergy records must be a JSON array.'
      using errcode = '22023';
  end if;

  if p_registration_data ? 'allergies'
     and pg_catalog.jsonb_array_length(coalesce(p_registration_data -> 'allergies', '[]'::jsonb)) > 0 then
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(coalesce(p_registration_data -> 'allergies', '[]'::jsonb)) as items(value)
      where pg_catalog.jsonb_typeof(items.value) <> 'object'
         or pg_catalog.lower(pg_catalog.btrim(coalesce(items.value ->> 'type', ''))) not in (
           'medication',
           'food',
           'environmental',
           'insect',
           'latex',
           'chemical'
         )
         or nullif(pg_catalog.btrim(coalesce(items.value ->> 'allergen', '')), '') is null
    ) then
      raise exception 'Each allergy record must include an accepted type and allergen.'
        using errcode = '22023';
    end if;

    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id',
          coalesce(
            nullif(pg_catalog.btrim(value ->> 'id'), ''),
            pg_catalog.gen_random_uuid()::text
          ),
          'type',
          pg_catalog.lower(pg_catalog.btrim(value ->> 'type')),
          'allergen',
          pg_catalog.btrim(value ->> 'allergen'),
          'reaction',
          pg_catalog.btrim(coalesce(value ->> 'reaction', ''))
        )
        order by ordinality
      ),
      '[]'::jsonb
    )
      into allergy_records
    from pg_catalog.jsonb_array_elements(coalesce(p_registration_data -> 'allergies', '[]'::jsonb))
      with ordinality as items(value, ordinality);

    select coalesce(pg_catalog.array_agg(
      pg_catalog.concat_ws(
        ': ',
        case allergy.value ->> 'type'
          when 'medication' then 'Medication Allergy'
          when 'food' then 'Food Allergy'
          when 'environmental' then 'Environmental Allergy'
          when 'insect' then 'Insect Allergy'
          when 'latex' then 'Latex Allergy'
          when 'chemical' then 'Chemical Allergy'
          else allergy.value ->> 'type'
        end,
        nullif(pg_catalog.btrim(allergy.value ->> 'allergen'), ''),
        nullif(pg_catalog.btrim(coalesce(allergy.value ->> 'reaction', '')), '')
      )
      order by ordinality
    ), '{}'::text[])
      into allergies
    from pg_catalog.jsonb_array_elements(allergy_records)
      with ordinality as allergy(value, ordinality);
  end if;

  if coalesce(pg_catalog.cardinality(allergies), 0) = 0 then
    allergies := pg_catalog.array_remove(array[
      nullif(pg_catalog.btrim(p_registration_data ->> 'allergyOne'), ''),
      nullif(pg_catalog.btrim(p_registration_data ->> 'allergyTwo'), ''),
      nullif(pg_catalog.btrim(p_registration_data ->> 'allergyThree'), '')
    ], null);
  end if;

  select patients.*
    into registration_patient
  from public.patients
  where patients.registration_token = p_registration_token
  for update;

  if found and registration_patient.registration_status = 'completed' then
    raise exception 'This Patient registration has already been completed.'
      using errcode = 'P0001';
  end if;

  if found and registration_patient.registration_status <> 'awaiting_patient_access_confirmation' then
    raise exception 'The Patient registration is not available for editing.'
      using errcode = 'P0001';
  end if;

  if found and p_patient_record_id is not null
     and registration_patient.id <> p_patient_record_id then
    raise exception 'Registration token does not match the Patient record.'
      using errcode = '22023';
  end if;

  if not found then
    if p_patient_record_id is not null then
      raise exception 'The provisional Patient record could not be found.'
        using errcode = 'P0002';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('maternal-patient-registration', 0)
    );

    select coalesce(pg_catalog.max((pg_catalog.substring(patients.patient_id, '([0-9]+)$'))::integer), 0) + 1
      into next_patient_number
    from public.patients
    where patients.patient_id like 'LP-' || registration_year || '-%';

    generated_patient_id :=
      'LP-' || registration_year || '-' || pg_catalog.lpad(next_patient_number::text, 5, '0');

    loop
      random_uuid_characters := pg_catalog.replace(
        pg_catalog.gen_random_uuid()::text,
        '-',
        ''
      );
      generated_control_number :=
        'LPMRH-' || pg_catalog.upper(pg_catalog.substr(random_uuid_characters, 1, 4)) ||
        '-' || pg_catalog.upper(pg_catalog.substr(random_uuid_characters, 5, 4));
      exit when not exists (
        select 1 from public.patients
        where patients.control_number = generated_control_number
      );
    end loop;

    insert into public.patients (
      full_name,
      patient_id,
      control_number,
      date_of_birth,
      age,
      address,
      contact_number,
      email,
      expected_delivery_date,
      blood_type,
      account_status,
      registration_status,
      registration_token,
      registration_draft,
      user_id,
      control_used_at,
      updated_at
    ) values (
      pg_catalog.btrim(p_registration_data ->> 'name'),
      generated_patient_id,
      generated_control_number,
      (p_registration_data ->> 'birthdate')::date,
      (p_registration_data ->> 'age')::integer,
      pg_catalog.btrim(p_registration_data ->> 'address'),
      pg_catalog.btrim(p_registration_data ->> 'contactNumber'),
      nullif(pg_catalog.btrim(p_registration_data ->> 'email'), ''),
      nullif(p_registration_data ->> 'edd', '')::date,
      nullif(pg_catalog.btrim(p_registration_data ->> 'bloodType'), ''),
      'pending_activation',
      'awaiting_patient_access_confirmation',
      p_registration_token,
      p_registration_data,
      null,
      null,
      pg_catalog.now()
    )
    returning public.patients.* into registration_patient;
  else
    update public.patients
    set full_name = pg_catalog.btrim(p_registration_data ->> 'name'),
        date_of_birth = (p_registration_data ->> 'birthdate')::date,
        age = (p_registration_data ->> 'age')::integer,
        address = pg_catalog.btrim(p_registration_data ->> 'address'),
        contact_number = pg_catalog.btrim(p_registration_data ->> 'contactNumber'),
        email = nullif(pg_catalog.btrim(p_registration_data ->> 'email'), ''),
        expected_delivery_date = nullif(p_registration_data ->> 'edd', '')::date,
        blood_type = nullif(pg_catalog.btrim(p_registration_data ->> 'bloodType'), ''),
        registration_status = 'awaiting_patient_access_confirmation',
        registration_draft = p_registration_data,
        updated_at = pg_catalog.now()
    where public.patients.id = registration_patient.id
    returning public.patients.* into registration_patient;
  end if;

  delete from public.patient_emergency_contact
  using public.patient_personal_information
  where patient_emergency_contact.patient_id = patient_personal_information.id
    and patient_personal_information.patient_record_id = registration_patient.id::text;

  delete from public.patient_personal_information
  where patient_personal_information.patient_record_id = registration_patient.id::text;

  insert into public.patient_personal_information (
    patient_record_id,
    patient_code,
    full_name,
    gender,
    email,
    birthdate,
    age,
    address,
    contact_number,
    occupation,
    work_address,
    company,
    work_contact_number,
    blood_type,
    updated_at
  ) values (
    registration_patient.id::text,
    registration_patient.patient_id,
    pg_catalog.btrim(p_registration_data ->> 'name'),
    'Female',
    nullif(pg_catalog.btrim(p_registration_data ->> 'email'), ''),
    (p_registration_data ->> 'birthdate')::date,
    (p_registration_data ->> 'age')::integer,
    pg_catalog.btrim(p_registration_data ->> 'address'),
    pg_catalog.btrim(p_registration_data ->> 'contactNumber'),
    nullif(pg_catalog.btrim(p_registration_data ->> 'occupation'), ''),
    nullif(pg_catalog.btrim(p_registration_data ->> 'workAddress'), ''),
    nullif(pg_catalog.btrim(p_registration_data ->> 'company'), ''),
    nullif(pg_catalog.btrim(p_registration_data ->> 'workContactNumber'), ''),
    nullif(pg_catalog.btrim(p_registration_data ->> 'bloodType'), ''),
    pg_catalog.now()
  )
  returning public.patient_personal_information.id into personal_information_id;

  if nullif(pg_catalog.btrim(p_registration_data ->> 'husbandPartner'), '') is not null
     or nullif(pg_catalog.btrim(p_registration_data ->> 'partnerContactNumber'), '') is not null then
    insert into public.patient_emergency_contact (
      patient_id,
      contact_person,
      relationship,
      contact_number,
      updated_at
    ) values (
      personal_information_id,
      coalesce(nullif(pg_catalog.btrim(p_registration_data ->> 'husbandPartner'), ''), 'Emergency Contact'),
      'Husband/Partner',
      nullif(pg_catalog.btrim(p_registration_data ->> 'partnerContactNumber'), ''),
      pg_catalog.now()
    );
  end if;

  delete from public.patient_obstetric_history
  where patient_obstetric_history.patient_id = registration_patient.id;
  insert into public.patient_obstetric_history (
    patient_id,
    age_at_menarche,
    menstrual_pattern,
    cycle_length_days,
    menstruation_duration_days,
    sexually_active,
    contraceptive_method,
    gravida,
    para,
    last_menstrual_period,
    expected_delivery_date,
    pregnancy_records,
    updated_at
  ) values (
    registration_patient.id,
    nullif(p_registration_data ->> 'ageMenarche', '')::integer,
    nullif(pg_catalog.btrim(p_registration_data ->> 'menstrualPattern'), ''),
    nullif(p_registration_data ->> 'cycleLength', '')::integer,
    nullif(p_registration_data ->> 'durationMenstruation', '')::integer,
    case p_registration_data ->> 'sexuallyActive'
      when 'Yes' then true when 'No' then false else null
    end,
    nullif(pg_catalog.btrim(p_registration_data ->> 'contraceptiveMethod'), ''),
    (p_registration_data ->> 'gravida')::integer,
    (p_registration_data ->> 'para')::integer,
    nullif(p_registration_data ->> 'lmp', '')::date,
    nullif(p_registration_data ->> 'edd', '')::date,
    coalesce(p_registration_data -> 'pregnancyRecords', '[]'::jsonb),
    pg_catalog.now()
  );

  delete from public.patient_medical_history
  where patient_medical_history.patient_id = registration_patient.id;
  insert into public.patient_medical_history (
    patient_id,
    allergies,
    allergy_records,
    medical_conditions,
    other_medical_condition,
    family_history,
    other_family_history,
    updated_at
  ) values (
    registration_patient.id,
    allergies,
    allergy_records,
    medical_conditions,
    nullif(pg_catalog.btrim(p_registration_data ->> 'medicalOther'), ''),
    family_history,
    nullif(pg_catalog.btrim(p_registration_data ->> 'familyOther'), ''),
    pg_catalog.now()
  );

  return query
  select
    registration_patient.id,
    registration_patient.full_name,
    registration_patient.patient_id,
    registration_patient.control_number,
    registration_patient.date_of_birth,
    registration_patient.age,
    registration_patient.contact_number,
    registration_patient.email,
    registration_patient.address,
    registration_patient.status,
    registration_patient.account_status,
    registration_patient.registration_status,
    registration_patient.user_id,
    registration_patient.control_used_at,
    registration_patient.created_at,
    p_registration_data;
end;
$function$;

create function public.finish_patient_registration(
  p_patient_record_id uuid,
  p_registration_token uuid,
  p_access_handoff_confirmed boolean
)
returns table (
  id uuid,
  full_name text,
  patient_id text,
  control_number text,
  date_of_birth date,
  age integer,
  contact_number text,
  email text,
  address text,
  status text,
  account_status text,
  registration_status text,
  user_id uuid,
  control_used_at timestamptz,
  created_at timestamptz,
  registration_data jsonb
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  registration_patient public.patients%rowtype;
begin
  if auth.uid() is null or not exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profiles.role, ''))) in ('staff', 'admin')
  ) then
    raise exception 'Only authenticated Staff or Admin users can finish Patient registration.'
      using errcode = '42501';
  end if;

  if p_access_handoff_confirmed is distinct from true then
    raise exception 'Confirm that the Patient received or scanned the QR code before finishing the registration.'
      using errcode = '22023';
  end if;

  select patients.*
    into registration_patient
  from public.patients
  where patients.id = p_patient_record_id
    and patients.registration_token = p_registration_token
  for update;

  if not found then
    raise exception 'The provisional Patient registration could not be found.'
      using errcode = 'P0002';
  end if;

  if registration_patient.registration_status = 'completed' then
    raise exception 'This Patient registration has already been completed.'
      using errcode = 'P0001';
  end if;

  if registration_patient.registration_status <> 'awaiting_patient_access_confirmation' then
    raise exception 'The Patient registration is not ready to be completed.'
      using errcode = 'P0001';
  end if;

  return query
  update public.patients
  set registration_status = 'completed',
      registration_draft = null,
      access_handoff_confirmed_at = pg_catalog.now(),
      access_handoff_confirmed_by = auth.uid(),
      updated_at = pg_catalog.now()
  where public.patients.id = p_patient_record_id
    and public.patients.registration_token = p_registration_token
    and public.patients.registration_status = 'awaiting_patient_access_confirmation'
  returning
    public.patients.id,
    public.patients.full_name,
    public.patients.patient_id,
    public.patients.control_number,
    public.patients.date_of_birth,
    public.patients.age,
    public.patients.contact_number,
    public.patients.email,
    public.patients.address,
    public.patients.status,
    public.patients.account_status,
    public.patients.registration_status,
    public.patients.user_id,
    public.patients.control_used_at,
    public.patients.created_at,
    null::jsonb;

end;
$function$;

create function public.get_patient_registration_draft(
  p_patient_record_id uuid,
  p_registration_token uuid
)
returns table (
  id uuid,
  full_name text,
  patient_id text,
  control_number text,
  date_of_birth date,
  age integer,
  contact_number text,
  email text,
  address text,
  status text,
  account_status text,
  registration_status text,
  user_id uuid,
  control_used_at timestamptz,
  created_at timestamptz,
  registration_data jsonb
)
language plpgsql
security definer
stable
set search_path = ''
as $function$
begin
  if auth.uid() is null or not exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profiles.role, ''))) in ('staff', 'admin')
  ) then
    raise exception 'Only authenticated Staff or Admin users can restore Patient registration.'
      using errcode = '42501';
  end if;

  return query
  select
    patients.id,
    patients.full_name,
    patients.patient_id,
    patients.control_number,
    patients.date_of_birth,
    patients.age,
    patients.contact_number,
    patients.email,
    patients.address,
    patients.status,
    patients.account_status,
    patients.registration_status,
    patients.user_id,
    patients.control_used_at,
    patients.created_at,
    patients.registration_draft
  from public.patients
  where patients.id = p_patient_record_id
    and patients.registration_token = p_registration_token
    and patients.registration_status = 'awaiting_patient_access_confirmation';
end;
$function$;

revoke all on function public.save_patient_registration(uuid, uuid, jsonb) from public;
revoke all on function public.save_patient_registration(uuid, uuid, jsonb) from anon;
grant execute on function public.save_patient_registration(uuid, uuid, jsonb) to authenticated;

revoke all on function public.finish_patient_registration(uuid, uuid, boolean) from public;
revoke all on function public.finish_patient_registration(uuid, uuid, boolean) from anon;
grant execute on function public.finish_patient_registration(uuid, uuid, boolean) to authenticated;

revoke all on function public.get_patient_registration_draft(uuid, uuid) from public;
revoke all on function public.get_patient_registration_draft(uuid, uuid) from anon;
grant execute on function public.get_patient_registration_draft(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';

commit;

-- Post-apply verification (read only):
-- select registration_status, account_status, user_id, control_used_at, count(*)
-- from public.patients
-- group by registration_status, account_status, user_id, control_used_at;

