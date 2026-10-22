// Offline: actual Admin auth hook, layout/loading JSX, route fallback and logout
// callback with synthetic transports. No backend requests or browser claims.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { parse } from "espree";
import { transformWithOxc } from "vite";

if (!vm.SourceTextModule) {
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", ...process.argv.slice(1)], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const ast = source => parse(source, { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true }, range: true });
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const equal = (value, expected, message) => { assert.deepEqual(value, expected, message); checks++; };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const ok = data => ({ data, error: null });
const offline = new Error("Synthetic connection failure");
const user = { id: "synthetic-admin", email: "admin@synthetic.test" };
const profile = { id: user.id, role: "admin", account_status: "active", full_name: "Synthetic Admin" };
const session = { user, access_token: "synthetic-token" };

function hooks() {
  const slots = [], effects = [];
  let cursor = 0, dirty = true, component, result;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const runtime = {
    useRef(value) { const index = cursor++; return slots[index] ||= { current: value }; },
    useState(initial) {
      const index = cursor++;
      slots[index] ||= { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, value => { slots[index].value = typeof value === "function" ? value(slots[index].value) : value; dirty = true; }];
    },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps, deps)) slots[index] = { value: callback, deps };
      return slots[index].value;
    },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps, deps)) effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; });
    },
  };
  return {
    runtime, get result() { return result; },
    mount(fn) { component = fn; this.flush(); },
    flush() {
      let renders = 0;
      while (dirty) {
        if (++renders > 30) throw new Error("Unexpected auth render loop");
        dirty = false; cursor = 0; result = component();
        for (const effect of effects.splice(0)) effect();
      }
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}
async function settle(runtime) {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  runtime.flush();
}
const hookSource = (await read("src/hooks/useAuthenticatedAdmin.js")).replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, "");
function authFixture(options = {}) {
  const runtime = hooks(), timers = new Map(), listeners = new Set();
  let timerId = 0, clears = 0;
  const plan = { user: ok({ user }), profile: ok(profile), session: ok({ session }), ...options };
  const supabase = {
    auth: {
      getUser: async () => plan.user,
      getSession: async () => plan.session,
      onAuthStateChange(callback) { listeners.add(callback); return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } }; },
    },
    from(table) {
      equal(table, "profiles", "auth retains the authoritative profile query");
      return { select() { return this; }, eq() { return this; }, maybeSingle: async () => plan.profile };
    },
    realtime: { setAuth: async () => { if (plan.realtimeError) throw offline; } },
  };
  const context = vm.createContext({ ...runtime.runtime, supabase, clearAdminWorkspaceSnapshots: () => clears++,
    window: { setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id) } });
  const useHook = vm.runInContext(hookSource + "\nuseAuthenticatedAdmin", context);
  runtime.mount(useHook);
  return { runtime, plan, supabase, get clears() { return clears; },
    start() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    emit(event, nextSession) { for (const listener of listeners) listener(event, nextSession); runtime.flush(); } };
}

const slowUser = deferred(), slowProfile = deferred();
const auth = authFixture({ user: slowUser.promise, profile: slowProfile.promise });
check(auth.runtime.result.loading && !auth.runtime.result.isAdmin, "initial auth blocks protected content");
auth.start(); await settle(auth.runtime);
check(auth.runtime.result.loading, "slow user verification remains loading");
slowUser.resolve(ok({ user })); await settle(auth.runtime);
check(auth.runtime.result.loading && !auth.runtime.result.isAdmin, "slow profile verification cannot prematurely authorize");
slowProfile.resolve(ok(profile)); await settle(auth.runtime);
check(auth.runtime.result.isAdmin && !auth.runtime.result.loading && !auth.runtime.result.error, "verified active Admin completes loading");
const refreshGate = deferred(); auth.plan.profile = refreshGate.promise;
const refresh = auth.runtime.result.refresh(); await settle(auth.runtime);
check(auth.runtime.result.isAdmin && !auth.runtime.result.loading, "background refresh retains the verified identity without a full-screen flash");
refreshGate.resolve({ data: null, error: offline }); await refresh; await settle(auth.runtime);
check(!auth.runtime.result.loading && auth.runtime.result.error, "failed refresh leaves loading and exposes an error");
auth.plan.profile = ok(profile); await auth.runtime.result.refresh(); await settle(auth.runtime);
check(auth.runtime.result.isAdmin && !auth.runtime.result.error, "retry recovers valid Admin access");
auth.runtime.unmount();

for (const [options, code] of [
  [{ user: ok({ user: null }) }, "admin_not_authenticated"],
  [{ profile: ok({ ...profile, role: "doctor" }) }, "admin_role_mismatch"],
  [{ profile: ok({ ...profile, account_status: "inactive" }) }, "admin_account_inactive"],
  [{ profile: { data: null, error: offline } }, undefined],
  [{ session: { data: {}, error: offline } }, undefined],
]) {
  const fixture = authFixture(options); fixture.start(); await settle(fixture.runtime);
  check(!fixture.runtime.result.loading && !fixture.runtime.result.isAdmin && fixture.runtime.result.error, "denied/failed verification finishes without protected access");
  if (code) equal(fixture.runtime.result.error.code, code, "existing role/account redirect reason is preserved");
  fixture.runtime.unmount();
}
const rejected = authFixture(); rejected.supabase.auth.getUser = async () => { throw offline; };
rejected.start(); await settle(rejected.runtime);
check(!rejected.runtime.result.loading && rejected.runtime.result.error, "rejected transport exits loading"); rejected.runtime.unmount();
const realtime = authFixture({ realtimeError: true }); realtime.start(); await settle(realtime.runtime);
check(realtime.runtime.result.isAdmin && !realtime.runtime.result.loading, "optional Realtime synchronization failure preserves existing authorization behavior"); realtime.runtime.unmount();
const signoutGate = deferred(), signedOut = authFixture({ profile: signoutGate.promise });
signedOut.start(); await settle(signedOut.runtime); signedOut.emit("SIGNED_OUT", null);
signoutGate.resolve(ok(profile)); await settle(signedOut.runtime);
check(!signedOut.runtime.result.loading && !signedOut.runtime.result.isAdmin && signedOut.runtime.result.error.code === "admin_not_authenticated", "late authorization cannot restore signed-out access");
equal(signedOut.clears, 1, "signout preserves workspace cache cleanup"); signedOut.runtime.unmount();
const oldProfile = deferred(), racing = authFixture({ profile: oldProfile.promise }); racing.start(); await settle(racing.runtime);
racing.plan.profile = ok(profile); await racing.runtime.result.refresh(); await settle(racing.runtime);
oldProfile.resolve({ data: null, error: offline }); await settle(racing.runtime);
check(racing.runtime.result.isAdmin && !racing.runtime.result.loading && !racing.runtime.result.error, "older failure cannot replace the current successful result"); racing.runtime.unmount();

// Actual UI modules with inert sidebar/profile/inactivity dependencies.
let route = "/admin/dashboard", access = { loading: true, error: null, refreshProfile() {} }, outlet;
const uiContext = vm.createContext({});
const uiReact = { ...React, useState: initial => [typeof initial === "function" ? initial() : initial, () => {}], useRef: current => ({ current }), useEffect() {}, useCallback: fn => fn };
const marker = name => () => React.createElement("div", { "data-test": name });
const Navigate = () => null;
const mocks = {
  react: { default: uiReact, ...uiReact }, "react/jsx-runtime": jsxRuntime,
  "react-router-dom": { useLocation: () => ({ pathname: route, search: "", hash: "" }), Navigate, Outlet: () => outlet },
  "@iconify/react": { Icon: () => React.createElement("svg", { "aria-hidden": true }) },
  "../../hooks/useAdminAuth": { useAdminAuth: () => access },
  "../../hooks/useRoleInactivityIdentity": { useRoleInactivityIdentity() {} },
  "./AdminSidebar": { default: marker("sidebar") }, "./AdminProfileDropdown": { default: marker("profile") },
};
const loaded = new Map();
const paths = {
  "../common/WorkspaceLoadingScreen": "src/components/common/WorkspaceLoadingScreen.jsx",
  "../common/WorkspaceSectionFallback": "src/components/common/WorkspaceSectionFallback.jsx",
  "./MaternalCareLogo": "src/components/common/MaternalCareLogo.jsx",
  "./AdminPageState": "src/components/admin/AdminPageState.jsx",
};
async function loadUi(path, sourceOverride) {
  if (loaded.has(path)) return loaded.get(path);
  const source = sourceOverride || await read(path);
  const code = (await transformWithOxc(source, path, { jsx: { runtime: "automatic", development: false } })).code;
  const module = new vm.SourceTextModule(code, { context: uiContext }); loaded.set(path, module);
  await module.link(spec => {
    if (paths[spec]) return loadUi(paths[spec]);
    const values = spec.endsWith(".css") ? {} : mocks[spec];
    if (!values) throw Error("Unexpected UI dependency: " + spec);
    return new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context: uiContext });
  });
  await module.evaluate(); return module;
}
const state = (await loadUi("src/components/admin/AdminPageState.jsx")).namespace.default;
const workspace = (await loadUi("src/components/common/WorkspaceLoadingScreen.jsx")).namespace.default;
const layout = (await loadUi("src/components/admin/AdminLayout.jsx")).namespace.default;
const markup = (component, props) => renderToStaticMarkup(React.createElement(component, props));
const adminMarkup = markup(state);
for (const path of ["/doctor/dashboard", "/staff/settings"]) {
  route = path; equal(markup(workspace), adminMarkup, "Admin startup exactly matches " + path);
}
route = "/admin/dashboard";
check(adminMarkup.includes('/images/maternal-care-logo.png') && !adminMarkup.includes("<span"), "Admin startup retains the original logo without duplicate text or shimmer");
const errorMarkup = markup(state, { type: "error", message: "Synthetic load failure", onRetry() {} });
check(errorMarkup.includes('role="alert"') && errorMarkup.includes("Retry") && !errorMarkup.includes("maternal-workspace-loading"), "existing error and retry UI does not masquerade as loading");
equal(markup(layout), adminMarkup, "Admin layout blocks with the shared screen during initial verification");
for (const [error, destination] of [
  [{ code: "admin_not_authenticated" }, "/login?next=%2Fadmin%2Fdashboard"],
  [{ code: "admin_account_inactive" }, "/login?reason=admin_inactive"],
  [{ code: "admin_role_mismatch", role: "doctor" }, "/doctor"],
]) {
  access = { loading: false, error };
  const tree = layout(); equal(tree.type, Navigate, "denied Admin access still redirects"); equal(tree.props.to, destination, "existing redirect destination is unchanged");
}
access = { loading: false, error: offline, refreshProfile() {} };
check(markup(layout).includes('role="alert"'), "network/profile errors keep the safe retry screen");
access = { loading: false, isAdmin: true, user, profile };
outlet = React.createElement("article", null, "Synthetic current Admin page");
check(markup(layout).includes('data-test="sidebar"') && markup(layout).includes("Synthetic current Admin page"), "authorized layout renders navigation and page content");
const Pending = () => { throw new Promise(() => {}); };
outlet = React.createElement(Pending);
const pendingHtml = renderToString(React.createElement(layout)).replace(/<!--[\s\S]*?-->/g, "");
check(pendingHtml.includes('data-test="sidebar"') && pendingHtml.includes('data-test="profile"') && pendingHtml.includes("Loading Admin workspace..."), "a pending page chunk keeps the Admin shell and uses the section loader");
check(!pendingHtml.includes("maternal-workspace-loading-card"), "page chunk loading does not duplicate the full-screen logo loader");
outlet = React.createElement("article", null, "Synthetic next Admin page"); route = "/admin/reports";
check(markup(layout).includes("Synthetic next Admin page"), "next section renders without initial-auth loading");

function find(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const value of Object.values(node)) for (const child of Array.isArray(value) ? value : [value]) { const result = find(child, predicate); if (result) return result; }
  return null;
}
const appSource = await read("src/App.jsx");
const routeFallback = find(ast(appSource), node => node.type === "FunctionDeclaration" && node.id?.name === "RouteLoadingFallback");
mocks["./components/common/WorkspaceLoadingScreen"] = { default: workspace };
const fallback = (await loadUi("route-fallback.jsx", 'import {useLocation} from "react-router-dom"; import WorkspaceLoadingScreen from "./components/common/WorkspaceLoadingScreen";\n' + appSource.slice(...routeFallback.range) + "\nexport default RouteLoadingFallback;")).namespace.default;
route = "/admin/dashboard"; equal(markup(fallback), adminMarkup, "initial Admin lazy-route fallback matches authentication loading");

const providerSource = await read("src/context/AdminAuthContext.jsx");
const logoutNode = find(ast(providerSource), node => node.type === "VariableDeclarator" && node.id?.name === "logout").init.arguments[0];
const events = [], logoutPromiseRef = { current: null }, logoutGate = deferred();
const logout = vm.runInNewContext("(" + providerSource.slice(...logoutNode.range) + ")", {
  logoutPromiseRef, recordAuditEvent: async () => { events.push("audit"); },
  supabase: { auth: { signOut: () => { events.push("signout"); return logoutGate.promise; } } },
  navigate: destination => events.push(destination),
});
const firstLogout = logout(), secondLogout = logout();
equal(firstLogout, secondLogout, "Admin logout coalesces duplicate actions");
await Promise.resolve(); logoutGate.resolve({ error: null }); await firstLogout;
equal(events.join(","), "audit,signout,/login?logout=1", "Admin logout preserves audit, SDK signout, and redirect ordering");
console.log(`PASS: ${checks} Admin loading/auth/layout/logout checks; synthetic transports only. Live browser/session/layout checks remain separate.`);
