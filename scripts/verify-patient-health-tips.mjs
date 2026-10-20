// Synthetic data and mock transports only. No clinical content, database or notification dispatch.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { getPatientHealthTips, selectDailyHealthTip } from "../src/lib/patientHealthTips.js";
import { getManilaDateKey } from "../src/lib/appointmentDate.js";

let assertions = 0;
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); assertions++; };
const row = (id, extra = {}) => ({ id, title: "Synthetic title", content: "Synthetic guidance",
  category: "Nutrition", is_active: true, patient_id: null, ...extra });
const rows = [row("a"), row("b"), row("c"), row("d")];
const tips = getPatientHealthTips(rows, "patient-a");
equal(tips.length, 4, "Four published database rows remain four, including distinct records with identical content");
equal(getPatientHealthTips([...rows, rows[0]], "patient-a").length, 4, "Duplicate row ID is displayed once");
equal(getPatientHealthTips(rows, "").length, 0, "No linked Patient yields no tips");
equal(getPatientHealthTips([row("own", { patient_id: "patient-a" }), row("other", { patient_id: "patient-b" }),
  row("name", { patient_id: "Synthetic Patient" })], "patient-a").map(tip => tip.id), ["own"], "Only internal Patient identity matches");
for (const extra of [{ is_active: false }, { is_active: null }, { content: " " }, { id: "" },
  { status: "archived" }, { status: "draft" }, { status: "pending" }, { archived_at: "2030-01-01" },
  { approval_status: "pending" }, { is_approved: false }]) {
  equal(getPatientHealthTips([row("rejected", extra)], "patient-a").length, 0, "Ineligible row excluded: " + JSON.stringify(extra));
}
equal(getPatientHealthTips([row("published", { status: "published", approval_status: "approved", display_schedule: "Weekly" })], "patient-a")[0].displaySchedule,
  "Weekly", "Doctor's non-daily display schedule is retained");
equal(getManilaDateKey("2026-10-18T15:59:59Z"), "2026-10-18", "Before Manila midnight");
equal(getManilaDateKey("2026-10-18T16:00:00Z"), "2026-10-19", "Manila date changes before UTC date");
equal(selectDailyHealthTip([], "2026-10-18"), null, "Empty library");
equal(selectDailyHealthTip(tips, "invalid"), null, "Invalid date");
equal(selectDailyHealthTip([{ ...tips[0], displaySchedule: "Weekly" }], "2026-10-18"), null, "Non-daily tips are not rescheduled");
for (const count of [1, 2, 4]) {
  const library = tips.slice(0, count);
  let previous;
  const seen = new Set();
  for (let day = 18; day < 26; day++) {
    const key = `2026-10-${day}`, selection = selectDailyHealthTip(library, key, previous);
    equal(selectDailyHealthTip([...library].reverse(), key, selection), selection, "Refresh/order stability");
    if (previous && count > 1) equal(selection.tipId !== previous.tipId, true, "Consecutive days do not repeat");
    seen.add(selection.tipId); previous = selection;
  }
  equal(seen.size, count, "Finite library cycles through all tips");
}
const today = selectDailyHealthTip(tips.slice(0, 2), "2026-10-18");
equal(selectDailyHealthTip(tips, "2026-10-18", today), today, "Newly published tips do not change today's selection");
const archived = tips.filter(tip => tip.id !== today.tipId);
equal(selectDailyHealthTip(archived, "2026-10-18", today).tipId !== today.tipId, true, "Archived selected tip is immediately replaced");
let future = today;const futureIds = new Set();
for (let day = 19; day < 24; day++) { future = selectDailyHealthTip(tips, `2026-10-${day}`, future);futureIds.add(future.tipId); }
equal(futureIds.has("c") && futureIds.has("d"), true, "New eligible tips enter future rotations");

// Exercise the unchanged Doctor management handlers against a write-capturing mock, never Supabase.
const doctor = await readFile(new URL("../src/pages/doctor/Doctor_Reminder.jsx", import.meta.url), "utf8");
const writes = [];
const noop = () => {};
const context = vm.createContext({ console, Date,
  healthTipForm: { title: "Synthetic title", category: "Nutrition", text: "Synthetic text", displaySchedule: "Daily" },
  healthTipFormMode: "add", editingHealthTipId: "synthetic-edit", validateHealthTipForm: () => true,
  loadAuthenticatedDoctor: async () => ({ authUser: { id: "synthetic-doctor" } }),
  setIsSavingHealthTip: noop, setHealthTipsMessage: noop, loadHealthTipRows: async () => {}, resetHealthTipForm: noop,
  setHealthTipFilter: noop, setIsHealthTipFormOpen: noop, setHealthTipManagementFilter: noop, showSuccessToast: noop,
  healthTipsTableName: "health_tips", supabase: { from(table) {
    const q = { insert(payload) { writes.push({ table, action: "insert", payload });return q; },
      update(payload) { writes.push({ table, action: "update", payload });return q; },
      eq() { return q; }, select() { return q; }, single() { return q; }, then(resolve) { return Promise.resolve({ data: { id: "synthetic-saved" }, error: null }).then(resolve); } };
    return q;
  } },
});
const handlers = doctor.slice(doctor.indexOf("  const saveHealthTip = async"), doctor.indexOf("  const deleteHealthTip = async"));
vm.runInContext(handlers + "\nglobalThis.save=saveHealthTip;globalThis.archive=updateHealthTipActiveState;", context);
await context.save({ preventDefault: noop });
equal(writes[0].action, "insert", "Doctor create retained");
equal(writes[0].payload[0].created_by, "synthetic-doctor", "Doctor ownership retained");
equal(writes[0].payload[0].is_active, true, "Existing publication contract retained");
context.healthTipFormMode = "edit";await context.save({ preventDefault: noop });
equal(writes[1].action, "update", "Doctor edit retained");
await context.archive({ id: "synthetic-saved", databaseBacked: true }, false);
equal(writes[2].payload.is_active, false, "Doctor archive retained");
await context.archive({ id: "synthetic-saved", databaseBacked: true }, true);
equal(writes[3].payload.is_active, true, "Doctor restore retained");
const countBefore = writes.length;await context.archive({ id: "local-unverified", databaseBacked: false }, false);
equal(writes.length, countBefore, "Unverified local entries cannot be managed as saved tips");
console.log(`PASS: ${assertions} health-tip assertions; authorized counts, publication/archive rules, Manila dates, finite daily rotation and unchanged Doctor management using mocked writes only.`);
