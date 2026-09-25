-- ============================================================
-- Same-day appointment check-in and Staff intake enforcement
--
-- Rules:
-- 1. An appointment may transition to checked_in only on its
--    scheduled calendar date in Asia/Manila.
-- 2. A checked-in appointment cannot be rescheduled.
-- 3. Staff intake may be saved through the approved RPC only
--    on the appointment date.
-- 4. Browser/authenticated users cannot bypass the Staff intake
--    RPC with direct INSERT/UPDATE/DELETE operations.
--
-- Existing historical rows are preserved.
-- ============================================================


-- ============================================================
-- 1. Protect schedule check-in transitions
-- ============================================================

create or replace function public.enforce_same_day_schedule_check_in()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_status_normalized text := '';
  new_status_normalized text;
  appointment_date_manila date;
  today_manila date;
begin
  new_status_normalized :=
    pg_catalog.lower(
      pg_catalog.btrim(
        coalesce(new.status, ''::text)
      )
    );

  if tg_op = 'UPDATE' then
    old_status_normalized :=
      pg_catalog.lower(
        pg_catalog.btrim(
          coalesce(old.status, ''::text)
        )
      );

    -- Once an appointment has been checked in, its scheduled
    -- date/time cannot be changed.
    --
    -- This check happens before evaluating the new status so a
    -- caller cannot bypass it by changing start_time and status
    -- in the same UPDATE statement.
    if old_status_normalized in (
      'checked_in',
      'checked-in',
      'checked in'
    )
    and new.start_time is distinct from old.start_time
    then
      raise exception using
        errcode = '23514',
        message =
          'Checked-in appointments cannot be rescheduled.';
    end if;
  end if;

  -- Ignore rows that are not becoming checked in.
  if new_status_normalized not in (
    'checked_in',
    'checked-in',
    'checked in'
  ) then
    return new;
  end if;

  -- New appointments may not be inserted already checked in.
  if tg_op = 'INSERT' then
    raise exception using
      errcode = '23514',
      message =
        'Appointments must be created before they can be checked in.';
  end if;

  -- Existing checked-in appointments may receive unrelated
  -- updates as long as start_time was not changed above.
  if old_status_normalized in (
    'checked_in',
    'checked-in',
    'checked in'
  ) then
    return new;
  end if;

  -- Check-in must originate from the pending/scheduled state.
  if old_status_normalized not in (
    'scheduled',
    'pending'
  ) then
    raise exception using
      errcode = '23514',
      message =
        'Appointment cannot transition to checked_in from its current status.';
  end if;

  appointment_date_manila :=
    (new.start_time at time zone 'Asia/Manila')::date;

  today_manila :=
    (current_timestamp at time zone 'Asia/Manila')::date;

  if appointment_date_manila is distinct from today_manila then
    raise exception using
      errcode = '23514',
      message =
        'Check-in is only allowed on the scheduled appointment date.';
  end if;

  return new;
end;
$$;


drop trigger if exists schedule_same_day_check_in_guard
on public.schedule;

create trigger schedule_same_day_check_in_guard
before insert or update
on public.schedule
for each row
execute function public.enforce_same_day_schedule_check_in();


comment on function public.enforce_same_day_schedule_check_in()
is
'Enforces same-day check-in in Asia/Manila, prevents appointments from being created already checked in, and prevents checked-in appointments from being rescheduled.';


-- ============================================================
-- 2. Protect the public Staff intake RPC
-- ============================================================

create or replace function public.save_staff_visit_intake(
  p_appointment_id uuid,
  p_visit_form_type text,
  p_intake_data jsonb
)
returns public.staff_visit_intake
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment_start_time timestamptz;
begin
  -- Only authenticated, active Staff accounts may use
  -- this public intake-writing RPC.
  if auth.uid() is null or not exists (
    select 1
    from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(
        pg_catalog.btrim(
          coalesce(profile.role, ''::text)
        )
      ) = 'staff'
      and pg_catalog.lower(
        pg_catalog.btrim(
          coalesce(profile.account_status, ''::text)
        )
      ) = 'active'
  ) then
    raise exception
      'Only active Staff can save Staff intake.'
      using errcode = '42501';
  end if;

  -- Get the appointment date from the server-side schedule row.
  select schedule.start_time
  into v_appointment_start_time
  from public.schedule as schedule
  where schedule.id = p_appointment_id;

  if not found then
    raise exception
      'The appointment was not found.'
      using errcode = 'P0002';
  end if;

  -- Staff intake may only be saved on the appointment's
  -- scheduled calendar date in Asia/Manila.
  if
    (v_appointment_start_time at time zone 'Asia/Manila')::date
    is distinct from
    (current_timestamp at time zone 'Asia/Manila')::date
  then
    raise exception
      'Staff intake is only available on the scheduled appointment date.'
      using errcode = '23514';
  end if;

  -- The private writer performs the remaining server checks,
  -- including:
  -- - appointment exists
  -- - patient relationship exists
  -- - appointment is checked in
  -- - appointment is not closed
  -- - visit type is valid
  -- - visit routing is correct
  return public.save_staff_visit_intake_unchecked_v1(
    p_appointment_id,
    p_visit_form_type,
    p_intake_data
  );
end;
$$;


comment on function public.save_staff_visit_intake(uuid, text, jsonb)
is
'Allows active Staff to save pre-consultation intake only on the scheduled appointment date in Asia/Manila.';


-- ============================================================
-- 3. Prevent direct browser writes to Staff intake
--
-- Application code uses public.save_staff_visit_intake().
--
-- The underlying unchecked writer is not executable by ordinary
-- authenticated users. Direct table writes are also removed so
-- application clients cannot bypass the approved RPC.
--
-- SELECT access remains controlled by the existing RLS policy.
-- ============================================================

revoke insert, update, delete, truncate, references, trigger
on table public.staff_visit_intake
from authenticated;


-- ============================================================
-- 4. Reload PostgREST schema
-- ============================================================

notify pgrst, 'reload schema';