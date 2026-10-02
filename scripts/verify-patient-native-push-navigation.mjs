// Run: node scripts/verify-patient-native-push-navigation.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as vm from "node:vm";
import {
  getSafePatientNativeNotificationTarget,
  getSafePatientNotificationTarget,
} from "../src/lib/patientNotificationRoutes.js";

// The isolated module mocks need Node's VM module flag; keep the normal run
// command usable without changing package scripts or production imports.
if (!vm.SourceTextModule) {
  const result = spawnSync(process.execPath, [
    "--experimental-vm-modules", ...process.execArgv, ...process.argv.slice(1),
  ], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
const { createContext, SourceTextModule, SyntheticModule } = vm;

const source = readFileSync(new URL("../src/lib/patientNativePushNavigation.js", import.meta.url), "utf8");
const notificationId = "00000000-0000-4000-8000-000000000001";
const otherNotificationId = "00000000-0000-4000-8000-000000000002";
const patientId = "00000000-0000-4000-8000-000000000003";
const otherPatientId = "00000000-0000-4000-8000-000000000006";
const session = (suffix, sessionSuffix = suffix, tokenVersion = 0) => ({
  user: { id: `00000000-0000-4000-8000-00000000000${suffix}` },
  access_token: `test.${Buffer.from(JSON.stringify({
    session_id: `00000000-0000-4000-8000-00000000001${sessionSuffix}`,
    token_version: tokenVersion,
  })).toString("base64url")}.test`,
});
const activeSession = session(4);
const otherSession = session(5);
const action = (id = notificationId, route = "/patient/appointments", type = "appointment_reminder") => ({
  actionId: "tap",
  notification: { data: { notification_id: id, notification_type: type, route } },
});
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function harness(t, {
  retained = true, listenerFailure = false, observerFailure = false,
  role = "patient", omitRole = false, account = { patient: { id: patientId }, status: "active" },
} = {}) {
  let now = 0;
  let timerId = 0;
  let authCallback;
  let tapCallback;
  let dispose;
  let currentSession = activeSession;
  let observerAlive = false;
  let listenerAlive = false;
  let mounted = false;
  let owned = true;
  let notificationGate;
  let consumerMounted = true;
  const timers = new Map();
  const events = new Map();
  const pushEvents = new Map();
  const faults = new Map();
  const records = new Map([notificationId, otherNotificationId]
    .map((id) => [id, { id, patient_id: patientId }]));
  const calls = [];
  const queries = [];
  const navigations = [];
  const writes = [];
  const storageCalls = [];
  const takeFault = (stage) => faults.get(stage)?.shift();
  const rejectWrite = (operation) => {
    writes.push(operation);
    throw new Error(`Native navigation attempted a write: ${operation}`);
  };
  const storage = (name) => new Proxy({
    getItem: () => { storageCalls.push(`${name}.getItem`); return null; },
    setItem: () => storageCalls.push(`${name}.setItem`),
    removeItem: () => storageCalls.push(`${name}.removeItem`),
    clear: () => storageCalls.push(`${name}.clear`),
  }, { set: () => { storageCalls.push(`${name}.assignment`); return true; } });
  const localStorage = storage("localStorage");
  const sessionStorage = storage("sessionStorage");
  const eventTarget = (name) => ({
    addEventListener: (event, callback) => events.set(`${name}:${event}`, callback),
    removeEventListener: (event) => events.delete(`${name}:${event}`),
  });
  const window = {
    ...eventTarget("window"),
    localStorage, sessionStorage,
    setTimeout: (callback, delay) => {
      timers.set(++timerId, { callback, due: now + delay });
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  const document = { ...eventTarget("document"), visibilityState: "visible" };
  const supabase = {
    rpc: () => rejectWrite("rpc"),
    auth: {
      onAuthStateChange: (callback) => {
        if (observerFailure) throw new Error("Auth observer startup failed");
        authCallback = callback;
        observerAlive = true;
        return { data: { subscription: { unsubscribe: () => { observerAlive = false; } } } };
      },
      getSession: async () => {
        calls.push("getSession");
        return { data: { session: currentSession }, error: takeFault("getSession") ?? null };
      },
      getUser: async () => {
        calls.push("getUser");
        return { data: { user: currentSession?.user }, error: takeFault("getUser") ?? null };
      },
    },
    from: (table) => {
      const query = { table, filters: [] };
      queries.push(query);
      const builder = {
        insert: () => rejectWrite("insert"),
        update: () => rejectWrite("update"),
        upsert: () => rejectWrite("upsert"),
        delete: () => rejectWrite("delete"),
        select: (columns) => { query.columns = columns; return builder; },
        eq: (column, value) => { query.filters.push([column, value]); return builder; },
        maybeSingle: async () => {
          if (table === "profiles") return { data: omitRole ? {} : { role }, error: takeFault("profiles") ?? null };
          assert.equal(table, "patient_notifications");
          const gate = notificationGate;
          notificationGate = undefined;
          if (gate) {
            gate.entered.resolve();
            await gate.promise;
          }
          const id = query.filters.find(([column]) => column === "id")?.[1];
          const owner = query.filters.find(([column]) => column === "patient_id")?.[1];
          const record = records.get(id);
          return {
            data: owned && record?.patient_id === owner ? { id: record.id } : null,
            error: takeFault("patient_notifications") ?? null,
          };
        },
      };
      return builder;
    },
  };
  const mocks = {
    "@capacitor/core": { Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => "android",
      isPluginAvailable: () => true,
    } },
    "@capacitor/push-notifications": { PushNotifications: {
      addListener: (event, callback) => {
        assert.equal(event, "pushNotificationActionPerformed");
        if (listenerFailure) return Promise.reject(new Error("Native listener startup failed"));
        listenerAlive = true;
        tapCallback = callback;
        pushEvents.set(event, callback);
        if (retained) callback(action());
        return Promise.resolve({ remove: async () => { listenerAlive = false; pushEvents.delete(event); } });
      },
    } },
    "./supabaseClient": { supabase },
    "./patientAuthLinking": {
      getCurrentPatientAccountStatus: async () => {
        calls.push("getCurrentPatientAccountStatus");
        const fault = takeFault("account");
        if (fault) throw fault;
        return account;
      },
      isMissingPatientAuthSession: (error) => error?.missingAuthSession === true,
    },
    "./patientAccountStatus": { patientAccountStatuses: { active: "active" } },
    "./patientNotificationRoutes": { getSafePatientNativeNotificationTarget },
  };
  const context = createContext({
    window,
    document, localStorage, sessionStorage,
    Date: class extends Date { static now() { return now; } },
    atob: (value) => Buffer.from(value, "base64").toString("utf8"),
  });
  // A VM-only accessor proves the real module retains only safe pending fields.
  // This export is never added to production source or exposed by the app.
  const module = new SourceTextModule(`${source}\nexport const inspectPendingTapForTest = () => pendingTap;`, {
    context,
    initializeImportMeta: (meta) => { meta.hot = { dispose: (callback) => { dispose = callback; } }; },
  });
  await module.link((specifier) => {
    assert.ok(Object.hasOwn(mocks, specifier), `Unexpected import: ${specifier}`);
    const exports = mocks[specifier];
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  const api = module.namespace;
  const bootstrap = api.startPatientNativePushNavigation();
  assert.equal(api.startPatientNativePushNavigation(), bootstrap);
  void bootstrap.then(() => { mounted = true; });
  await flush();
  t.after(() => {
    dispose();
    assert.equal(timers.size, 0, "Cleanup must clear all timers");
    assert.equal(observerAlive, false);
    assert.equal(listenerAlive, false);
    assert.equal(events.size, 0);
    assert.equal(api.hasPendingPatientNativePushNavigation(), false);
    assert.equal(pushEvents.size, 0);
    assert.deepEqual(writes, [], "Receipt, tap and navigation must never mark read or write");
    assert.deepEqual(storageCalls, [], "Pending taps must remain in memory, without browser storage");
  });
  return {
    api, bootstrap, calls, queries, navigations, timers, writes, storageCalls, pushEvents,
    get mounted() { return mounted; },
    get observerAlive() { return observerAlive; },
    get listenerAlive() { return listenerAlive; },
    emit: (event, nextSession) => { currentSession = nextSession; authCallback(event, nextSession); },
    tap: (id, route, type) => tapCallback(action(id, route, type)),
    deliver: (payload) => tapCallback(payload),
    receive: (payload) => pushEvents.get("pushNotificationReceived")?.(payload),
    setSessionSilently: (nextSession) => { currentSession = nextSession; },
    setAccount: (nextAccount) => { account = nextAccount; },
    setRecordOwner: (id, owner) => records.set(id, { id, patient_id: owner }),
    failNext: (stage, error) => {
      if (!faults.has(stage)) faults.set(stage, []);
      faults.get(stage).push(error);
    },
    setMounted: (value) => { consumerMounted = value; },
    online: () => events.get("window:online")?.(),
    visibility: (value, dispatch = true) => {
      document.visibilityState = value;
      if (dispatch) events.get("document:visibilitychange")?.();
    },
    jumpClock: (milliseconds) => { now += milliseconds; },
    denyOwnership: () => { owned = false; },
    pauseOwnership: () => {
      notificationGate = { ...deferred(), entered: deferred() };
      return notificationGate;
    },
    dispose,
    tick: async (milliseconds) => {
      const target = now + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.due <= target)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.due;
        timers.delete(id);
        timer.callback();
      }
      now = target;
      await flush();
    },
    consume: (overrides = {}) => api.consumePatientNativePushNavigation({
      userId: currentSession?.user.id,
      patientId: account.patient?.id,
      pathname: "/patient/dashboard", search: "", hash: "",
      navigate: (route, options) => navigations.push({ route, replace: options.replace }),
      isMounted: () => consumerMounted,
      ...overrides,
    }),
    acknowledge: (overrides = {}) => api.acknowledgePatientNativePushNavigation({
      userId: currentSession?.user.id, patientId: account.patient?.id,
      pathname: "/patient/appointments", search: "", hash: "", ...overrides,
    }),
  };
}

async function expectNoNavigation(h) {
  await h.api.verifyPendingPatientNativePushNavigation();
  await h.consume();
  assert.equal(h.api.hasPendingPatientNativePushNavigation(), false);
  assert.equal(h.api.canOpenPatientNativePushWorkspace(), false);
  assert.equal(h.navigations.length, 0);
}

await test("INITIAL_SESSION(active) before timeout preserves retained tap ordering and ownership authorization", async (t) => {
  const h = await harness(t);
  assert.equal(h.api.hasPendingPatientNativePushNavigation(), true);
  h.emit("SIGNED_IN", activeSession);
  await h.api.verifyPendingPatientNativePushNavigation();
  assert.equal(h.mounted, false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.queries.length, 0);
  await h.tick(4_999);
  h.emit("INITIAL_SESSION", activeSession);
  await h.bootstrap;
  assert.equal(h.mounted, true);
  assert.equal(h.timers.size, 1, "Only pending tap expiry remains after normal bootstrap");
  await h.tick(1);
  await h.api.verifyPendingPatientNativePushNavigation();
  assert.equal(h.api.canOpenPatientNativePushWorkspace(), true);
  assert.equal(h.navigations.length, 0, "Ownership must be verified before navigation");
  assert.deepEqual(h.queries.find((query) => query.table === "patient_notifications").filters,
    [["id", notificationId], ["patient_id", patientId]]);
  await h.consume();
  assert.deepEqual(h.navigations, [{ route: "/patient/appointments", replace: true }]);
  h.api.acknowledgePatientNativePushNavigation({
    userId: activeSession.user.id, patientId, pathname: "/patient/appointments", search: "", hash: "",
  });
  assert.equal(h.api.hasPendingPatientNativePushNavigation(), false);
  assert.equal(h.timers.size, 0);
});

await test("INITIAL_SESSION(null) before timeout mounts App and discards the retained tap", async (t) => {
  const h = await harness(t);
  h.emit("INITIAL_SESSION", null);
  await h.bootstrap;
  assert.equal(h.mounted, true);
  assert.equal(h.timers.size, 0);
  await h.tick(5_000);
  h.emit("SIGNED_IN", activeSession);
  await expectNoNavigation(h);
  assert.equal(h.calls.length, 0);
});

await test("No INITIAL_SESSION resolves bootstrap at five seconds and keeps the auth observer alive", async (t) => {
  const h = await harness(t, { retained: false });
  await h.tick(4_999);
  assert.equal(h.mounted, false);
  await h.tick(1);
  await h.bootstrap;
  assert.equal(h.mounted, true);
  assert.equal(h.observerAlive, true);
  assert.equal(h.listenerAlive, true);
  assert.equal(h.timers.size, 0);
  await expectNoNavigation(h);
  assert.equal(h.calls.length, 0, "Timeout must never rescue navigation via getSession");
});

await test("Retained tap -> timeout -> manual SIGNED_IN cannot restore the old destination", async (t) => {
  const h = await harness(t);
  h.emit("SIGNED_IN", activeSession);
  await h.tick(5_000);
  assert.equal(h.mounted, true);
  assert.equal(h.api.hasPendingPatientNativePushNavigation(), false);
  h.emit("SIGNED_IN", otherSession);
  h.tap(otherNotificationId);
  await expectNoNavigation(h);
  assert.equal(h.calls.length, 0);
  assert.equal(h.queries.length, 0);
});

await test("Timeout -> delayed INITIAL_SESSION(active) discards old and unresolved taps, then accepts fresh taps", async (t) => {
  const h = await harness(t);
  await h.tick(5_000);
  h.tap(otherNotificationId);
  h.emit("INITIAL_SESSION", activeSession);
  await expectNoNavigation(h);
  assert.equal(h.calls.length, 0);
  h.tap(otherNotificationId);
  await h.api.verifyPendingPatientNativePushNavigation();
  await h.consume();
  assert.deepEqual(h.navigations, [{ route: "/patient/appointments", replace: true }]);
  assert.equal(h.queries.filter((query) => query.table === "patient_notifications")
    .every((query) => query.filters[0][1] === otherNotificationId), true);
});

await test("A tap during fail-closed unresolved auth cannot survive into later manual login", async (t) => {
  const h = await harness(t, { retained: false });
  await h.tick(5_000);
  h.tap();
  h.emit("SIGNED_IN", activeSession);
  await expectNoNavigation(h);
  h.emit("INITIAL_SESSION", null);
  h.emit("SIGNED_IN", activeSession);
  await expectNoNavigation(h);
  assert.equal(h.calls.length, 0);
  h.tap(otherNotificationId);
  await h.api.verifyPendingPatientNativePushNavigation();
  await h.consume();
  assert.equal(h.navigations.length, 1);
});

await test("Native listener startup failure still settles bootstrap", async (t) => {
  const h = await harness(t, { listenerFailure: true });
  await h.bootstrap;
  assert.equal(h.mounted, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.observerAlive, false);
  await expectNoNavigation(h);
});

await test("Auth observer startup failure settles bootstrap and clears its timer", async (t) => {
  const h = await harness(t, { observerFailure: true });
  await h.bootstrap;
  assert.equal(h.mounted, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.listenerAlive, false);
  await expectNoNavigation(h);
});

await test("HMR cleanup before timeout settles bootstrap and ignores a stale timeout callback", async (t) => {
  const h = await harness(t);
  const staleTimeout = [...h.timers.values()].find((timer) => timer.due === 5_000).callback;
  h.dispose();
  await h.bootstrap;
  assert.equal(h.mounted, true);
  assert.equal(h.timers.size, 0);
  staleTimeout();
  await expectNoNavigation(h);
});

await test("Normal bootstrap cancels its timeout and preserves background tap navigation", async (t) => {
  const h = await harness(t, { retained: false });
  h.emit("INITIAL_SESSION", activeSession);
  await h.bootstrap;
  assert.equal(h.timers.size, 0);
  await h.tick(5_000);
  h.tap();
  await h.api.verifyPendingPatientNativePushNavigation();
  await h.consume();
  assert.equal(h.navigations.length, 1);
});

await test("Account switching invalidates ownership verification already in flight", async (t) => {
  const h = await harness(t);
  h.emit("INITIAL_SESSION", activeSession);
  await h.bootstrap;
  const gate = h.pauseOwnership();
  const verification = h.api.verifyPendingPatientNativePushNavigation();
  await gate.entered.promise;
  assert.ok(h.queries.some((query) => query.table === "patient_notifications"));
  h.emit("SIGNED_IN", otherSession);
  gate.resolve();
  await verification;
  await expectNoNavigation(h);
});

await test("Logout invalidates in-flight navigation and blocks further taps", async (t) => {
  const h = await harness(t);
  h.emit("INITIAL_SESSION", activeSession);
  await h.bootstrap;
  await h.api.verifyPendingPatientNativePushNavigation();
  const gate = h.pauseOwnership();
  const navigation = h.consume();
  await gate.entered.promise;
  h.api.cancelPatientNativePushNavigationBeforeLogout();
  h.tap(otherNotificationId);
  gate.resolve();
  await navigation;
  h.emit("SIGNED_OUT", null);
  await expectNoNavigation(h);
});

await test("Ownership denial discards the tap without navigation", async (t) => {
  const h = await harness(t);
  h.emit("INITIAL_SESSION", activeSession);
  await h.bootstrap;
  h.denyOwnership();
  await expectNoNavigation(h);
});

await test("Unsafe native routes still use the sanitized Dashboard fallback", async (t) => {
  const h = await harness(t, { retained: false });
  h.emit("INITIAL_SESSION", activeSession);
  await h.bootstrap;
  h.tap(notificationId, "https://example.invalid/unsafe");
  await h.api.verifyPendingPatientNativePushNavigation();
  await h.api.consumePatientNativePushNavigation({
    userId: activeSession.user.id, patientId, pathname: "/patient/appointments", search: "", hash: "",
    navigate: (route, options) => h.navigations.push({ route, replace: options.replace }),
    isMounted: () => true,
  });
  assert.deepEqual(h.navigations, [{ route: "/patient/dashboard", replace: true }]);
});

// Phase 6 contract tables deliberately specify expectations independently of
// the production route map. Each integration case requires ownership twice:
// before the workspace opens and again immediately before navigation.
const nativeRoutes = [
  ["appointment_created", "/patient/appointments"],
  ["appointment_reminder", "/patient/appointments"],
  ["appointment_rescheduled", "/patient/appointments"],
  ["appointment_cancelled", "/patient/appointments"],
  ["medication_reminder", "/patient/reminders/medications"],
  ["doctor_reminder", "/patient/reminders"],
  ["health_tip", "/patient/reminders"],
  ["medical_record_available", "/patient/medical-records"],
  ["laboratory_result_available", "/patient/medical-records"],
  ["prescription_available", "/patient/medical-records"],
  ["account_notification", "/patient/profile"],
  ["general", "/patient/dashboard"],
];

async function ready(t, options = {}) {
  const h = await harness(t, { retained: false, ...options });
  h.emit("INITIAL_SESSION", activeSession);
  await h.bootstrap;
  return h;
}

function ownershipQueries(h) {
  return h.queries.filter((query) => query.table === "patient_notifications");
}

function assertOwnership(h, id = notificationId, owner = patientId, count = 2) {
  const queries = ownershipQueries(h);
  assert.equal(queries.length, count, "Every verification must query ownership");
  for (const query of queries) {
    assert.equal(query.columns, "id", "Ownership lookup must retrieve only the opaque ID");
    assert.deepEqual(query.filters, [["id", id], ["patient_id", owner]]);
  }
}

for (const [type, target] of nativeRoutes) {
  await test(`Native route matrix: ${type} -> ${target}`, async (t) => {
    const h = await ready(t);
    h.tap(notificationId, target, type);
    assert.equal(h.navigations.length, 0);
    await h.api.verifyPendingPatientNativePushNavigation();
    assert.equal(h.api.canOpenPatientNativePushWorkspace(), true);
    assert.equal(h.navigations.length, 0, "Verification alone cannot navigate");
    assertOwnership(h, notificationId, patientId, 1);
    await h.consume({ pathname: target === "/patient/dashboard" ? "/patient/appointments" : "/patient/dashboard" });
    assert.deepEqual(h.navigations, [{ route: target, replace: true }]);
    assertOwnership(h);
    h.acknowledge({ pathname: target });
    assert.equal(h.api.hasPendingPatientNativePushNavigation(), false);
  });
}

await test("Strict route matching accepts only each type's exact Patient route", () => {
  const candidates = [...new Set(nativeRoutes.map(([, target]) => target)), "/patient/settings"];
  for (const [type, expected] of nativeRoutes) {
    for (const candidate of candidates) {
      assert.equal(getSafePatientNativeNotificationTarget(type, candidate),
        candidate === expected ? expected : "/patient/dashboard", `${type}: ${candidate}`);
    }
  }
});

await test("Native general Dashboard fallback preserves normal inbox and medication routes", () => {
  assert.equal(getSafePatientNativeNotificationTarget("general", undefined), "/patient/dashboard");
  assert.equal(getSafePatientNativeNotificationTarget("general", "/patient/reminders"), "/patient/dashboard");
  assert.equal(getSafePatientNativeNotificationTarget("unknown", "/patient/reminders"), "/patient/dashboard");
  for (const notification of [undefined, null, {}, { type: "general" }, { type: "unknown" },
    { type: "general", target_path: "https://example.invalid/unsafe" }]) {
    assert.equal(getSafePatientNotificationTarget(notification), "/patient/reminders");
  }
  assert.equal(getSafePatientNotificationTarget({ type: "general", target_path: "/patient/profile" }), "/patient/profile");
  for (const target_path of [undefined, "/patient/reminders", "/patient/profile", "/patient/settings"]) {
    assert.equal(getSafePatientNotificationTarget({ type: "medication_reminder", target_path }), "/patient/reminders/medications");
  }
});

const malformedIds = [
  ["missing", undefined], ["null", null], ["empty", ""], ["not a UUID", "malformed"],
  ["number", 7], ["array", [notificationId]], ["object", { id: notificationId }],
  ["leading whitespace", ` ${notificationId}`], ["trailing whitespace", `${notificationId} `],
  ["invalid version", "00000000-0000-0000-8000-000000000001"],
  ["invalid variant", "00000000-0000-4000-7000-000000000001"],
  ["truncated", notificationId.slice(0, -1)],
];
for (const [label, id] of malformedIds) {
  await test(`Malformed payload: ${label} notification_id is discarded before any lookup`, async (t) => {
    const h = await ready(t);
    const payload = action();
    if (id === undefined) delete payload.notification.data.notification_id;
    else payload.notification.data.notification_id = id;
    h.deliver(payload);
    await expectNoNavigation(h);
    assert.equal(h.calls.length, 0);
    assert.equal(h.queries.length, 0);
    assert.equal(h.timers.size, 0);
  });
}

for (const [label, payload] of [
  ["missing action", null], ["missing notification", { actionId: "tap" }],
  ["missing data", { actionId: "tap", notification: {} }],
  ["non-tap action", { ...action(), actionId: "dismiss" }],
]) {
  await test(`Malformed payload envelope: ${label} cannot authorize navigation`, async (t) => {
    const h = await ready(t);
    h.deliver(payload);
    await expectNoNavigation(h);
    assert.equal(h.queries.length, 0);
  });
}

await test("Valid but nonexistent notification ID is discarded after the ownership lookup", async (t) => {
  const h = await ready(t);
  const missingId = "00000000-0000-4000-8000-000000000009";
  h.tap(missingId);
  await expectNoNavigation(h);
  assertOwnership(h, missingId, patientId, 1);
});

await test("Notification belonging to another Patient cannot navigate even with a safe route", async (t) => {
  const h = await ready(t);
  h.setRecordOwner(notificationId, otherPatientId);
  h.tap();
  await expectNoNavigation(h);
  assertOwnership(h, notificationId, patientId, 1);
});

const adversarialRoutes = [
  ["wrong otherwise-safe Patient route", "/patient/reminders"],
  ["Patient settings", "/patient/settings"],
  ["Doctor route", "/doctor/dashboard"], ["Staff route", "/staff/dashboard"],
  ["Admin route", "/admin/dashboard"],
  ["external HTTPS URL", "https://example.invalid/patient/appointments"],
  ["javascript scheme", "javascript:alert(1)"], ["data scheme", "data:text/plain,synthetic"],
  ["custom scheme", "maternal-care://patient/appointments"],
  ["query string", "/patient/appointments?source=push"],
  ["hash", "/patient/appointments#next"], ["encoded route", "/patient/%61ppointments"],
  ["prefix route", "/patient/appointments-extra"],
  ["extra subpath", "/patient/appointments/details"], ["trailing slash", "/patient/appointments/"],
  ["protocol-relative URL", "//example.invalid/patient/appointments"],
  ["backslash", "/patient\\appointments"], ["dot segments", "/patient/records/../appointments"],
  ["trailing whitespace", "/patient/appointments "],
  ["missing route", undefined], ["null route", null], ["object route", {}], ["numeric route", 7],
];
const adversarialTypes = [
  ["prototype key", "__proto__"], ["constructor key", "constructor"],
  ["unknown type", "not_a_notification_type"], ["missing type", undefined],
  ["null type", null], ["object type", {}], ["numeric type", 7],
];
for (const [label, value, field] of [
  ...adversarialRoutes.map(([label, value]) => [label, value, "route"]),
  ...adversarialTypes.map(([label, value]) => [label, value, "notification_type"]),
]) {
  await test(`Adversarial payload: ${label} requires ownership and only resolves to Dashboard`, async (t) => {
    const h = await ready(t);
    const payload = action();
    payload.notification.data[field] = value;
    h.deliver(payload);
    assert.equal(h.api.canOpenPatientNativePushWorkspace(), false);
    assert.equal(h.navigations.length, 0);
    await h.consume({ pathname: "/patient/appointments" });
    assert.equal(h.queries.length, 0, "An unverified consumer cannot skip ownership");
    await h.api.verifyPendingPatientNativePushNavigation();
    assertOwnership(h, notificationId, patientId, 1);
    await h.consume({ pathname: "/patient/appointments" });
    assertOwnership(h);
    assert.deepEqual(h.navigations, [{ route: "/patient/dashboard", replace: true }]);
    h.acknowledge({ pathname: "/patient/dashboard" });
  });
}

await test("Dashboard fallback cannot bypass denied ownership", async (t) => {
  const h = await ready(t);
  h.setRecordOwner(notificationId, otherPatientId);
  h.tap(notificationId, "https://example.invalid/unsafe", "__proto__");
  await expectNoNavigation(h);
  assertOwnership(h, notificationId, patientId, 1);
});

for (const [label, options] of [
  ["Doctor", { role: "doctor" }], ["Staff", { role: "staff" }], ["Admin", { role: "admin" }],
  ["missing role", { omitRole: true }], ["empty role", { role: "" }], ["non-string role", { role: 7 }],
]) {
  await test(`Account isolation: ${label} is rejected before Patient ownership lookup`, async (t) => {
    const h = await ready(t, options);
    h.tap();
    await expectNoNavigation(h);
    assert.equal(ownershipQueries(h).length, 0);
    assert.equal(h.calls.includes("getCurrentPatientAccountStatus"), false);
    assert.deepEqual(h.queries[0].filters, [["id", activeSession.user.id]]);
  });
}

for (const [label, account] of [
  ["inactive Patient", { patient: { id: patientId }, status: "inactive" }],
  ["pending Patient", { patient: { id: patientId }, status: "pending_activation" }],
  ["archived Patient", { patient: { id: patientId }, status: "archived" }],
  ["unlinked Patient", { patient: null, status: "unlinked" }],
  ["active status without a linked record", { patient: null, status: "active" }],
]) {
  await test(`Account isolation: ${label} cannot open the workspace`, async (t) => {
    const h = await ready(t, { account });
    h.tap();
    await expectNoNavigation(h);
    assert.equal(ownershipQueries(h).length, 0);
    assert.equal(h.calls.includes("getCurrentPatientAccountStatus"), true);
  });
}

await test("Patient A pending -> Patient B session never transfers A's tap; B requires a fresh owned tap", async (t) => {
  const h = await ready(t);
  h.tap();
  const gate = h.pauseOwnership();
  const verifyingA = h.api.verifyPendingPatientNativePushNavigation();
  await gate.entered.promise;
  h.emit("SIGNED_IN", otherSession);
  h.setAccount({ patient: { id: otherPatientId }, status: "active" });
  h.setRecordOwner(otherNotificationId, otherPatientId);
  gate.resolve();
  await verifyingA;
  await expectNoNavigation(h);
  h.tap(otherNotificationId, "/patient/profile", "account_notification");
  await h.api.verifyPendingPatientNativePushNavigation();
  await h.consume();
  assert.deepEqual(h.navigations, [{ route: "/patient/profile", replace: true }]);
  const queries = ownershipQueries(h);
  assert.deepEqual(queries[0].filters, [["id", notificationId], ["patient_id", patientId]]);
  for (const query of queries.slice(1)) {
    assert.deepEqual(query.filters, [["id", otherNotificationId], ["patient_id", otherPatientId]]);
  }
});

for (const phase of ["verification", "consumption"]) {
  await test(`Session isolation: same user with different session_id cancels in-flight ${phase}`, async (t) => {
    const h = await ready(t);
    h.tap();
    if (phase === "consumption") await h.api.verifyPendingPatientNativePushNavigation();
    const gate = h.pauseOwnership();
    const operation = phase === "verification" ? h.api.verifyPendingPatientNativePushNavigation() : h.consume();
    await gate.entered.promise;
    h.emit("SIGNED_IN", session(4, 5));
    gate.resolve();
    await operation;
    await expectNoNavigation(h);
    h.tap(otherNotificationId);
    await h.api.verifyPendingPatientNativePushNavigation();
    await h.consume();
    assert.deepEqual(h.navigations, [{ route: "/patient/appointments", replace: true }]);
  });
}

await test("Final session recheck rejects a replacement session even before the auth observer reports it", async (t) => {
  const h = await ready(t);
  h.tap();
  const gate = h.pauseOwnership();
  const operation = h.api.verifyPendingPatientNativePushNavigation();
  await gate.entered.promise;
  h.setSessionSilently(session(4, 5));
  gate.resolve();
  await operation;
  await expectNoNavigation(h);
  assert.equal(h.calls.filter((call) => call === "getSession").length, 2);
});

await test("Same-session token refresh preserves valid pending work and ownership", async (t) => {
  const h = await ready(t);
  h.tap();
  const gate = h.pauseOwnership();
  const operation = h.api.verifyPendingPatientNativePushNavigation();
  await gate.entered.promise;
  const refreshed = session(4, 4, 1);
  assert.notEqual(refreshed.access_token, activeSession.access_token);
  h.emit("TOKEN_REFRESHED", refreshed);
  assert.equal(h.api.hasPendingPatientNativePushNavigation(), true);
  gate.resolve();
  await operation;
  await h.consume();
  assertOwnership(h);
  assert.deepEqual(h.navigations, [{ route: "/patient/appointments", replace: true }]);
});

await test("Duplicate taps remain suppressed before, during and after an acknowledged navigation", async (t) => {
  const h = await ready(t);
  h.tap();
  const snapshot = h.api.getPatientNativePushNavigationSnapshot();
  await h.tick(1000);
  h.tap(notificationId, "/patient/profile", "account_notification");
  assert.equal(h.api.getPatientNativePushNavigationSnapshot(), snapshot);
  assert.equal(h.api.inspectPendingTapForTest().receivedAt, 0);
  await h.api.verifyPendingPatientNativePushNavigation();
  const gate = h.pauseOwnership();
  const consuming = h.consume();
  await gate.entered.promise;
  await h.consume();
  gate.resolve();
  await consuming;
  await h.consume();
  assert.deepEqual(h.navigations, [{ route: "/patient/appointments", replace: true }]);
  assertOwnership(h);
  h.acknowledge();
  h.tap();
  await h.api.verifyPendingPatientNativePushNavigation();
  await h.consume();
  assert.equal(h.api.hasPendingPatientNativePushNavigation(), false);
  assert.equal(h.navigations.length, 1);
});

for (const phase of ["verification", "consumption"]) {
  await test(`Rapid distinct taps: latest wins while old ${phase} is in flight`, async (t) => {
    const h = await ready(t);
    h.tap();
    if (phase === "consumption") await h.api.verifyPendingPatientNativePushNavigation();
    const gate = h.pauseOwnership();
    const oldOperation = phase === "verification" ? h.api.verifyPendingPatientNativePushNavigation() : h.consume();
    await gate.entered.promise;
    h.tap(otherNotificationId, "/patient/reminders", "doctor_reminder");
    await h.api.verifyPendingPatientNativePushNavigation();
    await h.consume();
    gate.resolve();
    await oldOperation;
    await h.consume();
    assert.deepEqual(h.navigations, [{ route: "/patient/reminders", replace: true }]);
    assert.equal(h.api.inspectPendingTapForTest().notificationId, otherNotificationId);
    h.acknowledge({ pathname: "/patient/reminders" });
    assert.equal(h.api.hasPendingPatientNativePushNavigation(), false);
  });
}

for (const elapsed of [299_999, 300_000]) {
  await test(`Five-minute expiry boundary: ${elapsed}ms ${elapsed < 300_000 ? "is valid" : "is expired"}`, async (t) => {
    const h = await ready(t);
    h.tap();
    await h.tick(elapsed);
    await h.api.verifyPendingPatientNativePushNavigation();
    await h.consume();
    if (elapsed < 300_000) {
      assert.deepEqual(h.navigations, [{ route: "/patient/appointments", replace: true }]);
      await h.tick(1);
      assert.equal(h.api.hasPendingPatientNativePushNavigation(), false);
    } else {
      await expectNoNavigation(h);
      assert.equal(h.queries.length, 0);
    }
  });
}

await test("Expiry cancels ownership verification already in flight", async (t) => {
  const h = await ready(t);
  h.tap();
  const gate = h.pauseOwnership();
  const operation = h.api.verifyPendingPatientNativePushNavigation();
  await gate.entered.promise;
  await h.tick(300_000);
  gate.resolve();
  await operation;
  await expectNoNavigation(h);
  assertOwnership(h, notificationId, patientId, 1);
});

await test("Expiry is enforced before navigation even if a background timer has not fired", async (t) => {
  const h = await ready(t);
  h.tap();
  await h.api.verifyPendingPatientNativePushNavigation();
  h.jumpClock(300_000);
  await expectNoNavigation(h);
  assert.equal(h.timers.size, 0);
});

for (const stage of ["getUser", "profiles", "account", "patient_notifications"]) {
  await test(`Transient ${stage} failure retains safe metadata, waits ten seconds, then rechecks ownership`, async (t) => {
    const h = await ready(t);
    h.tap();
    h.failNext(stage, { status: 503 });
    await h.api.verifyPendingPatientNativePushNavigation();
    assert.equal(h.api.hasPendingPatientNativePushNavigation(), true);
    assert.equal(h.api.canOpenPatientNativePushWorkspace(), false);
    assert.deepEqual(Object.keys(h.api.inspectPendingTapForTest()).sort(), ["notificationId", "receivedAt", "sanitizedRoute"]);
    const callCount = h.calls.length;
    await h.api.verifyPendingPatientNativePushNavigation();
    await h.consume();
    assert.equal(h.calls.length, callCount);
    assert.equal(h.navigations.length, 0);
    await h.tick(9_999);
    await h.api.verifyPendingPatientNativePushNavigation();
    assert.equal(h.calls.length, callCount);
    await h.tick(1);
    await h.api.verifyPendingPatientNativePushNavigation();
    assert.equal(h.api.canOpenPatientNativePushWorkspace(), true);
    await h.consume();
    assert.deepEqual(h.navigations, [{ route: "/patient/appointments", replace: true }]);
    assert.ok(ownershipQueries(h).length >= 2);
    for (const query of ownershipQueries(h)) assert.deepEqual(query.filters, [["id", notificationId], ["patient_id", patientId]]);
  });
}

for (const trigger of ["online", "visible"]) {
  await test(`Retry recovery on ${trigger} reauthorizes the retained tap`, async (t) => {
    const h = await ready(t);
    h.tap();
    h.failNext("patient_notifications", { status: 503 });
    await h.api.verifyPendingPatientNativePushNavigation();
    assert.equal(h.timers.size, 2, "Expiry and retry timers are both retained");
    h.visibility("hidden");
    assert.equal(h.timers.size, 2, "A hidden document cannot restart verification");
    if (trigger === "online") {
      h.online();
      assert.equal(h.timers.size, 2, "Online event while hidden cannot bypass retry delay");
      h.visibility("visible", false);
      h.online();
    } else h.visibility("visible");
    assert.equal(h.timers.size, 1);
    await h.api.verifyPendingPatientNativePushNavigation();
    await h.consume();
    assert.deepEqual(h.navigations, [{ route: "/patient/appointments", replace: true }]);
    assertOwnership(h, notificationId, patientId, 3);
  });
}

for (const [label, fault] of [
  ["401", { status: 401 }], ["403", { status: 403 }], ["missing auth session", { missingAuthSession: true }],
]) {
  await test(`Retry policy: ${label} is terminal and cannot retain a tap`, async (t) => {
    const h = await ready(t);
    h.tap();
    h.failNext("getUser", fault);
    await expectNoNavigation(h);
    assert.equal(h.timers.size, 0);
  });
}

await test("A failed session lookup is fail-closed rather than eligible for a network retry", async (t) => {
  const h = await ready(t);
  h.tap();
  h.failNext("getSession", { status: 503 });
  await expectNoNavigation(h);
  assert.equal(h.queries.length, 0);
  assert.equal(h.timers.size, 0);
});

await test("Logout cancels a deferred retry and prevents its stale timer from restoring work", async (t) => {
  const h = await ready(t);
  h.tap();
  h.failNext("patient_notifications", { status: 503 });
  await h.api.verifyPendingPatientNativePushNavigation();
  const staleRetry = [...h.timers.values()].find((timer) => timer.due === 10_000).callback;
  h.api.cancelPatientNativePushNavigationBeforeLogout();
  h.emit("SIGNED_OUT", null);
  staleRetry();
  await h.tick(10_000);
  await expectNoNavigation(h);
  assert.equal(h.timers.size, 0);
});

await test("Unmounted consumer cannot navigate; a subsequently mounted consumer must reverify", async (t) => {
  const h = await ready(t);
  h.tap();
  await h.api.verifyPendingPatientNativePushNavigation();
  const gate = h.pauseOwnership();
  const operation = h.consume();
  await gate.entered.promise;
  h.setMounted(false);
  gate.resolve();
  await operation;
  assert.equal(h.navigations.length, 0);
  assert.equal(h.api.hasPendingPatientNativePushNavigation(), true);
  h.setMounted(true);
  await h.consume();
  assert.deepEqual(h.navigations, [{ route: "/patient/appointments", replace: true }]);
  assertOwnership(h, notificationId, patientId, 3);
});

await test("Already at exact target consumes without a new history operation", async (t) => {
  const h = await ready(t);
  h.tap();
  await h.api.verifyPendingPatientNativePushNavigation();
  await h.consume({ pathname: "/patient/appointments" });
  assertOwnership(h);
  assert.equal(h.navigations.length, 0);
  assert.equal(h.api.hasPendingPatientNativePushNavigation(), false);
  assert.equal(h.timers.size, 0);
});

for (const [label, location] of [
  ["search", { search: "?source=push" }], ["hash", { hash: "#next" }],
  ["search and hash", { search: "?source=push", hash: "#next" }],
]) {
  await test(`Target pathname with ${label} requires normalization and is not an acknowledgement`, async (t) => {
    const h = await ready(t);
    h.tap();
    await h.api.verifyPendingPatientNativePushNavigation();
    await h.consume({ pathname: "/patient/appointments", ...location });
    assert.deepEqual(h.navigations, [{ route: "/patient/appointments", replace: true }]);
    h.acknowledge(location);
    assert.equal(h.api.hasPendingPatientNativePushNavigation(), true);
    await h.consume();
    assert.equal(h.navigations.length, 1, "Navigation remains reserved until the exact URL commits");
    h.acknowledge();
    assert.equal(h.api.hasPendingPatientNativePushNavigation(), false);
  });
}

await test("Acknowledgement needs a navigation request, exact pathname and matching user/Patient binding", async (t) => {
  const h = await ready(t);
  h.tap();
  await h.api.verifyPendingPatientNativePushNavigation();
  h.acknowledge();
  assert.equal(h.api.hasPendingPatientNativePushNavigation(), true, "Verification alone is not arrival");
  await h.consume();
  for (const mismatch of [
    { pathname: "/patient/dashboard" }, { pathname: "/patient/appointments/" },
    { pathname: "/patient/appointments/details" }, { userId: otherSession.user.id },
    { patientId: otherPatientId }, { search: "?x=1" }, { hash: "#x" },
  ]) {
    h.acknowledge(mismatch);
    assert.equal(h.api.hasPendingPatientNativePushNavigation(), true);
  }
  h.acknowledge();
  assert.equal(h.api.hasPendingPatientNativePushNavigation(), false);
  assert.equal(h.navigations.length, 1);
});

await test("Consumer cannot substitute a different authenticated user or linked Patient", async (t) => {
  const h = await ready(t);
  h.tap();
  await h.api.verifyPendingPatientNativePushNavigation();
  const queryCount = h.queries.length;
  await h.consume({ userId: otherSession.user.id });
  await h.consume({ patientId: otherPatientId });
  assert.equal(h.queries.length, queryCount);
  assert.equal(h.navigations.length, 0);
  await h.consume();
  assert.deepEqual(h.navigations, [{ route: "/patient/appointments", replace: true }]);
});

await test("Foreground receipt has no native tap listener, navigation, ownership lookup or write side effects", async (t) => {
  const h = await ready(t);
  const snapshot = h.api.getPatientNativePushNavigationSnapshot();
  assert.deepEqual([...h.pushEvents.keys()], ["pushNotificationActionPerformed"]);
  h.receive(action().notification);
  assert.equal(h.api.getPatientNativePushNavigationSnapshot(), snapshot);
  await expectNoNavigation(h);
  assert.equal(h.calls.length, 0);
  assert.equal(h.queries.length, 0);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.storageCalls, []);
});

await test("Push-provided Patient and related IDs are ignored; only frozen safe metadata stays in memory", async (t) => {
  const h = await ready(t);
  const payload = action();
  Object.assign(payload.notification.data, {
    patient_id: otherPatientId,
    related_appointment_id: "synthetic-appointment",
    related_medical_record_id: "synthetic-record",
    related_reminder_id: "synthetic-reminder",
    access_token: "synthetic-untrusted-token", title: "Synthetic private title", body: "Synthetic private body",
  });
  h.deliver(payload);
  const pending = h.api.inspectPendingTapForTest();
  assert.deepEqual(Object.keys(pending).sort(), ["notificationId", "receivedAt", "sanitizedRoute"]);
  assert.deepEqual({ ...pending }, {
    notificationId, sanitizedRoute: "/patient/appointments", receivedAt: 0,
  });
  assert.equal(Object.isFrozen(pending), true);
  payload.notification.data.route = "/admin/dashboard";
  payload.notification.data.notification_id = otherNotificationId;
  await h.api.verifyPendingPatientNativePushNavigation();
  await h.consume();
  assertOwnership(h);
  assert.deepEqual(h.navigations, [{ route: "/patient/appointments", replace: true }]);
  assert.equal(h.api.inspectPendingTapForTest(), pending);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.storageCalls, []);
  h.acknowledge();
  assert.equal(h.api.inspectPendingTapForTest(), null);
});

await test("A valid uppercase UUID is normalized before ownership and duplicate suppression", async (t) => {
  const h = await ready(t);
  const lowerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  h.setRecordOwner(lowerId, patientId);
  h.tap(lowerId.toUpperCase());
  h.tap(lowerId);
  await h.api.verifyPendingPatientNativePushNavigation();
  await h.consume();
  assertOwnership(h, lowerId);
  assert.deepEqual(h.navigations, [{ route: "/patient/appointments", replace: true }]);
});
