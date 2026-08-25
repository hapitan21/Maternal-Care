-- ============================================================
-- Maternal Care - Medication Adherence Follow-up Workflow
-- ============================================================
-- REVIEW ONLY. Run this file manually in the Supabase SQL Editor
-- after reviewing it against the target project.
--
-- This migration does not execute from the React application. It does not
-- change medication occurrences, reminder processing, Cron jobs, notification
-- delivery, webhooks, or Patient access.
-- ============================================================

-- ============================================================
-- COMMENTED LIVE-SCHEMA PREFLIGHT QUERIES
-- ============================================================
-- select table_schema, table_name, column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name = 'profiles'
--   and column_name in ('id', 'role', 'account_status')
-- order by column_name;
--
-- select table_schema, table_name, column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name = 'patients'
--   and column_name in (
--     'id',
--     'user_id',
--     'account_status',
--     'archived_at',
--     'status'
--   )
-- order by column_name;
--
-- select table_schema, table_name, column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name = 'patient_notifications'
--   and column_name in ('id', 'patient_id')
-- order by column_name;

begin;

create table if not exists public.medication_adherence_followups (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null,
  assigned_doctor_id uuid not null,
  assignment_revision bigint not null default 1,
  status text not null default 'open',
  severity_snapshot text not null,
  adherence_rate_snapshot numeric(5, 2),
  total_outcomes_snapshot integer not null,
  taken_count_snapshot integer not null,
  skipped_count_snapshot integer not null,
  missed_count_snapshot integer not null,
  maximum_missed_streak_snapshot integer not null,
  analysis_window_start date not null,
  analysis_window_end date not null,
  latest_completed_dose_at timestamptz,
  last_contacted_at timestamptz,
  next_follow_up_at timestamptz,
  resolution_summary text,
  resolved_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint medication_adherence_followups_patient_id_fkey
    foreign key (patient_id)
    references public.patients(id)
    on delete restrict,
  constraint medication_adherence_followups_assigned_doctor_id_fkey
    foreign key (assigned_doctor_id)
    references public.profiles(id)
    on delete restrict,
  constraint medication_adherence_followups_assignment_revision_check
    check (assignment_revision >= 1),
  constraint medication_adherence_followups_status_check
    check (status in ('open', 'contacted', 'monitoring', 'resolved')),
  constraint medication_adherence_followups_severity_check
    check (severity_snapshot in ('warning', 'high', 'critical')),
  constraint medication_adherence_followups_rate_check
    check (
      adherence_rate_snapshot is null
      or adherence_rate_snapshot between 0 and 100
    ),
  constraint medication_adherence_followups_counts_check
    check (
      total_outcomes_snapshot >= 0
      and taken_count_snapshot >= 0
      and skipped_count_snapshot >= 0
      and missed_count_snapshot >= 0
      and maximum_missed_streak_snapshot >= 0
      and total_outcomes_snapshot =
        taken_count_snapshot + skipped_count_snapshot + missed_count_snapshot
    ),
  constraint medication_adherence_followups_streak_check
    check (maximum_missed_streak_snapshot <= missed_count_snapshot),
  -- Store the same rounded whole adherence percentage shown in the Doctor
  -- alert UI. The original counts preserve the exact fraction for later use.
  constraint medication_adherence_followups_adherence_consistency_check
    check (
      (
        total_outcomes_snapshot = 0
        and adherence_rate_snapshot is null
        and taken_count_snapshot = 0
        and skipped_count_snapshot = 0
        and missed_count_snapshot = 0
        and maximum_missed_streak_snapshot = 0
      )
      or
      (
        total_outcomes_snapshot > 0
        and adherence_rate_snapshot is not null
        and pg_catalog.abs(
          adherence_rate_snapshot
          - pg_catalog.round(
              taken_count_snapshot::numeric
              / total_outcomes_snapshot::numeric
              * 100,
              0
            )
        ) <= 0.01
      )
    ),
  constraint medication_adherence_followups_severity_semantics_check
    check (
      (
        severity_snapshot = 'critical'
        and maximum_missed_streak_snapshot >= 3
      )
      or
      (
        severity_snapshot = 'high'
        and maximum_missed_streak_snapshot < 3
        and total_outcomes_snapshot >= 3
        and adherence_rate_snapshot < 50
      )
      or
      (
        severity_snapshot = 'warning'
        and maximum_missed_streak_snapshot < 3
        and total_outcomes_snapshot >= 3
        and adherence_rate_snapshot >= 50
        and adherence_rate_snapshot < 80
      )
    ),
  constraint medication_adherence_followups_analysis_window_check
    check (analysis_window_end = analysis_window_start + 6),
  constraint medication_adherence_followups_resolution_length_check
    check (
      resolution_summary is null
      or char_length(resolution_summary) between 1 and 2000
    ),
  constraint medication_adherence_followups_resolution_state_check
    check (
      (
        status = 'resolved'
        and resolved_at is not null
        and nullif(pg_catalog.btrim(coalesce(resolution_summary, ''::text)), '') is not null
      )
      or
      (
        status <> 'resolved'
        and resolved_at is null
        and resolution_summary is null
      )
    )
);

create table if not exists public.medication_adherence_followup_events (
  id uuid primary key default gen_random_uuid(),
  followup_id uuid not null,
  event_type text not null,
  from_status text,
  to_status text,
  contact_method text,
  note text,
  resolution_summary text,
  next_follow_up_at timestamptz,
  related_notification_id uuid,
  created_by uuid not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint medication_adherence_followup_events_followup_id_fkey
    foreign key (followup_id)
    references public.medication_adherence_followups(id)
    on delete restrict,
  constraint medication_adherence_followup_events_notification_id_fkey
    foreign key (related_notification_id)
    references public.patient_notifications(id)
    on delete set null,
  constraint medication_adherence_followup_events_created_by_fkey
    foreign key (created_by)
    references public.profiles(id)
    on delete restrict,
  constraint medication_adherence_followup_events_type_check
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
        'reopened'
      )
    ),
  constraint medication_adherence_followup_events_from_status_check
    check (
      from_status is null
      or from_status in ('open', 'contacted', 'monitoring', 'resolved')
    ),
  constraint medication_adherence_followup_events_to_status_check
    check (
      to_status is null
      or to_status in ('open', 'contacted', 'monitoring', 'resolved')
    ),
  constraint medication_adherence_followup_events_contact_method_check
    check (
      contact_method is null
      or contact_method in (
        'in_app_notification',
        'phone',
        'sms',
        'email',
        'in_person',
        'other'
      )
    ),
  constraint medication_adherence_followup_events_note_length_check
    check (note is null or char_length(note) between 1 and 2000),
  constraint medication_adherence_followup_events_resolution_length_check
    check (
      resolution_summary is null
      or char_length(resolution_summary) between 1 and 2000
    ),
  constraint medication_adherence_followup_events_contact_requirement_check
    check (
      event_type not in ('contact_attempt', 'patient_contacted')
      or contact_method is not null
    )
);

create unique index if not exists medication_adherence_followups_one_active_patient_idx
  on public.medication_adherence_followups (patient_id)
  where status in ('open', 'contacted', 'monitoring');

create index if not exists medication_adherence_followups_patient_created_idx
  on public.medication_adherence_followups (patient_id, created_at desc);

create index if not exists medication_adherence_followups_next_follow_up_idx
  on public.medication_adherence_followups (next_follow_up_at)
  where status in ('open', 'contacted', 'monitoring');

create index if not exists medication_adherence_followup_events_case_created_idx
  on public.medication_adherence_followup_events (followup_id, created_at desc);

create or replace function public.set_medication_adherence_followup_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;

drop trigger if exists medication_adherence_followups_set_updated_at
  on public.medication_adherence_followups;

create trigger medication_adherence_followups_set_updated_at
before update on public.medication_adherence_followups
for each row
execute function public.set_medication_adherence_followup_updated_at();

alter table public.medication_adherence_followups enable row level security;
alter table public.medication_adherence_followup_events enable row level security;

drop policy if exists "Doctors and admins can read medication adherence followups"
  on public.medication_adherence_followups;

create policy "Doctors and admins can read medication adherence followups"
on public.medication_adherence_followups
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(
        pg_catalog.btrim(coalesce(profile.role, ''::text))
      ) in ('doctor', 'admin')
      and pg_catalog.lower(
        pg_catalog.btrim(coalesce(profile.account_status, 'active'::text))
      ) = 'active'
  )
);

drop policy if exists "Doctors and admins can read medication adherence followup events"
  on public.medication_adherence_followup_events;

create policy "Doctors and admins can read medication adherence followup events"
on public.medication_adherence_followup_events
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles as profile
    where profile.id = auth.uid()
      and pg_catalog.lower(
        pg_catalog.btrim(coalesce(profile.role, ''::text))
      ) in ('doctor', 'admin')
      and pg_catalog.lower(
        pg_catalog.btrim(coalesce(profile.account_status, 'active'::text))
      ) = 'active'
  )
);

-- Mutations are intentionally available only through the atomic functions
-- below. Follow-up events are append-only and neither table supports DELETE.
revoke all on public.medication_adherence_followups
  from public, anon, authenticated;
revoke all on public.medication_adherence_followup_events
  from public, anon, authenticated;
grant select on public.medication_adherence_followups to authenticated;
grant select on public.medication_adherence_followup_events to authenticated;

create or replace function public.start_medication_adherence_followup(
  p_patient_id uuid,
  p_severity_snapshot text,
  p_adherence_rate_snapshot numeric,
  p_total_outcomes_snapshot integer,
  p_taken_count_snapshot integer,
  p_skipped_count_snapshot integer,
  p_missed_count_snapshot integer,
  p_maximum_missed_streak_snapshot integer,
  p_analysis_window_start date,
  p_analysis_window_end date,
  p_latest_completed_dose_at timestamptz default null,
  p_initial_note text default null,
  p_next_follow_up_at timestamptz default null
)
returns public.medication_adherence_followups
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_severity text := pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_severity_snapshot, ''::text))
  );
  v_note text := nullif(pg_catalog.btrim(coalesce(p_initial_note, ''::text)), '');
  v_followup public.medication_adherence_followups;
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
    raise exception 'Only active Doctors or Admins can start medication adherence follow-ups.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.patients as patient
    where patient.id = p_patient_id
      and patient.user_id is not null
      and patient.archived_at is null
      and pg_catalog.lower(
        pg_catalog.btrim(coalesce(patient.account_status, ''::text))
      ) = 'active'
      and pg_catalog.lower(
        pg_catalog.btrim(coalesce(patient.status, ''::text))
      ) not in ('inactive', 'archived', 'deleted')
  ) then
    raise exception 'The selected Patient must be active and linked to a Patient account.'
      using errcode = 'P0002';
  end if;

  if v_severity not in ('warning', 'high', 'critical') then
    raise exception 'Follow-up severity must be warning, high, or critical.'
      using errcode = '22023';
  end if;

  if p_adherence_rate_snapshot is not null
     and (p_adherence_rate_snapshot < 0 or p_adherence_rate_snapshot > 100) then
    raise exception 'Adherence rate must be between 0 and 100.'
      using errcode = '22023';
  end if;

  if p_total_outcomes_snapshot is null
     or p_taken_count_snapshot is null
     or p_skipped_count_snapshot is null
     or p_missed_count_snapshot is null
     or p_maximum_missed_streak_snapshot is null then
    raise exception 'All follow-up snapshot counts are required.'
      using errcode = '22023';
  end if;

  if p_total_outcomes_snapshot < 0
     or p_taken_count_snapshot < 0
     or p_skipped_count_snapshot < 0
     or p_missed_count_snapshot < 0
     or p_maximum_missed_streak_snapshot < 0
     or p_total_outcomes_snapshot <>
       p_taken_count_snapshot + p_skipped_count_snapshot + p_missed_count_snapshot then
    raise exception 'Follow-up snapshot counts are invalid.'
      using errcode = '22023';
  end if;

  if p_maximum_missed_streak_snapshot > p_missed_count_snapshot then
    raise exception 'Maximum missed streak cannot exceed the missed dose count.'
      using errcode = '22023';
  end if;

  if p_total_outcomes_snapshot = 0
     and (
       p_adherence_rate_snapshot is not null
       or p_taken_count_snapshot <> 0
       or p_skipped_count_snapshot <> 0
       or p_missed_count_snapshot <> 0
       or p_maximum_missed_streak_snapshot <> 0
     ) then
    raise exception 'A zero-outcome snapshot must have null adherence and zero counts.'
      using errcode = '22023';
  end if;

  if p_total_outcomes_snapshot > 0
     and (
       p_adherence_rate_snapshot is null
       or pg_catalog.abs(
         p_adherence_rate_snapshot
         - pg_catalog.round(
             p_taken_count_snapshot::numeric
             / p_total_outcomes_snapshot::numeric
             * 100,
             0
           )
       ) > 0.01
     ) then
    raise exception 'Adherence rate must equal the rounded whole percentage of Taken divided by total completed outcomes.'
      using errcode = '22023';
  end if;

  if v_severity = 'critical'
     and p_maximum_missed_streak_snapshot < 3 then
    raise exception 'Critical follow-up requires at least three consecutive missed doses.'
      using errcode = '22023';
  end if;

  if v_severity = 'high'
     and (
       p_maximum_missed_streak_snapshot >= 3
       or p_total_outcomes_snapshot < 3
       or p_adherence_rate_snapshot is null
       or p_adherence_rate_snapshot >= 50
     ) then
    raise exception 'High follow-up requires fewer than three consecutive misses, at least three outcomes, and adherence below 50 percent.'
      using errcode = '22023';
  end if;

  if v_severity = 'warning'
     and (
       p_maximum_missed_streak_snapshot >= 3
       or p_total_outcomes_snapshot < 3
       or p_adherence_rate_snapshot is null
       or p_adherence_rate_snapshot < 50
       or p_adherence_rate_snapshot >= 80
     ) then
    raise exception 'Warning follow-up requires fewer than three consecutive misses, at least three outcomes, and adherence from 50 to below 80 percent.'
      using errcode = '22023';
  end if;

  if p_analysis_window_start is null
     or p_analysis_window_end is null
     or p_analysis_window_end <> p_analysis_window_start + 6 then
    raise exception 'Follow-up analysis window must cover exactly seven inclusive calendar dates.'
      using errcode = '22023';
  end if;

  if v_note is null then
    raise exception 'An initial follow-up note is required.'
      using errcode = '22023';
  end if;

  if char_length(v_note) > 2000 then
    raise exception 'Follow-up note must not exceed 2000 characters.'
      using errcode = '22023';
  end if;

  select followup.*
  into v_followup
  from public.medication_adherence_followups as followup
  where followup.patient_id = p_patient_id
    and followup.status in ('open', 'contacted', 'monitoring')
  order by followup.created_at desc
  limit 1;

  if found then
    return v_followup;
  end if;

  begin
    insert into public.medication_adherence_followups (
      patient_id,
      assigned_doctor_id,
      status,
      severity_snapshot,
      adherence_rate_snapshot,
      total_outcomes_snapshot,
      taken_count_snapshot,
      skipped_count_snapshot,
      missed_count_snapshot,
      maximum_missed_streak_snapshot,
      analysis_window_start,
      analysis_window_end,
      latest_completed_dose_at,
      next_follow_up_at
    )
    values (
      p_patient_id,
      auth.uid(),
      'open',
      v_severity,
      p_adherence_rate_snapshot,
      p_total_outcomes_snapshot,
      p_taken_count_snapshot,
      p_skipped_count_snapshot,
      p_missed_count_snapshot,
      p_maximum_missed_streak_snapshot,
      p_analysis_window_start,
      p_analysis_window_end,
      p_latest_completed_dose_at,
      p_next_follow_up_at
    )
    returning * into v_followup;
  exception
    when unique_violation then
      select followup.*
      into v_followup
      from public.medication_adherence_followups as followup
      where followup.patient_id = p_patient_id
        and followup.status in ('open', 'contacted', 'monitoring')
      order by followup.created_at desc
      limit 1;

      if not found then
        raise;
      end if;

      return v_followup;
  end;

  insert into public.medication_adherence_followup_events (
    followup_id,
    event_type,
    to_status,
    note,
    created_by
  )
  values (
    v_followup.id,
    'followup_started',
    'open',
    v_note,
    auth.uid()
  );

  if p_next_follow_up_at is not null then
    insert into public.medication_adherence_followup_events (
      followup_id,
      event_type,
      to_status,
      note,
      next_follow_up_at,
      created_by
    )
    values (
      v_followup.id,
      'followup_scheduled',
      'open',
      'Initial next follow-up scheduled.',
      p_next_follow_up_at,
      auth.uid()
    );
  end if;

  return v_followup;
end;
$function$;

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

  if v_followup.status = 'resolved' then
    raise exception 'Resolved follow-ups cannot receive new activity.'
      using errcode = '22023';
  end if;

  if v_event_type not in (
    'note_added',
    'contact_attempt',
    'notification_sent',
    'followup_scheduled'
  ) then
    raise exception 'Unsupported follow-up event type.'
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

  if v_event_type = 'note_added' and v_note is null then
    raise exception 'A follow-up note is required.'
      using errcode = '22023';
  end if;

  if v_event_type = 'followup_scheduled' and p_next_follow_up_at is null then
    raise exception 'A next follow-up date and time is required.'
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

  if p_next_follow_up_at is not null then
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

create or replace function public.update_medication_adherence_followup_status(
  p_followup_id uuid,
  p_status text,
  p_contact_method text default null,
  p_note text default null,
  p_next_follow_up_at timestamptz default null,
  p_resolution_summary text default null
)
returns public.medication_adherence_followups
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_status text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_status, ''::text)));
  v_contact_method text := nullif(
    pg_catalog.lower(pg_catalog.btrim(coalesce(p_contact_method, ''::text))),
    ''
  );
  v_note text := nullif(pg_catalog.btrim(coalesce(p_note, ''::text)), '');
  v_resolution text := nullif(
    pg_catalog.btrim(coalesce(p_resolution_summary, ''::text)),
    ''
  );
  v_event_type text;
  v_from_status text;
  v_followup public.medication_adherence_followups;
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
    raise exception 'Only active Doctors or Admins can update follow-up status.'
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

  v_from_status := v_followup.status;

  if v_followup.status = 'resolved' then
    raise exception 'Resolved follow-ups remain historical. Start a new follow-up instead.'
      using errcode = '22023';
  end if;

  if v_status not in ('contacted', 'monitoring', 'resolved') then
    raise exception 'Unsupported follow-up status.'
      using errcode = '22023';
  end if;

  if not (
    (v_followup.status = 'open' and v_status in ('contacted', 'monitoring'))
    or
    (v_followup.status = 'contacted' and v_status in ('monitoring', 'resolved'))
    or
    (v_followup.status = 'monitoring' and v_status in ('contacted', 'resolved'))
  ) then
    raise exception 'The requested follow-up status transition is not allowed.'
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

  if v_status = 'contacted' and v_contact_method is null then
    raise exception 'A contact method is required when marking the Patient contacted.'
      using errcode = '22023';
  end if;

  if v_status = 'resolved' and v_resolution is null then
    raise exception 'A resolution summary is required.'
      using errcode = '22023';
  end if;

  if v_resolution is not null and char_length(v_resolution) > 2000 then
    raise exception 'Resolution summary must not exceed 2000 characters.'
      using errcode = '22023';
  end if;

  if v_note is not null and char_length(v_note) > 2000 then
    raise exception 'Follow-up note must not exceed 2000 characters.'
      using errcode = '22023';
  end if;

  update public.medication_adherence_followups
  set
    status = v_status,
    last_contacted_at = case
      when v_status = 'contacted' then pg_catalog.now()
      else last_contacted_at
    end,
    next_follow_up_at = case
      when v_status = 'resolved' then null
      when p_next_follow_up_at is not null then p_next_follow_up_at
      else next_follow_up_at
    end,
    resolution_summary = case when v_status = 'resolved' then v_resolution else null end,
    resolved_at = case when v_status = 'resolved' then pg_catalog.now() else null end
  where id = v_followup.id
  returning * into v_followup;

  v_event_type := case
    when v_status = 'contacted' then 'patient_contacted'
    when v_status = 'resolved' then 'resolved'
    else 'status_changed'
  end;
  insert into public.medication_adherence_followup_events (
    followup_id,
    event_type,
    from_status,
    to_status,
    contact_method,
    note,
    resolution_summary,
    next_follow_up_at,
    created_by
  )
  values (
    v_followup.id,
    v_event_type,
    v_from_status,
    v_status,
    v_contact_method,
    v_note,
    case when v_status = 'resolved' then v_resolution else null end,
    p_next_follow_up_at,
    auth.uid()
  );

  return v_followup;
end;
$function$;

revoke all on function public.start_medication_adherence_followup(
  uuid, text, numeric, integer, integer, integer, integer, integer,
  date, date, timestamptz, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.start_medication_adherence_followup(
  uuid, text, numeric, integer, integer, integer, integer, integer,
  date, date, timestamptz, text, timestamptz
) to authenticated;

revoke all on function public.add_medication_adherence_followup_event(
  uuid, text, text, text, timestamptz, uuid
) from public, anon, authenticated;
grant execute on function public.add_medication_adherence_followup_event(
  uuid, text, text, text, timestamptz, uuid
) to authenticated;

revoke all on function public.update_medication_adherence_followup_status(
  uuid, text, text, text, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.update_medication_adherence_followup_status(
  uuid, text, text, text, timestamptz, text
) to authenticated;

notify pgrst, 'reload schema';

commit;

-- ============================================================
-- COMMENTED VERIFICATION QUERIES
-- ============================================================
-- select
--   class.relname as table_name,
--   class.relrowsecurity as rls_enabled,
--   class.relforcerowsecurity as rls_forced
-- from pg_catalog.pg_class as class
-- join pg_catalog.pg_namespace as namespace
--   on namespace.oid = class.relnamespace
-- where namespace.nspname = 'public'
--   and class.relname in (
--     'medication_adherence_followups',
--     'medication_adherence_followup_events'
--   )
-- order by class.relname;
--
-- select indexname, indexdef
-- from pg_catalog.pg_indexes
-- where schemaname = 'public'
--   and indexname = 'medication_adherence_followups_one_active_patient_idx';
--
-- select policyname, tablename, cmd, roles
-- from pg_catalog.pg_policies
-- where schemaname = 'public'
--   and tablename in (
--     'medication_adherence_followups',
--     'medication_adherence_followup_events'
--   )
-- order by tablename, policyname;
--
-- select p.oid::regprocedure, p.prosecdef, p.proconfig
-- from pg_catalog.pg_proc as p
-- join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
-- where n.nspname = 'public'
--   and p.proname in (
--     'start_medication_adherence_followup',
--     'add_medication_adherence_followup_event',
--     'update_medication_adherence_followup_status'
--   )
-- order by p.proname;
