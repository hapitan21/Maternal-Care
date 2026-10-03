# Phase 8C native push stale-processing terminal recovery

Baseline: 878e1e8. Local implementation only; no production operation is authorized.
One new migration: 20261003150000_patient_native_push_stale_processing_recovery.sql.

The supplied production audit found zero processing rows. Its 44 successful rows
had p50 approximately 0.136506s, p95 0.2181821s, p99 0.23810557s and maximum
0.238579s. This capability is preventive hardening, not incident repair.

## Meaning and preserved evidence

Delivery_unknown DOES NOT mean delivery failed. It means the provider delivery
outcome could not be proven after the processing claim became stale. Operations
must not manually resend solely because this status appears. Claim-before-send,
network ambiguity, accepted-send-before-finalization and memory-only rejection
all become the same terminal unknown after the reviewed threshold.

The recovery function uses attempted_at <= clock_timestamp() - interval '10 minutes',
including the exact boundary. It never bases age on created_at, updated_at or a
retry deadline. It orders by attempted_at/id, locks at most fifty rows with
FOR UPDATE SKIP LOCKED, and rechecks status and wall-clock age under each lock.
Its integer return is the number of terminal transitions.

It sets only status=delivery_unknown, next_attempt_at=NULL, recovery_at and
recovery_reason=stale_processing_unknown_outcome. The existing updated_at trigger
still runs. IDs, attempt count, claim token, attempted_at, created_at, sent_at,
FCM/error/provider metadata and last_failure_class are preserved. NULL failure
class remains NULL; stronger historical evidence is not replaced. Devices and
notifications are never updated. No provider/network operation occurs.

The new status CHECK preserves all four old statuses. Failure-class and sent-state
checks are extended only for delivery_unknown so historical evidence can remain.
Two nullable recovery columns and a narrowly scoped processing index
(attempted_at,id) support inspection and bounded sweeps. Recovery metadata is
required only for delivery_unknown; every other state retains NULL recovery fields.

## Installation and privilege boundary

Preflight checks required ledger types/nullability, status and attempt constraints,
occurrence uniqueness, Phase 8B result/deadline checks, RLS/grants, the reviewed
claim/list/finalizer bodies, argument names/defaults, volatility, search path and
updated_at trigger. Catalog expression hashes retain boolean grouping and quoted
literals; RPC body hashes normalize only CRLF. Cosmetic RPC-body changes may fail
closed and require review rather than being silently overwritten.

No old migration or Phase 8B RPC is replaced. Initial claims remain insert-only;
retry claims/discovery remain confirmed-transient failed-only, four total attempts
and thirty minutes from original creation. Firebase classification, payload,
backoff, retry credentials and retry cron remain unchanged. Recovery does not
rotate the current fence or grant direct ledger writes. Only postgres can execute
the recovery function; PUBLIC/anon/authenticated/service_role cannot.

The migration installs capability without executing recovery or modifying old rows.
A late fenced finalizer already returns already_finalized when a row is unknown,
before any cleanup. The helper now acknowledges that result as skipped and emits
only delivery_unknown_acknowledged. It does not retry finalization or send again.
The existing Edge Function aggregates skipped without a handler change.

## Inactive scheduler and later activation

On pg_cron with schedule(text,text,text) and
alter_job(bigint,text,text,text,text,boolean), the migration schedules the new job
captures the assigned username, then sets only active=false in the SAME
transaction and verifies that username remains unchanged. No active
job is visible after commit. This was tested with real pg_cron 1.6.4 in the
Supabase PostgreSQL 17.6.1.104 image. Catalog capability checks run at deployment;
this is not a claim about a separately inspected production extension version.
If inactive creation is unsupported, no recovery job is created.

The job is patient-native-push-stale-recovery, once per minute, with command:
select public.recover_stale_patient_native_push_deliveries();
The existing patient-native-push-retry-tick row is preserved exactly.

Before production activation, separately approve and verify the migration and
deploy the compatible sender helper. Neither operation is authorized in this pass.
After that verification, inspect without secrets:

    select jobid,jobname,schedule,database,username,active
    from cron.job where jobname='patient-native-push-stale-recovery';

Run the activation as the role that owns the scheduled job; the guard compares
its username with current_user, without changing ownership.
The exact later activation step below requires separate approval. It was tested
only inside a rolled-back disposable-database transaction; it was NOT run on
production. If no inactive job exists, stop and review the target cron capability
rather than creating an active job through an untested fallback.

    DO $activate$
    DECLARE v_job record;
    BEGIN
      SELECT * INTO STRICT v_job FROM cron.job WHERE jobname='patient-native-push-stale-recovery';
      IF v_job.database<>current_database() OR v_job.username<>current_user OR v_job.active
         OR v_job.schedule<>'* * * * *'
         OR v_job.command<>'select public.recover_stale_patient_native_push_deliveries();' THEN
        RAISE EXCEPTION 'Recovery cron configuration differs from reviewed inactive job.';
      END IF;
      PERFORM cron.alter_job(v_job.jobid,active:=true);
    END;
    $activate$;

## Durable local tests

Run focused actual-helper/actual-sender tests and source-bound fault models:

    node scripts/verify-patient-native-push-stale-recovery.mjs

Run compatibility, including existing Firebase and helper cases:

    node scripts/verify-patient-native-push-lifecycle.mjs
    node scripts/verify-patient-native-push-navigation.mjs
    node scripts/verify-patient-native-push-retry-sql.mjs

The Phase 8C source verifier pins the reviewed Phase 8B migration, Firebase helper
and sender so protected behavior cannot change silently. Models are explicitly
labelled; they are not PostgreSQL concurrency evidence.

For real serial contracts, nine overlapping-session races and full-migration
preflight rollback cases, use the existing Docker runtime/image. No application
migration chain, supabase start, global psql, package installation, production
credentials, published port or persistent volume is required:

    $testDocker = "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin\docker.exe"
    $env:NATIVE_PUSH_STALE_TEST_CONTAINER = 'maternal-native-stale-20261003-local'
    & $testDocker run --detach --name $env:NATIVE_PUSH_STALE_TEST_CONTAINER --tmpfs /var/lib/postgresql/data:rw -e PGDATA=/var/lib/postgresql/data -e POSTGRES_PASSWORD=stale-local-only -e POSTGRES_DB=maternal_native_push_stale_test public.ecr.aws/supabase/postgres:17.6.1.104 postgres -D /var/lib/postgresql/data -c config_file=/etc/postgresql/postgresql.conf -c hba_file=/var/lib/postgresql/data/pg_hba.conf -c cron.database_name=maternal_native_push_stale_test -c cron.launch_active_jobs=off -c listen_addresses=127.0.0.1
    & $testDocker exec $env:NATIVE_PUSH_STALE_TEST_CONTAINER pg_isready -h /var/run/postgresql -U supabase_admin -d maternal_native_push_stale_test
    node scripts/verify-patient-native-push-stale-recovery.mjs --postgres
    & $testDocker rm --force $env:NATIVE_PUSH_STALE_TEST_CONTAINER

The fixture refuses a nonempty application schema, other database names and hosts.
It installs real pg_cron but disables autonomous job execution for determinism;
net.http_post is an offline recorder. Real locks, actual RPCs, exact migration
preflight and inactive scheduling execute. Backend PIDs opened by the runner are
explicitly terminated in that dedicated DB, including on failure.

Boundary/history tests include a synthetic damaged-history case AFTER successful
preflight. Processing with non-NULL sent_at/failure_class violates reviewed Phase
8B checks, so those two checks are temporarily removed only in this isolated test,
the evidence is injected, recovery runs, and both exact checks are restored and
validated. Deployment preflight is never weakened. Normal valid history is also
snapshotted byte-for-byte across installation and recovery.

The nine races cover locked live processing; recovery before late success;
recovery before late permanent cleanup; finalization first; overlapping recovery
workers; retry versus recovery; a wrong old fence; concurrent device rotation;
and concurrent disable. Actual lock conflicts/waiters prove overlap.

## Limits

This is terminal resolution, not lease reclaim or provider idempotency. It cannot
prove delivery or stop a provider request already in flight. It prevents automatic
replay and late database overwrite. The ten-minute policy is separately reviewed;
no send-start marker, lease model or attempt-history table is introduced.
Activation remains a separate production approval step. No db push, deployment,
production mutation, commit or push is part of this implementation pass.

## Local validation result

Validated with the disposable Supabase PostgreSQL 17.6.1.104 image:

- Focused Phase 8C helper/sender/model safeguards: 15 passing.
- Real SQL contracts: 38 passing.
- Real overlapping-session concurrency scenarios: 9 passing.
- Full-migration preflight failure/rollback cases: 15 passing.
- Unsupported inactive-scheduler capability fallback: 1 passing.
- Actual NOSUPERUSER scheduler creation/disable/commit with unchanged username:
  1 passing; an independent connection sees no committed active job.
- Owner-only activation without username mutation: passing inside a rolled-back
  local non-superuser transaction.
- Documented guarded activation: passing inside a rolled-back local transaction.
- Full lifecycle suite, including Firebase and existing helper tests: 278 safeguards,
  zero known defects and zero unexpected failures.
- Native navigation: 121 passing scenarios.
- Phase 8B retry verifier: static contracts and five orchestration cases passing.
  Its separate real SQL suite was not rerun; Phase 8C tests execute the actual
  Phase 8B migration and RPCs in real PostgreSQL.
- Focused ESLint: passing. Node scripts use Node runtime globals; TypeScript helper
  files are transpiled with the installed Vite/Oxc before ESLint because the
  repository ESLint configuration has no TypeScript parser. No package or
  configuration change was needed.
- npm run build: passing; existing large-chunk/plugin-timing warnings remain.
- git diff --check: passing.

The disposable container is removed after validation. No production connection,
Supabase start, db push, deployment, secret change, commit or push was performed.

## Production pg_cron permission correction

The production attempt failed transactionally because cron.alter_job with an
explicit username requires superuser privileges, even when requesting postgres.
The migration now captures the username assigned by cron.schedule and changes
only active=false. Verification requires the exact ID/name, database, schedule,
command, inactive state and unchanged assigned username. No recovery privileges
are broadened. The local regression executes the actual scheduler block under a
NOSUPERUSER role with cron job ownership permissions, observes it from an
independent connection before and after commit, and checks that no active job is
committed. The unsupported-capability fallback remains covered.
