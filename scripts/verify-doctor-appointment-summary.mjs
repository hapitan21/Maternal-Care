/* global process */
// Run: node scripts/verify-doctor-appointment-summary.mjs
// Actual summary, report JSX, tab JSX, hook and print helper; synthetic patient data only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as vm from "node:vm";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithOxc } from "vite";
import * as dates from "../src/lib/appointmentDate.js";
import { resolveCurrentPregnancyWeek } from "../src/lib/pregnancyTracking.js";
import { isCompletedClinicalVisitRecord } from "../src/lib/clinicalVisitData.js";
import { buildDoctorAppointmentSummary } from "../src/lib/doctorAppointmentSummary.js";
import { printReport, formatReportTimestamp } from "../src/lib/reportExport.js";

if (!vm.SourceTextModule) {
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", ...process.argv.slice(1)], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
const root = new URL("../", import.meta.url);
let checks = 0;
const check = (ok, message) => { assert.ok(ok, message); checks++; };
const now = new Date("2026-10-03T03:00:00Z");
const row = (id, status, start = "2026-10-02T02:00:00Z") => ({ id, patient_id: "synthetic-a", status, start_time: start, end_time: start, title: "Synthetic appointment" });
const metrics = summary => Object.fromEntries(summary.metrics.map(metric => [metric.label, metric.value]));
const rows = [row("1", "done"), row("2", "canceled"), row("3", "no-show"), row("4", "pending"), row("5", "checked_in"),
  row("6", "accepted", "2027-10-03T04:00:00Z"), row("7", "scheduled", "invalid")];
const visitRecord = (scheduleId, age, patientId = "synthetic-a", extra = {}) => ({
  id: "record-" + scheduleId, patient_id: patientId, schedule_id: scheduleId,
  form_data: { recordStatus: "completed", gestationalAge: age, ...extra },
});
const visitRecords = [visitRecord("1", 17), visitRecord("2", "19 weeks 3 days"),
  visitRecord("6", "22 Weeks", "synthetic-a", { recordStatus: "draft" })];
const summary = buildDoctorAppointmentSummary(rows, now, { medicalRecords: visitRecords, patientId: "synthetic-a" });
assert.deepEqual(metrics(summary), { "Total Visits": "7", Completed: "1", Upcoming: "1", "Missed / Cancelled": "3", "Attendance Rate": "25%" }); checks++;
check(summary.additionalNote.includes("1 checked-in awaiting completion") && summary.additionalNote.includes("1 with unavailable dates"), "unrepresented buckets explain the total gap without reclassification");
check(summary.historyAppointments.length === 7 && rows.every(row => !row.classification), "one complete history without mutating source rows");
for (const status of ["scheduled", "pending", "accepted", "checked-in", "checkedin", "checked_in", "completed", "complete", "done", "cancelled", "canceled", "cancel", "missed", "no_show", "noshow", "absent", "future_status"]) {
  const item = row(status, status, "2027-10-03T04:00:00Z");
  const actual = buildDoctorAppointmentSummary([item], now);
  const classified = dates.classifyAppointment(item, now);
  check(actual.historyAppointments[0].classification.category === classified.category, "canonical classification preserved: " + status);
  const represented = Number(metrics(actual).Completed) + Number(metrics(actual).Upcoming) + Number(metrics(actual)["Missed / Cancelled"]);
  check(represented === 1, "supported/legacy status is accounted for consistently: " + status);
}
const empty = buildDoctorAppointmentSummary([], now);
check(empty.metrics.every(metric => metric.value === "0" || metric.value === "0%") && empty.additionalNote === "", "future patient zero summary");

const currentWeek = resolveCurrentPregnancyWeek({ expectedDeliveryDate: "2027-02-06", storedGestationalAge: "17 Weeks", now });
check(currentWeek === 22 && summary.historyAppointments.find(item => item.id === "1").recordedGestationalAge === "17 Weeks", "current pregnancy remains 22 Weeks while an older linked visit is 17 Weeks");
const twoCompleted = buildDoctorAppointmentSummary([row("one", "completed"), row("two", "completed")], now,
  { medicalRecords: [visitRecord("one", "17 Weeks"), visitRecord("two", "19 Weeks")], patientId: "synthetic-a" });
check(twoCompleted.historyAppointments.map(item => item.recordedGestationalAge).join(",") === "17 Weeks,19 Weeks", "each completed appointment retains its own recorded age");
check(summary.historyAppointments.find(item => item.id === "6").recordedGestationalAge === "Not recorded", "future appointment with only a draft visit never inherits current dating");
check(summary.historyAppointments.find(item => item.id === "7").recordedGestationalAge === "Not recorded", "appointment without a completed linked visit shows Not recorded");
for (const absent of [null, undefined, "", "  ", "-", "Not recorded", "Not provided", "n/a", {}, []]) {
  const result = buildDoctorAppointmentSummary([row("absent", "completed")], now, { medicalRecords: [visitRecord("absent", absent)], patientId: "synthetic-a" });
  check(result.historyAppointments[0].recordedGestationalAge === "Not recorded", "empty/placeholder/non-scalar age is not usable");
}
for (const flags of [{ recordStatus: "draft" }, { isDraft: true }, { deleted: true }, { recordStatus: "pending" }]) {
  check(buildDoctorAppointmentSummary([row("blocked", "scheduled")], now, { medicalRecords: [visitRecord("blocked", "22 Weeks", "synthetic-a", flags)], patientId: "synthetic-a" }).historyAppointments[0].recordedGestationalAge === "Not recorded", "unfinished/deleted record does not contribute a historical age");
}
for (const legacy of [{ gestational_age: "18 weeks" }, { pregnancyStatus: { gestationalAge: "18 weeks" } }, { pregnancy_status: { gestational_age: "18 weeks" } }, { visitInformation: { gestationalAge: "18 weeks" } }]) {
  const record = visitRecord("legacy", "");record.form_data = { recordStatus: "completed", ...legacy };
  check(buildDoctorAppointmentSummary([row("legacy", "completed")], now, { medicalRecords: [record], patientId: "synthetic-a" }).historyAppointments[0].recordedGestationalAge === "18 Weeks", "saved legacy clinical age is supported without a patient fallback");
}
const mixedPatients = buildDoctorAppointmentSummary([row("shared-id", "completed")], now, { medicalRecords: [visitRecord("shared-id", "30 Weeks", "synthetic-b")], patientId: "synthetic-a" });
check(mixedPatients.historyAppointments[0].recordedGestationalAge === "Not recorded", "a foreign patient's linked record is rejected even for a matching schedule ID");
const latestBlank = buildDoctorAppointmentSummary([row("duplicate", "completed")], now, { medicalRecords: [visitRecord("duplicate", ""), visitRecord("duplicate", "17 Weeks")], patientId: "synthetic-a" });
check(latestBlank.historyAppointments[0].recordedGestationalAge === "Not recorded", "newest completed record's missing value is not replaced by an older value");
check(JSON.stringify(summary.metrics) === JSON.stringify(buildDoctorAppointmentSummary(rows, now).metrics), "adding visit GA does not change any appointment statistic");

for (const [stored, displayed] of [[21, "21 Weeks"], ["21", "21 Weeks"], ["21 weeks 3 days", "21 Weeks 3 Days"],
  ["21 WEEKS 3 DAYS", "21 Weeks 3 Days"], [" 21 weeks ", "21 Weeks"], ["21.5", "21.5 Weeks"], [0, "0 Weeks"]]) {
  const record = visitRecord("display", stored);
  const result = buildDoctorAppointmentSummary([row("display", "completed")], now, { medicalRecords: [record], patientId: "synthetic-a" });
  check(result.historyAppointments[0].recordedGestationalAge === displayed, "historical display normalizes units without changing numbers: " + String(stored));
  check(record.form_data.gestationalAge === stored, "display normalization leaves the saved source value untouched");
}

const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function hookRuntime() {
  const slots = [];
  let cursor = 0, dirty = true, render, tree;
  const effects = [];
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, n) => Object.is(value, b[n]));
  const react = {
    useState(initial) {
      const n = cursor++;
      if (!slots[n]) slots[n] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[n].value, update => {
        slots[n].value = typeof update === "function" ? update(slots[n].value) : update;
        dirty = true;
      }];
    },
    useRef(value) {
      const n = cursor++;
      if (!slots[n]) slots[n] = { value: { current: value } };
      return slots[n].value;
    },
    useCallback(callback, deps) {
      const n = cursor++;
      if (!slots[n] || !equal(slots[n].deps, deps)) slots[n] = { value: callback, deps };
      return slots[n].value;
    },
    useMemo(factory, deps) {
      const n = cursor++;
      if (!slots[n] || !equal(slots[n].deps, deps)) slots[n] = { value: factory(), deps };
      return slots[n].value;
    },
    useEffect(effect, deps) {
      const n = cursor++;
      if (!slots[n] || !equal(slots[n].deps, deps)) {
        effects.push(() => {
          slots[n]?.cleanup?.();
          slots[n] = { deps, cleanup: effect() };
        });
      }
    },
  };
  return {
    react,
    mount(component) { render = component; dirty = true; },
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
      throw Error("Login state did not settle");
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}
function nodes(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => nodes(child, predicate));
  if (!node || typeof node !== "object") return [];
  return [...(predicate(node) ? [node] : []),
    ...[node.props?.children].flat().flatMap(child => nodes(child, predicate))];
}


const jsx = (type, props, key) => ({ type, props: props || {}, key });
async function load(source, name, imports, browserGlobals = {}) {
  const context = vm.createContext({ console, window: { requestAnimationFrame: callback => callback() }, document: { querySelector: () => null }, ...browserGlobals });
  const code = (await transformWithOxc(source, name, { jsx: { runtime: "automatic", development: false } })).code;
  const module = new vm.SourceTextModule(code, { context });
  await module.link(spec => {
    assert.ok(Object.hasOwn(imports, spec), "Unexpected import: " + spec);
    const exports = imports[spec];
    return new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context });
  });
  await module.evaluate(); return module.namespace;
}
const reportLayoutSource = await readFile(new URL("src/components/reports/PrintableReportLayout.jsx", root), "utf8");
const layout = await load(reportLayoutSource, "PrintableReportLayout.jsx", { "react-dom": { createPortal: node => node }, "../../lib/reportExport": { formatReportTimestamp }, "../../styles/report-print.css": {}, "react/jsx-runtime": jsxRuntime });
const reportSource = await readFile(new URL("src/components/reports/AppointmentSummaryPrintableReport.jsx", root), "utf8");
const report = await load(reportSource, "AppointmentSummaryPrintableReport.jsx", { "../../lib/appointmentDate": dates, "../../lib/reportExport": { formatReportTimestamp }, "./PrintableReportLayout": { ...layout, PrintableReportPortal: ({ className, children }) => React.createElement("article", { className: "report-print-root " + className }, children) }, "react/jsx-runtime": jsxRuntime });
const renderReport = props => renderToStaticMarkup(React.createElement(report.default, props));
const patientA = { id: "synthetic-a", full_name: "Synthetic Patient Alpha", patient_id: "TEST-A", gestational_age: "24 weeks", medical_notes: "MUST NOT PRINT", contact_number: "MUST NOT PRINT" };
const patientB = { id: "synthetic-b", full_name: "Synthetic Patient Beta", patient_id: "TEST-B" };
const reportA = renderReport({ patient: patientA, doctorName: "Synthetic Doctor", generatedAt: now, summary });
const reportB = renderReport({ patient: patientB, generatedAt: now, summary: empty });
check(reportA.includes(patientA.full_name) && reportA.includes("TEST-A") && !reportA.includes(patientB.full_name), "patient A only");
check(reportB.includes(patientB.full_name) && reportB.includes("TEST-B") && !reportB.includes(patientA.full_name) && !reportB.includes("Synthetic appointment"), "patient B/empty report only");
check(reportA.includes("Generated by") && reportA.includes("Synthetic Doctor") && reportA.includes("Generated"), "current Doctor and generated timestamp");
check(reportB.includes("No appointment history found.") && !reportB.includes("Generated by</dt>"), "empty report and optional Doctor name");
check(!reportA.includes("MUST NOT PRINT") && !/<button|<nav|<aside|profile|Edit Record|Send Notification|Prenatal Appointment Timeline/.test(reportA), "no clinical notes/contact/control/sidebar/timeline leakage");
check(["Date", "Time", "Gestational Age", "Doctor", "Purpose / Appointment Type", "Status"].every(label => reportA.includes(label)), "all required history columns");
const escaped = renderReport({ patient: { ...patientA, full_name: '<script>alert("synthetic")</script>' }, generatedAt: now, summary: empty });
check(!escaped.includes('<script>') && escaped.includes('&lt;script&gt;'), "patient text is safely escaped by React");

const page = await readFile(new URL("src/pages/doctor/Doctor_Medical_Records.jsx", root), "utf8");
const panelSource = 'import React from "react"; import {Icon} from "@iconify/react"; import {buildDoctorAppointmentSummary} from "summary"; import {printReport} from "print"; import Report from "report"; import {formatAppointmentDate,formatAppointmentTime} from "dates";\n'
  + page.slice(page.indexOf("function AppointmentsPanel("), page.indexOf("function getReviewStatus(")).replace("function AppointmentsPanel(", "export default function AppointmentsPanel(").replaceAll("AppointmentSummaryPrintableReport", "Report");
const runtime = hookRuntime(); const printCalls = []; let finishPrint;
const actualPanel = await load(panelSource, "AppointmentsPanel.jsx", { react: { default: runtime.react }, "@iconify/react": { Icon: () => null }, summary: { buildDoctorAppointmentSummary }, print: { printReport: args => { printCalls.push(args); return new Promise(resolve => { finishPrint = resolve; }); } }, report: { default: report.default }, dates, "react/jsx-runtime": { jsx, jsxs: jsx } });
let props = { patient: patientA, doctorName: "Synthetic Doctor", appointmentState: { appointments: rows, loading: false, error: null }, clinicalRecordState: { medicalRecords: visitRecords, loading: false, error: null } };
runtime.mount(() => actualPanel.default(props));
const button = () => nodes(runtime.current(), node => node.type === "button" && node.props.className === "mr-appointment-print-button")[0];
const screenAges = () => nodes(runtime.current(), node => node.type === "tr" && node.props["data-appointment-id"]).map(tr => nodes(tr, node => node.type === "td")[2].props.children);
const printedAges = snapshot => [...renderReport(snapshot).match(/<tbody>([\s\S]*?)<\/tbody>/)[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(tr => [...tr[1].matchAll(/<td>([\s\S]*?)<\/td>/g)][2]?.[1]).filter(Boolean);
const printedSnapshot = () => nodes(runtime.current(), node => node.type === report.default)[0]?.props;
check(!button().props.disabled, "loaded patient is printable");
const printing = button().props.onClick(); const snapshot = printedSnapshot();
check(screenAges().includes("17 Weeks") && screenAges().includes("19 Weeks 3 Days"), "actual history formats numeric weeks and recorded lowercase weeks/days");
check(screenAges().join("|") === printedAges(snapshot).join("|"), "screen and printable table render the exact same resolved gestational-age rows: " + JSON.stringify({screen:screenAges(),print:printedAges(snapshot)}));
check(!renderReport(snapshot).includes("24 weeks"), "printing never falls back to the patient current/stored gestational-age field");
check(renderReport(snapshot).includes("linked completed clinical visit") && !renderReport(snapshot).includes("age at each appointment is not recorded"), "print footnote accurately describes saved linked-visit values");
check(snapshot.patient.id === patientA.id && snapshot.summary.historyAppointments.every(item => item.patient_id === patientA.id), "actual tab prints its selected patient's dataset");
check(button().props.disabled && printCalls.length === 1, "printing disables duplicate clicks");
await button().props.onClick();check(printCalls.length === 1, "duplicate clicks do not launch another print");
check(printCalls[0].rootSelector === ".report-print-root.report-print-appointments", "dedicated report root");
finishPrint();await printing;await runtime.settle();
check(!printedSnapshot() && !button().props.disabled, "normal tab restored after print");
props = { ...props, patient: patientB, appointmentState: { appointments: [{ ...row("beta", "completed"), patient_id: patientB.id, title: "Synthetic Beta visit" }], loading: false, error: null }, clinicalRecordState: { medicalRecords: [...visitRecords, visitRecord("beta", "21 Weeks", patientB.id)], loading: false, error: null } };runtime.mount(() => actualPanel.default(props));
const betaPrint = button().props.onClick();const betaSnapshot = printedSnapshot();
check(betaSnapshot.patient.id === patientB.id && betaSnapshot.summary.historyAppointments.length === 1 && betaSnapshot.summary.historyAppointments[0].patient_id === patientB.id, "different populated patient's identity and history replace patient A");
check(screenAges()[0] === "21 Weeks" && printedAges(betaSnapshot)[0] === "21 Weeks", "patient B uses only its own linked age in both screen and print");
check(renderReport(betaSnapshot).includes("Synthetic Beta visit") && !renderReport(betaSnapshot).includes(patientA.full_name), "different populated patient report has no previous identity");finishPrint();await betaPrint;await runtime.settle();
props = { ...props, patient: { ...patientB, id: "synthetic-future", full_name: "Synthetic Future Patient", patient_id: "TEST-FUTURE" }, appointmentState: { appointments: [], loading: false, error: null } };runtime.mount(() => actualPanel.default(props));
const emptyPrint = button().props.onClick();check(printedSnapshot().patient.id === "synthetic-future" && printedSnapshot().summary.historyAppointments.length === 0, "switching to empty patient prints new identity/zero data");finishPrint();await emptyPrint;await runtime.settle();
for (const state of [{ loading: true, error: null }, { loading: false, error: new Error("synthetic") }]) {
  props = { ...props, appointmentState: { appointments: [], ...state } };runtime.mount(() => actualPanel.default(props));
  check(button().props.disabled, "loading/error prevents misleading empty print");await button().props.onClick();
}
check(printCalls.length === 3, "blocked print states make no print calls");
check(page.includes("key={patient.id}") && page.includes("doctorName={doctorName}"), "patient switch resets print state and current Doctor is forwarded");

for (const state of [{ loading: true, error: null }, { loading: false, error: new Error("synthetic clinical failure") }]) {
  props = { ...props, appointmentState: { appointments: rows, loading: false, error: null }, clinicalRecordState: { medicalRecords: [], ...state } };runtime.mount(() => actualPanel.default(props));
  check(button().props.disabled, "clinical record loading/error prevents premature print");await button().props.onClick();
}
check(printCalls.length === 3, "clinical load failures do not initiate printing");

// Exercise the existing page's actual bulk loader and tab-independent load effect.
const loaderStart = page.indexOf("  const loadMedicalRecords = React.useCallback(");
const loaderEnd = page.indexOf("  const loadPatientAvatar = React.useCallback(", loaderStart);
const loaderQueries = [];
const loaderSupabase = { from(table) {
  assert.equal(table, "medical_records");let patientId;
  return { select(columns) { check(columns.includes("schedule_id") && columns.includes("form_data"), "bulk query includes clinical linkage and recorded form data");return this; },
    eq(field, value) { assert.equal(field, "patient_id");patientId = value;return this; },
    order(field, options) { assert.equal(field, "uploaded_at");assert.equal(options.ascending, false);return new Promise(resolve => loaderQueries.push({ patientId, resolve })); } };
} };
const loaderPreamble = `import React from "react";import {supabase} from "supabase";import {isCompletedClinicalVisitRecord} from "clinical";
export const state = { rows: [], loadedPatientId: "", loading: false, error: null };
const medicalRecordRequestRef = {current:0},focusedRecordIdRef={current:""},onRecordSelectRef={current:null};
const setMedicalRecordRows = value => {state.rows=value;};
const setMedicalRecordsError = value => {state.error=value;};
const setLoadedMedicalRecordsPatientId = value => {state.loadedPatientId=value;};
const setIsLoadingRecords = value => {state.loading=value;};
const setRecordMessage = () => {};const setFocusedRecordId = () => {};
const setStableEditRecordId = update => {if(typeof update === "function")update("");};
` + page.match(/const medicalRecordColumns =[\s\S]*?;/)[0];
const loader = await load(loaderPreamble + page.slice(loaderStart,loaderEnd) + "export {loadMedicalRecords};", "MedicalRecordLoader.jsx",
  { react: { default: { useCallback: callback => callback } }, supabase: { supabase: loaderSupabase }, clinical: { isCompletedClinicalVisitRecord } });
const loadAlpha = loader.loadMedicalRecords(patientA);
const loadBeta = loader.loadMedicalRecords(patientB);
loaderQueries[1].resolve({ data: [visitRecord("beta", "21 Weeks", patientB.id)], error: null });await loadBeta;
loaderQueries[0].resolve({ data: visitRecords, error: null });await loadAlpha;
check(loader.state.loadedPatientId === patientB.id && loader.state.rows.every(item => item.patient_id === patientB.id), "stale medical-record response cannot replace patient B records");
check(loaderQueries.length === 2 && loaderQueries.every((query,index) => query.patientId === [patientA.id,patientB.id][index]), "one patient-scoped bulk query per load; no appointment-by-appointment queries");
const loadEmptyRecords = loader.loadMedicalRecords({ id: "synthetic-future" });loaderQueries[2].resolve({ data: [], error: null });await loadEmptyRecords;
check(loader.state.loadedPatientId === "synthetic-future" && loader.state.rows.length === 0 && !loader.state.loading, "new patient record load completes with empty clinical history");
const effectEnd = page.indexOf("  React.useEffect(() => {\r\n    if (!patient?.id || loadedMedicalRecordsPatientId",loaderEnd);
const effectStart = page.lastIndexOf("  React.useEffect(() => {",effectEnd - 1);
const bulkLoadEffect = page.slice(effectStart,effectEnd);
check(bulkLoadEffect.includes("loadMedicalRecords(patient)") && !bulkLoadEffect.includes("activeTab"), "medical-record bulk loading is independent of tab and supports direct Appointments entry");
for (const alreadyLoaded of [false,true]) {
  const scheduled = [], calls = [];
  await load(`import React from "react";
const patient = {id:"synthetic-direct"}, isLoadingRecords = false, loadedMedicalRecordsPatientId = "${alreadyLoaded ? "synthetic-direct" : ""}";
const loadMedicalRecords = patient => {capture(patient.id);};
` + bulkLoadEffect, "DirectAppointmentRecordEffect.jsx", { react: { default: { useEffect: effect => effect() } } },
    { capture: id => calls.push(id), window: { setTimeout: callback => {scheduled.push(callback);return 1;}, clearTimeout() {} } });
  for (const callback of scheduled)callback();
  check(calls.length === (alreadyLoaded ? 0 : 1), "direct Appointments entry loads once and reuses an already loaded patient snapshot");
}
const stateStart = page.indexOf("  const appointmentClinicalRecordState = React.useMemo(");
const stateEnd = page.indexOf("  const recordsRequired",stateStart);
for (const matched of [false,true]) {
  const projection = await load(`import React from "react";
const patient={id:"synthetic-b"}, loadedMedicalRecordsPatientId="${matched ? "synthetic-b" : "synthetic-a"}",
  medicalRecordRows=[{patient_id:"${matched ? "synthetic-b" : "synthetic-a"}",schedule_id:"beta",form_data:{gestationalAge:"21 Weeks"}}],
  isLoadingRecords=false,medicalRecordsError=null;
` + page.slice(stateStart,stateEnd) + "export {appointmentClinicalRecordState};", "ClinicalRecordProjection.jsx",
    { react: { default: { useMemo: factory => factory() } } });
  check(projection.appointmentClinicalRecordState.medicalRecords.length === (matched ? 1 : 0) && projection.appointmentClinicalRecordState.loading === !matched, "clinical data is withheld until the load belongs to the selected patient");
}

// Actual patient-scoped hook: an old response cannot cross a patient switch.
const hookRuntimeState = hookRuntime(); const queries = []; const timers = []; const filters = [];
const hookSupabase = {
  from(table) {
    assert.equal(table, "schedule");
    let patientId;
    return { select() { return this; }, eq(field, value) { assert.equal(field, "patient_id"); patientId = value; return this; },
      order() { return new Promise(resolve => queries.push({ patientId, resolve })); } };
  },
  channel() { return { on(_event, options) { filters.push(options.filter); return this; }, subscribe() { return this; } }; },
  removeChannel() {},
};
const hookSource = await readFile(new URL("src/hooks/usePatientAppointments.js", root), "utf8");
const hook = await load(hookSource, "usePatientAppointments.js", { react: hookRuntimeState.react, "../lib/supabaseClient": { supabase: hookSupabase } },
  { window: { setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {} } });
let selectedPatient = patientA.id;
hookRuntimeState.mount(() => hook.usePatientAppointments(selectedPatient));
hookRuntimeState.current(); timers.shift()();
selectedPatient = patientB.id; hookRuntimeState.mount(() => hook.usePatientAppointments(selectedPatient));
check(hookRuntimeState.current().appointments.length === 0 && hookRuntimeState.current().loading, "patient switch hides previous patient's rows before the new request"); timers.shift()();
queries[0].resolve({ data: rows, error: null }); await hookRuntimeState.settle();
check(hookRuntimeState.current().appointments.length === 0, "stale patient A request is discarded after switching to B");
const patientBRows = [{ ...row("b-row", "completed"), patient_id: patientB.id, title: "Synthetic Beta visit" }];
queries[1].resolve({ data: patientBRows, error: null }); await hookRuntimeState.settle();
check(hookRuntimeState.current().appointments.every(item => item.patient_id === patientB.id) && !hookRuntimeState.current().loading, "only patient B live rows become printable");
check(queries[0].patientId === patientA.id && queries[1].patientId === patientB.id && filters.every((filter, index) => filter === "patient_id=eq." + [patientA.id, patientB.id][index]), "queries and Realtime subscriptions both scope the selected patient");
selectedPatient = "synthetic-future"; hookRuntimeState.mount(() => hook.usePatientAppointments(selectedPatient));hookRuntimeState.current();timers.shift()();queries[2].resolve({ data: [], error: null });await hookRuntimeState.settle();
check(!hookRuntimeState.current().loading && hookRuntimeState.current().appointments.length === 0 && !hookRuntimeState.current().error, "new future patient becomes a valid printable empty history");hookRuntimeState.unmount();

// Execute the real print helper with isolated DOM/window event doubles.
const originalGlobals = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement };
const bodyClasses = new Set(); const eventListeners = new Map(); const styles = []; let printCount = 0; let focused = false;
class FocusElement { isConnected = true; focus() { focused = true; } }
globalThis.HTMLElement = FocusElement;
globalThis.document = { title: "Original title", activeElement: new FocusElement(), fonts: { ready: Promise.resolve() }, body: { classList: { add: (...classes) => classes.forEach(name => bodyClasses.add(name)), remove: (...classes) => classes.forEach(name => bodyClasses.delete(name)) } },
  getElementById: () => null, head: { appendChild: style => styles.push(style) }, createElement: () => ({ remove() { styles.splice(styles.indexOf(this), 1); } }), querySelectorAll: () => [{ textContent: reportA, scrollHeight: 800 }] };
globalThis.window = { onafterprint: null, requestAnimationFrame: callback => callback(), addEventListener: (name, callback) => eventListeners.set(name, callback), removeEventListener: name => eventListeners.delete(name),
  print() { printCount++;check(bodyClasses.has("is-printing-report") && document.title === "Appointment Summary", "print mode and safe title set before window.print"); eventListeners.get("afterprint")(); }, setTimeout, clearTimeout };
try {
  await printReport({ bodyClass: "print-doctor-appointment-summary", documentTitle: "Appointment Summary", rootSelector: ".report-print-root.report-print-appointments" });
  check(printCount === 1 && bodyClasses.size === 0 && document.title === "Original title" && styles.length === 0 && focused, "afterprint restores classes, title, page style and focus");
  window.print = () => { throw new Error("Synthetic print failure"); };
  await assert.rejects(printReport({ bodyClass: "print-doctor-appointment-summary" }));
  check(bodyClasses.size === 0 && styles.length === 0 && document.title === "Original title", "print failure also cleans up");
} finally { for (const [key, value] of Object.entries(originalGlobals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
const printCss = await readFile(new URL("src/styles/report-print.css", root), "utf8");
check(printCss.includes('body.is-printing-report > *:not(.report-print-root)') && printCss.includes('display: none !important;'), "print CSS hides the entire non-report application");
const toolbarCss = await readFile(new URL("src/styles/doctor-appointment-summary.css", root), "utf8");
check(toolbarCss.includes('max-width: 100%') && toolbarCss.includes('flex-wrap: wrap') && toolbarCss.includes('flex-direction: column'), "toolbar has bounded width, wrapping and mobile stacking");
console.log('PASS: ' + checks + ' Doctor appointment-summary regression assertions; no backend/production access.');
