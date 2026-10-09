import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";
import { parse } from "espree";
import {
  availabilityDayNames, getAvailabilityDayIndex, getAvailabilityDayOfWeek,
} from "../src/lib/availabilitySchedule.js";
import * as dates from "../src/lib/appointmentDate.js";

const zones = ["Asia/Manila", "UTC", "America/Los_Angeles"];
const zone = process.argv[process.argv.indexOf("--timezone") + 1];
if (!process.argv.includes("--timezone")) {
  const reports = zones.map(timeZone => {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--timezone", timeZone], {
      env: { ...process.env, TZ: timeZone }, encoding: "utf8", windowsHide: true,
    });
    if (child.error) throw child.error;
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return JSON.parse(child.stdout);
  });
  for (const report of reports) assert.deepEqual(report.staffSlots, reports[0].staffSlots,
    "Staff fallback results match across actual host timezones: " + report.zone);
  console.table(reports.map(({ zone: timeZone, assertions, monday }) => ({ timeZone, assertions, monday })));
  console.log("Availability calendar/Staff fallback verification passed: " +
    (reports.reduce((total, report) => total + report.assertions, 0) + reports.length * 2) + " assertions.");
  console.log("Actual helper and extracted production Staff loader/slot functions; synthetic read-only Supabase fixtures. No live database or browser verification.");
  process.exit(0);
}

let checks = 0;
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const plain = value => JSON.parse(JSON.stringify(value));
equal(process.env.TZ, zone, "Child process runs with requested host timezone");
equal(new Date("2026-10-12T00:00:00Z").getTimezoneOffset(),
  { "Asia/Manila": -480, UTC: 0, "America/Los_Angeles": 420 }[zone], "Host Date actually uses requested timezone");
equal(getAvailabilityDayOfWeek("2026-10-12"), 1, "2026-10-12 is Monday in every browser timezone");
equal(availabilityDayNames, ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], "Existing Sunday-zero weekday order");
for (let day = 0; day < 7; day++) {
  equal(getAvailabilityDayIndex(availabilityDayNames[day]), day, "Name/index roundtrip: " + day);
  equal(getAvailabilityDayIndex(" " + availabilityDayNames[day] + " "), day, "Existing trimmed weekday name support: " + day);
  equal(getAvailabilityDayOfWeek("2026-10-" + (11 + day)), day, "All seven date/weekday indexes: " + day);
}
for (const name of ["", "monday", "Funday", null, undefined]) equal(getAvailabilityDayIndex(name), -1, "Invalid names keep -1 sentinel");
for (const [date, weekday] of [
  ["0001-01-01", 1], ["0099-01-01", 4], ["1900-01-01", 1], ["2000-01-01", 6],
  ["2024-02-29", 4], ["2024-03-01", 5], ["2026-01-31", 6], ["2026-02-01", 0],
  ["2026-12-31", 4], ["2027-01-01", 5], ["2026-03-08", 0], ["2026-11-01", 0],
  ["9999-12-31", 5],
]) equal(getAvailabilityDayOfWeek(date), weekday, "Known Gregorian weekday and boundary: " + date);

// Independent Gregorian arithmetic oracle, avoiding Date construction/getters.
function gregorianWeekday(year, month, day) {
  const offsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const y = year - (month < 3 ? 1 : 0);
  return (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + offsets[month - 1] + day) % 7;
}
const dateKey = (year, month, day) => `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
for (const year of [1, 99, 1600, 1900, 2000, 2024, 2026, 2100, 2400, 9999]) {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (let month = 1; month <= 12; month++) {
    for (const day of [1, lengths[month - 1]]) equal(getAvailabilityDayOfWeek(dateKey(year, month, day)),
      gregorianWeekday(year, month, day), "Gregorian first/last day: " + dateKey(year, month, day));
    equal(getAvailabilityDayOfWeek(dateKey(year, month, lengths[month - 1] + 1)), -1,
      "Month overflow rejected: " + dateKey(year, month, lengths[month - 1] + 1));
    const nextYear = month === 12 ? year + 1 : year, nextMonth = month === 12 ? 1 : month + 1;
    if (nextYear <= 9999) equal(getAvailabilityDayOfWeek(dateKey(nextYear, nextMonth, 1)),
      (getAvailabilityDayOfWeek(dateKey(year, month, lengths[month - 1])) + 1) % 7,
      "Weekday advances across month/year boundary: " + dateKey(year, month, lengths[month - 1]));
  }
  equal(getAvailabilityDayOfWeek(dateKey(year, 2, 29)), leap ? gregorianWeekday(year, 2, 29) : -1,
    "Leap year/century acceptance: " + year);
}
for (const invalid of [
  "2026-02-30", "2026-02-29", "2026-04-31", "2026-00-12", "2026-13-12", "2026-01-00", "2026-01-32",
  "0000-01-01", "10000-01-01", "-2026-10-12", "2026-1-12", "2026-10-2", "26-10-12", "2026/10/12",
  "2026-10-12T00:00:00+08:00", "2026-10-12Z", "2026-10-12\n", "2026-10-12\r", " 2026-10-12", "2026-10-12 ",
  "", "not-a-date", null, undefined, 20261012, 0, NaN, true, new Date("2026-10-12T00:00:00Z"),
  ["2026-10-12"], new String("2026-10-12"), { toString() { throw Error("Do not coerce an invalid input"); } },
]) equal(getAvailabilityDayOfWeek(invalid), -1, "Invalid input is explicitly rejected without choosing a weekday");

// Execute the actual Staff RPC-first loader and slot functions, without mounting
// the page or touching a database. Only its existing read methods are available.
const staffSource = await readFile(new URL("../src/pages/staff/Staff_Patients.jsx", import.meta.url), "utf8");
const ast = parse(staffSource, { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true }, range: true });
function find(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const value of Object.values(node)) for (const child of Array.isArray(value) ? value : [value]) {
    const result = find(child, predicate); if (result) return result;
  }
  return null;
}
const names = ["defaultWalkInTimes", "inactiveAccountStatuses", "occupyingAppointmentStatuses", "isMissingWalkInRpcError",
  "logWalkInAvailabilityError", "normalizeWalkInSlots", "normalizeSlotStatus", "timeToMinutes", "isTimeWithinRange",
  "getManilaDateTime", "hasSlotPassed", "formatSlotTime", "mapDoctorDisplayName", "getDoctorSpecialization",
  "cleanText", "buildFallbackSlots", "loadWalkInAvailability"];
const declarations = names.map(name => {
  const node = find(ast, item => item.type === "FunctionDeclaration" && item.id?.name === name ||
    item.type === "VariableDeclaration" && item.declarations.some(entry => entry.id?.name === name));
  check(Boolean(node), "Extracted actual Staff production declaration: " + name);
  return staffSource.slice(...node.range);
}).join("\n");
async function staffFixture(selectedDate, rpcMode = "missing") {
  const state = { busy: false, error: "", doctors: [], selectedDoctorId: "", reads: [], rpc: [], errors: [], dayCalls: [] };
  const tables = {
    profiles: [{ id: "doctor-a", full_name: "Doctor A", role: "doctor", account_status: "active" },
      { id: "doctor-disabled", role: "doctor", account_status: "inactive" }],
    doctor_personal_information: [{ auth_user_id: "doctor-a", full_name: "Saved Doctor A" }],
    doctor_professional_information: [{ auth_user_id: "doctor-a", board_certification: "Prenatal" }],
    user_availability: [
      { profile_id: "doctor-a", day_of_week: 1, start_time: "08:00:00", end_time: "12:00:00", is_available: true },
      { profile_id: "doctor-a", day_of_week: 0, start_time: "13:00:00", end_time: "16:00:00", is_available: true },
      { profile_id: "doctor-a", day_of_week: 2, start_time: null, end_time: null, is_available: false },
      { profile_id: "doctor-disabled", day_of_week: 1, start_time: "08:00:00", end_time: "12:00:00", is_available: true },
    ],
    schedule: dates.toManilaISOString(selectedDate, "09:00") ? [
      { id: "kept-booking", doctor_id: "doctor-a", start_time: dates.toManilaISOString(selectedDate, "09:00"), status: "scheduled" },
      { id: "cancelled-booking", doctor_id: "doctor-a", start_time: dates.toManilaISOString(selectedDate, "10:30"), status: "cancelled" },
    ] : [],
  };
  const before = JSON.stringify(tables);
  const supabase = {
    async rpc(name, payload) {
      state.rpc.push({ name, payload });
      if (rpcMode === "ok") return { data: [{ doctor_id: "rpc-doctor", doctor_name: "RPC Doctor", slots: [], daily_capacity: 4, remaining_slots: 3 }], error: null };
      return { data: null, error: { code: rpcMode === "missing" ? "PGRST202" : "42501", message: "Synthetic RPC response" } };
    },
    from(table) {
      const entry = { table, filters: [] };state.reads.push(entry);
      const query = {
        select() { return query; },
        ilike(column, value) { entry.filters.push(["ilike", column, value]);return query; },
        eq(column, value) { entry.filters.push(["eq", column, value]);return query; },
        gte(column, value) { entry.filters.push(["gte", column, value]);return query; },
        lt(column, value) { entry.filters.push(["lt", column, value]);return query; },
        then(resolve, reject) {
          const data = tables[table].filter(row => entry.filters.every(([operation, column, value]) =>
            operation === "eq" ? row[column] === value : operation === "ilike" ? row[column]?.toLowerCase() === value.toLowerCase() :
              operation === "gte" ? Date.parse(row[column]) >= Date.parse(value) : Date.parse(row[column]) < Date.parse(value)));
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const context = vm.createContext({ ...dates, selectedDate, active: true, supabase,
    getManilaDateKey: (value = "2026-10-10T00:00:00Z") => dates.getManilaDateKey(value),
    getAvailabilityDayOfWeek: value => { const day = getAvailabilityDayOfWeek(value);state.dayCalls.push(day);return day; },
    setIsLoadingWalkInSlots: value => { state.busy = value; },setWalkInError: value => { state.error = value; },
    setDoctors: value => { state.doctors = value; },
    setSelectedDoctorId: update => { state.selectedDoctorId = update(state.selectedDoctorId); },
    console: { error: (...values) => state.errors.push(values) },
  });
  const load = new vm.Script(declarations + "\nloadWalkInAvailability;").runInContext(context);
  await load();equal(JSON.stringify(tables), before, "Staff loader does not mutate persisted appointment/availability fixtures");
  return state;
}
const monday = await staffFixture("2026-10-12");
equal(monday.dayCalls, [1], "Staff fallback resolves Monday availability");
equal(monday.reads.find(read => read.table === "user_availability").filters, [["eq", "day_of_week", 1]], "Staff availability query retains correct weekday filter");
equal(plain(monday.rpc[0]), { name: "get_walkin_registration_availability", payload: { p_slot_date: "2026-10-12" } }, "RPC calendar-date payload is unchanged");
equal(monday.busy, false, "Fallback completes loading");equal(monday.error, "", "Valid fallback has no error");
equal(monday.doctors.length, 1, "Inactive Doctors remain excluded");
const doctor = monday.doctors[0];
equal(doctor.name, "Saved Doctor A", "Existing Doctor identity/display mapping remains intact");
equal(doctor.dailyCapacity, 4, "Working hours keep existing slot capacity");equal(doctor.scheduledCount, 1, "Scheduled status continues occupying a slot");
equal(doctor.remainingSlots, 3, "Cancelled status preserves available capacity");
equal(plain(doctor.slots.map(slot => [slot.time, slot.status, slot.appointmentId])), [
  ["08:00", "available", ""], ["09:00", "full", "kept-booking"], ["10:30", "available", ""], ["11:30", "available", ""],
], "Existing times/statuses/appointment links remain unchanged");
const sunday = await staffFixture("2026-10-11");
equal(sunday.dayCalls, [0], "Sunday-zero contract remains compatible");
equal(plain(sunday.doctors[0].slots.map(slot => slot.time)), ["13:00", "14:30", "15:30"], "Sunday resolves only Sunday working hours");
const closed = await staffFixture("2026-10-13");
equal(closed.dayCalls, [2], "Closed Tuesday uses existing index");equal(closed.doctors[0].dailyCapacity, 0, "Closed availability yields no slots");
equal(closed.doctors[0].scheduledCount, 1, "Closed availability does not remove an existing appointment");
for (const invalid of ["2026-02-30", "2026-02-29", "2026-13-12", "not-a-date"]) {
  const state = await staffFixture(invalid);
  equal(state.dayCalls, [-1], "Invalid fallback input keeps existing -1 sentinel: " + invalid);
  equal(state.doctors.flatMap(item => item.slots).length, 0, "Invalid input cannot silently resolve slots from another weekday: " + invalid);
  equal(state.busy, false, "Invalid fallback input completes safely: " + invalid);
}
for (const mode of ["ok", "denied"]) {
  const state = await staffFixture("2026-10-12", mode);
  equal(state.reads.length, 0, "Normal/denied RPC never enters fallback: " + mode);
  equal(state.dayCalls.length, 0, "Normal/denied RPC does not invoke the date helper: " + mode);
  equal(state.busy, false, "RPC result completes loading: " + mode);
  if (mode === "ok") equal(state.doctors[0].id, "rpc-doctor", "Successful RPC retains authoritative result");
  else check(Boolean(state.error), "Denied RPC retains error handling without fallback access");
}
console.log(JSON.stringify({ zone, assertions: checks, monday: getAvailabilityDayOfWeek("2026-10-12"),
  staffSlots: plain({ monday: doctor.slots, sunday: sunday.doctors[0].slots }) }));
