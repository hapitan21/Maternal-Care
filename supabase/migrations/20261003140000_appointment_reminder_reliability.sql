-- Appointment reminder reliability; reconstructed from the supplied DEPLOYED
-- configured/repeating processor, not the older automatic-only HEAD script.
-- No medication/native-push changes. Apply only after review and approval.
begin;

do $preflight$
declare
  v_contract record;
  v_expression text;
  v_shape text;
  v_states text[];
begin
  if pg_catalog.to_regclass('public.reminders') is null
     or pg_catalog.to_regclass('public.appointment_reminder_dispatches') is null
     or pg_catalog.to_regclass('cron.job') is null then
    raise exception 'Appointment reminder reliability preflight: required schema is missing.';
  end if;
  -- Compare the catalog-deparsed expression shape and sorted literal set.
  -- Whitespace, parentheses, text casts and state ordering are immaterial;
  -- additional predicates, different columns or extra/missing states fail closed.
  for v_contract in
    select * from (values
      ('public.reminders', 'reminders_valid_status', 'lowerstatus=anyarray[?,?,?,?]',
        array['cancelled','completed','pending','sent']::text[]),
      ('public.appointment_reminder_dispatches', 'appointment_reminder_dispatches_status_check',
        'status=anyarray[?,?,?,?]', array['created','failed','processing','skipped']::text[])
    ) as contracts(relation_name, constraint_name, expression_shape, states)
  loop
    select pg_catalog.pg_get_expr(c.conbin, c.conrelid) into v_expression
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_attribute a on a.attrelid=c.conrelid and a.attname='status' and not a.attisdropped
    where c.conrelid=pg_catalog.to_regclass(v_contract.relation_name)
      and c.conname=v_contract.constraint_name and c.contype='c' and c.convalidated
      and c.conkey=array[a.attnum];
    if not found then
      raise exception 'Appointment reminder reliability preflight: expected status constraint % is missing or unvalidated.', v_contract.constraint_name;
    end if;
    select pg_catalog.array_agg(parts[1] order by parts[1]) into v_states
    from pg_catalog.regexp_matches(v_expression, '''([^'']*)''', 'g') as parts;
    v_shape := pg_catalog.regexp_replace(v_expression, '''[^'']*''', '?', 'g');
    v_shape := pg_catalog.replace(v_shape, '::text', '');
    v_shape := pg_catalog.replace(v_shape, 'pg_catalog.', '');
    v_shape := pg_catalog.lower(pg_catalog.regexp_replace(v_shape, '[[:space:]()]', '', 'g'));
    if v_shape is distinct from v_contract.expression_shape or v_states is distinct from v_contract.states then
      raise exception 'Appointment reminder reliability preflight: status constraint % differs from the reviewed contract.', v_contract.constraint_name;
    end if;
  end loop;
  if not exists (select 1 from pg_catalog.pg_index
    where indexrelid = pg_catalog.to_regclass('public.appointment_reminder_dispatches_reminder_scheduled_key')
      and indisunique and indisvalid and indnkeyatts = 2
      and pg_catalog.pg_get_indexdef(indexrelid, 1, true) = 'reminder_id'
      and pg_catalog.pg_get_indexdef(indexrelid, 2, true) = 'scheduled_for'
      and pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.pg_get_expr(indpred, indrelid)), '[[:space:]()]', '', 'g')
        in ('reminder_idisnotnullandscheduled_forisnotnull', 'scheduled_forisnotnullandreminder_idisnotnull'))
     or not exists (select 1 from pg_catalog.pg_constraint
       where conrelid = 'public.appointment_reminder_dispatches'::regclass
         and conname = 'appointment_reminder_dispatches_schedule_offset_key' and contype = 'u'
         and not condeferrable
         and pg_catalog.pg_get_constraintdef(oid) = 'UNIQUE (schedule_id, reminder_offset_minutes)') then
    raise exception 'Appointment reminder reliability preflight: occurrence claims are missing.';
  end if;
  if exists (select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.reminders'::regclass and attname = 'next_trigger_at'
      and attnotnull and not attisdropped) then
    raise exception 'Appointment reminder reliability preflight: next_trigger_at must permit NULL.';
  end if;
end;
$preflight$;

alter table public.reminders drop constraint reminders_valid_status;
alter table public.reminders add constraint reminders_valid_status
  check (pg_catalog.lower(status) = any(array['pending', 'sent', 'completed', 'cancelled', 'expired']));

create or replace function public.validate_appointment_reminder_timing()
returns trigger language plpgsql security definer set search_path = ''
as $timing$
declare
  v_start timestamptz;
  v_now timestamptz;
begin
  if pg_catalog.lower(pg_catalog.btrim(coalesce(new.reminder_type, ''))) <> 'appointment' then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.remind_at is not distinct from old.remind_at
       and new.schedule_id is not distinct from old.schedule_id
       and new.reminder_type is not distinct from old.reminder_type then
      return new;
    end if;
  end if;
  -- Lock the current appointment so a concurrent reschedule cannot invalidate
  -- a newly selected reminder time while it is being persisted.
  select appointment.start_time into v_start
  from public.schedule as appointment
  where appointment.id = new.schedule_id
  for share;
  if not found or v_start is null or new.remind_at is null then
    raise exception 'Choose a valid linked appointment and reminder time.' using errcode = '22023';
  end if;
  v_now := pg_catalog.clock_timestamp();
  if new.remind_at <= v_now then
    raise exception 'Choose a reminder time in the future.' using errcode = '22023';
  end if;
  if new.remind_at > v_start - interval '10 minutes' then
    raise exception 'Set the reminder at least 10 minutes before the appointment.' using errcode = '22023';
  end if;
  -- A new/user-rescheduled occurrence starts at remind_at. Processor-only
  -- next_trigger_at advancement is intentionally outside this trigger.
  new.next_trigger_at := new.remind_at;
  return new;
end;
$timing$;
revoke all on function public.validate_appointment_reminder_timing() from public, anon, authenticated;
drop trigger if exists reminders_validate_appointment_timing on public.reminders;
create trigger reminders_validate_appointment_timing
before insert or update of remind_at, schedule_id, reminder_type
on public.reminders for each row execute function public.validate_appointment_reminder_timing();

CREATE OR REPLACE FUNCTION public.create_appointment_patient_reminder(p_appointment_id uuid)
 RETURNS public.reminders
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
  v_now timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and pg_catalog.lower(coalesce(p.role, '')) in ('staff', 'doctor', 'admin')
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

  if pg_catalog.lower(coalesce(v_appointment.status, '')) in (
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
    and pg_catalog.lower(coalesce(r.reminder_type, '')) = 'appointment'
  limit 1;

  if found then
    return v_existing;
  end if;

  v_appointment_title := coalesce(
    nullif(pg_catalog.btrim(v_appointment.title), ''),
    'maternal care appointment'
  );

  -- Preserve idempotent returns above, even if the existing reminder is old.
  -- Strictly future excludes an exact now() fallback. The latest valid clinic
  -- slot is start minus ten minutes; if already reached, create nothing.
  v_now := pg_catalog.clock_timestamp();
  v_remind_at := case
    when v_appointment.start_time - interval '24 hours' > v_now
      then v_appointment.start_time - interval '24 hours'
    when v_appointment.start_time - interval '1 hour' > v_now
      then v_appointment.start_time - interval '1 hour'
    else v_appointment.start_time - interval '10 minutes'
  end;
  if v_remind_at is null or v_remind_at <= v_now then
    raise exception 'There is no future reminder time at least 10 minutes before this appointment.'
      using errcode = '22023';
  end if;

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
    pg_catalog.format(
      'You have a scheduled %s on %s.',
      v_appointment_title,
      pg_catalog.to_char(
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
      and pg_catalog.lower(coalesce(reminder_type, '')) = 'appointment'
  do nothing
  returning * into v_created;

  if found then
    return v_created;
  end if;

  select r.*
  into v_existing
  from public.reminders r
  where r.schedule_id = p_appointment_id
    and pg_catalog.lower(coalesce(r.reminder_type, '')) = 'appointment'
  limit 1;

  if not found then
    raise exception 'The appointment reminder could not be created.';
  end if;

  return v_existing;
end;
$function$;

CREATE OR REPLACE FUNCTION public.process_due_appointment_reminders()
 RETURNS TABLE(examined integer, claimed integer, notifications_created integer, skipped integer, failed integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_candidate record;
  v_dispatch_id uuid;
  v_notification_id uuid;
  v_next_trigger timestamptz;
  v_step interval;
  v_wall_now timestamptz;
  v_delivery_now timestamptz;
  v_appointment public.schedule%rowtype;
  v_patient public.patients%rowtype;
begin
  examined := 0;
  claimed := 0;
  notifications_created := 0;
  skipped := 0;
  failed := 0;

  -- Reconciliation counts as examined + skipped, never as claimed/created.
  -- Current processing/created claims are ambiguous or already delivered;
  -- retain those for review. Earlier repeat history does not block expiry.
  for v_candidate in
    select reminder.id as reminder_id, reminder.schedule_id
    from public.reminders as reminder
    join public.schedule as appointment on appointment.id = reminder.schedule_id
    where pg_catalog.lower(pg_catalog.btrim(coalesce(reminder.reminder_type, ''))) = 'appointment'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(reminder.status, ''))) = 'pending'
      and appointment.start_time <= v_now
      and not exists (
        select 1 from public.appointment_reminder_dispatches as dispatch
        where dispatch.reminder_id = reminder.id
          and dispatch.scheduled_for = coalesce(reminder.next_trigger_at, reminder.remind_at)
          and dispatch.status in ('processing', 'created')
      )
    order by appointment.start_time, reminder.id
    limit 200
    for update of reminder skip locked
  loop
    examined := examined + 1;
    begin
      select appointment.* into v_appointment
      from public.schedule as appointment where appointment.id = v_candidate.schedule_id
      for share nowait;
      if found and v_appointment.start_time <= pg_catalog.clock_timestamp() then
        update public.reminders as reminder set status = 'expired', next_trigger_at = null
        where reminder.id = v_candidate.reminder_id;
      end if;
    exception when lock_not_available then
      -- A reschedule/cancellation owns the appointment; retry reconciliation later.
      null;
    end;
    skipped := skipped + 1;
  end loop;

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

    -- Nonblocking appointment/Patient locks avoid waiting behind a reschedule
    -- while already holding the reminder lock. All eligibility stays unchanged.
    begin
      select appointment.* into v_appointment
      from public.schedule as appointment where appointment.id = v_candidate.schedule_id
      for share nowait;
      if not found then
        skipped := skipped + 1;
        continue;
      end if;
      select patient.* into v_patient from public.patients as patient
      where patient.id = v_candidate.patient_id for share nowait;
      if not found then
        skipped := skipped + 1;
        continue;
      end if;
      v_wall_now := pg_catalog.clock_timestamp();
      if v_appointment.start_time is null or v_appointment.start_time <= v_wall_now then
        update public.reminders as reminder set status = 'expired', next_trigger_at = null
        where reminder.id = v_candidate.reminder_id;
        skipped := skipped + 1;
        continue;
      end if;
      if pg_catalog.lower(pg_catalog.btrim(coalesce(v_appointment.status, '')))
           not in ('scheduled', 'pending', 'accepted', 'rescheduled')
         or v_patient.user_id is null
         or pg_catalog.lower(pg_catalog.btrim(coalesce(v_patient.account_status, ''))) <> 'active'
         or v_patient.archived_at is not null
         or pg_catalog.lower(pg_catalog.btrim(coalesce(v_patient.status, '')))
           in ('inactive', 'archived', 'deleted') then
        skipped := skipped + 1;
        continue;
      end if;
      v_candidate.appointment_start_time := v_appointment.start_time;
      v_candidate.user_id := v_patient.user_id;
    exception when lock_not_available then
      skipped := skipped + 1;
      continue;
    end;

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
        v_wall_now,
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
      -- Re-read after the real claim: a delayed claim can cross the deadline.
      select appointment.* into v_appointment from public.schedule as appointment
      where appointment.id = v_candidate.schedule_id for share;
      v_delivery_now := pg_catalog.clock_timestamp();
      if not found or pg_catalog.lower(pg_catalog.btrim(coalesce(v_appointment.status, '')))
           not in ('scheduled', 'pending', 'accepted', 'rescheduled') then
        update public.appointment_reminder_dispatches as dispatch
        set status = 'skipped', error_code = 'appointment_not_eligible_before_notification',
            notification_id = null, notification_created_at = null
        where dispatch.id = v_dispatch_id;
        skipped := skipped + 1;
        continue;
      end if;
      if v_appointment.start_time is null or v_appointment.start_time <= v_delivery_now then
        update public.appointment_reminder_dispatches as dispatch
        set status = 'skipped', error_code = 'appointment_started_before_notification',
            notification_id = null, notification_created_at = null
        where dispatch.id = v_dispatch_id;
        update public.reminders as reminder set status = 'expired', next_trigger_at = null
        where reminder.id = v_candidate.reminder_id;
        skipped := skipped + 1;
        continue;
      end if;
      v_candidate.appointment_start_time := v_appointment.start_time;
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

      -- If INSERT itself waited (index/trigger contention), roll back its entire
      -- subtransaction, including transactional notification transport enqueues.
      v_delivery_now := pg_catalog.clock_timestamp();
      if v_appointment.start_time is null or v_appointment.start_time <= v_delivery_now then
        raise exception 'Appointment cutoff reached during notification creation.' using errcode = 'P7501';
      end if;

      update public.appointment_reminder_dispatches as dispatch
      set
        status = 'created',
        notification_id = v_notification_id,
        notification_created_at = v_delivery_now,
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
          sent_at = v_delivery_now,
          next_trigger_at = null
        where reminder.id = v_candidate.reminder_id;
      else
        v_next_trigger := v_candidate.scheduled_for + v_step;

        -- If Cron was paused/offline, do not flood the Patient with every
        -- missed hourly/daily occurrence. Resume at the next future slot.
        while v_next_trigger <= v_delivery_now loop
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
            sent_at = v_delivery_now,
            next_trigger_at = null
          where reminder.id = v_candidate.reminder_id;
        else
          update public.reminders as reminder
          set
            status = 'pending',
            sent_at = v_delivery_now,
            next_trigger_at = v_next_trigger
          where reminder.id = v_candidate.reminder_id;
        end if;
      end if;

    exception
      when sqlstate 'P7501' then
        update public.appointment_reminder_dispatches as dispatch
        set status = 'skipped', notification_id = null, notification_created_at = null,
            error_code = 'appointment_started_before_notification'
        where dispatch.id = v_dispatch_id;
        update public.reminders as reminder set status = 'expired', next_trigger_at = null
        where reminder.id = v_candidate.reminder_id;
        skipped := skipped + 1;
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

-- Retain the deployed RPC execute grants through CREATE OR REPLACE. The cron
-- processor is server-only; no new client privilege is introduced.
revoke all on function public.process_due_appointment_reminders() from public, anon, authenticated;
comment on function public.process_due_appointment_reminders() is
  'Configured/fallback appointment reminders with locked expiry and wall-clock cutoff; expiry counts examined/skipped.';
comment on function public.validate_appointment_reminder_timing() is
  'Future and ten-minute lead validation only for appointment creation/user scheduling changes; processor advancement is excluded.';

-- One bounded/idempotent historical batch. Never alter ANY dispatch history.
do $historical$
declare v_candidate record; v_start timestamptz; v_cutoff timestamptz := pg_catalog.clock_timestamp();
begin
  for v_candidate in
    select reminder.id, reminder.schedule_id
    from public.reminders as reminder
    join public.schedule as appointment on appointment.id = reminder.schedule_id
    where pg_catalog.lower(pg_catalog.btrim(coalesce(reminder.reminder_type, ''))) = 'appointment'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(reminder.status, ''))) = 'pending'
      and appointment.start_time <= v_cutoff
      and coalesce(reminder.next_trigger_at, reminder.remind_at) <= v_cutoff
      and not exists (select 1 from public.appointment_reminder_dispatches as dispatch
        where dispatch.reminder_id = reminder.id)
    order by appointment.start_time, reminder.id
    limit 200 for update of reminder skip locked
  loop
    begin
      select appointment.start_time into v_start from public.schedule as appointment
      where appointment.id = v_candidate.schedule_id for share nowait;
      if found and v_start <= pg_catalog.clock_timestamp() then
        update public.reminders as reminder set status = 'expired', next_trigger_at = null
        where reminder.id = v_candidate.id;
      end if;
    exception when lock_not_available then null;
    end;
  end loop;
end;
$historical$;

-- Locate one exact existing identity; never schedule/unschedule a second job.
do $cron$
declare v_count integer; v_job record;
begin
  select pg_catalog.count(*) into v_count from cron.job
  where jobname = 'process-due-appointment-reminders';
  if v_count <> 1 then
    raise exception 'Appointment reminder cron preflight: expected exactly one existing job.';
  end if;
  select job.* into v_job from cron.job as job
  where job.jobname = 'process-due-appointment-reminders';
  if v_job.database is distinct from pg_catalog.current_database()
     or v_job.active is distinct from true
     or v_job.schedule not in ('*/5 * * * *', '* * * * *')
     or pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.btrim(v_job.command)), '\s+', ' ', 'g')
          is distinct from 'select * from public.process_due_appointment_reminders();' then
    raise exception 'Appointment reminder cron preflight: existing job configuration differs from the reviewed job.';
  end if;
  perform cron.alter_job(v_job.jobid, schedule := '* * * * *');
end;
$cron$;
commit;
