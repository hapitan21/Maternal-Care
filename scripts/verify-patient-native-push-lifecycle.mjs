// Run: node scripts/verify-patient-native-push-lifecycle.mjs
// Tests only: actual JS/TS runs in VM contexts with mocked native/auth/database/network APIs.
// SQL behavior uses a source-bound model, NOT a PostgreSQL engine or a live database.
// Expected failures assert desired behavior. Only their exact contract assertion is quarantined.
// A repaired contract is an UNEXPECTED PASS until its expected-failure annotation is removed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { webcrypto } from "node:crypto";
import * as vm from "node:vm";
import { transformWithOxc } from "vite";

if (!vm.SourceTextModule) {
  const result = spawnSync(process.execPath, [
    "--experimental-vm-modules", ...process.execArgv, ...process.argv.slice(1),
  ], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const root = new URL("../", import.meta.url);
const read = (file) => readFileSync(new URL(file, root), "utf8");
const nativePath = "src/lib/patientNativePush.js";
const hookPath = "src/hooks/usePatientNativePushNotifications.js";
const settingsPath = "src/components/patient/PatientPushNotificationSettings.jsx";
const senderPath = "supabase/functions/send-patient-native-push/index.ts";
const firebasePath = "supabase/functions/_shared/firebaseMessaging.ts";
const firebaseTestPath = "supabase/functions/_shared/firebaseMessaging_test.ts";
const rpcSql = read("supabase/migrations/20261002012000_fix_native_push_rpc_sql_expressions.sql");
// Model the last checked-in upsert definition; this is not a claim about deployed SQL.
const effectiveUpsertSql = readdirSync(new URL("supabase/migrations/", root))
  .filter(file => file.endsWith(".sql")).sort()
  .map(file => read("supabase/migrations/" + file))
  .filter(sql => /create or replace function public\.upsert_my_patient_native_push_device\(/i.test(sql)).at(-1);
const normalizedUpsertSql = effectiveUpsertSql.slice(0, effectiveUpsertSql.indexOf("$function$;") + 11)
  .replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();
const protectsInstallationOwnership = normalizedUpsertSql.includes(
  "where device.patient_id = v_patient_id and device.user_id = v_user_id returning"
);
const tableSql = read("supabase/migrations/20261001120000_patient_native_push_devices.sql");
const ledgerSql = read("supabase/migrations/20261002120000_patient_notification_native_push_deliveries.sql");
let installationSequence = 3000;
const installationKey = "maternal_native_push_installation_id";
const disabledKey = "maternal_native_push_explicitly_disabled";
const uid = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const token = (n) => "synthetic-registration-" + String(n).padStart(32, "0");
const jwt = (sessionId, version = 0) => "synthetic." + Buffer.from(JSON.stringify({
  session_id: sessionId, version,
})).toString("base64url") + ".synthetic";
const session = (user = uid(1), sessionId = uid(101), version = 0) => ({
  user: { id: user }, access_token: jwt(sessionId, version),
});
const patientA = uid(11);
const patientB = uid(12);
const activeAccount = (user = uid(1), patient = patientA) => ({
  user, patient, role: "patient", profileStatus: "active", patientStatus: "active",
  recordStatus: "active", archived: false,
});
const accounts = new Map([
  [uid(1), activeAccount()], [uid(2), activeAccount(uid(2), patientB)],
]);
const silentConsole = { info() {}, warn() {}, error() {}, log() {} };
const forbidNetwork = async () => { throw new Error("Unmocked network access is forbidden"); };
const flush = async () => { for (let i = 0; i < 128; i += 1) await Promise.resolve(); };
const observe = (promise) => {
  const operation = { settled: false };
  operation.promise = Promise.resolve(promise).then(
    value => { operation.value = value; operation.settled = true; },
    error => { operation.error = error; operation.settled = true; },
  );
  return operation;
};
const complete = async (operation) => {
  await flush();
  assert.equal(operation.settled, true, "controlled operation must settle without wall-clock waiting");
  await operation.promise;
  return operation;
};
const check = (condition, name) => assert.ok(condition, "contract: " + name);

function clock() {
  let now = 0;
  let next = 0;
  const timers = new Map();
  return {
    setTimeout(callback, delay = 0) {
      const id = ++next;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      now += ms;
      for (let i = 0; i < 100; i += 1) {
        await flush();
        const due = [...timers].filter(([, entry]) => entry.due <= now);
        if (!due.length) return;
        for (const [id, entry] of due) {
          if (timers.delete(id)) entry.callback();
        }
      }
      throw new Error("Fake timer did not quiesce");
    },
    get size() { return timers.size; },
  };
}

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
    },
    removeEventListener(event, listener) { listeners.get(event)?.delete(listener); },
    dispatchEvent(event) {
      for (const listener of [...(listeners.get(event.type) || [])]) listener(event);
      return true;
    },
  };
}

const transformed = new Map();
async function codeFor(file) {
  if (!transformed.has(file)) {
    const source = read(file);
    transformed.set(file, /\.(ts|jsx)$/.test(file)
      ? (await transformWithOxc(source, file, {
        jsx: { runtime: "automatic", development: false },
      })).code : source);
  }
  return transformed.get(file);
}

function synthetic(context, exports) {
  return new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context });
}

async function load(file, context, imports = {}) {
  const mod = new vm.SourceTextModule(await codeFor(file), { context, identifier: file });
  await mod.link(specifier => {
    if (!(specifier in imports)) throw new Error("Unmocked import: " + specifier);
    return synthetic(context, imports[specifier]);
  });
  await mod.evaluate();
  return mod.namespace;
}

// Narrowly recognize the current SQL contract. Unexpected SQL changes fail setup;
// this model is explicitly not proof of deployed RLS or PostgreSQL execution.
function validateSqlModel() {
  const sql = normalizedUpsertSql;
  for (const fragment of [
    "v_user_id uuid := auth.uid()", "into strict v_patient_id",
    "where patient.user_id = v_user_id",
    "coalesce(profile.role, ''))) = 'patient'",
    "coalesce(profile.account_status, ''))) = 'active'",
    "coalesce(patient.account_status, ''))) = 'active'",
    "patient.archived_at is null", "not in ('inactive', 'archived', 'deleted')",
  ]) assert.ok(sql.includes(fragment), "SQL model requires review: unrecognized account/upsert clause");
  const upsert = sql.slice(sql.indexOf("on conflict (platform, installation_id)"), sql.indexOf("returning", sql.indexOf("on conflict (platform, installation_id)"))).trim();
  const assignments = "push_token = excluded.push_token, enabled = true, last_seen_at = pg_catalog.now(), disabled_at = null, app_version = excluded.app_version";
  const expectedConflict = protectsInstallationOwnership
    ? "on conflict (platform, installation_id) do update set " + assignments +
      " where device.patient_id = v_patient_id and device.user_id = v_user_id"
    : "on conflict (platform, installation_id) do update set patient_id = excluded.patient_id, user_id = excluded.user_id, " + assignments;
  assert.equal(upsert, expectedConflict, "SQL model requires review: unrecognized ownership conflict clause");
  if (protectsInstallationOwnership) {
    assert.ok(sql.includes("insert into public.patient_native_push_devices as device ("));
    assert.ok(sql.includes("if not found then raise exception 'the native push registration conflicts with another app installation.' using errcode = '42501'"));
    assert.ok(sql.includes("when unique_violation then raise exception 'the native push registration conflicts with another app installation.' using errcode = '23505'"));
    assert.ok(sql.includes("security definer set search_path = ''"));
  }
  const deactivate = rpcSql.slice(
    rpcSql.indexOf("create or replace function public.deactivate_my_patient_native_push_device"),
    rpcSql.indexOf("create or replace function public.get_my_patient_native_push_device_status"),
  ).replace(/\s+/g, " ").toLowerCase();
  for (const fragment of ["device.installation_id = v_installation_id",
    "device.patient_id = v_patient_id", "device.user_id = v_user_id"]) {
    assert.ok(deactivate.includes(fragment), "SQL model requires review: deactivation ownership changed");
  }
  assert.match(tableSql, /unique\s*\(platform,\s*installation_id\)/i);
  assert.match(tableSql, /unique\s*\(push_token\)/i);
  assert.match(ledgerSql, /unique\s*\(notification_id,\s*device_id\)/i);
}

function registrationModel(accountMap = accounts) {
  const rows = new Map();
  let revision = 0;
  let deviceSequence = 200;
  function authorize(currentSession) {
    const account = accountMap.get(currentSession?.user?.id);
    if (!account || account.role !== "patient" || account.profileStatus !== "active" ||
        account.patientStatus !== "active" || !account.patient || account.archived ||
        ["inactive", "archived", "deleted"].includes(account.recordStatus)) {
      throw Object.assign(new Error("synthetic authorization rejection"), { code: "42501" });
    }
    return account;
  }
  return {
    rows,
    authorize,
    upsert(currentSession, installation, value) {
      const account = authorize(currentSession);
      if ([...rows.values()].some(row => row.installation_id !== installation && row.push_token === value)) {
        throw Object.assign(new Error("synthetic token uniqueness rejection"), { code: "23505" });
      }
      const previous = rows.get(installation);
      // Mirror the effective conflict predicate before any state/timestamp mutation.
      if (protectsInstallationOwnership && previous &&
          (previous.user_id !== account.user || previous.patient_id !== account.patient)) {
        throw Object.assign(new Error("synthetic installation conflict"), { code: "42501" });
      }
      const row = { ...previous, id: previous?.id || uid(++deviceSequence),
        platform: "android", installation_id: installation, patient_id: account.patient,
        user_id: account.user, push_token: value, enabled: true, disabled_at: null,
        updated_at: "revision-" + (++revision), last_seen_at: "revision-" + revision };
      rows.set(installation, row);
      return row;
    },
    deactivate(currentSession, installation) {
      const account = authorize(currentSession);
      const row = rows.get(installation);
      if (row?.user_id === account.user && row.patient_id === account.patient) {
        row.enabled = false;
        row.disabled_at ||= "synthetic-disabled";
        row.updated_at = "revision-" + (++revision);
        return true;
      }
      return false;
    },
    status(currentSession, installation) {
      const account = authorize(currentSession);
      const row = rows.get(installation);
      return { found: row?.user_id === account.user,
        enabled: row?.user_id === account.user && row.patient_id === account.patient && row.enabled };
    },
    // The checked-in RPC has no authorized transfer credential/API. A UUID is not a grant.
    authorizedTransfer: null,
  };
}

async function nativeHarness({ storage = new Map(), model = registrationModel(),
  retained = [], initialSession = session(), autoToken, accountMap = accounts,
} = {}) {
  const time = clock();
  const window = { ...eventTarget(), setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key), clear: () => storage.clear(),
    },
  };
  const document = { ...eventTarget(), visibilityState: "visible" };
  let currentSession = initialSession;
  let permission = "granted";
  let deactivateFails = false;
  let registerCalls = 0;
  let unregisterCalls = 0;
  const nativeListeners = new Map();
  const retainedEvents = [...retained];
  const authListeners = new Set();
  const sessionHistory = new Map(initialSession ? [[initialSession.access_token, initialSession]] : []);
  const gates = new Map();
  let userMismatch = false;
  let persistenceFailures = 0;
  let registerFails = false;
  const listenerCallbacks = [];
  const pause = stage => {
    let entered;
    let release;
    const gate = { started: false, entered: new Promise(resolve => { entered = resolve; }),
      wait: new Promise(resolve => { release = resolve; }), mark: () => { gate.started = true; entered(); }, release: () => release() };
    gates.set(stage, gate);
    return gate;
  };
  const checkpoint = async stage => {
    const gate = gates.get(stage);
    if (gate) { gates.delete(stage); gate.mark(); await gate.wait; }
  };
  const authenticatedSession = headers => headers.has("Authorization")
    ? sessionHistory.get(headers.get("Authorization").replace(/^Bearer /, "")) : currentSession;
  const calls = [];
  const writes = [];
  const emit = value => {
    const callbacks = [...(nativeListeners.get("registration") || [])];
    if (!callbacks.length) retainedEvents.push(value);
    for (const callback of callbacks) callback({ value });
  };
  const push = {
    checkPermissions: async () => ({ receive: permission }),
    requestPermissions: async () => ({ receive: permission }),
    async register() {
      registerCalls++;
      await checkpoint("register");
      if (registerFails) throw new Error("synthetic registration failure");
      if (autoToken) emit(autoToken);
    },
    async unregister() { unregisterCalls++; },
    async addListener(event, callback) {
      if (!nativeListeners.has(event)) nativeListeners.set(event, new Set());
      nativeListeners.get(event).add(callback);
      listenerCallbacks.push({ event, callback });
      if (event === "registration") {
        const pending = retainedEvents.splice(0);
        for (const value of pending) callback({ value });
      }
      await checkpoint("listener:" + event);
      return { remove: async () => nativeListeners.get(event)?.delete(callback) };
    },
  };
  const supabase = {
    auth: {
      getSession: async () => {
        const captured = currentSession;
        calls.push("auth:getSession");
        await checkpoint("session");
        return { data: { session: captured }, error: null };
      },
      getUser: async accessToken => {
        const captured = accessToken ? sessionHistory.get(accessToken) : currentSession;
        await checkpoint("user");
        return { data: { user: userMismatch ? { id: uid(999) } : captured?.user }, error: null };
      },
      onAuthStateChange(callback) {
        authListeners.add(callback);
        return { data: { subscription: { unsubscribe: () => authListeners.delete(callback) } } };
      },
    },
    from(table) {
      assert.equal(table, "profiles", "registration may read only the authenticated profile");
      const headers = new Map();
      let profileId;
      let signal;
      const builder = {
        select(columns) { assert.equal(columns, "role, account_status"); return builder; },
        eq(column, value) { assert.equal(column, "id"); profileId = value; return builder; },
        maybeSingle() { return builder; },
        setHeader(name, value) { headers.set(name, value); return builder; },
        abortSignal(value) { signal = value; return builder; },
        then(resolve, reject) {
          return (async () => {
            await checkpoint("profile");
            if (signal?.aborted) return { data: null, error: { code: "synthetic-abort" } };
            const owner = authenticatedSession(headers)?.user?.id;
            assert.equal(profileId, owner, "profile lookup must be pinned to its authenticated owner");
            const account = accountMap.get(owner);
            return { data: account ? { role: account.role, account_status: account.profileStatus } : null, error: null };
          })().then(resolve, reject);
        },
      };
      return builder;
    },
    rpc(name, args) {
      calls.push(name);
      const headers = new Map();
      let signal;
      let execution;
      const execute = () => execution ||= (async () => {
        await checkpoint("rpc:" + name);
        if (signal?.aborted) return { data: null, error: { code: "synthetic-abort" } };
        const requestSession = authenticatedSession(headers);
        try {
          if (name === "get_current_patient_account_status") {
            const account = accountMap.get(requestSession?.user?.id);
            const archived = account?.archived || ["archived", "deleted"].includes(account?.recordStatus);
            return { data: account?.patient ? [{ id: account.patient,
              account_status: archived ? "archived" : account.patientStatus, linked: true }] : [], error: null };
          }
          if (name === "upsert_my_patient_native_push_device") {
            assert.equal(headers.has("Authorization"), true, "upsert must use an explicitly bound bearer");
            if (persistenceFailures > 0) {
              persistenceFailures--;
              return { data: null, error: { code: "synthetic-transient" } };
            }
            const row = model.upsert(requestSession, args.p_installation_id, args.p_push_token);
            writes.push({ owner: row.user_id, installation: row.installation_id, value: row.push_token });
            return { data: { device_id: row.id, enabled: row.enabled }, error: null };
          }
          if (name === "deactivate_my_patient_native_push_device") {
            assert.equal(headers.has("Authorization"), true, "cleanup must use an explicitly bound bearer");
            if (deactivateFails) return { data: null, error: { code: "synthetic-deactivation-failure" } };
            const found = model.deactivate(requestSession, args.p_installation_id);
            return { data: { found, enabled: false }, error: null };
          }
          if (name === "get_my_patient_native_push_device_status") {
            return { data: model.status(requestSession, args.p_installation_id), error: null };
          }
          throw new Error("Unmocked RPC");
        } catch (error) {
          if (["42501", "23505"].includes(error.code)) return { data: null, error: { code: error.code } };
          throw error;
        }
      })();
      const builder = {
        setHeader(name, value) { headers.set(name, value); return builder; },
        abortSignal(value) { signal = value; return builder; },
        then: (resolve, reject) => execute().then(resolve, reject),
      };
      return builder;
    },
  };
  const context = vm.createContext({ console: silentConsole, AbortController,
    window, document, navigator: { onLine: true }, fetch: forbidNetwork,
    crypto: { randomUUID: () => uid(++installationSequence) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    atob: value => Buffer.from(value, "base64").toString("binary"),
  });
  const api = await load(nativePath, context, {
    "@capacitor/core": { Capacitor: {
      isNativePlatform: () => true, getPlatform: () => "android", isPluginAvailable: () => true,
    } },
    "@capacitor/push-notifications": { PushNotifications: push },
    "./supabaseClient": { supabase },
  });
  api.beginPatientNativePushSession();
  return {
    api, context, model, storage, window, document, time, calls, writes, emit, accountMap,
    pause,
    listenerCount(event = "registration") { return nativeListeners.get(event)?.size || 0; },
    savedTokenCallback() { return listenerCallbacks.find(item => item.event === "registration")?.callback; },
    failPersistence(count = 1) { persistenceFailures = count; },
    failRegister(value = true) { registerFails = value; },
    emitError() { for (const callback of nativeListeners.get("registrationError") || []) callback({ error: "synthetic" }); },
    get authListenerCount() { return authListeners.size; },
    mismatchUser(value = true) { userMismatch = value; },
    get currentSession() { return currentSession; },
    get registerCalls() { return registerCalls; },
    get unregisterCalls() { return unregisterCalls; },
    setPermission(value) { permission = value; },
    failDeactivation(value = true) { deactivateFails = value; },
    async authChange(next, event = "SIGNED_IN") {
      currentSession = next;
      if (next) sessionHistory.set(next.access_token, next);
      for (const callback of authListeners) callback(event, next);
      await flush();
    },
    async visible(value) {
      document.visibilityState = value ? "visible" : "hidden";
      document.dispatchEvent({ type: "visibilitychange" });
      window.dispatchEvent({ type: value ? "focus" : "blur" });
      await flush();
    },
  };
}

// Runs the actual hook with deterministic state/ref/dependency/effect semantics.
// It does not claim browser layout or a full React DOM render was tested.
function hookRuntime() {
  const slots = [];
  let index = 0;
  let dirty = true;
  let render;
  let result;
  let pendingEffects = [];
  const depsEqual = (a, b) => a && b && a.length === b.length && a.every((value, n) => Object.is(value, b[n]));
  return {
    react: {
      useState(initial) {
        const n = index++;
        if (!slots[n]) slots[n] = { value: typeof initial === "function" ? initial() : initial };
        return [slots[n].value, update => {
          slots[n].value = typeof update === "function" ? update(slots[n].value) : update;
          dirty = true;
        }];
      },
      useRef(initial) { const n = index++; slots[n] ||= { current: initial }; return slots[n]; },
      useCallback(callback, deps) {
        const n = index++;
        if (!slots[n] || !depsEqual(slots[n].deps, deps)) slots[n] = { value: callback, deps };
        return slots[n].value;
      },
      useEffect(effect, deps) {
        const n = index++;
        if (!slots[n] || !depsEqual(slots[n].deps, deps)) {
          pendingEffects.push(() => {
            slots[n]?.cleanup?.();
            slots[n] = { deps, cleanup: effect() };
          });
        }
      },
    },
    mount(callback) { render = callback; },
    async settle() {
      for (let cycle = 0; cycle < 30; cycle += 1) {
        if (dirty) {
          dirty = false; index = 0; result = render();
          const effects = pendingEffects;
          pendingEffects = [];
          for (const effect of effects) effect();
        }
        await flush();
        if (!dirty) return result;
      }
      throw new Error("Hook did not quiesce");
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

async function settingsHarness(harness) {
  const runtime = hookRuntime();
  const statuses = await load("src/lib/webPush.js", harness.context);
  const accountStatuses = await load("src/lib/patientAccountStatus.js", harness.context);
  const hook = await load(hookPath, harness.context, {
    react: runtime.react,
    "../lib/patientNativePush": harness.api,
    "../lib/patientAuthLinking": { getCurrentPatientAccountStatus: async () => {
      const account = harness.accountMap.get(harness.currentSession?.user?.id);
      return { patient: account?.patient ? { id: account.patient } : null, status: account?.patientStatus };
    } },
    "../lib/patientAccountStatus": accountStatuses,
    "../lib/webPush": statuses,
  });
  runtime.mount(hook.usePatientNativePushNotifications);
  let state = await runtime.settle();
  const jsx = (type, props) => ({ type, props: props || {} });
  const component = await load(settingsPath, harness.context, {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@iconify/react": { Icon: () => null },
    "../../hooks/usePatientNativePushNotifications": { usePatientNativePushNotifications: () => state },
    "../../hooks/usePatientPushNotifications": { usePatientPushNotifications: () => { throw new Error("Unexpected Web Push path"); } },
    "../../lib/patientNativePush": harness.api,
    "../../lib/webPush": statuses,
    "../../styles/patient-push-settings.css": {},
  });
  const renderTree = node => {
    if (!node || typeof node !== "object") return node;
    if (typeof node.type === "function") return renderTree(node.type(node.props));
    return { ...node, props: { ...node.props,
      children: Array.isArray(node.props.children)
        ? node.props.children.map(renderTree) : renderTree(node.props.children) } };
  };
  const find = (node, predicate) => {
    if (!node || typeof node !== "object") return null;
    if (predicate(node)) return node;
    for (const child of [node.props?.children].flat()) {
      const found = find(child, predicate);
      if (found) return found;
    }
    return null;
  };
  return {
    get state() { return state; },
    async settle() { state = await runtime.settle(); return state; },
    tree() { return renderTree(component.default()); },
    disableButton() { return find(this.tree(), node => node.type === "button" && node.props.className === "is-disable"); },
    errorVisible() { return !!find(this.tree(), node => node.type === "p" && node.props.className === "is-error"); },
    unmount: runtime.unmount,
  };
}

async function senderHarness(model = registrationModel()) {
  const notification = { id: uid(501), patient_id: patientA, type: "general" };
  const notifications = new Map([[notification.id, notification]]);
  const ledger = new Map();
  const sends = [];
  const logs = [];
  const outcomes = new Map();
  const queries = [];
  let claimSequence = 600;
  let handler;
  const success = { ok: true, httpStatus: 200, providerMessageId: "synthetic-provider-message" };
  const db = {
    from(table) {
      assert.ok(["patient_notifications", "patient_native_push_devices", "patient_notification_native_push_deliveries"].includes(table));
      const query = { table, action: "select", filters: [] };
      queries.push(query);
      let execution;
      const execute = () => execution ||= Promise.resolve().then(() => {
        let rows;
        if (table === "patient_notifications") rows = [...notifications.values()];
        else if (table === "patient_native_push_devices") rows = [...model.rows.values()];
        else rows = [...ledger.values()];
        if (query.action === "insert") {
          assert.equal(table, "patient_notification_native_push_deliveries");
          const key = JSON.stringify([query.value.notification_id, query.value.device_id]);
          if (ledger.has(key)) return { data: null, error: { code: "23505" } };
          const row = { ...query.value, id: uid(++claimSequence) };
          ledger.set(key, row);
          return { data: { id: row.id }, error: null };
        }
        const matching = rows.filter(row => query.filters.every(([column, value]) => row[column] === value));
        if (query.action === "update") for (const row of matching) Object.assign(row, query.value);
        // Copy selection: subsequent rotation must not mutate the sender's snapshot.
        const copied = matching.map(row => ({ ...row }));
        return { data: query.single ? copied[0] ?? null : copied, error: null };
      });
      const builder = {
        select(columns) { query.columns = columns; return builder; },
        eq(column, value) { query.filters.push([column, value]); return builder; },
        insert(value) { query.action = "insert"; query.value = value; return builder; },
        update(value) { query.action = "update"; query.value = value; return builder; },
        maybeSingle() { query.single = true; return execute(); },
        single() { query.single = true; return execute(); },
        then(resolve, reject) { return execute().then(resolve, reject); },
      };
      return builder;
    },
  };
  const environment = new Map([
    ["NATIVE_PUSH_WEBHOOK_SECRET", "synthetic-webhook-secret"],
    ["SUPABASE_URL", "https://database.invalid"],
    ["SUPABASE_SERVICE_ROLE_KEY", "synthetic-server-key"],
  ]);
  const logger = (...args) => logs.push(args);
  const context = vm.createContext({
    console: { info: logger, warn: logger, error: logger },
    crypto: { subtle: webcrypto.subtle, randomUUID: () => uid(700) },
    TextEncoder, Request, Response, fetch: forbidNetwork,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : ["2026-10-02T00:00:00Z"])); } },
    Deno: {
      env: { get: key => environment.get(key) },
      serve: callback => { handler = callback; },
    },
  });
  await load(senderPath, context, {
    "@supabase/supabase-js": { createClient: () => db },
    "../_shared/firebaseMessaging.ts": {
      FirebaseConfigurationError: class extends Error {},
      getFirebaseAuthorization: async () => ({ projectId: "synthetic-project", accessToken: "synthetic-authorization" }),
      sendFirebaseMessage: async (authorization, message) => {
        assert.equal(authorization.projectId, "synthetic-project");
        sends.push({ ...message });
        const outcome = outcomes.get(message.token) || success;
        return typeof outcome === "function" ? outcome(message) : outcome;
      },
    },
  });
  return {
    model, ledger, sends, logs, outcomes, queries, notifications, notification,
    async invoke(id = notification.id, secret = "synthetic-webhook-secret") {
      const response = await handler(new Request("https://sender.invalid", {
        method: "POST", headers: { "x-webhook-secret": secret, "content-type": "application/json" },
        body: JSON.stringify({ type: "INSERT", schema: "public", table: "patient_notifications",
          record: { id }, old_record: null }),
      }));
      return { status: response.status, body: await response.json() };
    },
  };
}

const permanentFailure = { ok: false, httpStatus: 404, errorCode: "UNREGISTERED",
  errorMessage: "Synthetic permanent failure", permanentTokenFailure: true };
const transientFailure = { ok: false, httpStatus: 503, errorCode: "UNAVAILABLE",
  errorMessage: "Synthetic transient failure", permanentTokenFailure: false };
const tests = [];
const safeguard = (name, run) => tests.push({ name, run });
const defect = (name, reason, run) => tests.push({ name, expectedFailure: reason, run });

safeguard("SQL authorization model and uniqueness mirror recognized source", async () => {
  validateSqlModel();
  const model = registrationModel();
  assert.equal(model.authorizedTransfer, null, "No proof-based transfer API currently exists in this model");
});

safeguard("one Patient registers two independent installations", async () => {
  const model = registrationModel();
  const first = model.upsert(session(), uid(801), token(1));
  const second = model.upsert(session(), uid(802), token(2));
  assert.equal(model.rows.size, 2);
  assert.notEqual(first.id, second.id);
  assert.equal(first.patient_id, second.patient_id);
});

safeguard("same-owner token refresh updates one registration row", async () => {
  const model = registrationModel();
  const before = model.upsert(session(), uid(801), token(1));
  const after = model.upsert(session(), uid(801), token(2));
  assert.equal(model.rows.size, 1);
  assert.equal(after.id, before.id);
  assert.equal(after.push_token, token(2));
  assert.notEqual(after.updated_at, before.updated_at);
});

safeguard("actual repeated registration reuses installation and row", async () => {
  const h = await nativeHarness({ autoToken: token(1) });
  await h.api.registerPatientNativePushDevice();
  const first = [...h.model.rows.values()][0];
  await h.api.registerPatientNativePushDevice();
  assert.equal(h.model.rows.size, 1);
  assert.equal([...h.model.rows.values()][0].id, first.id);
  assert.equal(h.writes.length, 2);
});

safeguard("one token cannot create registrations for different installations", async () => {
  const model = registrationModel();
  model.upsert(session(), uid(801), token(1));
  assert.throws(() => model.upsert(session(), uid(802), token(1)), { code: "23505" });
  assert.equal(model.rows.size, 1);
});

safeguard("sender selects all and only enabled Android installations for canonical Patient", async () => {
  const model = registrationModel();
  model.upsert(session(), uid(801), token(1));
  model.upsert(session(), uid(802), token(2));
  model.upsert(session(), uid(803), token(3)).enabled = false;
  model.upsert(session(), uid(804), token(4)).platform = "ios";
  model.upsert(session(uid(2), uid(102)), uid(805), token(5));
  const h = await senderHarness(model);
  const result = await h.invoke();
  assert.equal(result.status, 200);
  assert.equal(result.body.sent, 2);
  assert.deepEqual(new Set(h.sends.map(message => message.token)), new Set([token(1), token(2)]));
});

safeguard("permanent failure disables only failed device; another device delivers", async () => {
  const model = registrationModel();
  model.upsert(session(), uid(801), token(1));
  model.upsert(session(), uid(802), token(2));
  const h = await senderHarness(model);
  h.outcomes.set(token(1), permanentFailure);
  const result = await h.invoke();
  assert.equal(result.body.disabledTokens, 1);
  assert.equal(result.body.sent, 1);
  assert.equal(model.rows.get(uid(801)).enabled, false);
  assert.equal(model.rows.get(uid(802)).enabled, true);
});

safeguard("device send exception leaves both registrations active and other delivery succeeds", async () => {
  const model = registrationModel();
  model.upsert(session(), uid(801), token(1));
  model.upsert(session(), uid(802), token(2));
  const h = await senderHarness(model);
  h.outcomes.set(token(1), async () => { throw new Error("synthetic transport exception"); });
  const result = await h.invoke();
  assert.equal(result.body.failed, 1);
  assert.equal(result.body.sent, 1);
  assert.equal([...model.rows.values()].every(row => row.enabled), true);
});

safeguard("delivery claim identity includes notification and device; repeat webhook does not resend", async () => {
  const model = registrationModel();
  model.upsert(session(), uid(801), token(1));
  model.upsert(session(), uid(802), token(2));
  const h = await senderHarness(model);
  await h.invoke();
  assert.equal(h.ledger.size, 2);
  const firstKeys = new Set([...h.ledger.values()].map(row => row.device_id));
  assert.equal(firstKeys.size, 2);
  const repeat = await h.invoke();
  assert.equal(repeat.body.skipped, 2);
  assert.equal(h.sends.length, 2);
  h.notifications.set(uid(502), { ...h.notification, id: uid(502) });
  await h.invoke(uid(502));
  assert.equal(h.ledger.size, 4);
  assert.equal(h.sends.length, 4);
});

safeguard("old delivery failure cannot disable a newly rotated registration", async () => {
  const model = registrationModel();
  model.upsert(session(), uid(801), token(1));
  const h = await senderHarness(model);
  h.outcomes.set(token(1), async () => {
    model.upsert(session(), uid(801), token(2));
    return permanentFailure;
  });
  const result = await h.invoke();
  assert.equal(result.body.disabledTokens, 0);
  assert.equal(model.rows.get(uid(801)).enabled, true);
  assert.equal(model.rows.get(uid(801)).push_token, token(2));
  assert.equal([...h.ledger.values()][0].status, "failed");
});

safeguard("transient device failure preserves enabled registration", async () => {
  const model = registrationModel();
  model.upsert(session(), uid(801), token(1));
  const h = await senderHarness(model);
  h.outcomes.set(token(1), transientFailure);
  const result = await h.invoke();
  assert.equal(result.body.failed, 1);
  assert.equal(model.rows.get(uid(801)).enabled, true);
});

safeguard("cleanup is idempotent across later notifications and repeat delivery", async () => {
  const model = registrationModel();
  model.upsert(session(), uid(801), token(1));
  const h = await senderHarness(model);
  h.outcomes.set(token(1), permanentFailure);
  await h.invoke();
  const disabledAt = model.rows.get(uid(801)).disabled_at;
  await h.invoke();
  h.notifications.set(uid(502), { ...h.notification, id: uid(502) });
  await h.invoke(uid(502));
  assert.equal(h.sends.length, 1);
  assert.equal(model.rows.get(uid(801)).disabled_at, disabledAt);
});

safeguard("sender rejects unauthorized request without device reads or sends", async () => {
  const h = await senderHarness();
  const result = await h.invoke(undefined, "synthetic-wrong-secret");
  assert.equal(result.status, 401);
  assert.equal(h.queries.length, 0);
  assert.equal(h.sends.length, 0);
});

safeguard("sender logs exclude registration values and send metadata excludes Patient identity", async () => {
  const model = registrationModel();
  model.upsert(session(), uid(801), token(1));
  const h = await senderHarness(model);
  await h.invoke();
  const logText = JSON.stringify(h.logs);
  assert.equal(logText.includes(token(1)), false);
  assert.equal(logText.includes(patientA), false);
  const message = h.sends[0];
  assert.deepEqual(Object.keys(message).sort(), ["notificationId", "notificationType", "route", "token"]);
  assert.equal(Object.keys(message).includes("patientId"), false);
});

const beginRegistration = async h => {
  const op = observe(h.api.registerPatientNativePushDevice());
  await flush();
  return op;
};
const requireSuccessfulRegistration = async h => {
  const op = await beginRegistration(h);
  h.emit(token(1));
  await complete(op);
  assert.equal(op.error, undefined, "initial registration must succeed");
  return h.storage.get(installationKey);
};

safeguard("retained older event must not skip fresh register", async () => {
  const h = await nativeHarness({ retained: [token(1)], autoToken: token(2) });
  const op = observe(h.api.registerPatientNativePushDevice());
  await complete(op);
  assert.equal(op.error, undefined);
  check(h.registerCalls === 1, "retained older event must not skip fresh register");
  assert.equal(h.writes.length, 1);
  assert.equal([...h.model.rows.values()][0].push_token, token(2));
});

safeguard("newer retained token must win over older retained token", async () => {
  const h = await nativeHarness({ retained: [token(1), token(2)] });
  const op = observe(h.api.registerPatientNativePushDevice());
  await complete(op);
  assert.equal(op.error, undefined);
  assert.equal(h.model.rows.size, 1);
  check([...h.model.rows.values()][0].push_token === token(2), "newer retained token must win over older retained token");
});

safeguard("closely spaced token updates must persist the latest token", async () => {
  const h = await nativeHarness();
  const op = await beginRegistration(h);
  assert.equal(h.registerCalls, 1);
  h.emit(token(1));
  h.emit(token(2));
  await complete(op);
  assert.equal(op.error, undefined);
  assert.equal(h.model.rows.size, 1);
  check([...h.model.rows.values()][0].push_token === token(2), "closely spaced token updates must persist the latest token");
});

safeguard("later foreground token rotation must update the existing row", async () => {
  const h = await nativeHarness();
  const installation = await requireSuccessfulRegistration(h);
  const firstId = h.model.rows.get(installation).id;
  h.emit(token(2));
  await flush();
  assert.equal(h.model.rows.size, 1);
  assert.equal(h.model.rows.get(installation).id, firstId);
  check(h.model.rows.get(installation).push_token === token(2), "later foreground token rotation must update the existing row");
});


safeguard("newer token arriving during an older upsert is serialized and wins", async () => {
  const h = await nativeHarness();
  const op = await beginRegistration(h);
  const gate = h.pause("rpc:upsert_my_patient_native_push_device");
  h.emit(token(1));
  await flush();
  assert.equal(gate.started, true);
  h.emit(token(2));
  h.emit(token(3));
  await flush();
  assert.equal(h.writes.length, 0);
  assert.equal(h.calls.filter(call => call === "upsert_my_patient_native_push_device").length, 1);
  gate.release();
  await complete(op);
  assert.equal(op.error, undefined);
  assert.deepEqual(h.writes.map(write => write.value), [token(1), token(3)]);
  assert.equal([...h.model.rows.values()][0].push_token, token(3));
  assert.equal(h.registerCalls, 1);
});

safeguard("duplicate token callbacks do not produce extra upserts or register calls", async () => {
  const h = await nativeHarness();
  await requireSuccessfulRegistration(h);
  h.emit(token(1));
  h.emit(token(1));
  await flush();
  assert.equal(h.writes.length, 1);
  h.emit(token(2));
  h.emit(token(2));
  await flush();
  assert.equal(h.writes.length, 2);
  assert.equal(h.registerCalls, 1);
  assert.equal(h.listenerCount(), 1);
  assert.equal(h.listenerCount("registrationError"), 1);
});

safeguard("rotation revalidates authorization and coalesces tokens received during that check", async () => {
  const h = await nativeHarness();
  const installation = await requireSuccessfulRegistration(h);
  const gate = h.pause("profile");
  h.emit(token(2));
  await flush();
  assert.equal(gate.started, true);
  h.emit(token(3));
  gate.release();
  await flush();
  assert.equal(h.model.rows.get(installation).push_token, token(3));
  assert.deepEqual(h.writes.map(write => write.value), [token(1), token(3)]);
  assert.equal(h.registerCalls, 1);
});

safeguard("same logical session refresh preserves continuous rotation", async () => {
  const h = await nativeHarness();
  const installation = await requireSuccessfulRegistration(h);
  const gate = h.pause("profile");
  h.emit(token(2));
  await flush();
  assert.equal(gate.started, true);
  await h.authChange(session(uid(1), uid(101), 1), "TOKEN_REFRESHED");
  gate.release();
  await flush();
  assert.equal(h.model.rows.get(installation).push_token, token(2));
  assert.equal(h.listenerCount(), 1);
  assert.equal(h.registerCalls, 1);
});

for (const [label, next, event] of [
  ["sign-out", null, "SIGNED_OUT"],
  ["Patient switch", session(uid(2), uid(102)), "SIGNED_IN"],
  ["replacement session_id", session(uid(1), uid(999)), "SIGNED_IN"],
]) safeguard(label + " aborts pending rotation and detaches stale listeners", async () => {
  const h = await nativeHarness();
  const installation = await requireSuccessfulRegistration(h);
  const staleCallback = h.savedTokenCallback();
  const gate = h.pause("rpc:upsert_my_patient_native_push_device");
  h.emit(token(2));
  await flush();
  assert.equal(gate.started, true);
  await h.authChange(next, event);
  assert.equal(h.listenerCount(), 0);
  assert.equal(h.listenerCount("registrationError"), 0);
  staleCallback({ value: token(3) });
  gate.release();
  await flush();
  assert.equal(h.writes.length, 1);
  assert.equal(h.model.rows.get(installation).push_token, token(1));
  assert.equal(h.calls.includes("deactivate_my_patient_native_push_device"), false);
});

safeguard("logout synchronously invalidates rotation before asynchronous cleanup", async () => {
  const h = await nativeHarness();
  await requireSuccessfulRegistration(h);
  const staleCallback = h.savedTokenCallback();
  const gate = h.pause("profile");
  h.emit(token(2));
  await flush();
  assert.equal(gate.started, true);
  const logout = observe(h.api.cleanupPatientNativePushBeforeLogout());
  staleCallback({ value: token(3) });
  await complete(logout);
  gate.release();
  await flush();
  assert.equal(h.writes.length, 1);
  assert.equal(h.listenerCount(), 0);
  assert.equal(logout.value.deactivated, true);
});

safeguard("shell lifecycle replacement cannot reuse an old token callback after login", async () => {
  const h = await nativeHarness();
  await requireSuccessfulRegistration(h);
  const staleCallback = h.savedTokenCallback();
  h.api.endPatientNativePushSession();
  await h.authChange(session(uid(2), uid(102)));
  h.api.beginPatientNativePushSession();
  staleCallback({ value: token(2) });
  await flush();
  assert.equal(h.writes.length, 1);
  // B uses a distinct installation; normal registration cannot transfer A's row.
  h.storage.set(installationKey, uid(803));
  const op = await beginRegistration(h);
  h.emit(token(3));
  await complete(op);
  assert.equal(op.error, undefined);
  staleCallback({ value: token(4) });
  await flush();
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].owner, uid(2));
  assert.equal(h.writes[1].value, token(3));
  assert.equal(h.listenerCount(), 1);
});

safeguard("Disable during rotation prevents callbacks from reactivating the existing row", async () => {
  const h = await nativeHarness();
  const installation = await requireSuccessfulRegistration(h);
  const staleCallback = h.savedTokenCallback();
  const gate = h.pause("rpc:upsert_my_patient_native_push_device");
  h.emit(token(2));
  await flush();
  assert.equal(gate.started, true);
  const disabled = observe(h.api.disablePatientNativePushDevice());
  staleCallback({ value: token(3) });
  await complete(disabled);
  gate.release();
  h.emit(token(4));
  await h.api.reconcilePatientNativePushRegistration();
  await flush();
  assert.equal(h.writes.length, 1);
  assert.equal(h.model.rows.get(installation).enabled, false);
  assert.equal(h.storage.get(disabledKey), "true");
  assert.equal(h.listenerCount(), 0);
  assert.equal(h.registerCalls, 1);
  const enabled = observe(h.api.registerPatientNativePushDevice({ allowExplicitlyDisabled: true }));
  await flush();
  h.emit(token(5));
  await complete(enabled);
  assert.equal(enabled.error, undefined);
  assert.equal(h.model.rows.size, 1);
  assert.equal(h.model.rows.get(installation).push_token, token(5));
  assert.equal(h.api.isPatientNativePushExplicitlyDisabled(), false);
  h.emit(token(6));
  await flush();
  assert.equal(h.model.rows.get(installation).push_token, token(6));
  assert.equal(h.registerCalls, 2);
});

safeguard("a failed older upsert still drains a newer token already queued", async () => {
  const h = await nativeHarness();
  const op = await beginRegistration(h);
  const gate = h.pause("rpc:upsert_my_patient_native_push_device");
  h.failPersistence();
  h.emit(token(1));
  await flush();
  assert.equal(gate.started, true);
  h.emit(token(2));
  gate.release();
  await complete(op);
  assert.equal(op.error, undefined);
  assert.equal(h.writes.length, 1);
  assert.equal([...h.model.rows.values()][0].push_token, token(2));
  assert.equal(h.calls.includes("deactivate_my_patient_native_push_device"), false);
});

safeguard("transient rotation failure does not replay an old token or start a retry loop", async () => {
  const h = await nativeHarness();
  const installation = await requireSuccessfulRegistration(h);
  const firstId = h.model.rows.get(installation).id;
  h.failPersistence();
  h.emit(token(2));
  await flush();
  assert.equal(h.writes.length, 1);
  assert.equal(h.model.rows.get(installation).enabled, false);
  const upserts = h.calls.filter(call => call === "upsert_my_patient_native_push_device").length;
  h.emit(token(2));
  await flush();
  assert.equal(h.calls.filter(call => call === "upsert_my_patient_native_push_device").length, upserts);
  assert.equal(h.registerCalls, 1);
  h.emit(token(3));
  await flush();
  assert.equal(h.model.rows.get(installation).push_token, token(3));
  assert.equal(h.model.rows.get(installation).enabled, true);
  assert.equal(h.model.rows.get(installation).id, firstId);
  assert.equal(h.registerCalls, 1);
});

safeguard("initial coordination waits for register to start and uses callbacks received meanwhile", async () => {
  const h = await nativeHarness({ retained: [token(1)] });
  const gate = h.pause("register");
  const op = await beginRegistration(h);
  assert.equal(gate.started, true);
  assert.equal(h.writes.length, 0);
  h.emit(token(2));
  gate.release();
  await complete(op);
  assert.equal(op.error, undefined);
  assert.equal(h.writes.length, 1);
  assert.equal([...h.model.rows.values()][0].push_token, token(2));
});

safeguard("a delayed fresh callback supersedes retained data without another register call", async () => {
  const h = await nativeHarness({ retained: [token(1)] });
  const op = await beginRegistration(h);
  await complete(op);
  assert.equal(op.error, undefined);
  h.emit(token(2));
  await flush();
  assert.equal([...h.model.rows.values()][0].push_token, token(2));
  assert.equal(h.registerCalls, 1);
});

safeguard("cancellation during listener attachment removes late handles and blocks saved callbacks", async () => {
  for (const stage of ["listener:registration", "listener:registrationError"]) {
    const h = await nativeHarness();
    const gate = h.pause(stage);
    const op = await beginRegistration(h);
    assert.equal(gate.started, true);
    const staleCallback = h.savedTokenCallback();
    await h.authChange(null, "SIGNED_OUT");
    await complete(op);
    gate.release();
    await flush();
    staleCallback({ value: token(2) });
    await flush();
    assert.equal(h.listenerCount(), 0);
    assert.equal(h.listenerCount("registrationError"), 0);
    assert.equal(h.registerCalls, 0);
    assert.equal(h.writes.length, 0);
  }
});

safeguard("invalid later callbacks cannot replace a valid token", async () => {
  const h = await nativeHarness();
  const installation = await requireSuccessfulRegistration(h);
  h.emit("invalid");
  await flush();
  assert.equal(h.writes.length, 1);
  assert.equal(h.model.rows.get(installation).push_token, token(1));
});

safeguard("native registration failure and timeout detach the persistent listeners", async () => {
  for (const failure of ["register", "event", "timeout"]) {
    const h = await nativeHarness();
    if (failure === "register") h.failRegister();
    const op = await beginRegistration(h);
    if (failure === "event") h.emitError();
    if (failure === "timeout") await h.time.advance(20_000);
    await complete(op);
    assert.equal(op.error?.code, failure === "timeout" ? "registration_timeout" : "registration_failed");
    assert.equal(h.listenerCount(), 0);
    assert.equal(h.listenerCount("registrationError"), 0);
    assert.equal(h.writes.length, 0);
  }
});

safeguard("a token arriving during registration completion starts exactly one follow-up update", async () => {
  const h = await nativeHarness();
  let emitted = false;
  h.window.addEventListener(h.api.patientNativePushStatusChangedEvent, event => {
    if (event.detail.enabled && !emitted) { emitted = true; h.emit(token(2)); }
  });
  const installation = await requireSuccessfulRegistration(h);
  await flush();
  assert.equal(h.model.rows.get(installation).push_token, token(2));
  assert.equal(h.writes.length, 2);
  assert.equal(h.registerCalls, 1);
});

safeguard("newer rotation received during failure cleanup is not lost", async () => {
  const h = await nativeHarness();
  const installation = await requireSuccessfulRegistration(h);
  const gate = h.pause("rpc:deactivate_my_patient_native_push_device");
  h.failPersistence();
  h.emit(token(2));
  await flush();
  assert.equal(gate.started, true);
  h.emit(token(3));
  gate.release();
  await flush();
  assert.equal(h.model.rows.get(installation).push_token, token(3));
  assert.equal(h.model.rows.get(installation).enabled, true);
  assert.deepEqual(h.writes.map(write => write.value), [token(1), token(3)]);
  assert.equal(h.registerCalls, 1);
});

safeguard("changed Patient eligibility blocks continuous rotation before an upsert", async () => {
  const accountMap = new Map([[uid(1), activeAccount()]]);
  const h = await nativeHarness({ accountMap, model: registrationModel(accountMap) });
  await requireSuccessfulRegistration(h);
  accountMap.get(uid(1)).patientStatus = "inactive";
  h.emit(token(2));
  await flush();
  assert.equal(h.writes.length, 1);
  assert.equal(h.listenerCount(), 0);
  assert.equal(h.listenerCount("registrationError"), 0);
  assert.equal(h.calls.filter(call => call === "upsert_my_patient_native_push_device").length, 1);
});

safeguard("concurrent registration callers share one native request and one upsert", async () => {
  const h = await nativeHarness();
  const first = h.api.registerPatientNativePushDevice();
  const second = h.api.registerPatientNativePushDevice();
  assert.equal(first, second);
  const op = observe(first);
  await flush();
  assert.equal(h.registerCalls, 1);
  h.emit(token(1));
  await complete(op);
  assert.equal(op.error, undefined);
  assert.equal(h.writes.length, 1);
});

safeguard("explicit disable cancels pending registration and blocks automatic resume", async () => {
  const h = await nativeHarness();
  const op = await beginRegistration(h);
  const disabled = observe(h.api.disablePatientNativePushDevice());
  await complete(op);
  await complete(disabled);
  assert.equal(op.error?.code, "explicit_disable");
  assert.equal(disabled.value.deactivated, true);
  assert.equal(h.writes.length, 0);
  const before = h.registerCalls;
  h.emit(token(2));
  const result = await h.api.reconcilePatientNativePushRegistration();
  assert.equal(result.registered, false);
  assert.equal(h.registerCalls, before);
  assert.equal(h.writes.length, 0);
  assert.equal(h.api.isPatientNativePushExplicitlyDisabled(), true);
  assert.equal(h.storage.get(disabledKey), "true");
});

safeguard("explicit re-enable clears disable preference only after success and reuses row", async () => {
  const h = await nativeHarness({ autoToken: token(1) });
  await h.api.registerPatientNativePushDevice();
  const firstId = [...h.model.rows.values()][0].id;
  await h.api.disablePatientNativePushDevice();
  assert.equal(h.api.isPatientNativePushExplicitlyDisabled(), true);
  await h.api.registerPatientNativePushDevice({ allowExplicitlyDisabled: true });
  assert.equal(h.api.isPatientNativePushExplicitlyDisabled(), false);
  assert.equal(h.model.rows.size, 1);
  assert.equal([...h.model.rows.values()][0].id, firstId);
  assert.equal([...h.model.rows.values()][0].enabled, true);
});

safeguard("failed explicit re-enable keeps local disable and database row disabled", async () => {
  const h = await nativeHarness();
  const installation = await requireSuccessfulRegistration(h);
  await h.api.disablePatientNativePushDevice();
  const op = observe(h.api.registerPatientNativePushDevice({ allowExplicitlyDisabled: true }));
  await flush();
  h.emit("invalid-synthetic-value");
  await complete(op);
  assert.equal(op.error?.code, "registration_failed");
  assert.equal(h.api.isPatientNativePushExplicitlyDisabled(), true);
  assert.equal(h.model.rows.get(installation).enabled, false);
  assert.equal(h.model.rows.size, 1);
});

safeguard("registration timeout cleans listeners and does not persist", async () => {
  const h = await nativeHarness();
  const op = await beginRegistration(h);
  await h.time.advance(20_000);
  await complete(op);
  assert.equal(op.error?.code, "registration_timeout");
  assert.equal(h.writes.length, 0);
  assert.equal(h.time.size, 0);
});

safeguard("Patient switch must not persist an old registration under the new Patient", async () => {
  const h = await nativeHarness();
  const op = await beginRegistration(h);
  await h.authChange(session(uid(2), uid(102)));
  h.emit(token(1));
  await complete(op);
  check(h.writes.every(write => write.owner !== uid(2)), "Patient switch must not persist an old registration under the new Patient");
});

safeguard("same-user new session_id must invalidate stale registration", async () => {
  const h = await nativeHarness();
  const op = await beginRegistration(h);
  await h.authChange(session(uid(1), uid(999)));
  h.emit(token(1));
  await complete(op);
  check(h.writes.length === 0, "same-user new session_id must invalidate stale registration");
});

safeguard("same valid session refresh allows registration to complete", async () => {
  const h = await nativeHarness();
  const op = await beginRegistration(h);
  await h.authChange(session(uid(1), uid(101), 1), "TOKEN_REFRESHED");
  h.emit(token(1));
  await complete(op);
  assert.equal(op.error, undefined);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].owner, uid(1));
});

safeguard("normal logout cleanup cancels registration before signing out", async () => {
  const h = await nativeHarness();
  const op = await beginRegistration(h);
  const logout = observe(h.api.cleanupPatientNativePushBeforeLogout());
  await complete(op);
  await complete(logout);
  await h.authChange(null, "SIGNED_OUT");
  h.emit(token(1));
  await flush();
  assert.equal(op.error?.code, "logout_cleanup");
  assert.equal(h.writes.length, 0);
  assert.equal(logout.value.deactivated, true);
  assert.equal(h.unregisterCalls, 1);
});

safeguard("auth SIGNED_OUT alone must cancel pending registration", async () => {
  const h = await nativeHarness();
  const op = await beginRegistration(h);
  await h.authChange(null, "SIGNED_OUT");
  await flush();
  const cancelledImmediately = op.settled && op.error?.code !== "persistence_failed";
  // Finish the controlled operation after observing the boundary; no timer is left running.
  h.emit(token(1));
  await complete(op);
  assert.equal(h.writes.length, 0, "unauthenticated RPC model must still reject writes");
  check(cancelledImmediately, "auth SIGNED_OUT alone must cancel pending registration");
});

safeguard("explicit session replacement cancels pending registration", async () => {
  const h = await nativeHarness();
  const op = await beginRegistration(h);
  h.api.beginPatientNativePushSession();
  await complete(op);
  h.emit(token(1));
  assert.equal(op.error?.code, "session_replaced");
  assert.equal(h.writes.length, 0);
});


safeguard("signed-out registration cannot resume after a later Patient login", async () => {
  const h = await nativeHarness();
  const op = await beginRegistration(h);
  await h.authChange(null, "SIGNED_OUT");
  await complete(op);
  assert.equal(op.error?.code, "auth_changed");
  await h.authChange(session(uid(2), uid(102)));
  h.api.beginPatientNativePushSession();
  h.emit(token(1));
  await flush();
  assert.equal(h.writes.length, 0);
  assert.equal(h.calls.includes("upsert_my_patient_native_push_device"), false);
});

safeguard("generation cancellation during session capture prevents native work and writes", async () => {
  const h = await nativeHarness();
  const gate = h.pause("session");
  const op = observe(h.api.registerPatientNativePushDevice());
  await flush();
  assert.equal(gate.started, true);
  h.api.beginPatientNativePushSession();
  await complete(op);
  gate.release();
  await flush();
  assert.equal(op.error?.code, "session_replaced");
  assert.equal(h.registerCalls, 0);
  assert.equal(h.writes.length, 0);
});

safeguard("Patient switch during final authorization prevents the upsert from being issued", async () => {
  const h = await nativeHarness();
  const op = await beginRegistration(h);
  const gate = h.pause("profile");
  h.emit(token(1));
  await flush();
  assert.equal(gate.started, true);
  await h.authChange(session(uid(2), uid(102)));
  gate.release();
  await complete(op);
  assert.equal(op.error?.code, "auth_changed");
  assert.equal(h.calls.includes("upsert_my_patient_native_push_device"), false);
  assert.equal(h.writes.length, 0);
});

safeguard("same-session refresh during final authorization can complete safely", async () => {
  const h = await nativeHarness();
  const op = await beginRegistration(h);
  const gate = h.pause("profile");
  h.emit(token(1));
  await flush();
  assert.equal(gate.started, true);
  await h.authChange(session(uid(1), uid(101), 1), "TOKEN_REFRESHED");
  gate.release();
  await complete(op);
  assert.equal(op.error, undefined);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].owner, uid(1));
});

safeguard("sign-out aborts a dispatched but still pending persistence request", async () => {
  const h = await nativeHarness();
  const op = await beginRegistration(h);
  const gate = h.pause("rpc:upsert_my_patient_native_push_device");
  h.emit(token(1));
  await flush();
  assert.equal(gate.started, true);
  await h.authChange(null, "SIGNED_OUT");
  gate.release();
  await complete(op);
  assert.equal(op.error?.code, "auth_changed");
  assert.equal(h.writes.length, 0);
});

safeguard("cancelled persistence and compensation cannot mutate a replacement Patient row", async () => {
  const h = await nativeHarness();
  const op = await beginRegistration(h);
  const installation = h.storage.get(installationKey);
  const gate = h.pause("rpc:upsert_my_patient_native_push_device");
  h.emit(token(1));
  await flush();
  assert.equal(gate.started, true);
  await h.authChange(session(uid(2), uid(102)));
  const replacement = h.model.upsert(h.currentSession, installation, token(2));
  gate.release();
  await complete(op);
  assert.equal(op.error?.code, "auth_changed");
  assert.equal(h.writes.length, 0);
  assert.equal(replacement.enabled, true);
  assert.equal(replacement.push_token, token(2));
  assert.equal(h.calls.includes("deactivate_my_patient_native_push_device"), false);
});

safeguard("logout invalidation precedes asynchronous deactivation", async () => {
  const h = await nativeHarness();
  const op = await beginRegistration(h);
  const gate = h.pause("rpc:deactivate_my_patient_native_push_device");
  const logout = observe(h.api.cleanupPatientNativePushBeforeLogout());
  // No await before this callback: logout must have already invalidated the operation.
  h.emit(token(1));
  await flush();
  assert.equal(gate.started, true);
  await complete(op);
  assert.equal(op.error?.code, "logout_cleanup");
  assert.equal(h.writes.length, 0);
  gate.release();
  await complete(logout);
  assert.equal(logout.value.deactivated, true);
});

safeguard("logout cleanup does not run under a replacement account", async () => {
  const h = await nativeHarness();
  const installation = await requireSuccessfulRegistration(h);
  const gate = h.pause("session");
  const logout = observe(h.api.cleanupPatientNativePushBeforeLogout());
  await flush();
  assert.equal(gate.started, true);
  await h.authChange(session(uid(2), uid(102)));
  // A fresh B installation keeps the cleanup isolation assertion independent of takeover.
  h.storage.set(installationKey, uid(804));
  const replacement = h.model.upsert(h.currentSession, uid(804), token(2));
  gate.release();
  await complete(logout);
  assert.equal(logout.value.deactivated, false);
  assert.equal(logout.value.unregistered, false);
  assert.equal(h.model.rows.get(installation).enabled, true);
  assert.equal(replacement.enabled, true);
  assert.equal(h.calls.includes("deactivate_my_patient_native_push_device"), false);
});

safeguard("Patient access is revalidated after native registration and before the upsert", async () => {
  for (const updates of [{ role: "doctor" }, { patientStatus: "inactive" },
    { patientStatus: "pending_activation" }, { patient: null }, { archived: true }]) {
    const accountMap = new Map([[uid(1), activeAccount()]]);
    const h = await nativeHarness({ accountMap, model: registrationModel(accountMap) });
    const op = await beginRegistration(h);
    assert.equal(h.registerCalls, 1);
    Object.assign(accountMap.get(uid(1)), updates);
    h.emit(token(1));
    await complete(op);
    assert.equal(op.error?.code, "inactive_patient");
    assert.equal(h.calls.includes("upsert_my_patient_native_push_device"), false);
    assert.equal(h.writes.length, 0);
  }
});


safeguard("logout auth reads remain bounded and late reads cannot trigger cleanup", async () => {
  const h = await nativeHarness();
  const gate = h.pause("session");
  const logout = observe(h.api.cleanupPatientNativePushBeforeLogout());
  await flush();
  assert.equal(gate.started, true);
  await h.time.advance(2_500);
  await h.time.advance(2_500);
  await complete(logout);
  assert.equal(logout.value.deactivated, false);
  assert.equal(logout.value.unregistered, false);
  gate.release();
  await flush();
  assert.equal(h.calls.includes("deactivate_my_patient_native_push_device"), false);
  assert.equal(h.unregisterCalls, 0);
});

safeguard("server-verified user mismatch prevents native registration and persistence", async () => {
  const h = await nativeHarness();
  h.mismatchUser();
  const op = observe(h.api.registerPatientNativePushDevice());
  await complete(op);
  assert.equal(op.error?.code, "inactive_patient");
  assert.equal(h.registerCalls, 0);
  assert.equal(h.writes.length, 0);
});

safeguard("missing or malformed logical session identity fails closed", async () => {
  for (const invalid of [session(uid(1), "invalid-session"),
    { user: { id: uid(1) }, access_token: "synthetic.invalid.synthetic" }]) {
    const h = await nativeHarness({ initialSession: invalid });
    const op = observe(h.api.registerPatientNativePushDevice());
    await complete(op);
    assert.equal(op.error?.code, "auth_changed");
    assert.equal(h.registerCalls, 0);
    assert.equal(h.writes.length, 0);
  }
});

safeguard("shell lifecycle end cancels work and session starts do not duplicate auth observers", async () => {
  const h = await nativeHarness();
  const op = await beginRegistration(h);
  assert.equal(h.authListenerCount, 1);
  h.api.endPatientNativePushSession();
  h.emit(token(1));
  await complete(op);
  assert.equal(op.error?.code, "session_ended");
  assert.equal(h.writes.length, 0);
  assert.equal(h.authListenerCount, 0);
  for (let i = 0; i < 3; i += 1) h.api.beginPatientNativePushSession();
  assert.equal(h.authListenerCount, 1);
});

for (const [label, updates] of [
  ["Doctor", { role: "doctor" }], ["missing role", { role: undefined }], ["Staff", { role: "staff" }], ["Admin", { role: "admin" }],
  ["inactive Patient", { patientStatus: "inactive" }], ["pending Patient", { patientStatus: "pending" }], ["pending activation Patient", { patientStatus: "pending_activation" }],
  ["inactive profile", { profileStatus: "inactive" }], ["archived Patient", { archived: true }],
  ["archived record status", { recordStatus: "archived" }], ["deleted record status", { recordStatus: "deleted" }],
  ["unlinked Patient", { patient: null }],
]) safeguard("registration authorization rejects " + label, async () => {
  const accountMap = new Map([[uid(1), { ...activeAccount(), ...updates }]]);
  const model = registrationModel(accountMap);
  const h = await nativeHarness({ model, accountMap, autoToken: token(1) });
  const op = observe(h.api.registerPatientNativePushDevice());
  await complete(op);
  assert.equal(op.error?.code, "inactive_patient");
  assert.equal(h.registerCalls, 0, "invalid account must be blocked before native registration");
  assert.equal(model.rows.size, 0);
  assert.equal(h.writes.length, 0);
});

safeguard("own-device deactivation cannot disable another Patient's registration", async () => {
  const model = registrationModel();
  model.upsert(session(), uid(801), token(1));
  const result = model.deactivate(session(uid(2), uid(102)), uid(801));
  assert.equal(result, false);
  assert.equal(model.rows.get(uid(801)).enabled, true);
});

safeguard("knowing another installation UUID must not authorize takeover", async () => {
  const model = registrationModel();
  model.upsert(session(), uid(801), token(1));
  let rejected = false;
  try { model.upsert(session(uid(2), uid(102)), uid(801), token(2)); }
  catch (error) { if (error.code !== "42501") throw error; rejected = true; }
  check(rejected && model.rows.get(uid(801)).user_id === uid(1), "knowing another installation UUID must not authorize takeover");
});

safeguard("disabled registration still requires authorization for ownership transfer", async () => {
  const model = registrationModel();
  model.upsert(session(), uid(801), token(1));
  model.deactivate(session(), uid(801));
  assert.equal(model.authorizedTransfer, null);
  let rejected = false;
  try { model.upsert(session(uid(2), uid(102)), uid(801), token(2)); }
  catch (error) { if (error.code !== "42501") throw error; rejected = true; }
  check(rejected, "disabled registration still requires authorization for ownership transfer");
});

safeguard("forward upsert retains signature, definer safety, least privilege, and token error sanitization", async () => {
  const sql = effectiveUpsertSql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();
  assert.match(sql, /create or replace function public\.upsert_my_patient_native_push_device\( p_installation_id text, p_push_token text, p_platform text default 'android', p_app_version text default null \) returns jsonb language plpgsql security definer set search_path = ''/);
  assert.ok(sql.includes("revoke all on function public.upsert_my_patient_native_push_device( text, text, text, text ) from public, anon, authenticated"));
  assert.ok(sql.includes("grant execute on function public.upsert_my_patient_native_push_device( text, text, text, text ) to authenticated"));
  assert.doesNotMatch(sql, /create table|alter table|drop |grant.*on table|create policy|create or replace function public\.(deactivate|get_my)/);
  assert.ok(sql.includes("when unique_violation then raise exception 'the native push registration conflicts with another app installation.' using errcode = '23505'"));
  assert.ok(protectsInstallationOwnership);
});

safeguard("new installation ownership is derived from its active linked Patient", async () => {
  const model = registrationModel();
  const row = model.upsert(session(uid(2), uid(102)), uid(851), token(2));
  assert.equal(row.user_id, uid(2));
  assert.equal(row.patient_id, patientB);
  assert.equal(row.enabled, true);
  assert.equal(model.rows.size, 1);
});

safeguard("same-owner update and token rotation preserve ownership and row identity", async () => {
  const model = registrationModel();
  const first = model.upsert(session(), uid(851), token(1));
  const rotated = model.upsert(session(), uid(851), token(2));
  assert.equal(rotated.id, first.id);
  assert.equal(rotated.patient_id, first.patient_id);
  assert.equal(rotated.user_id, first.user_id);
  assert.equal(rotated.push_token, token(2));
  assert.notEqual(rotated.updated_at, first.updated_at);
  assert.notEqual(rotated.last_seen_at, first.last_seen_at);
  assert.equal(model.rows.size, 1);
});

safeguard("same-owner re-enable preserves installation and registration identity", async () => {
  const model = registrationModel();
  const first = model.upsert(session(), uid(851), token(1));
  model.deactivate(session(), uid(851));
  const enabled = model.upsert(session(), uid(851), token(2));
  assert.equal(enabled.id, first.id);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.disabled_at, null);
  assert.equal(enabled.user_id, uid(1));
  assert.equal(model.rows.size, 1);
});

for (const disabled of [false, true]) safeguard("failed takeover preserves every original field (disabled=" + disabled + ")", async () => {
  const model = registrationModel();
  model.upsert(session(), uid(851), token(1));
  if (disabled) model.deactivate(session(), uid(851));
  const before = { ...model.rows.get(uid(851)) };
  assert.throws(() => model.upsert(session(uid(2), uid(102)), uid(851), token(2)), { code: "42501" });
  assert.deepEqual(model.rows.get(uid(851)), before);
  assert.equal(model.rows.size, 1);
});

safeguard("both auth user and canonical Patient must match existing ownership", async () => {
  const accountMap = new Map([[uid(1), activeAccount()], [uid(2), activeAccount(uid(2), patientA)]]);
  const model = registrationModel(accountMap);
  const first = model.upsert(session(), uid(851), token(1));
  assert.throws(() => model.upsert(session(uid(2), uid(102)), uid(851), token(2)), { code: "42501" });
  accountMap.get(uid(1)).patient = patientB;
  assert.throws(() => model.upsert(session(), uid(851), token(2)), { code: "42501" });
  assert.deepEqual(model.rows.get(uid(851)), first);
});

safeguard("knowing both installation and its token still does not authorize takeover", async () => {
  const model = registrationModel();
  const first = model.upsert(session(), uid(851), token(1));
  assert.throws(() => model.upsert(session(uid(2), uid(102)), uid(851), token(1)), { code: "42501" });
  assert.deepEqual(model.rows.get(uid(851)), first);
});

safeguard("token conflicts cannot mutate either installation or leak ownership in the error", async () => {
  for (const useExistingInstallation of [false, true]) {
    const model = registrationModel();
    model.upsert(session(), uid(851), token(1));
    model.upsert(session(uid(2), uid(102)), uid(852), token(2));
    const before = [...model.rows].map(([key, row]) => [key, { ...row }]);
    assert.throws(() => model.upsert(session(uid(2), uid(102)), useExistingInstallation ? uid(852) : uid(853), token(1)), { code: "23505" });
    assert.deepEqual([...model.rows], before);
  }
});

safeguard("legacy inactive record status independently rejects otherwise active Patient upsert", async () => {
  const account = { ...activeAccount(), recordStatus: "inactive" };
  assert.equal(account.role, "patient");
  assert.equal(account.profileStatus, "active");
  assert.equal(account.patientStatus, "active");
  assert.equal(account.archived, false);
  assert.ok(account.patient);
  const model = registrationModel(new Map([[uid(1), account]]));
  assert.throws(() => model.upsert(session(), uid(851), token(1)), { code: "42501" });
  assert.equal(model.rows.size, 0);
});

safeguard("RPC model itself rejects invalid roles and account states", async () => {
  for (const update of [
    { role: "doctor" }, { role: "staff" }, { role: "admin" }, { role: undefined },
    { profileStatus: "inactive" }, { patientStatus: "inactive" },
    { patientStatus: "pending_activation" }, { patientStatus: "deleted" },
    { patientStatus: "deactivated" }, { patientStatus: "suspended" },
    { patientStatus: "disabled" }, { patientStatus: "blocked" },
    { archived: true }, { recordStatus: "archived" }, { recordStatus: "deleted" },
    { patient: null },
  ]) {
    const accountMap = new Map([[uid(1), { ...activeAccount(), ...update }]]);
    const model = registrationModel(accountMap);
    assert.throws(() => model.upsert(session(), uid(851), token(1)), { code: "42501" });
    assert.equal(model.rows.size, 0);
  }
  assert.throws(() => registrationModel().upsert(null, uid(851), token(1)), { code: "42501" });
});

safeguard("granted permission and explicit disable are separate states", async () => {
  const h = await nativeHarness({ autoToken: token(1) });
  await h.api.registerPatientNativePushDevice();
  await h.api.disablePatientNativePushDevice();
  assert.equal(await h.api.checkPatientNativePushPermission(), "granted");
  assert.equal(h.api.isPatientNativePushExplicitlyDisabled(), true);
});

safeguard("OS denial prevents registration without setting explicit disable", async () => {
  const h = await nativeHarness();
  h.setPermission("denied");
  const result = await h.api.reconcilePatientNativePushRegistration();
  assert.equal(result.permission, "denied");
  assert.equal(result.registered, false);
  assert.equal(h.registerCalls, 0);
  assert.equal(h.api.isPatientNativePushExplicitlyDisabled(), false);
});

defect("Settings refreshes permission after background revoke and visible resume", "mounted Settings hook has no visible/resume refresh", async () => {
  const h = await nativeHarness({ autoToken: token(1) });
  await h.api.registerPatientNativePushDevice();
  const settings = await settingsHarness(h);
  assert.equal(settings.state.permission, "granted");
  await h.visible(false);
  h.setPermission("denied");
  await h.visible(true);
  // Model the Patient shell's existing visible reconciliation as well.
  const reconciled = await h.api.reconcilePatientNativePushRegistration();
  assert.equal(reconciled.permission, "denied");
  await settings.settle();
  settings.unmount();
  check(settings.state.permission === "denied", "Settings refreshes permission after background revoke and visible resume");
});

safeguard("manual Settings refresh observes permission denial distinctly from explicit disable", async () => {
  const h = await nativeHarness({ autoToken: token(1) });
  await h.api.registerPatientNativePushDevice();
  const settings = await settingsHarness(h);
  h.setPermission("denied");
  await settings.state.refreshPushStatus();
  await settings.settle();
  assert.equal(settings.state.permission, "denied");
  assert.equal(settings.state.status, "permission_denied");
  assert.equal(h.api.isPatientNativePushExplicitlyDisabled(), false);
  settings.unmount();
});

safeguard("failed server deactivation is immediately shown as error with a usable Disable button", async () => {
  const h = await nativeHarness({ autoToken: token(1) });
  await h.api.registerPatientNativePushDevice();
  const settings = await settingsHarness(h);
  h.failDeactivation();
  assert.equal(await settings.state.disablePushNotifications(), false);
  await settings.settle();
  assert.equal(settings.state.status, "error");
  assert.equal(settings.errorVisible(), true);
  assert.equal(settings.disableButton()?.props.disabled, false);
  assert.equal([...h.model.rows.values()][0].enabled, true);
  settings.unmount();
});

defect("failed deactivation stays visible and retryable after status refresh", "refresh hides unsynchronized disable error and removes retry button", async () => {
  const h = await nativeHarness({ autoToken: token(1) });
  await h.api.registerPatientNativePushDevice();
  const settings = await settingsHarness(h);
  h.failDeactivation();
  await settings.state.disablePushNotifications();
  await settings.settle();
  assert.equal(settings.errorVisible(), true);
  assert.ok(settings.disableButton());
  await settings.state.refreshPushStatus();
  await settings.settle();
  assert.equal([...h.model.rows.values()][0].enabled, true);
  const retryable = settings.state.status === "error" && settings.errorVisible() && settings.disableButton()?.props.disabled === false;
  settings.unmount();
  check(retryable, "failed deactivation stays visible and retryable after status refresh");
});

safeguard("retrying Disable after server recovery deactivates the row", async () => {
  const h = await nativeHarness({ autoToken: token(1) });
  await h.api.registerPatientNativePushDevice();
  const settings = await settingsHarness(h);
  h.failDeactivation();
  await settings.state.disablePushNotifications();
  await settings.settle();
  h.failDeactivation(false);
  assert.equal(await settings.state.disablePushNotifications(), true);
  await settings.settle();
  assert.equal([...h.model.rows.values()][0].enabled, false);
  assert.equal(settings.state.status, "unsubscribed");
  settings.unmount();
});

safeguard("restart retains installation UUID through the actual storage helper", async () => {
  const storage = new Map();
  const first = await nativeHarness({ storage });
  const identity = first.api.getOrCreatePatientNativePushInstallationId();
  const restarted = await nativeHarness({ storage });
  assert.equal(restarted.api.getOrCreatePatientNativePushInstallationId(), identity);
});

safeguard("logout/login retains installation UUID", async () => {
  const h = await nativeHarness();
  const identity = h.api.getOrCreatePatientNativePushInstallationId();
  await h.api.cleanupPatientNativePushBeforeLogout();
  await h.authChange(null, "SIGNED_OUT");
  await h.authChange(session());
  h.api.beginPatientNativePushSession();
  assert.equal(h.api.getOrCreatePatientNativePushInstallationId(), identity);
});

safeguard("cleared storage creates a different installation UUID", async () => {
  const h = await nativeHarness();
  const identity = h.api.getOrCreatePatientNativePushInstallationId();
  h.storage.clear();
  assert.notEqual(h.api.getOrCreatePatientNativePushInstallationId(), identity);
});

safeguard("fresh installation creates a separate row without changing another Patient's row", async () => {
  const model = registrationModel();
  const other = { ...model.upsert(session(uid(2), uid(102)), uid(802), token(2)) };
  const h = await nativeHarness({ model, autoToken: token(1) });
  await h.api.registerPatientNativePushDevice();
  assert.equal(model.rows.size, 2);
  assert.deepEqual(model.rows.get(uid(802)), other);
});

safeguard("restored UUID under another Patient must not silently overwrite registration", async () => {
  const model = registrationModel();
  model.upsert(session(), uid(801), token(1));
  const before = { ...model.rows.get(uid(801)) };
  const h = await nativeHarness({ model, storage: new Map([[installationKey, uid(801)]]),
    initialSession: session(uid(2), uid(102)), autoToken: token(2) });
  const op = observe(h.api.registerPatientNativePushDevice());
  await complete(op);
  check(model.rows.get(uid(801)).user_id === uid(1) && h.writes.length === 0,
    "restored UUID under another Patient must not silently overwrite registration");
  assert.equal(op.error?.code, "persistence_failed");
  assert.deepEqual(model.rows.get(uid(801)), before);
});

safeguard("restored UUID with conflicting token is rejected rather than duplicating token", async () => {
  const model = registrationModel();
  model.upsert(session(), uid(801), token(1));
  model.upsert(session(uid(2), uid(102)), uid(802), token(2));
  const h = await nativeHarness({ model, storage: new Map([[installationKey, uid(801)]]), autoToken: token(2) });
  const op = observe(h.api.registerPatientNativePushDevice());
  await complete(op);
  assert.equal(op.error?.code, "persistence_failed");
  assert.equal(model.rows.size, 2);
  assert.equal(model.rows.get(uid(802)).push_token, token(2));
});

async function firebaseTests() {
  const time = clock();
  const context = vm.createContext({ console: silentConsole, AbortController,
    Request, Response, fetch: forbidNetwork,
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout });
  const helper = await load(firebasePath, context);
  const cases = await load(firebaseTestPath, context, {
    "node:assert/strict": { default: assert }, "./firebaseMessaging.ts": helper,
  });
  for (const entry of cases.firebaseLifecycleTests) tests.push(entry);
}

// A different assertion or thrown mock/runtime error is NEVER an expected failure.
function classify(test, error) {
  if (!error) return test.expectedFailure ? "unexpected-pass" : "pass";
  return test.expectedFailure && error.code === "ERR_ASSERTION" &&
    error.message === "contract: " + test.name ? "expected-fail" : "unexpected-failure";
}

function verifyClassifier() {
  const example = { name: "classifier fixture", expectedFailure: "known" };
  assert.equal(classify(example), "unexpected-pass");
  assert.equal(classify(example, new Error("runtime failure")), "unexpected-failure");
  assert.equal(classify(example, new assert.AssertionError({ message: "different assertion" })), "unexpected-failure");
  assert.equal(classify(example, new assert.AssertionError({ message: "contract: classifier fixture" })), "expected-fail");
}

async function main() {
  verifyClassifier();
  validateSqlModel();
  await firebaseTests();
  let passed = 0;
  let reproduced = 0;
  let unexpected = 0;
  console.log("Phase 7A: isolated actual-source tests; SQL authorization is a source-bound model only.");
  console.log("No production credentials, database connections, device operations, or unmocked network calls.");
  for (const test of tests) {
    let error;
    try { await test.run(); } catch (caught) { error = caught; }
    const outcome = classify(test, error);
    if (outcome === "pass") { passed++; console.log("PASS: " + test.name); }
    else if (outcome === "expected-fail") {
      reproduced++;
      console.log("EXPECTED FAIL: " + test.name + " — " + test.expectedFailure);
    } else {
      unexpected++;
      // Do not dump assertion operands, stacks, fixture values, or provider responses.
      console.error((outcome === "unexpected-pass" ? "UNEXPECTED PASS: " : "UNEXPECTED FAILURE: ") + test.name);
    }
  }
  console.log("Summary: safeguards passed=" + passed + "; known defects reproduced=" + reproduced +
    "; unexpected failures=" + unexpected);
  process.exitCode = unexpected ? 1 : 0;
}

try { await main(); } catch {
  console.error("UNEXPECTED FAILURE: harness setup or source-model assumptions require review");
  process.exitCode = 1;
}
