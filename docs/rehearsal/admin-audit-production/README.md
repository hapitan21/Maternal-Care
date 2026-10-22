# Production-shaped Audit Logs rehearsal (Checkpoint 2 recovery)

Package preparation and local repairs do not run database/container changes.
User-executed checkpoints are separate; the current bootstrap failure may have
occurred after its setup committed. This package is outside migration discovery.
The original production project and Maternal-Care-Staging are excluded.
Do not run the original repository's Supabase start/reset/migration/seed commands.
Do not remove the old staging test abort guard.

## Scope and prerequisites

Use a NEW official PostgreSQL container, no network, no ports, no host bind mounts,
new database name and random nonce. Docker must be a local Unix socket/named pipe.
No database URL, hosted project ref, password, production dump or existing volume
can be supplied to the runner. Images must already be cached and digest-pinned;
the runner never pulls an image. Both major and exact version are required through
--pg-major and --pg-version. Major-only and exact-version official postgres tags
are accepted, but an exact tag must match --pg-version. Before creation, read-only
image inspection must find the requested official repository digest, Linux image,
one matching PG_MAJOR, and one matching PG_VERSION. Debian package suffixes such as
17.6-2.pgdg13+1 are recognized; PostgreSQL 17.11 does not satisfy expected 17.6.
Missing, ambiguous, unexpected or uncached metadata fails before docker run.
Its acknowledgement strings are interlocks,
not permission: obtain explicit review approval before each execution checkpoint.

Docker CLI 29.8.2 and a Supabase launcher were found locally. Earlier daemon access
was denied; the exact-version continuation successfully performed read-only Docker
inspection through the available permission path. No containers were started or
removed. The protected r139-supabase-restore-v2, r139-sql-restore-test and
lucid_neumann containers were running and are not rehearsal targets.
psql/postgres/pg_dump/initdb were not found on PATH. Supabase's PowerShell launcher
was blocked by execution policy; its .cmd version check failed on a telemetry-file
permission error. No execution policy, installation or service was changed.

Production is verified as PostgreSQL 17.6 (170006). The selected cached image is:

`postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929`

Read-only inspection found PG_MAJOR=17 and PG_VERSION=17.6-2.pgdg13+1. The cached
postgres:17 digest 2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3
reports 17.11-1.pgdg13+2 and must fail when --pg-version is 17.6. No binary/container
execution was used to inspect versions. The SQL major-version guard is unchanged.
For any future baseline change, request approval for this SELECT-only inspection:

```sql
select current_setting('server_version'), current_setting('server_version_num');
```

This is a focused production-shaped baseline, not a full system/production clone:

- All FOUR public audit/Admin status function bodies match the production MD5s
  supplied as directly verified MATCH results. Their bodies are extracted unchanged.
- The audit table has the 15 repository columns/types, six validated constraints,
  an active-Admin SELECT policy, restricted table grants, and the existing named
  audit INSERT trigger. Schema/policy/helper DDL comes from the reviewed repository;
  confirm full installed constraint definitions, policy expressions, helper bodies,
  owners/ACLs and production major against the saved diagnostic results before
  calling this an exact production match. Four function hashes do not certify
  those other objects or production's unrelated triggers.
- profiles/patients are minimal synthetic support tables, not clinical schemas.
  No Auth users, patient records, device registrations or secrets are copied.
- auth.uid() reads a synthetic SQL claims GUC. realtime.send() records a private,
  transactional trace only. There is NO JWT validation, Auth server, PostgREST,
  Realtime authorization service, webhook, FCM or SMS integration in this container.
  The trace does not prove WebSocket delivery.

## Static review of the candidate

The local patch adds missing name/type checks for all 15 columns and a six-validated-
constraints guard. All four original body MD5, owner=postgres, SECURITY DEFINER,
empty search_path and content-CHECK guards remain. A mismatch is a STOP.
The CHECK changes only the recognized status array; its other predicates survive.
The internal writer is revoked from PUBLIC/anon/authenticated/service_role, and
effective inherited EXECUTE is checked. CREATE OR REPLACE preserves Admin RPC OIDs
and grants; their single literal audit call is replaced in pg_get_functiondef output.
Tests compare original arguments/defaults, owner/config/grants and exact body text
apart from that single replacement. Dynamic compilation has NOT yet been tested.

The whole candidate is one transaction. Audit INSERT failure must propagate through
the existing Admin RPC and undo its account changes. Audit broadcasting retains
its existing catch-and-warn behavior: a delivery failure must not undo an audit row.
Historical rows, RLS, grants and triggers are not rewritten. Old login/logout and
three report models retain the seven-argument UUID-returning RPC interface; client
reports become reported/client_reported and Admin status events remain authoritative
success/server_transaction. The viewer counts both statuses and supports the source.

ALTER CHECK requires a strong table lock and validation scan. lock_timeout=5s and
statement_timeout=30s cause failure/rollback rather than unlimited waiting. Use a
brief reviewed DDL/administrative-write quiet period for any eventual production
change; the hash preflight is not a lock against unrelated concurrent DDL. An
in-flight old Admin caller may be rejected by the restricted wrapper and roll back
safely. Observe timings during rehearsal; do not silently increase the timeouts.
This does not add deduplication, historical truth, or missing business audit coverage.

## One ordered execution procedure, divided at approval checkpoints

Run from the original maternal-app directory. Commands require their stated approvals.
For the existing Checkpoint 2 target, use its recovery path instead of repeating
container creation or bootstrap. Keep this same PowerShell session.

**Checkpoint 0: offline verification (already authorized and run).**

```powershell
node scripts/verify-admin-audit-rehearsal.mjs
node docs/rehearsal/admin-audit-production/run.mjs --check
```

**Checkpoint 1: approve the target, matching image/version, and container creation.**
Use the selected cached 17.6 image and a fresh nonce. If Docker access is unavailable,
stop for normal local permission review. If no matching cached image exists, stop for separate
image-download approval. No SQL is executed by create or pg_isready.

```powershell
$rehearsalRunner = (Resolve-Path 'docs/rehearsal/admin-audit-production/run.mjs').Path
$rehearsalNonce = [guid]::NewGuid().ToString('N')
$rehearsalMajor = '17'
$rehearsalVersion = '17.6'
$rehearsalImage = 'postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929'
$rehearsalArgs = @('--nonce',$rehearsalNonce,'--image',$rehearsalImage,'--pg-major',$rehearsalMajor,'--pg-version',$rehearsalVersion)
function Invoke-AuditRehearsal {
  param([string]$Phase,[string]$Acknowledgement)
  & node $rehearsalRunner $Phase @rehearsalArgs --approval $Acknowledgement
  if ($LASTEXITCODE -ne 0) { throw "STOP: rehearsal phase failed: $Phase" }
}
Invoke-AuditRehearsal create CREATE_ISOLATED_REHEARSAL
docker exec "mc-audit-rehearsal-$rehearsalNonce" pg_isready --host=/var/run/postgresql --username=postgres
if ($LASTEXITCODE -ne 0) { throw 'STOP: wait for readiness before requesting the next phase' }
```

**Checkpoint 2: approve synthetic baseline creation and rollback/failure trials.**
Review bootstrap.sql, guard.sql, migration.sql, tests.sql and catalog assertions.
The runner rejects a nonempty baseline and mismatched socket/database/nonce/version.
Do not point any frontend, phone or notification integration at this environment.
The bootstrap command below is ONLY for a never-initialized target. For the existing
mc-audit-rehearsal-ab53a2750d8e47fb9bb31b70f79a16ec target, follow the recovery
instructions immediately below instead; do not rerun bootstrap or Checkpoint 1.

```powershell
Invoke-AuditRehearsal bootstrap EXECUTE_SYNTHETIC_BASELINE
Invoke-AuditRehearsal rollback-trial EXECUTE_ROLLBACK_TRIAL
Invoke-AuditRehearsal guard-trial EXECUTE_GUARD_TRIAL
Invoke-AuditRehearsal failure-trial EXECUTE_FAILURE_TRIAL
Invoke-AuditRehearsal inspect INSPECT_ISOLATED_REHEARSAL
```

**Recovery from the confirmed `record "b" has no field "conname"` failure.**
bootstrap.sql commits before the runner appends baseline-check.sql. Its final
assertion failure therefore does not prove the synthetic setup was rolled back.
The repaired query uses saved_constraint as its SQL alias and retains every
constraint/function/history comparison. Do not initialize, remove or replace
the existing container, and do not assume it is intact without inspection.

Prepared commands only; this local repair did not run any database inspection or
trial. After approval for read-only inspection, use the EXISTING nonce explicitly:

```powershell
$resumeRunner = (Resolve-Path 'docs/rehearsal/admin-audit-production/run.mjs').Path
$resumeArgs = @('--nonce','ab53a2750d8e47fb9bb31b70f79a16ec',
  '--image','postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929',
  '--pg-major','17','--pg-version','17.6')
node $resumeRunner inspect @resumeArgs --approval INSPECT_ISOLATED_REHEARSAL
if ($LASTEXITCODE -ne 0) { throw 'STOP: existing rehearsal inspection failed' }
```

Confirm the identity/marker guard passes for database mc_audit_ab53a2750d8e, the four
original function hashes match, audit_logs has 15 columns and six validated
constraints, the original success/failure/rejected CHECK is present, the expected
RLS/grants/trigger are retained, the two synthetic historical rows are the only
audit rows, and the internal writer is absent. Unexpected or incomplete results
are a STOP; do not rerun bootstrap to repair them.

If inspection confirms the expected committed baseline, obtain/confirm approval
for the existing Checkpoint 2 trials, then resume WITHOUT bootstrap:

```powershell
node $resumeRunner rollback-trial @resumeArgs --approval EXECUTE_ROLLBACK_TRIAL
if ($LASTEXITCODE -ne 0) { throw 'STOP: rollback trial failed' }
node $resumeRunner guard-trial @resumeArgs --approval EXECUTE_GUARD_TRIAL
if ($LASTEXITCODE -ne 0) { throw 'STOP: guard trial failed' }
node $resumeRunner failure-trial @resumeArgs --approval EXECUTE_FAILURE_TRIAL
if ($LASTEXITCODE -ne 0) { throw 'STOP: late-failure trial failed' }
```

Each trial runs the corrected exact baseline comparison BEFORE the candidate's
BEGIN/DDL. It must verify the stored history, catalog, function bodies/security/
grants and all six constraint definitions; none is skipped because of the earlier
failure. The trials restore/recheck that baseline afterward. Stop at Checkpoint 3
for separate approval before any candidate COMMIT.

**Recovery from the confirmed rollback-trial `DO $status$` syntax failure.**
The PL/pgSQL IF-condition reader stops at a THEN outside parentheses. The bare
CASE in the account-status comparison exposed its inner THEN at that level,
truncating the condition before CASE was complete and producing the reported
end-of-input error. The test now assigns expected_status in a separate CASE
assignment (terminated by a semicolon), then compares the returned status with
that variable. PostgreSQL 17's [condition reader](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/pl/plpgsql/src/pl_gram.y#L2563)
explains the delimiter behavior. Existing comparison operators and all audit,
authorization, metadata, count and rollback assertions are preserved.

The target UUID CASE is also an assignment. The previous-status metadata CASE
is inside the parentheses of NOT EXISTS, so its THEN does not terminate the
outer IF condition. Neither expression needs changing for this failure.

The failed rollback-trial has no candidate COMMIT: ON_ERROR_STOP should close
the failed psql session and abort that transaction. Do not assume recovery until
read-only inspection confirms the original baseline. Reuse the fixed $resumeArgs
above for the existing container; do not rerun bootstrap or create a replacement.
After verifying rollback and confirming approval for the unfinished trials:

```powershell
node $resumeRunner rollback-trial @resumeArgs --approval EXECUTE_ROLLBACK_TRIAL
if ($LASTEXITCODE -ne 0) { throw 'STOP: corrected rollback trial failed' }
# Run these only if they do not already have a recorded PASS for this target.
node $resumeRunner guard-trial @resumeArgs --approval EXECUTE_GUARD_TRIAL
if ($LASTEXITCODE -ne 0) { throw 'STOP: guard trial failed' }
node $resumeRunner failure-trial @resumeArgs --approval EXECUTE_FAILURE_TRIAL
if ($LASTEXITCODE -ne 0) { throw 'STOP: late-failure trial failed' }
```

Stop on any unexpected state or error. Do not run apply/test or advance to
Checkpoint 3 as part of this recovery. This local repair executes no Docker SQL.

Expected: the full candidate and tests compile/run inside rollback-trial, then the
exact original catalog/history are restored. guard-trial resets the public writer's
search_path only inside a transaction; the unchanged preflight must reject it.
failure-trial raises an error after all migration DDL but before COMMIT. Each expected
failure closes its psql connection with ON_ERROR_STOP, then checks exact baseline
recovery in a fresh connection. Expected failures are PASS only when both the specific
error and complete recovery match. An unexpected error is FAIL; stop and preserve it.

**Checkpoint 3: approve candidate COMMIT only in this identified disposable container.**

```powershell
Invoke-AuditRehearsal apply APPLY_ISOLATED_CANDIDATE
Invoke-AuditRehearsal test EXECUTE_SYNTHETIC_TESTS
Invoke-AuditRehearsal inspect INSPECT_ISOLATED_REHEARSAL
```

apply uses migration.sql unchanged, preceded by identity/baseline checks. Post-check
failure after its COMMIT does NOT automatically undo that migration: stop and retain
the disposable target for diagnosis. test rolls back every test row/account change.
Final persistent history is the original two synthetic rows; the new internal writer
and expanded CHECK remain installed. inspect.sql provides catalog/count results.

The SQL assertions require: four-role own login/logout (including omitted logout
target), all nine Admin model/format report combinations, UUID receipts, rejection
of business claims/wrong targets/extra sensitive metadata/inactive or unauthenticated
callers, denied private-writer access (including service_role), non-Admin RLS-empty
reads, and denied ordinary INSERT/UPDATE/DELETE/TRUNCATE. Six valid account transitions
must produce six success/server_transaction events. No-op transitions, outer rollback,
and a temporary audit-INSERT CHECK failure must leave no committed success and no
changed account. History, constraints, table/column grants, RLS and trigger signatures
must match the captured baseline, except the intended CHECK and function changes.

**Checkpoint 4: separately approve a NEW local Supabase gateway test target.**
This is still a release gate, not simulated by the preceding SQL. Never reuse
Maternal-Care-Staging. Use a fresh work directory/config, no repository migrations
or seeds, new local Auth/signing keys and synthetic accounts only. Review a public-
schema-only adaptation of this baseline that keeps the REAL auth.uid(), roles and
realtime.send(); bootstrap.sql deliberately refuses an existing Supabase schema and
must NOT be edited to force it through. Reconfirm the four hashes, 15 columns, six
constraints, grants and trigger before applying the same candidate there.

Use the new local Auth service/Admin API to create Admin/Doctor/Staff/Patient users;
link their returned UUIDs to synthetic profiles/patient records as appropriate.
Sign in normally, obtain genuine access tokens in memory, and test the existing RPC
through /rest/v1/rpc/record_audit_event with the exact current frontend payloads.
SQL GUC impersonation and a manually edited exp claim do not test the gateway.

Before any HTTP request, independently verify that the approved local stack and its
database marker match the reviewed nonce. Refuse hosted URLs and HTTP redirects:

```powershell
# Only after the separately reviewed fresh local Supabase target exists.
$jwtBase = [uri](Read-Host 'Approved new LOCAL Supabase URL')
if ($jwtBase.Scheme -ne 'http' -or $jwtBase.Host -notin @('127.0.0.1','localhost','[::1]') -or $jwtBase.UserInfo -or $jwtBase.Query -or $jwtBase.Fragment) {
  throw 'STOP: only the approved local gateway is permitted'
}
# Populate these in memory from that local target; never use production keys/tokens.
# $localAnonKey, $localAdminToken, $localAdminId
$jwtHeaders = @{apikey=$localAnonKey;Authorization="Bearer $localAdminToken"}
$jwtBody = @{p_module='authentication';p_action='login';p_entity_type='auth_user';
  p_entity_id=$localAdminId;p_description='Synthetic local gateway login.';p_metadata=@{}} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$($jwtBase.AbsoluteUri.TrimEnd('/'))/rest/v1/rpc/record_audit_event" `
  -Headers $jwtHeaders -ContentType 'application/json' -Body $jwtBody -MaximumRedirection 0 -TimeoutSec 10
```

Repeat the prepared test matrix with each real role token: own login/logout PASS;
Admin PDF/Excel/print PASS; non-Admin reports and all forged clinical/appointment/
patient/settings claims denied with no row. Wrong-user targets and sensitive metadata
must fail. Missing bearer uses only the local anon key and must fail. Obtain a genuinely
expired synthetic JWT (wait for the approved local expiry); invalid signature/expired
tokens must be rejected by the gateway, usually 401, independently of SQL role tests.
The ungranted internal RPC must not execute (a hidden/not-found endpoint is acceptable).
Check Admin-only inbox reads and no cached Admin rows after sign-out/account switching.
Capture sanitized HTTP status/code/count, not tokens. Any 2xx receipt must be checked
as reported/client_reported, not business proof. Finally verify active-Admin private
Broadcast receive and non-Admin denial with real JWT renewal/reconnect; confirm the
publisher event/topic/private flag and manual Refresh. Do not send external notifications.

The gateway/public-baseline adaptation and local stack configuration need review
against the available Supabase version before this checkpoint can execute. They are
not certified by this PostgreSQL-only package or an SQL Editor role switch.

## Rollback, recovery and release decision

An error before candidate COMMIT aborts its entire transaction; the runner closes
the failed psql process, so no open transaction is reused. guard-trial/failure-trial
verify the restored originals and history in a fresh connection. A failed rollback
assertion is a stop condition. Do not continue on the same uncertain target.

After an intentionally committed rehearsal, prefer a separately approved NEW nonce/
container and replay the sealed synthetic baseline to recover/repeat. Preserve the
old container/logs for review; no automatic drop, cleanup, backup restoration or
history deletion is supplied. This avoids inventing a production down migration.
Restoring the broad writer in production would reopen the security issue. Any real
production recovery must be separately approved from its exact saved definitions,
owners/ACLs/constraints/trigger snapshot. Do not shrink the status CHECK when reported
rows exist; never delete/relabel audit history to make rollback pass.

Only consider production after all approved SQL trials AND real Supabase gateway/
Realtime checks pass, the saved installed baseline matches, and a timed lock/recovery
plan is reviewed. No production/staging execution or deployment is authorized here.

## Actual offline verification

- `node scripts/verify-admin-audit-rehearsal.mjs`: 129 assertions PASS, 0 failures
  after the status-CASE repair. Includes the original alias and CASE failures as
  negative controls, expected-status assignment/comparison checks, scoped alias
  checks, retained constraint predicates/baseline order, and image safeguards.
- `node docs/rehearsal/admin-audit-production/run.mjs --check`: sealed SQL/runner
  hashes PASS, with no Docker/SQL action.
- `node scripts/verify-admin-audit.mjs`: 50 scenarios / 251 assertions PASS.
- `node scripts/verify-admin-audit-viewer-ui.mjs`: 22 assertions / four viewports
  PASS, using synthetic data and blocked external HTTP.
- Scoped ESLint for the three new .mjs files (Node globals/recommended rules),
  three Node syntax checks, JSX parsing through the existing tests and
  `git diff --check` PASS. No app source changed; a web/Android build was not needed.

This local repair inspected SQL structurally only and did not rerun the reported
PostgreSQL failure. Full compilation, permission/RLS, dynamic replacement, locking,
transactional and gateway/Realtime verification are not certified by offline tests;
the remaining trials still require approval and successful execution.

The exact-image continuation changed only the runner, its focused tests, this README
and the runner hash in manifest.json. Resealing first verified every SQL hash was
unchanged, then the existing prepare script's --seal and runner's --check verified
the resulting manifest. No SQL fixtures, migration, authorization tests or expected
production function hashes changed. Separate approval is still required before
Checkpoint 1 creates any container; all later approval checkpoints remain in place.

The subsequent baseline-alias repair changed only baseline-check.sql, its focused
regression checks, this README and that SQL file's manifest hash. Only the SQL
constraint snapshot alias and its three field references changed in baseline-check.sql;
the function loop and all rollback comparisons remain. Other SQL and runner hashes
were verified unchanged before resealing. No additional declared-variable/relation-
alias collision was found in the other rehearsal scripts. PostgreSQL execution of
the repair is pending: local tests are static/offline and do not certify compilation.
The existing mc-audit-rehearsal-ab53a2750d8e47fb9bb31b70f79a16ec container was not
accessed or modified during this repair.

The later status-CASE repair changed only tests.sql, its focused offline checks,
this README and that test file's manifest hash. Only the expected-status declaration,
assignment and response comparison changed in tests.sql; other blocks, assertions
and fixtures are unchanged. No Docker/container operation, SQL execution or database
rollback inspection was performed by this local repair. Full PostgreSQL compilation
of the corrected trial remains pending approval and execution on the existing target.
