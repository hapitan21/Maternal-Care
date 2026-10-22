# Admin activity coverage and refresh review — October 19

Source review and offline synthetic tests only. No production/staging SQL, audit
writes, SMS, publication/RLS changes or deployments were performed. The reported
219 events (204 Authentication, 15 Reports) establish one selected date window,
not all-time coverage. Production results have not yet been collected.

## Verified sources and coverage limits

Both Admin pages read **public.audit_logs**. Its common projection uses id,
actor_user_id, actor_name, actor_role, module, action, status, entity_type, entity_id,
description, metadata, ip_address, created_at and request_id; the table also has
user_agent. Production has 15 columns; the supplied staging baseline adds event_origin.
Audit Logs safely falls back only when that optional column is missing. Full metadata
and user_agent are not fetched into the viewer. Source classification does not turn
a historical success/metadata marker into proof of a completed business transaction.

| Role/action | Repository producer evidence | Persisted coverage |
| --- | --- | --- |
| All four roles: successful login | `src/pages/auth/login.jsx:362` calls `recordAuditEvent` | Authentication rows reported in selected window; exact role split pending SQL |
| Admin logout | `src/context/AdminAuthContext.jsx:17` reports before sign-out | Pending counts; a report is not proof sign-out completed |
| Staff/Doctor/Patient logout | No corresponding central helper call found | Unverified; do not infer from absence in one week |
| Admin PDF/Excel export and print | `AdminReports.jsx:757` reports after report preparation | 15 Reports rows reported in selected window |
| Admin patient/Doctor/Staff account status changes | Three `admin_set_*_account_status` RPCs call audit writer after updates; Patient consistency migration preserves this | Known source producer; zero selected-range rows is not a bug by itself |
| Admin settings changes or other account operations | No central writer call in inspected settings frontend/RPC; status RPC coverage is not all account management | Installed producers and all-time counts pending |
| Staff registration, appointment lifecycle/check-in, assessment saves | No central audit helper or audit-writing business trigger found in inspected repository paths | Source coverage gap; installed coverage unverified |
| Doctor appointment/visit/record/reminder operations | No central audit producer found in inspected repository paths | Source coverage gap; installed coverage unverified |
| Patient activation, booking, adherence | No central audit producer found in inspected repository paths | Source coverage gap; installed coverage unverified |

Clinical records, appointment_events, notification/reminder/adherence ledgers and
Supabase's auth.audit_log_entries are independent stores. They are not silently
merged into audit_logs: their contents have different privacy, authorization and
event semantics. Existing records must not be fabricated or backfilled as verified
business successes merely to populate charts.

The original `record_audit_event` repository body derives the actor from auth.uid()
but accepts overly broad module/action claims with status=success. That makes actor
identity attributable without making every claimed business action trustworthy.
Keep the existing guarded production-only security proposal separate and unchanged;
its function hashes/15-column guards must not be bypassed. Verified staging instead
has its restricted client-report RPC and s4audit_private writer: retain them and
their permissions. This review does not certify either installed database's bodies.

## Filtering and Realtime findings

Audit Logs uses Manila midnight Oct 13 inclusive to Oct 20 exclusive, all selected
user/module/action filters, an exact page count and deterministic timestamp/id sort.
Charts/cards use a bounded analytics sample and show its truncation notice; a server
row cap can make chart totals smaller than exact totals. Synthetic 204+15 rows
produce exactly 219 total / 204 authentication / 0 access changes, and adding a
deactivation changes access to one. No evidence justifies changing this filtering.
Older pages deliberately show an updates notice rather than shifting while read.

Dashboard Recent Activities is the **global latest eight** audit rows. Its summary
date selector does not filter this widget. No login-only query or presentation
filter exists. A login-heavy last eight does not prove other categories are lost.

Both hooks already listen to private `admin:audit-logs`, event `audit_log_changed`.
They treat messages as invalidations and refetch records, never as trusted row data.
The repository INSERT publisher is `broadcast_admin_audit_log_change()` with an
active-Admin receive policy using `is_active_admin_realtime()`. Auth synchronizes the
JWT with realtime.setAuth. Private Broadcast publishing/receive permission is separate
from publishing audit_logs through Postgres Changes; do not enable a broad publication.
Dashboard also has 60-second polling/focus fallback; Audit Logs has focus/online/
visibility refresh plus its explicit Refresh button. Channel cleanup and trailing
refresh coalescing are preserved.

One confirmed frontend defect was reproduced: Dashboard suppressed permission errors
when a snapshot existed and kept cached activity visible. Local corrections clear
Dashboard caches, hide data on authorization errors or disabled Admin access, and
require successful fresh summary/activity reads before recovery. No successful
read of one component can repopulate caches while blocked. A separate visible status
now announces audit-channel failure and points to the existing Refresh button.
Other network/cache behavior and all business writes remain unchanged.

## One manual, read-only production batch

Open `docs/sql-drafts/admin-audit-production-readonly-diagnostics.sql` in the ORIGINAL
project SQL Editor. Run section 01 first to verify the table/columns, then the batch.
It contains only SELECTs and invokes no application RPC. It returns all-time and
selected-range counts, a privacy-safe latest-eight breakdown, optional-origin
classifications, function signatures/hashes/privileges, triggers without arguments,
redacted policy expressions, effective role/table/column privileges, and publication
inventory. No actor names/IDs, clinical records, phones, credentials, headers or
message payloads are returned. Catalog source-text matches are candidates, not proof
of executed writes; SQL Editor results are not authenticated-client RLS tests.

Interpret returned counts before changing producers. All-time business events absent
from one week imply a window difference. All-time absence plus no installed writer
candidates supports a coverage gap; inspect relevant installed bodies privately.
Compare selected-range totals with All Users/Modules/Actions in the frontend.
Concurrent inserts and analytics sampling can explain small differences.

## Approval-gated next steps

1. Review that read-only batch's results. Confirm private channel join status and
   sanitized error/reason without copying JWTs. SUBSCRIBED alone does not prove a
   publisher exists or that a newly persisted event is delivered.
2. Reuse the completed security review/rehearsal work; finish the remaining isolated
   JWT/Realtime gates before approving the guarded production security proposal.
   Do not replace staging's existing private writer or relax receive policies.
3. Only if installed coverage is genuinely missing, prepare narrowly scoped producer
   DDL against verified installed definitions. Prefer trusted transactional writes
   in existing authorized mutation RPCs or explicitly reviewed domain triggers.
   Derive actor from authenticated server context; emit after a verified transition,
   roll back audit with the mutation on failure, use stable event IDs, record minimal
   module/action/opaque entity linkage, and exclude clinical values/notes and patient
   identifiers wherever unnecessary. Do not add client-asserted success logging.
4. Approve isolated producer tests first (wrong role/patient, rollback, concurrency,
   duplicate claims, privacy and RLS), then any database installation separately.
   There is no executable coverage-expansion DDL in this review because the installed
   writer/mutation definitions and actual missing categories are still unverified.

Official references: https://supabase.com/docs/guides/realtime/authorization and
https://supabase.com/docs/guides/realtime/broadcast.
