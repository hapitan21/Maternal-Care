-- Manual-review migration. Do not execute automatically.
-- Uses the existing public.medical_records table for both visit form types.
--
-- Read-only verification queries:
--
-- select table_name, column_name, data_type, udt_name, is_nullable, column_default
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name in ('schedule', 'patients', 'profiles', 'medical_records')
-- order by table_name, ordinal_position;
--
-- select patient_id, count(*)
-- from public.medical_records
-- where lower(btrim(coalesce(nullif(type, ''), title, ''))) in
--       ('initial', 'initial visit', 'initial consultation')
--   and lower(btrim(coalesce(form_data ->> 'recordStatus', 'completed'))) = 'completed'
--   and lower(btrim(coalesce(form_data ->> 'isDraft', 'false'))) not in ('true', '1', 'yes')
--   and lower(btrim(coalesce(form_data ->> 'deleted', 'false'))) not in ('true', '1', 'yes')
-- group by patient_id
-- having count(*) > 1;
--
-- select schedule_id, count(*)
-- from public.medical_records
-- where schedule_id is not null
-- group by schedule_id
-- having count(*) > 1;
--
-- select routine_name, specific_name, data_type
-- from information_schema.routines
-- where routine_schema = 'public'
--   and routine_name in (
--     'get_appointment_visit_form_type',
--     'save_appointment_visit_record'
--   )
-- order by routine_name;

begin;

do $preflight$
declare
  v_mismatches text;
begin
  with expected(table_name, column_name, sql_type) as (
    values
      ('schedule', 'id', 'uuid'),
      ('schedule', 'patient_id', 'uuid'),
      ('schedule', 'doctor_id', 'uuid'),
      ('schedule', 'patient_name', 'text'),
      ('schedule', 'doctor_name', 'text'),
      ('schedule', 'title', 'text'),
      ('schedule', 'start_time', 'timestamp with time zone'),
      ('schedule', 'status', 'text'),
      ('patients', 'id', 'uuid'),
      ('profiles', 'id', 'uuid'),
      ('profiles', 'role', 'text'),
      ('profiles', 'full_name', 'text'),
      ('medical_records', 'id', 'uuid'),
      ('medical_records', 'patient_id', 'uuid'),
      ('medical_records', 'schedule_id', 'uuid'),
      ('medical_records', 'doctor_id', 'uuid'),
      ('medical_records', 'patient_name', 'text'),
      ('medical_records', 'type', 'text'),
      ('medical_records', 'title', 'text'),
      ('medical_records', 'notes', 'text'),
      ('medical_records', 'form_data', 'jsonb'),
      ('medical_records', 'uploaded_at', 'timestamp with time zone'),
      ('medical_records', 'uploaded_by', 'text')
  )
  select string_agg(
    format(
      'public.%I.%I expected %s but found %s',
      e.table_name,
      e.column_name,
      e.sql_type,
      coalesce(pg_catalog.format_type(a.atttypid, a.atttypmod), 'missing')
    ),
    '; '
  )
  into v_mismatches
  from expected e
  left join pg_namespace n on n.nspname = 'public'
  left join pg_class t on t.relnamespace = n.oid and t.relname = e.table_name
  left join pg_attribute a
    on a.attrelid = t.oid
   and a.attname = e.column_name
   and a.attnum > 0
   and not a.attisdropped
  where a.attname is null
     or pg_catalog.format_type(a.atttypid, a.atttypmod) <> e.sql_type;

  if v_mismatches is not null then
    raise exception 'Preflight failed: %', v_mismatches;
  end if;

  if exists (
    select 1
    from public.medical_records m
    where m.schedule_id is not null
    group by m.schedule_id
    having count(*) > 1
  ) then
    raise exception
      'Preflight failed: duplicate medical records exist for one or more schedule IDs.';
  end if;

  if exists (
    select 1
    from public.medical_records m
    where lower(btrim(coalesce(nullif(m.type, ''), m.title, ''))) in
          ('initial', 'initial visit', 'initial consultation')
      and lower(btrim(coalesce(m.form_data ->> 'recordStatus', 'completed'))) = 'completed'
      and lower(btrim(coalesce(m.form_data ->> 'isDraft', 'false'))) not in
          ('true', '1', 'yes')
      and lower(btrim(coalesce(m.form_data ->> 'deleted', 'false'))) not in
          ('true', '1', 'yes')
    group by m.patient_id
    having count(*) > 1
  ) then
    raise exception
      'Preflight failed: more than one completed Initial Visit exists for a Patient.';
  end if;
end;
$preflight$;

create unique index if not exists medical_records_schedule_id_unique
  on public.medical_records (schedule_id)
  where schedule_id is not null;

create unique index if not exists medical_records_one_completed_initial_visit_per_patient
  on public.medical_records (patient_id)
  where lower(btrim(coalesce(nullif(type, ''), title, ''))) in
        ('initial', 'initial visit', 'initial consultation')
    and lower(btrim(coalesce(form_data ->> 'recordStatus', 'completed'))) = 'completed'
    and lower(btrim(coalesce(form_data ->> 'isDraft', 'false'))) not in
        ('true', '1', 'yes')
    and lower(btrim(coalesce(form_data ->> 'deleted', 'false'))) not in
        ('true', '1', 'yes');

drop function if exists public.get_appointment_visit_form_type(uuid);

create function public.get_appointment_visit_form_type(
  p_appointment_id uuid
)
returns table (
  appointment_id uuid,
  patient_id uuid,
  visit_form_type text,
  has_completed_initial_visit boolean,
  appointment_status text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_appointment public.schedule%rowtype;
  v_has_initial boolean;
  v_linked_visit_type text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(btrim(coalesce(p.role, ''))) in ('doctor', 'staff', 'admin')
  ) then
    raise exception 'Only Doctors, Staff, and Admins can open visit forms.'
      using errcode = '42501';
  end if;

  select s.*
  into v_appointment
  from public.schedule s
  where s.id = p_appointment_id;

  if not found then
    raise exception 'The appointment was not found.' using errcode = 'P0002';
  end if;

  if v_appointment.patient_id is null then
    raise exception 'The appointment is not linked to a Patient record.'
      using errcode = '23502';
  end if;

  if lower(btrim(coalesce(v_appointment.status, ''))) in (
    'cancelled',
    'canceled',
    'cancel',
    'deleted',
    'missed',
    'no_show',
    'no show'
  ) then
    raise exception 'Cancelled, deleted, or missed appointments cannot open a visit form.'
      using errcode = '22023';
  end if;

  select case
    when lower(btrim(coalesce(nullif(m.type, ''), m.title, ''))) in
         ('initial', 'initial visit', 'initial consultation')
      then 'initial'
    else 'follow_up'
  end into v_linked_visit_type
  from public.medical_records m
  where m.schedule_id = v_appointment.id
  limit 1;

  select exists (
    select 1
    from public.medical_records m
    where m.patient_id = v_appointment.patient_id
      and lower(btrim(coalesce(nullif(m.type, ''), m.title, ''))) in
          ('initial', 'initial visit', 'initial consultation')
      and lower(btrim(coalesce(m.form_data ->> 'recordStatus', 'completed'))) = 'completed'
      and lower(btrim(coalesce(m.form_data ->> 'isDraft', 'false'))) not in
          ('true', '1', 'yes')
      and lower(btrim(coalesce(m.form_data ->> 'deleted', 'false'))) not in
          ('true', '1', 'yes')
  ) into v_has_initial;

  return query
  select
    v_appointment.id,
    v_appointment.patient_id,
    coalesce(v_linked_visit_type, case when v_has_initial then 'follow_up' else 'initial' end),
    v_has_initial,
    v_appointment.status;
end;
$function$;

drop function if exists public.save_appointment_visit_record(uuid, text, json);
drop function if exists public.save_appointment_visit_record(uuid, text, jsonb);

create function public.save_appointment_visit_record(
  p_appointment_id uuid,
  p_visit_form_type text,
  p_form_data jsonb
)
returns public.medical_records
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_appointment public.schedule%rowtype;
  v_existing public.medical_records%rowtype;
  v_saved public.medical_records%rowtype;
  v_actor_role text;
  v_actor_name text;
  v_requested_type text;
  v_expected_type text;
  v_existing_type text;
  v_has_initial boolean;
  v_doctor_id uuid;
  v_server_form_data jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select lower(btrim(coalesce(p.role, ''))), nullif(btrim(p.full_name), '')
  into v_actor_role, v_actor_name
  from public.profiles p
  where p.id = auth.uid();

  if v_actor_role is null or v_actor_role not in ('doctor', 'staff', 'admin') then
    raise exception 'Only Doctors, Staff, and Admins can save visit records.'
      using errcode = '42501';
  end if;

  v_requested_type := lower(btrim(coalesce(p_visit_form_type, '')));
  if v_requested_type not in ('initial', 'follow_up') then
    raise exception 'Visit form type must be initial or follow_up.'
      using errcode = '22023';
  end if;

  if p_form_data is null or jsonb_typeof(p_form_data) <> 'object' then
    raise exception 'Visit form data must be a JSON object.' using errcode = '22023';
  end if;

  if btrim(coalesce(p_form_data ->> 'chiefComplaint', '')) = ''
     or btrim(coalesce(p_form_data ->> 'assessment', '')) = ''
     or btrim(coalesce(p_form_data ->> 'diagnosis', '')) = ''
     or btrim(coalesce(p_form_data ->> 'treatmentPlan', '')) = '' then
    raise exception
      'Chief Complaint, Assessment, Diagnosis, and Plan / Treatment are required.'
      using errcode = '23502';
  end if;

  select s.*
  into v_appointment
  from public.schedule s
  where s.id = p_appointment_id
  for update;

  if not found then
    raise exception 'The appointment was not found.' using errcode = 'P0002';
  end if;

  if v_appointment.patient_id is null then
    raise exception 'The appointment is not linked to a Patient record.'
      using errcode = '23502';
  end if;

  if lower(btrim(coalesce(v_appointment.status, ''))) in (
    'cancelled',
    'canceled',
    'cancel',
    'deleted',
    'missed',
    'no_show',
    'no show'
  ) then
    raise exception 'Cancelled, deleted, or missed appointments cannot save a visit record.'
      using errcode = '22023';
  end if;

  select m.*
  into v_existing
  from public.medical_records m
  where m.schedule_id = v_appointment.id
  limit 1;

  if found then
    if v_existing.patient_id <> v_appointment.patient_id then
      raise exception 'The existing visit record belongs to a different Patient.';
    end if;

    v_existing_type := case
      when lower(btrim(coalesce(nullif(v_existing.type, ''), v_existing.title, ''))) in
           ('initial', 'initial visit', 'initial consultation')
        then 'initial'
      else 'follow_up'
    end;

    if v_existing_type <> v_requested_type then
      raise exception 'This appointment already has a different visit record type.';
    end if;

    return v_existing;
  end if;

  if lower(btrim(coalesce(v_appointment.status, ''))) not in
     ('checked_in', 'checked-in', 'checked in') then
    raise exception 'Check in the appointment before saving a visit record.'
      using errcode = '22023';
  end if;

  select exists (
    select 1
    from public.medical_records m
    where m.patient_id = v_appointment.patient_id
      and lower(btrim(coalesce(nullif(m.type, ''), m.title, ''))) in
          ('initial', 'initial visit', 'initial consultation')
      and lower(btrim(coalesce(m.form_data ->> 'recordStatus', 'completed'))) = 'completed'
      and lower(btrim(coalesce(m.form_data ->> 'isDraft', 'false'))) not in
          ('true', '1', 'yes')
      and lower(btrim(coalesce(m.form_data ->> 'deleted', 'false'))) not in
          ('true', '1', 'yes')
  ) into v_has_initial;

  v_expected_type := case when v_has_initial then 'follow_up' else 'initial' end;
  if v_requested_type <> v_expected_type then
    if v_expected_type = 'initial' then
      raise exception 'Complete the Initial Visit Form before recording a Follow-Up Visit.';
    end if;
    raise exception
      'This Patient already has an Initial Visit record. Open the Follow-Up Visit Form instead.';
  end if;

  v_doctor_id := coalesce(
    v_appointment.doctor_id,
    case when v_actor_role = 'doctor' then auth.uid() else null end
  );

  if v_doctor_id is null and nullif(btrim(v_appointment.doctor_name), '') is not null then
    select p.id
    into v_doctor_id
    from public.profiles p
    where lower(btrim(coalesce(p.role, ''))) = 'doctor'
      and lower(btrim(coalesce(p.full_name, ''))) =
          lower(btrim(v_appointment.doctor_name))
    limit 1;
  end if;

  v_server_form_data :=
    p_form_data ||
    pg_catalog.jsonb_build_object(
      'appointmentId', v_appointment.id,
      'patientId', v_appointment.patient_id,
      'doctorId', v_doctor_id,
      'visitFormType', v_requested_type,
      'recordStatus', 'completed',
      'isDraft', false,
      'completedAt', pg_catalog.now()
    );

  begin
    insert into public.medical_records (
      patient_id,
      schedule_id,
      doctor_id,
      patient_name,
      type,
      title,
      notes,
      form_data,
      uploaded_at,
      uploaded_by
    )
    values (
      v_appointment.patient_id,
      v_appointment.id,
      v_doctor_id,
      coalesce(nullif(btrim(v_appointment.patient_name), ''), 'Patient'),
      case when v_requested_type = 'initial' then 'Initial Visit' else 'Follow-Up Visit' end,
      case when v_requested_type = 'initial' then 'Initial Visit' else 'Follow-Up Visit' end,
      coalesce(
        nullif(btrim(p_form_data ->> 'chiefComplaint'), ''),
        nullif(btrim(p_form_data ->> 'diagnosis'), ''),
        'Maternal care visit completed.'
      ),
      v_server_form_data,
      now(),
      coalesce(nullif(btrim(v_appointment.doctor_name), ''), v_actor_name, 'Clinic user')
    )
    on conflict (schedule_id)
      where schedule_id is not null
    do nothing
    returning * into v_saved;
  exception
    when unique_violation then
      raise exception
        'This Patient already has a completed Initial Visit record. Open the Follow-Up Visit Form instead.'
        using errcode = '23505';
  end;

  if not found then
    select m.*
    into v_saved
    from public.medical_records m
    where m.schedule_id = v_appointment.id
    limit 1;

    if not found then
      raise exception 'The visit record could not be created.';
    end if;

    if v_saved.patient_id <> v_appointment.patient_id then
      raise exception 'The concurrent visit record belongs to a different Patient.';
    end if;
  end if;

  update public.schedule s
  set status = 'completed'
  where s.id = v_appointment.id;

  return v_saved;
end;
$function$;

revoke all on function public.get_appointment_visit_form_type(uuid)
  from public, anon;
grant execute on function public.get_appointment_visit_form_type(uuid)
  to authenticated;

revoke all on function public.save_appointment_visit_record(uuid, text, jsonb)
  from public, anon;
grant execute on function public.save_appointment_visit_record(uuid, text, jsonb)
  to authenticated;

notify pgrst, 'reload schema';

commit;
