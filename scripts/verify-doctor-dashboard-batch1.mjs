import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import process from "node:process";
import * as vm from "node:vm";
import { createClient } from "@supabase/supabase-js";
import { transformWithOxc } from "vite";
import { fetchDoctorDashboardSchedule, isDoctorDashboardActiveStatus } from "../src/lib/doctorDashboardSchedule.js";
import * as dates from "../src/lib/appointmentDate.js";

if (!vm.SourceTextModule) {
  const run = spawnSync(process.execPath, ["--experimental-vm-modules", ...process.argv.slice(1)], { stdio: "inherit", windowsHide: true });
  if (run.error) throw run.error;
  process.exit(run.status ?? 1);
}

let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const equal = (actual, expected, message) => { assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message); checks++; };
const rejects = async (work, pattern) => { await assert.rejects(work, error => pattern.test(error.message || String(error))); checks++; };
const doctorA = "10000000-0000-4000-8000-000000000001";
const doctorB = "10000000-0000-4000-8000-000000000002";
const patientA = "20000000-0000-4000-8000-000000000001";
const patientB = "20000000-0000-4000-8000-000000000002";
const uuid = n => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const row = (n, status = "scheduled", start = "2026-10-09T13:00:00+08:00", end = start, doctor = doctorA) => ({
  id: uuid(n), doctor_id: doctor, patient_id: n % 2 ? patientA : patientB,
  maternal_appointment_id: "MA-" + n, patient_name: "Synthetic Patient " + n,
  start_time: start, end_time: end, status,
});
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

// Exercise the installed Supabase SDK over a fetch mock. No live endpoint or
// credentials are used. The mock evaluates PostgREST filters independently.
function splitExpressions(value) {
  let depth = 0, begin = 0;
  const parts = [];
  for (let n = 0; n < value.length; n++) {
    if (value[n] === "(") depth++;
    if (value[n] === ")") depth--;
    if (value[n] === "," && depth === 0) { parts.push(value.slice(begin, n)); begin = n + 1; }
  }
  parts.push(value.slice(begin));
  return parts;
}
function matches(expression, item) {
  const group = /^(and|or)\((.*)\)$/.exec(expression);
  if (group) {
    const values = splitExpressions(group[2]).map(part => matches(part, item));
    return group[1] === "and" ? values.every(Boolean) : values.some(Boolean);
  }
  const atom = /^(\w+)\.(eq|gt|is)\.(.*)$/.exec(expression);
  assert.ok(atom, "Unsupported mocked PostgREST expression: " + expression);
  const [, field, operator, wanted] = atom;
  const actual = item[field];
  if (operator === "is") return wanted === "null" && actual == null;
  if (actual == null) return false;
  const left = field === "start_time" ? Date.parse(actual) : String(actual);
  const right = field === "start_time" ? Date.parse(wanted) : wanted;
  return operator === "eq" ? left === right : left > right;
}
function mockDatabase(rows, serverLimit = 2) {
  const control = { rows, serverLimit, failAt: 0, rejectAt: 0, beforePage: null, transformPage: null, patientCount: 12 };
  const scheduleCalls = [], rpcCalls = [];
  let running = 0, maxRunning = 0;
  const fetch = async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.endsWith("/rpc/get_doctor_patient_directory")) {
      rpcCalls.push(url);
      check(options.method === "HEAD" && url.searchParams.get("status") === "ilike.active", "patient count retains exact HEAD/active filtering");
      return new Response(null, { status: 200, headers: { "content-range": "*/" + control.patientCount } });
    }
    check(url.pathname === "/rest/v1/schedule", "only the existing schedule table is queried");
    check(["eq." + doctorA, "eq." + doctorB].includes(url.searchParams.get("doctor_id")), "every page has an explicit Doctor scope");
    check(url.searchParams.get("order") === "start_time.asc.nullslast,id.asc", "database ordering includes the unique ID tie-breaker and explicit null ordering");
    check(url.searchParams.get("limit") === "500", "page request remains bounded");
    const call = { url, ordinal: scheduleCalls.length + 1, size: null };
    scheduleCalls.push(call);
    running++; maxRunning = Math.max(maxRunning, running);
    try {
      await control.beforePage?.(call);
      if (call.ordinal === control.rejectAt) throw Object.assign(new Error("Synthetic page cancellation"), { name: "AbortError" });
      if (call.ordinal === control.failAt) {
        return new Response(JSON.stringify({ message: "Synthetic later-page failure", code: "XX000", details: null, hint: null }), { status: 500 });
      }
      const filtered = control.rows.filter(item => Array.from(url.searchParams).every(([key, value]) => {
        if (["select", "order", "limit"].includes(key)) return true;
        if (key === "or") return matches("or" + value, item);
        return matches(key + "." + value, item);
      }));
      filtered.sort((first, second) => {
        for (const term of url.searchParams.get("order").split(",")) {
          const [field] = term.split(".");
          const a = first[field], b = second[field];
          if (a == null && b == null) continue;
          if (a == null) return 1;
          if (b == null) return -1;
          const left = field === "start_time" ? Date.parse(a) : a;
          const right = field === "start_time" ? Date.parse(b) : b;
          if (left < right) return -1;
          if (left > right) return 1;
        }
        return 0;
      });
      let page = filtered.slice(0, Math.min(control.serverLimit, Number(url.searchParams.get("limit"))));
      if (control.transformPage) page = control.transformPage(call, page);
      call.size = page?.length ?? null;
      return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
    } finally { running--; }
  };
  const client = createClient("https://dashboard.example.test", "synthetic-anon-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch },
  });
  return { client, control, scheduleCalls, rpcCalls, get maxRunning() { return maxRunning; } };
}

for (const [count, cap, sizes] of [
  [0, 2, [0]], [1, 2, [1, 0]], [2, 2, [2, 0]], [3, 2, [2, 1, 0]], [4, 2, [2, 2, 0]],
  [501, 128, [128, 128, 128, 117, 0]], [1000, 500, [500, 500, 0]], [1001, 500, [500, 500, 1, 0]],
]) {
  const ownRows = Array.from({ length: count }, (_, n) => row(n + 1));
  const db = mockDatabase([...ownRows].reverse().concat(row(9001, "scheduled", undefined, undefined, doctorB)), cap);
  const result = await fetchDoctorDashboardSchedule(db.client, doctorA);
  equal(result.data.map(item => item.id), ownRows.map(item => item.id), "all same-time appointments survive the page boundaries: " + count);
  equal(db.scheduleCalls.map(call => call.size), sizes, "short and exact pages always terminate through an empty page: " + count);
  check(db.scheduleCalls.every(call => call.url.searchParams.get("doctor_id") === "eq." + doctorA), "other Doctor rows stay excluded");
  check(db.maxRunning === 1, "schedule pages are fetched serially");
}
{
  const dated = [row(1, "completed", "2026-09-01T10:00:00Z"), row(2, "scheduled", "2026-10-09T05:00:00Z"), row(3, "scheduled", "2026-10-09T13:00:00+08:00")];
  const undated = [row(4, "completed", null), row(5, "done", null), row(6, "scheduled", null)];
  const db = mockDatabase([...undated, ...dated].reverse(), 2);
  const result = await fetchDoctorDashboardSchedule(db.client, doctorA);
  equal(result.data.map(item => item.id), [1, 2, 3, 4, 5, 6].map(uuid), "UTC/offset ties and null timestamp tail are complete and ordered");
  check(db.scheduleCalls.some(call => call.url.searchParams.get("start_time") === "is.null" && call.url.searchParams.has("id")), "null tail uses a stable ID cursor");
}
{
  const db = mockDatabase(Array.from({ length: 5 }, (_, n) => row(n + 1)), 2);
  db.control.transformPage = (call, page) => {
    if (call.ordinal === 1) return [...page, page.at(-1)];
    if (call.ordinal === 2) return [{ ...row(1), patient_name: "Fresh repeated patient" }, ...page];
    return page;
  };
  const result = await fetchDoctorDashboardSchedule(db.client, doctorA);
  equal(result.data.map(item => item.id), [1, 2, 3, 4, 5].map(uuid), "repeated IDs within and across pages cannot inflate appointments");
  check(result.data[0].patient_name === "Fresh repeated patient", "latest observed duplicate fields replace older fields");
}
{
  const db = mockDatabase([row(1), row(2), row(3)]);
  db.control.transformPage = call => call.ordinal <= 2 ? [row(1), row(2)] : [];
  await rejects(fetchDoctorDashboardSchedule(db.client, doctorA), /did not advance/);
  check(db.scheduleCalls.length === 2, "non-advancing repeated page fails instead of looping or claiming completion");
}
for (const failure of ["failAt", "rejectAt"]) {
  const db = mockDatabase([row(1), row(2), row(3)]); db.control[failure] = 2;
  await rejects(fetchDoctorDashboardSchedule(db.client, doctorA), failure === "failAt" ? /Synthetic later-page failure/ : /Synthetic page cancellation/);
  check(db.scheduleCalls.length === 2, "later-page failure stops pagination: " + failure);
}
{
  const db = mockDatabase([row(1)]);
  db.control.transformPage = () => [{ start_time: null }];
  await rejects(fetchDoctorDashboardSchedule(db.client, doctorA), /missing its schedule ID/);
  await rejects(fetchDoctorDashboardSchedule(db.client, ""), /Doctor ID is required/);
  check(db.scheduleCalls.length === 1, "missing Doctor identity never starts an unscoped fetch");
  equal(await fetchDoctorDashboardSchedule(db.client, doctorA, () => false), { data: null, error: null }, "already stale request has no publishable result");
  check(db.scheduleCalls.length === 1, "already stale request starts no pages");
}
for (const status of ["scheduled", "pending", "accepted", " SCHEDULED ", "checked_in", "checked-in", "check_in", "checkedin"]) check(isDoctorDashboardActiveStatus(status), "active status alias qualifies: " + status);
for (const status of ["completed", "complete", "done", "cancelled", "canceled", "cancel", "missed", "no_show", "no-show", "noshow", "absent", "archived", "deleted", "future_status"]) check(!isDoctorDashboardActiveStatus(status), "non-active status is excluded: " + status);

const source = await readFile(new URL("../src/pages/doctor/Doctor_Dashboard.jsx", import.meta.url), "utf8");
async function load(code, name, imports = {}, extra = {}) {
  const context = vm.createContext({ console, URLSearchParams, ...extra });
  const transformed = (await transformWithOxc(code, name, { jsx: { runtime: "automatic", development: false } })).code;
  const module = new vm.SourceTextModule(transformed, { context, initializeImportMeta: meta => { meta.env = { DEV: false }; } });
  await module.link(spec => {
    assert.ok(Object.hasOwn(imports, spec), "Unexpected test import: " + spec);
    const values = imports[spec];
    return new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context });
  });
  await module.evaluate(); return module.namespace;
}
const beginLoader = "  const loadDashboardStats = useCallback(async () => {";
const endLoader = "  }, [authenticatedDoctorId]);";
const loaderBody = source.slice(source.indexOf(beginLoader), source.indexOf(endLoader) + endLoader.length)
  .replace(beginLoader, "export async function loadDashboardStats() {").replace(endLoader, "}");
const mapper = await load('import {formatAppointmentDate,formatAppointmentTime} from "dates";\n'
  + source.slice(source.indexOf("function getInitials("), source.indexOf("async function fetchDashboardPatientAvatarMap("))
  + source.slice(source.indexOf("function mapUpcomingSession("), source.indexOf("function ProfileDropdown("))
  + '\nexport {mapUpcomingSession};', "dashboard-mapper.js", { dates });
let now = "2026-10-09T12:00:00+08:00";
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } }
async function productionLoader(db) {
  const scaffold = `import {supabase} from "db"; import {fetchDoctorDashboardSchedule,isDoctorDashboardActiveStatus,appointmentStatuses,normalizeAppointmentStatus,classifyAppointment,compareUpcomingAppointments,mapUpcomingSession,fetchDashboardPatientAvatarMap} from "dependencies";
let authenticatedDoctorId="${doctorA}"; const dashboardStatsRequestRef={current:0}; const dashboardSessionsRef={current:null}; const doctorDashboardSnapshots=new Map();
export const observed={metricUpdates:0,sessionUpdates:0};
const setDashboardStats=value=>{observed.stats=value;observed.metricUpdates++;}; const setDashboardStatsResolved=value=>observed.statsResolved=value; const setDashboardFailed=value=>observed.failed=value; const setDashboardMessage=value=>observed.message=value;
const setUpcomingSessions=value=>{observed.sessions=typeof value==="function"?value(observed.sessions):value;observed.sessionUpdates++;}; const setSessionsResolved=value=>observed.sessionsResolved=value;
export function invalidateDoctor(id) {authenticatedDoctorId=id;dashboardStatsRequestRef.current++;} export function snapshot(id="${doctorA}") {return doctorDashboardSnapshots.get(id);} `;
  return load(scaffold + loaderBody, "dashboard-batch1-loader.js", {
    db: { supabase: db.client }, dependencies: { ...dates, fetchDoctorDashboardSchedule, isDoctorDashboardActiveStatus, mapUpcomingSession: mapper.mapUpcomingSession, fetchDashboardPatientAvatarMap: async () => new Map() },
  }, { Date: FixedDate });
}
const fixtures = [
  row(1, "completed", "2026-09-01T09:00:00+08:00"), row(2, " done ", "2026-09-02T09:00:00+08:00"), row(3, "complete", "2026-09-03T09:00:00+08:00"), row(4, "completed", "2026-10-09T09:00:00+08:00"), row(5, "completed", null),
  row(41, "scheduled", "2026-10-09T11:30:00+08:00", "2026-10-09T12:30:00+08:00"),
  row(42, "checked_in", "2026-10-09T11:45:00+08:00", "2026-10-09T12:45:00+08:00"),
  row(43, "pending", "2026-10-09T12:00:00+08:00", "2026-10-09T12:30:00+08:00"),
  row(44, "check-in", "2026-10-09T11:00:00+08:00", "2026-10-09T12:00:00+08:00"),
  row(45, "accepted"), row(46, "scheduled", "2026-10-10T00:00:00+08:00"),
  row(47, "checked-in", "2026-10-09T10:00:00+08:00", "2026-10-09T10:30:00+08:00"),
  ...["cancelled", "canceled", "missed", "no_show", "absent", "archived", "deleted", "future_status"].map((status, n) => row(50 + n, status)),
  row(900, "completed", undefined, undefined, doctorB),
];
{
  const db = mockDatabase(fixtures, 3), loader = await productionLoader(db);
  await loader.loadDashboardStats();
  equal(loader.observed.stats, { totalPatients: 12, todaysAppointments: 5, completedSessions: 5, completionProgress: 7 }, "all-time completion and original daily progress use the complete schedule");
  equal(loader.observed.sessions.map(item => item.id), [44, 41, 42, 43].map(uuid), "only four eligible future/current rows appear in chronological order");
  check(loader.observed.sessions.every(item => [patientA, patientB].includes(item.patientId)), "session mapping preserves the authoritative patient UUID");
  equal(loader.snapshot().upcomingSessions, loader.observed.sessions, "complete successful result is cached");
  check(dates.classifyAppointment(row(999, "archived"), new Date(now)).isUpcoming, "shared appointment classification remains unchanged");
  check(dates.classifyAppointment(fixtures.find(item => item.id === uuid(47)), new Date(now)).category === "checked_in", "elapsed check-in retains the existing workflow semantics");
  db.control.rows = [row(101, "scheduled"), row(102, "completed"), row(103, "scheduled")];
  const prior = { stats: loader.observed.stats, sessions: loader.observed.sessions, snapshot: loader.snapshot(), metrics: loader.observed.metricUpdates, updates: loader.observed.sessionUpdates };
  db.control.failAt = db.scheduleCalls.length + 2;
  await loader.loadDashboardStats();
  check(loader.observed.failed && loader.observed.message === "Unable to refresh the dashboard. Please try again later.", "later-page failure uses the existing safe Dashboard error state");
  check(loader.observed.stats === prior.stats && loader.observed.sessions === prior.sessions && loader.snapshot() === prior.snapshot, "failed pagination preserves the last successful metrics, sessions and snapshot");
  check(loader.observed.metricUpdates === prior.metrics && loader.observed.sessionUpdates === prior.updates, "no partial totals or session rows publish after later-page failure");
  db.control.failAt = 0; await loader.loadDashboardStats();
  check(!loader.observed.failed && loader.observed.stats.completedSessions === 1, "next complete refresh recovers through the existing loader");
}
{
  const db = mockDatabase([row(1), row(2), row(3)]), loader = await productionLoader(db);
  db.control.failAt = 2; await loader.loadDashboardStats();
  check(loader.observed.failed && !loader.observed.statsResolved && !loader.observed.sessionsResolved && !loader.snapshot(), "failed initial pagination never claims complete or empty results");
}
{
  const db = mockDatabase([]), loader = await productionLoader(db); await loader.loadDashboardStats();
  equal(loader.observed.stats, { totalPatients: 12, todaysAppointments: 0, completedSessions: 0, completionProgress: 0 }, "empty schedule keeps the clinic patient count and zero appointment metrics");
  equal(loader.observed.sessions, [], "empty successful schedule resolves to no sessions");
}
{
  const midnightRows = [
    row(1, "scheduled", "2026-10-08T23:59:00+08:00", "2026-10-09T00:01:00+08:00"),
    row(2, "scheduled", "2026-10-08T16:00:00Z", "2026-10-09T00:30:00+08:00"),
    row(3, "done", "2026-10-09T00:00:00+08:00"), row(4, "completed", "2026-10-08T23:59:59+08:00"),
    row(5, "archived", "2026-10-09T00:00:00+08:00"),
  ];
  for (const [instant, today, progress] of [["2026-10-08T23:59:59.999+08:00", 1, 50], ["2026-10-09T00:00:00+08:00", 1, 33]]) {
    now = instant; const db = mockDatabase(midnightRows, 1), loader = await productionLoader(db); await loader.loadDashboardStats();
    equal(loader.observed.stats, { totalPatients: 12, todaysAppointments: today, completedSessions: 2, completionProgress: progress }, "Manila midnight retains completed/progress semantics: " + instant);
    equal(loader.observed.sessions.map(item => item.id), [1, 2].map(uuid), "midnight list excludes unsupported future status");
  }
  now = "2026-10-09T12:00:00+08:00";
}

const coordinator = await load(source.slice(source.indexOf("function createDashboardRefreshCoordinator()"), source.indexOf("const navItems")) + '\nexport {createDashboardRefreshCoordinator};', "dashboard-coordinator.js");
{
  const db = mockDatabase([row(1), row(2), row(3), row(4), row(5)]), loader = await productionLoader(db);
  const started = deferred(), release = deferred();
  db.control.beforePage = async call => { if (call.ordinal === 2) { started.resolve(); await release.promise; } };
  const refresh = coordinator.createDashboardRefreshCoordinator(), scope = refresh.activate(loader.loadDashboardStats);
  const work = scope.request(); await started.promise;
  check(!loader.observed.statsResolved && !loader.observed.sessionsResolved && !loader.snapshot(), "pending later page retains initial loading without publishing partial rows");
  for (let n = 0; n < 10; n++) check(scope.request() === work, "concurrent triggers reuse the existing refresh lock");
  check(db.scheduleCalls.length === 2, "no duplicate page-fetch sequence starts while a page is pending");
  release.resolve(); await work;
  const firstPages = db.scheduleCalls.filter(call => !call.url.searchParams.has("or") && !call.url.searchParams.has("start_time"));
  check(firstPages.length === 2 && db.rpcCalls.length === 2, "concurrent triggers coalesce into one trailing full refresh");
  check(db.maxRunning === 1 && loader.observed.metricUpdates === 2, "refresh serialization survives multi-page schedules"); scope.stop();
}
for (const sessionChange of [false, true]) {
  const db = mockDatabase([row(1), row(2), row(3), row(101, "scheduled", undefined, undefined, doctorB)]), loader = await productionLoader(db);
  const started = deferred(), release = deferred();
  db.control.beforePage = async call => { if (call.ordinal === 2) { started.resolve(); await release.promise; } };
  const refresh = coordinator.createDashboardRefreshCoordinator(), oldScope = refresh.activate(loader.loadDashboardStats);
  const work = oldScope.request(); await started.promise; oldScope.request();
  oldScope.stop(); loader.invalidateDoctor(sessionChange ? doctorB : "");
  let newScope;
  if (sessionChange) { newScope = refresh.activate(loader.loadDashboardStats); newScope.request(); }
  check(db.scheduleCalls.length === 2, "session/unmount cleanup keeps an in-flight sequence serialized");
  release.resolve(); await work;
  check(!loader.snapshot(doctorA), "late old Doctor pages cannot write an old or new cache snapshot");
  check(oldScope.request() === undefined, "stopped component callbacks cannot restart pagination");
  if (sessionChange) {
    equal(loader.observed.sessions.map(item => item.id), [uuid(101)], "replacement Doctor receives only their own fresh session");
    check(loader.snapshot(doctorB) && !loader.observed.failed, "replacement Doctor has an isolated successful snapshot"); newScope.stop();
  } else {
    check(db.scheduleCalls.length === 2 && loader.observed.metricUpdates === 0 && loader.observed.sessionUpdates === 0, "unmount invalidation prevents further pages and state/cache publication");
  }
}

// Execute the actual Dashboard action and existing record-routing helper.
const openStart = "  const openMedicalRecordTarget = useCallback((target, options = {}) => {";
const openEnd = "  }, [activePage, medicalRecordTarget?.returnPage, navigate]);";
const openBody = source.slice(source.indexOf(openStart), source.indexOf(openEnd) + openEnd.length)
  .replace(openStart, "export function openMedicalRecordTarget(target, options = {}) {").replace(openEnd, "}");
const routes = await load(source.slice(source.indexOf("const doctorPagePaths"), source.indexOf("function getInitials("))
  + '\nlet activePage="dashboard", medicalRecordTarget=null; export const observed={}; const preloadDoctorSection=()=>{}; const setDoctorPatientHeaderAction=()=>{}; const startTransition=fn=>fn(); const setMedicalRecordTarget=value=>{medicalRecordTarget=value;observed.target=value;}; const setActivePage=value=>{activePage=value;}; const navigate=(destination,options)=>{observed.destination=destination;observed.options=options;};\n'
  + openBody + '\nexport {getMedicalRecordTargetFromSearch,getInitialDoctorPage};', "dashboard-routing.js");
const jsx = (type, props, key) => ({ type, props: props || {}, key });
const home = await load('import {useState,useCallback} from "react"; import {Icon} from "icon"; import ProfileAvatarContent from "avatar"; import DashboardSessionActions from "menu";\n'
  + source.slice(source.indexOf("const dashboardStatusCards"), source.indexOf("const medicalRecordTabParamByLabel"))
  + source.slice(source.indexOf("function DashboardHome"), source.indexOf("function Doctor_Dashboard")).replace("function DashboardHome", "export default function DashboardHome"), "dashboard-batch1-home.jsx", {
  react: { useState: value => [value, () => {}], useCallback: callback => callback }, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
  icon: { Icon: () => null }, avatar: { default: () => null }, menu: { default: () => null },
});
function nodes(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => nodes(child, predicate));
  if (!node || typeof node !== "object") return [];
  return [...(predicate(node) ? [node] : []), ...nodes(node.props?.children, predicate)];
}
for (const [patientId, appointmentId] of [[patientA, "MA special / ? &"], [patientB, "MA ID not assigned"]]) {
  let appointmentDestination;
  const session = { id: uuid(77), patientId, appointmentId, patient: "Synthetic Patient", date: "Oct 09, 2026", time: "1:00 PM" };
  const tree = home.default({ setActivePage: (page, options) => { appointmentDestination = { page, options }; }, onOpenMedicalRecord: routes.openMedicalRecordTarget,
    dashboardStats: {}, upcomingSessions: [session], sessionsState: "data", accountName: "Synthetic Doctor" });
  const actions = nodes(tree, node => node.props.role === "menuitem");
  check(actions.length === 2, "each selected patient has appointment and record actions"); actions[0].props.onClick();
  equal(appointmentDestination, { page: "appointments", options: { path: "/doctor/appointments?appointmentId=" + encodeURIComponent(appointmentId === "MA ID not assigned" ? session.id : appointmentId) } }, "View Appointment retains its exact encoded MA/UUID destination");
  actions[1].props.onClick();
  equal(routes.observed.target, { patientId, activeTab: "Overview", recordId: "", returnPage: "dashboard" }, "View Patient selects the authoritative UUID and Overview without a stale record ID");
  equal(routes.observed.destination, { pathname: "/doctor", search: "?view=dashboard&tab=overview&patientId=" + patientId }, "View Patient reuses the exact medical-record route");
  equal(routes.getMedicalRecordTargetFromSearch(routes.observed.destination.search), routes.observed.target, "record deep link round-trips the patient and Dashboard return target");
  check(routes.getInitialDoctorPage("/doctor", routes.observed.destination.search) === "medicalRecords", "deep-link reload opens Medical Records rather than the directory");
  check(routes.observed.options.replace === false, "record navigation preserves browser Back behavior");
}
{
  const tree = home.default({ setActivePage: () => {}, onOpenMedicalRecord: () => { throw new Error("No patient should open"); }, dashboardStats: {}, upcomingSessions: [{ id: uuid(78), patientId: "", appointmentId: "MA-78" }], sessionsState: "data" });
  check(nodes(tree, node => node.props.role === "menuitem").length === 1, "missing patient UUID cannot open a generic or incorrect patient record");
}
check(source.includes("onOpenMedicalRecord={openMedicalRecordTarget}"), "Dashboard binds the patient action to the existing authorized shell routing helper");
check(source.includes('initialPatient={medicalRecordTarget?.patientId ? { id: medicalRecordTarget.patientId } : null}') && source.includes('onBackToPatients={() => navigateDoctorPage(medicalRecordTarget?.returnPage || "patients")}'), "record selection and Dashboard return use the existing medical-record integration");

console.log("Doctor Dashboard Batch 1 regression: " + checks + " assertions passed (mocked Supabase SDK, pagination, counters, navigation, concurrency and cleanup; no live/runtime validation).");
