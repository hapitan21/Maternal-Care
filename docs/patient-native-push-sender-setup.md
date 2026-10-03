# Patient native push sender setup

`send-patient-native-push` is the server-only Android FCM HTTP v1 delivery path
for rows already created in `public.patient_notifications`. It is separate from
the existing browser Web Push sender and must use a separate webhook secret.

Do not place a Firebase service-account file, private key, OAuth token, FCM
registration token, or real webhook secret in Git, React/Vite variables,
Android assets, documentation, shell history, or logs.

## Required Supabase secrets

- `FIREBASE_SERVICE_ACCOUNT_JSON`: the complete service-account JSON stored as
  one Supabase secret. The sender validates and uses only `project_id`,
  `client_email`, `private_key`, and optional `private_key_id`.
- `NATIVE_PUSH_WEBHOOK_SECRET`: a long, independently generated random value
  used only by the native-push Database Webhook.

The Firebase service account must belong to, or be granted narrowly scoped FCM
send access to, the Android application's Firebase project. Enable the Firebase
Cloud Messaging API and grant only the permission required to create FCM
messages. Never use the Android client API key or `google-services.json` for
server authentication.

Set production secrets through the Supabase Dashboard or an ignored local env
file. To avoid putting JSON/private keys in command history, prefer:

```sh
supabase secrets set --env-file <ignored-native-push-env-file>
```

The ignored file must define `FIREBASE_SERVICE_ACCOUNT_JSON` and
`NATIVE_PUSH_WEBHOOK_SECRET`. Do not commit it.

## Migration and local validation

Review and apply the native delivery-ledger migration before invoking the
function. For a linked project, preview migration work first:

```sh
supabase db push --dry-run
```

When Docker and the Supabase local Edge runtime are available, serve the
function with an ignored local env file and JWT gateway verification disabled.
The handler still requires `x-webhook-secret`:

```sh
supabase functions serve send-patient-native-push --no-verify-jwt --env-file <ignored-native-push-env-file>
```

Test rejection of wrong methods, missing/incorrect secrets, malformed JSON,
wrong event/table/schema values, and invalid notification UUIDs before testing
against Firebase. Then validate canonical notification lookup, duplicate claim
skipping, multiple enabled installations, invalid-token disable, and aggregate
responses.

## Future deployment

Do not run these steps until the migration, secrets, and physical-device test
plan have been reviewed.

```sh
supabase functions deploy send-patient-native-push --no-verify-jwt
```

The deployed function is not authenticated by `verify_jwt`; it authenticates
the Database Webhook with the separate `x-webhook-secret` value. Knowing the
function URL alone is insufficient to pass this check.

## Future Database Webhook

Create this only after the function is deployed and the production secrets are
set:

| Setting | Value |
| --- | --- |
| Name | `send-patient-native-push-on-notification` |
| Schema | `public` |
| Table | `patient_notifications` |
| Event | `INSERT` only |
| Method | `POST` |
| Destination | Deployed `send-patient-native-push` Edge Function |
| Header | `x-webhook-secret: <same value as NATIVE_PUSH_WEBHOOK_SECRET>` |

Use a separate Dashboard webhook from `send-patient-web-push`. Do not change or
remove the existing Web Push webhook.

The native handler accepts only the webhook notification UUID. It re-fetches
the canonical `patient_notifications` row, derives Patient ownership and a
hard-coded safe route, and queries only enabled Android registrations belonging
to that Patient.

## Privacy-safe message

Every native message uses the same lock-screen copy:

- Title: `Maternal Care`
- Body: `You have a new reminder. Open Maternal Care to view details.`

The data payload contains only string values for `notification_id`, an
allowlisted `notification_type`, and a hard-coded allowlisted `route`. It does
not contain Patient identifiers, names, database title/message values, related
entity IDs, medication details, diagnoses, laboratory content, pregnancy data,
notes, or other clinical text.

## Production verification

After deployment and webhook creation:

1. Send one canonical notification to a dedicated test Patient and verify its
   in-app row and Android system notification.
2. Test foreground, background, and killed app states. Tap/deep-link routing is
   intentionally not implemented by this phase.
3. Test two enabled Android installations; one device failure must not block the
   other.
4. Replay the same webhook and confirm the unique notification/device claim is
   skipped rather than sent again.
5. Invalidate only a dedicated test token, then verify its device row is updated
   to `enabled = false` without being deleted.
6. Confirm function logs and ledger rows contain no FCM tokens, Patient IDs,
   notification content, credentials, JWT assertions, or OAuth tokens.

Commit and push only after these runtime checks pass.

## Phase 8B bounded delivery retries (local implementation; not deployed)

Review `supabase/migrations/20261003130000_patient_native_push_bounded_retries.sql`
together with the updated sender. This phase does not authorize applying the
migration, deploying the function, provisioning Vault values, or enabling production retries.

Normal webhook claims remain insert-only: every existing notification/device
pair is skipped, including a failed row that is due. Only authenticated retry
mode can claim an existing failed row. The database requires a confirmed
transient rejection, a due deadline, fewer than four total claimed attempts,
less than 30 minutes since original `created_at`, and an enabled canonical
Android registration. A retry clears all previous result metadata and receives
a fresh database-generated claim token. Historical failed/processing rows are
left unchanged and never inferred retryable. Processing rows are not reclaimed.

FCM 429 and valid FCM HTTP 500 INTERNAL / 503 UNAVAILABLE responses may retry.
Precise permanent-token failures retain the existing classifier. Payload,
authentication, configuration, and explicit unsupported client errors are
terminal. Network exceptions, timeouts, HTTP 502/504, and ambiguous/unreadable
5xx responses have an unknown provider outcome and are never automatically
replayed. The in-app notification remains the fallback.

For 500/503, the top-level status must match the HTTP status, any supplied
numeric code must match it, and any supplied message must be a string. An absent
details field or an empty array is allowed; a supplied details field must be an
array of valid typed object envelopes. Every FcmError code must be the expected
INTERNAL/UNAVAILABLE string, with no conflicting or malformed codes.
Identical duplicates are accepted. Other well-formed typed envelopes (such as
RetryInfo) neither establish nor contradict the transient outcome; BadRequest
prevents replay. Malformed or contradictory evidence is unknown regardless of
detail order. Permanent-token classification is unchanged.

HTTP-date Retry-After values use an explicit parser for IMF-fixdate, RFC 850
(including its two-digit-year rule), and asctime. Calendar/time/weekday
validation rejects impossible dates; valid past dates normalize to zero.
The longest valid provider delay still participates in the existing backoff.

The four-attempt limit includes the initial claim. Failed attempts 1–3 schedule
60/120/240 seconds plus 0–25% nonnegative jitter, using the longer valid HTTP
`Retry-After` or typed `google.rpc.RetryInfo` delay. A deadline at or beyond the
original 30-minute window, or attempt 4, schedules nothing.

Finalization requires the delivery ID, claim token, and attempt count under a
database lock. Permanent-device cleanup happens in that same fenced transaction
and additionally requires the selected registration's unchanged `updated_at`,
enabled state, and canonical ownership. Stale workers cannot update the ledger
or disable registrations. Duplicate finalization acknowledges the existing
result without repeating cleanup. After a provider result, temporary recording
failures retry only the identical finalization RPC after 250 ms, 1 s, and 2 s.
They never send FCM again. Exhaustion leaves `processing` for Phase 8C.

### Separate retry authentication

Future reviewed function configuration must supply `NATIVE_PUSH_RETRY_SECRET`,
an independently generated 32–256 character URL-safe secret (`A-Z`, `a-z`,
`0-9`, `_`, `-`) distinct from `NATIVE_PUSH_WEBHOOK_SECRET`. Neither credential
authorizes the other mode. Mode-specific authentication precedes operational
database access. Retry requests use:

```text
POST <project-url>/functions/v1/send-patient-native-push
x-native-push-mode: retry
x-retry-secret: <NATIVE_PUSH_RETRY_SECRET>
content-type: application/json

{"mode":"retry"}
```

The database discovers at most ten candidates ordered by `next_attempt_at, id`.
The sender uses concurrency five and the same per-device claim/send/finalization
path for both modes. Discovery never grants a claim.

### Inert scheduler infrastructure

The migration requires existing Vault, pg_cron, and pg_net capabilities and
fails before schema changes if they are missing. It installs no extensions.
Review these prerequisites in a separate read-only environment assessment
before applying; the SQL fixtures do not prove production extension availability.

A minute cron job invokes the private enqueue function. Its command contains
no secret or endpoint. The function reads these named Vault values:

| Vault name | Required value |
| --- | --- |
| `native_push_retry_enabled` | Exactly `true`; set last, only after separate approval |
| `native_push_retry_project_url` | Trusted `https://<20-character-project-ref>.supabase.co` project base |
| `native_push_retry_url` | Exactly that base plus `/functions/v1/send-patient-native-push` |
| `native_push_retry_secret` | Same separate URL-safe retry secret configured on the function |

No Vault values are created by the migration. Missing, invalid, mismatched, or
disabled configuration performs no HTTP call. Custom domains, query strings,
and alternative paths are rejected. The enqueue function emits no decrypted
values in logs and is executable only by `postgres`; claim/list/finalization
RPCs are executable only by `service_role`. Ledger RLS remains enabled, SELECT
is preserved, and direct service-role ledger INSERT/UPDATE grants are removed.

### Coordinated migration and sender rollout

The migration takes PostgreSQL table locks while adding columns, constraints,
and the index and changing privileges. These operations can wait for active
transactions and block ledger writes; review traffic and long-running
transactions before scheduling the separately authorized rollout. This is not
a zero-downtime guarantee.

The migration revokes direct `service_role` INSERT/UPDATE on
`patient_notification_native_push_deliveries`. The updated sender uses the
claim/finalization RPCs instead. The old sender's direct ledger writes therefore
fail under the post-migration privilege model; the updated sender likewise
requires the new RPCs to exist. Coordinate the migration and Edge Function
update in one controlled rollout, and do not intentionally leave the old sender
operating against the new grants for an extended period. A transition gap can
prevent delivery claims; webhook replay remains insert-only and is not an
automatic recovery mechanism for every missed invocation.

Keep the scheduler inert throughout the transition. Do not provision/enable
retry scheduling until both the migration and updated sender are deployed and
verified under separate authorization. Only then configure the separate retry
secret and trusted Vault values, setting the enable flag last.

### Durable local verification

```sh
node scripts/verify-patient-native-push-lifecycle.mjs
node scripts/verify-patient-native-push-navigation.mjs
node scripts/verify-patient-native-push-retry-sql.mjs
```

The lifecycle harness executes the exported Firebase and delivery-helper tests
with the repository's existing Node/Oxc runtime and sender mocks. The SQL script
checks migration guards and an explicitly labelled model; this is not proof of
PostgreSQL concurrency. Deno-compatible helper test registrations are also kept.

For actual SQL and two-connection claim races, use an existing `psql` runtime
and a dedicated, empty loopback database named `maternal_native_push_retry_test`
with the existing `anon`, `authenticated`, and `service_role` test roles:

```sh
node scripts/verify-patient-native-push-retry-sql.mjs --postgres
```

The runner targets `127.0.0.1`, user `postgres`, default port 54322 (optional
`NATIVE_PUSH_TEST_PGPORT`), and never a linked project. It loads the real ledger
and retry migrations into the dedicated test database, runs
`supabase/tests/patient_native_push_delivery_retry_test.sql`, then runs competing
initial/retry claims using independent connections. A holds its claim in an
uncommitted transaction; a third connection must observe B actively waiting
for a Lock with A in pg_blocking_pids(B) before A can commit. B must then return
zero claims, and the ledger attempt count must remain one/two for initial/retry.
Sessions, connections, observer queries, and synchronization have bounded
timeouts; child processes are cleaned up on success and failure.
Setup/synchronization failures are reported separately from assertion failures.
Local control-flow tests check barrier/cleanup orchestration with fakes and do
not prove PostgreSQL locking. The SQL fixture reproduces the production device
updated_at trigger, uses committed transaction boundaries for registration
rotation, and snapshots all historical states and attempt counts above four. Local Vault/cron/pg_net
transport fixtures isolate scheduling tests; they do not verify real extension
execution. The script does not install tools or create databases/roles. Without
`psql`, real SQL and concurrency checks report NOT EXECUTED.
