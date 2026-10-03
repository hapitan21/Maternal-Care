import process from "node:process";
// Run: node scripts/verify-patient-native-push-retry-sql.mjs
// Real SQL: add --postgres with local psql and a dedicated empty test database.
// This source-bound model NEVER proves PostgreSQL locking/concurrency.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const retryMigrationPath = "supabase/migrations/20261003130000_patient_native_push_bounded_retries.sql";
const root = new URL("../", import.meta.url);
export function verifyRetrySql() {
  const sql = readFileSync(new URL(retryMigrationPath, root), "utf8");
  const claim = sql.slice(sql.indexOf("create function public.claim_patient"), sql.indexOf("create function public.list_due"));
  const initial = claim.slice(claim.indexOf("if p_mode = 'notification'"), claim.indexOf("elsif p_mode = 'retry'"));
  const retry = claim.slice(claim.indexOf("elsif p_mode = 'retry'"));
  assert.match(initial, /on conflict \(notification_id, device_id\) do nothing/i);
  assert.doesNotMatch(initial, /do update|update public/);
  for (const fragment of ["delivery.status = 'failed'", "delivery.last_failure_class = 'confirmed_transient'",
    "delivery.next_attempt_at <= v_now", "delivery.attempt_count < 4", "v_now < delivery.created_at + interval '30 minutes'",
    "device.patient_id = notification.patient_id", "device.platform = 'android' and device.enabled",
    "attempt_count = delivery.attempt_count + 1", "claim_token = pg_catalog.gen_random_uuid()", "attempted_at = v_now"]) {
    assert.ok(retry.includes(fragment), "Unrecognized retry SQL contract: " + fragment);
  }
  for (const field of ["last_failure_class", "next_attempt_at", "fcm_http_status", "error_code", "error_message", "provider_message_id", "sent_at"]) {
    assert.ok(retry.includes(field + " = null"), "Retry must clear " + field);
  }
  assert.doesNotMatch(retry, /created_at\s*=/);
  const finalize = sql.slice(sql.indexOf("create function public.finalize_patient"), sql.indexOf("revoke all on function public.claim"));
  for (const fragment of ["for update", "v_delivery.claim_token is distinct from p_claim_token",
    "v_delivery.attempt_count is distinct from p_attempt_count", "v_delivery.status <> 'processing'",
    "device.updated_at = p_device_updated_at", "device.patient_id = notification.patient_id",
    "60000 * pg_catalog.power", "pg_catalog.random() * 0.25", "v_deadline >= v_delivery.created_at + interval '30 minutes'"]) {
    assert.ok(finalize.includes(fragment), "Unrecognized finalization SQL contract: " + fragment);
  }
  assert.ok(finalize.indexOf("'stale_claim'") < finalize.indexOf("update public.patient_native_push_devices"));
  assert.ok(finalize.indexOf("'already_finalized'") < finalize.indexOf("update public.patient_native_push_devices"));
  assert.match(sql, /limit 10;/);
  assert.match(sql, /order by delivery.next_attempt_at, delivery.id/);
  assert.match(sql, /revoke insert, update on public.patient_notification_native_push_deliveries from service_role/);
  assert.equal((sql.match(/security definer set search_path = ''/g) || []).length, 4);
  assert.match(sql, /v_enabled is distinct from 'true'/);
  assert.match(sql, /v_url is distinct from v_project_url \|\| '\/functions\/v1\/send-patient-native-push'/);
  assert.doesNotMatch(sql, /create extension|vault.create_secret|alter table public.patient_native_push_devices|update public.patient_notification_native_push_deliveries[\s\S]*?where status = 'processing'/);
  // These fixture/source checks are not substitutes for executing PostgreSQL.
  const fixture = readFileSync(new URL("supabase/tests/patient_native_push_delivery_retry_test.sql", root), "utf8");
  const production = readFileSync(new URL("supabase/migrations/20261001120000_patient_native_push_devices.sql", root), "utf8");
  const trigger = production.slice(production.indexOf("create or replace function public.set_patient_native_push_devices_updated_at()"),
    production.indexOf("\nalter table public.patient_native_push_devices enable row level security;"));
  assert.ok(fixture.includes(trigger), "Fixture must reproduce the exact production updated_at function and trigger.");
  for (const fragment of ["'sent',1,200", "'failed',1,503", "'disabled_token',1,404", "'processing',1,null",
    "'failed',6,429", "'processing',7,500", "full join public.patient_notification_native_push_deliveries",
    "selected_device_updated_at", "production trigger advanced registration version in separate transaction",
    "error_code='DEVICE_DISABLE_FAILED'"]) assert.ok(fixture.includes(fragment), "Missing SQL fixture contract: " + fragment);
  assert.doesNotMatch(fixture, /update public\.patient_native_push_devices[^;]*updated_at\s*=/i);
  const runner = readFileSync(new URL(import.meta.url), "utf8");
  assert.ok(runner.includes("pg_catalog.pg_blocking_pids(") && runner.includes("wait_event_type='Lock'"),
    "Runner must observe actual PostgreSQL lock contention before releasing A.");
  return sql;
}
const uuid = n => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
export function createDeliveryLedger({ notifications, devices, now = () => Date.now() }) {
  const rows = new Map();
  let sequence = 8000, disableFailures = false;
  const canonical = (notificationId, deviceId) => {
    const notification = notifications.get(notificationId);
    const device = [...devices.values()].find(row => row.id === deviceId);
    return notification && device && notification.patient_id === device.patient_id
      && device.enabled && device.platform === "android" ? device : null;
  };
  const keyFor = (notificationId, deviceId) => JSON.stringify([notificationId, deviceId]);
  const claim = (notificationId, deviceId, mode) => {
    const key = keyFor(notificationId, deviceId);
    const current = rows.get(key);
    if (!canonical(notificationId, deviceId)) return null;
    if (mode === "notification") {
      if (current) return null;
      const timestamp = new Date(now()).toISOString();
      const row = { id: uuid(++sequence), notification_id: notificationId, device_id: deviceId,
        status: "processing", attempt_count: 1, claim_token: uuid(++sequence), attempted_at: timestamp,
        created_at: timestamp, updated_at: timestamp, last_failure_class: null, next_attempt_at: null,
        fcm_http_status: null, error_code: null, error_message: null, provider_message_id: null, sent_at: null };
      rows.set(key, row);
      return { delivery_id: row.id, claim_token: row.claim_token, attempt_count: row.attempt_count };
    }
    assert.equal(mode, "retry");
    if (!current || current.status !== "failed" || current.last_failure_class !== "confirmed_transient"
        || !current.next_attempt_at || Date.parse(current.next_attempt_at) > now() || current.attempt_count >= 4
        || now() >= Date.parse(current.created_at) + 1800000) return null;
    Object.assign(current, { status: "processing", attempt_count: current.attempt_count + 1,
      claim_token: uuid(++sequence), attempted_at: new Date(now()).toISOString(), updated_at: new Date(now()).toISOString(),
      last_failure_class: null, next_attempt_at: null, fcm_http_status: null, error_code: null,
      error_message: null, provider_message_id: null, sent_at: null });
    return { delivery_id: current.id, claim_token: current.claim_token, attempt_count: current.attempt_count };
  };
  const finalize = args => {
    const row = [...rows.values()].find(row => row.id === args.p_delivery_id);
    if (!row || !args.p_claim_token || row.claim_token !== args.p_claim_token || row.attempt_count !== args.p_attempt_count) {
      return { result: "stale_claim", status: null };
    }
    if (row.status !== "processing") return { result: "already_finalized", status: row.status };
    const category = args.p_failure_class;
    assert.ok(["success", "permanent_device", "confirmed_transient", "non_retryable", "unknown_outcome"].includes(category));
    let status = "failed", code = args.p_error_code, message = "FCM delivery failed.", deadline = null;
    if (category === "success") { status = "sent"; code = null; message = null; }
    if (category === "permanent_device") {
      const device = canonical(row.notification_id, row.device_id);
      if (!disableFailures && device?.updated_at === args.p_device_updated_at) {
        Object.assign(device, { enabled: false, disabled_at: new Date(now()).toISOString(), updated_at: new Date(now()).toISOString() });
        status = "disabled_token";
      } else { code = "DEVICE_DISABLE_FAILED"; }
    }
    if (category === "confirmed_transient") {
      assert.ok(args.p_http_status === 429 || (args.p_http_status === 500 && args.p_error_code === "INTERNAL")
        || (args.p_http_status === 503 && args.p_error_code === "UNAVAILABLE"));
      if (row.attempt_count < 4) {
        const next = now() + Math.max(60000 * 2 ** (row.attempt_count - 1), args.p_retry_after_ms || 0);
        if (next < Date.parse(row.created_at) + 1800000) deadline = new Date(next).toISOString();
      }
    }
    Object.assign(row, { status, fcm_http_status: args.p_http_status, error_code: code,
      error_message: message, provider_message_id: status === "sent" ? args.p_provider_message_id : null,
      sent_at: status === "sent" ? new Date(now()).toISOString() : null,
      last_failure_class: status === "sent" ? null : category, next_attempt_at: deadline,
      updated_at: new Date(now()).toISOString() });
    return { result: "finalized", status };
  };
  const due = () => [...rows.values()].filter(row => row.status === "failed"
    && row.last_failure_class === "confirmed_transient" && row.next_attempt_at
    && Date.parse(row.next_attempt_at) <= now() && row.attempt_count < 4
    && now() < Date.parse(row.created_at) + 1800000 && canonical(row.notification_id, row.device_id))
    .sort((a, b) => a.next_attempt_at.localeCompare(b.next_attempt_at) || a.id.localeCompare(b.id))
    .slice(0, 10).map(row => ({ notification_id: row.notification_id, device_id: row.device_id }));
  return { rows, claim, finalize, due, setDisableFailure(value) { disableFailures = value; } };
}

class RetrySqlSetupError extends Error {
  constructor(message) { super(message); this.name = "RetrySqlSetupError"; }
}

// Interactive psql stays open at a known transaction boundary. Only synthetic
// markers/counts/backend PIDs are read; no claim token or registration is printed.
export function createPsqlSession(args, { cwd, env, spawnProcess = spawn, timeoutMs = 20000 }) {
  const child = spawnProcess("psql", args, { cwd, env, windowsHide: true });
  const lines = [], waiters = new Set();
  let partial = "", failure = null, closed = false, resolveClosed;
  const closedPromise = new Promise(resolve => { resolveClosed = resolve; });
  const fail = message => {
    failure ||= new RetrySqlSetupError(message);
    for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(failure); }
    waiters.clear();
  };
  const deadline = setTimeout(() => {
    fail("Local psql session exceeded its bounded lifetime.");
    child.kill();
  }, timeoutMs);
  child.stdout.on("data", chunk => {
    partial += chunk.toString();
    if (partial.length + lines.join("").length > 32768) {
      fail("Local psql session exceeded the bounded output size."); child.kill(); return;
    }
    let newline;
    while ((newline = partial.indexOf("\n")) >= 0) {
      const line = partial.slice(0, newline).trim();
      partial = partial.slice(newline + 1);
      lines.push(line);
      for (const waiter of waiters) {
        if (!waiter.matches(line)) continue;
        clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(line);
      }
    }
  });
  child.stderr.resume();
  child.stdin.on("error", () => { fail("Local psql session input failed."); child.kill(); });
  child.on("error", () => {
    fail("Unable to start local psql session.");
    clearTimeout(deadline); resolveClosed();
  });
  child.on("close", code => {
    closed = true; clearTimeout(deadline);
    fail(code === 0 ? "Local psql session closed before a synchronization marker." : "Local psql session failed.");
    resolveClosed();
  });
  const send = sql => {
    if (failure || closed) throw failure || new RetrySqlSetupError("Local psql session is closed.");
    child.stdin.write(sql + "\n");
  };
  const waitFor = (marker, timeout = 6000) => {
    const matches = line => typeof marker === "string" ? line === marker : marker.test(line);
    const found = lines.find(matches);
    if (found !== undefined) return Promise.resolve(found);
    if (failure || closed) return Promise.reject(failure || new RetrySqlSetupError("Local psql session is closed."));
    return new Promise((resolve, reject) => {
      const waiter = { matches, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new RetrySqlSetupError("Local psql synchronization marker was not reached."));
      }, timeout);
      waiters.add(waiter);
    });
  };
  return {
    send, waitFor,
    hasMarker: marker => lines.includes(marker),
    async finish() {
      send("\\q"); child.stdin.end();
      await closedPromise;
      if (failure && failure.message !== "Local psql session closed before a synchronization marker.") throw failure;
    },
    async stop() {
      clearTimeout(deadline);
      if (!closed) { fail("Local psql session was stopped."); child.kill(); child.stdin.destroy(); }
      // Killing psql disconnects its backend and rolls back any uncommitted claim.
      let timer;
      await Promise.race([closedPromise, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]);
      clearTimeout(timer);
    },
  };
}

// Actual overlap is established by a third connection observing B waiting for
// a PostgreSQL lock held by A. Starting processes or delaying COMMIT is insufficient.
export async function verifyOverlappingClaims({ mode, openSession, observeBlock, timeoutMs = 6000 }) {
  assert.ok(mode === "notification" || mode === "retry", "Unknown concurrency claim mode.");
  const sessions = [];
  try {
    const a = openSession(); sessions.push(a);
    const b = openSession(); sessions.push(b);
    const settings = "SET statement_timeout='10s'; SET lock_timeout='8s'; SET idle_in_transaction_session_timeout='15s';";
    for (const session of sessions) session.send(settings + "\nSELECT 'backend:' || pg_catalog.pg_backend_pid();");
    const backendA = Number((await a.waitFor(/^backend:\d+$/)).slice(8));
    const backendB = Number((await b.waitFor(/^backend:\d+$/)).slice(8));
    if (!Number.isSafeInteger(backendA) || !Number.isSafeInteger(backendB) || backendA === backendB) {
      throw new RetrySqlSetupError("Independent local PostgreSQL backends were not established.");
    }
    const claim = "SELECT 'claims:' || count(*) FROM public.claim_patient_native_push_delivery("
      + "'00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','" + mode + "');";
    a.send("BEGIN;\n" + claim + "\n\\echo A_CLAIM_HELD");
    await a.waitFor("A_CLAIM_HELD");
    assert.equal(await a.waitFor(/^claims:\d+$/), "claims:1", "A must obtain the contested claim.");
    b.send("BEGIN;\n\\echo B_CLAIM_STARTED\n" + claim + "\n\\echo B_CLAIM_DONE");
    await b.waitFor("B_CLAIM_STARTED");
    const deadline = Date.now() + timeoutMs;
    let overlapped = false;
    while (Date.now() < deadline) {
      if (b.hasMarker("B_CLAIM_DONE")) break;
      if (await observeBlock(backendA, backendB)) { overlapped = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!overlapped) throw new RetrySqlSetupError("Synchronization failed: PostgreSQL never showed B blocked by open transaction A.");
    a.send("COMMIT;\n\\echo A_COMMITTED");
    await a.waitFor("A_COMMITTED");
    await a.finish();
    await b.waitFor("B_CLAIM_DONE");
    assert.equal(await b.waitFor(/^claims:\d+$/), "claims:0", "B must lose the claim after A commits and predicates recheck.");
    b.send("COMMIT;\n\\echo B_COMMITTED");
    await b.waitFor("B_COMMITTED");
    await b.finish();
  } finally {
    await Promise.allSettled(sessions.map(session => session.stop()));
  }
}

// Control-flow tests use fakes only. They are not SQL/concurrency execution.
export async function verifyConcurrencyOrchestration() {
  for (const [mode, scenario] of [
    ["notification", "success"], ["retry", "success"], ["retry", "no-overlap"],
    ["retry", "wrong-loser-count"], ["retry", "second-session-fails"],
  ]) {
    const state = { opened: 0, stopped: 0, held: false, started: false, observed: false, committed: false };
    const openSession = () => {
      const number = ++state.opened;
      if (scenario === "second-session-fails" && number === 2) throw new RetrySqlSetupError("Synthetic setup failure.");
      return {
        send(sql) {
          if (sql.includes("A_CLAIM_HELD")) state.held = true;
          if (sql.includes("B_CLAIM_STARTED")) state.started = true;
          if (sql.includes("A_COMMITTED")) {
            assert.equal(state.observed, true, "A cannot release before a proven observer barrier.");
            state.committed = true;
          }
        },
        async waitFor(marker) {
          if (typeof marker !== "string") {
            if (marker.source.startsWith("^backend:")) return "backend:" + (100 + number);
            return "claims:" + (number === 1 || scenario === "wrong-loser-count" ? 1 : 0);
          }
          if (marker === "B_CLAIM_DONE") assert.equal(state.committed, true);
          return marker;
        },
        hasMarker: () => scenario === "no-overlap",
        async finish() {},
        async stop() { state.stopped++; },
      };
    };
    const run = () => verifyOverlappingClaims({
      mode, openSession,
      async observeBlock(a, b) {
        assert.equal(a, 101); assert.equal(b, 102);
        assert.equal(state.held && state.started && !state.committed, true);
        state.observed = true; return true;
      },
    });
    if (scenario === "success") {
      await run(); assert.equal(state.observed && state.committed, true);
    } else {
      await assert.rejects(run, scenario === "wrong-loser-count" ? assert.AssertionError : RetrySqlSetupError);
      if (scenario !== "wrong-loser-count") assert.equal(state.committed, false);
    }
    assert.equal(state.stopped, scenario === "second-session-fails" ? 1 : 2, "Every opened session must be cleaned up.");
  }
}

async function realSql() {
  const runtime = spawnSync("psql", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  if (runtime.error || runtime.status !== 0) {
    console.log("REAL POSTGRES TESTS: NOT EXECUTED (psql is unavailable).");
    return;
  }
  const port = process.env.NATIVE_PUSH_TEST_PGPORT || "54322";
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new RetrySqlSetupError("Invalid isolated local test port.");
  }
  const args = ["--host=127.0.0.1", "--port=" + port, "--username=postgres",
    "--dbname=maternal_native_push_retry_test", "--no-psqlrc", "--no-password",
    "--set=ON_ERROR_STOP=1", "--tuples-only", "--no-align", "--quiet"];
  const cwd = fileURLToPath(root), env = { ...process.env, PGCONNECT_TIMEOUT: "5" };
  const serial = spawnSync("psql", [...args, "--set=allow_isolated_test=true",
    "--file=supabase/tests/patient_native_push_delivery_retry_test.sql"],
  { cwd, env, encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 100000 });
  if (serial.error || serial.status !== 0) {
    if (/Native retry SQL regression failed:/.test(serial.stderr || "")) assert.fail("Real local SQL fixture assertion failed.");
    throw new RetrySqlSetupError("Local SQL setup/contracts could not complete in the dedicated empty test database.");
  }
  console.log("PASS: real local SQL serial contracts, historical preservation and production-trigger rotation.");
  const run = (sql, timeout = 10000) => {
    const result = spawnSync("psql", [...args, "--command=" + sql],
      { cwd, env, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 32768 });
    if (result.error || result.status !== 0) throw new RetrySqlSetupError("Bounded local PostgreSQL observer/setup command failed.");
    return result.stdout.trim();
  };
  const pair = "notification_id='00000000-0000-4000-8000-000000000101' AND device_id='00000000-0000-4000-8000-000000000201'";
  const race = async mode => verifyOverlappingClaims({
    mode,
    openSession: () => createPsqlSession(args, { cwd, env }),
    observeBlock: (backendA, backendB) => run(
      "SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid=" + backendB
      + " AND state='active' AND wait_event_type='Lock' AND " + backendA
      + "=ANY(pg_catalog.pg_blocking_pids(" + backendB + ")));", 2000) === "t",
  });
  await race("notification");
  assert.equal(run("SELECT attempt_count FROM public.patient_notification_native_push_deliveries WHERE " + pair), "1");
  console.log("PASS: real PostgreSQL initial claim overlap observed; B loses after A commits.");
  run("UPDATE public.patient_notification_native_push_deliveries SET status='failed', last_failure_class='confirmed_transient',"
    + " attempted_at=now()-interval '70 seconds', next_attempt_at=now()-interval '1 second' WHERE " + pair + ";");
  await race("retry");
  assert.equal(run("SELECT attempt_count FROM public.patient_notification_native_push_deliveries WHERE " + pair), "2");
  console.log("PASS: real PostgreSQL retry UPDATE overlap observed; B rechecks and loses; one increment.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    verifyRetrySql();
    console.log("PASS: source-bound SQL/static contract verification (not PostgreSQL execution).");
    await verifyConcurrencyOrchestration();
    console.log("PASS: five barrier/cleanup control-flow tests with fakes (not PostgreSQL execution).");
    if (process.argv.includes("--postgres")) await realSql();
    else console.log("REAL POSTGRES TESTS: NOT EXECUTED; use --postgres on an isolated local test server.");
  } catch (error) {
    const kind = error instanceof RetrySqlSetupError ? "SETUP/SYNCHRONIZATION FAILURE"
      : error instanceof assert.AssertionError ? "ASSERTION FAILURE" : "VERIFIER FAILURE";
    console.error(kind + ": " + error.message);
    process.exitCode = 1;
  }
}
