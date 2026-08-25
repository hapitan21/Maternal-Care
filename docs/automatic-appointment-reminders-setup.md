# Automatic Appointment Reminders Setup

Phase 4A creates Patient inbox notifications approximately 24 hours and 2 hours before eligible appointments. It does not send Web Push directly. Each `patient_notifications` insert follows the existing Database Webhook and `send-patient-web-push` delivery path.

## Before Applying SQL

Review `supabase_automatic_appointment_reminders.sql` and run its commented read-only preflight queries separately. Confirm:

- `schedule.id` and `schedule.patient_id` are `uuid`.
- `schedule.start_time` is `timestamptz`.
- `patients.id` and `patients.user_id` are `uuid`.
- `patient_notifications.id` and `related_appointment_id` are `uuid`.
- The status distribution still matches the audited application values.
- No conflicting ledger table or processing function exists.

The application currently recognizes these appointment status spellings:

| Category | Values found |
| --- | --- |
| Active or occupying | `scheduled`, `pending`, `accepted`, `rescheduled` |
| Checked in | `checked_in`, `checked in` |
| Completed | `completed`, `complete`, `done` |
| Cancelled | `cancelled`, `canceled`, `cancel` |
| No show or missed | `no_show`, `no show`, `missed`, `absent` |
| Excluded lifecycle | `archived`, `deleted` |

The processor uses the active allowlist only. Checked-in, completed, cancelled, no-show, missed, archived, deleted, and unknown statuses are not eligible.

Apply the SQL file manually in the Supabase SQL Editor only after the preflight results have been reviewed. The file creates the internal ledger, its update trigger, and the processing function. It does not install `pg_cron` or create a Cron job.

## Reminder Windows

Supabase Cron should still invoke the processor every five minutes. The
processor now uses catch-up windows instead of exact five-minute slices:

- The 24-hour reminder applies while an appointment is more than 2 hours and no
  more than 24 hours away.
- The 2-hour reminder applies after the current time and no more than 2 hours
  before the appointment begins.

The windows do not overlap. An appointment within two hours receives only the
2-hour reminder, not a late 24-hour reminder. If a Cron run is delayed or
missed, a later run can still create the appropriate reminder while the
appointment remains in its catch-up window.

Both `schedule.start_time` and `now()` are compared as `timestamptz`. No
display-time text or database timezone conversion participates in scheduling.

The unique ledger constraint on `(schedule_id, reminder_offset_minutes)`
prevents repeated notifications. On first installation, eligible appointments
already inside a catch-up window may receive one reminder.

## Create the Cron Job

Do not create the job until the SQL has been reviewed, applied, and manually tested.

### Preferred: Supabase Dashboard

1. Open the Supabase project.
2. Open **Integrations**.
3. Install or open **Cron**.
4. Create a job.
5. Set the name to `process-due-appointment-reminders`.
6. Set the schedule to every 5 minutes.
7. Set the job type to **Database Function**.
8. Select `public.process_due_appointment_reminders`.
9. Review the configuration, then create the job manually.

### SQL Alternative

Review this statement before running it manually as a database administrator:

```sql
select cron.schedule(
  'process-due-appointment-reminders',
  '*/5 * * * *',
  $$ select public.process_due_appointment_reminders(); $$
);
```

Do not point Cron at the Database Webhook or Edge Function. The database function inserts the inbox row, and the existing insert webhook performs the Web Push handoff.

## Monitoring

Supabase Cron stores configured jobs in `cron.job` and run history in `cron.job_run_details`.

```sql
select
  jobid,
  jobname,
  schedule,
  command,
  active
from cron.job
where jobname = 'process-due-appointment-reminders';
```

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
  where jobname = 'process-due-appointment-reminders'
)
order by start_time desc
limit 100;
```

The function returns one summary row with `examined`, `claimed`, `notifications_created`, `skipped`, and `failed`. A repeated run should count previously claimed appointment/offset pairs as `skipped`.

Review recent dispatches without exposing Patient names or clinical details:

```sql
select
  id,
  schedule_id,
  patient_id,
  notification_id,
  reminder_offset_minutes,
  appointment_start_time,
  status,
  error_code,
  claimed_at,
  notification_created_at
from public.appointment_reminder_dispatches
order by created_at desc
limit 100;
```

## Failure Inspection and Retry

A failed inbox insert leaves the claimed ledger row in `failed` state with the privacy-safe code `notification_insert_failed`. Raw SQL errors are not stored. A worker interruption can leave a row in `processing`.

```sql
select
  id,
  schedule_id,
  patient_id,
  reminder_offset_minutes,
  appointment_start_time,
  status,
  error_code,
  claimed_at,
  updated_at
from public.appointment_reminder_dispatches
where status in ('failed', 'processing')
order by claimed_at;
```

Do not bulk-clear or automatically remove these rows. Before retrying one dispatch, an administrator should:

1. Resolve the underlying notification constraint or service issue.
2. Verify the appointment is still future, active, and inside the intended reminder window.
3. Verify the Patient is still linked, active, and not archived.
4. Verify no matching `appointment_reminder` notification already exists.
5. Prepare a reviewed, one-row administrator transaction that inserts the expected privacy-safe notification and updates the same ledger row to `created`.
6. Confirm the existing webhook creates one push-delivery record.

Keeping the original ledger row preserves the unique appointment/offset claim. Do not create a second ledger claim, and do not retry a stale reminder after its appointment or reminder window has passed.

## Manual Tests

Use test Patients and appointments only. Do not alter production appointments for these checks.

### Test A: 24-Hour Reminder

1. Manually create a test appointment between 2 and 24 hours from now.
2. Run this as a database administrator:

   ```sql
   select * from public.process_due_appointment_reminders();
   ```

3. Confirm exactly one dispatch row with `reminder_offset_minutes = 1440`.
4. Confirm exactly one `appointment_reminder` inbox notification.
5. Confirm the existing webhook creates one Web Push delivery.
6. Run the processor again.
7. Confirm there is no duplicate notification and the existing claim is counted as skipped.

### Test B: 2-Hour Reminder

1. Manually create a test appointment between now and 2 hours from now.
2. Run the processor manually.
3. Confirm exactly one dispatch row with `reminder_offset_minutes = 120`.
4. Confirm exactly one `appointment_reminder` notification.
5. Confirm Web Push is sent once through the existing webhook.
6. Run the processor again.
7. Confirm there is no duplicate.

### Test C: Cancelled Appointment

1. Manually create a test appointment inside either reminder window.
2. Cancel it before processing.
3. Run the processor.
4. Confirm no reminder dispatch or notification was created.

### Test D: Inactive or Unlinked Patient

1. Use an inactive or unlinked test Patient with an appointment inside a reminder window.
2. Run the processor.
3. Confirm no reminder dispatch or notification was created.

Also test the exact `checked_in`, `completed`, `no_show`, and `archived` status spellings from the project. None should create a reminder.

## Notification Contract

The processor inserts only these privacy-safe values:

| Offset | Title | Message |
| --- | --- | --- |
| 1440 minutes | `Appointment Tomorrow` | `You have a clinic appointment scheduled within the next 24 hours.` |
| 120 minutes | `Appointment Soon` | `You have a clinic appointment scheduled within the next 2 hours.` |

Both notifications use:

- Type: `appointment_reminder`
- Target: `/patient/appointments`
- Priority: `important`
- Related appointment: the real `schedule.id`
- Patient and user IDs: the linked `patients` row
- Creator and unrelated clinical IDs: `null`

No Patient name, diagnosis, appointment reason, medication, laboratory result, address, confidential note, or pregnancy complication is included.

## Reschedules and Cancellations

Phase 4A allows only one reminder per appointment and offset, even if `schedule.start_time` later changes. A rescheduled appointment does not receive the same 24-hour or 2-hour reminder twice. The existing immediate `appointment_rescheduled` notification communicates that change.

An appointment cancelled before processing is not claimed. If cancellation happens after a reminder was sent, the historical dispatch and notification remain; the existing immediate `appointment_cancelled` notification communicates the cancellation.

Do not delete dispatch history when appointments are rescheduled or cancelled.
