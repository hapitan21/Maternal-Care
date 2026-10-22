# Selected-patient PhilHealth reader — preparation only

Status: **NOT APPROVED FOR INSTALLATION OR FRONTEND ACTIVATION.** No SQL has been executed. The companion [SQL draft](sql-drafts/doctor-patient-philhealth-reader-REVIEW.sql) has an unconditional execution gate, a transaction, and a final ROLLBACK. Existing installation bundles and review gates are untouched.

## Established repository contracts

- `supabase/migrations/20261006120000_add_patient_philhealth_and_gtpal.sql` already defines nullable `patients.philhealth_member` (boolean) and `patients.philhealth_pin` (text), without backfilling historical patients. Registration maps `philHealthMember` and `philHealthPin` into these fields. No new column, PIN sentinel, or historical-data rewrite is needed.
- `supabase_patients_operational_rls_hardening.sql`, `get_doctor_patient_directory()`, authenticates an active Doctor but returns all patients; it has no patient-assignment predicate and does not return either PhilHealth field. The same source removes browser SELECT on `patients`. Neither a direct table fallback nor adding unsupported selected columns to the existing directory RPC is appropriate.
- `supabase/migrations/20260925214000_fix_assigned_doctor_visit_authorization.sql` checks the active authenticated Doctor against `schedule.doctor_id` for an exact appointment. This supports the proposed relationship check, but does not itself establish a Medical Records read policy.
- `src/pages/doctor/Doctor_Medical_Records.jsx` fetches the selected patient's directory row and ignores outdated requests through `patientRequestRef`. Its Overview uses the existing patient information card. No application change is part of this proposal.

These are repository-source findings, **not verification of deployed definitions, grants or policies**. The previously reported 77 Staff tests are existing evidence; they were not rerun or treated as proof of this new reader.

## Proposed boundary requiring approval

New object: `public.get_doctor_patient_philhealth_status(p_patient_id uuid)`. Output is exactly one row with `philhealth_member boolean` (nullable) and `philhealth_pin_recorded boolean` (non-null). It returns no PIN, credential, patient demographic or other clinical field. PIN presence means at least one non-whitespace character; it does not attest PIN validity or independently verified enrollment.

| Caller/context | Proposed result |
| --- | --- |
| Authenticated active Doctor assigned to this patient's pending, scheduled, checked-in, ready-for-Doctor or completed appointment | Read the two fields |
| Active Doctor with only an unrelated patient's appointment | Generic permission denial |
| Original author after all qualifying appointments have been reassigned | Deny; historical-author admission needs separate approval |
| Only cancelled, missed/no-show, deleted or unknown-state appointments | Deny |
| Inactive/missing-profile Doctor; Staff; Admin; Patient | Deny inside function, even though these roles share the authenticated database role |
| Anonymous or service-role caller | No function EXECUTE; no new privileged-service workflow is assumed |
| Null patient identifier | Reject; nonexistent and unauthorized identifiers otherwise receive the same permission error |

This is deliberately narrower than the directory reader. **Approve the relationship rule and status allowlist before implementation**; do not claim it reproduces a pre-existing all-Doctor read restriction. Existing appointments support Basic-only/unlinked patients without requiring Patient account activation. No patient-name matching, newest-row selection, or client-supplied actor identity is used. No separate Staff/Admin application access is added by this Doctor-only feature.

The function uses server `auth.uid()`, exact UUID joins, qualified relations, empty search path, STABLE SECURITY DEFINER and a proposed trusted `postgres` owner. It contains only SELECTs. SECURITY DEFINER requires these explicit checks because the owner can bypass RLS; existing table policies are not changed or assumed to filter this function. Authenticated EXECUTE is granted only on the new function; PUBLIC/anon/service_role execution is revoked on that function before a potential future commit. Owners/database administrators remain privileged and are outside the browser boundary.

**Security prerequisite:** verify deployed schedule grants, column grants, RLS, and mutation RPCs prevent callers from forging `doctor_id`/`patient_id` assignment. A relationship predicate is insufficient if a Doctor can self-assign another patient's appointment. Also verify protected profile role/status fields, unique `profiles.id`/`patients.id`, schedule foreign keys, function/schema ownership, and all inherited or reachable SET ROLE privileges (including default PUBLIC EXECUTE). The draft's effective EXECUTE checks include inherited permissions, but do not audit the complete SET ROLE graph. Unexpected privileges must block installation, not trigger unrelated automatic revocations.

A STABLE read observes a statement snapshot. A concurrent reassignment/deactivation after that snapshot may not cancel an in-flight response; subsequent requests must be denied. Frontend session guards prevent applying an old session's result, without claiming instantaneous database revocation.

## Minimal future frontend integration

Only after separate backend installation and activation approval:

1. Extend `src/pages/doctor/Doctor_Medical_Records.jsx` with an optional, separately enabled read after the selected patient's authorized directory fetch succeeds. Call the new signature with that exact patient's UUID. Do not change `patientSelectColumns` or the directory RPC's return contract.
2. Validate exactly one response row and strict boolean/null types. Keep loading/error state separate from existing patient details. Clear it on patient/session changes; bind the request to the initiating patient, authenticated Doctor and existing request generation. Ignore stale responses. Do not retain cross-session cached results or log response/request credentials.
3. Use the existing information card/InfoRow; preserve layout and unrelated content. Never fetch or render the PIN itself. Missing RPC, denial or network error displays unavailable, without breaking existing Medical Records or falling back to direct `patients` SELECT.

| Saved status | PIN presence | Overview text |
| --- | --- | --- |
| true | true | **PhilHealth: Yes — PIN recorded** |
| false | either | **PhilHealth: Not enrolled** |
| true | false | PhilHealth: Yes — PIN not recorded |
| null | either | PhilHealth: Not recorded |
| Not yet loaded / denied / malformed / failed | unknown | Loading / PhilHealth: Unavailable, as appropriate |

Null with a legacy PIN is still unknown enrollment. Missing PIN is never evidence of No. Boolean presence is not clinical/insurance verification. Staff's existing Yes/No selection and required PIN validation remain unchanged.

## Required validation before release (not yet executed)

- Compile the draft's proposed body in an independently approved disconnected fixture; do not remove this file's gate. Verify exact signature/output, owner, search path, STABLE/definer settings, effective EXECUTE, schema CREATE privileges, inherited memberships and reachable SET ROLE routes. Test actual Supabase JWT/PostgREST separately; a local `auth.uid()` stub is insufficient evidence.
- Synthetic positive/negative cases: assigned Doctor patient A allowed, patient B denied even with a known UUID; Staff/Admin/Patient/anon/inactive/missing actor denied; null and nonexistent IDs; each approved appointment status; reassignment/deactivation; attempted forged assignment; existing inactive/unlinked Patient accounts according to the approved clinical-read policy.
- Data cases: null/false/true membership; NULL/empty/space/tab/newline PIN; nonempty PIN; contradictory legacy values. Confirm output has exactly two fields, contains no PIN and causes no writes. Verify unrelated patient rows and existing reader behavior remain unchanged.
- Mocked React cases: all display strings above, missing/malformed/multiple rows, missing RPC and denied/network response, patient/session switching and late responses. Assert no PIN in DOM/logs, no cross-patient display, no new direct table access. Preserve Doctor's Order and run the existing Staff PhilHealth tests, scoped lint and build when frontend implementation is approved.

## Deployment prerequisites and rollback

Before installation: obtain approved read-only metadata for the intended target, confirm the above exact columns/types/keys, existing directory contract and authorization policies, trusted owner and role graph, supported appointment statuses, and absence of a conflicting new signature/overload. Approve the narrower clinical-read scope and resolve any forgeable assignment boundary first. Review the compiled candidate and runtime test results. A separate explicit approval is required for installation and frontend activation; this document is not that approval.

Rollback after a future approved implementation: disable only the new frontend integration first. After checking dependencies, separately authorize revoking the new function's execution and dropping **only** `public.get_doctor_patient_philhealth_status(uuid)` without CASCADE. No patient data, PINs, histories, appointments, existing RPCs, table grants or RLS policies need changing. The proposal itself writes no data and is not installed.

Files/objects needing implementation approval: the new function and its owner/EXECUTE ACL; the optional reader/state/InfoRow integration in `src/pages/doctor/Doctor_Medical_Records.jsx`; narrowly scoped reader/UI regression tests. No change is proposed to `get_doctor_patient_directory()`, Staff registration, existing installation manifests, historical migrations, or any of the 11 existing review gates.
