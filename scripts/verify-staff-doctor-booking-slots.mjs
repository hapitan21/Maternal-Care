import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parse } from "espree";
import { getAvailabilityDayOfWeek, getAvailabilityWindowForDate } from "../src/lib/availabilitySchedule.js";
import { toManilaISOString } from "../src/lib/appointmentDate.js";

const source = readFileSync(new URL("../src/pages/staff/Staff_Appointments.jsx", import.meta.url), "utf8");
assert.equal((source.match(/get_staff_doctor_schedule_availability/g) || []).length, 3,
  "Staff form loading, calendar loading, and save-time verification use the scoped availability RPC");
assert.ok(!source.includes('.from("user_availability")'),
  "Staff no longer makes RLS-filtered direct reads from another Doctor's availability rows");
const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true }, range: true });
const names = ["isClosedStatus", "hasAppointmentConflict", "getAvailableAppointmentTimes", "getDoctorScheduleState", "getDoctorScheduleMessage"];
const declarations = names.map((name) => {
  const node = ast.body.find((item) => item.type === "FunctionDeclaration" && item.id.name === name);
  assert.ok(node, `Missing production function ${name}`);
  return source.slice(...node.range);
});
const context = {
  getAvailabilityWindowForDate,
  getAvailabilityDayOfWeek,
  clinicLocalDateTimeToISOString: (date, time, zone) => {
    assert.equal(zone, "Asia/Manila");
    return toManilaISOString(date, time);
  },
  Date,
  Number,
  String,
};
vm.runInNewContext(declarations.join("\n"), context);

const monday = "2026-10-26";
const sunday = "2026-10-25";
const policy = {
  timezone: "Asia/Manila",
  clinicOpeningTime: "06:00:00",
  clinicClosingTime: "18:00:00",
  defaultAppointmentDurationMinutes: 30,
};
const schedule = [
  { day_of_week: 1, start_time: "08:00:00", end_time: "12:00:00", is_available: true },
  { day_of_week: 0, start_time: null, end_time: null, is_available: false },
];
const slots = (overrides = {}) => Array.from(context.getAvailableAppointmentTimes({
  rows: schedule,
  date: monday,
  policy,
  appointments: [],
  editingAppointmentId: "",
  ...overrides,
}));

const normal = slots();
assert.equal(normal[0], "08:00");
assert.equal(normal.at(-1), "11:30");
assert.ok(!normal.includes("06:00"));
assert.ok(!normal.includes("12:00"));
assert.deepEqual(slots({ date: sunday }), []);
assert.deepEqual(slots({ rows: [] }), []);
assert.deepEqual(slots({ rows: null }), []);
assert.deepEqual(slots({ policy: null }), []);
assert.equal(slots({ rows: [{ ...schedule[0], start_time: "13:00:00", end_time: "17:00:00" }] })[0], "13:00");

const occupied = {
  id: "existing",
  status: "scheduled",
  startTime: toManilaISOString(monday, "09:00"),
  endTime: toManilaISOString(monday, "09:30"),
};
const withConflict = slots({ appointments: [occupied] });
assert.ok(!withConflict.includes("09:00"));
assert.ok(!withConflict.includes("08:45"));
assert.ok(withConflict.includes("09:30"));
assert.ok(slots({ appointments: [{ ...occupied, status: "Cancelled" }] }).includes("09:00"));
assert.ok(slots({ appointments: [occupied], editingAppointmentId: occupied.id }).includes("09:00"));
assert.equal(slots({ policy: { ...policy, defaultAppointmentDurationMinutes: 60 } }).at(-1), "11:00");
assert.equal(slots({ policy: { ...policy, clinicOpeningTime: "08:00:30" } })[0], "08:01");

const wednesday = "2026-11-04";
const savedWednesday = [{ ...schedule[0], profile_id: "doctor-a", day_of_week: 3 }];
assert.equal(getAvailabilityDayOfWeek(wednesday), 3);
assert.equal(context.getDoctorScheduleState(savedWednesday, wednesday, "doctor-a").kind, "available");
assert.equal(slots({ rows: savedWednesday, date: wednesday })[0], "08:00");
assert.equal(slots({ rows: savedWednesday, date: wednesday }).at(-1), "11:30");
assert.ok(!slots({ rows: savedWednesday, date: wednesday }).includes("07:00"));
assert.ok(!slots({ rows: savedWednesday, date: wednesday }).includes("12:00"));
const laterDoctor = [{ ...savedWednesday[0], profile_id: "doctor-b", start_time: "13:00:00", end_time: "17:00:00" }];
assert.equal(context.getDoctorScheduleState(laterDoctor, wednesday, "doctor-b").kind, "available");
assert.equal(slots({ rows: laterDoctor, date: wednesday })[0], "13:00");
const changedSchedule = [{ ...savedWednesday[0], start_time: "09:00:00", end_time: "11:00:00" }];
assert.equal(slots({ rows: changedSchedule, date: wednesday })[0], "09:00");
assert.equal(slots({ rows: changedSchedule, date: wednesday }).at(-1), "10:30");
const wednesdayConflict = { ...occupied, startTime: toManilaISOString(wednesday, "09:00"), endTime: toManilaISOString(wednesday, "09:30") };
assert.ok(!slots({ rows: savedWednesday, date: wednesday, appointments: [wednesdayConflict] }).includes("09:00"));
assert.ok(slots({ rows: savedWednesday, date: wednesday, appointments: [wednesdayConflict] }).includes("09:30"));
assert.equal(context.getDoctorScheduleState(savedWednesday, wednesday, "doctor-b").kind, "unverified");
assert.equal(context.getDoctorScheduleState([], wednesday, "doctor-a").kind, "unverified");
assert.equal(context.getDoctorScheduleState([{ ...savedWednesday[0], day_of_week: 1 }], wednesday, "doctor-a").kind, "missing-day");
assert.equal(context.getDoctorScheduleState([{ ...savedWednesday[0], is_available: false }], wednesday, "doctor-a").kind, "unavailable");
assert.equal(context.getDoctorScheduleState([{ ...savedWednesday[0], end_time: "07:00:00" }], wednesday, "doctor-a").kind, "invalid-hours");
assert.match(context.getDoctorScheduleMessage("unverified"), /could not be verified/);

console.log("Staff Doctor booking slot checks passed (synthetic data; no browser or database writes).");
