// Run: node scripts/verify-doctor-visit-record-mapping.mjs
// Execute the actual form and record JSX with synthetic data and no network client.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as vm from "node:vm";
import { parse } from "espree";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithOxc } from "vite";
import * as dates from "../src/lib/appointmentDate.js";
import * as clinical from "../src/lib/clinicalVisitData.js";
import * as pregnancy from "../src/lib/pregnancyTracking.js";
import * as summary from "../src/lib/doctorAppointmentSummary.js";

if (!vm.SourceTextModule) {
  const child = spawnSync(process.execPath, ["--experimental-vm-modules", ...process.argv.slice(1)], { stdio: "inherit", windowsHide: true });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}
const root = new URL("../", import.meta.url);
const formPath = "src/pages/appointments/AppointmentVisitForm.jsx";
const recordPath = "src/pages/doctor/Doctor_Medical_Records.jsx";
const formSource = await readFile(new URL(formPath, root), "utf8");
const recordSource = await readFile(new URL(recordPath, root), "utf8");
const parseSource = source => parse(source, { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true }, range: true });
let checks = 0;
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function check(value, message) { assert.ok(value, message); checks++; }
const serial = value => JSON.parse(JSON.stringify(value));
const today = new Date("2026-10-07T04:00:00Z");
const fixedPregnancy = { ...pregnancy, resolveCurrentPregnancyWeek: options => pregnancy.resolveCurrentPregnancyWeek({ ...options, now: today }) };
const noNetwork = () => { throw Error("Unexpected backend/component access in fixture"); };
async function load(source, filename, overrides = {}) {
  const imports = {
    react: { default: React, ...React }, "react/jsx-runtime": jsxRuntime,
    "react-router-dom": { useLocation: () => ({ search: "" }), useNavigate: () => noNetwork },
    "../../lib/appointmentDate": dates, "../../lib/clinicalVisitData": clinical,
    "../../lib/pregnancyTracking": fixedPregnancy, "../../lib/doctorAppointmentSummary": summary,
    "../../lib/supabaseClient": { supabase: { from: noNetwork, rpc: noNetwork } },
    ...overrides,
  };
  const context = vm.createContext({ console, Date, Map, Set, URLSearchParams,
    window: { setTimeout, clearTimeout }, document: { addEventListener() {}, removeEventListener() {}, getElementById: () => null } });
  const code = (await transformWithOxc(source, filename, { jsx: { runtime: "automatic", development: false } })).code;
  const module = new vm.SourceTextModule(code, { context, initializeImportMeta(meta) { meta.env = { DEV: false }; } });
  const declarations = parseSource(source).body.filter(node => node.type === "ImportDeclaration");
  await module.link(spec => {
    let values = imports[spec];
    if (!values) {
      const declaration = declarations.find(node => node.source.value === spec);
      values = Object.fromEntries(declaration.specifiers.map(item => [item.type === "ImportDefaultSpecifier" ? "default" : item.imported.name,
        spec === "@iconify/react" || spec === "lucide-react" ? () => null : noNetwork]));
    }
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}
function hookRuntime() {
  const slots = []; let cursor = 0, dirty = true, tree, component;
  const effects = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const memo = (factory, deps) => {
    const n = cursor++;
    if (!slots[n] || !same(slots[n].deps, deps)) slots[n] = { value: factory(), deps };
    return slots[n].value;
  };
  const react = {
    useState(initial) {
      const n = cursor++;
      if (!slots[n]) slots[n] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[n].value, value => { slots[n].value = typeof value === "function" ? value(slots[n].value) : value; dirty = true; }];
    },
    useRef: value => memo(() => ({ current: value }), []),
    useMemo: memo, useCallback: (callback, deps) => memo(() => callback, deps),
    useEffect(effect, deps) {
      const n = cursor++;
      if (!slots[n] || !same(slots[n].deps, deps)) effects.push(() => {
        slots[n]?.cleanup?.(); slots[n] = { deps, cleanup: effect() };
      });
    },
  };
  return {
    react, mount(fn) { component = fn; },
    async settle() {
      for (let n = 0; n < 12; n++) {
        if (dirty) { dirty = false; cursor = 0; tree = component(); for (const effect of effects.splice(0)) effect(); }
        await new Promise(resolve => setTimeout(resolve, 0));
        if (!dirty) return tree;
      }
      throw Error("Form fixture did not settle");
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}
function nodes(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => nodes(child, predicate));
  if (!node || typeof node !== "object") return [];
  return [...(predicate(node) ? [node] : []), ...nodes(node.props?.children, predicate)];
}
const patient = { id: "synthetic-patient", patient_id: "TEST-00046", full_name: "Synthetic Patient", expected_delivery_date: "2027-01-06", gestational_age: "27", risk_level: "Low Risk" };
const obstetric = { id: "synthetic-history", patient_id: patient.id, gravida: 3, para: 2, full_term: 1, preterm: 1, abortion_miscarriage: 1, living_children: 2,
  last_menstrual_period: "2026-04-01", expected_delivery_date: "2027-01-06" };
const vitals = { bloodPressure: "110/70", temperature: "36.7", respiratoryRate: "18", weight: "58", height: "160", oxygenSaturation: "98", gestationalAge: "27", fetalHeartRate: "145" };
const savedFields = { ...vitals, fundalHeight: "27", estimatedFetalWeight: "1.0", fetalMovement: "Active / Present", babyPosition: "Cephalic", pregnancyType: "Singleton", riskLevel: "Low Risk",
  smokingStatus: "Never", alcoholIntake: "Never", drugUse: "No", physicalActivity: "Moderate", diet: "Balanced", chiefComplaint: "Synthetic chief complaint",
  assessment: "Synthetic assessment", diagnosis: "Synthetic diagnosis", doctorOrder: "Synthetic doctor's order", treatmentPlan: "Synthetic treatment plan",
  vaccinations: [{ vaccineName: "Tdap", lotNumber: "TEST-TDAP-001", dateGiven: "2026-10-07" }] };
const schedule = { id: "synthetic-appointment", patient_id: patient.id, doctor_id: "synthetic-doctor", maternal_appointment_id: "TEST-00159", start_time: "2026-10-07T02:00:00Z", status: "checked_in" };
const makeRecord = (formData = {}) => ({ id: "synthetic-record", patient_id: patient.id, schedule_id: schedule.id, doctor_id: schedule.doctor_id, type: "Initial Visit", title: "Initial Visit", uploaded_at: "2026-10-07T02:00:00Z",
  form_data: { ...savedFields, visitFormType: "initial", recordStatus: "completed", isDraft: false, ...formData } });
async function mountForm({ staffEdd, record = null, patientEdd = "2027-01-06", registrationEdd = "2027-01-06", requestedType = "initial", prior = [],
  history = {}, historyError = null, historyBaseError = null, fallbackHistory = null, directoryPatientId = patient.id, routingError = null } = {}) {
  const runtime = hookRuntime(), writes = [], navigation = [], reads = [];
  const original = JSON.stringify(record);
  let stored = record ? structuredClone(record) : null;
  const rowPatient = { ...patient, id: directoryPatientId, expected_delivery_date: patientEdd };
  const rowObstetric = history === null ? null : { ...obstetric, expected_delivery_date: registrationEdd, ...history };
  const response = data => ({ data, error: null });
  function query(table, initial = null) {
    const filters = {}, orders = []; let update = null, projection = "";
    const result = () => {
      reads.push({ table, filters: serial(filters), orders: serial(orders), projection });
      if (update) {
        assert.equal(table, "medical_records"); assert.equal(filters.id, stored.id); assert.equal(filters.schedule_id, schedule.id);
        writes.push({ kind: "update", table, payload: serial(update) }); stored = { ...stored, ...serial(update) };
        return response(stored);
      }
      if (initial) return response(initial);
      if (table === "schedule") return response(schedule);
      if (table === "medical_records") return response(filters.schedule_id ? stored : prior);
      if (table === "patient_obstetric_history") {
        if (historyBaseError) return { data: null, error: historyBaseError };
        if (projection.includes("gravida") && historyError) return { data: null, error: historyError };
        return response(projection.includes("gravida") ? rowObstetric : fallbackHistory || rowObstetric);
      }
      if (["patient_medical_history", "patient_initial_assessment"].includes(table)) return response(null);
      throw Error("Unexpected query: " + table);
    };
    return { select(columns) { projection = columns; return this; }, eq(key, value) { filters[key] = value; return this; }, order(key, options) { orders.push([key, options]); return this; }, limit() { return this; },
      update(payload) { update = payload; return this; }, maybeSingle: async () => result(), then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); } };
  }
  const supabase = { from: query, rpc(name, payload) {
    if (name === "get_appointment_visit_form_type") return Promise.resolve(routingError ? { data: null, error: routingError } : response({ visit_form_type: requestedType, appointment_status: stored ? "completed" : "checked_in" }));
    if (name === "get_doctor_patient_directory") return query("directory", rowPatient);
    if (name === "get_staff_visit_intake") return Promise.resolve(response({ id: "synthetic-intake", intake_data: { ...vitals, expectedDeliveryDate: staffEdd } }));
    if (name === "save_appointment_visit_record") {
      writes.push({ kind: "rpc", name, payload: serial(payload) });
      stored = makeRecord(payload.p_form_data);
      stored.type = stored.title = payload.p_visit_form_type === "follow_up" ? "Follow-Up Visit" : "Initial Visit";
      return Promise.resolve(response(stored));
    }
    if (name === "sync_doctor_visit_pregnancy_state") {
      writes.push({ kind: "rpc", name, payload: serial(payload) }); return Promise.resolve(response(null));
    }
    throw Error("Unexpected RPC: " + name);
  } };
  const location = { search: record ? `?source=medical-record&patientId=${patient.id}&recordId=${record.id}` : "" };
  const navigate = (path, options) => navigation.push({ path, options });
  const module = await load(formSource, "AppointmentVisitForm.jsx", {
    react: runtime.react, "../../lib/supabaseClient": { supabase },
    "react-router-dom": { useLocation: () => location, useNavigate: () => navigate },
  });
  runtime.mount(() => module.default({ appointmentId: schedule.id, requestedType, workspace: "doctor" }));
  let tree = await runtime.settle();
  const field = id => nodes(tree, node => node.props?.id === id)[0];
  const submit = () => nodes(tree, node => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  return { field, writes, reads, navigation, submit, original, stored: () => stored,
    history: () => nodes(tree, node => node.type?.name === "StoredObstetricHistory")[0],
    tree: () => tree,
    async change(id, value) { field(id).props.onChange(value); tree = await runtime.settle(); },
    async settle() { tree = await runtime.settle(); return tree; }, unmount: () => runtime.unmount() };
}

// Full load: exercise both EDD sources, empty/placeholder Staff values, and the date-field prop.
for (const missing of ["", null, undefined, "  ", "-", "Not recorded", "Not provided", "n/a", "none", "null", "undefined"]) {
  const app = await mountForm({ staffEdd: missing });
  equal(app.field("expected-delivery-date")?.props.value, "2027-01-06", "blank/placeholder Staff EDD cannot erase registration EDD: " + missing);
  equal(app.writes.length, 0, "loading never writes/backfills");
  for (const [id, expected] of [["blood-pressure", "110/70"], ["temperature", "36.7"], ["respiratory-rate", "18"], ["weight", "58"], ["height", "160"], ["oxygen-saturation", "98"], ["fetal-heart-rate", "145"]])
    equal(app.field(id)?.props.value, expected, "Staff intake remains unchanged: " + id);
  app.unmount();
}
for (const registrationEdd of ["", null, " ", "Not recorded", "n/a", "invalid date"]) {
  const app = await mountForm({ registrationEdd });
  equal(app.field("expected-delivery-date").props.value, "2027-01-06", "patient EDD fallback when registration EDD is unavailable"); app.unmount();
}
const registrationWins = await mountForm({ patientEdd: "2027-01-08" });
equal(registrationWins.field("expected-delivery-date").props.value, "2027-01-06", "registration EDD precedes patient fallback"); registrationWins.unmount();
const unknownEdd = await mountForm({ patientEdd: null, registrationEdd: null });
equal(unknownEdd.field("expected-delivery-date").props.value, "", "no stored EDD stays blank rather than inventing a date"); unknownEdd.unmount();
for (const savedEdd of [null, undefined, "  ", "Not recorded", "n/a"]) {
  const app = await mountForm({ record: makeRecord({ expectedDeliveryDate: savedEdd }) });
  equal(app.field("expected-delivery-date").props.value, "2027-01-06", "legacy empty/placeholder Doctor EDD may prefill registration");
  equal(app.writes.length, 0, "legacy placeholder EDD is not automatically saved"); app.unmount();
}
const staffWins = await mountForm({ staffEdd: "2027-01-07" });
equal(staffWins.field("expected-delivery-date").props.value, "2027-01-07", "meaningful current Staff EDD precedence remains"); staffWins.unmount();
const doctorWins = await mountForm({ staffEdd: "2027-01-07", record: makeRecord({ expectedDeliveryDate: "2027-01-08", bloodPressure: "120/80" }) });
equal(doctorWins.field("expected-delivery-date").props.value, "2027-01-08", "saved Doctor EDD wins on edit");
equal(doctorWins.field("blood-pressure").props.value, "120/80", "saved Doctor clinical values still win");
equal(doctorWins.writes.length, 0, "saved Doctor record is not rewritten by load"); doctorWins.unmount();
const legacy = makeRecord({ expectedDeliveryDate: "" });
const editing = await mountForm({ record: legacy, staffEdd: "2027-01-07" });
equal(editing.field("expected-delivery-date").props.value, "2027-01-06", "legacy blank Doctor EDD prefills from authoritative registration");
equal(editing.stored().form_data.expectedDeliveryDate, "", "legacy persisted record remains blank until explicit save");
equal(JSON.stringify(legacy), editing.original, "load does not mutate the caller's legacy record");
equal(editing.writes.length, 0, "no automatic legacy backfill");
editing.submit(); await editing.settle();
equal(editing.writes.filter(item => item.kind === "update").length, 1, "explicit editing updates the same record once");
equal(editing.writes.some(item => item.name === "save_appointment_visit_record"), false, "edit never creates a duplicate record");
equal(editing.stored().form_data.expectedDeliveryDate, "2027-01-06", "direct update saves corrected EDD");
equal(editing.stored().id, legacy.id, "editing preserves record identity");
for (const [key, value] of Object.entries(savedFields)) equal(editing.stored().form_data[key], value, "explicit edit preserves saved clinical field: " + key);
check(editing.navigation[0]?.path.includes("tab=medical-record") && editing.navigation[0]?.path.includes("recordId=synthetic-record"), "edit returns to the same patient's record");
editing.unmount();
const creating = await mountForm();
for (const [id, value] of [["chief-complaint", savedFields.chiefComplaint], ["assessment", savedFields.assessment], ["diagnosis", savedFields.diagnosis], ["treatment-plan", savedFields.treatmentPlan]]) await creating.change(id, value);
creating.submit(); creating.submit(); await creating.settle();
const saves = creating.writes.filter(item => item.name === "save_appointment_visit_record");
equal(saves.length, 1, "save lock prevents duplicate concurrent record creation");
equal(saves[0].payload.p_form_data.expectedDeliveryDate, "2027-01-06", "canonical formDataForSave and save RPC preserve EDD");
equal(saves[0].payload.p_form_data.recordStatus, "completed", "completion contract retained");
equal(saves[0].payload.p_form_data.isDraft, false, "saved record remains completed rather than draft");
equal(saves[0].payload.p_form_data.appointmentId, schedule.id, "same appointment linkage");
equal(creating.navigation[0]?.path, "/doctor/appointments", "creation keeps return navigation");
const createdRecord = creating.stored(); creating.unmount();
const reopening = await mountForm({ record: createdRecord });
equal(reopening.field("expected-delivery-date").props.value, "2027-01-06", "saved EDD survives reopening");
equal(reopening.writes.length, 0, "reopening does not save again"); reopening.unmount();
const followUp = await mountForm({ requestedType: "follow_up", prior: [makeRecord()] });
equal(followUp.field("expected-delivery-date").props.value, "2027-01-06", "Follow-Up pregnancy prefill remains available");
equal(followUp.field("doctor-order").props.value, "", "new Follow-Up does not inherit old Doctor's Order"); followUp.unmount();

// Stored history uses the exact resolved row, separate from editable encounter data.
const storedHistory = await mountForm({ requestedType: "follow_up", staffEdd: "2027-01-07" });
const historyElement = storedHistory.history();
equal(historyElement.props.obstetric.id, obstetric.id, "summary uses the selected obstetric row ID");
equal(historyElement.props.historyId, obstetric.id, "display ID matches current pregnancy sync context");
equal(historyElement.props.patientId, patient.id, "summary Patient matches appointment Patient");
equal(historyElement.props.obstetric.expected_delivery_date, "2027-01-06", "stored EDD stays on the history row");
equal(storedHistory.field("expected-delivery-date").props.value, "2027-01-07", "encounter EDD remains independently prefilled from Staff");
const historyHtml = renderToStaticMarkup(historyElement);
check(historyHtml.includes('aria-expanded="false"') && historyHtml.includes('id="follow-up-stored-obstetric-history" hidden=""'), "history starts collapsed with accessible disclosure state");
check(historyHtml.includes("View Full History") && historyHtml.includes("Stored EDD"), "summary labels stored date and disclosure");
check(!/<input|<textarea|<select/.test(historyHtml), "stored history contains no editable controls");
const historyReads = storedHistory.reads.filter(row => row.table === "patient_obstetric_history");
equal(historyReads.length, 1, "successful expansion uses one existing history query, no second selection");
equal(historyReads[0].filters, { patient_id: patient.id }, "history query is Patient-scoped");
equal(historyReads[0].orders.map(([key]) => key), ["updated_at", "created_at", "id"], "existing deterministic row order retained");
for (const column of ["id", "patient_id", "gravida", "para", "full_term", "preterm", "abortion_miscarriage", "living_children", "last_menstrual_period", "expected_delivery_date"])
  check(historyReads[0].projection.split(", ").includes(column), "Follow-Up authorized projection includes " + column);
equal(storedHistory.writes.length, 0, "opening stored history performs no writes");
for (const invalid of [{ historyId: "another-history" }, { patientId: "another-patient" }]) {
  const html = renderToStaticMarkup(React.cloneElement(historyElement, invalid));
  check(html.includes("Stored obstetric history is unavailable") && !html.includes("View Full History"), "display independently rejects mismatched row/Patient context");
}
storedHistory.unmount();
for (const missing of [null, undefined, "", " ", "Not recorded", "n/a"]) {
  const app = await mountForm({ requestedType: "follow_up", history: { gravida: 0, para: missing, full_term: 0,
    preterm: 0, abortion_miscarriage: 0, living_children: 0, last_menstrual_period: null, expected_delivery_date: null } });
  const html = renderToStaticMarkup(app.history());
  check(html.includes("<dt>Gravida (G)</dt><dd>0</dd>"), "recorded zero survives: " + missing);
  check(html.includes("<dt>Para (P)</dt><dd>Not provided</dd>"), "missing counts do not become zero: " + missing);
  check(html.includes("<dt>Stored EDD</dt><dd>Not provided</dd>"), "no Patient/encounter EDD substitution into stored history");
  equal(app.writes.length, 0, "missing values are never backfilled"); app.unmount();
}
for (const options of [
  { history: null },
  { historyError: { code: "42703", message: "optional column unavailable" } },
  { historyError: { code: "42501", message: "permission denied" } },
  { historyError: { code: "42703", message: "optional column unavailable" }, fallbackHistory: { ...obstetric, id: "another-resolved-history", gravida: 99 } },
]) {
  const app = await mountForm({ requestedType: "follow_up", ...options });
  check(Boolean(app.field("expected-delivery-date")), "optional history absence/error preserves existing visit loading");
  const html = renderToStaticMarkup(app.history());
  check(html.includes("Stored obstetric history is unavailable") && !html.includes("View Full History"), "unavailable history never renders partial/fallback records");
  equal(app.writes.length, 0, "unavailable/unauthorized history never writes"); app.unmount();
}
for (const options of [{ history: { patient_id: "another-patient" } }, { history: { id: null } }, { directoryPatientId: "another-patient" }]) {
  const app = await mountForm({ requestedType: "follow_up", ...options });
  equal(app.history(), undefined, "invalid Patient/history identity fails closed before display");
  equal(app.writes.length, 0, "invalid identity performs no writes"); app.unmount();
}
const unauthorized = await mountForm({ requestedType: "follow_up", routingError: { code: "42501", message: "not assigned" } });
equal(unauthorized.history(), undefined, "unauthorized Doctor cannot display a visit's history");
equal(unauthorized.reads.length, 0, "failed visit authorization prevents all downstream history reads"); unauthorized.unmount();
const deniedHistory = await mountForm({ requestedType: "follow_up", historyBaseError: { code: "42501", message: "history access denied" } });
equal(deniedHistory.history(), undefined, "denied base and optional history reads never expose history");
equal(deniedHistory.writes.length, 0, "permission failures never invoke a clinical save"); deniedHistory.unmount();
const initialHistory = await mountForm();
equal(initialHistory.history(), undefined, "Doctor Initial never renders a duplicate Stored History card");
check(nodes(initialHistory.tree(), node => node.type?.name === "ObstetricHistorySection").length === 1, "existing Doctor Initial history card remains present exactly once"); initialHistory.unmount();

const readerExports = "\nexport { mapSupabaseMedicalRecord, MedicalRecordEntry, buildPrenatalData };";
const reader = await load(recordSource + readerExports, "Doctor_Medical_Records.jsx");
const map = row => reader.mapSupabaseMedicalRecord(row, patient, new Map([[schedule.doctor_id, "Synthetic Doctor"]]), new Map([[schedule.id, schedule]]));
const sourceRecord = makeRecord({ expectedDeliveryDate: "", completedAt: "2026-10-07T02:00:00Z" });
const originalRecord = JSON.stringify(sourceRecord);
const mapped = map(sourceRecord);
equal(serial(mapped.findings.find(([label]) => label === "Estimated Fetal Weight")), ["Estimated Fetal Weight", "1.0", "kg"], "current form field retains 1.0 and matches kg writer contract");
const followUpRecord = map(makeRecord({ visitFormType: "follow_up" }));
equal(serial(followUpRecord.findings.find(([label]) => label === "Estimated Fetal Weight")), ["Estimated Fetal Weight", "1.0", "kg"], "current Follow-Up writer also uses kg");

// Doctor's Order uses its own saved encounter field, never Plan/Treatment or prior instructions.
const order = "Synthetic instruction one.\nReturn for review as advised.\n<not-html> & follow the prescription.";
const followUpSave = await mountForm({ requestedType: "follow_up", prior: [makeRecord()] });
equal(followUpSave.field("doctor-order").props.value, "", "new Follow-Up order starts blank despite prior Initial order");
for (const [id, value] of [["chief-complaint", savedFields.chiefComplaint], ["assessment", savedFields.assessment],
  ["diagnosis", savedFields.diagnosis], ["treatment-plan", savedFields.treatmentPlan], ["doctor-order", order]]) {
  await followUpSave.change(id, value);
}
followUpSave.submit(); followUpSave.submit(); await followUpSave.settle();
const orderSaves = followUpSave.writes.filter(item => item.name === "save_appointment_visit_record");
equal(orderSaves.length, 1, "Follow-Up completion still coalesces duplicate save clicks");
equal(orderSaves[0].payload.p_visit_form_type, "follow_up", "same Follow-Up RPC contract");
equal(orderSaves[0].payload.p_form_data.doctorOrder, order, "actual save handler submits the exact multiline Doctor's Order");
equal(orderSaves[0].payload.p_form_data.treatmentPlan, savedFields.treatmentPlan, "Doctor's Order remains independent of treatment");
equal(orderSaves[0].payload.p_form_data.recordStatus, "completed", "completed record contract unchanged");
equal(orderSaves[0].payload.p_form_data.patientId, patient.id, "Follow-Up patient linkage unchanged");
equal(orderSaves[0].payload.p_form_data.appointmentId, schedule.id, "Follow-Up appointment linkage unchanged");
for (const key of ["gravida", "para", "full_term", "preterm", "abortion_miscarriage", "living_children", "last_menstrual_period", "registrationHistory", "obstetric"])
  equal(Object.hasOwn(orderSaves[0].payload.p_form_data, key), false, "read-only history stays outside saved encounter payload: " + key);
equal(followUpSave.navigation[0]?.path, "/doctor/appointments", "Follow-Up save navigation unchanged");
const savedFollowUp = serial(followUpSave.stored()); followUpSave.unmount();
const eddCorrection = await mountForm({ requestedType: "follow_up", record: savedFollowUp });
await eddCorrection.change("expected-delivery-date", "2027-01-09");
eddCorrection.submit(); await eddCorrection.settle();
equal(eddCorrection.writes.length, 0, "changed encounter EDD still requires confirmation before any write");
check(renderToStaticMarkup(eddCorrection.history()).includes("January 6, 2027"), "editing EDD never changes stored history preview");
const confirmEdd = nodes(eddCorrection.tree(), node => node.type === "button" && node.props.children === "Update EDD")[0];
check(Boolean(confirmEdd), "existing EDD confirmation is retained");
confirmEdd.props.onClick(); await eddCorrection.settle();
const sync = eddCorrection.writes.find(row => row.name === "sync_doctor_visit_pregnancy_state");
equal(sync?.payload.p_expected_delivery_date, "2027-01-09", "explicit confirmation still synchronizes edited EDD");
equal(sync?.payload.p_obstetric_history_id, obstetric.id, "EDD synchronization keeps exactly the resolved history ID");
equal(eddCorrection.writes.filter(row => row.kind === "update").length, 1, "EDD correction updates only the existing encounter"); eddCorrection.unmount();
equal(savedFollowUp.form_data.doctorOrder, order, "mock JSON persistence round trip preserves exact order");
const reopenedFollowUp = await mountForm({ requestedType: "follow_up", record: savedFollowUp, prior: [makeRecord()] });
equal(reopenedFollowUp.field("doctor-order").props.value, order, "saved Follow-Up form rehydrates Doctor's Order");
equal(reopenedFollowUp.writes.length, 0, "reopening does not rewrite clinical records"); reopenedFollowUp.unmount();
const mappedFollowUp = map(savedFollowUp);
equal(mappedFollowUp.doctorOrder, order, "Medical Record mapper retains the saved order exactly");
const followUpHtml = renderToStaticMarkup(React.createElement(reader.MedicalRecordEntry, { record: mappedFollowUp }));
check(followUpHtml.includes("<h4>Doctor&#x27;s Order</h4>"), "actual completed Follow-Up JSX labels Doctor's Order");
check(followUpHtml.includes("Synthetic instruction one.\nReturn for review as advised.\n&lt;not-html&gt; &amp; follow the prescription."), "render preserves line breaks and escapes clinical text");
check(!followUpHtml.includes("<not-html>"), "clinical instructions are rendered as text, not markup");
for (const value of [savedFields.chiefComplaint, savedFields.assessment, savedFields.diagnosis, savedFields.treatmentPlan])
  check(followUpHtml.includes(value), "existing Follow-Up content preserved: " + value);
for (const visitFormType of ["initial", "follow_up"]) {
  for (const missing of [undefined, null, "", " \n ", false, {}, []]) {
    const row = makeRecord({ visitFormType, doctorOrder: missing });
    const original = JSON.stringify(row);
    const html = renderToStaticMarkup(React.createElement(reader.MedicalRecordEntry, { record: map(row) }));
    check(/<h4>Doctor&#x27;s Order<\/h4><p class="mr-medical-doctor-order">\s*Not recorded\s*<\/p>/.test(html), visitFormType + ": missing/malformed order displays Not recorded");
    equal(JSON.stringify(row), original, "display never backfills an absent historical order");
  }
}
for (const visitFormType of ["initial", "follow_up"]) {
  for (const value of ["Previously saved synthetic order", "None"]) {
    const legacy = makeRecord({ visitFormType, doctorOrder: value });
    equal(map(legacy).doctorOrder, value, "existing explicit instructions remain visible, including an explicit None");
    equal(map({ ...legacy, form_data: JSON.stringify(legacy.form_data) }).doctorOrder, value, "existing serialized form_data remains supported");
  }
}
const differentVisit = map(makeRecord({ visitFormType: "follow_up", doctorOrder: "Different encounter order" }));
equal(differentVisit.doctorOrder, "Different encounter order", "each encounter uses its own order");
equal(mappedFollowUp.doctorOrder, order, "mapping a different encounter does not replace the selected visit's order");
const recordColumns = parseSource(recordSource).body.find(node => node.type === "VariableDeclaration" && node.declarations[0].id.name === "medicalRecordColumns");
check(recordColumns.declarations[0].init.value.split(",").map(value => value.trim()).includes("form_data"), "existing Medical Record SELECT includes the saved JSON");
const recordCss = await readFile(new URL("src/styles/medical_records.css", root), "utf8");
check(/\.mr-medical-entry-content \.mr-medical-doctor-order\s*\{[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;/.test(recordCss), "only Doctor's Order preserves newlines and wraps long instructions");
const html = renderToStaticMarkup(React.createElement(reader.MedicalRecordEntry, { record: mapped }));
check(html.includes("<h4>Doctor&#x27;s Order</h4><p class=\"mr-medical-doctor-order\">Synthetic doctor&#x27;s order</p>"), "completed Initial Visit displays its own saved Doctor's Order");
// Recreate the reader module and JSON response to model a fresh read/reopen.
const refreshedReader = await load(recordSource + readerExports, "Doctor_Medical_Records-refresh.jsx");
const initialOrder = "Initial encounter instructions.\n<initial-only> & prescribed care.";
const encounterRows = [
  { ...makeRecord({ doctorOrder: initialOrder }), id: "initial-order-record", schedule_id: "initial-order-appointment" },
  { ...savedFollowUp, id: "follow-up-order-record", schedule_id: "follow-up-order-appointment" },
  { ...makeRecord({ doctorOrder: undefined, treatmentPlan: "Treatment must not become an order" }), id: "missing-order-record", schedule_id: "missing-order-appointment" },
];
const originalEncounters = JSON.stringify(encounterRows);
const expectedOrders = ["Initial encounter instructions.\n&lt;initial-only&gt; &amp; prescribed care.",
  "Synthetic instruction one.\nReturn for review as advised.\n&lt;not-html&gt; &amp; follow the prescription.", "Not recorded"];
for (const [index, encounter] of encounterRows.entries()) {
  const beforeRefresh = map(encounter);
  const refreshed = refreshedReader.mapSupabaseMedicalRecord(serial(encounter), patient,
    new Map([[schedule.doctor_id, "Synthetic Doctor"]]), new Map([[schedule.id, schedule]]));
  const firstHtml = renderToStaticMarkup(React.createElement(reader.MedicalRecordEntry, { record: beforeRefresh }));
  const refreshedHtml = renderToStaticMarkup(React.createElement(refreshedReader.MedicalRecordEntry, { record: refreshed }));
  const paragraph = /<p class="mr-medical-doctor-order">([\s\S]*?)<\/p>/;
  equal(firstHtml.match(paragraph)?.[1], expectedOrders[index], "encounter-specific order, escaping and fallback: " + encounter.id);
  equal((firstHtml.match(/<h4>Doctor&#x27;s Order<\/h4>/g) || []).length, 1, "exactly one Doctor's Order section per encounter");
  equal(refreshedHtml, firstHtml, "fresh reader/JSON reload retains the same encounter's output: " + encounter.id);
  equal(refreshed.id, encounter.id, "refreshed output retains exact encounter identity");
  const orderPosition = firstHtml.indexOf("<h4>Doctor&#x27;s Order</h4>");
  check(firstHtml.indexOf("<h4>Diagnosis</h4>") < orderPosition && firstHtml.indexOf("<h4>Plan / Treatment</h4>") < orderPosition,
    "order remains after Diagnosis and Plan/Treatment");
  if (beforeRefresh.vaccinations.length) {
    check(orderPosition < firstHtml.indexOf("<h4>Vaccinations</h4>"), "order remains before saved Vaccinations");
  } else {
    check(!firstHtml.includes("<h4>Vaccinations</h4>"), "order display does not add unrelated vaccination data");
  }
}
equal(JSON.stringify(encounterRows), originalEncounters, "mapping, rendering and refreshing never modify historical encounter JSON");
check(html.includes("<strong>1.0</strong><span>kg</span>"), "actual Medical Record JSX renders 1.0 kg without conversion");
check(html.includes("<dt>Gestational Age</dt><dd>27 Weeks</dd>"), "actual Medical Record JSX renders numeric gestational age with units");
check(html.includes("<dt>Expected Delivery Date</dt><dd>Not recorded</dd>"), "unsaved legacy EDD remains Not recorded in the reader");
for (const value of ["TEST-00159", "Synthetic Doctor", "completed", savedFields.chiefComplaint, savedFields.assessment, "110/70", "58", "36.7", "18", "160", "22.7", "145", "Cephalic", "Active / Present", "Low Risk", savedFields.diagnosis, savedFields.treatmentPlan, "Tdap", "TEST-TDAP-001", "2026-10-07"])
  check(html.includes(value), "existing Medical Record output preserved: " + value);
for (const [value, expected] of [["27", "27 Weeks"], [27, "27 Weeks"], ["27 weeks", "27 Weeks"], ["27 Weeks", "27 Weeks"], [" 27 WEEKS ", "27 Weeks"], ["27 weeks 2 days", "27 Weeks 2 Days"], [0, "0 Weeks"], ["", "Not recorded"], [null, "Not recorded"], [undefined, "Not recorded"], [" ", "Not recorded"], ["n/a", "Not recorded"], ["Not recorded", "Not recorded"], ["-", "Not recorded"]]) {
  const item = { ...mapped, gestationalAge: value, obstetric: [["Gestational Age", value]] };
  const actual = renderToStaticMarkup(React.createElement(reader.MedicalRecordEntry, { record: item }));
  equal((actual.match(new RegExp(`<dt>Gestational Age</dt><dd>${expected}</dd>`, "g")) || []).length, 2, "both Medical Record GA cells format consistently: " + value);
  equal(item.gestationalAge, value, "display does not rewrite stored GA");
}
const correctedReader = map(makeRecord({ expectedDeliveryDate: "2027-01-06" }));
equal(correctedReader.obstetric.find(([label]) => label === "Expected Delivery Date")[1], "2027-01-06", "saved EDD reaches the Medical Record reader unchanged");
for (const data of [{ estimated_fetal_weight: "1000" }, { clinicalFindings: { estimatedFetalWeight: "1000" } }, { findings: [["Estimated Fetal Weight", "1000", "g"]] }]) {
  const row = makeRecord(); delete row.form_data.estimatedFetalWeight; Object.assign(row.form_data, data);
  equal(serial(map(row).findings.find(([label]) => label === "Estimated Fetal Weight")), ["Estimated Fetal Weight", "1000", "g"], "legacy fetal-weight gram contract preserved");
}
equal(JSON.stringify(sourceRecord), originalRecord, "all reader/display operations leave the saved record unchanged");
const prenatal = reader.buildPrenatalData(patient, { obstetric }, [mapped]);
equal(serial(prenatal.obstetricStats.map(([, value]) => value)), ["3", "2", "1", "1", "1", "2"], "G3 P2 T1 P1 A1 L2 unchanged");
equal(prenatal.currentPregnancyDetails[0][0][1], "April 01, 2026", "Prenatal LMP unchanged");
equal(prenatal.currentPregnancyDetails[0][1][1], "January 06, 2027", "Prenatal registration EDD unchanged even with legacy blank Doctor EDD");
equal(prenatal.currentPregnancyDetails[0][2][1], "27 Weeks", "Prenatal current GA unchanged");
check(renderToStaticMarkup(prenatal.currentPregnancyDetails[1][1][1]).includes("Low Risk"), "Prenatal risk unchanged");
equal(serial(prenatal.lifestyleRows.filter(([label]) => label !== "Occupation").map(([, value]) => value)), ["Never", "Never", "No", "Moderate", "Balanced"], "Prenatal lifestyle unchanged");
equal(serial(prenatal.immunizationRows), [["Tdap", "October 7, 2026"]], "Prenatal Tdap unchanged");
equal(prenatal.prenatalVisitRows.length, 1, "single prenatal visit row unchanged");
check(prenatal.prenatalVisitRows[0].includes("110/70 mmHg") && prenatal.prenatalVisitRows[0].includes("145 bpm"), "Prenatal visit clinical data unchanged");
console.log(`PASS: ${checks} Doctor visit/record mapping checks; actual load/save/JSX, mocked backend only; no network or production writes.`);
