# October 18 hardening prerequisite and nine-producer rehearsal

Preparation only; no SQL, Docker, user creation, SMS or deployment executed.
Existing sealed packets, production proposal, producer hashes and UNREVIEWED guard
remain unchanged. Checkpoints 1–3 are not repeated.

Offline verification: business suite 11 scenarios/204 assertions, existing audit suite
50/251, Dashboard refresh suite 14/77: **75 scenarios/532 assertions, zero failures**.
Node syntax, scoped ESLint (zero errors/warnings) and git diff --check passed.
These are source contracts and JavaScript mocks, not database execution. No frontend
runtime changed, so the previous build was not repeated. All 124 unrelated pre-existing
paths, including both SQL proposals and sealed packages, retained their starting hashes.

## Hash finding: expected dependency, not a faulty hash

| State | LF-normalized `pg_proc.prosrc` MD5 | Evidence |
| --- | --- | --- |
| Original public record_audit_event | `a8589348a66eaf55796e3d217d98b29a` | Supplied production inventory; exact repository body in 20260928030000_profiles_security_stage1.sql |
| Restricted public record_audit_event | `efb73094d315918dc10777fb50dcbc23` | Recomputed from `$client$` body of 20261018_admin_audit_production_only_proposal.sql |

These hash the function BODY, not pg_get_functiondef or a whole SQL file. CRLF is
normalized to LF. The sealed rehearsal migration equals the October 18 proposal.
Production's supplied original hash cannot satisfy the producer's hardened prerequisite.
Do not replace either hash to make the draft install.

The exact prerequisite is the **complete, separately approved October 18 production
security proposal**, not just replacing the public wrapper: it requires the original
15 columns/six validated constraints, active-Admin SELECT protection, existing private
Broadcast trigger, and the four original function hashes/owners/search paths/grants.
It then restricts public claims to own login/logout and Admin report activities,
marks them `reported`/`client_reported`, creates the non-browser-callable internal
writer, and changes only the three trusted Admin status RPC audit calls to that writer.
The writer's success scope stays Admin account status; do not broaden it for new events.

After that prerequisite, inspect actual installed owner/search_path/EXECUTE privileges,
status CHECK, all three Admin status call sites, and the wrapper body hash **again**.
Collect the producer catalog fingerprint only AFTER hardening and source-fixture
setup; an original-baseline fingerprint is not the post-hardening baseline.
The producer's UNREVIEWED remains a hard STOP. No bypass or executable alternate path
is authorized. A separately reviewed, approved catalog-binding procedure is required
before any later trigger installation; no such binding has been made here.

## Findings and limits

- Verified diagnostic gap corrected locally: business_preflight.sql previously
  omitted `*_unchecked_v1` clinical helpers from its displayed privilege inventory.
  It now includes both facades and helpers. The fingerprint already included all
  public functions; its query and the producer guard are unchanged.
- Conditional coverage risk, not a proven production defect: the original visit-save
  body can fill a null schedule Doctor from auth.uid(), while the proposed clinical
  trigger requires equal schedule/record Doctor IDs. That legacy path would save
  without a central event. However, later repository facades enforce Doctor-only
  and assigned-Doctor access, which can reject the path before saving. Determine
  which facade and unchecked body are installed. Do NOT weaken the clinical predicate
  or declare Staff able to save Doctor visits from the old body alone. No trigger
  predicate, save handler or authorization has been changed in this review.
- A private trigger is observational: it does not repair weak business-table RLS or
  a callable unchecked clinical helper. Any installed Patient/Staff/wrong-Doctor bypass
  is a blocker for a separate security correction, not something an audit row fixes.
- Stable receipts cover creates, registration, adherence and canonical reschedules;
  update/cancel/check-in keys additionally use transaction identity. Two meaningful
  same-action edits in one transaction coalesce; a new business UUID is a new event.
  Source-ID reuse after delete can suppress another create. No exactly-once booking
  or delivery claim is justified. Concurrency and rollback remain untested in PostgreSQL.
- Audit errors intentionally abort their business transaction. Do not swallow them
  or silently skip expected human events to preserve a green result. Normal successful
  clinical saves must pass with auditing installed before deployment is considered.

## Smallest isolated plan — explicit approvals, no execution now

1. **Read-only target/definition checkpoint.** Prefer the already-approved healthy
   CP4 local Supabase runtime, only after proving its nonce/project/database/volume
   ownership, expiry-valid private credentials, existing seals and localhost endpoint.
   No restart, new stack, reset or protected-resource reuse is required by this plan.
   Do not use the distinct 16-column Maternal-Care-Staging project: these production
   drafts deliberately reject it and its s4audit_private writer. No production data,
   users or credentials may be copied. Preserve real Supabase auth.uid()/auth.role()
   and native Auth/PostgREST/Realtime; SQL role-switch stubs are insufficient.

2. **Approve only the missing fixture/setup work.** Inspect whether CP4 already has
   the hardened wrapper; if so do not rerun setup.sql or the October 18 migration.
   The current CP4 generator installs a minimal hardened audit schema, native Broadcast
   and profile fixture; it does NOT install the clinical/appointment/reminder business
   tables, mutation RPCs or three Admin status RPCs. It cannot alone test nine triggers.
   Prepare/review the minimum dependency closure of the INSTALLED business schemas,
   actual guarded RPC bodies, helper revocations, source RLS and constraints using
   synthetic data only. There are eleven primary inspected tables (nine trigger
   sources plus profiles/audit_logs); scheduling/availability RPCs may need additional
   verified dependencies. Do not replace them with permissive stubs or direct service
   writes and call the result an authorization test. Existing historical hardening
   rehearsal results stand; only remaining real-JWT integration is in scope.
   Keep reminder/event SMS flags off, omit live webhook/provider credentials, disable
   scheduling jobs and route all notification transports to local mocks/no outbound
   delivery. Review SQL/fixtures separately before any execution.

3. **Approve synthetic users, catalog binding and trigger rehearsal separately.**
   Minimum: Admin, Staff, Doctor and two Patients (four roles; second Patient proves
   ownership isolation). Add a second Doctor only if testing installed assignment
   boundaries requires it. Get genuine JWTs through local Auth; never print them or
   fabricate request.jwt claims. Pin reviewed artifact SHA-256s. Until the installed
   catalog is approved through the guard's review procedure, trigger execution stays
   blocked. Do not edit/reseal existing immutable runtime packets.

4. **Run only the new integration matrix after approval.**

| Gate | Required evidence |
| --- | --- |
| Public RPC | Each active role may report only its own login/logout; only Admin may report the supported export/print contracts. Rows are reported/client_reported, not business success. Reject foreign target, forged clinical/business success, arbitrary metadata, inactive/no-auth and invalid/expired JWTs. |
| Permissions | Authenticated roles, including Admin, cannot directly write central audit or receipts; cannot execute either internal writer/producer or any unchecked clinical bypass. Admin can SELECT; other roles see no audit rows and cannot read private receipts. A hidden RPC/404 alone does not prove EXECUTE denial: inspect effective privileges too. Transport/500/timeouts are failures, not successful authorization denials. |
| Existing Admin status | Confirm the three existing status RPCs still emit their authoritative audit event with current authenticated actor, in the same successful transaction, without duplicate public reports. |
| Appointment sources | Create via real Staff and Doctor RPCs; reschedule via canonical immutable event; authorized cancel/check-in via existing operation. Match one audit/receipt per actual mutation, no raw schedule time-update duplicate. Unsupported/wrong-role operations leave zero new rows. |
| Booking | Patient A submits own pending request: one booking-request event. Staff accepts: stored status accepted and one appointment-create event despite schedule INSERT plus request UPDATE. Test legacy schedule approval too. Rejected/failed submission/approval leaves no success audit. Patient B cannot submit or mutate A's records. |
| Staff saves | Initial and Follow-Up through save_staff_visit_intake: saved row and exactly one correctly typed event each. Unchanged retry (including new staffSavedAt) adds none; meaningful edits add update. Actor is current Staff, not retained staff_id from an earlier editor. Doctor/Patient attempts follow installed restrictions. |
| Doctor saves | Initial and Follow-Up through the installed guarded facade; direct authorized edits through the existing update path. Correct Patient/schedule/Doctor linkage; Patient/Staff/wrong assigned Doctor cannot bypass the installed contract. Test the null-Doctor legacy case against the ACTUAL facade and require either explicit denial or complete audit coverage of an allowed save. |
| Reminder sources | Doctor medication/appointment reminder create/edit/delete; inactivity is update. An occurrence-referenced medication DELETE must fail and add no delete audit or remove adherence. No audit of scheduler-only changes or claim that sending succeeded. |
| Adherence | Seed a notified occurrence privately, then Patient A uses the genuine mark RPC. One acknowledge event for taken/skipped without storing drug, dosage or response value. Patient B/wrong-role/repeat/direct-write attempts fail without a new event. Service setup writes never count as authenticated human evidence. |
| Privacy/UI | Assert fixed module/action/description, authentic actor UUID/profile role, safe opaque linkage, Patient-name masking and no clinical JSON in resulting audit/receipt payloads. Both Admin pages represent all new types with consistent exact totals and correctly labelled bounded chart samples. |

5. **Rollback/concurrency/availability gate.** In the disposable target only, test
   actual duplicate/no-op calls and concurrent accepted-request/reschedule/save calls.
   Count business rows, canonical events, receipts and audit rows separately; two
   genuinely different mutations are not duplicates. Roll back a mutation AFTER its
   trigger ran: business row, receipt and audit insertion must all disappear. Retry
   once after verified rollback: one successful event, no stale receipt suppression.
   Inject a controlled audit failure: expect atomic rollback and failure reported to
   the caller, never a false success. Then remove only the approved test fault and
   verify both Initial/Follow-Up Staff and Doctor saves succeed and retain values.
   Migration rollback uses a separately reviewed rollback-trial harness; do not wrap
   these BEGIN/COMMIT-bearing drafts in an outer transaction expecting ROLLBACK to
   undo their internal COMMIT. Preserve the original sealed proposals unchanged.

6. **Private Realtime and clinical-success gate.** Subscribe as Admin BEFORE a new
   committed business action; verify audit_log_changed on private admin:audit-logs
   invalidates/refetches actual rows in both pages. Payload must not fabricate a row.
   Verify no committed audit row/phantom UI activity from a rolled-back action;
   treat any invalidation as a signal to refetch, not proof of commit. Test denied
   Patient/Staff/Doctor subscriptions, reconnect and manual Refresh fallback.
   A controlled Broadcast delivery failure must leave the clinical save and central
   audit successful, using the existing publisher's exception handling. Separately
   fail the later pregnancy-summary sync: the already committed visit/audit remain,
   UI reports the partial sync correctly, and no blind save retry creates another row.

STOP on any unexpected clinical rollback, missing expected human event, permission
bypass, orphan/duplicate receipt, PHI leak or altered historical record. Preserve the
target and sanitized evidence; do not reset, widen permissions or disable assertions.
Only after these gates pass should production approval be considered, separately for
the October 18 prerequisite and the business extension. No deployment parity is claimed.
