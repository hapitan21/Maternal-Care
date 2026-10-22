# Business audit producers — October 19 local review

Local preparation only. No SQL, Docker operation, user creation, SMS, deployment,
RLS change, staging or production write occurred. Branch `release/maternal-care-oct23-2026`,
HEAD `bd3e839`; the older `3d19aeb` is not current local HEAD.

The user's production SQL result establishes 972 central rows: 860 Authentication,
59 User Management, 53 Reports, with none for the requested business workflows.
This supersedes the earlier review's selected-window 219 count. The user also
confirmed real browser delivery of a Staff login to Dashboard Recent Activities.
We preserve that publisher/channel and do not reinterpret a publication inventory
as evidence that private Broadcast is broken.

## Exact scope

Frontend implemented: Dashboard reads the existing `entity_type` column and uses
fixed business descriptions instead of clinical text. All proposed modules/actions
already exist in Audit Logs filters, chart grouping and count calculations. No
frontend writes or success-report calls were added. No page markup, styles, details
source classification, query filters, charts, refresh behavior or channel changed.

Backend **draft only**, in `sql-drafts/20261019_admin_audit_business_producers.sql`:

| Requested action | Authoritative source and proposed event |
| --- | --- |
| Staff/Doctor/Admin appointment creation | `schedule` INSERT scheduled/upcoming, or pending → scheduled/upcoming: appointment_management/create; no client metadata used as proof or exclusion |
| Booking approval (modern and legacy existing schedule) | `create_patient_appointment_request` pending → **accepted**, with matching persisted schedule/Patient/Doctor: appointment_management/create, shared schedule identity |
| Rescheduling | Immutable `appointment_events` INSERT, `appointment_rescheduled`: appointment_management/reschedule; no duplicate schedule time-update producer |
| Cancellation / check-in | Actual `schedule.status` transitions: appointment_management/cancel or check_in; synonyms normalized, no identical-status retry event |
| Staff Initial / Follow-Up save and meaningful edits | `staff_visit_intake` INSERT/UPDATE, `staff_completed`, valid visit_type and schedule/Patient/Doctor linkage: visit_records/create or update |
| Initial / Follow-Up Visit save and meaningful edits | `medical_records` INSERT/UPDATE, linked schedule, completed non-draft/non-deleted form: visit_records/create or update; actual actor comes from profile, not doctor_id |
| Staff/Admin completed registration | `patients.registration_status` awaiting_patient_access_confirmation → completed, current actor's handoff confirmation: patient_management/register |
| Doctor/Admin medication reminder create/update/delete | Actual `medication_reminders` mutation: reminder_management/create, update or delete. Inactivation is an **update**, not a deletion |
| Doctor/Staff/Admin appointment reminder create/update/delete | Actual `reminders` mutation with reminder_type=appointment, exclude scheduler-only fields: reminder_management/create, update or delete |
| Patient booking submission | `create_patient_appointment_request` INSERT pending, active linked owner: appointment_management/create, distinct booking-request entity type |
| Patient medication adherence response | `medication_reminder_occurrences` notified → taken/skipped, active linked owner: reminder_management/acknowledge; no drug or response value logged |

No business event is enabled by these local changes. Existing records are not
modified or backfilled. Booking submission and later appointment approval are two
different actions. The approval's schedule INSERT and accepted request transition
share one receipt. Declines, health-tip administration, background jobs, failed
attempts, deletes of clinical records and arbitrary appointment edits are outside
this draft. Null-auth/service operations never acquire a guessed human actor.

## Source evidence and prerequisites

- `supabase/migrations/20261001090000_appointment_policy_stage1_foundation.sql`:
  create_standard_appointment persists schedules. The later
  `20261001100000_patient_request_appointment_policy.sql` persists booking requests
  and accept_patient_appointment_request returns status **accepted**, after schedule
  insert/update and request update in the same transaction.
- `20260923120000_immutable_appointment_reschedule_events.sql` and later
  `20261001110000_appointment_reschedule_policy.sql`: private immutable event ledger
  and transactional reschedule RPC. Installed permissions/definitions still need comparison.
- `supabase_staff_preconsultation_intake.sql`: save_staff_visit_intake upserts the
  separate assessment; repeated upserts replace staffSavedAt but retain the original
  staff_id. Therefore actor must be current auth.uid(), not row staff_id.
- `supabase_patient_visit_form_routing.sql`: save_appointment_visit_record inserts a
  linked completed record and returns an existing record on duplicate schedule.
  AppointmentVisitForm also directly updates existing medical_records. A table
  producer covers both without editing either save path. The RPC source permits
  Staff/Admin as well as Doctor; the event says **record saved**, never falsely
  assigns the current actor's role from the record's doctor_id.
- `AppointmentVisitForm.jsx`: later sync_doctor_visit_pregnancy_state is a separate
  call and can fail after persistence. The draft does not claim that sync succeeded
  or that a clinical assessment is correct/complete merely because a record exists.
- `supabase_patient_registration_workflow.sql`: finish_patient_registration performs
  the completed transition with auth.uid handoff confirmation. Walk-in finishing
  calls that workflow and schedules separately within its transaction. Nothing in
  the three-step registration or automatic initial appointment is rewritten.
- `Doctor_Reminder.jsx`, `supabase_reminders_policies.sql`,
  `supabase_medication_reminders_policies.sql`: direct authorized table operations.
  Failed DELETE due to occurrence FK restriction produces no success audit row.
- `supabase_automatic_medication_reminders.sql`: mark_medication_reminder_occurrence
  permits only the notified → taken/skipped transition for an active owned Patient.
  It records a Patient **response**, not proof medication was taken.

The original public SECURITY DEFINER record_audit_event derives identity from
auth.uid but accepts broad business success claims. It must **not** be used as a
new business producer. The unchanged, separate October 18 production security
proposal restricts it to own authentication and Admin report claims (`reported`)
and keeps authoritative Admin account-status writes internal. Its internal writer
allows only those Admin status events, so this draft does not broaden or replace it.

The new draft creates one inaccessible schema, one receipt table, one no-argument
SECURITY DEFINER trigger function and nine triggers. Owner postgres, empty
search_path, fully qualified references, explicit revoke from PUBLIC/anon/
authenticated/service_role, plus effective-access postchecks. No new public RPC or
browser-callable business writer. Actor ID/role/name come from authenticated server
context and active profiles; new Patient events use the generic actor name "Patient"
while retaining the authenticated actor UUID for attribution. Modules, actions and descriptions are fixed by the
mutation branch. JSON fields are compared internally, never copied or hashed into
the audit payload. Only opaque source IDs and two fixed metadata markers are stored;
Patient registration has no public Patient entity ID (its inaccessible receipt key
uses the opaque source UUID for deduplication). No notes, patient names, diagnoses,
drug names, dosages, phone numbers, JWTs or clinical values are emitted.

**Not deployment-ready:** `reviewed_catalog_md5='UNREVIEWED'` deliberately stops
installation. The read-only companion preflight returns a schema/authorization/
function/trigger fingerprint and structural inventories without patient rows or
function bodies. The draft recomputes that exact fingerprint. It also pins the
restricted client wrapper body from the unchanged October 18 proposal, rejects
staging's schema/writer, rejects RPC overloads and direct canonical-ledger writes,
and requires the existing Broadcast trigger and private Admin writer.

A matching fingerprint means only **no drift from the separately reviewed database**.
Review all actual mutation RPC bodies, definer owners/search paths, source RLS and
column grants, protected profile role/account-status writes, duplicate producers
and parent-ID immutability before approving it. Broad clinic-role policies in the
repository do not prove Doctor assignment restrictions or current installed RLS.
The fingerprint includes object OIDs; a clone needs its own reviewed fingerprint.
It is not portable from production to staging. Never bypass the older proposal's
original four function hashes or use this draft to replace staging's s4audit_private.

## Integrity and remaining risks

Receipts and audit insertion are in the business transaction. Stable create,
registration, adherence and reschedule identities deduplicate those events. Updates,
cancel and check-in use entity/action/transaction identity. Timestamp-only clinical
retries are ignored; two genuinely different edits in one transaction intentionally
coalesce. Failed/rolled-back operations must leave neither receipt nor audit row.

This is not database-level exactly-once booking or SMS delivery. A duplicate business
row with a new UUID creates another event; later transactions with meaningful
changes create new updates. Delete/reinsert using a reused source ID can suppress
the second create. Do not approve an ID-reuse workflow without revisiting that key.
These properties and concurrent behavior remain unverified in PostgreSQL.

Audit failure deliberately aborts the associated business transaction. That preserves
atomic evidence, but could interrupt a working save if a constraint, role, privilege,
or trigger behaves differently than reviewed. This availability risk is a deployment
blocker until isolated failure/rollback tests pass. Silent exception swallowing would
hide missing audit coverage; the draft avoids it. The existing Broadcast function's
notification-failure handling is untouched.

Source markers remain **metadata markers**, not proof that a historical event was
trusted. New code does not relabel old rows as server verified. No changes to
event_origin, status constraints, existing RLS, grants, business functions or Realtime.

## Verification and shortest safe rollout

Performed locally: producer/presentation suite **9 scenarios / 185 assertions**,
Dashboard refresh/count suite **14 / 77**, existing audit security/viewer-hook suite
**50 / 251**: total **73 / 513, zero failures**. Four JavaScript syntax checks,
scoped ESLint and git diff --check passed. Vite production build passed (2,221 modules;
existing large-chunk/plugin timing warnings). All 119 unrelated pre-existing dirty
paths match their starting hashes; only the two intended pre-existing files changed,
alongside the five newly dirty/added paths. No staged files; branch/HEAD unchanged.

Offline commands (no database calls):

```powershell
node scripts/verify-admin-audit-business-producers.mjs
node scripts/verify-admin-activity-refresh.mjs
node scripts/verify-admin-audit.mjs
node --check scripts/verify-admin-audit-business-producers.mjs
node --check scripts/verify-admin-activity-refresh.mjs
node --check src/lib/adminDashboard.js
node --check src/hooks/useAdminDashboardData.js
node node_modules/eslint/bin/eslint.js src/lib/adminDashboard.js src/hooks/useAdminDashboardData.js scripts/verify-admin-audit-business-producers.mjs scripts/verify-admin-activity-refresh.mjs
npm.cmd run build
git diff --check
```

These exercise real presentation/count/chart helpers and actual hooks with mocked
reads/private channels, plus SQL structural contracts. They do **not** compile
PL/pgSQL or establish installed authorization, trigger behavior, rollback or concurrency.

1. **Read-only review checkpoint:** compare installed producers/permissions with
   source. Confirm whether the separately reviewed October 18 restriction has been
   deployed. Collect the companion preflight results from the intended baseline.
2. **Isolated execution approval:** use an approved disposable, production-shaped
   database with outbound SMS/FCM disabled and mocked transport. Reuse passed
   Checkpoints 1–3; rehearse this *new* extension only. Apply the security prerequisite
   there if absent; review and pin that isolated catalog, then test the producer draft.
3. Four synthetic real JWT roles: authorized creation/reschedule/cancel/check-in;
   both Staff and Doctor Initial/Follow-Up save/edit; registration finish including
   walk-in automatic appointment; reminder CRUD/inactivation/FK-rejected delete;
   own booking and adherence. Verify wrong-role/cross-Patient rejection by installed
   source permissions; no forged actor/role/public-success claims or private access.
   Test pending request exclusion, one accepted-appointment event, both legacy and
   modern approval, no-op retries, concurrent RPC calls, transaction rollback and
   injected audit failure. Assert zero clinical values in every resulting audit row.
4. Join the existing private Admin channel with a real Admin JWT; verify one business
   insert refreshes Dashboard and Audit Logs, page-two updates notice, filter counts,
   chart totals/sample notice and manual Refresh when join is denied. Non-Admins
   cannot read audit rows or receive the private channel. No new Realtime policies.
5. **Production approval only after those pass:** review backup/recovery and short
   lock window, approve the production-specific catalog and the two SQL proposals
   separately. The frontend is backward compatible and may be released independently;
   it alone creates no business coverage. Observe new synthetic activity only after
   explicit approval; never trigger historical patient actions to populate history.

Before commit, ROLLBACK removes the new extension and its receipt/audit inserts.
After commit, recovery requires a separately reviewed transaction removing only the
nine named mc_audit_* triggers and the new function/receipt/schema in dependency order;
preserve all audit history and existing Broadcast/security objects. No cleanup SQL
has been run or authorized. Avoid emergency permission widening or catch-all logging.
