import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { test } from "node:test";
import { verifyAppointmentReminderSql } from "./verify-appointment-reminder-sql.mjs";
import {
  APPOINTMENT_REMINDER_LEAD_GUIDANCE,
  clinicReminderLocalToISOString,
  getAppointmentReminderNotifyAt,
  getAppointmentReminderTimingError,
  getAppointmentReminderStatusLabel,
  isLocalAppointmentReminderDue,
} from "../src/lib/appointmentReminder.js";

const start = "2026-10-03T06:00:00Z";
const now = Date.parse("2026-10-03T05:30:00Z");
for (const [label, due, expected] of [
  ["exact ten-minute boundary", "05:50:00", ""],
  ["nine minutes fifty-nine seconds", "05:50:01", APPOINTMENT_REMINDER_LEAD_GUIDANCE],
  ["five minutes", "05:55:00", APPOINTMENT_REMINDER_LEAD_GUIDANCE],
  ["one minute", "05:59:00", APPOINTMENT_REMINDER_LEAD_GUIDANCE],
  ["appointment start", "06:00:00", APPOINTMENT_REMINDER_LEAD_GUIDANCE],
  ["after appointment start", "06:01:00", APPOINTMENT_REMINDER_LEAD_GUIDANCE],
  ["past reminder", "05:29:59", "Choose a reminder time in the future."],
  ["reminder equal to now", "05:30:00", "Choose a reminder time in the future."],
]) {
  test("new scheduling: " + label, () => {
    assert.equal(getAppointmentReminderTimingError("2026-10-03T" + due + "Z", start, now), expected);
  });
}

test("invalid dates fail safely", () => {
  assert.equal(getAppointmentReminderTimingError("invalid", start, now), "Choose a valid reminder date and time.");
  for (const value of ["", "2026-02-30T12:00", "2026-10-03T24:00", "2026-10-03T13:60", "2026-10-03T13:59Z"]) {
    assert.equal(clinicReminderLocalToISOString(value), "");
  }
});

test("clinic input is stable in Manila, UTC and New York device timezones", () => {
  const helperUrl = new URL("../src/lib/appointmentReminder.js", import.meta.url).href;
  const script = "import {clinicReminderLocalToISOString,getAppointmentReminderNotifyAt} from "
    + JSON.stringify(helperUrl) + ";console.log(JSON.stringify(["
    + "clinicReminderLocalToISOString('2026-10-03T13:59'),"
    + "clinicReminderLocalToISOString('2026-10-04T00:05'),"
    + "getAppointmentReminderNotifyAt({scheduleAt:'2026-10-03T16:05:00Z'},'1hour'),"
    + "getAppointmentReminderNotifyAt({scheduleDate:'2026-10-04',scheduleTime:'00:05'},'1hour')"
    + "]));";
  for (const TZ of ["Asia/Manila", "UTC", "America/New_York"]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      env: { ...process.env, TZ }, encoding: "utf8", windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      "2026-10-03T05:59:00.000Z", "2026-10-03T16:05:00.000Z",
      "2026-10-03T15:05:00.000Z", "2026-10-03T15:05:00.000Z",
    ]);
  }
});

test("clinic-local seconds preserve the lead-time boundary", () => {
  const due = clinicReminderLocalToISOString("2026-10-03T13:50:01");
  assert.equal(due, "2026-10-03T05:50:01.000Z");
  assert.equal(getAppointmentReminderTimingError(due, start, now), APPOINTMENT_REMINDER_LEAD_GUIDANCE);
});

test("custom conversion and preset offsets use the same absolute appointment instant", () => {
  const appointment = { scheduleAt: start };
  assert.equal(getAppointmentReminderNotifyAt(appointment, "custom", "2026-10-03T13:50"), "2026-10-03T05:50:00.000Z");
  for (const [lead, hours] of [["1hour", 1], ["1day", 24], ["3days", 72], ["3weeks", 504]]) {
    assert.equal(Date.parse(getAppointmentReminderNotifyAt(appointment, lead)), Date.parse(start) - hours * 3600000);
  }
});

for (const [status, label] of [["pending", "Pending"], ["sent", "Sent"], ["completed", "Completed"],
  ["cancelled", "Cancelled"], ["expired", "Expired"], ["unexpected", "Unavailable"]]) {
  test("Patient appointment status: " + status, () => {
    assert.equal(getAppointmentReminderStatusLabel(status), label);
    assert.equal(getAppointmentReminderStatusLabel(" " + status.toUpperCase() + " "), label);
  });
}

const reminder = { status: "Pending", notifyAt: "2026-10-03T05:59:00Z", scheduleAt: start, scheduleStatus: "scheduled" };
test("existing legacy one-minute reminder remains locally eligible before cutoff", () => {
  assert.equal(isLocalAppointmentReminderDue(reminder, Date.parse(reminder.notifyAt)), true);
  assert.equal(isLocalAppointmentReminderDue(reminder, Date.parse(start) - 1), true);
});
test("local scheduling excludes not-yet-due, started and ended appointments", () => {
  assert.equal(isLocalAppointmentReminderDue(reminder, Date.parse(reminder.notifyAt) - 1), false);
  assert.equal(isLocalAppointmentReminderDue(reminder, Date.parse(start)), false);
  assert.equal(isLocalAppointmentReminderDue(reminder, Date.parse(start) + 3600000), false);
});
for (const status of ["Expired", "Cancelled", "Completed", "Missed", "Unavailable"]) {
  test("local notification excludes " + status, () => {
    assert.equal(isLocalAppointmentReminderDue({ ...reminder, status }, Date.parse(reminder.notifyAt)), false);
  });
}
for (const scheduleStatus of ["cancelled", "completed", "no_show", "checked_in", "unexpected"]) {
  test("local notification excludes appointment " + scheduleStatus, () => {
    assert.equal(isLocalAppointmentReminderDue({ ...reminder, scheduleStatus }, Date.parse(reminder.notifyAt)), false);
  });
}
test("successful pre-start local presentation remains available", () => {
  assert.equal(isLocalAppointmentReminderDue({ ...reminder, status: "Sent" }, Date.parse(reminder.notifyAt)), true);
});
test("browser clock skew cannot be mistaken for backend enforcement", () => {
  const due = "2026-10-03T05:50:00Z";
  assert.equal(getAppointmentReminderTimingError(due, start, Date.parse("2026-10-03T05:49:00Z")), "");
  assert.equal(getAppointmentReminderTimingError(due, start, Date.parse("2026-10-03T05:51:00Z")), "Choose a reminder time in the future.");
});
test("active UI wires validation before persistence and guards the notification timer", () => {
  const doctor = readFileSync(new URL("../src/pages/doctor/Doctor_Reminder.jsx", import.meta.url), "utf8");
  const patient = readFileSync(new URL("../src/pages/patient/Patient_PWA_Reminder.jsx", import.meta.url), "utf8");
  const submit = doctor.slice(doctor.indexOf("const handleSubmit = async"));
  assert.ok(submit.indexOf("getAppointmentReminderTimingError(notifyAt, scheduleAt)") < submit.indexOf(".insert([payload])"));
  assert.ok(submit.includes("if (timingError) throw new Error(timingError)"));
  assert.ok(doctor.includes("APPOINTMENT_REMINDER_LEAD_GUIDANCE} Times are in Manila."));
  assert.ok(doctor.includes('aria-describedby="appointment-reminder-lead-guidance"'));
  assert.ok(patient.includes("status: getAppointmentReminderStatusLabel(row.status)"));
  assert.ok(patient.includes("isLocalAppointmentReminderDue(reminder, now)"));
  assert.doesNotMatch(patient, /formatDatabaseReminderStatus/);
});

test("backend source preserves the supplied deployed configured/fallback contracts", () => {
  verifyAppointmentReminderSql();
});
