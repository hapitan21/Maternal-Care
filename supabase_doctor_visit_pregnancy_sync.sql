-- Run this in the Supabase SQL Editor after the patient clinical RLS hardening.
-- It gives active Doctors one narrowly scoped, audited path for synchronizing
-- canonical pregnancy fields after a completed Initial or Follow-Up Visit.

begin;

drop function if exists public.sync_doctor_visit_pregnancy_state(uuid, text, date, boolean, uuid);

create or replace function public.sync_doctor_visit_pregnancy_state(
  p_appointment_id uuid,
  p_risk_level text default null,
  p_expected_delivery_date date default null,
  p_update_expected_delivery_date boolean default false,
  p_obstetric_history_id uuid default null,
  p_current_gestational_week integer default null
)
returns table (
  patient_id uuid,
  obstetric_history_id uuid,
  risk_level text,
  expected_delivery_date date
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_patient_id uuid;
  v_obstetric_history_id uuid;
  v_risk_level text;
  v_expected_delivery_date date;
begin
  if auth.uid() is null or not exists (
    select 1
    from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text))) = 'doctor'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.account_status, ''::text))) = 'active'
  ) then
    raise exception 'Only active Doctors can synchronize current pregnancy fields.'
      using errcode = '42501';
  end if;

  select appointment.patient_id
  into v_patient_id
  from public.schedule as appointment
  where appointment.id = p_appointment_id;

  if v_patient_id is null then
    raise exception 'The appointment is not linked to a Patient record.'
      using errcode = '23502';
  end if;

  if not exists (
    select 1
    from public.medical_records as record
    where record.schedule_id = p_appointment_id
      and record.patient_id = v_patient_id
      and pg_catalog.lower(
        pg_catalog.btrim(coalesce(record.form_data ->> 'recordStatus', 'completed'))
      ) = 'completed'
      and pg_catalog.lower(
        pg_catalog.btrim(coalesce(record.form_data ->> 'isDraft', 'false'))
      ) not in ('true', '1', 'yes')
      and pg_catalog.lower(
        pg_catalog.btrim(coalesce(record.form_data ->> 'deleted', 'false'))
      ) not in ('true', '1', 'yes')
  ) then
    raise exception 'Complete the Doctor clinical visit before synchronizing pregnancy fields.'
      using errcode = '22023';
  end if;

  v_risk_level := nullif(pg_catalog.btrim(coalesce(p_risk_level, ''::text)), '');
  if v_risk_level is not null and v_risk_level not in ('Low Risk', 'Moderate Risk', 'High Risk') then
    raise exception 'Risk Level must be Low Risk, Moderate Risk, or High Risk.'
      using errcode = '22023';
  end if;

  if v_risk_level is not null then
    update public.patients as patient
    set risk_level = v_risk_level,
        updated_at = pg_catalog.now()
    where patient.id = v_patient_id;
  end if;

  if coalesce(p_update_expected_delivery_date, false) then
    if p_expected_delivery_date is null then
      raise exception 'Expected Delivery Date is required when updating the current pregnancy.'
        using errcode = '23502';
    end if;

    if p_current_gestational_week is null or
       p_current_gestational_week < 0 or
       p_current_gestational_week > 40 then
      raise exception 'The selected Expected Delivery Date is inconsistent with the current pregnancy dating.'
        using errcode = '22023';
    end if;

    v_obstetric_history_id := p_obstetric_history_id;
    if v_obstetric_history_id is null then
      select history.id
      into v_obstetric_history_id
      from public.patient_obstetric_history as history
      where history.patient_id = v_patient_id
      limit 1;
    end if;

    if v_obstetric_history_id is not null then
      update public.patient_obstetric_history as history
      set expected_delivery_date = p_expected_delivery_date,
          updated_at = pg_catalog.now()
      where history.id = v_obstetric_history_id
        and history.patient_id = v_patient_id
      returning history.id into v_obstetric_history_id;

      if not found then
        raise exception 'The selected obstetric-history row does not belong to this Patient.'
          using errcode = '42501';
      end if;
    end if;

    -- Keep the established patients fallback aligned with the authoritative
    -- obstetric EDD. No duplicate obstetric row is inserted when one is absent.
    update public.patients as patient
    set expected_delivery_date = p_expected_delivery_date,
        gestational_age = pg_catalog.format('%s Weeks', p_current_gestational_week),
        updated_at = pg_catalog.now()
    where patient.id = v_patient_id;
  end if;

  select patient.risk_level, patient.expected_delivery_date
  into v_risk_level, v_expected_delivery_date
  from public.patients as patient
  where patient.id = v_patient_id;

  if v_obstetric_history_id is not null then
    select history.expected_delivery_date
    into v_expected_delivery_date
    from public.patient_obstetric_history as history
    where history.id = v_obstetric_history_id
      and history.patient_id = v_patient_id;
  end if;

  return query
  select
    v_patient_id,
    v_obstetric_history_id,
    v_risk_level,
    v_expected_delivery_date;
end;
$function$;

revoke all on function public.sync_doctor_visit_pregnancy_state(uuid, text, date, boolean, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.sync_doctor_visit_pregnancy_state(uuid, text, date, boolean, uuid, integer)
  to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
