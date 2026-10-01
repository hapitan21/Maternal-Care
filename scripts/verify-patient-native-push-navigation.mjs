// Run: node --experimental-vm-modules scripts/verify-patient-native-push-navigation.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import { getSafePatientNativeNotificationTarget } from "../src/lib/patientNotificationRoutes.js";

const source = readFileSync(new URL("../src/lib/patientNativePushNavigation.js", import.meta.url), "utf8");
const notificationId = "00000000-0000-4000-8000-000000000001";
const otherNotificationId = "00000000-0000-4000-8000-000000000002";
const patientId = "00000000-0000-4000-8000-000000000003";
const session = (suffix) => ({
  user: { id: `00000000-0000-4000-8000-00000000000${suffix}` },
  access_token: `test.${Buffer.from(JSON.stringify({
    session_id: `00000000-0000-4000-8000-00000000001${suffix}`,
  })).toString("base64url")}.test`,
});
const activeSession = session(4);
const otherSession = session(5);
const action = (id = notificationId, route = "/patient/appointments") => ({
  actionId: "tap",
  notification: { data: { notification_id: id, notification_type: "appointment_reminder", route } },
});
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function harness(t, { retained = true, listenerFailure = false, observerFailure = false } = {}) {
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
  const timers = new Map();
  const events = new Map();
  const calls = [];
  const queries = [];
  const navigations = [];
  const eventTarget = (name) => ({
    addEventListener: (event, callback) => events.set(`${name}:${event}`, callback),
    removeEventListener: (event) => events.delete(`${name}:${event}`),
  });
  const window = {
    ...eventTarget("window"),
    setTimeout: (callback, delay) => {
      timers.set(++timerId, { callback, due: now + delay });
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  const supabase = {
    auth: {
      onAuthStateChange: (callback) => {
        if (observerFailure) throw new Error("Auth observer startup failed");
        authCallback = callback;
        observerAlive = true;
        return { data: { subscription: { unsubscribe: () => { observerAlive = false; } } } };
      },
      getSession: async () => {
        calls.push("getSession");
        return { data: { session: currentSession }, error: null };
      },
      getUser: async () => {
        calls.push("getUser");
        return { data: { user: currentSession?.user }, error: null };
      },
    },
    from: (table) => {
      const query = { table, filters: [] };
      queries.push(query);
      const builder = {
        select: (columns) => { query.columns = columns; return builder; },
        eq: (column, value) => { query.filters.push([column, value]); return builder; },
        maybeSingle: async () => {
          if (table === "profiles") return { data: { role: "patient" }, error: null };
          assert.equal(table, "patient_notifications");
          if (notificationGate) {
            notificationGate.entered.resolve();
            await notificationGate.promise;
          }
          return { data: owned ? { id: query.filters.find(([column]) => column === "id")[1] } : null, error: null };
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
        if (retained) callback(action());
        return Promise.resolve({ remove: async () => { listenerAlive = false; } });
      },
    } },
    "./supabaseClient": { supabase },
    "./patientAuthLinking": {
      getCurrentPatientAccountStatus: async () => ({ patient: { id: patientId }, status: "active" }),
      isMissingPatientAuthSession: () => false,
    },
    "./patientAccountStatus": { patientAccountStatuses: { active: "active" } },
    "./patientNotificationRoutes": { getSafePatientNativeNotificationTarget },
  };
  const context = createContext({
    window,
    document: { ...eventTarget("document"), visibilityState: "visible" },
    Date: class extends Date { static now() { return now; } },
    atob: (value) => Buffer.from(value, "base64").toString("utf8"),
  });
  const module = new SourceTextModule(source, {
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
  });
  return {
    api, bootstrap, calls, queries, navigations, timers,
    get mounted() { return mounted; },
    get observerAlive() { return observerAlive; },
    get listenerAlive() { return listenerAlive; },
    emit: (event, nextSession) => { currentSession = nextSession; authCallback(event, nextSession); },
    tap: (id, route) => tapCallback(action(id, route)),
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
    consume: () => api.consumePatientNativePushNavigation({
      userId: currentSession?.user.id,
      patientId,
      pathname: "/patient/dashboard", search: "", hash: "",
      navigate: (route, options) => navigations.push({ route, replace: options.replace }),
      isMounted: () => true,
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
