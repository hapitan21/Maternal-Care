# Four-role audit logging review — 22 October 2026

This is a source review of branch `review/maternal-care-web-final-20261020` at
`8153f02`, including the pre-existing uncommitted work. It does not certify the
currently installed Supabase definitions. A user-supplied production SQL Editor
CSV provides the aggregate count snapshot below. No database query, migration,
audit insert, or deployment was run by this review.

## Architecture and current visibility

`public.audit_logs` is the central 15-column ledger described in
`supabase_admin_audit_logs.sql`. The original table/RPC script grants authenticated
clients no direct table writes, allows active Admin SELECT through RLS, and derives
the actor from `auth.uid()` and `profiles` in `record_audit_event`. Its original
browser-callable function accepts broad success claims; a report through that
function does not prove the associated business action committed. The repository
also has an Admin-only private Broadcast trigger for new rows. These are source
definitions, not a fresh inspection of installed objects.

Named source objects are `public.audit_logs`,
`public.record_audit_event(text,text,text,text,text,jsonb,uuid)`,
`public.admin_set_patient_account_status`,
`public.admin_set_doctor_account_status`,
`public.admin_set_staff_account_status`, and the
`broadcast_admin_audit_log_change_trigger` /
`public.broadcast_admin_audit_log_change()` pair. The original table script
defines the active-Admin SELECT policy and revokes ordinary client DML. No
separate Audit Logs view was found in the inspected repository definitions.

The current frontend calls the central writer from the shared clinic login,
Admin logout, and Admin report export/print paths. Admin patient/Doctor/Staff
account-status RPCs contain transactional audit calls. The Patient has a separate
login route without a central writer. Doctor, Staff, and Patient sign-out paths
do not call the central writer. Supabase Auth's own audit entries, appointment
events, and clinical/notification ledgers are separate stores and are not merged
into `public.audit_logs` by the viewer.

The Admin viewer reads `audit_logs` with active Admin identity gating, an exact
filtered count, 10-row pages, descending `created_at, id`, Manila date bounds,
and actor/role/module/action/status filters. Selected-field search applies to
actor name, exact actor UUID, action, description, or affected record ID before
exact counting and paging. Timestamp and ID sort in the selected direction. A 5,000-row
sample supplies dropdown choices; the canonical module/action choices remain
available if the sample truncates. The User dropdown can omit older actors and
shows a truncation notice. There is no Audit Logs export in the current page.
Date defaults to the latest seven Manila
calendar days; earlier history requires a wider date range. Realtime is an
invalidation hint; Refresh re-reads the ledger. The detail query avoids fetching
the unrestricted metadata object and user agent. Optional `event_origin` is used
when installed; production's 15-column schema falls back only for that missing
column. Source markers in historical metadata are labelled as markers rather
than trusted proof.

Supabase's separate [Auth Audit Logs](https://supabase.com/docs/guides/auth/audit-logs)
cover Auth events such as sign-in, sign-out, signup, and password changes.
Database storage in `auth.audit_log_entries` is optional. Its current setting,
event outcomes, retention, and access have not been inspected in this project.
Those entries must not be exposed directly to browser roles or copied into
`public.audit_logs` without a trusted, deduplicated, privacy-reviewed design.

## Security finding requiring installed-state confirmation

The original repository body of `public.record_audit_event` derives the actor
from `auth.uid()` but accepts client-selected business module/action/description
and writes `status='success'`. If that body is installed, any active authenticated
user allowed to execute it can report a false business success. The restricted
production wrapper and staging's separate writer were prepared/reviewed earlier,
but their current installed state is not established by this source review.
Do not treat legacy success rows as proof of committed business transactions.

## Coverage matrix

Legend: **producer** means a repository path writes the central ledger;
**gap** means no central producer was found in the inspected source; **runtime
unknown** means an installed trigger/RPC or current persisted result has not been
independently verified. Existing external Auth/clinical ledgers are not counted
as central coverage.

| Role | Activity | Repository coverage | Evidence / limit |
| --- | --- | --- | --- |
| Admin | Shared login | Producer, best-effort client report | `src/pages/auth/login.jsx` calls `recordAuditEvent` after role routing succeeds. |
| Admin | Logout | Producer, best-effort client report | `src/context/AdminAuthContext.jsx` reports before `signOut`; the event can precede a failed sign-out. |
| Admin | Patient/Doctor/Staff account status | Transactional producer in source | `supabase_admin_user_management.sql` and `20260928040000_admin_patient_status_consistency.sql`; installed bodies and results remain runtime unknown. |
| Admin | Report PDF/Excel/print | Producer, best-effort client report | `src/pages/admin/AdminReports.jsx` reports after preparation/print invocation. |
| Admin | Other account edits, settings, appointment management, audit-log reads/exports | Gap or feature-dependent | No matching central producer found. Audit Logs export is not implemented in this page. |
| Doctor | Shared login | Producer, best-effort client report | Shared `/login` path only; successful Auth alone is not enough if later profile/routing checks fail. |
| Doctor | Logout | Gap | `RoleInactivityProvider` signs out without a central report. |
| Doctor | Appointments, visit saves/edits, reminders, record/document access, profile edits | Gap in central ledger source; runtime unknown | Existing RPC/table mutations and reads operate without a matching central writer in inspected paths. Proposed database producers cover a subset of successful writes only. |
| Staff | Shared login | Producer, best-effort client report | Shared `/login` path. |
| Staff | Logout | Gap | `StaffDashboard` and settings sign out without a central report. |
| Staff | Registration, appointment/check-in/reschedule, assessments, record access, profile edits | Gap in central ledger source; runtime unknown | Existing workflows are present; their source paths have no verified central producer. Proposed database producers cover a subset of successful writes only. |
| Patient | Separate Patient login, failed login, activation/link, logout | Gap | `Patient_Login.jsx`, `Patient_CreateAccount.jsx`, and `Patient_PWA.jsx` use Auth/linking/sign-out without the central writer. Failed unauthenticated login cannot be safely sent through the authenticated audit RPC. |
| Patient | Booking request, adherence response, record access/download, profile/security edits | Gap in central ledger source; runtime unknown | Existing workflows are present; proposed database producers cover booking and adherence only. |
| All four roles | Failed sign-in, password recovery/change, unauthorized attempts | Central gap; separate Auth evidence may exist | Confirm the project's Auth Audit Logs setting and outcome fields before designing a trusted, private integration. A failed unauthenticated attempt has no reliable `auth.uid()` to attribute. |
| System/service | Notification generation, queueing, sending, delivery/failure, SMS | Central gap; separate workflow ledgers | Preserve each actual delivery state and service attribution. The disabled IPROG bridge flags remain disabled; no event should claim delivery from a queued item. |

Prior local notes report a production diagnostic of 972 rows (860 Authentication,
59 User Management, 53 Reports) at the time it was supplied. That historical
result supports the reported business-event gap then; it does not establish
today's installed coverage, status distribution, or all four current role counts.
The read-only diagnostic SQL in
`docs/sql-drafts/admin-audit-production-readonly-diagnostics.sql` is available
for an authorized operator, but was not executed here.

## Eight-module source coverage and empty-filter diagnosis

This matrix concerns writes to the **central** `public.audit_logs` ledger in the
inspected repository. Source producer evidence is distinct from the production
aggregate counts below: the counts do not identify the installed writer or prove
that an individual business operation committed. The guarded business-producer
SQL below is a proposal, not installed coverage.

| Module | Current central producer evidence | Missing or unverified coverage |
| --- | --- | --- |
| Appointment Management | None found in the inspected active source | Staff/Doctor/Admin appointment changes and Patient booking have workflow tables/RPCs, but no confirmed central writer. A guarded proposal covers selected create, reschedule, cancel and check-in paths; approval, completion, missed status and other transitions need separate review. |
| Authentication | Shared clinic login; Admin logout reports to the central RPC | Patient's separate login and Doctor/Staff/Patient logout do not use that RPC. Failed login, password/security events and actual sign-out outcome need trusted Auth/server evidence. |
| Patient Management | None found in the inspected active source | Three-step Staff registration, profile and clinical-history edits lack a confirmed central producer. The proposal covers only registration completion; profile/history changes and sensitive reads need separate policy and producer review. |
| Reminder Management | None found in the inspected active source | Reminder, medication and adherence mutations plus SMS/notification outcomes are not centrally recorded by an active source producer. The proposal covers selected human reminder mutations and Patient adherence; queued/sent/delivered/failed service outcomes are outside it. |
| Reports | Admin PDF/Excel export and print make best-effort client reports after preparation | Other generation paths and failed outcomes have no confirmed trusted producer. Automatic data refreshes should not become report events. |
| System Settings | None found in the inspected active source | No central writer was found for supported configuration changes; actual setting stores and installed writers need read-only inspection before designing events. |
| User Management | Admin Patient/Doctor/Staff status RPCs have transactional writer calls in source | Account creation, role/permission and profile changes are not comprehensively covered. Installed definitions and emitted rows remain unverified. |
| Visit Records | None found in the inspected active source | Staff assessment and Doctor visit saves/edits have no confirmed active central producer. The proposal covers selected saved assessment/visit transitions; diagnostics, uploads, prescriptions and authorized reads require separate review. |

### User-supplied production count snapshot, 22 October 2026

The user exported an eight-row, read-only aggregate from the production SQL
Editor (`Supabase Snippet Audit Logs Diagnostics Coverage & Write Path
Inventory.csv`). The query left-joined the eight canonical modules to
`public.audit_logs` and counted all-time rows, latest-seven-Manila-day rows and
stored actor roles. This is stronger evidence about **persisted central rows**
than the older selected-window notes, but it does not inspect installed
functions/triggers/RLS or prove authenticated browser access.

| Module | All time | Latest seven Manila days | Stored actor roles, all time |
| --- | ---: | ---: | --- |
| Appointment Management | 0 | 0 | none |
| Authentication | 1,108 | 392 | Admin 209; Doctor 349; Staff 361; Patient 189 |
| Patient Management | 0 | 0 | none |
| Reminder Management | 0 | 0 | none |
| Reports | 58 | 13 | Admin 58 |
| System Settings | 0 | 0 | none |
| User Management | 61 | 2 | Admin 61 |
| Visit Records | 0 | 0 | none |

The eight rows sum to 1,227 central events all time and 407 in the latest
seven-Manila-day window; every module's role counts sum to its all-time count.
Five modules have **zero central rows all time**. Their empty filters cannot be
explained solely by the default date range, pagination or another frontend
filter. This does **not** prove the underlying workflow never occurred, that
other domain ledgers are empty, or that no future producer exists. Authentication
has rows attributed to all four stored roles, including Patient, but this
aggregate does not show actions, outcomes or whether those rows came from the
current Patient login path. Reports and User Management rows are Admin-only in
this snapshot. No audit history was modified or backfilled.

The viewer's eight option values match the source table's canonical module CHECK.
Selecting a module adds one exact `module` predicate to the Admin RLS-protected
page and sample queries; **All Modules** adds none. The exact filtered count is
computed before ten-row pagination. The latest seven Manila calendar days are
selected by default, and all active user/role/action/status/search filters still
apply. A verified zero count therefore means **no matching visible central rows
for that query**, not proof that the underlying business action never occurred.
The empty state now shows the selected module and dates and suggests widening the
range or clearing other filters. Query errors and authorization failures have
their own states. No legacy category remapping was added: the repository table
CHECK already uses the eight canonical values, while the installed schema and any
actual legacy aliases have not been inspected. Guessing aliases could mislabel or
double-count history.

Next inspect the existing read-only diagnostic's `02_all_time` result for
action/status detail, then `06_functions`, `07_triggers`, `08_policies` and
`08_effective_table_privileges` for installed writer and access candidates.
The previous 972-row aggregate is historical evidence only. Installed writer
bodies, Auth Audit Logs settings, authenticated-role reads and actual transaction
outcomes remain pending authorized database/runtime verification.

## Verified frontend correction

`src/pages/admin/AdminAuditLogs.jsx` now displays Event ID and Actor ID in the
authorized details dialog. If a row has an actor UUID but a missing/placeholder
name, its table, User filter, and details use a short UUID label rather than
calling the person “System”; the full UUID appears in the details. A truly
unidentified row retains its stored name or System fallback. Existing role,
status, target, timestamp, source classification, pagination, date filtering,
details access gate, and metadata whitelist are unchanged. The table now includes
an explicit Status column with Activity, Module, affected record, description,
and the details action. Search, status, and sort use the existing server-side
page/count query; User ID search requires a complete UUID and text wildcards
are treated literally. The missing actor's
human name cannot be recovered safely from the central row when it was never
stored; adding a profile join needs a separate authorization/privacy review.

## Database work requiring separate approval

The smallest safe expansion for successful business mutations is a guarded,
transactional producer attached to their existing authorized RPC/table mutation
paths. It must derive `auth.uid()`/role server-side, emit fixed descriptions and
opaque linkage only after a real state transition, deduplicate one logical action,
roll back the audit insert with a failed mutation, and grant no new browser write
access. Preserve active-Admin SELECT, existing history, and the private Broadcast
channel. Never copy clinical form values, diagnoses, medication details, credentials,
Patient control numbers, or unrestricted metadata into the ledger.
Source grants/RLS prevent ordinary authenticated clients from directly updating
or deleting the ledger; they do not prove protection from privileged database
roles, accidental owner writes, or retention jobs in the installed project.

The **unapplied** source proposal
`docs/sql-drafts/20261019_admin_audit_business_producers.sql` covers nine
mutation sources for appointment changes, Staff/Doctor visit saves, registration
completion, reminders, Patient booking, and adherence. Its `UNREVIEWED` catalog
guard deliberately prevents installation. It depends on the separately reviewed
production security restriction in
`docs/sql-drafts/20261018_admin_audit_production_only_proposal.sql`; staging has
a distinct 16-column schema and private writer, so these production proposals
must not be applied there. See `docs/admin-audit-business-producers-review.md`
and `docs/admin-audit-hardening-rehearsal-plan.md` for object-level prerequisites,
security/performance/availability risks, and synthetic-JWT rollback/duplicate/RLS
verification gates.
The existing `audit_logs` fields already accommodate actor/role snapshots,
target, status, timestamp, and bounded metadata, so this review proposes no
replacement audit table or general-purpose schema expansion. The producer
draft's private receipts support deduplication and are not a second audit log.

The remaining gaps need their own narrow design after installed definitions and
actual workflows are confirmed: Patient Auth success/failure and activation,
Doctor/Staff/Patient logout, profile/security changes, administrative edits,
authorized medical/document reads, and audit-log access. Auth failures cannot
rely on an unauthenticated browser RPC; client reports before logout cannot prove
successful sign-out. A trusted Auth/server path and explicit event policy are
required. Read-access auditing must avoid every render/background refresh and
must not create recursive Audit Logs read events. The new selected-field search
uses ordinary RLS-protected reads. Combining several fields in one search or
indexing larger text searches would require a separate authorized query/index
review. Leading-wildcard `ILIKE` searches may become expensive on a much larger
ledger. CSV export remains deferred because the current module has no trusted
audit-export event producer or reviewed export policy; a page-only download
could be mistaken for complete history.

Before any database/security change: obtain fresh read-only installed catalog and
all-time role/module/action counts, compare exact functions/triggers/RLS/grants
with the reviewed baseline, approve a disposable environment with real role JWTs
and non-sensitive data, test success/failure/concurrency/rollback and no duplicate
or private payloads, then request separate approval for any production migration.
No historical events should be fabricated. Runtime role tests, authenticated
viewer interaction, and installed audit immutability remain pending.

## Verification of this frontend revision

- Offline audit suite: 58 scenarios / 404 assertions passed, including all eight
  canonical module filters and All Modules, exact count, role/status/search
  composition, wildcard escaping, stable sort order, authorization loss,
  pagination, and safe detail fields. This uses synthetic rows and does not
  establish that the installed database contains all eight categories.
- Dashboard refresh suite: 14 scenarios / 80 assertions passed. Business
  producer source-contract suite: 11 scenarios / 204 assertions passed; it does
  not execute SQL.
- Scoped ESLint for the changed JSX, hook, and test script; Vite production
  build; `git diff --check`; CSS parse/nine-column width check; and installed
  Supabase-client URL construction passed. The local Vite server on port 4173
  served the updated page, hook, and CSS with `Cache-Control: no-store`.
- No in-app browser session was available. Authenticated Admin interactions,
  visual desktop/tablet/mobile checks, real four-role events, installed grants,
  Auth Audit Logs settings, and transaction/rollback tests remain pending.
  Repository-wide ESLint previously failed on pre-existing generated Android
  assets; the changed source passed scoped ESLint.
