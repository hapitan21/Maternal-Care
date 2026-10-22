# Checkpoint 4: Compose proposal ? preparation only

This supersedes the experimental-stack launch instructions. Checkpoints 1?3, the production-only security proposal, and the working Audit Logs UI remain unchanged. No Docker resource or database has been changed by this preparation. Approval flags are interlocks, not permission to proceed.

## Decision and exact impact

Use a NEW nonce-named Compose project alongside the existing stacks: five containers (database, Auth, REST, Realtime, Kong), two NEW project-owned bridge networks, and one NEW database volume. All five services join the internal `-net` bridge; only Kong also joins the non-internal `-gateway` bridge. Kong alone publishes **127.0.0.1:55421 -> 8000**. PostgreSQL, Auth, REST and Realtime have no host publication. Approved SQL would use container-local psql. Neither network is an external/shared Compose resource. No existing CP4 volume, protected container, or original project is adopted. Existing healthy, strict and experimental stacks stay in their current states.

The gateway addresses the observed internal-only bridge behavior: requested HostConfig port bindings existed, but effective NetworkSettings.Ports was empty. Adding a non-internal network gives Kong normal bridge connectivity (including possible outbound access); the other four services remain attached exclusively to the internal bridge. Both bridges carry this proposal's nonce label and localhost default-binding option. This is a source-only proposal: effective host publication still requires separately approved runtime verification. Never connect the existing healthy Kong to another network or edit/reseal an existing packet to apply this change.

The JSON Compose proposal and runtime manifest are in [admin-audit-cp4/](./admin-audit-cp4/). JSON is valid Compose/YAML syntax; use the GENERATED temporary packet, not the placeholder review template. Every image is pinned to its locally observed repository digest and has pull_policy=never. The source versions are PostgreSQL 17.11.0.002, Kong 2.8.1, Auth 2.197.0, PostgREST 16.4, and Realtime 2.140.3. This does not repeat or replace the passed exact-17.6 migration rehearsal.

No Compose conversion, container replacement, rename, volume copy, backup/restore, or data migration is necessary. Disk/RAM for five additional services is a remaining prerequisite. This additive approach preserves recovery options before the thesis defense.

## Dependencies and private configuration

- Database: the 9,642-byte db-start.sh is copied unchanged from the strict container's startup command (SHA-256 recorded in code/manifest). It writes the Supabase bootstrap schema, sets role passwords/JWT settings, and creates _realtime. The pinned image supplies initial Auth schema/auth.uid(), roles, and image migrations; these were found by read-only file inventory. **Starting this service executes upstream initialization SQL on the NEW volume.** Starting Auth and Realtime also runs their service migrations/tenant seed. This must be expressly included in startup approval. Audit setup.sql is separate and never mounted as an automatic init script.
- Database public environment: POSTGRES_USER=supabase_admin, POSTGRES_DB=postgres, POSTGRES_HOST=/var/run/postgresql, PGDATA=/var/lib/postgresql/data, JWT_EXP=3600. Private db.env supplies POSTGRES_PASSWORD, PGPASSWORD, JWT_SECRET. Auth connects as supabase_auth_admin, REST as authenticator, Realtime as supabase_admin. Fresh passwords are consistent across services; no original values are copied.
- The Compose definition lists EVERY selected non-secret environment variable. runtime-manifest.json lists EVERY private variable name per service. Image defaults remain supplied by the pinned images. Optional CLI OAuth, external SMTP/SMS, phone authentication, Edge Functions, Storage, Studio, analytics and pooler configuration is intentionally absent. Signup and notification hooks are disabled; only separately approved synthetic Admin API user creation is supported.
- private/auth.env contains the local database URI and fresh signing keys; private/rest.env contains its database URI and verifier JWKS; private/realtime.env contains database password, verifier JWKS/JWT secret, encryption key, secret-key base and metrics secret. A fresh ES256 pair plus HS256 legacy verifier preserves genuine Auth-issued user JWTs and legacy anon/service API-key compatibility. No key is production/staging-derived. API keys expire after 24 hours; do not patch/reseal expired credentials blindly.
- Private Kong configuration contains fresh anon/service API keys, key-auth, localhost CORS, and only Auth, REST and Realtime routes. Default anonymous Authorization is ADDED only when absent; existing user Authorization is never replaced. Realtime uses realtime-dev:4000/socket and /api. No REST admin, clinical, notification or function routes are exported.
- Aliases: db/db.supabase.internal; auth; rest; realtime/realtime-dev; kong/api.supabase.internal. These aliases and all service-to-service routes stay on the new internal bridge. Only Kong also joins the project gateway, without moving its internal aliases. Realtime DB_HOST=db, DB_IP_VERSION=ipv4; dependencies wait for healthy DB before service startup, and Kong waits for healthy Auth/REST/Realtime.
- Health checks: database TCP pg_isready; Auth /health; PostgREST --ready (connection pool/schema cache via unpublished admin port 3001); Realtime /api/ping; Kong process health. Ping alone does not establish tenant/private-channel readiness. WAL settings, roles, tenant migrations, realtime.send/realtime.messages and schema grants still need a separately approved catalog check before audit setup/users. Do not weaken the existing setup.sql guard if any prerequisite is missing.

Only the new workspace's db-start.sh and private/kong.json are bind-mounted, read-only. No repository mount, Docker socket mount, key dump, existing database directory or external volume is permitted. Docker Compose >=2.30 is required for raw env files; their embedded JSON must not be reinterpreted as dotenv quoting/interpolation.

## Confirmed Realtime restart evidence

The strict Realtime container exited with code 1, OOMKilled=false, repeatedly reporting **Failed to detect IP version for DB_HOST: nxdomain** during migration boot. Its DB_HOST is the old strict database container name, and that database is stopped. The observed failure is DNS resolution before authentication/migration. This does NOT prove that credentials, migration permissions or tenant setup will pass after DNS recovers. Nothing was restarted to test that hypothesis.

## A ? local files and offline review (no Docker)

On Windows use [prepare-admin-audit-cp4-windows.ps1](../../scripts/prepare-admin-audit-cp4-windows.ps1), reviewed and executed personally in **Windows PowerShell 5.1, non-elevated James** (SID `S-1-5-21-3618251315-97338079-3510826831-1001`). The old packets and DACL backup stay untouched. This wrapper creates a fresh nonce only at execution, then exclusively creates a new NTFS directory beneath James's LocalApplicationData/Temp using CreateDirectoryW with a protected **DACL-only** descriptor. Only James, SYSTEM and Administrators receive inheritable FullControl. No owner/SACL update, Set-Acl, privilege adjustment, existing-directory ACL change, or Docker command is used. Owner, three exact ACEs and empty-directory checks must pass before generating credentials.

The existing generator remains unchanged. A process-local TEMP/TMP parent makes all newly created packet files inherit the restricted Windows DACL; the wrapper restores both original environment values in finally. It validates all eleven files (ten sealed artifacts plus plan.json), all three directories, inherited permissions, James ownership, read-only handle access, ten hashes, the original manifest contract, and newly issued 24-hour API-key JWT expiries. Node failure diagnostics show only phase/type/code; original Windows exceptions are rethrown. Secrets never appear in output. SHA-256 sealing detects content changes against the plan; it is not a signature or a Windows permission guarantee.

**Preparation only, after reviewing the wrapper:**

```powershell
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath 'C:\Users\James Freian Hapitan\OneDrive\Desktop\maternal-care\maternal-app'
$cp4Preparation = & .\scripts\prepare-admin-audit-cp4-windows.ps1
if (!$cp4Preparation -or !$cp4Preparation.Packet) { throw 'STOP: No verified packet receipt.' }
$cp4 = $cp4Preparation.Packet
$cp4TempParent = $cp4Preparation.Parent
$cp4Preparation | Format-List
# STOP. No Docker preflight, startup, initialization, SQL, or synthetic users here.
```

If execution policy blocks the script, **stop and report it**; do not elevate or change/bypass policy. On any preparation failure, retain the new restricted parent/partial packet for diagnosis; no automatic deletion, permission repair or overwrite is attempted. Record exception type, native error code (if present), and path, never private contents. Any later approved retry creates a new nonce/parent. The old restored packet remains a separate artifact; its API-key JWTs expire October 19, 2026 at 04:52:57 Philippine time. Do not patch individual keys. Newly generated keys have their own expiry shown in the receipt; database passwords/signing secrets have no corresponding encoded expiry.

Because loadPlan intentionally requires the packet under os.tmpdir(), every **later separately approved** helper invocation must set both process TEMP and TMP to `$cp4TempParent`, and restore the previous values in finally. Keep the safe receipt/path for that approval. Do not move the packet or relax that identity guard. This change to process-local temporary paths does not change Docker Desktop settings.

Private files stay outside Git. POSIX mode 0600/0700 alone is NOT a Windows ACL guarantee. Never export full docker inspect, docker compose config, private env files, keys or JWTs to a transcript. Environment values take precedence in Compose: use the sealed generated configuration without overrides, extra -f files, --scale, service selection or changed project names. Normal-James preparation/ACL verification and later Docker Desktop bind-mount access have not been established by static tests; actual Docker preflight still requires separate approval.

Codex validation for this wrapper is limited to PowerShell/embedded-JavaScript parsing, static guard checks and synthetic ACL-validator cases in [verify-admin-audit-cp4-windows.ps1](../../scripts/verify-admin-audit-cp4-windows.ps1). It does not execute the wrapper, native directory creation or generator. The broader existing CP4 test script generates temporary credential fixtures and is intentionally not run for this static-only preparation task.

## B ? explicit approval required before ANY next Docker operation

First approve only Docker Compose version/config validation, cached-image availability, free port 55421, absence of the proposed container/network/volume names, private-file ACLs, and an unchanged protected-resource inventory. Compose config validation must be quiet to avoid displaying secrets. No startup/pull/SQL is included in that first approval. No launcher is implemented in the helpers.

Then review and separately approve creating ONLY the five new services/two new networks/new volume **and the upstream initialization SQL/service migrations described above**. Proposed scope after that approval: generated compose.json, exact generated project name, pull=never, no-build, no overrides. Do not run supabase start/stop/reset against this Compose packet, and do not change the original strict stack to recover it. Preserve the currently healthy stack and older resources; any port conflict or resource-capacity problem needs review, never automatic stop/cleanup.

After approved startup, the only helper Docker mode is an explicitly approved read-only inspection:

```powershell
node .\scripts\admin-audit-cp4.mjs inspect-compose $cp4 INSPECT_NEW_COMPOSE_RUNTIME
if ($LASTEXITCODE -ne 0) { throw 'Runtime failed identity/isolation/health verification; stop.' }
```

It checks the project-labeled inventory is exactly five containers, two networks and one volume; exact nonce-owned names/images; five healthy services; bridge drivers/internal flags; Compose-project and nonce network labels; all-five internal membership and Kong-only gateway membership; exclusive new volume; and expected read-only binds. Every container must have exactly its expected network attachments. The sole effective publication must be Kong's 127.0.0.1:55421 -> 8000/tcp in NetworkSettings.Ports; missing/empty mappings, wildcard/IPv6 bindings, extra ports, extra network members and unexpected project resources fail. HostConfig's requested mapping alone does not pass. It writes a secret-free inspection receipt. API tests/viewer require a matching receipt no older than five minutes and the sealed API origin plus database nonce marker. This receipt is a trusted local observation, not a cryptographic attestation or continuous monitoring.

For source-only network regression checks, run `node scripts/verify-admin-audit-cp4-networks.mjs` and `node scripts/verify-admin-audit-cp4-keys.mjs`. These use synthetic in-memory fixtures and never prepare a disk packet or invoke Docker. The broader existing CP4 suite prepares a scratch packet and is not part of the current no-packet approval. Existing single-network sealed packets do not satisfy the new contract; preserve them unchanged and obtain separate approval before generating a fresh packet under non-elevated James, then another approval before Docker preflight or startup.

## C ? separately approved audit SQL and synthetic tests

First review the new target's service/catalog prerequisites, then request approval for executing setup.sql ONCE on its new database only. Never replay Checkpoints 1?3 or the production migration. On uncertain outcomes inspect before retry; never reset a volume to make a test pass. Only after the nonce marker and RPC/RLS definitions are confirmed should synthetic-user/API testing be approved.

Load only MC_CP4_URL, MC_CP4_ANON_KEY and MC_CP4_SERVICE_KEY from the sealed private/client.env into process environment WITHOUT printing their values. Run the existing verify mode with CREATE_LOCAL_SYNTHETIC_USERS_AND_TEST, then the viewer mode with OPEN_LOCAL_AUDIT_VIEWER. The original test matrix remains: four real Auth identities/JWTs, Admin SELECT vs other roles' empty RLS reads, forbidden direct writes/internal writer access, own login/logout/Admin reports allowed as client-reported, forged business success denied, real private Broadcast delivery and refreshed-JWT delivery. Network failures/timeouts never count as authorization denials. A run-start marker blocks blind retries.

The actual Audit Logs page/Auth/hooks are mounted only in the isolated harness on 127.0.0.1:58973. Preserve manual Refresh tests with the Realtime connection blocked; verify filters/pagination, cached-data removal on sign-out/role changes, and fresh authorized recovery. No UI redesign or broad browser suite is needed.

## Rollback/recovery and go/no-go

Before startup: abandon the proposal without any Docker change. After an approved startup failure: with a NEW explicit approval, stop ONLY the nonce-owned Compose services, retain their volume, private packet and sanitized evidence; do not delete/reset data or touch older stacks/protected resources. Diagnose DNS, database availability/passwords, initialization logs, WAL/replication, schemas/grants and tenant health in that order. A restart reruns upstream behavior (including tenant seed); review its impact first. There is no production rollback because no production change is proposed.

**GO for local review/preparation only. NO-GO for execution until the separate Docker/config/startup/initialization approvals and readiness checks above.** Offline tests cannot prove actual Kong parsing, Docker Desktop internal-network publishing, fresh-volume initialization, ES256/JWKS interoperability or Realtime tenant delivery.

References: [Supabase Docker setup](https://supabase.com/docs/guides/self-hosting/docker), [PostgREST readiness](https://docs.postgrest.org/en/stable/references/admin_server.html), [Realtime seed](https://github.com/supabase/realtime/blob/v2.140.3/priv/repo/seeds.exs), [Kong request transformations](https://developer.konghq.com/plugins/request-transformer/).
