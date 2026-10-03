/* global process */
// Synthetic auth/DOM/storage only. Run: node scripts/verify-role-inactivity.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { createHash, webcrypto } from "node:crypto";
import * as vm from "node:vm";
import { transformWithOxc } from "vite";
import {
  createRoleInactivityManager, getInactivityScope, getLogicalSessionIdentity,
  INACTIVITY_TIMEOUT_MS, INACTIVITY_WARNING_MS, INACTIVITY_STORAGE_PREFIX,
  isClinicPath, signOutExpiredClinicSession,
} from "../src/lib/roleInactivity.js";

if (!vm.SourceTextModule) {
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", ...process.argv.slice(1)], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
const root = new URL("../", import.meta.url);
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; };
const source = (path) => readFile(new URL(path, root), "utf8");
const protectedForms = ["src/pages/appointments/AppointmentVisitForm.jsx", "src/pages/appointments/StaffPreConsultationForm.jsx"];
const initialFormHashes = new Map(await Promise.all(protectedForms.map(async path => [path, createHash("sha256").update(await readFile(new URL(path, root))).digest("hex")])));
const session = (user = "synthetic-clinic", id = "synthetic-session", extra = {}) => ({
  user: { id: user }, access_token: "x." + Buffer.from(JSON.stringify({ session_id: id, ...extra })).toString("base64url") + ".x",
});
const memoryStorage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), values };
};
function clockHarness(storage = memoryStorage()) {
  let time = 1000000;
  let next = 0;
  const timers = new Map();
  const views = [];
  let expires = 0;
  let remoteLogouts = 0;
  const setTimer = (fn, delay) => { const id = ++next; timers.set(id, { fn, at: time + delay }); return id; };
  const clearTimer = id => timers.delete(id);
  const manager = createRoleInactivityManager({ storage, now: () => time, setTimer, clearTimer,
    onChange: view => views.push(view), onExpire: () => expires++, onRemoteLogout: () => remoteLogouts++ });
  return { manager, storage, timers, views, get time() { return time; }, get expires() { return expires; }, get remoteLogouts() { return remoteLogouts; },
    set time(value) { time = value; },
    advance(delta) {
      const target = time + delta;
      while (true) {
        const due = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!due || due[1].at > target) break;
        timers.delete(due[0]); time = due[1].at; due[1].fn();
      }
      time = target;
    }, activate(role = "doctor", scope = "synthetic-scope", authorized = true) {
      return manager.activate({ role, scope, authorized, userId: "synthetic-clinic" });
    } };
}
check(INACTIVITY_TIMEOUT_MS === 900000 && INACTIVITY_WARNING_MS === 840000, "production uses 15/14 minutes without a debug override");
for (const role of ["admin", "doctor", "staff"]) {
  const h = clockHarness(); check(h.activate(role), role + " activates after verified authorization");
  h.advance(839999); check(h.manager.snapshot().phase === "active", "no premature warning");
  h.advance(1); check(h.manager.snapshot().phase === "warning" && h.views.at(-1).secondsRemaining === 60, "warning exactly at minute 14");
  const before = h.manager.snapshot().lastActivity;
  check(!h.manager.activity() && h.manager.snapshot().lastActivity === before, "ordinary interaction cannot dismiss an open warning");
  h.advance(59999); check(h.expires === 0, "session remains valid before minute 15");
  h.advance(1); check(h.expires === 1 && h.manager.snapshot().phase === "expired", "expiry exactly at minute 15");
  check(!h.manager.stayLoggedIn() && h.expires === 1 && h.timers.size === 0, "late click cannot revive expired session");
}
for (const role of ["patient", "", "unknown"]) {
  const h = clockHarness(); check(!h.activate(role) && h.timers.size === 0, role + " never starts a clinic timer");
}
check(!clockHarness().activate("doctor", "scope", false), "unauthorized identity does not activate");
check(!createRoleInactivityManager().activate({ role: "doctor", authorized: true, scope: "scope" }), "missing user does not activate");
for (const path of ["/patient", "/patient/dashboard", "/login", "/forgot-password", "/administrator"]) check(!isClinicPath(path), "unauthenticated/Patient route excluded: " + path);
for (const path of ["/admin", "/doctor/appointments", "/staff/patients"]) check(isClinicPath(path), "clinic route included: " + path);
const stay = clockHarness(); stay.activate(); stay.advance(840000);
check(stay.manager.stayLoggedIn() && stay.manager.snapshot().phase === "active", "explicit Stay Logged In closes warning");
stay.advance(899999); check(!stay.expires, "renewed session receives fresh 15 minutes"); stay.advance(1); check(stay.expires === 1, "renewed session eventually expires");
const activity = clockHarness(); activity.activate(); activity.advance(400000); activity.manager.activity();
check(activity.manager.snapshot().lastActivity === activity.time, "genuine prewarning interaction renews");
const originalActivity = activity.manager.snapshot().lastActivity;
for (const event of ["TOKEN_REFRESHED", "Realtime", "network", "visibilitychange", "focus", "pageshow"]) {
  activity.advance(1000); activity.manager.check();
  check(activity.manager.snapshot().lastActivity === originalActivity, event + " time checks do not renew activity");
}
const sleep = clockHarness(); sleep.activate(); sleep.time += 900001; sleep.manager.check();
check(sleep.expires === 1, "sleep/wake checks absolute elapsed time");
const shared = memoryStorage(); const tabA = clockHarness(shared); const tabB = clockHarness(shared);
tabA.activate(); tabB.activate(); tabA.advance(400000); tabB.time = tabA.time; tabA.manager.activity();
tabB.manager.storageChanged({ key: INACTIVITY_STORAGE_PREFIX + "synthetic-scope", newValue: shared.getItem(INACTIVITY_STORAGE_PREFIX + "synthetic-scope") });
check(tabB.manager.snapshot().lastActivity === tabA.time, "same-origin genuine activity synchronizes deadline");
tabA.advance(840000); tabB.time = tabA.time; tabB.manager.check();
check(tabB.manager.snapshot().phase === "warning", "both tabs warn against the shared deadline");
tabA.manager.stop({ clear: true }); tabB.manager.storageChanged({ key: INACTIVITY_STORAGE_PREFIX + "synthetic-scope", newValue: null });
check(tabB.remoteLogouts === 1 && tabB.timers.size === 0 && tabB.manager.snapshot().phase === "disabled", "cross-tab manual logout cancels warning and timers");
const old = clockHarness(); old.activate(); old.advance(900000); old.activate("doctor", "new-session");
check(old.manager.snapshot().phase === "active" && old.manager.snapshot().lastActivity === old.time, "replacement session cannot inherit expired deadline");
const unavailableStorage = { getItem() { throw Error("Synthetic unavailable storage"); }, setItem() { throw Error("Synthetic unavailable storage"); }, removeItem() { throw Error("Synthetic unavailable storage"); } };
const unavailable = clockHarness(unavailableStorage); unavailable.activate(); unavailable.advance(800000);
unavailable.manager.stop(); unavailable.activate(); unavailable.advance(40000);
check(unavailable.manager.snapshot().phase === "warning", "guard refresh/remount cannot reset activity when persistent storage is unavailable");
const oldIdentity = getLogicalSessionIdentity(session());
check(oldIdentity === getLogicalSessionIdentity(session(undefined, undefined, { iat: 200 })), "token refresh retains logical identity");
check(oldIdentity !== getLogicalSessionIdentity(session(undefined, "replacement")), "replacement session ID changes identity");
const scope = await getInactivityScope(oldIdentity);
check(scope.length === 64 && !scope.includes("synthetic"), "persisted namespace is a SHA-256 digest, never an auth token/session ID");
check(scope !== await getInactivityScope(getLogicalSessionIdentity(session("other-clinic"))), "account change has an independent namespace");

// Execute actual hook/provider JSX in a deterministic React-like effect harness.
function events() {
  const listeners = new Map();
  return { addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    emit(name, event = {}) { for (const fn of [...(listeners.get(name) || [])]) fn(event); }, listeners };
}
function hookRuntime() {
  const slots = [];
  let index = 0; let dirty = true; let component; let props; let result;
  const effects = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const runtime = {
    useRef(value) { const i = index++; return slots[i] ||= { current: value }; },
    useState(value) { const i = index++; if (!slots[i]) slots[i] = { value: typeof value === "function" ? value() : value }; return [slots[i].value, next => { const v = typeof next === "function" ? next(slots[i].value) : next; if (!Object.is(v, slots[i].value)) { slots[i].value = v; dirty = true; } }]; },
    useCallback(fn, deps) { const i = index++; if (!same(slots[i]?.deps, deps)) slots[i] = { value: fn, deps }; return slots[i].value; },
    useMemo(fn, deps) { const i = index++; if (!same(slots[i]?.deps, deps)) slots[i] = { value: fn(), deps }; return slots[i].value; },
    useEffect(fn, deps) { const i = index++; if (!same(slots[i]?.deps, deps)) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
    useContext(context) { index++; return context.value; }, createContext: value => ({ value, Provider: "ContextProvider" }),
  };
  runtime.useLayoutEffect = runtime.useEffect;
  return { runtime, slots, get result() { return result; },
    mount(fn, initial = {}) { component = fn; props = initial; dirty = true; this.flush(); },
    flush() { let count = 0; while (dirty) { if (++count > 30) throw Error("render loop"); dirty = false; index = 0; result = component(props); for (const fn of effects.splice(0)) fn(); } },
    update(next) { props = next; dirty = true; this.flush(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}
const element = (type, props) => ({ type, props: props || {} });
const jsx = { jsx: element, jsxs: element, Fragment: "Fragment" };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = async (h) => { for (let i = 0; i < 20; i++) await Promise.resolve(); h?.flush(); };
async function loadModule(path, mocks, context, cache = new Map()) {
  if (cache.has(path)) return cache.get(path);
  let code = await source(path);
  if (path.endsWith(".jsx")) code = (await transformWithOxc(code, path, { jsx: { runtime: "automatic" } })).code;
  code = code.replace(/import.meta.env/g, '({ DEV: false, VITE_SUPABASE_URL: "https://synthetic.supabase.co" })');
  const module = new vm.SourceTextModule(code, { context, identifier: path }); cache.set(path, module);
  await module.link(async specifier => {
    if (specifier.endsWith(".css")) return new vm.SyntheticModule([], () => {}, { context });
    if (specifier in mocks) {
      const exports = mocks[specifier]; return new vm.SyntheticModule(Object.keys(exports), function() { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context });
    }
    let child = new URL(specifier, new URL(path, root));
    if (!/\.jsx?$/.test(child.pathname)) {
      try { await access(new URL(child.href + ".js")); child = new URL(child.href + ".js"); }
      catch { child = new URL(child.href + ".jsx"); }
    }
    return loadModule(child.href.slice(root.href.length), mocks, context, cache);
  });
  await module.evaluate(); return module;
}
function authHarness() {
  let current = session(); const subscribers = new Set(); let writes = 0;
  const profileGate = deferred(); let profileWait = false;
  const client = { auth: {
    getUser: async () => ({ data: { user: current?.user || null }, error: null }),
    getSession: async () => ({ data: { session: current }, error: null }),
    onAuthStateChange(fn) { subscribers.add(fn); return { data: { subscription: { unsubscribe: () => subscribers.delete(fn) } } }; },
    signOut: async () => { client.emit("SIGNED_OUT", null); return { error: null }; },
  }, realtime: { setAuth: async () => {} },
  from() { const query = { select() { return query; }, eq() { return query; },
    async maybeSingle() { if (profileWait) return profileGate.promise; if (client.profileResult !== undefined) return client.profileResult; return { data: { id: current?.user.id, role: client.role, account_status: "active", full_name: "Synthetic" }, error: null }; } }; return query; },
  emit(event, next) { current = next; for (const fn of [...subscribers]) fn(event, current); },
  role: "staff", gate: profileGate, wait() { profileWait = true; }, get writes() { return writes; }, track() { writes++; }, get session() { return current; } };
  return client;
}
const makeEnvironment = () => {
  const h = clockHarness(); const window = { ...events(), localStorage: memoryStorage(), sessionStorage: memoryStorage(), setTimeout: (fn, ms) => { const key = Symbol(); h.timers.set(key, { fn, at: h.time + ms }); return key; }, clearTimeout: key => h.timers.delete(key), dispatchEvent() {} };
  const document = { ...events(), body: { style: { overflow: "" } }, activeElement: null };
  const digests = [];
  const testCrypto = { subtle: { digest(...args) { const pending = webcrypto.subtle.digest(...args); digests.push(pending); return pending; } } };
  const context = vm.createContext({ window, document, console, Date: class extends Date { static now() { return h.time; } },
    setTimeout: window.setTimeout, clearTimeout: window.clearTimeout, atob, crypto: testCrypto, TextEncoder, Uint8Array, URL });
  return { h, window, document, context, digests };
};
for (const role of ["admin", "staff"]) {
  const hook = hookRuntime(); const env = makeEnvironment(); const client = authHarness(); client.role = role;
  let cacheClears = 0; let settingsWrites = 0;
  const mocks = {
    react: hook.runtime, "../lib/supabaseClient": { supabase: client },
    "../lib/adminWorkspaceSnapshots": { clearAdminWorkspaceSnapshots: () => cacheClears++ },
    "../lib/staffSessionCache": { clearStaffSessionCache: () => cacheClears++ },
    "../lib/staffProfile": { clearStaffSettingsMemoryCache: () => cacheClears++, hydrateStaffSettingsFromIdentity: () => settingsWrites++ },
  };
  const module = await loadModule("src/hooks/useAuthenticated" + (role === "admin" ? "Admin" : "Staff") + ".js", mocks, env.context);
  const useHook = module.namespace[role === "admin" ? "useAuthenticatedAdmin" : "useAuthenticatedStaff"];
  hook.mount(useHook); env.h.advance(0); await settle(hook);
  check(hook.result[role === "admin" ? "isAdmin" : "isStaff"], role + " active authorization succeeds");
  client.wait(); const refresh = hook.result.refresh(); await settle(hook);
  client.emit("SIGNED_OUT", null); hook.flush();
  client.gate.resolve({ data: { id: "synthetic-clinic", role, account_status: "active" }, error: null });
  check(await refresh === null, role + " pending authorization result is fenced"); await settle(hook);
  check(!hook.result.identity && !hook.result[role === "admin" ? "isAdmin" : "isStaff"], role + " late result cannot restore protected identity");
  check(cacheClears > 0, role + " sign-out clears workspace caches");
  if (role === "staff") check(settingsWrites === 1 && hook.result.error.code === "staff_not_authenticated", "Staff stale work cannot republish module/profile cache and signed-out guard redirects");
  hook.unmount();
}

for (const role of ["admin", "staff"]) {
  for (const blocked of ["missing", "wrong-role", "inactive", "no-session", "profile-error"]) {
    const hooks = hookRuntime(); const env = makeEnvironment(); const client = authHarness(); client.role = role;
    if (blocked === "no-session") client.emit("SIGNED_OUT", null);
    else client.profileResult = { data: blocked === "missing" ? null : { id: "synthetic-clinic", role: blocked === "wrong-role" ? "patient" : role, account_status: blocked === "inactive" ? "inactive" : "active" }, error: blocked === "profile-error" ? { code: "synthetic", message: "Synthetic" } : null };
    const module = await loadModule("src/hooks/useAuthenticated" + (role === "admin" ? "Admin" : "Staff") + ".js", {
      react: hooks.runtime, "../lib/supabaseClient": { supabase: client },
      "../lib/adminWorkspaceSnapshots": { clearAdminWorkspaceSnapshots() {} },
      "../lib/staffSessionCache": { clearStaffSessionCache() {} },
      "../lib/staffProfile": { clearStaffSettingsMemoryCache() {}, hydrateStaffSettingsFromIdentity() {} },
    }, env.context);
    hooks.mount(module.namespace[role === "admin" ? "useAuthenticatedAdmin" : "useAuthenticatedStaff"]);
    env.h.advance(0); await settle(hooks);
    check(!hooks.result.identity && !hooks.result[role === "admin" ? "isAdmin" : "isStaff"], role + " existing authorization blocks " + blocked);
    if (role === "staff" && blocked === "inactive") check(hooks.result.error?.code === "staff_account_inactive", "Staff deactivation keeps its established account-state reason despite sign-out fencing");
    hooks.unmount();
  }
}

const env = makeEnvironment();
const cleanup = await loadModule("src/lib/clinicSessionCleanup.js", {}, env.context);
const profile = await loadModule("src/lib/staffProfile.js", {}, env.context);
env.window.localStorage.setItem("staff_dashboard_settings", JSON.stringify({ displayName: "Synthetic", email: "synthetic@example.test", address: "Synthetic", twoFactorAuth: true, loginNotifications: false, ordinaryPreference: "keep" }));
for (const key of ["maternal_patient_session", "maternal_native_push_installation_id", "maternal_native_push_explicitly_disabled", "doctor_health_tips"]) env.window.localStorage.setItem(key, "keep");
for (const key of ["maternal_staff_patient_registration", "maternal_staff_walkin_registration_slot", "maternal-sw-refresh-ready"]) env.window.sessionStorage.setItem(key, "keep");
cleanup.namespace.clearClinicSessionCaches();
const remainingSettings = JSON.parse(env.window.localStorage.getItem("staff_dashboard_settings"));
check(!remainingSettings.displayName && !remainingSettings.email && !remainingSettings.address && remainingSettings.twoFactorAuth && remainingSettings.loginNotifications === false && remainingSettings.ordinaryPreference === "keep", "Staff profile fields cleared while preference flags preserved");
for (const key of ["maternal_patient_session", "maternal_native_push_installation_id", "maternal_native_push_explicitly_disabled", "doctor_health_tips"]) check(env.window.localStorage.getItem(key) === "keep", "unrelated/Patient key retained: " + key);
for (const key of ["maternal_staff_patient_registration", "maternal_staff_walkin_registration_slot"]) check(env.window.sessionStorage.getItem(key) === null, "sensitive Staff session reference removed: " + key);
check(env.window.sessionStorage.getItem("maternal-sw-refresh-ready") === "keep", "service-worker flags retained");
profile.namespace.clearSensitiveStaffSettings();

for (const fail of [false, true]) {
  const store = memoryStorage(); store.setItem("sb-synthetic-auth-token", JSON.stringify(session())); store.setItem("unrelated", "keep");
  const calls = []; let local = session(); let cleaned = false;
  const auth = { async signOut(options) { calls.push(options); if (fail && !options) return { error: true }; local = null; return { error: null }; }, getSession: async () => ({ data: { session: local }, error: null }) };
  const done = await signOutExpiredClinicSession({ auth, storage: store, authStorageKey: "sb-synthetic-auth-token", identity: oldIdentity, isCurrent: () => true, cleanup: () => { cleaned = true; } });
  check(done && cleaned && calls[0] === undefined, "real default/global SDK sign-out is attempted before cleanup");
  check(store.getItem("unrelated") === "keep", "logout never blanket-clears storage");
  if (fail) check(calls[1].scope === "local" && store.getItem("sb-synthetic-auth-token") === null, "global failure uses targeted persistence removal plus public local SDK sign-out");
}
const replacementStore = memoryStorage(); replacementStore.setItem("auth", JSON.stringify(session("replacement-user")));
check(!await signOutExpiredClinicSession({ auth: { signOut: async () => ({ error: true }) }, storage: replacementStore, authStorageKey: "auth", identity: oldIdentity, isCurrent: () => true, cleanup() {} }), "fallback cannot delete replacement session");
check(replacementStore.getItem("auth") !== null, "replacement auth persistence retained");
check(!await signOutExpiredClinicSession({ auth: { signOut: async () => ({ error: true }) }, storage: memoryStorage(), authStorageKey: "auth", identity: oldIdentity, isCurrent: () => true, cleanup() {} }), "SDK sign-out failure never reports usable local logout as complete");

// Provider integration: execute real event callbacks and rendering before network settles.
async function providerHarness() {
  const env = makeEnvironment(); const hooks = hookRuntime(); const client = authHarness();
  let path = "/doctor/dashboard"; const navigations = []; let cleanups = 0;
  const mocks = {
    react: hooks.runtime, "react/jsx-runtime": jsx,
    "react-router-dom": { useLocation: () => ({ pathname: path }), useNavigate: () => navigate },
    "../../lib/supabaseClient": { supabase: client },
    "../../lib/clinicSessionCleanup": { clearClinicSessionCaches: () => cleanups++ },
    "./InactivityWarningDialog": { default: "WarningDialog" },
  };
  const navigate = (to, options) => { navigations.push({ to, options }); path = to.split("?")[0]; hooks.update({ children: "protected-child" }); };
  const module = await loadModule("src/components/auth/RoleInactivityProvider.jsx", mocks, env.context);
  hooks.mount(module.namespace.default, { children: "protected-child" }); await settle(hooks);
  // Crypto runs outside the VM microtask queue.
  await Promise.all(env.digests); await settle(hooks);
  const register = hooks.result.props.value;
  register({ userId: "synthetic-clinic", role: "doctor", revalidate: async () => ({ user: client.session?.user, role: "doctor", authorized: Boolean(client.session) }) }); hooks.flush();
  return { env, hooks, client, navigations, register, get cleanups() { return cleanups; }, navigate };
}
const provider = await providerHarness();
let finishLogout; const pendingLogout = new Promise(resolve => { finishLogout = resolve; });
provider.client.auth.signOut = () => {
  check(providerRoot.props.ref.current.hidden && providerRoot.props.ref.current.inert, "protected DOM is blocked synchronously before SDK sign-out begins");
  return pendingLogout;
};
const providerRoot = provider.hooks.result.props.children[0]; providerRoot.props.ref.current = { hidden: false, inert: false };
provider.env.h.advance(840000); provider.hooks.flush();
check(provider.hooks.result.props.children[2]?.props.secondsRemaining === 60, "actual provider renders 60-second warning");
check(provider.hooks.result.props.children[0].props.inert, "warning makes background workspace inert without discarding unsaved form state");
provider.env.document.emit("scroll", { isTrusted: true }); provider.hooks.flush();
check(provider.hooks.result.props.children[2]?.type === "WarningDialog", "warning scroll cannot silently renew");
provider.env.h.advance(60000); provider.hooks.flush();
check(provider.hooks.result.props.children[0].props.children.type === "main", "expired provider unmounts protected children before sign-out resolves");
check(providerRoot.props.ref.current.hidden === false, "blocked placeholder becomes visible after render, never old protected content");
check(provider.navigations.length === 0, "pending real sign-out does not merely navigate away");
provider.client.emit("SIGNED_OUT", null); finishLogout({ error: null }); await settle(provider.hooks);
check(provider.navigations.at(-1)?.to === "/login?reason=inactivity" && provider.navigations.at(-1).options.replace, "confirmed SDK sign-out redirects with replace to friendly inactivity state");
provider.hooks.unmount();
const back = await providerHarness();
const restoreGate = deferred(); back.register({ userId: "synthetic-clinic", role: "doctor", revalidate: () => restoreGate.promise });
back.env.window.emit("pagehide", { persisted: true }); back.env.window.emit("pageshow", { persisted: true }); back.hooks.flush();
check(back.hooks.result.props.children[0].props.hidden, "BFCache restoration blocks cached workspace pending authoritative guard check");
restoreGate.resolve({ user: back.client.session.user, role: "doctor", authorized: true }); await settle(back.hooks);
check(!back.hooks.result.props.children[0].props.hidden, "successful reauthorization restores valid workspace");
back.client.emit("TOKEN_REFRESHED", session(undefined, undefined, { iat: 42 })); await settle(back.hooks);
back.env.h.time += 900001; back.env.window.emit("pageshow", { persisted: true }); await settle(back.hooks);
check(back.hooks.result.props.children[0].props.children !== "protected-child" || back.navigations.at(-1)?.to === "/login?reason=inactivity", "sleep/token refresh/Browser Back cannot grant a fresh deadline");
back.hooks.unmount();


const failingProvider = await providerHarness();
failingProvider.client.auth.signOut = async () => ({ error: true });
failingProvider.env.h.advance(900000); await settle(failingProvider.hooks);
const failureContent = failingProvider.hooks.result.props.children[0].props.children;
check(failureContent.type === "main" && JSON.stringify(failureContent).includes("Retry sign out"), "actual provider retains blocked retry state if SDK fallback also fails");
check(failingProvider.navigations.length === 0, "incomplete local logout cannot redirect into an auto-restored login session");
failingProvider.hooks.unmount();

// Verify the fallback against the installed SDK, with a synthetic HTTP adapter.
const sdkStore = memoryStorage();
const sdkSession = { ...session(), refresh_token: "synthetic-refresh", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600 };
sdkStore.setItem("sb-synthetic-auth-token", JSON.stringify(sdkSession));
let sdkRequests = 0;
const sdk = createClient("https://synthetic.supabase.test", "synthetic-anon", {
  auth: { storage: sdkStore, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: async () => { sdkRequests++; return new Response(JSON.stringify({ message: "Synthetic offline failure" }), { status: 503, headers: { "Content-Type": "application/json" } }); } },
});
let sdkSignedOut = false;
const sdkSubscription = sdk.auth.onAuthStateChange(event => { if (event === "SIGNED_OUT") sdkSignedOut = true; });
const sdkDone = await signOutExpiredClinicSession({ auth: sdk.auth, storage: sdkStore, authStorageKey: "sb-synthetic-auth-token", identity: oldIdentity, isCurrent: () => true, cleanup() {} });
check(sdkDone && sdkSignedOut && !(await sdk.auth.getSession()).data.session, "installed Supabase SDK confirms null session and broadcasts SIGNED_OUT after fallback");
check(sdkRequests === 1, "fallback uses public SDK signOut without a second network request after targeted removal");
sdkSubscription.data.subscription.unsubscribe();

// Actual provider filters synthetic/background events and fences a replacement login.
const interactions = await providerHarness();
const activityValue = () => [...interactions.env.window.localStorage.values.values()][0];
const beforeInteraction = activityValue();
interactions.env.h.time += 1000;
interactions.env.document.emit("pointerdown", { isTrusted: false });
check(activityValue() === beforeInteraction, "programmatic pointer events are not user activity");
interactions.env.document.emit("pointerdown", { isTrusted: true });
const afterInteraction = activityValue();
check(afterInteraction !== beforeInteraction, "actual trusted pointer interaction updates persisted activity");
interactions.client.emit("TOKEN_REFRESHED", session(undefined, undefined, { iat: 1234 }));
for (const name of ["focus", "pageshow"]) interactions.env.window.emit(name, { persisted: false });
interactions.env.document.emit("visibilitychange");
check(activityValue() === afterInteraction, "actual SDK refresh/focus/visibility/pageshow never renew activity");
interactions.env.h.time += 900000; interactions.env.window.emit("focus"); await settle(interactions.hooks);
interactions.client.emit("SIGNED_IN", session("replacement-clinic", "replacement-session")); await Promise.all(interactions.env.digests); await settle(interactions.hooks);
interactions.navigate("/doctor/dashboard", { replace: true });
const unregister = interactions.register({ userId: "replacement-clinic", role: "doctor", revalidate: async () => ({ user: interactions.client.session.user, role: "doctor", authorized: true }) });
interactions.hooks.flush();
check(interactions.hooks.result.props.children[0].props.children === "protected-child", "new verified session may render after prior expiry without inheriting it");
interactions.env.h.advance(840000); interactions.hooks.flush();
check(interactions.hooks.result.props.children[2]?.props.secondsRemaining === 60, "replacement login has a fresh 14-minute warning deadline");
unregister(); interactions.hooks.flush();
check(!interactions.hooks.result.props.children[2], "authorization disappearance cancels warning");
interactions.hooks.unmount();

const cacheEnv = makeEnvironment();
const cacheModule = await loadModule("src/lib/doctorSessionCache.js", {}, cacheEnv.context);
const stores = Array.from({ length: 4 }, () => cacheModule.namespace.createDoctorSessionCache());
for (const store of stores) store.set("synthetic-clinic", { sensitive: "synthetic" });
cacheModule.namespace.clearDoctorSessionCaches();
check(stores.every(store => store.size === 0), "one Doctor cleanup clears every registered page cache");
for (const page of ["Doctor_Dashboard", "Doctor_Patients", "Doctor_Appointments", "Doctor_Reminder"]) {
  const current = await source("src/pages/doctor/" + page + ".jsx");
  const baseline = spawnSync("git", ["show", "HEAD:src/pages/doctor/" + page + ".jsx"], { encoding: "utf8", windowsHide: true });
  const withoutCacheIntegration = current.replace('import { createDoctorSessionCache } from "../../lib/doctorSessionCache";\n', "").replace(/(const doctor\w+Snapshots = )createDoctorSessionCache\(\);/, "$1new Map();");
  check(withoutCacheIntegration.replace(/\r/g, "") === baseline.stdout.replace(/\r/g, ""), page + " changes only its cache factory, preserving page/form business logic");
}

const dialogHooks = hookRuntime(); const dialogEnv = makeEnvironment(); let focus = 0; let renew = 0;
const dialog = await loadModule("src/components/auth/InactivityWarningDialog.jsx", { react: dialogHooks.runtime, "react/jsx-runtime": jsx, "react-dom": { createPortal: value => value } }, dialogEnv.context);
dialogHooks.mount(dialog.namespace.default, { secondsRemaining: 60, onStayLoggedIn: () => renew++ });
dialogHooks.slots[0].current = { focus: () => focus++ };
let prevented = 0;
for (const key of ["Escape", "Tab"]) dialogEnv.document.emit("keydown", { key, preventDefault: () => prevented++, stopPropagation() {} });
check(prevented === 2 && focus === 2 && renew === 0, "actual modal Escape/Tab contain focus without renewing or dismissing");
check(!dialogHooks.result.props.onClick && !dialogHooks.result.props.onMouseDown, "backdrop has no dismissal handler");
check(dialogHooks.result.props.children.props.role === "alertdialog", "warning has accessible dialog semantics");
const dialogText = JSON.stringify(dialogHooks.result);
check(dialogText.includes("unsaved changes may be lost") && dialogText.includes("Stay Logged In"), "warning communicates unsaved loss and explicit renewal action");
dialogHooks.unmount();

// Render the active login component, including existing cleanup query flows.
function allNodes(node) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(allNodes);
  return [node, ...allNodes(node.props?.children)];
}
for (const query of ["reason=inactivity", "logout=1", "emailChanged=1"]) {
  const loginEnv = makeEnvironment(); const loginHooks = hookRuntime(); const loginClient = authHarness();
  loginClient.emit("SIGNED_OUT", null); let logouts = 0;
  const loginNavigate = () => {};
  loginClient.auth.signOut = async () => { logouts++; return { error: null }; };
  const loginModule = await loadModule("src/pages/auth/login.jsx", {
    react: loginHooks.runtime, "react/jsx-runtime": jsx, "@iconify/react": { Icon: "Icon" },
    "react-router-dom": { Link: "Link", useNavigate: () => loginNavigate, useSearchParams: () => [new URLSearchParams(query)] },
    "../../lib/supabaseClient": { supabase: loginClient }, "./supabaseClient": { supabase: loginClient },
    "../../lib/auditLog": { recordAuditEvent: async () => {} },
    "../../components/common/MaternalCareLogo": { default: "Logo" },
  }, loginEnv.context);
  loginHooks.mount(loginModule.namespace.default); await settle(loginHooks);
  const rendered = allNodes(loginHooks.result);
  if (query === "reason=inactivity") {
    check(rendered.some(node => node.props.className === "login-success-message" && node.props.children === "You were logged out due to inactivity."), "actual login renders a friendly inactivity status message");
    check(!rendered.some(node => node.props.className === "login-error-message"), "inactivity notice is not a generic sign-in error");
  } else check(logouts === 1, "actual login preserves SDK cleanup for " + query);
  loginHooks.unmount();
}

const bridgeEnv = makeEnvironment(); const bridgeHooks = hookRuntime(); let bridgeReports = 0; let bridgeClears = 0;
const bridge = await loadModule("src/hooks/useRoleInactivityIdentity.js", {
  react: bridgeHooks.runtime,
  "../context/roleInactivityContext": { RoleInactivityContext: { value: () => { bridgeReports++; return () => bridgeClears++; } } },
}, bridgeEnv.context);
const bridgeRender = props => { bridge.namespace.useRoleInactivityIdentity(props); return null; };
const bridgeIdentity = { userId: "synthetic-clinic", role: "admin", authorized: true, revalidate: async () => {}, revision: {} };
bridgeHooks.mount(bridgeRender, bridgeIdentity);
bridgeHooks.update({ ...bridgeIdentity, revision: {} });
check(bridgeReports === 2 && bridgeClears === 1, "fresh verified guard revision re-registers a same-user replacement session");
bridgeHooks.update({ ...bridgeIdentity, authorized: false });
check(bridgeClears === 2, "denied guard removes the provider's authorized binding");
bridgeHooks.unmount();
check(!/\.(?:from|rpc)\(/.test(await source("src/components/auth/RoleInactivityProvider.jsx")), "provider has no role/profile/database queries");
check(Object.keys(JSON.parse(old.storage.getItem(INACTIVITY_STORAGE_PREFIX + "new-session"))).sort().join(",") === "expired,lastActivity", "shared activity record contains only timestamp and terminal boolean");
const login = await source("src/pages/auth/login.jsx");
check(login.includes('searchParams.get("reason") === "inactivity"') && login.includes('useState(inactivityLogout ? "You were logged out due to inactivity." : "")'), "inactivity notice uses existing non-error success styling");
check(login.includes('searchParams.get("logout") === "1"') && login.includes('searchParams.get("emailChanged") === "1"') && login.includes("signOutWithTimeout()"), "legacy logout/emailChanged session cleanup retained");
const app = await source("src/App.jsx");
check((app.match(/<RoleInactivityProvider>/g) || []).length === 1 && app.indexOf("<RoleInactivityProvider>") < app.indexOf("<Routes>"), "one provider above all routes");
check(!app.slice(app.indexOf("function PatientRoute()"), app.indexOf("function StaffRoute()")).includes("useRoleInactivityIdentity"), "Patient workspace never registers inactivity identity");
for (const role of ["doctor", "staff"]) {
  const path = role === "doctor" ? "src/pages/doctor/Doctor_Dashboard.jsx" : "src/pages/staff/StaffDashboard.jsx";
  check((await source(path)).includes("await supabase.auth.signOut()"), role + " existing manual SDK logout retained");
}
check((await source("src/context/AdminAuthContext.jsx")).includes("await supabase.auth.signOut()"), "Admin manual SDK logout retained");
for (const path of protectedForms) {
  const baseline = spawnSync("git", ["diff", "--exit-code", "HEAD", "--", path], { windowsHide: true });
  check(baseline.status === 0 && createHash("sha256").update(await readFile(new URL(path, root))).digest("hex") === initialFormHashes.get(path), "protected form unchanged in Git and byte-for-byte during verification: " + path);
}
console.log("Role inactivity verification passed: " + checks + " assertions.");
console.log("Actual timer, provider, dialog, Admin/Staff hooks and cleanup tested with synthetic auth/storage; no backend access.");
