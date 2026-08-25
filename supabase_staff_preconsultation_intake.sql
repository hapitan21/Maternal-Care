-- Manual-review migration. Do not execute automatically.
--
-- Staff pre-consultation intake is separate from Doctor medical_records.
-- Saving Staff intake must not complete an appointment or create a Doctor record.
-- Doctor visit-type routing remains owned by public.get_appointment_visit_form_type(uuid).
--
-- Read-only verification query before manual execution:
-- select table_name, column_name, data_type
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name in ('schedule', 'patients', 'profiles', 'medical_records', 'staff_visit_intake')
-- order by table_name, ordinal_position;

begin;

do $preflight$
declare
  v_mismatch text;
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
      ('patients', 'patient_id', 'text'),
      ('patients', 'full_name', 'text'),
      ('patients', 'age', 'integer'),
      ('patients', 'contact_number', 'text'),
      ('patients', 'address', 'text'),
      ('patients', 'gestational_age', 'text'),
      ('patients', 'expected_delivery_date', 'date'),
      ('patients', 'risk_level', 'text'),
      ('profiles', 'id', 'uuid'),
      ('profiles', 'role', 'text'),
      ('profiles', 'full_name', 'text'),
      ('medical_records', 'id', 'uuid'),
      ('medical_records', 'patient_id', 'uuid'),
      ('medical_records', 'schedule_id', 'uuid'),
      ('medical_records', 'type', 'text'),
      ('medical_records', 'title', 'text'),
      ('medical_records', 'form_data', 'jsonb')
  )
  select string_agg(
    format(
      '%I.%I expected %s found %s',
      e.table_name,
      e.column_name,
      e.sql_type,
      coalesce(c.data_type, 'missing')
    ),
    '; '
    order by e.table_name, e.column_name
  )
  into v_mismatch
  from expected e
  left join information_schema.columns c
    on c.table_schema = 'public'
   and c.table_name = e.table_name
   and c.column_name = e.column_name
  where c.column_name is null
     or c.data_type <> e.sql_type;

  if v_mismatch is not null then
    raise exception 'Staff pre-consultation preflight failed: %', v_mismatch;
  end if;

  if not exists (
    select 1
    from information_schema.routines r
    where r.routine_schema = 'public'
      and r.routine_name = 'get_appointment_visit_form_type'
  ) then
    raise exception
      'Staff pre-consultation preflight failed: public.get_appointment_visit_form_type(uuid) is required.';
  end if;

  if exists (
    select 1
    from public.medical_records m
    where m.schedule_id is not null
    group by m.schedule_id
    having count(*) > 1
  ) then
    raise exception
      'Staff pre-consultation preflight failed: duplicate Doctor medical records exist for one or more schedule IDs.';
  end if;
end;
$preflight$;

create table if not exists public.staff_visit_intake (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null,
  patient_id uuid not null,
  doctor_id uuid,
  staff_id uuid not null,
  visit_type text not null,
  intake_data jsonb not null default '{}'::jsonb,
  status text not null default 'staff_completed',
  staff_completed_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint staff_visit_intake_appointment_id_unique unique (appointment_id),
  constraint staff_visit_intake_appointment_id_fkey
    foreign key (appointment_id) references public.schedule(id) on delete cascade,
  constraint staff_visit_intake_patient_id_fkey
    foreign key (patient_id) references public.patients(id) on delete cascade,
  constraint staff_visit_intake_doctor_id_fkey
    foreign key (doctor_id) references public.profiles(id) on delete set null,
  constraint staff_visit_intake_staff_id_fkey
    foreign key (staff_id) references public.profiles(id) on delete restrict,
  constraint staff_visit_intake_visit_type_check
    check (visit_type in ('initial', 'follow_up')),
  constraint staff_visit_intake_status_check
    check (status in ('draft', 'staff_completed'))
);

do $postcreate_preflight$
declare
  v_mismatch text;
begin
  with expected(column_name, sql_type) as (
    values
      ('id', 'uuid'),
      ('appointment_id', 'uuid'),
      ('patient_id', 'uuid'),
      ('doctor_id', 'uuid'),
      ('staff_id', 'uuid'),
      ('visit_type', 'text'),
      ('intake_data', 'jsonb'),
      ('status', 'text'),
      ('staff_completed_at', 'timestamp with time zone'),
      ('created_at', 'timestamp with time zone'),
      ('updated_at', 'timestamp with time zone')
  )
  select string_agg(
    format(
      'staff_visit_intake.%I expected %s found %s',
      e.column_name,
      e.sql_type,
      coalesce(c.data_type, 'missing')
    ),
    '; '
    order by e.column_name
  )
  into v_mismatch
  from expected e
  left join information_schema.columns c
    on c.table_schema = 'public'
   and c.table_name = 'staff_visit_intake'
   and c.column_name = e.column_name
  where c.column_name is null
     or c.data_type <> e.sql_type;

  if v_mismatch is not null then
    raise exception 'Staff intake table preflight failed: %', v_mismatch;
  end if;
end;
$postcreate_preflight$;

create index if not exists staff_visit_intake_patient_id_idx
  on public.staff_visit_intake (patient_id);

create index if not exists staff_visit_intake_doctor_id_idx
  on public.staff_visit_intake (doctor_id);

create index if not exists staff_visit_intake_staff_id_idx
  on public.staff_visit_intake (staff_id);

create or replace function public.set_staff_visit_intake_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

drop trigger if exists staff_visit_intake_set_updated_at on public.staff_visit_intake;
create trigger staff_visit_intake_set_updated_at
before update on public.staff_visit_intake
for each row
execute function public.set_staff_visit_intake_updated_at();

alter table public.staff_visit_intake enable row level security;

drop policy if exists staff_visit_intake_clinic_read on public.staff_visit_intake;
create policy staff_visit_intake_clinic_read
on public.staff_visit_intake
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(btrim(coalesce(p.role, ''))) in ('doctor', 'staff', 'admin')
  )
);

drop policy if exists staff_visit_intake_staff_insert on public.staff_visit_intake;
create policy staff_visit_intake_staff_insert
on public.staff_visit_intake
for insert
to authenticated
with check (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(btrim(coalesce(p.role, ''))) in ('staff', 'admin')
  )
);

drop policy if exists staff_visit_intake_staff_update on public.staff_visit_intake;
create policy staff_visit_intake_staff_update
on public.staff_visit_intake
for update
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(btrim(coalesce(p.role, ''))) in ('staff', 'admin')
  )
)
with check (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(btrim(coalesce(p.role, ''))) in ('staff', 'admin')
  )
);

drop function if exists public.get_staff_visit_intake(uuid);

create function public.get_staff_visit_intake(
  p_appointment_id uuid
)
returns public.staff_visit_intake
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_role text;
  v_intake public.staff_visit_intake%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select lower(btrim(coalesce(p.role, '')))
  into v_actor_role
  from public.profiles p
  where p.id = auth.uid();

  if v_actor_role is null or v_actor_role not in ('doctor', 'staff', 'admin') then
    raise exception 'Only Doctors, Staff, and Admins can read Staff intake.'
      using errcode = '42501';
  end if;

  select i.*
  into v_intake
  from public.staff_visit_intake i
  where i.appointment_id = p_appointment_id;

  return v_intake;
end;
$function$;

drop function if exists public.save_staff_visit_intake(uuid, text, json);
drop function if exists public.save_staff_visit_intake(uuid, text, jsonb);

create function public.save_staff_visit_intake(
  p_appointment_id uuid,
  p_visit_form_type text,
  p_intake_data jsonb
)
returns public.staff_visit_intake
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_role text;
  v_appointment public.schedule%rowtype;
  v_requested_type text;
  v_expected_type text;
  v_saved public.staff_visit_intake%rowtype;
  v_server_intake_data jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select lower(btrim(coalesce(p.role, '')))
  into v_actor_role
  from public.profiles p
  where p.id = auth.uid();

  if v_actor_role is null or v_actor_role not in ('staff', 'admin') then
    raise exception 'Only Staff and Admins can save Staff pre-consultation intake.'
      using errcode = '42501';
  end if;

  v_requested_type := lower(btrim(coalesce(p_visit_form_type, '')));
  if v_requested_type not in ('initial', 'follow_up') then
    raise exception 'Visit form type must be initial or follow_up.'
      using errcode = '22023';
  end if;

  if p_intake_data is null or jsonb_typeof(p_intake_data) <> 'object' then
    raise exception 'Staff intake data must be a JSON object.' using errcode = '22023';
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
    'no show',
    'completed'
  ) then
    raise exception 'Closed appointments cannot save Staff intake.'
      using errcode = '22023';
  end if;

  if lower(btrim(coalesce(v_appointment.status, ''))) not in
     ('checked_in', 'checked-in', 'checked in', 'ready_for_doctor') then
    raise exception 'Check in the appointment before saving Staff intake.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.medical_records m
    where m.schedule_id = v_appointment.id
  ) then
    select i.*
    into v_saved
    from public.staff_visit_intake i
    where i.appointment_id = v_appointment.id;

    if found then
      return v_saved;
    end if;

    raise exception 'The Doctor visit record has already been saved for this appointment.'
      using errcode = '22023';
  end if;

  select r.visit_form_type
  into v_expected_type
  from public.get_appointment_visit_form_type(v_appointment.id) r
  limit 1;

  if v_expected_type is null then
    raise exception 'The visit-routing RPC did not return a form type.';
  end if;

  if v_requested_type <> v_expected_type then
    if v_expected_type = 'initial' then
      raise exception 'Complete the Initial Visit intake before recording Follow-Up intake.';
    end if;
    raise exception
      'This Patient already has a completed Initial Visit record. Open Follow-Up intake instead.';
  end if;

  v_server_intake_data :=
    p_intake_data ||
    jsonb_build_object(
      'appointmentId', v_appointment.id,
      'patientId', v_appointment.patient_id,
      'doctorId', v_appointment.doctor_id,
      'staffId', auth.uid(),
      'visitFormType', v_requested_type,
      'staffRecordStatus', 'staff_completed',
      'staffSavedAt', now()
    );

  insert into public.staff_visit_intake (
    appointment_id,
    patient_id,
    doctor_id,
    staff_id,
    visit_type,
    intake_data,
    status,
    staff_completed_at
  )
  values (
    v_appointment.id,
    v_appointment.patient_id,
    v_appointment.doctor_id,
    auth.uid(),
    v_requested_type,
    v_server_intake_data,
    'staff_completed',
    now()
  )
  on conflict on constraint staff_visit_intake_appointment_id_unique
  do update set
    patient_id = excluded.patient_id,
    doctor_id = excluded.doctor_id,
    visit_type = excluded.visit_type,
    intake_data = excluded.intake_data,
    status = 'staff_completed',
    staff_completed_at = coalesce(public.staff_visit_intake.staff_completed_at, excluded.staff_completed_at)
  returning * into v_saved;

  return v_saved;
end;
$function$;

revoke all on public.staff_visit_intake from public, anon;
grant select, insert, update on public.staff_visit_intake to authenticated;

revoke all on function public.set_staff_visit_intake_updated_at()
  from public, anon;

revoke all on function public.get_staff_visit_intake(uuid)
  from public, anon;
grant execute on function public.get_staff_visit_intake(uuid)
  to authenticated;

revoke all on function public.save_staff_visit_intake(uuid, text, jsonb)
  from public, anon;
grant execute on function public.save_staff_visit_intake(uuid, text, jsonb)
  to authenticated;

notify pgrst, 'reload schema';

commit;
