-- Enforce appointment-level Doctor authorization for maternal visit forms.
--
-- Staff:
--   - may determine Initial vs Follow-up routing
--
-- Doctor:
--   - must be active
--   - must be the Doctor assigned to the appointment
--   - only the assigned Doctor may save/complete the medical visit
--
-- This intentionally leaves the existing unchecked_v1 functions unchanged.
-- They remain callable only by postgres/service_role.

create or replace function public.get_appointment_visit_form_type(
  p_appointment_id uuid
)
returns table(
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
  v_actor_role text;
  v_assigned_doctor_id uuid;
begin
  select pg_catalog.lower(
           pg_catalog.btrim(
             pg_catalog.coalesce(profile.role, '')
           )
         )
  into v_actor_role
  from public.profiles as profile
  where profile.id = auth.uid()
    and pg_catalog.lower(
          pg_catalog.btrim(
            pg_catalog.coalesce(profile.account_status, '')
          )
        ) = 'active';

  if auth.uid() is null
     or v_actor_role is null
     or v_actor_role not in ('doctor', 'staff') then
    raise exception
      'Only active Doctors and Staff can route appointment visit forms.'
      using errcode = '42501';
  end if;

  select schedule.doctor_id
  into v_assigned_doctor_id
  from public.schedule as schedule
  where schedule.id = p_appointment_id;

  if not found then
    raise exception 'The appointment was not found.'
      using errcode = 'P0002';
  end if;

  if v_actor_role = 'doctor'
     and v_assigned_doctor_id is distinct from auth.uid() then
    raise exception
      'Only the Doctor assigned to this appointment can open its visit form.'
      using errcode = '42501';
  end if;

  return query
  select *
  from public.get_appointment_visit_form_type_unchecked_v1(
    p_appointment_id
  );
end;
$function$;


create or replace function public.save_appointment_visit_record(
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
  v_assigned_doctor_id uuid;
begin
  if auth.uid() is null
     or not exists (
       select 1
       from public.profiles as profile
       where profile.id = auth.uid()
         and pg_catalog.lower(
               pg_catalog.btrim(
                 pg_catalog.coalesce(profile.role, '')
               )
             ) = 'doctor'
         and pg_catalog.lower(
               pg_catalog.btrim(
                 pg_catalog.coalesce(profile.account_status, '')
               )
             ) = 'active'
     ) then
    raise exception
      'Only active Doctors can save completed medical records.'
      using errcode = '42501';
  end if;

  select schedule.doctor_id
  into v_assigned_doctor_id
  from public.schedule as schedule
  where schedule.id = p_appointment_id;

  if not found then
    raise exception 'The appointment was not found.'
      using errcode = 'P0002';
  end if;

  if v_assigned_doctor_id is distinct from auth.uid() then
    raise exception
      'Only the Doctor assigned to this appointment can save its completed medical record.'
      using errcode = '42501';
  end if;

  return public.save_appointment_visit_record_unchecked_v1(
    p_appointment_id,
    p_visit_form_type,
    p_form_data
  );
end;
$function$;


notify pgrst, 'reload schema';