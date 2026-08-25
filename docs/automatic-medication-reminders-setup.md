# Automatic Medication Reminders Setup

Phase 4B adds automatic Patient medication reminders and adherence tracking. It uses the existing Patient notification inbox, Database Webhook, and `send-patient-web-push` Edge Function. It does not send Web Push directly from PostgreSQL.

## Architecture

The intended flow is:

```text
Supabase Cron every five minutes
-> public.process_due_medication_reminders()
-> public.medication_reminder_occurrences
-> public.patient_notifications INSERT
-> existing Database Webhook
-> existing send-patient-web-push Edge Function
-> Patient PWA notification inbox and system notification
```

Patient action flow:

```text
Patient PWA
-> public.mark_medication_reminder_occurrence(...)
-> occurrence status becomes taken or skipped
```

Missed flow:

```text
processor run
-> notified occurrence older than two hours with no action
-> status becomes missed
```

## Schema Objects

Review and apply `supabase_automatic_medication_reminders.sql` manually. It creates:

- `public.medication_reminder_occurrences`
- `public.process_due_medication_reminders()`
- `public.mark_medication_reminder_occurrence(uuid, text)`
- RLS allowing Patients to select only their own occurrence rows
- No direct Patient insert, update, or delete policies

The occurrence ledger stores one row per concrete medication reminder time. The unique constraint is:

```sql
unique (medication_reminder_id, scheduled_for)
```

That is the duplicate-prevention mechanism across overlapping Cron runs.

## Clinic Timezone

The project uses `Asia/Manila` in `src/lib/appointmentDate.js`. Medication times are entered as clinic-local times and stored in `public.medication_reminders.reminder_times` as `time without time zone[]`.

The processor combines a clinic-local date and stored `time` using `AT TIME ZONE 'Asia/Manila'`, then stores the concrete result as `timestamptz`.

Do not append `Z` to medication times and do not convert AM/PM display strings in SQL.

## Schedule Formats Found

The current Doctor form writes:

- `start_date`
- `end_date`
- `frequency`
- `duration`
- `reminder_times`
- `status`

The checked-in policy SQL documents the live schedule-time type as:

```text
reminder_times time without time zone[] not null default '{}'::time without time zone[]
```

The current UI frequency values are labels:

- `Once daily`
- `Twice daily`
- `Every morning`
- `Every night`
- `As prescribed`

There is no selected-weekday or one-time recurrence field in the current medication reminder form. Phase 4B therefore supports the existing date range plus one or more stored times per clinic-local day. Each time produces a separate occurrence when it enters the due window.

## Eligibility

A medication occurrence is eligible only when:

- The medication reminder exists.
- `patient_id` is present.
- `status = 'active'`.
- `start_date` is present and has begun.
- `end_date` is null or has not passed for the clinic-local date.
- `reminder_times` contains at least one valid stored time.
- The linked Patient exists.
- The Patient has `user_id`.
- The Patient has `account_status` equal to `active` after trimming whitespace and normalizing case.
- The Patient has `archived_at is null`.
- The Patient lifecycle `status` is not `inactive`, `archived`, or `deleted`.

Inactive, paused, completed, cancelled, archived, deleted, unlinked, and inactive-account Patients are skipped. The account-status comparison is trimmed and case-insensitive so values such as `Active` or ` active ` still match.

## Due Catch-Up Window

Cron should run every five minutes. The processor uses this catch-up window:

```sql
scheduled_for <= now()
and scheduled_for > now() - interval '15 minutes'
```

This sends reminders at or shortly after their scheduled time. It does not send reminders early or for medication times many hours in the past. If Cron is down longer than 15 minutes, an administrator should review stale test-safe cases rather than bulk-sending old medication reminders.

## Missed Grace Period

Phase 4B uses a two-hour response grace period. Every processor run marks unanswered occurrences as missed when:

```sql
status = 'notified'
and scheduled_for <= now() - interval '2 hours'
and action_at is null
```

No second Patient notification is created when marking an occurrence missed. Quiet hours and configurable grace periods are future phases.

## Notification Contract

The processor inserts privacy-safe `patient_notifications` rows:

| Column | Value |
| --- | --- |
| `type` | `medication_reminder` |
| `title` | `Medication Reminder` |
| `message` | `It is time for a scheduled medication reminder.` |
| `target_path` | `/patient/reminders` |
| `priority` | `important` |
| `patient_id` | linked `public.patients.id` |
| `user_id` | linked `public.patients.user_id` |
| `created_by` | `null` |
| `created_by_role` | `null` |
| `related_appointment_id` | `null` |
| `related_medical_record_id` | `null` |
| `related_reminder_id` | `null` in the current schema because it references `public.reminders(id)`, not `public.medication_reminders(id)` |

The push preview must not include medication name, dosage, diagnosis, pregnancy condition, Patient name, or clinical notes. Medication details remain visible only inside the authenticated Patient PWA.

## Failure and Retry

The processor handles reminders independently. If notification insertion fails, the occurrence becomes:

- `status = 'failed'`
- `notification_id = null`
- `notified_at = null`
- `error_code = 'notification_insert_failed'`

Raw SQL errors, secrets, subscription keys, and clinical details are never stored in `error_code`.

A failed occurrence may be reclaimed only when it still has no notification and remains inside the 15-minute catch-up window. The original ledger row is updated back to `processing`; it is not deleted.

## Patient Taken and Skip

The Patient PWA calls:

```sql
public.mark_medication_reminder_occurrence(
  p_occurrence_id := 'OCCURRENCE-UUID'::uuid,
  p_action := 'taken'
);
```

Allowed actions are:

- `taken`
- `skipped`

The RPC verifies the authenticated user owns the linked Patient row, the Patient account is active, and the occurrence is currently `notified`. Repeated submissions after `taken`, `skipped`, or `missed` are rejected.

The Patient UI shows:

- `Upcoming` for future/no-notification rows
- `Due` for notified rows awaiting action
- `Taken`
- `Skipped`
- `Missed`
- `Reminder unavailable` for failed or stuck server occurrences

Only `Due` rows show `Taken` and `Skip` buttons.

## Deactivation and Editing

When a medication reminder is deactivated, paused, completed, or cancelled, the processor does not create future occurrences. Historical occurrence rows remain.

When a Doctor edits a reminder time, future occurrences that have not yet been generated use the new `reminder_times`. Historical generated occurrences remain unchanged because they already store their concrete `scheduled_for` timestamp.

Medication reminders with occurrence history cannot be permanently deleted because the occurrence ledger uses `on delete restrict` for `medication_reminder_id`. Deactivate or archive the medication reminder instead. Historical Taken, Skipped, Missed, and notification-linked adherence rows are preserved.

Do not delete occurrence history when reminders are edited.

## Realtime

The Patient notification inbox already uses Realtime on `public.patient_notifications`. Phase 4B does not require adding `public.medication_reminder_occurrences` to the Realtime publication because the Patient UI refreshes occurrence data after the Taken/Skip RPC.

If live occurrence updates are later required, review the commented publication statement in the SQL file before running it.

## Create the Cron Job

Do not create the job until the SQL has been reviewed, applied, and manually tested.

Name:

```text
process-due-medication-reminders
```

Schedule:

```text
*/5 * * * *
```

Type:

```text
SQL Snippet
```

Command:

```sql
select *
from public.process_due_medication_reminders();
```

Do not modify or remove `process-due-appointment-reminders`. The appointment and medication Cron jobs must remain separate.

## Monitoring Queries

Recent occurrences:

```sql
select
  id,
  medication_reminder_id,
  patient_id,
  scheduled_for,
  status,
  notification_id,
  claimed_at,
  notified_at,
  action_at,
  missed_at,
  error_code,
  created_at,
  updated_at
from public.medication_reminder_occurrences
order by created_at desc
limit 100;
```

Duplicate check, expected no rows:

```sql
select
  medication_reminder_id,
  scheduled_for,
  count(*)
from public.medication_reminder_occurrences
group by medication_reminder_id, scheduled_for
having count(*) > 1;
```

Linked notifications:

```sql
select
  occurrence.id as occurrence_id,
  occurrence.medication_reminder_id,
  occurrence.scheduled_for,
  occurrence.status,
  notification.id as notification_id,
  notification.type,
  notification.title,
  notification.message,
  notification.target_path,
  notification.priority,
  notification.created_at
from public.medication_reminder_occurrences as occurrence
join public.patient_notifications as notification
  on notification.id = occurrence.notification_id
order by notification.created_at desc
limit 100;
```

Cron job:

```sql
select
  jobid,
  jobname,
  schedule,
  command,
  active
from cron.job
where jobname = 'process-due-medication-reminders';
```

Cron run history:

```sql
select
  runid,
  jobid,
  status,
  return_message,
  start_time,
  end_time
from cron.job_run_details
where jobid = (
  select jobid
  from cron.job
  where jobname = 'process-due-medication-reminders'
)
order by start_time desc
limit 100;
```

## Manual Tests

Use test Patients and test reminders only.

### Test A: Automatic Notification

1. Create an active medication reminder for an active linked test Patient.
2. Set its next stored reminder time a few minutes in the future.
3. Wait until the scheduled time.
4. Run this manually as a database administrator:

   ```sql
   select * from public.process_due_medication_reminders();
   ```

5. Confirm one occurrence with `status = 'notified'`.
6. Confirm one `medication_reminder` Patient notification.
7. Confirm the existing Web Push delivery status is `sent`.
8. Run the processor again.
9. Confirm no duplicate occurrence or notification.

### Test B: Taken

1. Open the Patient PWA.
2. Locate the Due medication.
3. Select `Taken`.
4. Confirm the occurrence becomes `taken`.
5. Confirm `action_at` is populated.
6. Confirm no action buttons remain.

### Test C: Skipped

1. Use another due test reminder.
2. Select `Skip`.
3. Confirm the occurrence becomes `skipped`.
4. Confirm `action_at` is populated.

### Test D: Inactive Reminder

1. Deactivate, pause, complete, or cancel a test medication reminder before it is due.
2. Run the processor after the scheduled time.
3. Confirm no occurrence or notification is created.

### Test E: Inactive or Unlinked Patient

1. Use an inactive or unlinked test Patient.
2. Run the processor with a due test reminder.
3. Confirm no occurrence or notification is created.

### Test F: Missed

Use an isolated test occurrence only. An administrator may create or adjust one test occurrence to `status = 'notified'` with `scheduled_for` older than two hours. Run the processor and confirm only that unanswered test occurrence becomes `missed`.

Do not alter real Patient medication history.
