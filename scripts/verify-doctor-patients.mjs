import assert from "node:assert/strict";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithOxc } from "vite";
import { createClient } from "@supabase/supabase-js";
import { createDoctorSessionCache, clearDoctorSessionCaches } from "../src/lib/doctorSessionCache.js";

const root = new URL("../", import.meta.url);
if (!vm.SourceTextModule) {
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", ...process.argv.slice(1)], {
    cwd: fileURLToPath(root), stdio: "inherit", windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}
function same(actual, expected, message) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
  checks += 1;
}
const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};

// Execute the production component/effects with controlled requests and timers.
// No browser credentials, database traffic, or source rewriting on disk is used.
function hookRuntime() {
  const slots = [], effects = [];
  let cursor = 0, dirty = true, render, tree;
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, n) => Object.is(value, b[n]));
  const react = {
    useState(initial) {
      const n = cursor++;
      if (!slots[n]) slots[n] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[n].value, update => {
        const next = typeof update === "function" ? update(slots[n].value) : update;
        if (!Object.is(next, slots[n].value)) { slots[n].value = next; dirty = true; }
      }];
    },
    useRef(initial) {
      const n = cursor++;
      if (!slots[n]) slots[n] = { value: { current: initial } };
      return slots[n].value;
    },
    useMemo(factory, deps) {
      const n = cursor++;
      if (!slots[n] || !equal(slots[n].deps, deps)) slots[n] = { value: factory(), deps };
      return slots[n].value;
    },
    useEffect(effect, deps) {
      const n = cursor++;
      if (!slots[n] || !equal(slots[n].deps, deps)) effects.push(() => {
        slots[n]?.cleanup?.();
        slots[n] = { deps, cleanup: effect() };
      });
    },
  };
  return {
    react,
    mount(callback) { render = callback; dirty = true; },
    update() { dirty = true; },
    current() {
      if (dirty) {
        dirty = false; cursor = 0; tree = render();
        for (const effect of effects.splice(0)) effect();
      }
      return tree;
    },
    async settle() {
      for (let n = 0; n < 30; n++) {
        this.current(); await flush();
        if (!dirty) return tree;
      }
      throw new Error("Doctor Patients state did not settle");
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

const pagePath = "src/pages/doctor/Doctor_Patients.jsx";
const source = await readFile(new URL(pagePath, root), "utf8");
const compiled = (await transformWithOxc(source +
  "\nexport { PatientListPage, isActivePatientRow, mapSupabasePatient, fetchPatientAvatarMap };",
pagePath, { jsx: { runtime: "automatic", development: false } })).code;

async function loadPage(react, supabase, cache, environment, directoryErrors = new Map()) {
  const context = vm.createContext(environment);
  const imports = {
    react,
    "react/jsx-runtime": jsxRuntime,
    "@iconify/react": { Icon: () => null },
    "react-router-dom": { useLocation: () => environment.location },
    "../../lib/supabaseClient": { supabase },
    "../../lib/doctorSessionCache": { createDoctorSessionCache: (() => {
      let created = 0;
      return () => created++ === 0 ? cache : directoryErrors;
    })() },
    "../../hooks/useDoctorDelayedLoader": { useDoctorDelayedLoader: loading => loading },
    "../../styles/doctor-patients.css": {},
  };
  const module = new vm.SourceTextModule(compiled, { context });
  await module.link(specifier => {
    assert.ok(Object.hasOwn(imports, specifier), "Unexpected Patients dependency: " + specifier);
    const exports = imports[specifier];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

async function loadProductionSupabaseClient() {
  const clientSource = await readFile(new URL("src/lib/supabaseClient.js", root), "utf8");
  const context = vm.createContext({ window: {} });
  const module = new vm.SourceTextModule(clientSource, {
    context,
    initializeImportMeta(meta) {
      meta.env = {
        VITE_SUPABASE_URL: "https://production-client.example.test",
        VITE_SUPABASE_ANON_KEY: "synthetic-anon-key",
      };
    },
  });
  await module.link(specifier => {
    assert.equal(specifier, "@supabase/supabase-js");
    return new vm.SyntheticModule(["createClient"], function () {
      this.setExport("createClient", createClient);
    }, { context });
  });
  await module.evaluate();
  return module.namespace.supabase;
}

const validIdentity = { loading: false, error: null, authUser: { id: "synthetic-doctor" } };
const patient = (id = "one", name = "Maria Santos", extra = {}) => ({
  id, patient_id: "PT-" + id, full_name: name, status: "active", archived_at: null,
  date_of_birth: "2000-01-01", created_at: "2026-10-01T00:00:00Z", ...extra,
});
const liveHarnesses = [];
const directoryErrorsBySnapshot = new WeakMap();
async function harness(options = {}) {
  const hooks = hookRuntime(), cache = options.cache || createDoctorSessionCache();
  if (!directoryErrorsBySnapshot.has(cache)) directoryErrorsBySnapshot.set(cache, createDoctorSessionCache());
  const directoryErrors = directoryErrorsBySnapshot.get(cache);
  const directory = [], avatars = [], channels = [], diagnostics = [], timers = new Map(), events = [];
  const blockedFetchCalls = [];
  let timerId = 0, identity = options.identity ?? validIdentity;
  let directoryThrow = options.directoryThrow, avatarThrow = options.avatarThrow;
  let blockDirectoryFetch = Boolean(options.blockDirectoryFetch);
  const blockedDirectoryClient = blockDirectoryFetch ? createClient(
    "https://blocked-directory.example.test", "synthetic-anon-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async (url, init) => {
        blockedFetchCalls.push({ url: String(url), method: init?.method });
        throw new TypeError("Failed to fetch: synthetic request blocker");
      } },
    }
  ) : null;
  const hub = () => {
    const handlers = new Map();
    return {
      addEventListener(name, callback) {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name).add(callback);
      },
      removeEventListener(name, callback) { handlers.get(name)?.delete(callback); },
      emit(name) { return [...(handlers.get(name) || [])].map(callback => callback()); },
      count(name) { return handlers.get(name)?.size || 0; },
    };
  };
  const window = {
    ...hub(),
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    dispatchEvent(event) { events.push(event); },
  };
  const document = { ...hub(), visibilityState: "visible" };
  const location = { pathname: options.path || "/doctor/patients" };
  const supabase = {
    rpc(name, args) {
      assert.ok(["get_doctor_patient_directory", "get_patient_avatar_urls"].includes(name));
      const request = { ...deferred(), name, args, columns: "", ordering: null };
      (name === "get_doctor_patient_directory" ? directory : avatars).push(request);
      if (name === "get_doctor_patient_directory" && directoryThrow) {
        const error = directoryThrow; directoryThrow = null; throw error;
      }
      if (name === "get_patient_avatar_urls" && avatarThrow) {
        const error = avatarThrow; avatarThrow = null; throw error;
      }
      if (name === "get_doctor_patient_directory" && options.directoryClient) {
        return options.directoryClient.rpc(name, args);
      }
      if (name === "get_doctor_patient_directory" && blockDirectoryFetch) {
        blockDirectoryFetch = false;
        return blockedDirectoryClient.rpc(name, args);
      }
      return {
        select(columns) { request.columns = columns; return this; },
        order(column, settings) { request.ordering = { column, ...settings }; return this; },
        then(resolve, reject) { return request.promise.then(resolve, reject); },
      };
    },
    channel(name) {
      const channel = {
        name, active: true,
        on(type, filter, callback) { Object.assign(this, { type, filter, callback }); return this; },
        subscribe() { return this; },
      };
      channels.push(channel); return channel;
    },
    removeChannel(channel) {
      channel.active = false;
      return options.removeChannelError ? Promise.reject(options.removeChannelError) : Promise.resolve("ok");
    },
  };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } }
  const module = await loadPage(hooks.react, supabase, cache, {
    window, document, location, CustomEvent,
    console: { error: (...args) => diagnostics.push(args), warn: (...args) => diagnostics.push(args) },
  }, directoryErrors);
  hooks.mount(() => module.default({ doctorIdentity: identity }));
  const result = {
    hooks, cache, directory, avatars, channels, diagnostics, timers, events, window, document, module, blockedFetchCalls,
    get props() { return hooks.current().props.children.props; },
    async updateIdentity(next) { identity = next; hooks.update(); await hooks.settle(); },
    async navigate(path) { location.pathname = path; hooks.update(); await hooks.settle(); await this.flushTimers(); },
    async flushTimers() {
      for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
      await hooks.settle();
    },
    refresh() { return channels.findLast(channel => channel.active).callback(); },
    async reply(rows, { index = directory.length - 1, error = null, enrich = true } = {}) {
      const before = avatars.length;
      directory[index].resolve({ data: rows, error }); await hooks.settle();
      if (enrich) {
        for (const request of avatars.slice(before)) request.resolve({ data: [], error: null });
        await hooks.settle();
      }
    },
    close() { hooks.unmount(); },
  };
  liveHarnesses.push(result);
  await hooks.settle();
  return result;
}

function nodes(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => nodes(child, predicate));
  if (!node || typeof node !== "object") return [];
  return [...(predicate(node) ? [node] : []), ...nodes(node.props?.children, predicate)];
}
const presentation = await loadPage({ ...React, useMemo: factory => factory() }, {}, new Map(), {});
const tree = props => presentation.PatientListPage(props);
const markup = props => renderToStaticMarkup(tree(props));
const retryButton = props => nodes(tree(props), node => node.type === "button" && node.props.className === "doctor-patients-retry-btn")[0];

const unhandled = [];
const onUnhandled = error => unhandled.push(error);
process.on("unhandledRejection", onUnhandled);
try {
  // Lifecycle checks run through both the predicate and the actual directory loader.
  const cases = [
    [patient(), true, "active non-archived"],
    [patient("inactive", "Inactive", { status: "inactive" }), false, "inactive"],
    [patient("deleted", "Deleted", { status: "deleted" }), false, "deleted"],
    [patient("archived", "Archived", { status: "archived" }), false, "archived status"],
    [patient("timestamp", "Timestamp", { archived_at: "2026-10-01T00:00:00Z" }), false, "active with archive timestamp"],
    [patient("null", "Null", { archived_at: null }), true, "explicit null archive flag"],
    [patient("normalized", "Normalized", { status: "  InAcTiVe  " }), false, "normalized inactive status"],
  ];
  for (const [row, expected, label] of cases) check(presentation.isActivePatientRow(row) === expected, "Lifecycle: " + label);
  const mixed = await harness();
  await mixed.reply(cases.map(([row]) => row));
  same(mixed.props.patients.map(row => row.recordId), ["one", "null"], "Mixed directory contains exactly eligible rows");
  check(mixed.directory[0].columns.includes("archived_at"), "Archive flag is requested");
  const baselinePage = spawnSync("git", ["show", "HEAD:" + pagePath], { cwd: fileURLToPath(root), encoding: "utf8", windowsHide: true });
  assert.equal(baselinePage.status, 0);
  const baselineColumns = baselinePage.stdout.match(/const patientSelectColumns\s*=\s*"([^"]+)"/)[1];
  check(mixed.directory[0].columns.replace(", archived_at", "") === baselineColumns.replace(", archived_at", ""), "No projection narrowing or unrelated fields");
  same(mixed.directory[0].ordering, { column: "created_at", ascending: false }, "Existing directory ordering preserved");
  check(mixed.directory[0].args === undefined, "Existing argument-free directory RPC preserved");

  const loading = await harness({ identity: { loading: true, authUser: null, error: null } });
  check(loading.props.loadState === "loading", "Identity loading keeps existing loading state");
  check(loading.directory.length === 0, "Identity loading does not request directory");
  check(markup(loading.props).includes("Loading patients..."), "Existing accessible loading announcement preserved");
  check(markup(loading.props).includes("doctor-patients-skeleton-row"), "Existing skeleton preserved");
  check(!markup(loading.props).includes("No patient found."), "Loading does not flash successful empty state");
  await loading.updateIdentity(validIdentity);
  check(loading.directory.length === 1, "Valid resolved identity permits loading");
  await loading.reply([]);
  check(loading.props.loadState === "loaded", "Valid empty directory settles loading");
  check(markup(loading.props).includes("No patient found."), "Successful empty presentation preserved");
  check(loading.avatars.length === 0, "Empty directory skips avatar RPC");

  for (const identity of [
    { loading: false, authUser: null, error: new Error("Private identity detail") },
    { loading: false, authUser: null, error: null },
    { loading: false, authUser: {}, error: null },
    { ...validIdentity, error: new Error("Private profile detail") },
  ]) {
    const failed = await harness({ identity });
    check(failed.props.loadState === "error", "Resolved unusable identity stops loading");
    check(failed.props.identityError.includes("Unable to verify your Doctor account"), "Identity failure has friendly page error");
    check(failed.directory.length === 0 && failed.channels.length === 0, "Identity error cannot initiate directory request/subscription");
    check(!markup(failed.props).includes("doctor-patients-skeleton-row"), "Identity failure has no permanent skeleton");
    check(!markup(failed.props).includes("Private"), "Identity diagnostics are not exposed");
    check(!retryButton(failed.props), "Directory Retry is unavailable without usable identity");
    failed.close();
  }
  const identityTransition = await harness({ identity: { loading: true, authUser: null, error: null } });
  await identityTransition.updateIdentity({ loading: false, authUser: null, error: new Error("Resolved identity failure") });
  check(identityTransition.props.loadState === "error" && identityTransition.directory.length === 0, "Loading-to-identity-error transition settles without a request");
  const existingIdentity = await harness();
  await existingIdentity.reply([patient()]);
  await existingIdentity.updateIdentity({ ...validIdentity, error: new Error("Identity no longer usable") });
  const requestsBeforeFocus = existingIdentity.avatars.length;
  existingIdentity.window.emit("focus"); await existingIdentity.hooks.settle();
  check(existingIdentity.props.loadState === "error", "Resolved identity error hides previously loaded directory");
  check(existingIdentity.avatars.length === requestsBeforeFocus && !existingIdentity.channels.some(channel => channel.active), "Identity failure stops page-local requests/listeners");

  // Retry uses the rendered action and the same loader/query; repeated captured
  // click callbacks are tested before React has time to disable the button.
  const retry = await harness();
  await retry.reply(null, { error: { message: "Private database detail" } });
  check(retry.props.loadState === "error", "First returned directory error settles loading");
  check(!markup(retry.props).includes("doctor-patients-refresh-warning"), "First-load failure uses the full error presentation");
  check(Boolean(retryButton(retry.props)), "First directory error exposes Retry");
  check(markup(retry.props).includes('role="alert"'), "Directory error is announced");
  check(!markup(retry.props).includes("Private database detail"), "Friendly error hides database details");
  check(!markup(retry.props).includes("No patient found."), "Directory failure is not successful empty state");
  const click = retryButton(retry.props).props.onClick;
  const attempt = click(); click(); click();
  await retry.hooks.settle();
  check(retry.directory.length === 2, "Repeated manual click callbacks start one retry request");
  check(retryButton(retry.props).props.disabled, "Retry is disabled while pending");
  check(retryButton(retry.props).props["aria-busy"], "Retry exposes busy state");
  check(markup(retry.props).includes("Retrying..."), "Retry has visible pending feedback");
  check(Boolean(retry.props.directoryError), "Existing failure remains visible until retry succeeds");
  same({ name: retry.directory[1].name, columns: retry.directory[1].columns, ordering: retry.directory[1].ordering },
    { name: retry.directory[0].name, columns: retry.directory[0].columns, ordering: retry.directory[0].ordering }, "Retry calls the same existing directory loader");
  await retry.reply([patient()]); await attempt; await retry.hooks.settle();
  check(retry.props.loadState === "loaded" && retry.props.patients.length === 1, "Retry success displays patient data");
  check(retry.props.directoryError === "", "Retry success clears request error");
  check(!retry.props.retryPending && !retryButton(retry.props), "Retry settles and action disappears after success");

  const beforeFailure = retry.props.patients;
  retry.refresh(); await retry.reply(null, { error: { message: "Refresh failure" } });
  check(retry.props.patients === beforeFailure, "Background error retains valid rows without replacement");
  check(retry.props.loadState === "loaded", "Background error retains loaded presentation");
  check(retry.props.directoryError.includes("previously loaded list"), "Background failure explains cached data");
  check(markup(retry.props).includes("Maria Santos") && Boolean(retryButton(retry.props)), "Rows and retry remain visible together");
  const failedAttempt = retry.props.onRetry(); await retry.hooks.settle();
  retry.directory.at(-1).reject(new Error("Rejected retry")); await failedAttempt; await retry.hooks.settle();
  check(!retry.props.retryPending && !retryButton(retry.props).props.disabled, "Rejected retry releases manual-click guard");
  check(retry.props.patients === beforeFailure, "Rejected background retry preserves rows");
  const nextAttempt = retry.props.onRetry(); await retry.reply([patient()]); await nextAttempt; await retry.hooks.settle();
  check(retry.props.directoryError === "", "Retry works again after rejection");

  for (const mode of ["synchronous throw", "promise rejection"]) {
    const failed = await harness(mode === "synchronous throw" ? { directoryThrow: new Error("Private thrown detail") } : {});
    if (mode === "promise rejection") { failed.directory[0].reject(new Error("Private rejected detail")); await failed.hooks.settle(); }
    check(failed.props.loadState === "error", mode + " settles directory loading");
    check(failed.props.directoryError === "Unable to load patients. Please try again.", mode + " uses friendly error");
    check(Boolean(retryButton(failed.props)), mode + " exposes recovery");
    failed.close();
  }

  // Target/search behavior remains as before, but it cannot erase request errors.
  const targeted = await harness({ path: "/doctor/patients/one" });
  await targeted.reply([patient()]); await targeted.flushTimers();
  check(targeted.props.searchTerm === "PT-one", "Existing targeted search behavior preserved");
  targeted.window.emit("focus");
  const pendingAvatar = targeted.avatars.at(-1);
  targeted.refresh(); await targeted.reply(null, { error: { message: "Targeted refresh failure" } });
  const directoryError = targeted.props.directoryError;
  pendingAvatar.resolve({ data: [{ patient_id: "one", avatar_url: "https://example.test/one.jpg" }], error: null });
  await targeted.hooks.settle(); await targeted.flushTimers();
  check(targeted.props.directoryError === directoryError, "Later avatar/target success cannot erase directory error");
  check(targeted.props.patients[0].photo.includes("one.jpg"), "Avatar enrichment can still complete after directory failure");
  await targeted.navigate("/doctor/patients/not-found");
  check(targeted.props.navigationNotice.includes("could not be found"), "Existing missing-target notice preserved");
  check(targeted.props.directoryError === directoryError, "Missing-target notice remains separate from directory error");
  check(markup(targeted.props).includes("could not be found") && markup(targeted.props).includes("Unable to refresh"), "Request error and navigation notice can coexist");

  for (const mode of ["returned error", "rejected promise", "synchronous throw"]) {
    const avatarFailure = await harness(mode === "synchronous throw" ? { avatarThrow: new Error("Avatar throw") } : {});
    await avatarFailure.reply([patient(), patient("two", "Ana Cruz")], { enrich: false });
    check(avatarFailure.props.loadState === "loaded", "Directory renders before " + mode + " avatar settlement");
    if (mode === "returned error") avatarFailure.avatars[0].resolve({ data: null, error: { message: "Avatar error" } });
    if (mode === "rejected promise") avatarFailure.avatars[0].reject(new Error("Avatar rejection"));
    await avatarFailure.hooks.settle();
    check(avatarFailure.props.loadState === "loaded" && avatarFailure.props.patients.length === 2, mode + " avatar failure is non-fatal");
    check(avatarFailure.props.directoryError === "", mode + " avatar failure is not a directory error");
    check(avatarFailure.avatars.length === 1, mode + " uses one avatar batch, not N+1");
    same(avatarFailure.avatars[0].args.p_patient_ids, ["one", "two"], "Avatar batch contains eligible row UUIDs");
    avatarFailure.close();
  }

  const photos = await harness();
  await photos.reply([patient()], { enrich: false });
  photos.avatars[0].resolve({ data: [{ patient_id: "one", avatar_url: "https://example.test/known.jpg" }], error: null });
  await photos.hooks.settle();
  const knownRows = photos.props.patients;
  photos.window.emit("focus"); photos.avatars.at(-1).reject(new Error("Focus avatar rejection")); await photos.hooks.settle();
  check(photos.props.patients === knownRows && photos.props.patients[0].photo.includes("known.jpg"), "Focus avatar rejection preserves existing rows/photos");
  photos.document.visibilityState = "hidden";
  const avatarCount = photos.avatars.length;
  photos.window.emit("focus"); await photos.hooks.settle();
  check(photos.avatars.length === avatarCount, "Hidden document does not refresh avatars");
  photos.document.visibilityState = "visible"; photos.document.emit("visibilitychange");
  photos.avatars.at(-1).reject(new Error("Visibility avatar rejection")); await photos.hooks.settle();
  check(photos.props.patients === knownRows, "Visibility avatar rejection preserves rows");
  photos.refresh(); await photos.reply([patient("one", "Fresh name")], { enrich: false });
  check(photos.props.patients[0].photo.includes("known.jpg"), "Directory refresh preserves known photo before enrichment");
  photos.avatars.at(-1).resolve({ data: null, error: { message: "Refresh avatar failure" } }); await photos.hooks.settle();
  check(photos.props.patients[0].name === "Fresh name" && photos.props.patients[0].photo.includes("known.jpg"), "Avatar failure keeps fresh directory fields and existing photo");
  const savedCache = photos.cache, savedRows = photos.props.patients;
  check(savedCache.get(validIdentity.authUser.id) === savedRows, "Doctor-keyed snapshot stores loaded rows");
  photos.close();
  const restored = await harness({ cache: savedCache });
  check(restored.props.patients === savedRows && restored.props.loadState === "loaded", "Re-entry immediately restores snapshot");
  restored.directory[0].reject(new Error("Cached refresh rejection")); await restored.hooks.settle();
  check(restored.props.patients === savedRows && restored.props.loadState === "loaded", "Rejected re-entry refresh retains snapshot");

  const failedSnapshotCache = createDoctorSessionCache();
  failedSnapshotCache.set(validIdentity.authUser.id, savedRows);
  const beforeRemount = await harness({ cache: failedSnapshotCache });
  beforeRemount.directory[0].reject(new TypeError("Failed to fetch")); await beforeRemount.hooks.settle();
  const errorBeforeRemount = beforeRemount.props.directoryError;
  beforeRemount.close();
  const afterRemount = await harness({ cache: failedSnapshotCache });
  check(afterRemount.props.directoryError === errorBeforeRemount && Boolean(retryButton(afterRemount.props)), "Same-snapshot remount preserves directory warning and Retry while refresh is pending");
  check(afterRemount.props.patients === savedRows && markup(afterRemount.props).includes("Fresh name"), "Same-snapshot remount preserves rows together with the warning");
  afterRemount.directory[0].reject(new TypeError("Failed to fetch")); await afterRemount.hooks.settle();
  check(afterRemount.props.directoryError === errorBeforeRemount, "Rejected remount refresh retains the directory warning");
  const warningProps = afterRemount.props;
  for (const state of ["loading", "loaded", "error"]) {
    const explicitWarning = { ...warningProps, loadState: state, retryPending: true };
    check(markup(explicitWarning).includes("doctor-patients-refresh-warning") && markup(explicitWarning).includes("Fresh name"), "Cached-row directoryError renders warning and rows independently of " + state + " state");
    check(retryButton(explicitWarning).props.disabled && retryButton(explicitWarning).props.onClick === explicitWarning.onRetry, "Cached-row branch consumes onRetry and retryPending in " + state + " state");
    check(!markup(explicitWarning).includes("doctor-patients-skeleton-row"), "Cached-row warning avoids replacement skeletons in " + state + " state");
  }
  const retryWithoutRows = { ...warningProps, patients: [], loadState: "loading", retryPending: true };
  check(markup(retryWithoutRows).includes('aria-label="Patient directory error"') && Boolean(retryButton(retryWithoutRows)), "No-row directoryError uses the full recoverable error during pending Retry");
  check(!markup(retryWithoutRows).includes("<table") && !markup(retryWithoutRows).includes("doctor-patients-skeleton-row"), "No-row directoryError replaces table and skeleton rather than hiding the error");
  afterRemount.close();
  const successfulRemount = await harness({ cache: failedSnapshotCache });
  check(successfulRemount.props.directoryError === errorBeforeRemount, "Directory warning survives another same-snapshot remount");
  await successfulRemount.reply([patient()]); successfulRemount.close();
  const clearedRemount = await harness({ cache: failedSnapshotCache });
  check(clearedRemount.props.directoryError === "" && !retryButton(clearedRemount.props), "Directory success clears the session warning before later remount");
  clearedRemount.close();
  const failedFirstCache = createDoctorSessionCache();
  const failedFirstMount = await harness({ cache: failedFirstCache });
  failedFirstMount.directory[0].reject(new TypeError("Failed to fetch")); await failedFirstMount.hooks.settle();
  failedFirstMount.close();
  const failedFirstRemount = await harness({ cache: failedFirstCache });
  check(Boolean(failedFirstRemount.props.directoryError) && Boolean(retryButton(failedFirstRemount.props)), "First-load directory error also survives remount while refresh is pending");
  check(!markup(failedFirstRemount.props).includes("<table") && !markup(failedFirstRemount.props).includes("doctor-patients-skeleton-row"), "Remounted first-load error does not revert to an indefinite skeleton");
  failedFirstRemount.close();
  const isolatedError = await harness({ cache: failedFirstCache, identity: { ...validIdentity, authUser: { id: "doctor-without-error" } } });
  check(isolatedError.props.directoryError === "", "Directory errors do not leak between Doctor identities");
  isolatedError.close();

  // Reproduce Dashboard -> Patients re-entry using a populated Doctor cache.
  // One case exercises the installed Supabase client with a rejected fetch;
  // its custom fetch never makes a network request or uses browser credentials.
  for (const mode of ["returned error", "rejected promise", "synchronous throw", "blocked fetch"]) {
    const cachedDirectory = createDoctorSessionCache();
    cachedDirectory.set(validIdentity.authUser.id, savedRows);
    const cached = await harness({
      cache: cachedDirectory,
      path: "/doctor/patients/one",
      directoryThrow: mode === "synchronous throw" ? new Error("Private blocked detail") : null,
      blockDirectoryFetch: mode === "blocked fetch",
    });
    if (mode === "returned error") await cached.reply(null, { error: { message: "Private refresh detail" } });
    if (mode === "rejected promise") {
      cached.directory[0].reject(new TypeError("Failed to fetch: private detail"));
      await cached.hooks.settle();
    }
    if (mode === "blocked fetch") {
      check(cached.blockedFetchCalls.length === 1 && cached.blockedFetchCalls[0].method === "POST", "Blocked fetch exercises the real directory RPC fetch path");
      check(cached.blockedFetchCalls[0].url.includes("/rpc/get_doctor_patient_directory"), "Blocked fetch targets only the directory RPC");
    }
    check(cached.props.patients === savedRows && cached.props.loadState === "loaded", mode + " preserves cached rows and settles loading");
    const warning = nodes(tree(cached.props), node => node.props.className?.includes("doctor-patients-refresh-warning"))[0];
    check(Boolean(warning) && warning.props.role === "alert" && !warning.props.hidden, mode + " exposes the directory refresh warning");
    check(warning.props["aria-label"] === "Patient directory refresh warning", mode + " identifies the warning accessibly");
    check(markup(cached.props).includes("Unable to refresh the patient directory") && markup(cached.props).includes("Fresh name"), mode + " renders warning and retained table together");
    check(!markup(cached.props).includes("Private") && !markup(cached.props).includes("Failed to fetch"), mode + " hides technical errors");
    check(!markup(cached.props).includes("doctor-patients-skeleton-row"), mode + " does not replace cached content with loading skeletons");
    check(Boolean(retryButton(cached.props)), mode + " provides Retry after cached re-entry failure");
    const cachedError = cached.props.directoryError;
    await cached.flushTimers();
    check(cached.props.searchTerm === "PT-one" && cached.props.navigationNotice === "", mode + " successful target processing remains intact");
    check(cached.props.directoryError === cachedError && Boolean(retryButton(cached.props)), mode + " target success cannot clear the directory warning");
    cached.window.emit("focus");
    cached.avatars.at(-1).resolve({ data: [{ patient_id: "one", avatar_url: "https://example.test/fresh-avatar.jpg" }], error: null });
    await cached.hooks.settle(); await cached.flushTimers();
    check(cached.props.patients[0].photo.includes("fresh-avatar.jpg"), mode + " avatar success still enriches cached rows");
    check(cached.props.directoryError === cachedError && Boolean(retryButton(cached.props)), mode + " avatar success cannot clear the directory warning");
    const retainedRows = cached.props.patients;
    const retryClick = retryButton(cached.props).props.onClick;
    const cachedAttempt = retryClick(); retryClick(); retryClick();
    await cached.hooks.settle();
    check(cached.directory.length === 2 && retryButton(cached.props).props.disabled, mode + " prevents repeat Retry while pending");
    check(cached.props.patients === retainedRows && cached.props.directoryError === cachedError, mode + " pending Retry preserves rows and warning");
    cached.directory.at(-1).reject(new TypeError("Retry fetch rejected"));
    await cachedAttempt; await cached.hooks.settle();
    check(cached.props.patients === retainedRows && cached.props.directoryError === cachedError, mode + " failed Retry preserves rows and warning");
    check(!retryButton(cached.props).props.disabled, mode + " failed Retry becomes available again");
    const recovered = retryButton(cached.props).props.onClick();
    await cached.reply([patient("one", "Recovered directory"), patient("archived-again", "Archived", { archived_at: "2026-10-06T00:00:00Z" })]);
    await recovered; await cached.hooks.settle();
    check(cached.props.directoryError === "" && !retryButton(cached.props), mode + " successful directory Retry clears the warning");
    same(cached.props.patients.map(row => row.recordId), ["one"], mode + " recovery preserves archive filtering");
    check(cached.props.patients[0].name === "Recovered directory", mode + " successful Retry publishes fresh directory fields");
    cached.close();
  }
  const backgroundRefresh = restored.refresh();
  await restored.reply([patient("one", "Updated without Retry")]); await backgroundRefresh;
  check(restored.props.directoryError === "" && !retryButton(restored.props), "Successful background directory refresh clears its warning");

  const firstBlockedFetch = await harness({ blockDirectoryFetch: true });
  check(firstBlockedFetch.props.loadState === "error" && Boolean(retryButton(firstBlockedFetch.props)), "Real blocked fetch on first load settles into full recoverable error");
  check(!markup(firstBlockedFetch.props).includes("doctor-patients-skeleton-row") && !markup(firstBlockedFetch.props).includes("doctor-patients-refresh-warning"), "First blocked fetch stops skeletons without showing a cached-row warning");
  firstBlockedFetch.close();

  // Use the unchanged production singleton module, installed SDK/auth fetch
  // wrapper and production Patients component. Intercept only the fetch
  // boundary, as DevTools request blocking does. No real network is permitted.
  const originalFetch = globalThis.fetch;
  let productionClient;
  const productionHarnesses = [];
  const productionFetchCalls = [];
  let blockProductionFetch = true;
  try {
    globalThis.fetch = async (url, init) => {
      const requestUrl = new URL(String(url));
      assert.equal(requestUrl.hostname, "production-client.example.test");
      assert.equal(requestUrl.pathname, "/rest/v1/rpc/get_doctor_patient_directory");
      productionFetchCalls.push({ method: init?.method });
      if (blockProductionFetch) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify([patient("one", "Production fetch recovery")]), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    };
    productionClient = await loadProductionSupabaseClient();
    await productionClient.auth.initialize();
    for (const withCache of [false, true]) {
      blockProductionFetch = true;
      const productionCache = createDoctorSessionCache();
      if (withCache) productionCache.set(validIdentity.authUser.id, savedRows);
      const production = await harness({
        cache: productionCache, directoryClient: productionClient,
        path: "/doctor/patients/one",
      });
      productionHarnesses.push(production);
      const label = withCache ? "cached production fetch" : "first production fetch";
      check(Boolean(production.props.directoryError) && Boolean(retryButton(production.props)), label + " publishes recoverable directory error");
      check(production.diagnostics.some(entry => entry[0] === "Load doctor patients failed:"), label + " reaches the production directory catch");
      check(production.props.loadState === (withCache ? "loaded" : "error"), label + " settles loading correctly");
      check(markup(production.props).includes("doctor-patients-refresh-warning") === withCache, label + " selects the appropriate error presentation");
      check(!markup(production.props).includes("Failed to fetch"), label + " does not expose fetch diagnostics");
      if (withCache) {
        check(production.props.patients === savedRows, "Production fetch rejection retains original cached rows");
        const productionError = production.props.directoryError;
        await production.flushTimers();
        check(production.props.searchTerm === "PT-one" && production.props.directoryError === productionError, "Production fetch warning survives successful target processing");
        production.props.setSearchTerm("Fresh"); await production.hooks.settle();
        check(production.props.directoryError === productionError && Boolean(retryButton(production.props)), "Production fetch warning survives search state changes");
        production.hooks.update(); await production.hooks.settle();
        await production.updateIdentity({ ...validIdentity, profile: { full_name: "Synthetic Doctor" } });
        check(production.props.directoryError === productionError && Boolean(retryButton(production.props)), "Production fetch warning survives ordinary and parent identity rerenders");
        production.window.emit("focus");
        production.avatars.at(-1).resolve({ data: [{ patient_id: "one", avatar_url: "https://example.test/production-avatar.jpg" }], error: null });
        await production.hooks.settle(); await production.flushTimers();
        check(production.props.patients[0].photo.includes("production-avatar.jpg") && production.props.directoryError === productionError, "Production fetch warning survives avatar completion and cache publication");
      } else {
        check(production.props.patients.length === 0 && !markup(production.props).includes("doctor-patients-skeleton-row"), "First production fetch rejection leaves no indefinite skeleton");
      }
      blockProductionFetch = false;
      const recoverProduction = retryButton(production.props).props.onClick();
      await production.hooks.settle();
      production.avatars.at(-1).resolve({ data: [], error: null });
      await recoverProduction; await production.hooks.settle();
      check(production.props.directoryError === "" && !retryButton(production.props), label + " successful production fetch Retry clears the error");
      check(production.props.patients[0].name === "Production fetch recovery", label + " Retry publishes the production response");
      production.close();
    }
    check(productionFetchCalls.length === 4 && productionFetchCalls.every(request => request.method === "POST"), "Production client issued exactly two blocked directory requests and two successful retries");
  } finally {
    for (const production of productionHarnesses) production.close();
    await productionClient?.auth.stopAutoRefresh();
    globalThis.fetch = originalFetch;
  }

  const otherDoctor = await harness({ cache: savedCache, identity: { ...validIdentity, authUser: { id: "another-doctor" } } });
  check(otherDoctor.props.patients.length === 0 && otherDoctor.props.loadState === "loading", "Snapshots do not leak between Doctor IDs");
  await otherDoctor.reply([]);
  const emptySnapshot = await harness({ cache: otherDoctor.cache, identity: { ...validIdentity, authUser: { id: "another-doctor" } } });
  check(emptySnapshot.props.loadState === "loaded", "Successful empty snapshot remains a loaded result");
  await emptySnapshot.reply(null, { error: { message: "Empty snapshot refresh failure" } });
  check(emptySnapshot.props.loadState === "loaded", "Refresh failure preserves valid empty snapshot");

  const listProps = { ...mixed.props, searchTerm: "mArIa" };
  check(markup(listProps).includes("Maria Santos") && !markup(listProps).includes(">Null<"), "Search remains case-insensitive");
  const rowKeys = props => nodes(tree(props), node => node.type === "tr" && node.key !== null).map(node => node.key);
  same(rowKeys({ ...listProps, searchTerm: "  mArIa  " }), ["one"], "Outer whitespace trimming preserves matched rows");
  check(markup({ ...listProps, searchTerm: "no-such-patient" }).includes("No patient found."), "Empty search result remains intact");
  same(nodes(tree({ ...mixed.props, searchTerm: "" }), node => node.type === "tr" && node.key !== null).map(node => node.key), ["one", "null"], "Rendered row keys remain database UUIDs");
  mixed.props.onViewRecord("one");
  same(mixed.events[0], { type: "doctor:navigate", detail: {
    section: "medicalRecords", medicalRecordTarget: { patientId: "one", activeTab: "Overview", recordId: "", returnPage: "patients" },
  } }, "View dispatches unchanged selected-patient destination");
  mixed.props.onViewRecord("unknown");
  check(mixed.events.length === 1, "Unknown row cannot dispatch View navigation");

  const dashboardSource = await readFile(new URL("src/pages/doctor/Doctor_Dashboard.jsx", root), "utf8");
  const navigationSource = dashboardSource.slice(dashboardSource.indexOf("const doctorPagePaths"), dashboardSource.indexOf("const dashboardStatusCards")) +
    dashboardSource.slice(dashboardSource.indexOf("const medicalRecordTabParamByLabel"), dashboardSource.indexOf("function getInitials"));
  const searchForTarget = new Function("URLSearchParams", navigationSource + "\nreturn buildDoctorMedicalRecordSearch;")(URLSearchParams);
  check("/doctor" + searchForTarget(mixed.events[0].detail.medicalRecordTarget) === "/doctor?view=patients&tab=overview&patientId=one", "Actual shell serializer preserves exact View URL");

  const aborted = await harness();
  aborted.close(); aborted.directory[0].reject(new Error("Directory rejection after unmount")); await flush();
  check(aborted.cache.size === 0, "Unmounted rejected directory cannot publish/cache results");
  check(aborted.channels.every(channel => !channel.active), "Unmount removes directory subscription");
  const cleanup = await harness({ removeChannelError: new Error("Subscription removal rejection") });
  cleanup.close(); await flush();
  check(cleanup.diagnostics.some(entry => String(entry[0]).includes("subscription")), "Subscription cleanup rejection is handled");

  const styles = await readFile(new URL("src/styles/doctor-patients.css", root), "utf8");
  const newStyles = styles.slice(styles.indexOf("/* Compact request feedback"), styles.indexOf("/* Paint both intentionally"));
  const selectors = [...newStyles.matchAll(/([^{}]+)\{/g)].map(match => match[1].replace(/\/\*[\s\S]*?\*\//g, "").trim());
  check(selectors.length > 0 && selectors.every(selector => selector.startsWith(".doctor-dashboard:not(.staff-dashboard-shell) .doctor-patients-page")), "New error/retry styling excludes Staff");
  const baselineStyles = spawnSync("git", ["show", "HEAD:src/styles/doctor-patients.css"], { cwd: fileURLToPath(root), encoding: "utf8", windowsHide: true });
  assert.equal(baselineStyles.status, 0);
  check(styles.replace(newStyles, "").replace(/\r/g, "") === baselineStyles.stdout.replace(/\r/g, "") || baselineStyles.stdout.replace(/\r/g, "").includes(newStyles.replace(/\r/g, "")), "Existing table/scroll/name/View styles remain unchanged");
  const diff = spawnSync("git", ["diff", "--name-only", "HEAD"], { cwd: fileURLToPath(root), encoding: "utf8", windowsHide: true });
  assert.equal(diff.status, 0);
  const changed = diff.stdout.trim().split(/\r?\n/).filter(Boolean);
  const allowed = new Set([pagePath, "src/styles/doctor-patients.css", "scripts/verify-doctor-patients.mjs"]);
  check(changed.every(path => allowed.has(path)), "Only the three authorized Batch 1 files differ from HEAD");
  check(!changed.some(path => /Doctor_Dashboard|doctor-dashboard|doctorSessionCache/.test(path)), "Doctor Dashboard/cache dependencies untouched");
  check(!changed.some(path => /staff|Staff/.test(path)), "Staff source and styling untouched");
  check(!changed.some(path => /AppointmentVisitForm|StaffPreConsultationForm/.test(path)), "Concurrent appointment form files untouched");
  clearDoctorSessionCaches();
  check(savedCache.size === 0, "Existing session cleanup still clears Patients snapshots");
  check(directoryErrorsBySnapshot.get(failedFirstCache).size === 0, "Existing session cleanup also clears directory errors");
  await new Promise(resolve => setImmediate(resolve));
  check(unhandled.length === 0, "No unhandled page-local promise rejections");
} finally {
  for (const current of liveHarnesses) current.close();
  await flush();
  process.removeListener("unhandledRejection", onUnhandled);
}

console.log(`Doctor Patients Batch 1: ${checks} deterministic assertions passed.`);
