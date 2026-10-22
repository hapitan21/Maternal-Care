# Controlled automatic appointment event SMS — local proposal

No SQL, Vault configuration, Edge deployment or real SMS was performed. Installed
production definitions and the October 19 10:18 AM dispatch remain unverified.

## Existing paths and scope

| Successful action | Existing source entry point | SMS event |
| --- | --- | --- |
| Staff registration initial appointment | `Staff_Patients.jsx:3920` after reservation completion and schedule lookup | confirmation |
| Staff Add / Edit appointment | `Staff_Appointments.jsx:4196` after save / reschedule receipt | confirmation / rescheduling |
| Staff booking approval | `Staff_Appointments.jsx:3215` after acceptance RPC | confirmation |
| Staff reschedule dialog | `Staff_Appointments.jsx:3637` after reschedule RPC | rescheduling |
| Staff cancellation | `Staff_Appointments.jsx:3334,3431` after status update | cancellation |
| Doctor Add appointment | `Doctor_Appointments.jsx:2195` after insert receipt | confirmation |
| Doctor reschedule | `Doctor_Appointments.jsx:2740` after reschedule RPC | rescheduling |
| Doctor cancellation | `Doctor_Appointments.jsx:2543` after status update | cancellation |

These paths already use `automaticAppointmentNotification.js` / `appointmentSms.js`.
Booking approval uses notification-only creation plus one direct SMS request.
No additional frontend producer is added. Notification type mapping, in-app RPC,
FCM, clinical forms and appointment writes are unchanged. Pending/declined requests
are rejected by SMS planning; declining is not appointment cancellation.

Previously, direct calls bypassed `appointment_sms_bridge_enabled`: that flag only
guards scheduled-reminder enqueueing. The medication bridge has its own flag.
Neither flag is a global kill switch. Existing pg_net requests and provider queues
are not recalled by turning a bridge OFF. Confirm the actual incident by correlating
dispatch `notification_type`, schedule linkage, timestamps and Edge execution logs;
do not retrieve phone numbers, provider receipt URLs or credentials.

Additional scope requiring separate review: SQL-only schedule writes, scripts,
external integrations or a browser closing between commit and notification request
can omit event SMS. There is no transactional outbox for confirmation/cancellation.
Do not add a broad schedule trigger or historical backfill to address this implicitly.

## New boundary and dependencies

One Vault setting: **`appointment_event_sms_enabled`**. The only enabled value is
one exact `true` entry. Missing, duplicate, malformed, unreadable configuration or a
missing RPC is OFF. No browser setting or request-body override is accepted.
No confirmation-only control is introduced.

`docs/sql-drafts/appointment-event-sms-control.sql` is a separate, unapplied helper
proposal: a scalar-boolean, SECURITY DEFINER function with empty search_path,
postgres ownership, and execute only for service_role. It reads one named setting,
returns no secrets, creates no Vault entry and enables nothing. CREATE FUNCTION
fails on an existing signature; review a collision rather than replacing it.

The final `send-notification-sms` transport loads the stored ledger notification
type, checks the helper before reservation, then checks again after patient lookup
immediately before IPROG. Only literal boolean true is accepted from the RPC. No
enabled decision is cached. Unknown/missing SMS types are refused; first inventory
installed producers before rollout. Known appointment/medication reminder types
retain their existing bridge behavior and never read this new setting.

The ledger must have `notification_type`, processing/cancelled statuses, the existing
unique dispatch key, and the existing atomic provider-null reservation contract.
No table/schema/RLS change is proposed. No direct Vault access is added for clients.
Existing Auth checks still require an active authorized Staff/Doctor/Admin; Doctors
must own the appointment. Reminder orchestration and raw transport retain server
secret authentication. These are source guarantees, not installed permission tests.

## Suppression, timing and history

An OFF decision marks only the current processing dispatch cancelled, with the safe
reason `appointment_event_sms_disabled`. It does not delete history, alter the saved
appointment, reset attempts or clear provider evidence. Before reservation it uses
provider IS NULL; after reservation only the request which acquired that reservation
can suppress it. Write failure never falls through to IPROG. Existing sent/delivered,
failed, cancelled and previously reserved rows retain their previous handling.

Suppressed event keys cannot be reclaimed by the normal claim RPC or safe-retry RPC.
Enabling does not scan, replay or enqueue history; it applies to new eligible calls
for all patients, not an individual test recipient. No notification for historical
booking #23 is generated. Unobserved/stale processing rows are not automatically
cancelled or reconciled: inspect them separately before activation. Previously
unrequested historical events can still be requested by authorized callers; the
existing system has no activation cutoff or immutable confirmation/cancellation
event identity. Strict historical exclusion and commit-to-send reliability need a
separately reviewed transactional outbox/activation boundary and RPC changes.

Future outbox draft contract (not executable SQL): write an immutable lifecycle
event and one unique `(event_id, channel)` outbox row in the same authorized
creation/approval/reschedule/cancellation transaction. Record event-time enablement
and a reviewed activation cutoff so OFF-era events remain permanently suppressed.
A server worker must consume only eligible new events and retain the final transport
switch/reservation checks. Reconcile current keys before transitioning producers;
never run frontend and outbox producers with different keys for the same event.
Exact RPC edits require installed production definitions and separate approval;
this package deliberately supplies no speculative replacement application RPCs.

If OFF is observed before the final read completes, the event is suppressed. OFF
cannot atomically cancel a provider call already starting after the final read,
an in-flight request, a provider-accepted SMS or a running old deployed version.
Do not promise provider exactly-once delivery or handset delivery from ledger sent.
Provider errors and uncertain outcomes retain their existing no-blind-retry behavior.

Rescheduling text now uses both previous and new start times from the same persisted
immutable reschedule event, never the subsequently edited schedule. Missing/invalid
old ranges or unchanged ranges skip SMS safely; legacy nullable history needs review.
Confirmation stays unchanged; cancellation says to contact the clinic. Date/time
formatting retains Asia/Manila and ASCII whitespace normalization for every template.

Existing frontend helpers await secondary notification work in several Staff and
reschedule flows; SMS failure/disabled results do not undo committed writes. They
can still delay UI completion during network outages. Fixing that timing or adding
durable delivery requires separate scope; no save handler was changed here.

## Local verification

Run `node scripts/verify-appointment-event-sms.mjs` for the existing six SMS suites,
actual secured transport handler with mocked clients/provider, bridge source checks,
and shared frontend notification contract checks. The adapter uses Node's built-in
TypeScript transform, not native Deno type checking. It refuses live fetch and live
environment reads. No SQL executes. Also run the existing Staff approval regression,
appointment success-toasts checks, scoped lint, Vite build and git diff --check.
PostgreSQL execution, installed grants, live JWT and production Edge parity remain
separate verification gates; static SQL checks do not establish them.
The Node adapter requires the locally verified Node 22.17+ built-in module hooks.

## Ordered approval checkpoints and recovery

1. **Read-only production review:** verify installed schema, claim/retry functions,
   current transport/Auth definitions, existing SMS types, helper-name availability,
   Vault availability and owner/grant baseline. Inspect stale dispatch metadata and
   resolve the October 19 event. Never expose Vault values. Existing bridges stay OFF.
2. **Approve isolated SQL rehearsal separately:** exercise the draft helper against
   synthetic Vault rows (missing/false/true/invalid/duplicate as schema permits),
   error handling, role grants, suppression and concurrency. No existing protected
   rehearsal container or database should be reused without approval.
3. **Approve production helper installation separately:** apply the reviewed draft
   only, retain an absent/false flag, verify service-only grants and API schema reload
   visibility. Never weaken permissions to fix a failed read.
4. **Approve Edge deployment separately:** deploy the guarded final transport first
   with OFF, then the appointment orchestration/template bundle. Confirm all regions/
   workers use the guarded version; old workers are not controlled by this proposal.
5. **Approve disabled-state runtime verification separately:** synthetic appointment
   events must save normally, retain in-app/FCM, create cancelled SMS ledgers, and make
   zero IPROG requests. Test direct calls and queued OFF behavior without contacting
   the real provider (isolated/mock endpoint only).
6. **Approve activation and real SMS separately:** use a quiet controlled window;
   a global ON setting permits other users' concurrent appointment events. Review
   outstanding requests first. Authorize exact synthetic recipients/events, enable
   only the event setting, verify one dispatch per event, then return OFF and confirm.
   Never enable either reminder bridge or replay history as part of this test.

Recovery: keep the guarded final transport deployed and set the event flag false
only with approval. Do not roll back to the old unguarded transport, reset ledger
rows, clear provider reservations, retry uncertain outcomes or delete dispatch
history. Missing helper fails closed; removing it is not necessary for recovery.
Template-only rollback can retain the safety boundary. Business appointment and
in-app/FCM paths remain independent of this setting.
