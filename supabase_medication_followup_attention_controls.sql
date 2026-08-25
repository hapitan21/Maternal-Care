-- REVIEW ONLY: do not run until this migration has been reviewed and approved.
-- Adds Doctor-side acknowledgement and snooze events without changing follow-up
-- status, schedule, Patient notifications, medication reminders, or occurrences.

-- ============================================================
-- COMMENTED PREFLIGHT QUERIES
-- ============================================================
-- select constraint_name, pg_catalog.pg_get_constraintdef(oid) as definition
-- from (
--   select constraint_record.conname as constraint_name, constraint_record.oid
--   from pg_catalog.pg_constraint as constraint_record
--   where constraint_record.conrelid =
--     'public.medication_adherence_followup_events'::regclass
--     and constraint_record.contype = 'c'
-- ) as checks
-- order by constraint_name;

-- select
--   column_name,
--   data_type,
--   udt_name,
--   is_nullable,
--   character_maximum_length
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name = 'medication_adherence_followup_events'
-- order by ordinal_position;

-- select
--   routine.oid::regprocedure as signature,
--   routine.prosecdef as security_definer,
--   routine.proconfig as configuration,
--   pg_catalog.pg_get_functiondef(routine.oid) as definition
-- from pg_catalog.pg_proc as routine
-- join pg_catalog.pg_namespace as namespace
--   on namespace.oid = routine.pronamespace
-- where namespace.nspname = 'public'
--   and routine.proname = 'add_medication_adherence_followup_event';

-- select grantee, privilege_type
-- from information_schema.routine_privileges
-- where specific_schema = 'public'
--   and routine_name = 'add_medication_adherence_followup_event'
-- order by grantee, privilege_type;

-- select grantee, privilege_type
-- from information_schema.role_table_grants
-- where table_schema = 'public'
--   and table_name in (
--     'medication_adherence_followups',
--     'medication_adherence_followup_events'
--   )
-- order by table_name, grantee, privilege_type;

-- select policyname, permissive, roles, cmd, qual, with_check
-- from pg_catalog.pg_policies
-- where schemaname = 'public'
--   and tablename in (
--     'medication_adherence_followups',
--     'medication_adherence_followup_events'
--   )
-- order by tablename, policyname;

begin;

alter table public.medication_adherence_followup_events
  drop constraint if exists medication_adherence_followup_events_type_check;

alter table public.medication_adherence_followup_events
  add constraint medication_adherence_followup_events_type_check
  check (
    event_type in (
      'followup_started',
      'note_added',
      'contact_attempt',
      'patient_contacted',
      'notification_sent',
      'status_changed',
      'followup_scheduled',
      'resolved',
      'reopened',
      'attention_acknowledged',
      'attention_snoozed',
      'doctor_reassigned'
    )
  );

create or replace function public.add_medication_adherence_followup_event(
  p_followup_id uuid,
  p_event_type text,
  p_contact_method text default null,
  p_note text default null,
  p_next_follow_up_at timestamptz default null,
  p_related_notification_id uuid default null
)
returns public.medication_adherence_followup_events
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_event_type text := pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_event_type, ''::text))
  );
  v_contact_method text := nullif(
    pg_catalog.lower(pg_catalog.btrim(coalesce(p_contact_method, ''::text))),
    ''
  );
  v_note text := nullif(pg_catalog.btrim(coalesce(p_note, ''::text)), '');
  v_followup public.medication_adherence_followups;
  v_event public.medication_adherence_followup_events;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select pg_catalog.lower(pg_catalog.btrim(coalesce(profile.role, ''::text)))
  into v_role
  from public.profiles as profile
  where profile.id = auth.uid()
    and pg_catalog.lower(
      pg_catalog.btrim(coalesce(profile.account_status, 'active'::text))
    ) = 'active';

  if v_role is null or v_role not in ('doctor', 'admin') then
    raise exception 'Only active Doctors or Admins can record follow-up activity.'
      using errcode = '42501';
  end if;

  select followup.*
  into v_followup
  from public.medication_adherence_followups as followup
  where followup.id = p_followup_id
  for update;

  if not found then
    raise exception 'Medication adherence follow-up was not found.'
      using errcode = 'P0002';
  end if;

  if v_role = 'doctor' and v_followup.assigned_doctor_id <> auth.uid() then
    raise exception 'Doctors can only record activity for assigned follow-ups.'
      using errcode = '42501';
  end if;

  if pg_catalog.lower(
    pg_catalog.btrim(coalesce(v_followup.status, ''::text))
  ) = 'resolved' then
    raise exception 'Resolved follow-ups cannot receive new activity.'
      using errcode = '22023';
  end if;

  if v_event_type not in (
    'note_added',
    'contact_attempt',
    'notification_sent',
    'followup_scheduled',
    'attention_acknowledged',
    'attention_snoozed'
  ) then
    raise exception 'Unsupported follow-up event type.'
      using errcode = '22023';
  end if;

  if v_event_type in ('attention_acknowledged', 'attention_snoozed') and (
    v_followup.next_follow_up_at is null
    or (v_followup.next_follow_up_at at time zone 'Asia/Manila')::date
      > (pg_catalog.now() at time zone 'Asia/Manila')::date
  ) then
    raise exception 'Attention controls are available only for follow-ups that are due today or overdue.'
      using errcode = '22023';
  end if;

  if v_contact_method is not null and v_contact_method not in (
    'in_app_notification',
    'phone',
    'sms',
    'email',
    'in_person',
    'other'
  ) then
    raise exception 'Unsupported contact method.'
      using errcode = '22023';
  end if;

  if v_event_type = 'contact_attempt' and v_contact_method is null then
    raise exception 'A contact method is required for a contact attempt.'
      using errcode = '22023';
  end if;

  if v_event_type = 'notification_sent' then
    v_contact_method := 'in_app_notification';
    if p_related_notification_id is null then
      raise exception 'A sent notification identifier is required.'
        using errcode = '22023';
    end if;
  end if;

  if v_note is not null and char_length(v_note) > 2000 then
    raise exception 'Follow-up note must not exceed 2000 characters.'
      using errcode = '22023';
  end if;

  if v_event_type in ('attention_acknowledged', 'attention_snoozed')
    and v_note is not null
    and char_length(v_note) > 1000
  then
    raise exception 'Attention-control note must not exceed 1000 characters.'
      using errcode = '22023';
  end if;

  if v_event_type = 'note_added' and v_note is null then
    raise exception 'A follow-up note is required.'
      using errcode = '22023';
  end if;

  if v_event_type = 'followup_scheduled' and p_next_follow_up_at is null then
    raise exception 'A next follow-up date and time is required.'
      using errcode = '22023';
  end if;

  if v_event_type = 'attention_snoozed' and (
    p_next_follow_up_at is null
    or p_next_follow_up_at <= pg_catalog.now()
  ) then
    raise exception 'Snooze expiration must be in the future.'
      using errcode = '22023';
  end if;

  if v_event_type = 'attention_acknowledged'
    and p_next_follow_up_at is not null
  then
    raise exception 'Acknowledgement does not accept a scheduled timestamp.'
      using errcode = '22023';
  end if;

  if p_next_follow_up_at is not null
    and v_event_type not in ('followup_scheduled', 'attention_snoozed')
  then
    raise exception 'This event type does not accept a scheduled timestamp.'
      using errcode = '22023';
  end if;

  if v_event_type in ('attention_acknowledged', 'attention_snoozed') and (
    v_contact_method is not null
    or p_related_notification_id is not null
  ) then
    raise exception 'Attention controls cannot send or reference Patient notifications.'
      using errcode = '22023';
  end if;

  if p_related_notification_id is not null and not exists (
    select 1
    from public.patient_notifications as notification
    where notification.id = p_related_notification_id
      and notification.patient_id = v_followup.patient_id
  ) then
    raise exception 'The notification does not belong to the follow-up Patient.'
      using errcode = '23503';
  end if;

  if v_event_type = 'followup_scheduled' then
    update public.medication_adherence_followups
    set next_follow_up_at = p_next_follow_up_at
    where id = v_followup.id;
  end if;

  insert into public.medication_adherence_followup_events (
    followup_id,
    event_type,
    contact_method,
    note,
    next_follow_up_at,
    related_notification_id,
    created_by
  )
  values (
    v_followup.id,
    v_event_type,
    v_contact_method,
    v_note,
    p_next_follow_up_at,
    p_related_notification_id,
    auth.uid()
  )
  returning * into v_event;

  return v_event;
end;
$function$;

-- Reassert the existing append-only browser-role access model.
revoke all on public.medication_adherence_followup_events
  from public, anon, authenticated;
grant select on public.medication_adherence_followup_events to authenticated;

revoke all on function public.add_medication_adherence_followup_event(
  uuid, text, text, text, timestamptz, uuid
) from public, anon, authenticated;
grant execute on function public.add_medication_adherence_followup_event(
  uuid, text, text, text, timestamptz, uuid
) to authenticated;

notify pgrst, 'reload schema';

commit;

-- ============================================================
-- COMMENTED VERIFICATION QUERIES (READ ONLY)
-- ============================================================
-- select
--   constraint_record.conname,
--   pg_catalog.pg_get_constraintdef(constraint_record.oid)
-- from pg_catalog.pg_constraint as constraint_record
-- where constraint_record.conrelid =
--   'public.medication_adherence_followup_events'::regclass
--   and constraint_record.conname =
--     'medication_adherence_followup_events_type_check';

-- select
--   routine.oid::regprocedure as signature,
--   routine.prosecdef as security_definer,
--   routine.proconfig as configuration,
--   pg_catalog.pg_get_functiondef(routine.oid) as definition
-- from pg_catalog.pg_proc as routine
-- join pg_catalog.pg_namespace as namespace
--   on namespace.oid = routine.pronamespace
-- where namespace.nspname = 'public'
--   and routine.proname = 'add_medication_adherence_followup_event';

-- select
--   has_function_privilege(
--     'authenticated',
--     'public.add_medication_adherence_followup_event(uuid,text,text,text,timestamptz,uuid)',
--     'execute'
--   ) as authenticated_can_execute,
--   has_table_privilege(
--     'authenticated',
--     'public.medication_adherence_followup_events',
--     'insert'
--   ) as authenticated_can_insert_directly,
--   has_table_privilege(
--     'authenticated',
--     'public.medication_adherence_followup_events',
--     'update'
--   ) as authenticated_can_update_events,
--   has_table_privilege(
--     'authenticated',
--     'public.medication_adherence_followup_events',
--     'delete'
--   ) as authenticated_can_delete_events;

-- Attention-control eligibility examples (read only; these do not call the RPC):
-- with attention_cases(label, next_follow_up_at, expected_result) as (
--   values
--     (
--       'Due Today',
--       (
--         (pg_catalog.now() at time zone 'Asia/Manila')::date
--         + interval '1 day' - interval '1 microsecond'
--       ) at time zone 'Asia/Manila',
--       'accepted'
--     ),
--     (
--       'Overdue',
--       pg_catalog.now() - interval '2 hours',
--       'accepted'
--     ),
--     (
--       'Upcoming',
--       (
--         (pg_catalog.now() at time zone 'Asia/Manila')::date
--         + interval '1 day' + interval '12 hours'
--       ) at time zone 'Asia/Manila',
--       'rejected'
--     ),
--     ('Unscheduled', null::timestamptz, 'rejected')
-- )
-- select
--   label,
--   expected_result,
--   case
--     when next_follow_up_at is not null
--       and (next_follow_up_at at time zone 'Asia/Manila')::date
--         <= (pg_catalog.now() at time zone 'Asia/Manila')::date
--       then 'accepted'
--     else 'rejected'
--   end as actual_result
-- from attention_cases;

-- Resolved-status normalization example (read only):
-- select
--   status_value,
--   pg_catalog.lower(
--     pg_catalog.btrim(coalesce(status_value, ''::text))
--   ) = 'resolved' as rejected_by_resolved_guard
-- from (values ('resolved'::text), (' Resolved '::text)) as statuses(status_value);

-- Patient-notification safety check (read only; expected result is true):
-- select pg_catalog.strpos(
--   pg_catalog.lower(
--     pg_catalog.pg_get_functiondef(
--       'public.add_medication_adherence_followup_event(uuid,text,text,text,timestamptz,uuid)'::regprocedure
--     )
--   ),
--   'insert into public.patient_notifications'
-- ) = 0 as creates_no_patient_notification;

-- Expected static verification:
-- 1. The event CHECK contains all previous values plus
--    attention_acknowledged, attention_snoozed, and the Phase 5C.2
--    doctor_reassigned audit event. The shared Doctor/Admin activity RPC
--    still cannot insert doctor_reassigned directly.
-- 2. The RPC signature is unchanged, remains SECURITY DEFINER, and has
--    search_path set to an empty protected path.
-- 3. Authenticated users can execute the RPC and cannot directly insert,
--    update, or delete event rows.
-- 4. The function definition updates next_follow_up_at only for
--    followup_scheduled, never for attention_snoozed.
-- 5. Due Today and Overdue attention controls pass the Manila calendar-date
--    guard; Upcoming and Unscheduled attention controls fail it with 22023.
-- 6. Resolved status is rejected after lower/btrim/coalesce normalization.
-- 7. No verification statement above creates a follow-up event or notification.
