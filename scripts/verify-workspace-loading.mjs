// Offline lifecycle tests: execute the actual loader callbacks with controlled
// read responses. No authentication, backend, clinical writes, or dependencies.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import { parse } from "espree";
import postcss from "postcss";
import { settleQuery } from "../src/lib/settleQuery.js";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
function equal(value, expected, message) { assert.deepEqual(value, expected, message); checks++; }
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function find(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const value of Object.values(node)) {
    if (!value || typeof value !== "object") continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      const result = find(child, predicate);
      if (result) return result;
    }
  }
  return null;
}
async function callback(path, name, overrides = {}) {
  const source = await read(path);
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true }, range: true });
  const declaration = find(ast, node => node.type === "VariableDeclarator" && node.id?.name === name);
  check(declaration, `${name} exists in actual source`);
  const expression = declaration.init.type === "CallExpression" ? declaration.init.arguments[0] : declaration.init;
  const code = source.slice(...expression.range).replaceAll("import.meta.env.DEV", "false");
  const state = { setLoading: true, setForm: { chiefComplaint: "Unfinished clinical work" } };
  const updates = [];
  const context = {
    console: { warn() {}, error() {}, table() {} }, Promise, Map, Set,
    requestIdRef: { current: 0 }, active: true, refreshPromise: null,
    appointmentId: "appointment", requestedType: "initial", visitType: "initial",
    workspace: "doctor", isFollowUp: false, location: { search: "" },
    navigate() {}, logVisitError() {},
    getErrorMessage: (error, fallback) => error?.message || fallback,
    scheduleColumns: "id", patientColumns: "id", recordColumns: "id",
    settleQuery,
  };
  for (const [, setter] of code.matchAll(/\b(set[A-Z]\w*)\(/g)) {
    context[setter] = value => {
      updates.push(setter);
      state[setter] = typeof value === "function" ? value(state[setter]) : value;
    };
  }
  Object.assign(context, overrides);
  const sandbox = vm.createContext(context);
  const run = vm.runInContext(`(${code})`, sandbox);
  return { run, state, updates, context: sandbox };
}
function client(respond) {
  const chain = name => new Proxy({}, {
    get(_, key) {
      if (key === "then") return (resolve, reject) => Promise.resolve().then(() => respond(name)).then(resolve, reject);
      return () => chain(name);
    },
  });
  return { rpc: chain, from: chain };
}
const ok = data => ({ data, error: null });
const networkError = new Error("Synthetic offline request");
const response = ok([]);
equal(await settleQuery(Promise.resolve(response)), response, "normal Supabase result is preserved");
equal((await settleQuery(Promise.reject(networkError))).error, networkError, "rejected reads follow the normal error path");

for (const [file, name] of [["StaffPreConsultationForm", "loadForm"], ["AppointmentVisitForm", "loadVisit"]]) {
  const path = `src/pages/appointments/${file}.jsx`;
  for (const stage of ["routing", "schedule", "details"]) {
    const supabase = client(query => {
      if (query === "get_appointment_visit_form_type") {
        if (stage === "routing") throw networkError;
        return ok({ visit_form_type: "initial" });
      }
      if (query === "schedule") {
        if (stage === "schedule") throw networkError;
        return ok({ id: "appointment", patient_id: "patient" });
      }
      throw networkError;
    });
    const test = await callback(path, name, {
      supabase, loadVisitPatient: () => Promise.reject(networkError),
      loadLatestRegistrationHistory: () => Promise.reject(networkError),
      obstetricHistoryColumns: "id", followUpHistoryColumns: "id",
      medicalHistoryColumns: "id", initialAssessmentColumns: "id",
    });
    await test.run();
    equal(test.state.setLoading, false, `${file}: rejected ${stage} ends loading`);
    check(test.state.setError, `${file}: rejected ${stage} exposes an error`);
    equal(test.state.setForm.chiefComplaint, "Unfinished clinical work", `${file}: failure preserves existing values`);
  }
  const slow = deferred();
  const test = await callback(path, name, { supabase: client(() => slow.promise) });
  const pending = test.run();
  equal(test.state.setLoading, true, `${file}: slow request keeps loading until it settles`);
  test.context.requestIdRef.current++;
  const updates = test.updates.length;
  slow.reject(networkError);
  await pending;
  equal(test.updates.length, updates, `${file}: unmounted/stale rejection cannot update state`);

  const first = deferred(), second = deferred();
  let calls = 0;
  const racing = await callback(path, name, { supabase: client(() => (++calls === 1 ? first.promise : second.promise)) });
  const oldLoad = racing.run();
  await Promise.resolve();
  const newLoad = racing.run();
  await Promise.resolve();
  first.resolve({ data: null, error: networkError });
  await oldLoad;
  equal(racing.state.setLoading, true, `${file}: stale completion cannot dismiss the new loader`);
  second.resolve({ data: null, error: networkError });
  await newLoad;
  equal(racing.state.setLoading, false, `${file}: latest error ends loading`);
}

const staffPath = "src/pages/staff/Staff_Appointments.jsx";
const staffContext = {
  supabase: client(() => { throw networkError; }),
  appointmentsRequestRef: { current: null }, appointmentsEpochRef: { current: 1 },
  scheduleTableName: "schedule", scheduleColumns: "id",
  mapScheduleToAppointment: row => row, mapScheduleToCalendarEvent: row => row,
};
const staff = await callback(staffPath, "loadAppointments", staffContext);
const failed = await staff.run();
equal(failed.ok, false, "Staff appointments report rejection");
equal(staff.state.setIsLoadingAppointments, false, "Staff appointments stop loading on rejection");
check(staff.state.setAppointmentsLoadError, "Staff appointments expose retryable load error");
equal(staff.context.appointmentsRequestRef.current, null, "Staff appointment lock is released after failure");
staff.context.supabase = client(() => ok([]));
equal((await staff.run()).ok, true, "Staff appointments recover without remount or reload");
equal(staff.state.setAppointments.length, 0, "Staff empty dataset completes as empty");
equal(staff.state.setAppointmentsLoadError, "", "Staff retry clears the load error");
const delayedList = deferred();
staff.context.supabase = client(() => delayedList.promise);
const listLoad = staff.run(), repeatedLoad = staff.run();
equal(listLoad, repeatedLoad, "concurrent Staff refreshes reuse the pending request");
const beforeStaleList = staff.updates.length;
staff.context.appointmentsEpochRef.current++;
delayedList.resolve(ok([]));
await listLoad;
equal(staff.updates.length, beforeStaleList, "Staff navigation invalidates late list results");

const dashboard = await callback("src/pages/staff/StaffDashboard.jsx", "loadDashboardStats", {
  supabase: client(() => { throw networkError; }), dashboardSnapshotRef: { current: null },
  staffDashboardScheduleColumns: "id",
});
await dashboard.run();
equal(dashboard.state.setIsLoadingDashboard, false, "Staff dashboard rejection ends loading");
check(dashboard.state.setDashboardMessage, "Staff dashboard rejection shows error");
equal(dashboard.context.refreshPromise, null, "Staff dashboard lock clears on failure");
Object.assign(dashboard.context, {
  supabase: client(() => ok([])), emptyStaffDashboardStats: {},
  compareUpcomingAppointments: () => 0, fetchDashboardPatientAvatarMap: async () => new Map(),
  mapUpcomingSession: row => row, staffUserId: "staff", setStaffSessionSnapshot() {},
});
await dashboard.run();
equal(dashboard.state.setDashboardStats.totalPatients, 0, "empty Staff dashboard finishes with zero patients");
equal(dashboard.state.setDashboardMessage, "", "Staff dashboard retry recovers from rejection");

const profile = await callback("src/pages/staff/Staff_ViewProfile.jsx", "loadStaffProfile", {
  cachedStaffProfile: {}, profileRequestRef: { current: 0 },
  supabase: { auth: { getUser: () => Promise.reject(networkError) } },
});
await profile.run();
equal(profile.state.setLoadingProfile, false, "Staff profile auth rejection ends loading");
check(profile.state.setProfileError, "Staff profile auth rejection exposes error");
const slowProfile = deferred();
profile.context.supabase.auth.getUser = () => slowProfile.promise;
const profileLoad = profile.run();
profile.context.profileRequestRef.current++;
const profileUpdates = profile.updates.length;
slowProfile.resolve({ data: { user: null }, error: networkError });
await profileLoad;
equal(profile.updates.length, profileUpdates, "Staff profile navigation ignores late auth responses");

const recordPath = "src/pages/doctor/Doctor_Medical_Records.jsx";
for (const name of ["loadMedicalRecords", "loadPrenatalDetails"]) {
  const ref = name === "loadMedicalRecords" ? "medicalRecordRequestRef" : "prenatalRequestRef";
  const flag = name === "loadMedicalRecords" ? "setIsLoadingRecords" : "setIsLoadingPrenatalDetails";
  const test = await callback(recordPath, name, {
    supabase: client(() => { throw networkError; }), [ref]: { current: 0 }, medicalRecordColumns: "id",
  });
  await test.run({ id: "patient" });
  equal(test.state[flag], false, `${name}: rejection ends loading`);
  check(test.state.setMedicalRecordsError || test.state.setPrenatalDetailsError, `${name}: rejection exposes error`);
}
const medical = await callback(recordPath, "loadMedicalRecords", {
  supabase: client(() => ok([])), medicalRecordRequestRef: { current: 0 },
  medicalRecordColumns: "id", focusedRecordIdRef: { current: "" },
  isCompletedClinicalVisitRecord: () => true, onRecordSelectRef: { current: null },
});
equal((await medical.run({ id: "patient" })).length, 0, "empty Doctor records finish normally");
equal(medical.state.setIsLoadingRecords, false, "empty Doctor records stop loading");
const staleRecord = deferred();
medical.context.supabase = client(() => staleRecord.promise);
const recordLoad = medical.run({ id: "old-patient" });
medical.context.medicalRecordRequestRef.current++;
const beforeRecord = medical.updates.length;
staleRecord.reject(networkError);
await recordLoad;
equal(medical.updates.length, beforeRecord, "late Doctor record failure cannot overwrite another patient");
const patientRead = await callback(recordPath, "loadPatient", {
  supabase: client(() => { throw networkError; }), patientRequestRef: { current: 0 },
  selectedInitialPatientRef: { current: { id: "patient" } },
  focusedRecordIdRef: { current: "" }, doctorProfileCacheRef: { current: new Map() },
  patientSelectColumns: "id",
});
await patientRead.run();
equal(patientRead.state.setIsLoadingPatient, false, "Doctor patient verification rejection ends loading");
equal(patientRead.state.setIsLoadingPatientRelated, false, "Doctor patient verification failure ends related loading");
equal(patientRead.state.setIsLoadingRecords, false, "switching patients resets the previous record loader");
equal(patientRead.state.setIsLoadingPrenatalDetails, false, "switching patients resets the previous prenatal loader");
check(patientRead.state.setPatientLoadError, "Doctor patient verification failure exposes an error");

// Source contracts cover unchanged security/workflow code and exact Patient
// startup design extraction; live viewport rendering remains a browser check.
const original = path => execFileSync("git", ["show", `HEAD:${path}`], { encoding: "utf8", windowsHide: true }).replaceAll("\r\n", "\n");
const staffFormPath = "src/pages/appointments/StaffPreConsultationForm.jsx";
for (const name of ["saveForm", "normalizeLoadedForm", "validateStaffIntake"]) {
  const select = source => {
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true }, range: true });
    const node = find(ast, node => ["VariableDeclarator", "FunctionDeclaration"].includes(node.type) && node.id?.name === name);
    return source.slice(...node.range).replaceAll("\r\n", "\n");
  };
  equal(select(await read(staffFormPath)), select(original(staffFormPath)), `Staff ${name}: clinical workflow is unchanged`);
}
for (const path of ["src/hooks/useAuthenticatedStaff.js", "src/hooks/useAuthenticatedDoctor.js", "src/hooks/useDoctorRouteAuthorization.js", "src/pages/doctor/Doctor_Reminder.jsx", "src/pages/doctor/Doctor_Patients.jsx"]) {
  equal((await read(path)).replaceAll("\r\n", "\n"), original(path), `${path}: existing lifecycle/security/skeletons are unchanged`);
}
const oldCss = postcss.parse(original("src/styles/patient-PWA.css"));
const newCss = postcss.parse(await read("src/styles/workspace-loading.css"));
function declaration(css, selector, property) {
  let result;
  css.walkRules(selector, rule => rule.walkDecls(property, decl => { result = decl.value.replace(/\s*!important$/, ""); }));
  return result;
}
equal(declaration(newCss, ".maternal-workspace-loading-card", "gap"), declaration(oldCss, ".pwa-loading-card", "gap"), "Patient card spacing is preserved");
equal(declaration(newCss, ".maternal-workspace-loading-card", "font-weight"), declaration(oldCss, ".pwa-loading-card", "font-weight"), "Patient card font weight is preserved");
equal(declaration(newCss, ".maternal-workspace-loading-card", "color"), declaration(oldCss, ":root", "--pwa-pink"), "Patient pink is preserved");
equal(declaration(newCss, ".maternal-workspace-loading", "background"), declaration(oldCss, ":root", "--pwa-bg"), "Patient background is preserved");
const screen = await read("src/components/common/WorkspaceLoadingScreen.jsx");
check(screen.includes('role="status"') && screen.includes('decorative variant="status"'), "shared startup uses the same accessible branding");
check(screen.includes('message = "Maternal Care"'), "startup uses the requested Maternal Care label");
const patientSource = await read("src/pages/patient/Patient_PWA.jsx");
check(patientSource.includes('<WorkspaceLoadingScreen message={patientLoadingMessage} />'), "Patient consumes the shared startup component");
const app = await read("src/App.jsx");
check(!app.includes("admin-auth-state"), "Staff startup no longer depends on Admin auth styling");
check(app.includes("doctorAccess.loading && !doctorAccess.authorized") && app.includes("staffAccess.loading && !staffAccess.identity"), "background auth checks keep the authorized workspaces mounted");
console.log(`PASS: ${checks} workspace loading checks (offline; no backend writes).`);
