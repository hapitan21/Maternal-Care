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
  const module = new vm.SourceTextModule(code, { context });
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
async function mountForm({ staffEdd, record = null, patientEdd = "2027-01-06", registrationEdd = "2027-01-06", requestedType = "initial", prior = [] } = {}) {
  const runtime = hookRuntime(), writes = [], navigation = [];
  const original = JSON.stringify(record);
  let stored = record ? structuredClone(record) : null;
  const rowPatient = { ...patient, expected_delivery_date: patientEdd };
  const rowObstetric = { ...obstetric, expected_delivery_date: registrationEdd };
  const response = data => ({ data, error: null });
  function query(table, initial = null) {
    const filters = {}; let update = null;
    const result = () => {
      if (update) {
        assert.equal(table, "medical_records"); assert.equal(filters.id, stored.id); assert.equal(filters.schedule_id, schedule.id);
        writes.push({ kind: "update", table, payload: serial(update) }); stored = { ...stored, ...serial(update) };
        return response(stored);
      }
      if (initial) return response(initial);
      if (table === "schedule") return response(schedule);
      if (table === "medical_records") return response(filters.schedule_id ? stored : prior);
      if (table === "patient_obstetric_history") return response(rowObstetric);
      if (["patient_medical_history", "patient_initial_assessment"].includes(table)) return response(null);
      throw Error("Unexpected query: " + table);
    };
    return { select() { return this; }, eq(key, value) { filters[key] = value; return this; }, order() { return this; }, limit() { return this; },
      update(payload) { update = payload; return this; }, maybeSingle: async () => result(), then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); } };
  }
  const supabase = { from: query, rpc(name, payload) {
    if (name === "get_appointment_visit_form_type") return Promise.resolve(response({ visit_form_type: requestedType, appointment_status: stored ? "completed" : "checked_in" }));
    if (name === "get_doctor_patient_directory") return query("directory", rowPatient);
    if (name === "get_staff_visit_intake") return Promise.resolve(response({ id: "synthetic-intake", intake_data: { ...vitals, expectedDeliveryDate: staffEdd } }));
    if (name === "save_appointment_visit_record") {
      writes.push({ kind: "rpc", name, payload: serial(payload) });
      stored = makeRecord(payload.p_form_data);
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
  return { field, writes, navigation, submit, original, stored: () => stored,
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

const readerExports = "\nexport { mapSupabaseMedicalRecord, MedicalRecordEntry, buildPrenatalData };";
const reader = await load(recordSource + readerExports, "Doctor_Medical_Records.jsx");
const map = row => reader.mapSupabaseMedicalRecord(row, patient, new Map([[schedule.doctor_id, "Synthetic Doctor"]]), new Map([[schedule.id, schedule]]));
const sourceRecord = makeRecord({ expectedDeliveryDate: "", completedAt: "2026-10-07T02:00:00Z" });
const originalRecord = JSON.stringify(sourceRecord);
const mapped = map(sourceRecord);
equal(serial(mapped.findings.find(([label]) => label === "Estimated Fetal Weight")), ["Estimated Fetal Weight", "1.0", "kg"], "current form field retains 1.0 and matches kg writer contract");
const followUpRecord = map(makeRecord({ visitFormType: "follow_up" }));
equal(serial(followUpRecord.findings.find(([label]) => label === "Estimated Fetal Weight")), ["Estimated Fetal Weight", "1.0", "kg"], "current Follow-Up writer also uses kg");
const html = renderToStaticMarkup(React.createElement(reader.MedicalRecordEntry, { record: mapped }));
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
