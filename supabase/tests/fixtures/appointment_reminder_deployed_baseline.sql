-- Exact definitions supplied from production pg_get_functiondef, 2026-10-03.
-- Test baseline only: never apply this fixture to a live database.
CREATE OR REPLACE FUNCTION public.process_due_appointment_reminders()
 RETURNS TABLE(examined integer, claimed integer, notifications_created integer, skipped integer, failed integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_now timestamptz := pg_catalog.now();
  v_candidate record;
  v_dispatch_id uuid;
  v_notification_id uuid;
  v_next_trigger timestamptz;
  v_step interval;
begin
  examined := 0;
  claimed := 0;
  notifications_created := 0;
  skipped := 0;
  failed := 0;

  -- ----------------------------------------------------------
  -- A. CONFIGURED APPOINTMENT REMINDERS
  -- ----------------------------------------------------------
  for v_candidate in
    select
      reminder.id as reminder_id,
      reminder.schedule_id,
      reminder.patient_id,
      patient.user_id,
      appointment.start_time as appointment_start_time,
      coalesce(reminder.next_trigger_at, reminder.remind_at) as scheduled_for,
      reminder.repeat_mode,
      reminder.repeat_until,
      reminder.title,
      reminder.message
    from public.reminders as reminder
    join public.schedule as appointment
      on appointment.id = reminder.schedule_id
    join public.patients as patient
      on patient.id = reminder.patient_id
    where pg_catalog.lower(
            pg_catalog.btrim(coalesce(reminder.reminder_type, ''))
          ) = 'appointment'
      and pg_catalog.lower(
            pg_catalog.btrim(coalesce(reminder.status, ''))
          ) = 'pending'
      and coalesce(reminder.next_trigger_at, reminder.remind_at) is not null
      and coalesce(reminder.next_trigger_at, reminder.remind_at) <= v_now
      and appointment.start_time > v_now
      and pg_catalog.lower(
            pg_catalog.btrim(coalesce(appointment.status, ''))
          ) in ('scheduled', 'pending', 'accepted', 'rescheduled')
      and patient.user_id is not null
      and pg_catalog.lower(
            pg_catalog.btrim(coalesce(patient.account_status, ''))
          ) = 'active'
      and patient.archived_at is null
      and pg_catalog.lower(
            pg_catalog.btrim(coalesce(patient.status, ''))
          ) not in ('inactive', 'archived', 'deleted')
    order by coalesce(reminder.next_trigger_at, reminder.remind_at)
    limit 200
    for update of reminder skip locked
  loop
    examined := examined + 1;
    v_dispatch_id := null;
    v_notification_id := null;

    begin
      insert into public.appointment_reminder_dispatches (
        reminder_id,
        schedule_id,
        patient_id,
        notification_id,
        reminder_offset_minutes,
        appointment_start_time,
        scheduled_for,
        status,
        claimed_at,
        notification_created_at,
        error_code
      )
      values (
        v_candidate.reminder_id,
        v_candidate.schedule_id,
        v_candidate.patient_id,
        null,
        null,
        v_candidate.appointment_start_time,
        v_candidate.scheduled_for,
        'processing',
        v_now,
        null,
        null
      )
      on conflict (reminder_id, scheduled_for)
        where reminder_id is not null
          and scheduled_for is not null
      do update
        set
          status = 'processing',
          claimed_at = excluded.claimed_at,
          notification_id = null,
          notification_created_at = null,
          error_code = null
      where public.appointment_reminder_dispatches.status = 'failed'
      returning id into v_dispatch_id;
    exception
      when others then
        failed := failed + 1;
        continue;
    end;

    if v_dispatch_id is null then
      skipped := skipped + 1;
      continue;
    end if;

    claimed := claimed + 1;

    begin
      insert into public.patient_notifications (
        patient_id,
        user_id,
        created_by,
        created_by_role,
        type,
        title,
        message,
        target_path,
        related_appointment_id,
        related_medical_record_id,
        related_reminder_id,
        priority
      )
      values (
        v_candidate.patient_id,
        v_candidate.user_id,
        null,
        null,
        'appointment_reminder',
        coalesce(
          nullif(pg_catalog.btrim(v_candidate.title), ''),
          'Appointment Reminder'
        ),
        coalesce(
          nullif(pg_catalog.btrim(v_candidate.message), ''),
          'You have an upcoming maternal care appointment.'
        ),
        '/patient/appointments',
        v_candidate.schedule_id,
        null,
        v_candidate.reminder_id,
        'important'
      )
      returning id into v_notification_id;

      update public.appointment_reminder_dispatches as dispatch
      set
        status = 'created',
        notification_id = v_notification_id,
        notification_created_at = v_now,
        error_code = null
      where dispatch.id = v_dispatch_id;

      notifications_created := notifications_created + 1;

      v_step := case v_candidate.repeat_mode
        when 'hourly' then interval '1 hour'
        when 'daily' then interval '1 day'
        else null
      end;

      if v_step is null then
        update public.reminders as reminder
        set
          status = 'sent',
          sent_at = v_now,
          next_trigger_at = null
        where reminder.id = v_candidate.reminder_id;
      else
        v_next_trigger := v_candidate.scheduled_for + v_step;

        -- If Cron was paused/offline, do not flood the Patient with every
        -- missed hourly/daily occurrence. Resume at the next future slot.
        while v_next_trigger <= v_now loop
          v_next_trigger := v_next_trigger + v_step;
        end loop;

        if v_next_trigger >= v_candidate.appointment_start_time
           or (
             v_candidate.repeat_until is not null
             and v_next_trigger >= v_candidate.repeat_until
           )
        then
          update public.reminders as reminder
          set
            status = 'sent',
            sent_at = v_now,
            next_trigger_at = null
          where reminder.id = v_candidate.reminder_id;
        else
          update public.reminders as reminder
          set
            status = 'pending',
            sent_at = v_now,
            next_trigger_at = v_next_trigger
          where reminder.id = v_candidate.reminder_id;
        end if;
      end if;

    exception
      when others then
        update public.appointment_reminder_dispatches as dispatch
        set
          status = 'failed',
          notification_id = null,
          notification_created_at = null,
          error_code = 'notification_insert_failed'
        where dispatch.id = v_dispatch_id;

        failed := failed + 1;
    end;
  end loop;


  -- ----------------------------------------------------------
  -- B. EXISTING AUTOMATIC FALLBACK
  --
  -- Only appointments with NO appointment reminder row are eligible.
  -- This prevents duplicate configured + automatic notifications.
  -- ----------------------------------------------------------
  for v_candidate in
    with eligible_appointments as materialized (
      select
        appointment.id as schedule_id,
        appointment.patient_id,
        patient.user_id,
        appointment.start_time
      from public.schedule as appointment
      join public.patients as patient
        on patient.id = appointment.patient_id
      where appointment.id is not null
        and appointment.patient_id is not null
        and appointment.start_time is not null
        and appointment.start_time > v_now
        and (
          (
            appointment.start_time > v_now + interval '23 hours 55 minutes'
            and appointment.start_time <= v_now + interval '24 hours'
          )
          or
          (
            appointment.start_time > v_now + interval '1 hour 55 minutes'
            and appointment.start_time <= v_now + interval '2 hours'
          )
        )
        and pg_catalog.lower(
              pg_catalog.btrim(coalesce(appointment.status, ''))
            ) in ('scheduled', 'pending', 'accepted', 'rescheduled')
        and patient.user_id is not null
        and pg_catalog.lower(
              pg_catalog.btrim(coalesce(patient.account_status, ''))
            ) = 'active'
        and patient.archived_at is null
        and pg_catalog.lower(
              pg_catalog.btrim(coalesce(patient.status, ''))
            ) not in ('inactive', 'archived', 'deleted')
        and not exists (
          select 1
          from public.reminders as configured
          where configured.schedule_id = appointment.id
            and pg_catalog.lower(
                  pg_catalog.btrim(coalesce(configured.reminder_type, ''))
                ) = 'appointment'
        )
      for update of appointment, patient skip locked
    ),
    due_reminders as (
      select
        eligible.schedule_id,
        eligible.patient_id,
        eligible.user_id,
        eligible.start_time,
        1440::integer as reminder_offset_minutes
      from eligible_appointments as eligible
      where eligible.start_time > v_now + interval '23 hours 55 minutes'
        and eligible.start_time <= v_now + interval '24 hours'

      union all

      select
        eligible.schedule_id,
        eligible.patient_id,
        eligible.user_id,
        eligible.start_time,
        120::integer as reminder_offset_minutes
      from eligible_appointments as eligible
      where eligible.start_time > v_now + interval '1 hour 55 minutes'
        and eligible.start_time <= v_now + interval '2 hours'
    )
    select
      due.schedule_id,
      due.patient_id,
      due.user_id,
      due.start_time,
      due.reminder_offset_minutes
    from due_reminders as due
    order by
      due.start_time,
      due.reminder_offset_minutes desc,
      due.schedule_id
  loop
    examined := examined + 1;
    v_dispatch_id := null;
    v_notification_id := null;

    begin
      insert into public.appointment_reminder_dispatches (
        reminder_id,
        schedule_id,
        patient_id,
        notification_id,
        reminder_offset_minutes,
        appointment_start_time,
        scheduled_for,
        status,
        claimed_at,
        notification_created_at,
        error_code
      )
      values (
        null,
        v_candidate.schedule_id,
        v_candidate.patient_id,
        null,
        v_candidate.reminder_offset_minutes,
        v_candidate.start_time,
        v_candidate.start_time
          - pg_catalog.make_interval(mins => v_candidate.reminder_offset_minutes),
        'processing',
        v_now,
        null,
        null
      )
      on conflict on constraint
        appointment_reminder_dispatches_schedule_offset_key
      do nothing
      returning id into v_dispatch_id;
    exception
      when others then
        failed := failed + 1;
        continue;
    end;

    if v_dispatch_id is null then
      skipped := skipped + 1;
      continue;
    end if;

    claimed := claimed + 1;

    begin
      insert into public.patient_notifications (
        patient_id,
        user_id,
        created_by,
        created_by_role,
        type,
        title,
        message,
        target_path,
        related_appointment_id,
        related_medical_record_id,
        related_reminder_id,
        priority
      )
      values (
        v_candidate.patient_id,
        v_candidate.user_id,
        null,
        null,
        'appointment_reminder',
        case v_candidate.reminder_offset_minutes
          when 1440 then 'Appointment Tomorrow'
          else 'Appointment Soon'
        end,
        case v_candidate.reminder_offset_minutes
          when 1440 then
            'You have a clinic appointment scheduled within the next 24 hours.'
          else
            'You have a clinic appointment scheduled within the next 2 hours.'
        end,
        '/patient/appointments',
        v_candidate.schedule_id,
        null,
        null,
        'important'
      )
      returning id into v_notification_id;

      update public.appointment_reminder_dispatches as dispatch
      set
        status = 'created',
        notification_id = v_notification_id,
        notification_created_at = v_now,
        error_code = null
      where dispatch.id = v_dispatch_id;

      notifications_created := notifications_created + 1;

    exception
      when others then
        update public.appointment_reminder_dispatches as dispatch
        set
          status = 'failed',
          notification_id = null,
          notification_created_at = null,
          error_code = 'notification_insert_failed'
        where dispatch.id = v_dispatch_id;

        failed := failed + 1;
    end;
  end loop;

  return next;
  return;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_appointment_patient_reminder(p_appointment_id uuid)
 RETURNS reminders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_appointment public.schedule%rowtype;
  v_existing public.reminders%rowtype;
  v_created public.reminders%rowtype;
  v_remind_at timestamp with time zone;
  v_appointment_title text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(coalesce(p.role, '')) in ('staff', 'doctor', 'admin')
  ) then
    raise exception 'Only Staff, Doctors, and Admins can create appointment reminders.'
      using errcode = '42501';
  end if;

  select s.*
  into v_appointment
  from public.schedule s
  where s.id = p_appointment_id
  for share;

  if not found then
    raise exception 'The appointment was not found.' using errcode = 'P0002';
  end if;

  if lower(coalesce(v_appointment.status, '')) in (
    'cancelled',
    'canceled',
    'cancel',
    'no_show',
    'no show'
  ) then
    raise exception 'A reminder cannot be created for a cancelled appointment.'
      using errcode = '22023';
  end if;

  if v_appointment.patient_id is null then
    raise exception 'The appointment is not linked to a Patient record.'
      using errcode = '23502';
  end if;

  select r.*
  into v_existing
  from public.reminders r
  where r.schedule_id = p_appointment_id
    and lower(coalesce(r.reminder_type, '')) = 'appointment'
  limit 1;

  if found then
    return v_existing;
  end if;

  v_appointment_title := coalesce(
    nullif(btrim(v_appointment.title), ''),
    'maternal care appointment'
  );

  v_remind_at := case
    when v_appointment.start_time - interval '24 hours' > now()
      then v_appointment.start_time - interval '24 hours'
    when v_appointment.start_time - interval '1 hour' > now()
      then v_appointment.start_time - interval '1 hour'
    else now()
  end;

  insert into public.reminders (
    patient_id,
    schedule_id,
    created_by,
    reminder_type,
    title,
    message,
    remind_at,
    status,
    sent_at
  )
  values (
    v_appointment.patient_id,
    v_appointment.id,
    auth.uid(),
    'appointment',
    'Upcoming Maternal Care Appointment',
    format(
      'You have a scheduled %s on %s.',
      v_appointment_title,
      to_char(
        v_appointment.start_time at time zone 'Asia/Manila',
        'FMMonth DD, YYYY at FMHH12:MI AM'
      )
    ),
    v_remind_at,
    'pending',
    null
  )
  on conflict (schedule_id)
    where schedule_id is not null
      and lower(coalesce(reminder_type, '')) = 'appointment'
  do nothing
  returning * into v_created;

  if found then
    return v_created;
  end if;

  select r.*
  into v_existing
  from public.reminders r
  where r.schedule_id = p_appointment_id
    and lower(coalesce(r.reminder_type, '')) = 'appointment'
  limit 1;

  if not found then
    raise exception 'The appointment reminder could not be created.';
  end if;

  return v_existing;
end;
$function$;
