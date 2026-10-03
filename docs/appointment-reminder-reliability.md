# Appointment reminder reliability

Baseline: 7425851. Local implementation only; no production change, deployment,
commit or push. One new migration: 20261003140000_appointment_reminder_reliability.sql.

## Deployed baseline

The full processor and Staff/Doctor/Admin writer were reconstructed from the supplied
production pg_get_functiondef() bodies. The older automatic-only HEAD script was not
used. The exact supplied bodies are retained as a local test fixture at
supabase/tests/fixtures/appointment_reminder_deployed_baseline.sql.
The source verifier compares the entire automatic fallback block and the configured
notification INSERT to those bodies. Both remain byte-identical.

## Backend contract

- Preflight verifies validated, single-status-column catalog expressions and exact
  state sets: reminders pending/sent/completed/cancelled, dispatches
  processing/created/skipped/failed. It ignores state order, whitespace, parentheses
  and text casts while rejecting additional predicates or missing/extra states.
  The dispatch constraint is asserted without modification.
- reminders_valid_status permits pending, sent, completed, cancelled and expired.
  No table, RLS, index, native-push, medication or SMS-bridge redesign is included.
- A privileged trigger validates appointment INSERTs and actual user scheduling
  changes to remind_at, schedule_id or reminder_type.
  It locks the current appointment and uses clock_timestamp() for strictly future
  time and a minimum ten-minute lead. Exactly ten minutes is valid.
- Creation/user scheduling initializes next_trigger_at to the chosen remind_at.
  Status-only, sent_at and processor next_trigger_at advancement updates do not
  revalidate historical remind_at values. Repeat-mode/repeat-until-only edits also
  preserve progressed next_trigger_at and sent_at, even with a historical origin.
- The RPC retains auth.uid(), the existing Staff/Doctor/Admin role gate, title/message,
  appointment locking, existing-row return and unique-conflict behavior.
  Existing reminders return before timing validation, including old reminders.
- RPC 24h/1h slots are unchanged. The old now() fallback cannot satisfy strictly
  future time when the trigger checks the wall clock. Its replacement is the latest
  valid future slot, appointment start minus ten minutes. Exactly ten minutes of
  remaining time leaves NO strictly future valid slot and is therefore rejected,
  as are closer/already-started appointments. This intentionally changes short-lead
  creation timing while preserving the authoritative rule.

## Processor, expiry and counters

The five-column return signature and SECURITY DEFINER/empty search path are preserved.
Runtime expiry and configured processing use the same reminder row locks with
SKIP LOCKED and bounded batches of 200. Fresh nonblocking appointment/Patient locks
avoid waiting behind a reschedule while holding a reminder lock; busy rows wait for a
later invocation. Eligible appointment statuses and linked/active/nonarchived Patient
requirements remain unchanged.

Pending configured reminders past start expire with next_trigger_at NULL, preserving
sent_at. Unclaimed expiry creates no dispatch, Patient notification, SMS or native enqueue.
Reconciliation increments examined and skipped, never claimed or notifications_created.

The fresh pre-notification check also handles real claims delayed across start:
the existing claim becomes skipped with appointment_started_before_notification,
and its reminder expires. Cancellation/completion resolves the claim as skipped without
notification. A post-INSERT clock check rolls back the notification subtransaction and
its transactional enqueues if insertion itself crossed start, then resolves the real claim.
Original scheduled_for is never replaced by execution time.

Configured occurrence identity remains (reminder_id, scheduled_for). Failed configured
claims retain their deployed failed-only recovery; created/processing claims are not
reclaimed. Current processing/created claims with inconsistent pending reminder state
remain for explicit review, rather than being labeled never delivered. Runtime expiry
may terminate a past-cutoff failed occurrence without changing its failed ledger history.

Hourly/daily processing creates at most one catch-up, then advances past missed slots
until the next slot is future. It stops at appointment start or repeat_until, preserving
normal sent terminal behavior after a successful final occurrence. A pending repeat
missed at cutoff expires while retaining any earlier sent_at.

## Historical repair and cron

The migration reconciles at most 200 due, pending, overdue appointment reminders with
NO dispatch history. It clears next_trigger_at and preserves sent_at, creates no delivery
artifacts, and is idempotent. No fixed count of four is embedded. ANY historical dispatch
history is left unchanged by the one-time repair; ambiguous cases need explicit review.

The migration locates exactly one process-due-appointment-reminders job by name,
validates its database, active flag, reviewed command and cadence, and uses cron.alter_job
to change only its schedule to * * * * *. It never schedules or unschedules a job.
Missing/duplicate/changed metadata fails and rolls back the complete transaction.
The ALTER TABLE constraint operation holds a schema lock during the migration; deployment
must be reviewed and separately approved.

Automatic 24h (23h55m–24h) and 2h (1h55m–2h) fallback windows remain unchanged.
Their (schedule_id, reminder_offset_minutes) claim suppresses duplicate evaluation under
one-minute cron. ANY configured appointment reminder, including expired, still suppresses
fallback. The existing created-only SMS trigger is unchanged.

## Preserved frontend

The existing compact Doctor form guidance, strictly future/ten-minute validation,
explicit UTC+08 custom conversion and absolute preset offsets are retained.
Patient statuses explicitly map Pending, Sent, Completed, Cancelled and Expired; unknown
status is Unavailable. Elapsed time never implies Sent. Expired/terminal/post-start local
appointment notifications are excluded. Medication handling is unchanged.

## Local validation

- Reminder JS/unit/source suite: 34 passed (the existing 33 plus deployed SQL parity).
- Real PostgreSQL serial contracts: 100 assertions passed, including repeat-only
  historical edits, true rescheduling and unchanged dispatch-constraint checks.
- Real two-session cases: six passed (competing processors, expiry wins, pre-cutoff
  delivery wins, cancellation, completion, reschedule).
- Status preflight rollback cases: five passed (extra reminder state, reminder
  predicate drift, missing dispatch constraint, extra dispatch state, missing skipped).
- Cron rollback cases: three passed (missing job, duplicate identity, changed command).
  Every failure compares full function/constraint/column/trigger/cron/data snapshots.
  Reapplication tests reconstruct the four-state baseline inside rollback transactions;
  the installed five-state schema is deliberately rejected as a pre-migration baseline.
- Native lifecycle: 263 safeguards, zero known defects/unexpected failures.
- Native navigation: 121 passed.
- Phase 8B source verifier and five orchestration checks: passed. The unrelated Phase 8B
  real SQL suite was not rerun in this reminder fixture.
- Focused ESLint: passed, including the new .mjs runner via the project's JS rules.
- npm run build: passed; existing large-chunk and plugin-timing warnings remain.
- Full-project lint's prior 3,529 generated-Android errors/two warnings remain unrelated;
  no lint configuration or Android files changed.
- git diff --check and new-file trailing-whitespace checks: passed.

Commands:

    node --test scripts/verify-appointment-reminder-reliability.js
    node scripts/verify-appointment-reminder-sql.mjs
    node node_modules/eslint/bin/eslint.js src/lib/appointmentReminder.js src/pages/doctor/Doctor_Reminder.jsx src/pages/patient/Patient_PWA_Reminder.jsx scripts/verify-appointment-reminder-reliability.js
    Get-Content -Raw scripts/verify-appointment-reminder-sql.mjs | node node_modules/eslint/bin/eslint.js --stdin --stdin-filename scripts/verify-appointment-reminder-sql.js
    npm run build
    node scripts/verify-patient-native-push-lifecycle.mjs
    node scripts/verify-patient-native-push-navigation.mjs
    node scripts/verify-patient-native-push-retry-sql.mjs
    git diff --check

## Repeatable disposable PostgreSQL run (PowerShell)

Use the already-downloaded image and a fresh unique container name. No published port,
repository mount or persistent volume is needed. The fixture requires an empty application
schema and refuses other database names/hosts. Do not run supabase start or db push.

    $testDocker = "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin\docker.exe"
    $env:APPOINTMENT_REMINDER_TEST_CONTAINER = 'maternal-reminder-reliability-20261003-4e7b'
    & $testDocker run --detach --name $env:APPOINTMENT_REMINDER_TEST_CONTAINER --tmpfs /var/lib/postgresql/data:rw -e PGDATA=/var/lib/postgresql/data -e POSTGRES_PASSWORD=reminder-local-only -e POSTGRES_DB=maternal_appointment_reminder_test public.ecr.aws/supabase/postgres:17.6.1.104 postgres -D /var/lib/postgresql/data -c config_file=/etc/postgresql/postgresql.conf -c hba_file=/var/lib/postgresql/data/pg_hba.conf -c cron.database_name=maternal_appointment_reminder_test -c cron.launch_active_jobs=off -c listen_addresses=127.0.0.1
    & $testDocker exec $env:APPOINTMENT_REMINDER_TEST_CONTAINER pg_isready -h /var/run/postgresql -U supabase_admin -d maternal_appointment_reminder_test
    node scripts/verify-appointment-reminder-sql.mjs --postgres
    & $testDocker rm --force $env:APPOINTMENT_REMINDER_TEST_CONTAINER

The native image configuration supplies Vault crypto preloads/key-script support.
initdb's local hba file permits the container-local test administrative role. No production
credentials are loaded. Autonomous cron execution is disabled only for deterministic tests;
real pg_cron metadata/alter_job execute and are checked. Vault entries are synthetic and
local; HTTP/native transports are transactional offline recorders, not Android/FCM/SMS
sends. Only the migration/fixture/bridge files are copied into the container.

The runner uses docker exec psql, so Windows psql is unnecessary. It proves lock overlap
with actual NOWAIT row-lock conflicts, uses unique invocation markers, and explicitly
cleans up only its own backend PIDs. The disposable container is removed after validation.

All requested local checks pass. READY FOR REVIEW; deployment and physical verification
remain separate steps. Native transport can still arrive later under its unchanged retry
contract; this fix controls appointment reminder creation rather than end-to-end delivery.
