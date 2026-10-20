// Synthetic browser APIs only: never presents a real notification or contacts a backend.
import assert from "node:assert/strict";
import { sendPatientAppointmentBrowserReminder as send } from "../src/lib/patientAppointmentBrowserReminder.js";

let assertions = 0;
const equal = (actual, expected) => { assert.deepEqual(actual, expected); assertions++; };
const now = Date.parse("2030-10-18T01:00:00Z");
const reminder = { id: "synthetic-reminder", notifyAt: new Date(now).toISOString(),
  scheduleAt: new Date(now + 3600000).toISOString(), scheduleStatus: "scheduled", status: "Sent",
  message: "Synthetic appointment" };
const values = new Map(), calls = [];
const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
class MockNotification {
  static permission = "granted";
  constructor(title, options) { calls.push({ title, options }); }
}
const options = { reminder, patientId: "synthetic-patient", now, storage, notification: MockNotification, serviceWorker: null };
equal(await send(options), "shown");
equal(calls.length, 1);
equal(calls[0].title, "Appointment Reminder");
equal(calls[0].options.data.url, "/patient/reminders");
equal(calls[0].options.body, reminder.message);
equal(calls[0].options.tag.startsWith("maternal-appointment-browser-v1:"), true);
equal(await send({ ...options, reminder: { ...reminder } }), "already-presented");
equal(calls.length, 1);
// Fresh module models a reload: persistent storage still prevents duplicate presentation.
const { sendPatientAppointmentBrowserReminder: freshSend } = await import("../src/lib/patientAppointmentBrowserReminder.js?synthetic-reload");
equal(await freshSend(options), "already-presented");
equal(calls.length, 1);
equal(await send({ ...options, patientId: "another-synthetic-patient" }), "shown");
equal(await send({ ...options, reminder: { ...reminder, notifyAt: new Date(now - 1000).toISOString() } }), "shown");
equal(calls.length, 3);
for (const status of ["Expired", "Completed", "Cancelled", "Unavailable"]) {
  equal(await send({ ...options, reminder: { ...reminder, id: status, status } }), "not-due");
}
for (const scheduleStatus of ["completed", "cancelled", "no_show", "checked_in"]) {
  equal(await send({ ...options, reminder: { ...reminder, scheduleStatus } }), "not-due");
}
equal(await send({ ...options, now: now - 1 }), "not-due");
equal(await send({ ...options, now: now + 3600000 }), "not-due");
equal(await send({ ...options, patientId: "" }), "not-due");
equal(await send({ ...options, notification: null }), "unavailable");
const pending = { ...reminder, id: "pending", status: "Pending" };
MockNotification.permission = "denied";
equal(await send({ ...options, reminder: pending }), "unavailable");
MockNotification.permission = "granted";
equal(await send({ ...options, reminder: pending }), "shown");
// Concurrent effects/refreshes share the claim before the asynchronous worker lookup.
let release;
const worker = { getRegistration: () => new Promise(resolve => { release = resolve; }) };
const concurrent = { ...options, reminder: { ...pending, id: "concurrent" }, serviceWorker: worker };
const first = send(concurrent);
equal(await send(concurrent), "already-presented");
release({ showNotification: async (title, options) => calls.push({ title, options }) });
equal(await first, "shown");
const beforeFailure = calls.length;
const uncertain = { ...options, reminder: { ...pending, id: "uncertain" },
  serviceWorker: { getRegistration: async () => ({ showNotification: async () => { throw Error("Synthetic uncertain result"); } }) } };
equal(await send(uncertain), "uncertain");
equal(await send(uncertain), "already-presented");
equal(calls.length, beforeFailure); // No blind constructor fallback after worker presentation.
const blockedStorage = { getItem() { throw Error("Synthetic storage denial"); }, setItem() { throw Error("Synthetic storage denial"); } };
const blocked = { ...options, storage: blockedStorage, reminder: { ...pending, id: "blocked-storage" } };
equal(await send(blocked), "shown");
equal(await send(blocked), "already-presented");
equal(await send({ ...options, reminder: { ...pending, id: "lookup-failure" },
  serviceWorker: { getRegistration: async () => { throw Error("Synthetic lookup failure"); } } }), "shown");
console.log(`PASS: ${assertions} browser reminder assertions; timing/status policy, route/reload/concurrent deduplication, denied permission and uncertain outcomes. Mock APIs only.`);
