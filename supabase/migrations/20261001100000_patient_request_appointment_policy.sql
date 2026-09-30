begin;

create or replace function public.create_patient_appointment_request(
  p_doctor_id uuid,
  p_doctor_name text,
  p_title text,
  p_category text,
  p_start_time timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_patient public.patients%rowtype;
  v_doctor_name text;
  v_duration_minutes integer;
  v_end_time timestamptz;
  v_request_id public.create_patient_appointment_request.id%type;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;

  select patient.*
    into v_patient
  from public.patients as patient
  where patient.user_id = auth.uid()
  limit 1;

  if v_patient.id is null then
    raise exception 'No Patient record is linked to this account.'
      using errcode = '42501';
  end if;

  if p_start_time is null
     or p_start_time <= pg_catalog.now() then
    raise exception 'Choose an appointment time in the future.'
      using errcode = '22023';
  end if;

  if nullif(
       pg_catalog.btrim(coalesce(p_title, '')),
       ''
     ) is null then
    raise exception 'Appointment type is required.'
      using errcode = '22023';
  end if;

  if p_doctor_id is not null then
    select coalesce(
             nullif(
               pg_catalog.btrim(coalesce(personal.full_name, '')),
               ''
             ),
             nullif(
               pg_catalog.btrim(coalesce(doctor_profile.full_name, '')),
               ''
             ),
             nullif(
               pg_catalog.btrim(coalesce(p_doctor_name, '')),
               ''
             ),
             'Clinic doctor'
           )
      into v_doctor_name
    from public.profiles as doctor_profile
    left join public.doctor_personal_information as personal
      on personal.auth_user_id = doctor_profile.id
    where doctor_profile.id = p_doctor_id
      and pg_catalog.lower(
            pg_catalog.btrim(coalesce(doctor_profile.role, ''))
          ) = 'doctor'
      and pg_catalog.lower(
            pg_catalog.btrim(
              coalesce(doctor_profile.account_status, 'active')
            )
          ) not in (
            'inactive',
            'deactivated',
            'disabled',
            'suspended',
            'archived',
            'deleted'
          );

    if v_doctor_name is null then
      raise exception 'The selected Doctor is not available.'
        using errcode = '22023';
    end if;
  else
    v_doctor_name := coalesce(
      nullif(
        pg_catalog.btrim(coalesce(p_doctor_name, '')),
        ''
      ),
      'Available clinic doctor'
    );
  end if;

  ------------------------------------------------------------
  -- OPERATIONAL APPOINTMENT POLICY
  --
  -- Derive the requested slot duration from the current
  -- Admin-configured appointment policy.
  ------------------------------------------------------------

  select settings.default_appointment_duration_minutes
    into v_duration_minutes
  from public.system_settings as settings
  where settings.singleton_guard = true
  for share;

  if not found then
    raise exception 'Operational appointment policy is not configured.'
      using errcode = '55000';
  end if;

  if v_duration_minutes is null
     or v_duration_minutes <= 0 then
    raise exception
      'Operational appointment policy has an invalid default appointment duration.'
      using errcode = '55000';
  end if;

  v_end_time :=
    p_start_time
    + pg_catalog.make_interval(mins => v_duration_minutes);

  perform public.validate_appointment_policy_range(
    p_start_time,
    v_end_time
  );

  ------------------------------------------------------------
  -- PATIENT REQUEST CONFLICT
  ------------------------------------------------------------

  if exists (
    select 1
    from public.create_patient_appointment_request as request
    where request.patient_id::text = v_patient.id::text
      and pg_catalog.lower(
            pg_catalog.btrim(coalesce(request.status, ''))
          ) = 'pending'
      and request.start_time < v_end_time
      and request.end_time > p_start_time
  ) then
    raise exception
      'You already have a pending appointment request during this time.'
      using errcode = '23505';
  end if;

  ------------------------------------------------------------
  -- EXISTING PATIENT APPOINTMENT CONFLICT
  ------------------------------------------------------------

  if exists (
    select 1
    from public.schedule as schedule
    where schedule.patient_id::text = v_patient.id::text
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
      and schedule.end_time > p_start_time
  ) then
    raise exception
      'You already have an appointment during this time.'
      using errcode = '23505';
  end if;

  insert into public.create_patient_appointment_request (
    patient_id,
    patient_name,
    doctor_id,
    doctor_name,
    title,
    category,
    start_time,
    end_time,
    status
  )
  values (
    v_patient.id,
    coalesce(
      nullif(
        pg_catalog.btrim(coalesce(v_patient.full_name, '')),
        ''
      ),
      'Patient'
    ),
    p_doctor_id,
    v_doctor_name,
    pg_catalog.btrim(p_title),
    coalesce(
      nullif(
        pg_catalog.btrim(coalesce(p_category, '')),
        ''
      ),
      'appointment'
    ),
    p_start_time,
    v_end_time,
    'pending'
  )
  returning id into v_request_id;

  return pg_catalog.jsonb_build_object(
    'id',
      v_request_id,
    'request_id',
      v_request_id,
    'status',
      'pending'
  );
end;
$function$;


create or replace function public.accept_patient_appointment_request(
  p_request_id bigint,
  p_doctor_id uuid default null::uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
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
  -- STAFF AUTHORIZATION
  ------------------------------------------------------------

  select pg_catalog.lower(
           pg_catalog.btrim(coalesce(profile.role, ''))
         )
    into v_actor_role
  from public.profiles as profile
  where profile.id = auth.uid()
    and pg_catalog.lower(
          pg_catalog.btrim(coalesce(profile.role, ''))
        ) = 'staff'
    and pg_catalog.lower(
          pg_catalog.btrim(coalesce(profile.account_status, ''))
        ) = 'active';

  if v_actor_role is null then
    raise exception
      'Only active Staff users can approve appointment requests.'
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

  if v_request.end_time is null
     or v_request.end_time <= v_request.start_time then
    raise exception
      'The appointment request has an invalid time range.'
      using errcode = '22023';
  end if;

  /*
   * Preserve the exact slot originally stored on the Patient
   * request. Do not recalculate it using today's default duration.
   */
  v_end_time := v_request.end_time;

  /*
   * Keep operational settings stable while the request becomes
   * a confirmed schedule row.
   */
  perform 1
  from public.system_settings as settings
  where settings.singleton_guard = true
  for share;

  if not found then
    raise exception 'Operational appointment policy is not configured.'
      using errcode = '55000';
  end if;

  perform public.validate_appointment_policy_range(
    v_request.start_time,
    v_end_time
  );


  ------------------------------------------------------------
  -- DOCTOR ASSIGNMENT
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

commit;