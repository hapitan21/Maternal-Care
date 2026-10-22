-- REVIEW ONLY: this draft was not applied to Supabase.
-- Purpose: let active Staff/Admin users read only requested active Doctors'
-- weekly availability without widening user_availability table RLS.
-- Returned fields contain schedule availability only; no patient or profile
-- details are returned. Existing table policies and appointment records remain unchanged.

begin;

create or replace function public.get_staff_doctor_schedule_availability(
  p_doctor_ids uuid[]
)
returns table (
  profile_id uuid,
  day_of_week smallint,
  start_time time without time zone,
  end_time time without time zone,
  is_available boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null or not exists (
    select 1
    from public.profiles as actor
    where actor.id = auth.uid()
      and pg_catalog.lower(pg_catalog.btrim(coalesce(actor.account_status, ''))) = 'active'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(actor.role, ''))) in ('staff', 'admin')
  ) then
    raise exception 'Only active Staff or Admin users can read Doctor availability.'
      using errcode = '42501';
  end if;

  if p_doctor_ids is null
     or pg_catalog.cardinality(p_doctor_ids) = 0
     or exists (select 1 from pg_catalog.unnest(p_doctor_ids) as requested(id) where requested.id is null) then
    raise exception 'Provide one or more Doctor IDs.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from pg_catalog.unnest(p_doctor_ids) as requested(id)
    left join public.profiles as doctor on doctor.id = requested.id
    where doctor.id is null
       or pg_catalog.lower(pg_catalog.btrim(coalesce(doctor.role, ''))) <> 'doctor'
       or pg_catalog.lower(pg_catalog.btrim(coalesce(doctor.account_status, ''))) <> 'active'
  ) then
    raise exception 'One or more requested Doctors are not active.'
      using errcode = '42501';
  end if;

  return query
  select availability.profile_id,
         availability.day_of_week,
         availability.start_time,
         availability.end_time,
         availability.is_available
  from public.user_availability as availability
  where availability.profile_id = any (p_doctor_ids)
  order by availability.profile_id, availability.day_of_week;
end;
$function$;

alter function public.get_staff_doctor_schedule_availability(uuid[]) owner to postgres;
revoke all on function public.get_staff_doctor_schedule_availability(uuid[])
  from public, anon, authenticated;
grant execute on function public.get_staff_doctor_schedule_availability(uuid[])
  to authenticated;

comment on function public.get_staff_doctor_schedule_availability(uuid[]) is
  'Returns weekly availability fields for explicitly requested active Doctors to active Staff/Admin callers; does not widen user_availability table RLS.';

commit;

-- Approval/staging checks required before applying:
-- 1. Confirm authenticated Staff can call this function and cannot request inactive/non-Doctor profiles.
-- 2. Confirm Doctor and Patient callers are rejected, while Admin and Staff are allowed.
-- 3. Confirm only the requested Doctors' availability fields are returned.
-- 4. Confirm the Staff Add Appointment and clinic-wide calendar read from this RPC.
-- 5. Independently review appointment write enforcement: create_standard_appointment
--    currently validates clinic policy and conflicts but does not check user_availability.
-- 6. Confirm reschedule_appointment and other authorized writers enforce availability
--    before any change that claims availability is a server-side booking rule.
