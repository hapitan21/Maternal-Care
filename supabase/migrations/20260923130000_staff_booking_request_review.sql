-- Move Patient appointment-request review responsibility
-- from Doctor to Staff/Admin.
--
-- Patient booking remains unchanged:
-- Patient -> pending booking request
--
-- Clinic review becomes:
-- Staff/Admin -> approve or decline
-- Approved request -> confirmed public.schedule row assigned to a Doctor.

begin;


-- ============================================================
-- 1. RLS
-- ============================================================

-- Doctors should no longer receive Patient booking requests.
drop policy if exists
  "Doctors can read assigned appointment requests"
on public.create_patient_appointment_request;


-- Re-create Staff/Admin request visibility using the project's
-- canonical active account status.
drop policy if exists
  "Staff and admins can read appointment requests"
on public.create_patient_appointment_request;

create policy
  "Staff and admins can read appointment requests"
on public.create_patient_appointment_request
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(
        pg_catalog.btrim(coalesce(profile.role, ''))
      ) in ('staff', 'admin')
      and pg_catalog.lower(
        pg_catalog.btrim(coalesce(profile.account_status, ''))
      ) = 'active'
  )
);


-- ============================================================
-- 2. REMOVE THE OLD DOCTOR-ONLY ACCEPT FUNCTION
-- ============================================================
--
-- The previous signature:
--
-- accept_patient_appointment_request(bigint)
--
-- was Doctor-only and automatically assigned auth.uid()
-- as the appointment Doctor.
--
-- Drop it so it cannot remain available as an overload.

drop function if exists
  public.accept_patient_appointment_request(bigint);


-- ============================================================
-- 3. STAFF/ADMIN ACCEPT RPC
-- ============================================================
--
-- p_doctor_id is optional.
--
-- If Staff does not explicitly change the Doctor, the RPC uses
-- the Doctor originally selected by the Patient.
--
-- Staff may also provide another active Doctor when approving.

create function public.accept_patient_appointment_request(
  p_request_id bigint,
  p_doctor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_role text;

  v_request public.create_patient_appointment_request%rowtype;

  v_doctor_id uuid;
  v_doctor_name text;

  v_patient_name text;

  v_end_time timestamptz;
  v_schedule_id public.schedule.id%type;
begin

  ------------------------------------------------------------
  -- AUTHENTICATION
  ------------------------------------------------------------

  if auth.uid() is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;


  ------------------------------------------------------------
  -- STAFF / ADMIN AUTHORIZATION
  ------------------------------------------------------------

  select pg_catalog.lower(
           pg_catalog.btrim(coalesce(profile.role, ''))
         )
    into v_actor_role
  from public.profiles as profile
  where profile.id = auth.uid()
    and pg_catalog.lower(
          pg_catalog.btrim(coalesce(profile.role, ''))
        ) in ('staff', 'admin')
    and pg_catalog.lower(
          pg_catalog.btrim(coalesce(profile.account_status, ''))
        ) = 'active';

  if v_actor_role is null then
    raise exception
      'Only active Staff or Admin users can approve appointment requests.'
      using errcode = '42501';
  end if;


  ------------------------------------------------------------
  -- LOCK REQUEST
  ------------------------------------------------------------

  select request.*
    into v_request
  from public.create_patient_appointment_request as request
  where request.id = p_request_id
  for update;

  if v_request.id is null then
    raise exception 'Appointment request was not found.'
      using errcode = 'P0002';
  end if;


  ------------------------------------------------------------
  -- REQUEST MUST STILL BE PENDING
  ------------------------------------------------------------

  if pg_catalog.lower(
       pg_catalog.btrim(coalesce(v_request.status, ''))
     ) <> 'pending' then
    raise exception
      'Only pending appointment requests can be approved.'
      using errcode = '22023';
  end if;


  ------------------------------------------------------------
  -- PATIENT VALIDATION
  ------------------------------------------------------------

  if v_request.patient_id is null then
    raise exception
      'The request is not linked to a valid Patient record.'
      using errcode = '23503';
  end if;

  select nullif(
           pg_catalog.btrim(coalesce(patient.full_name, '')),
           ''
         )
    into v_patient_name
  from public.patients as patient
  where patient.id = v_request.patient_id;

  if v_patient_name is null then
    raise exception
      'The request is not linked to a valid Patient record.'
      using errcode = '23503';
  end if;


  ------------------------------------------------------------
  -- REQUESTED TIME VALIDATION
  ------------------------------------------------------------

  if v_request.start_time is null
     or v_request.start_time <= pg_catalog.now() then
    raise exception
      'The requested appointment time is no longer in the future.'
      using errcode = '22023';
  end if;

  v_end_time := case
    when v_request.end_time is not null
      and v_request.end_time > v_request.start_time
    then v_request.end_time
    else v_request.start_time + interval '30 minutes'
  end;


  ------------------------------------------------------------
  -- DOCTOR ASSIGNMENT
  --
  -- Staff may explicitly choose another Doctor.
  -- Otherwise preserve the Doctor selected by the Patient.
  ------------------------------------------------------------

  v_doctor_id := coalesce(
    p_doctor_id,
    v_request.doctor_id
  );

  if v_doctor_id is null then
    raise exception
      'Select an active Doctor before approving this appointment request.'
      using errcode = '22023';
  end if;


  ------------------------------------------------------------
  -- AUTHORITATIVE ACTIVE DOCTOR
  ------------------------------------------------------------

  select coalesce(
           nullif(
             pg_catalog.btrim(coalesce(personal.full_name, '')),
             ''
           ),
           nullif(
             pg_catalog.btrim(coalesce(profile.full_name, '')),
             ''
           )
         )
    into v_doctor_name
  from public.profiles as profile
  left join public.doctor_personal_information as personal
    on personal.auth_user_id = profile.id
  where profile.id = v_doctor_id
    and pg_catalog.lower(
          pg_catalog.btrim(coalesce(profile.role, ''))
        ) = 'doctor'
    and pg_catalog.lower(
          pg_catalog.btrim(coalesce(profile.account_status, ''))
        ) = 'active';

  if v_doctor_name is null then
    raise exception
      'The selected Doctor is not active or is unavailable.'
      using errcode = '22023';
  end if;


  ------------------------------------------------------------
  -- PATIENT APPOINTMENT CONFLICT
  ------------------------------------------------------------

  if exists (
    select 1
    from public.schedule as schedule
    where schedule.patient_id = v_request.patient_id
      and (
        v_request.schedule_id is null
        or schedule.id <> v_request.schedule_id
      )
      and pg_catalog.lower(
            pg_catalog.btrim(coalesce(schedule.status, 'scheduled'))
          ) not in (
            'cancel',
            'cancelled',
            'canceled',
            'no_show',
            'no show',
            'completed',
            'complete'
          )
      and schedule.start_time < v_end_time
      and schedule.end_time > v_request.start_time
  ) then
    raise exception
      'The Patient already has an appointment during this time.'
      using errcode = '23505';
  end if;


  ------------------------------------------------------------
  -- DOCTOR APPOINTMENT CONFLICT
  ------------------------------------------------------------

  if exists (
    select 1
    from public.schedule as schedule
    where schedule.doctor_id = v_doctor_id
      and (
        v_request.schedule_id is null
        or schedule.id <> v_request.schedule_id
      )
      and pg_catalog.lower(
            pg_catalog.btrim(coalesce(schedule.status, 'scheduled'))
          ) not in (
            'cancel',
            'cancelled',
            'canceled',
            'no_show',
            'no show',
            'completed',
            'complete'
          )
      and schedule.start_time < v_end_time
      and schedule.end_time > v_request.start_time
  ) then
    raise exception
      'The selected Doctor already has an appointment during this time.'
      using errcode = '23505';
  end if;


  ------------------------------------------------------------
  -- LEGACY REQUEST WITH EXISTING SCHEDULE
  ------------------------------------------------------------

  if v_request.schedule_id is not null then

    update public.schedule
    set
      patient_id = v_request.patient_id,
      patient_name = v_patient_name,

      doctor_id = v_doctor_id,
      doctor_name = v_doctor_name,

      title = pg_catalog.btrim(v_request.title),

      description =
        pg_catalog.jsonb_strip_nulls(
          pg_catalog.jsonb_build_object(
            'category',
              coalesce(
                nullif(
                  pg_catalog.btrim(v_request.category),
                  ''
                ),
                'appointment'
              ),

            'notes',
              nullif(
                pg_catalog.btrim(v_request.description),
                ''
              ),

            'source',
              'patient-booking-request',

            'requestStatus',
              'accepted',

            'bookingRequestId',
              v_request.id
          )
        )::text,

      start_time = v_request.start_time,
      end_time = v_end_time,

      status = 'scheduled',
      updated_at = pg_catalog.now()

    where id = v_request.schedule_id

    returning id into v_schedule_id;

  end if;


  ------------------------------------------------------------
  -- CREATE CONFIRMED SCHEDULE IF NEEDED
  ------------------------------------------------------------

  if v_schedule_id is null then

    insert into public.schedule (
      patient_id,
      patient_name,

      doctor_id,
      doctor_name,

      title,
      description,

      start_time,
      end_time,

      status
    )
    values (
      v_request.patient_id,
      v_patient_name,

      v_doctor_id,
      v_doctor_name,

      pg_catalog.btrim(v_request.title),

      pg_catalog.jsonb_strip_nulls(
        pg_catalog.jsonb_build_object(
          'category',
            coalesce(
              nullif(
                pg_catalog.btrim(v_request.category),
                ''
              ),
              'appointment'
            ),

          'notes',
            nullif(
              pg_catalog.btrim(v_request.description),
              ''
            ),

          'source',
            'patient-booking-request',

          'requestStatus',
            'accepted',

          'bookingRequestId',
            v_request.id
        )
      )::text,

      v_request.start_time,
      v_end_time,

      'scheduled'
    )

    returning id into v_schedule_id;

  end if;


  ------------------------------------------------------------
  -- MARK REQUEST ACCEPTED
  ------------------------------------------------------------

  update public.create_patient_appointment_request
  set
    status = 'accepted',

    doctor_id = v_doctor_id,
    doctor_name = v_doctor_name,

    schedule_id = v_schedule_id,

    reviewed_at = pg_catalog.now(),
    reviewed_by = auth.uid(),

    updated_at = pg_catalog.now()

  where id = v_request.id;


  ------------------------------------------------------------
  -- RESPONSE
  ------------------------------------------------------------

  return pg_catalog.jsonb_build_object(
    'request_id',
      v_request.id,

    'schedule_id',
      v_schedule_id,

    'patient_id',
      v_request.patient_id,

    'doctor_id',
      v_doctor_id,

    'status',
      'accepted'
  );

end;
$function$;


comment on function public.accept_patient_appointment_request(
  bigint,
  uuid
) is
  'Allows active Staff/Admin users to approve a pending Patient appointment request and atomically create or confirm its Doctor-assigned schedule.';


revoke all on function public.accept_patient_appointment_request(
  bigint,
  uuid
)
from public, anon;

grant execute on function public.accept_patient_appointment_request(
  bigint,
  uuid
)
to authenticated;


-- ============================================================
-- 4. STAFF/ADMIN DECLINE RPC
-- ============================================================

create or replace function public.decline_patient_appointment_request(
  p_request_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_role text;
  v_request public.create_patient_appointment_request%rowtype;
begin

  ------------------------------------------------------------
  -- AUTHENTICATION
  ------------------------------------------------------------

  if auth.uid() is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;


  ------------------------------------------------------------
  -- STAFF / ADMIN AUTHORIZATION
  ------------------------------------------------------------

  select pg_catalog.lower(
           pg_catalog.btrim(coalesce(profile.role, ''))
         )
    into v_actor_role
  from public.profiles as profile
  where profile.id = auth.uid()
    and pg_catalog.lower(
          pg_catalog.btrim(coalesce(profile.role, ''))
        ) in ('staff', 'admin')
    and pg_catalog.lower(
          pg_catalog.btrim(coalesce(profile.account_status, ''))
        ) = 'active';

  if v_actor_role is null then
    raise exception
      'Only active Staff or Admin users can decline appointment requests.'
      using errcode = '42501';
  end if;


  ------------------------------------------------------------
  -- LOCK REQUEST
  ------------------------------------------------------------

  select request.*
    into v_request
  from public.create_patient_appointment_request as request
  where request.id = p_request_id
  for update;

  if v_request.id is null then
    raise exception 'Appointment request was not found.'
      using errcode = 'P0002';
  end if;


  ------------------------------------------------------------
  -- REQUEST MUST STILL BE PENDING
  ------------------------------------------------------------

  if pg_catalog.lower(
       pg_catalog.btrim(coalesce(v_request.status, ''))
     ) <> 'pending' then
    raise exception
      'Only pending appointment requests can be declined.'
      using errcode = '22023';
  end if;


  ------------------------------------------------------------
  -- MARK DECLINED
  ------------------------------------------------------------

  update public.create_patient_appointment_request
  set
    status = 'declined',

    reviewed_at = pg_catalog.now(),
    reviewed_by = auth.uid(),

    updated_at = pg_catalog.now()

  where id = v_request.id;


  ------------------------------------------------------------
  -- LEGACY REQUESTS MAY HAVE AN OLD SCHEDULE ROW
  ------------------------------------------------------------

  if v_request.schedule_id is not null then

    update public.schedule
    set
      status = 'cancelled',

      description =
        pg_catalog.jsonb_strip_nulls(
          pg_catalog.jsonb_build_object(
            'category',
              coalesce(
                nullif(
                  pg_catalog.btrim(v_request.category),
                  ''
                ),
                'appointment'
              ),

            'notes',
              nullif(
                pg_catalog.btrim(v_request.description),
                ''
              ),

            'source',
              'patient-booking-request',

            'requestStatus',
              'declined',

            'bookingRequestId',
              v_request.id
          )
        )::text,

      updated_at = pg_catalog.now()

    where id = v_request.schedule_id;

  end if;


  ------------------------------------------------------------
  -- RESPONSE
  ------------------------------------------------------------

  return pg_catalog.jsonb_build_object(
    'request_id',
      v_request.id,

    'status',
      'declined'
  );

end;
$function$;


comment on function public.decline_patient_appointment_request(
  bigint
) is
  'Allows active Staff/Admin users to decline pending Patient appointment requests.';


revoke all on function public.decline_patient_appointment_request(
  bigint
)
from public, anon;

grant execute on function public.decline_patient_appointment_request(
  bigint
)
to authenticated;


notify pgrst, 'reload schema';

commit;