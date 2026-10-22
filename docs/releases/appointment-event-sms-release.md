# Controlled appointment-event SMS — approval packet

Local preparation, October 19, 2026; branch release/maternal-care-oct23-2026,
HEAD bd3e839. No database/Vault changes, Docker mutations, deployment or real SMS.

## Reviewed artifacts

Run `node scripts/prepare-appointment-sms-release.mjs --prepare` to make a NEW
temporary packet, or `--check <packet>` to verify an existing one. It copies only:

- process-appointment-sms/index.ts and deno.json;
- send-notification-sms/index.ts and deno.json;
- _shared/appointmentSms.ts, appointmentEventSmsControl.ts, iprogSms.ts,
  semaphoreSms.ts, smsTransportReservation.ts, supabaseSecretAuth.ts;
- a generated minimal supabase/config.toml for ONLY the two target functions;
- the unchanged helper draft at review-only/appointment-event-sms-control.sql.

All function paths above are under supabase/functions. The twelve SHA-256-sealed
files plus release-manifest.json contain no runtime credentials. SQL is outside
supabase/migrations and never auto-applied. No Admin Audit, Android, frontend,
medication orchestrator or unrelated migration is included. The direct SDK import
is pinned to npm:@supabase/supabase-js@2.105.3 in both function-specific deno.json files.
Record the manifest SHA-256 independently at approval; a self-consistent manifest
alone is not a signature. No deployment mode exists in the preparation scripts.

The transport imports the event-control, IPROG, phone-normalization, reservation and
secret-auth modules. The appointment orchestrator imports appointmentSms and
secret-auth, claims through claim_notification_dispatch, then calls the transport.
Both function bundles must include their imports; shared modules are not deployed
as independent functions. Deploy ONLY the named functions, never all functions or
--prune. Keep process-medication-sms and both reminder bridge flags unchanged.

## Verification performed and remaining gate

- Node adapter: 220 tests, 19 SQL/source assertions, 66 frontend contract assertions;
  zero failures and zero live-network attempts.
- Native Deno 2.9.7: all 220 tests passed (209 existing + 11 new in separate runs)
  WITH type checking, cached-only dependencies,
  real network/environment access denied and only local fixture reads allowed.
  Both actual deployment entrypoints passed native cached-only type checks. Deno
  lint passed for eight runtime TypeScript files and three focused test files.
- One test-only TS2367 issue was corrected: fixture-ID distinctness now uses Set
  cardinality, preserving its assertion. No runtime SMS logic was changed here.
- Eleven additional mocked tests execute the actual appointment Edge handler:
  missing/invalid JWT, Patient, inactive Staff, foreign Doctor, user reminder,
  wrong/server secret, stored Patient authority, concurrent claims and uncertain
  transport. These extend, rather than substitute for, the PostgreSQL/JWT gate.
- Staff approval mocks: 35 scenarios / 247 assertions passed. Actual clinical form
  browser fixture: 409 save/Router/toast/scroll assertions passed at 320/390/768/1366px
  with synthetic backend. These do not establish production DB or FCM delivery.
- Coverage includes confirmation/accepted requests, persisted old/new reschedule
  times, cancellation, ASCII Manila formatting, wrong/unknown types, control true/
  false/missing/invalid/read-error, concurrent reservations, queued OFF after reserve,
  suppression-write failure, uncertain provider outcomes, historical rows, and both
  unchanged reminder types. One mock provider attempt means neither real sending
  nor handset delivery.

Docker read-only inspection confirmed the healthy d9849de6496a4b16a651a9b359a0db3e
audit CP4 stack at 127.0.0.1:55421 and the older protected stacks. None is verified
or authorized as an SMS fixture. No SQL was executed in any of them. Host psql was
not found. Genuine PostgreSQL helper/grant and real service-role PostgREST checks
remain UNVERIFIED; Docker availability does not authorize changing an audit database.
The normal sandbox Deno alias was unusable; permitted execution of its resolved
installed binary succeeded. Normal-context CLI --version hit an access-denied
telemetry write; package metadata pins 2.119.0, but CLI execution must be verified
under the normal approved Windows identity. Do not reset ACLs or update the CLI.

## Isolated SQL/transport rehearsal — separate approval required

Use a separately approved SMS-only disposable Supabase target or new explicitly
approved local fixture; verify project/database identity, native Vault availability,
versions, schemas, roles, grants, source RPC definitions and disabled outgoing hooks
BEFORE changes. Do not infer parity from the audit CP4 setup or reuse its database.
No production users, phones, credentials or dispatch history may be copied.

Install the reviewed helper only there after approval. Exercise actual Vault-backed
settings absent, false, exact true, invalid/case/whitespace values, duplicates if the
installed uniqueness constraint permits, and controlled read denial/failure. Verify
postgres owner, SECURITY DEFINER, empty search_path, scalar boolean, service_role
EXECUTE and effective anon/authenticated denial (not just missing API visibility).
Run a separate post-install PostgREST check using a real isolated service credential;
anon, Patient, Staff, Doctor and Admin JWTs must not invoke this helper.

Use synthetic appointments, real isolated claim/retry RPCs, actual uniqueness and
CAS updates, mocked IPROG transport with outbound access blocked, and fake provider
credentials. Check all three event templates, accepted versus pending/declined,
immutable reschedule ownership, duplicate keys/concurrent requests, cancelled keys
not reclaimable, processing/provider reservation ownership, and provider acceptance
followed by failed ledger persistence. OFF before either guard must prevent provider
calls; ON then OFF during lookup must suppress. Test both known reminder types
without reading the new switch; do not activate their database bridges. Reject
Patient/missing/inactive/foreign-Doctor callers to the appointment orchestrator,
wrong server credentials at raw transport, and client-body attempts to override
the persisted type/Patient/provider/control. Only actual installed authorization
checks, not a source inventory or mock, can close this gate.

## Production sequence — each phase requires approval

1. **Read-only inventory and rollback baseline.** Manually review
   ../sql-drafts/appointment-event-sms-release-preflight.sql in the ORIGINAL project.
   It returns no Vault values, phone numbers, patient rows or provider receipt URLs.
   Verify helper-name availability, Vault view/owner access, claim/retry bodies and
   grants, source ownership guards, unique dispatch key, processing/cancelled status,
   reservation columns and unchanged updated_at trigger. Inventory every persisted
   SMS type: the new transport refuses unknown types. Review unreserved/reserved
   processing rows, pg_net/Edge in-flight work and old workers. Capture current
   deployed versions privately outside the dirty repository before deployment.

2. **Approve helper installation ONLY, with switch absent or false.** Review the
   exact sealed SQL draft; it creates one service-only reader, creates no Vault entry
   and changes no tables/RLS/bridges. A name collision is a STOP, not permission to
   replace another function. Both reminder bridges stay absent/false. Verify native
   grants and service-role RPC resolves false through PostgREST before proceeding.
   If schema-cache visibility needs a standard reload, approve that separately;
   never widen permissions or interpret a missing RPC as an enabled setting.

3. **Approve guarded transport deployment first.** Use the explicit project ref and
   isolated packet below. Preserve the existing verify_jwt=false configuration because
   the function verifies the server secret itself; the appointment function verifies
   authenticated user JWTs/roles/ownership internally. Neither accepts public sending.
   Wait for deployed-version verification and the disabled-state gate before phase 4.
   An already-running OLD transport may still send; OFF cannot control that version.

4. **Approve process-appointment-sms deployment second.** Include appointmentSms,
   ASCII formatting, event templates and secret-auth dependencies. Keep transport
   guard and all switches OFF. No frontend, FCM, Android or medication-function deploy.

5. **Approve disabled-state smoke tests separately.** First complete isolated tests
   with mock transport and zero real provider calls. For any approved production
   smoke use only an explicitly authorized synthetic dispatch/Patient; a missing or
   invalid phone adds a provider safety barrier, but require status=cancelled and
   last_error=appointment_event_sms_disabled BEFORE phone validation, not merely
   absence of a message. Inspect versioned execution evidence without printing keys.
   Require normal Staff/Doctor persistence, in-app notification and FCM checks using
   approved test workflows; do not infer handset delivery from mocked frontend tests.
   No synthetic production mutation or real push is authorized by this document.

6. **Controlled activation is a separate approval.** Authorize exact test phone,
   synthetic Patient, future event and maintenance/traffic window. This is a GLOBAL
   event switch, not a recipient allowlist: other users' events can send while ON.
   No exactly-one-recipient test is safe until concurrent traffic and old/unreserved
   event requests are controlled. Unknown outstanding work is a NO-GO. Enable only
   appointment_event_sms_enabled after approval, issue one new authorized event,
   check one claim/reservation/provider acceptance and phone receipt, then return
   event control OFF with approval and verify. Keep both reminder bridges OFF.
   Test other templates in isolated mocks first; real additional SMS needs approval.

## Exact deployment commands — REVIEW ONLY, NOT EXECUTED

These require the phase-specific approvals above. Do not run the block wholesale.
The packet created in this preparation is shown below; for a regenerated packet,
review and substitute its NEW path and independently approved manifest hash.

```powershell
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$packet = 'C:\Users\JAMESF~1\AppData\Local\Temp\maternal-sms-release-da4XtY'
$approvedManifestHash = '39508bf309abd47633fb3ef6c1c2b357bda555dd40a4267f76c9867c9a48322a'
$approvedProjectRef = 'REPLACE_WITH_REVIEWED_ORIGINAL_PROJECT_REF'
$repo = 'C:\Users\James Freian Hapitan\OneDrive\Desktop\maternal-care\maternal-app'
$cli = Join-Path $repo 'node_modules\.bin\supabase.cmd'
if ($approvedProjectRef -notmatch '^[a-z0-9]{20}$') { throw 'STOP: reviewed original project ref required.' }
if ((Get-FileHash -LiteralPath (Join-Path $packet 'release-manifest.json') -Algorithm SHA256).Hash.ToLower() -ne $approvedManifestHash) { throw 'STOP: manifest changed.' }
node (Join-Path $repo 'scripts\prepare-appointment-sms-release.mjs') --check $packet
if ($LASTEXITCODE -ne 0) { throw 'STOP: packet verification failed.' }

# PHASE 3 APPROVAL ONLY: helper installed and false; isolated gates passed.
& $cli --workdir $packet functions deploy send-notification-sms --project-ref $approvedProjectRef --use-api --no-verify-jwt
if ($LASTEXITCODE -ne 0) { throw 'STOP: transport deployment failed; do not deploy upstream.' }
```

STOP: verify deployed version and disabled-state evidence; obtain PHASE 4 approval.
Run the following separately, in the same reviewed terminal; missing variables must
stop rather than fall back to the dirty working directory.

```powershell
Set-StrictMode -Version Latest
if ((Get-FileHash -LiteralPath (Join-Path $packet 'release-manifest.json') -Algorithm SHA256).Hash.ToLower() -ne $approvedManifestHash) { throw 'STOP: manifest changed.' }
node (Join-Path $repo 'scripts\prepare-appointment-sms-release.mjs') --check $packet
if ($LASTEXITCODE -ne 0) { throw 'STOP: packet verification failed.' }
& $cli --workdir $packet functions deploy process-appointment-sms --project-ref $approvedProjectRef --use-api --no-verify-jwt
if ($LASTEXITCODE -ne 0) { throw 'STOP: orchestration deployment failed.' }
```

The CLI supports --workdir, explicit function names/project ref and --use-api server
bundling; per-function deno.json controls dependencies. Verify flags against the
installed 2.119.0 CLI before approval. References:
[CLI](https://supabase.com/docs/reference/cli/supabase-functions-deploy),
[dependencies](https://supabase.com/docs/guides/functions/dependencies).
No db push, db reset, secrets set, Vault mutation or activation command is included.

## Recovery and limits

With explicit approval set only the event switch false (or retain absence). KEEP the
guarded final transport deployed; reverting to the previous unguarded transport
reintroduces the bypass. If needed, roll back only orchestration/templates from an
independently reviewed compatible artifact while keeping the guard. Do not delete
dispatches, clear reservations/provider IDs, reset attempts, retry uncertain sends,
replay suppressed keys or resend booking #23. No helper removal is needed to stop
event SMS; helper missing/read-error is also fail-closed in the new transport.

OFF does not cancel provider-accepted/in-flight sends or an old worker. Reminder
flags do not recall already-enqueued reminder requests, and the new event control
intentionally does not block reminder transport. Review those queues separately.
Cancelled event keys stay suppressed after enabling; enabling scans nothing. There
is no transactional outbox, automatic historical backfill or activation cutoff.
An authorized caller can still request a previously unrequested historical event;
keep the controlled window limited to reviewed NEW actions. UI callbacks can miss
events if a browser closes after commit, or delay secondary completion on outages.
Ledger sent means provider accepted/queued, not handset delivered or exactly once.

Readiness: source/native/mocked gates PASS; real PostgreSQL/Vault/permission and
isolated service-role gates remain BLOCKED pending an approved target and SQL
execution. Production rollout and activation remain NOT APPROVED.
