# Admin Audit Logs reconciliation - October 18, 2026

Local work only. No SQL was executed against staging or production. No migration,
policy, grant, RPC, trigger, setting, notification, APK or deployment was changed.
Git remains release/maternal-care-oct23-2026 at 3d19aeb. This review continues the
existing October 18 implementation; it does not establish new audit coverage.

## Verified staging: retain the existing security boundary

The supplied staging results establish 16 audit columns, including event_origin;
active-Admin SELECT RLS; no authenticated direct table writes; a public audit RPC
restricted to own login/logout and Admin report claims; and a dedicated transactional
s4audit_private.record_account_status(text,text,text,text,text,jsonb,uuid) writer.
All three Admin status RPCs already call it. anon, authenticated and service_role
have neither schema USAGE nor function EXECUTE on that writer. Preserve both denials.
The event-origin CHECK admits client_reported/server_verified. Doctor and Staff
login records already exist. These protections address the original public-claim
vulnerability without the older proposal's replacement writer or reported status.

No staging audit SQL modification is proposed. In particular, do not replace its
private writer, add reported to its CHECK, or install the older production-shaped
proposal to make an offline test pass. The supplied findings do not include complete
raw installed function bodies here; they are the verified baseline, not newly fetched
or independently hash-certified definitions. Targeted runtime authorization tests
remain necessary before declaring the whole boundary proven end to end.

## Frontend compatibility

The page request first selects the common fields plus event_origin. Only an exact
missing-column response (42703/PGRST204 mentioning event_origin) permits one read
fallback to the common projection. Auth, network, other-column, table and repeated
errors remain errors. Each page load probes independently: production may make one
additional read per page/refresh; no schema capability is cached across projects.
No wildcard or full metadata object is fetched. Analytics/actor queries use only
common columns and do not need the optional column.

Dedicated client_reported origin is unverified even when status is success.
Dedicated server_verified is distinct from legacy metadata; reported plus
server_verified is flagged inconsistent. Unknown dedicated origins are unverified.
When the column is absent/null, reported or metadata.event_source=client_reported
is a client report; server_transaction is labelled a metadata marker, not proof.
Historical production metadata could have been supplied to the broad public RPC.
Neither status=success nor a historical marker proves a business operation occurred.

The existing filters use dates, actor, module and action, not success-only status.
Charts and exact totals count both reported and success rows, including client
reports; they are activity counts, not counts of verified completed transactions.
Existing Admin deactivate/reactivate action names, linked entities and whitelisted
previous/new status details remain supported. Generic Status rendering supports
reported without requiring staging to store it. Analytics remain bounded samples.

Manual Refresh, focus/online refresh, stale/error banners, stable page-two update
notices and modal authorization gates are retained. Auth failures invalidate all
three audit snapshot namespaces for that Admin, including PGRST302. A fresh zero
count also invalidates older cached pages: empty RLS results must not resurrect
previously visible rows when switching back. A zero result alone is not proof of
an active Admin role. Loss of isAdmin hides rows, counts, actors and the dialog.
Transient errors can still show explicitly stale, same-Admin cached data while
Admin authorization remains enabled. An offline cache is not a fresh permission
check; server-side role revocation is only observed on identity/data revalidation.

## Realtime: authorization and publishing are separate

Current viewer: private topic admin:audit-logs, Broadcast event audit_log_changed.
The Dashboard uses the same topic/event on its own route. useAuthenticatedAdmin
checks the authenticated user and active Admin profile, and synchronizes the JWT
with realtime.setAuth before publishing isAdmin. Auth events refresh the token;
a Realtime synchronization failure does not block ordinary authorized table reads.

Supabase private Broadcast receive permission is evaluated using realtime.messages
SELECT authorization for the connecting JWT/topic/extension. Sending permission is
separate; this viewer is a receiver and does not need authenticated INSERT access.
See https://supabase.com/docs/guides/realtime/authorization and
https://supabase.com/docs/guides/troubleshooting/realtime-messages-not-arriving.

The older diagnostics filtered policies by an audit-like name; that could miss
applicable policies. The revised SELECT-only batch lists ALL realtime.messages
policies plus RLS/owner/schema/table privileges and role bypass attributes. An empty
policy result alone is not a complete effective-access or runtime diagnosis.
With RLS enabled and a normal authenticated role without owner/bypass privileges,
no applicable receive policy predicts denial; confirm the actual channel response.
Do not switch to a public channel or add a permissive policy to suppress an error.

Capture the sanitized .subscribe(status, error) callback error, WebSocket phx_join
reply status/reason and any system/operational error, project ref, topic/event,
private=true, JWT role/expiry validity (never its token), and Realtime settings.
CHANNEL_ERROR/TIMED_OUT/CLOSED trigger a safe Refresh banner; SUBSCRIBED proves a
join, not the existence of a publisher or delivery of an audit change.

Staging has no audit table triggers, so the repository's INSERT-trigger publisher
is absent. It might have a separately configured publisher; verify rather than
assuming one. Without a publisher, this Broadcast subscription cannot deliver
new audit inserts even if authorized. Production already has a Broadcast trigger;
retain it. No staging publisher or authorization policy is proposed here. Manual
Refresh works regardless of either missing piece; focus/online are catch-up paths.

## Separate production-only correction candidate

sql-drafts/20261018_admin_audit_production_only_proposal.sql is a review candidate
for the verified 15-column production baseline, not an approved executable change.
It rejects event_origin, a non-15-column table, s4audit_private, and a missing expected
production Broadcast trigger. The four original exact function-body hashes,
SECURITY DEFINER/owner/search_path checks and exact CHECK transformation guard are
preserved. Those hashes come from repository SQL, not a new production inspection.
Installed production bodies, owners, ACLs, columns/types and CHECK must match the
reviewed baseline first. Any mismatch stops work; do not bypass the guards or copy
staging definitions into production. The candidate may deliberately refuse current
production until those differences are reviewed.

The candidate keeps the public signature, restricts it to active own-auth/Admin
report claims marked reported/client_reported, and moves the three Admin status
RPC audit calls to an unexposed trusted writer with success/server_transaction.
Their business bodies and grants are retained; an audit failure still rolls back
the status transaction. The CHECK expansion preserves other conditions verbatim.
No event_origin column, RLS change or Realtime change is proposed for production.
No history is relabelled or deleted. Existing clients keep the same RPC API.
There is no durable exactly-once guarantee or new registration, booking, clinical,
settings, SMS or FCM central audit coverage.

The old security_proposal.sql remains as a clearly superseded review artifact with
its original guards intact. The old staging_tests.sql assumes that older proposal;
its body is preserved behind an unconditional transaction-aborting guard. Do not
run it against verified staging or remove the guard to force a pass. The revised
staging_diagnostics.sql is SELECT-only, includes the private schema/writer, lists
all Realtime policies and groups counts by both origin representations without
returning personal identifiers or raw metadata. It has NOT been executed.

## Ordered staging verification plan and approval checkpoints

1. REVIEW CHECKPOINT: approve the local diff and confirm the separate project ref,
   staging frontend environment and synthetic identities. No DB change is needed.
   Reuse the verified definition dump; approve targeted SELECT diagnostics only
   where the existing dump lacks owner/ACL, Realtime RLS/grants or full policies.
2. READ-ONLY CHECKPOINT: authorize a staging-only viewer/session check as an active
   Admin and non-Admin; collect sanitized REST status/code/count and private join
   reply. Verify both source variants offline, staging client success classification,
   manual Refresh, empty results, filtered counts, page-two notice and cache hiding
   after sign-out/account switch/authorization loss. Never expose an Admin token.
3. SYNTHETIC-WRITE CHECKPOINT (separate explicit approval required): prepare/review
   tests against the installed staging bodies, then test own login/logout for four
   roles, Admin PDF/Excel/print, cross-user targets, non-Admin reports, forged business
   claims and sensitive metadata. Valid reports retain success/client_reported;
   rejected claims create no row. Missing/expired JWT must fail via the actual gateway.
   Check schema USAGE and private EXECUTE denials for all three API roles. On approved,
   isolated synthetic accounts only, test the three Admin status RPCs, no-op/invalid
   transitions and rollback: committed changes have server_verified rows; failed or
   rolled-back changes have none. Review triggers/external side effects before writes;
   SQL rollback does not guarantee reversal of external sends. Use no device tokens,
   notification/SMS tests, clinical submissions or production identities.
4. REALTIME DECISION CHECKPOINT: compare publisher configuration and join authorization.
   If automatic updates are required and a missing piece is confirmed, prepare a
   separate minimal active-Admin-only receive/publisher proposal and request approval.
   Manual Refresh remains the supported fallback. No permissive/public-channel fix.
5. PRODUCTION CHECKPOINT: separately approve read-only comparison of exact installed
   15-column production definitions/ACLs/constraints/trigger. Only after review,
   rehearse the guarded production candidate on an approved matching clone (not this
   staging project), including old-client compatibility and transactional failure.
   Any production application/deployment needs a new explicit approval and recovery
   snapshot. Do not restore the broad writer as an automatic rollback; it reopens
   the known claim-forgery vulnerability. Preserve historical reported rows if a
   future rollback is reviewed; never shrink the CHECK while such rows exist.

## Local verification

Focused mocked helper/hook/presentation and structural SQL tests cover both schema
variants, missing Realtime authorization, empty RLS responses, cached authorization,
filters, pagination, uncertainty and callers. Structural tests do not parse or execute
PostgreSQL and cannot certify installed grants or rollback. Final run counts and
lint/syntax/build results are recorded in the accompanying implementation report.
All database tests and real WebSocket authorization checks remain unexecuted.

Final local results: 50 focused scenarios / 251 assertions and 22 actual-page UI
assertions across four viewports passed, with zero failures. Scoped ESLint, five
JavaScript syntax checks, JSX parsing, diff whitespace checks and the production
web build passed. Build artifacts were directed to a new temporary directory;
existing dist and Android output were preserved. Only normal chunk-size warnings
remain. The single-query denial race is covered: late responses cannot repopulate
snapshots, filter changes cannot clear the denial, and only a complete successful
fresh refresh restores display. No production SQL syntax/runtime certification is
claimed by these offline tests.

## Isolated production rehearsal continuation

The user subsequently supplied direct production MATCH results for all four
previously repository-derived body hashes, plus the verified 15-column/six-validated-
constraint baseline. The new preparation is in
[rehearsal/admin-audit-production/README.md](rehearsal/admin-audit-production/README.md).
It preserves this staging project's implementation and uses a new network-isolated
synthetic PostgreSQL container only after explicit approval. The production proposal
now also checks every column name/type and the six validated constraints; all original
hash and CHECK guards remain. No SQL or container execution has occurred. The older
staging test abort guard is unchanged. Real JWT/PostgREST/Realtime tests remain a
separate approved local Supabase gate; SQL simulation does not certify them.
