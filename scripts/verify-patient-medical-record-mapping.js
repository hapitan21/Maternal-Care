// Run: node scripts/verify-patient-medical-record-mapping.js
// Execute the real patient JSX with in-memory fixtures and a network-disabled client.
/* global process */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as vm from "node:vm";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithOxc } from "vite";
import * as clinical from "../src/lib/clinicalVisitData.js";

if (!vm.SourceTextModule) {
  const child = spawnSync(process.execPath, ["--experimental-vm-modules", ...process.argv.slice(1)], {
    stdio: "inherit", windowsHide: true,
  });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

const path = "src/pages/patient/Patient_PWA_MedicalRecords.jsx";
const source = await readFile(new URL("../" + path, import.meta.url), "utf8");
const extraExports = "\nexport { mapMedicalRecord, normalizeFinding, compareMedicalRecords, acceptMedicalRecordCache, buildRegistrationObstetricHistory, loadPatientDetailRow, MedicalRecordCard, RegistrationObstetricHistory };";
const code = (await transformWithOxc(source + extraExports, path, {
  jsx: { runtime: "automatic", development: false },
})).code;
const noNetwork = () => { throw Error("Unexpected network or write in Patient mapping fixture"); };
let assertions = 0;
let scenarios = 0;
const serial = value => JSON.parse(JSON.stringify(value));
const equal = (actual, expected, message) => {
  assert.deepEqual(serial(actual), serial(expected), message);
  assertions++;
};
const check = (value, message) => { assert.ok(value, message); assertions++; };
const scenario = async (name, run) => { await run(); scenarios++; console.log("PASS: " + name); };

async function load(overrides = {}) {
  const imports = {
    react: { default: React, ...React },
    "react/jsx-runtime": jsxRuntime,
    "@iconify/react": { Icon: () => null },
    "../../lib/clinicalVisitData": clinical,
    "../../lib/supabaseClient": { supabase: { from: noNetwork, rpc: noNetwork } },
    "../../components/patient/PatientPwaUi": { PatientPageHeader: () => null },
    "../../lib/patientPwaSessionCache": { getPatientPwaSessionCache: () => null, setPatientPwaSessionCache: noNetwork },
    "../../styles/patient-PWA-medicalrecords.css": {},
    ...overrides,
  };
  const context = vm.createContext({ console: { ...console, warn() {}, error() {} }, Date, Map, Set, URL,
    window: { setTimeout, clearTimeout } });
  const module = new vm.SourceTextModule(code, { context });
  await module.link(spec => {
    const values = imports[spec];
    if (!values) throw Error("Unexpected import " + spec);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}
const api = await load();
const record = (data = {}, row = {}) => ({
  id: "initial", patient_id: "own-patient", type: "Initial Visit", title: "Initial Visit",
  notes: "Unrelated complaint metadata", uploaded_at: "2026-10-09T03:00:00Z",
  created_at: "2026-10-09T03:00:00Z",
  ...row,
  form_data: { recordStatus: "completed", isDraft: false, visitFormType: "initial", ...data },
});
const map = (data, row, schedule, height) => api.mapMedicalRecord(record(data, row), schedule, height);
const finding = (mapped, label) => mapped.findings.find(item => item.label === label);
const html = mapped => renderToStaticMarkup(React.createElement(api.MedicalRecordCard, { record: mapped }));

await scenario("GA uses weeks consistently without rewriting saved values", () => {
  for (const [value, expected] of [["27", "27 Weeks"], [27, "27 Weeks"], [0, "0 Weeks"],
    ["27 Weeks", "27 Weeks"], ["27 weeks 3 days", "27 weeks 3 days"], ["27w 3d", "27w 3d"]]) {
    const row = record({ gestationalAge: value });
    const before = JSON.stringify(row);
    const mapped = api.mapMedicalRecord(row);
    equal(mapped.gestationalAge, expected, "header/search GA");
    equal(mapped.obstetric[0].value, expected, "obstetric GA");
    equal(JSON.stringify(row), before, "stored source unchanged");
    check(html(mapped).includes(expected), "GA rendered");
  }
  for (const value of ["", null, undefined, "-", "N/A", "Not provided"]) {
    const mapped = map({ gestationalAge: value });
    equal(mapped.gestationalAge, "Not recorded", "missing GA header");
    equal(mapped.obstetric[0].value, "-", "missing GA obstetric field");
  }
  for (const obstetric of [[{ label: "Gestational Age", value: "27" }], [["GA", 27]]]) {
    equal(map({ obstetric }).obstetric[0].value, "27 Weeks", "legacy obstetric GA");
  }
});

await scenario("current kg and legacy gram fetal weights preserve source units", () => {
  for (const [data, value, unit] of [
    [{ estimatedFetalWeight: "1.1" }, "1.1", "kg"],
    [{ estimatedFetalWeight: 1.1 }, "1.1", "kg"],
    [{ estimatedFetalWeight: 0 }, "0", "kg"],
    [{ estimated_fetal_weight: "1000" }, "1000", "g"],
    [{ clinicalFindings: { estimatedFetalWeight: "1000" } }, "1000", "g"],
    [{ clinical_findings: { estimated_fetal_weight: "1000" } }, "1000", "g"],
    [{ estimatedFetalWeight: "1000 g" }, "1000", "g"],
    [{ estimatedFetalWeight: "1.1kg" }, "1.1", "kg"],
    [{ estimatedFetalWeight: "1000", estimatedFetalWeightUnit: "g" }, "1000", "g"],
    [{ estimated_fetal_weight: { value: "1.1", unit: "kg" } }, "1.1", "kg"],
    [{ estimated_fetal_weight: "35", estimated_fetal_weight_unit: "oz" }, "35", "oz"],
  ]) {
    const mapped = map(data);
    equal(finding(mapped, "Estimated Fetal Weight"), { label: "Estimated Fetal Weight", value, unit }, "fetal weight and unit");
  }
  for (const value of ["", null, "N/A", "Not recorded"]) {
    check(!finding(map({ estimatedFetalWeight: value }), "Estimated Fetal Weight"), "no fake fetal weight");
  }
});

await scenario("finding tuples and objects preserve values, units, and numeric zero", () => {
  for (const item of [["Estimated Fetal Weight", "1000", "g"],
    { label: "Estimated Fetal Weight", value: "1000", unit: "g" }]) {
    equal(api.normalizeFinding(item), { label: "Estimated Fetal Weight", value: "1000", unit: "g" }, "compatible finding");
    equal(finding(map({ findings: [item] }), "Estimated Fetal Weight").unit, "g", "tuple mapping in real record");
  }
  equal(api.normalizeFinding(["Fundal Height", 0, "cm"]).value, "0", "zero is a saved value");
  equal(api.normalizeFinding({ name: "Respiratory Rate", result: 18 }).unit, "breaths/min", "known vital unit");
  equal(api.normalizeFinding(["Estimated Fetal Weight", "1000 g"]).unit, "g", "embedded explicit unit");
});

await scenario("Doctor's Order maps and renders only meaningful saved content", () => {
  for (const data of [{ doctorOrder: "Saved order: return for review." }, { doctor_order: "Saved order: return for review." }]) {
    const mapped = map(data);
    equal(mapped.doctorOrder, "Saved order: return for review.", "saved order alias");
    check(html(mapped).includes("Doctor&#x27;s Order") && html(mapped).includes(mapped.doctorOrder), "order section rendered");
  }
  for (const value of ["", null, "-", "Not recorded", "N/A"]) {
    const mapped = map({ doctorOrder: value });
    equal(mapped.doctorOrder, "", "blank optional order");
    check(!html(mapped).includes("Doctor&#x27;s Order"), "no empty order section");
  }
});

await scenario("current and legacy prescriptions retain medications and instructions", () => {
  const medication = { medication: "Fixture iron", dosage: "60 mg", frequency: "Daily", duration: "7 days", instructions: "After food" };
  equal(map({ medications: [medication], prescriptionInstructions: "Take as directed." }).prescriptions,
    ["Fixture iron - 60 mg - Daily - 7 days - After food", "Take as directed."], "current producer mapping");
  equal(map({ prescriptions: ["Legacy medicine 5 mg", "Legacy advice"] }).prescriptions,
    ["Legacy medicine 5 mg", "Legacy advice"], "legacy list retained");
  equal(map({ prescription: "Legacy prescription text" }).prescriptions, ["Legacy prescription text"], "legacy string retained");
  equal(map({ prescription: { medications: [medication], instructions: "Nested advice" } }).prescriptions,
    ["Fixture iron - 60 mg - Daily - 7 days - After food", "Nested advice"], "legacy object retained");
  equal(map({ prescriptions: { medications: [{ name: "Legacy drug", dose: "5 mg" }], instructions: "Legacy instructions" } }).prescriptions,
    ["Legacy drug - 5 mg", "Legacy instructions"], "plural object compatible");
  equal(map({ medications: [{ medication: "" }, {}], prescriptionInstructions: "", prescription: {}, prescriptions: [null, "-"] }).prescriptions,
    [], "empty prescriptions produce no fabricated entries");
  check(html(map({ medications: [medication] })).includes("Fixture iron"), "current medication rendered");
});

await scenario("diagnostic text maps across current, nested, snake_case, and legacy forms", () => {
  const expected = ["Laboratory: Saved lab result", "Ultrasound: Saved scan finding"];
  for (const data of [
    { laboratoryResultSummary: "Saved lab result", ultrasoundFindings: "Saved scan finding" },
    { laboratoryReview: { testType: "Metadata only", resultSummary: "Saved lab result" }, ultrasoundReview: { findings: "Saved scan finding" } },
    { laboratory_result_summary: "Saved lab result", ultrasound_findings: "Saved scan finding" },
    { laboratoryReview: "Saved lab result", ultrasoundReview: "Saved scan finding" },
    { laboratory_review: { result_summary: "Saved lab result" }, ultrasound_review: { findings: "Saved scan finding" } },
  ]) equal(map(data).diagnosticResults, expected, "diagnostic source compatibility");
  equal(map({ diagnosticResults: ["Legacy actual result"] }).diagnosticResults, ["Legacy actual result"], "legacy results retained");
  equal(map({ laboratoryReview: { testType: "CBC", interpretation: "Internal metadata" }, ultrasoundReview: { visitDate: "2026-10-01" } }).diagnosticResults,
    [], "generic metadata is not a result");
  equal(map({ laboratoryResultSummary: "", ultrasoundFindings: "-", diagnosticResults: ["N/A"] }).diagnosticResults,
    [], "blank result sections omitted");
  check(html(map({ laboratoryResultSummary: "Saved lab result" })).includes("Laboratory: Saved lab result"), "actual result rendered");
});

await scenario("clinical fields never borrow titles, notes, complaint, or assessment", () => {
  const mapped = map({ additionalNotes: "Unrelated notes", dangerSigns: "Unrelated assessment fallback" });
  equal(mapped.complaint, "No chief complaint recorded.", "complaint missing");
  equal(mapped.assessment, ["No assessment recorded."], "assessment missing");
  equal(mapped.diagnosis, "No diagnosis recorded.", "diagnosis is not Initial Visit");
  equal(mapped.treatment, ["No treatment plan recorded."], "plan missing");
  equal(map({ assessment: "Saved clinical assessment" }).diagnosis, "No diagnosis recorded.", "assessment is not diagnosis");
  equal(map({ chief_complaint: "Saved complaint", clinical_assessment: "Saved assessment", final_diagnosis: "Saved diagnosis", plan_treatment: "Saved treatment" }).assessment,
    ["Saved assessment"], "explicit assessment alias");
  equal(map({ final_diagnosis: "Saved diagnosis" }).diagnosis, "Saved diagnosis", "explicit diagnosis alias");
  equal(map({ plan_treatment: "Saved treatment" }).treatment, ["Saved treatment"], "explicit treatment alias");
  check(!html(mapped).includes("Unrelated complaint metadata"), "generic row notes not rendered as clinical information");
});

await scenario("saved follow-up EDD/risk and baseline height remain intact", () => {
  const mapped = map({ visitFormType: "follow_up", expectedDeliveryDate: "2027-01-06", riskLevel: "Low Risk", weight: "58", height: "" },
    { type: "Follow-Up Visit" }, null, "160");
  equal(mapped.visitType, "Follow-Up Visit", "distinct follow-up");
  equal(mapped.obstetric.find(item => item.label === "Expected Delivery Date").value, "2027-01-06", "saved EDD read");
  equal(mapped.obstetric.find(item => item.label === "Pregnancy Status").value, "Low Risk", "saved risk read");
  equal(finding(mapped, "Baseline Height").value, "160", "inherited historical height");
  check(!finding(mapped, "Height"), "baseline is not today's measurement");
  equal(finding(map({ visitFormType: "follow_up", height: "161" }, {}, null, "160"), "Height").value, "161", "explicit current height wins");
  equal(finding(map({ visitFormType: "follow_up", findings: [["Weight", "58", "kg"]] }, {}, null, "160"), "Baseline Height").value,
    "160", "tuple findings preserve baseline label");
});

await scenario("linked schedule and unlinked visit-date fallbacks retain Manila time", () => {
  const data = { appointmentDate: "2026-10-07", appointmentTime: "09:30", visitDate: "2026-09-01", visitTime: "08:00" };
  const unlinked = map(data);
  equal(unlinked.date, "October 7, 2026", "producer appointment date first");
  equal(unlinked.dayTime, "Wednesday - 09:30", "producer time preserved");
  equal(unlinked.sortTime, Date.parse("2026-10-07T09:30:00+08:00"), "clinic time defines effective sort time");
  const linked = map(data, {}, { start_time: "2026-10-08T02:00:00Z", doctor_name: "Fixture Doctor" });
  equal(linked.date, "October 8, 2026", "schedule authoritative");
  check(linked.dayTime.includes("10:00 AM"), "linked Manila time");
  equal(linked.doctor, "Fixture Doctor", "linked doctor unchanged");
  equal(map({ visitDate: "2026-09-01", visitTime: "08:00" }).date, "September 1, 2026", "legacy date fallback");
  equal(map({}).date, "October 9, 2026", "uploaded timestamp fallback");
  equal(map({}, { uploaded_at: null, created_at: "2026-10-08T01:00:00Z" }).date, "October 8, 2026", "created timestamp fallback");
  equal(map({}, { uploaded_at: null, created_at: null }).date, "-", "no fabricated date");
  equal(map({ appointmentDate: "2026-02-30", visitDate: "2026-09-01" }).date, "September 1, 2026", "invalid calendar date skipped");
  equal(map({ appointmentDate: "2026-10-07" }).dayTime, "Wednesday", "no invented midnight display");
  equal(map({ visitDate: "2026-10-07", visitTime: "9:30 AM" }).dayTime, "Wednesday - 9:30 AM", "legacy 12-hour time preserved");
  equal(map({ visitDate: "2026-10-07", visitTime: "9:30 PM" }).sortTime, Date.parse("2026-10-07T21:30:00+08:00"), "legacy PM time sorts correctly");
});

await scenario("newest-first order uses effective date, upload, creation, then stable ID", () => {
  const initial = map({ appointmentDate: "2026-10-07", appointmentTime: "09:30" }, { id: "initial", uploaded_at: "2026-10-07T03:00:00Z" });
  const follow = map({ appointmentDate: "2026-10-07", appointmentTime: "09:30", visitFormType: "follow_up" },
    { id: "follow", type: "Follow-Up Visit", uploaded_at: "2026-10-07T04:00:00Z" });
  for (const rows of [[initial, follow], [follow, initial]]) equal(rows.sort(api.compareMedicalRecords).map(item => item.id), ["follow", "initial"], "same-date visits stable");
  const sameA = { ...initial, id: "a" }, sameB = { ...initial, id: "b" };
  for (const rows of [[sameA, sameB], [sameB, sameA]]) equal(rows.sort(api.compareMedicalRecords).map(item => item.id), ["b", "a"], "ID tie-break");
  equal([sameB, { ...sameA, createdTime: initial.createdTime + 1 }].sort(api.compareMedicalRecords)[0].id, "a", "creation tie-break");
  equal([follow, { ...initial, sortTime: follow.sortTime + 1 }].sort(api.compareMedicalRecords)[0].id, "initial", "visit time remains primary");
});

const obstetric = { id: "selected-current", patient_id: "own-patient", gravida: 3, para: 2, full_term: 1, preterm: 1,
  abortion_miscarriage: 1, living_children: 2, last_menstrual_period: "2026-04-01", expected_delivery_date: "2027-01-06" };
await scenario("registration G/P/T/P/A/L and dates remain separate and unchanged", () => {
  equal(api.buildRegistrationObstetricHistory({}, obstetric).map(item => item.value),
    [3, 2, 1, 1, 1, 2, "April 1, 2026", "January 6, 2027"], "reference GTPAL mapping");
  equal(api.buildRegistrationObstetricHistory({}, { gravida: 0, para: 0, full_term: 0, preterm: 0, abortion_miscarriage: 0, living_children: 0 }).slice(0, 6).map(item => item.value),
    [0, 0, 0, 0, 0, 0], "zero counts preserved");
  check(api.buildRegistrationObstetricHistory({}, {}).every(item => item.value === "Not provided"), "unknown counts are not fabricated");
});

await scenario("report attachments preserve existing storage metadata", () => {
  const mapped = map({ laboratoryAttachment: { name: "lab.pdf", path: "own-patient/lab.pdf", size: 123, type: "application/pdf" },
    ultrasoundAttachment: { name: "scan.pdf", path: "own-patient/scan.pdf", size: 456, type: "application/pdf" } },
    { file_name: "legacy.pdf", file_data_url: "data:application/pdf;base64,fixture" });
  equal(mapped.attachments.map(item => [item.kind, item.name, item.path]),
    [["Laboratory", "lab.pdf", "own-patient/lab.pdf"], ["Ultrasound", "scan.pdf", "own-patient/scan.pdf"], ["Medical Record", "legacy.pdf", ""]], "report attachment compatibility");
});

function mockClient({ records = [], history = [obstetric], selectedId = obstetric.id, summaryPatientId = "own-patient", summaryError = null } = {}) {
  const calls = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "authenticated-user" } }, error: null }) },
    rpc(name) {
      calls.push(["rpc", name]);
      if (name === "get_my_patient_profile_summary") return Promise.resolve({ data: { patient: { id: summaryPatientId }, obstetric: selectedId ? { id: selectedId } : null }, error: summaryError });
      if (name !== "get_patient_own_record") return noNetwork();
      return { limit() { return this; }, maybeSingle: async () => ({ data: { id: "own-patient" }, error: null }) };
    },
    from(table) {
      const filters = {};
      const response = () => {
        const rows = table === "medical_records" ? records : table === "patient_obstetric_history" ? history : [];
        return { data: rows.filter(row => Object.entries(filters).every(([key, value]) => row[key] === value)), error: null };
      };
      const query = {
        select() { return query; },
        eq(key, value) { filters[key] = value; calls.push([table, key, value]); return query; },
        order() { return query; }, limit() { return query; }, in() { return query; },
        maybeSingle: async () => ({ ...response(), data: response().data[0] || null }),
        then(resolve, reject) { return Promise.resolve(response()).then(resolve, reject); },
      };
      return query;
    },
    channel() { const channel = { on() { return channel; }, subscribe() { return channel; } }; return channel; },
    removeChannel() {},
  };
  return { client, calls };
}

await scenario("obstetric row selection uses the existing RPC's chosen ID deterministically", async () => {
  const old = { ...obstetric, id: "older", gravida: 1 };
  for (const history of [[old, obstetric], [obstetric, old]]) {
    const mock = mockClient({ history });
    const reader = await load({ "../../lib/supabaseClient": { supabase: mock.client } });
    equal((await reader.loadPatientDetailRow("patient_obstetric_history", "own-patient")).id, "selected-current", "RPC-selected row fetched");
    check(mock.calls.some(call => call[0] === "patient_obstetric_history" && call[1] === "id" && call[2] === "selected-current"), "unique ID filter");
    check(mock.calls.some(call => call[0] === "patient_obstetric_history" && call[1] === "patient_id" && call[2] === "own-patient"), "ownership filter retained");
  }
  for (const options of [{ selectedId: null }, { summaryPatientId: "another-patient" }, { summaryError: { message: "Fixture error" } }]) {
    const mock = mockClient(options);
    const reader = await load({ "../../lib/supabaseClient": { supabase: mock.client } });
    let error = null;
    equal(await reader.loadPatientDetailRow("patient_obstetric_history", "own-patient", value => { error = value; }), null, "selection fails closed");
    check(!mock.calls.some(call => call[0] === "patient_obstetric_history"), "no arbitrary history fallback");
    equal(Boolean(error), Boolean(options.summaryPatientId || options.summaryError), "selection error surfaced appropriately");
  }
});

await scenario("cached drafts, deleted, non-completed and synthetic entries are filtered", () => {
  const entries = [api.mapMedicalRecord(record({}, { id: "completed" })),
    api.mapMedicalRecord(record({ recordStatus: "draft", isDraft: true }, { id: "draft" })),
    api.mapMedicalRecord(record({ deleted: true }, { id: "deleted" })),
    api.mapMedicalRecord(record({ recordStatus: "pending" }, { id: "pending" })),
    api.mapMedicalRecord(record({ is_draft: "yes" }, { id: "snake-draft" })),
    api.mapMedicalRecord(record({}, { id: "registration-own-patient" }))];
  const cache = { version: 2, patientRecords: entries, registrationHistory: { status: "ready", items: [] } };
  equal(api.acceptMedicalRecordCache(cache, "own-patient").patientRecords.map(item => item.id), ["completed"], "cache filtered");
  equal(api.acceptMedicalRecordCache(cache, "own-patient").registrationHistory, cache.registrationHistory, "registration cache unaffected");
  equal(cache.patientRecords.length, 6, "cache source not mutated");
  equal(api.acceptMedicalRecordCache({ patientRecords: entries }, "own-patient"), null, "old snapshots missing deletion flags refreshed");
});

function hookRuntime() {
  const slots = []; let cursor = 0, dirty = true, tree, component;
  const effects = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const memo = (factory, deps) => {
    const index = cursor++;
    if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { value: factory(), deps };
    return slots[index].value;
  };
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, value => { slots[index].value = typeof value === "function" ? value(slots[index].value) : value; dirty = true; }];
    },
    useRef: value => memo(() => ({ current: value }), []), useMemo: memo,
    useEffect(effect, deps) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) effects.push(() => {
        slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: effect() };
      });
    },
  };
  return {
    react, mount(fn) { component = fn; },
    render() { cursor = 0; dirty = false; tree = component(); return tree; },
    async settle() {
      for (let i = 0; i < 20; i++) {
        if (dirty) { this.render(); }
        for (const effect of effects.splice(0)) effect();
        await new Promise(resolve => setTimeout(resolve, 0));
        if (!dirty && !effects.length) return tree;
      }
      throw Error("Patient fixture failed to settle");
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}
async function mountPage(records, cache = null) {
  const runtime = hookRuntime();
  const mock = mockClient({ records });
  const snapshots = [];
  const page = await load({
    react: { default: React, ...React, ...runtime.react },
    "../../lib/supabaseClient": { supabase: mock.client },
    "../../lib/patientPwaSessionCache": {
      getPatientPwaSessionCache: () => cache,
      setPatientPwaSessionCache: (id, section, snapshot) => snapshots.push(snapshot),
    },
  });
  runtime.mount(() => page.default({ profile: { recordId: "own-patient" } }));
  const first = renderToStaticMarkup(runtime.render());
  const final = renderToStaticMarkup(await runtime.settle());
  runtime.unmount();
  return { first, final, snapshot: snapshots.at(-1), calls: mock.calls };
}
await scenario("real page filters fresh records before mapping and preserves separate registration", async () => {
  const rows = [record({}, { id: "completed" }), record({ recordStatus: "draft", isDraft: true }, { id: "draft" }),
    record({ deleted: "yes" }, { id: "deleted" }), record({ recordStatus: "pending" }, { id: "pending" })];
  const page = await mountPage(rows);
  equal(page.snapshot.patientRecords.map(item => item.id), ["completed"], "fresh loader completed only");
  equal(page.snapshot.version, 2, "safe snapshot version written");
  check(page.final.includes("Registration / Obstetric History") && page.final.includes("January 6, 2027"), "registration still loaded");
  check(page.calls.filter(call => call[1] === "patient_id").every(call => call[2] === "own-patient"), "auth-resolved ID for data reads");
  const empty = await mountPage([]);
  equal(empty.snapshot.patientRecords, [], "registration not fabricated into consultation");
  check(empty.final.includes("No medical records available yet"), "no-record state preserved");
});
await scenario("real first render never exposes a cached draft", async () => {
  const draft = api.mapMedicalRecord(record({ chiefComplaint: "CACHED-DRAFT-MARKER", recordStatus: "draft", isDraft: true }, { id: "draft" }));
  const page = await mountPage([], { version: 2, patientRecords: [draft], selectedRecordId: "draft", registrationHistory: { status: "ready", items: [] } });
  check(!page.first.includes("CACHED-DRAFT-MARKER"), "cached draft filtered before first paint");
  equal(page.snapshot.patientRecords, [], "draft not resaved into cache");
});

console.log(`Patient Medical Records regression summary: ${scenarios} scenarios; ${assertions} assertions passed. Mocked backend only; no network or production writes.`);
