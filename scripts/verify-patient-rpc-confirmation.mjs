// Offline only: actual source handlers, in-memory Supabase/React mocks, no output files.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { transformWithOxc } from "vite";
import * as appointmentDates from "../src/lib/appointmentDate.js";

let scenarios = 0;
let assertions = 0;
const check = (actual, expected, label) => {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, label);
  assertions++;
};
const scenario = async (name, run) => { await run(); scenarios++; console.log(`PASS: ${name}`); };
const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const reminder = await read("src/pages/patient/Patient_PWA_Reminder.jsx");
const profile = await read("src/pages/patient/Patient_PWA_ViewProfile.jsx");
const hook = await read("src/hooks/useSendPatientNotification.js");
const booking = await read("src/components/patient/PatientBookAppointment.jsx");
const part = (source, start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Missing source boundaries: ${start}`);
  return source.slice(a, b);
};
const forbidden = () => { throw Error("Unexpected offline fixture operation"); };
const runSource = (code, context) => vm.runInNewContext(code, { console: { error() {} }, ...context });
const patientId = "11111111-1111-4111-8111-111111111111";
const occurrenceId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const timestamp = "2026-10-17T01:02:03.000Z";
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function bookingFixture({ result = { data: { id: 123, request_id: 123, status: "pending" } },
  throws = false, authError = null, unavailable = false } = {}) {
  const state = { writes: 0, success: "", errors: [], busy: false, step: 4,
    selectedTime: "08:00", selectedDate: "2030-10-20", payload: null };
  const code = part(booking, "function normalizeBookingRequestId(value)", "const SERVICES =") +
    part(booking, "  const submitBooking =", "\n  if (submittedAppointmentId)") + "\nsubmitBooking;";
  const submit = runSource(code, {
    step: state.step, isEditingFromReview: false, hasValidBookingDetails: true, hasCurrentAvailability: true,
    selectedService: { id: "prenatal", databaseTitle: "Prenatal Check-up" },
    selectedDoctor: { id: otherId, databaseId: otherId, name: "Synthetic Doctor" }, selectedDoctorId: otherId,
    selectedDate: state.selectedDate, selectedTime: state.selectedTime, isSelectedTimeUnavailable: false,
    submitInFlightRef: { current: false }, unconfirmedBookingRef: { current: false },
    dateFromKey: value => new Date(`${value}T00:00:00`),
    setSubmitError: value => { if (value) state.errors.push(value); },
    setIsSubmitErrorSelectionBound: () => {}, setIsSubmitting: value => { state.busy = value; },
    setSubmittedAppointmentId: value => { state.success = value; },
    setSelectedTime: value => { state.selectedTime = value; }, setRejectedSlotKeys: update => update(new Set()),
    setSlotSelectionError: value => state.errors.push(value), setStep: value => { state.step = value; },
    getSlotKey: (...args) => args.join(":"), getReadableBookingError: () => "Booking rejected.",
    isUnavailableSlotError: () => unavailable, isSelectionBoundBookingError: () => false,
    supabase: {
      auth: { getUser: async () => ({ data: { user: { id: patientId } }, error: authError }) },
      rpc: async (name, payload) => { assert.equal(name, "create_patient_appointment_request");
        state.writes++; state.payload = payload; if (throws) throw Error("offline timeout"); return await result; },
      from: forbidden,
    },
  });
  return { state, submit };
}
for (const [id, requestId, expected] of [[123, 123, "123"], [123, "123", "123"], ["00123", "123", "123"],
  ["9007199254740993", "9007199254740993", "9007199254740993"],
  ["9223372036854775807", "9223372036854775807", "9223372036854775807"]]) {
  await scenario(`Booking validates pending bigint request ${expected}`, async () => {
    const f = bookingFixture({ result: { data: { id, request_id: requestId, status: "pending" } } });
    await f.submit(); check(f.state.success, expected); check(f.state.writes, 1); check(f.state.busy, false);
    check(f.state.payload.p_doctor_id, otherId); check(f.state.errors, []);
  });
}
const invalidBookings = [null, {}, [], [{ id: 123, request_id: 123, status: "pending" }],
  { id: 123, status: "pending" }, { request_id: 123, status: "pending" },
  { id: 124, request_id: 123, status: "pending" },
  { id: 123, request_id: 123, status: "rejected" }, { id: 123, request_id: 123, status: "scheduled" },
  { id: 123, request_id: 123 }, { schedule_id: otherId },
  ...[0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 9007199254740992, "9223372036854775808",
    "0", "-1", "1.5", "1e3", "abc", {}, otherId].map(value => ({ id: value, request_id: value, status: "pending" }))];
for (const [index, data] of invalidBookings.entries()) await scenario(`Booking rejects inconclusive receipt ${index + 1}`, async () => {
  const f = bookingFixture({ result: { data } }); await f.submit(); await f.submit();
  check(f.state.success, ""); check(f.state.writes, 1); check(f.state.busy, false);
  check(f.state.selectedTime, "08:00"); check(f.state.selectedDate, "2030-10-20"); check(f.state.step, 4);
  check(f.state.errors.every(message => message.includes("may have been saved")), true);
});
for (const options of [{ throws: true }, { result: { error: { message: "Failed to fetch" } } },
  { result: { error: { code: "40003", message: "statement completion unknown" } } }]) {
  await scenario("Booking transport uncertainty blocks subsequent mutation", async () => {
    const f = bookingFixture(options); await f.submit(); await f.submit();
    check(f.state.success, ""); check(f.state.writes, 1); check(f.state.step, 4);
  });
}
await scenario("Booking confirmed SQL rejection preserves existing slot recovery", async () => {
  const f = bookingFixture({ result: { error: { code: "P0001", message: "slot unavailable" } }, unavailable: true });
  await f.submit(); check(f.state.success, ""); check(f.state.step, 3); check(f.state.selectedTime, "");
  check(f.state.writes, 1);
});
await scenario("Booking denied session never reaches mutation", async () => {
  const f = bookingFixture({ authError: { message: "expired" } }); await f.submit();
  check(f.state.writes, 0); check(f.state.success, ""); check(f.state.busy, false);
});
await scenario("Booking authorization rejection never reports success", async () => {
  const f = bookingFixture({ result: { error: { code: "42501", message: "denied" } } }); await f.submit();
  check(f.state.writes, 1); check(f.state.success, ""); check(f.state.errors, ["Booking rejected."]);
});
await scenario("Booking synchronous duplicate-click protection", async () => {
  const pending = deferred(); const f = bookingFixture({ result: pending.promise });
  const first = f.submit(); await f.submit(); check(f.state.writes, 1);
  pending.resolve({ data: { id: 123, request_id: 123, status: "pending" } }); await first;
  check(f.state.success, "123"); check(f.state.busy, false);
});

function medicationFixture({ result = { data: [{ success: true, status: "taken" }] }, saved,
  readError = null, throwRpc = false, initialRows = [{ id: occurrenceId }] } = {}) {
  const state = { writes: 0, reads: 0, success: [], errors: [], rows: initialRows, busy: null };
  const row = saved === undefined ? { id: occurrenceId, patient_id: patientId, status: "taken", action_at: timestamp } : saved;
  const query = {
    select: () => query, eq: () => query,
    maybeSingle: async () => { state.reads++; return { data: row, error: readError }; },
  };
  const action = runSource(part(reminder, "  const handleMedicationOccurrenceAction =", "\n  useEffect(() => {" ) +
    "\nhandleMedicationOccurrenceAction;", {
    patientRecordId: patientId,
    medicationActionLockRef: { current: false }, submittedMedicationActionsRef: { current: new Map() },
    setSkipTarget: () => {}, setMedicationActionState: value => { state.busy = value; },
    setMedicationActionError: value => { if (value.message) state.errors.push(value.message); },
    dismissToast: () => {}, showSuccessToast: value => state.success.push(value),
    setMedicationOccurrences: update => { state.rows = update(state.rows); },
    supabase: {
      rpc: async () => { state.writes++; if (throwRpc) throw Error("offline transport"); return await result; },
      from: table => { assert.equal(table, "medication_reminder_occurrences"); return query; },
    },
  });
  return { state, act: (actionName = "taken", item = {}) => action({ occurrence: { id: occurrenceId },
    matchKey: "dose", patientId, ...item }, actionName, { confirmed: true }) };
}

for (const action of ["taken", "skipped"]) await scenario(`Medication ${action}: strict receipt and server timestamp`, async () => {
  const f = medicationFixture({ result: { data: [{ success: true, status: action }] },
    saved: { id: occurrenceId, patient_id: patientId, status: action, action_at: timestamp } });
  await f.act(action);
  check(f.state.success.length, 1); check(f.state.rows[0].actionAt, timestamp);
  check(f.state.rows[0].status, action); check(f.state.writes, 1); check(f.state.reads, 1);
});
for (const data of [null, [], [{ success: true, status: "taken" }, { success: true, status: "taken" }],
  [{ success: false, status: "taken" }], [{ success: "true", status: "taken" }],
  [{ success: true, status: "skipped" }], [{ success: true }], { success: true, status: "taken" }]) {
  await scenario(`Medication rejects ${JSON.stringify(data)}`, async () => {
    const f = medicationFixture({ result: { data } }); await f.act();
    check(f.state.success.length, 0); check(f.state.rows, [{ id: occurrenceId }]);
    check(f.state.errors.length, 1); check(f.state.busy, { key: "", action: "" });
  });
}
for (const options of [{ throwRpc: true }, { result: { error: { message: "denied" } } },
  { readError: { message: "read failed" } }, { saved: null },
  { saved: { id: occurrenceId, patient_id: otherId, status: "taken", action_at: timestamp } },
  { saved: { id: otherId, patient_id: patientId, status: "taken", action_at: timestamp } },
  { saved: { id: occurrenceId, patient_id: patientId, status: "skipped", action_at: timestamp } },
  { saved: { id: occurrenceId, patient_id: patientId, status: "taken", action_at: null } }]) {
  await scenario(`Medication failure/readback isolation ${JSON.stringify(options)}`, async () => {
    const f = medicationFixture(options); await f.act(); check(f.state.success.length, 0);
    check(f.state.errors.length, 1); check(f.state.busy, { key: "", action: "" });
  });
}
await scenario("Medication uncertainty: same action verifies without another mutation", async () => {
  const f = medicationFixture({ result: { data: null } }); await f.act(); await f.act();
  check(f.state.writes, 1); check(f.state.reads, 1); check(f.state.success.length, 1);
  await f.act("skipped"); check(f.state.writes, 1); check(f.state.success.length, 1);
});
await scenario("Medication repeated clicks, unsupported action and wrong patient", async () => {
  const pending = deferred(); const f = medicationFixture({ result: pending.promise });
  const first = f.act(); await f.act(); check(f.state.writes, 1);
  pending.resolve({ data: [{ success: true, status: "taken" }] }); await first;
  const other = medicationFixture(); await other.act("invalid"); await other.act("taken", { patientId: otherId });
  check(other.state.writes, 0);
});

function deriveMedicationState(rows) {
  let cache;
  // Evaluate the real page's builders, memo calculations and cache snapshot.
  const helpers = part(reminder, "const medicationOccurrenceStatuses =", "function getStatusClass") +
    part(reminder, "function getStatusClass(status)", "function isCancelledOrCompletedStatus") +
    part(reminder, "function getLocalDateKey", "function formatMedicationStatus") +
    part(reminder, "function isDateInsideMedicationRange", "function isMissingMedicationOccurrenceError") +
    part(reminder, "function getMedicationOccurrenceStatus", "function formatAppointmentMonth");
  const consumers = part(reminder, "  const medicationOccurrenceMap =", "  const appointmentList =") +
    part(reminder, "  const todaySummary =", "  if (isMedicationScheduleScreen)") +
    part(reminder, "    const snapshot = {", "  }, [") +
    "\nconst summary = todaySummary;\n" +
    part(reminder, "  const recordedDoses =", "  const emptyTextByTab =") +
    "\n({ todaySummary, recentAdherenceRows, medicationList, medicationOccurrenceMap, adherencePercentage });";
  const today = appointmentDates.getManilaDateKey();
  const result = runSource(helpers + consumers, {
    ...appointmentDates, useMemo: callback => callback(), medicationOccurrences: rows,
    medicationReminders: [{ databaseId: "synthetic-medication", medication: "Synthetic medicine", isActive: true,
      reminderTimes: ["08:00", "09:00"], startDate: today, endDate: today }],
    activeTab: "Today", tipIndex: 0, patientRecordId: patientId, profilePatientId: patientId,
    appointmentReminders: [], scheduleReminders: [], healthTips: [], initialCacheRef: { current: null },
    setPatientPwaSessionCache: (_patient, _key, snapshot) => { cache = snapshot; },
  });
  return { ...result, cache };
}
function medicationStateRows() {
  const today = appointmentDates.getManilaDateKey();
  return ["08:00", "09:00"].map((time, index) => {
    const scheduledFor = new Date(appointmentDates.toManilaISOString(today, time)).toISOString();
    return { id: index ? otherId : occurrenceId, patientId, medicationReminderId: "synthetic-medication",
      scheduleDate: today, scheduleTime: time, scheduledFor, normalizedScheduledFor: scheduledFor,
      matchKey: `synthetic-medication|${scheduledFor}`, status: index ? "missed" : "notified",
      actionAt: "", missedAt: index ? timestamp : "", errorCode: "" };
  });
}
for (const action of ["taken", "skipped"]) await scenario(`Medication ${action}: schedule, counts, timeline and cache synchronize`, async () => {
  const rows = medicationStateRows(); const before = deriveMedicationState(rows);
  check(before.todaySummary, { todayDoses: 2, taken: 0, skipped: 0, missed: 1 });
  const f = medicationFixture({ initialRows: rows, result: { data: [{ success: true, status: action }] },
    saved: { id: occurrenceId, patient_id: patientId, status: action, action_at: timestamp } });
  await f.act(action); const after = deriveMedicationState(f.state.rows);
  check(after.todaySummary, { todayDoses: 2, taken: action === "taken" ? 1 : 0, skipped: action === "skipped" ? 1 : 0, missed: 1 });
  const schedule = after.medicationList.find(row => row.occurrence?.id === occurrenceId);
  const history = after.recentAdherenceRows.find(row => row.id === occurrenceId);
  check(schedule.status, action.toUpperCase()); check(schedule.canMarkMedicationAction, false);
  check(history.statusLabel, action.toUpperCase()); check(history.actionAt, timestamp);
  check(history.response !== "Awaiting response" && history.response !== "-", true);
  check(after.adherencePercentage, action === "taken" ? 50 : 0);
  check(after.cache.medicationOccurrences[0].status, action); check(after.cache.medicationOccurrences[0].actionAt, timestamp);
  check(after.medicationOccurrenceMap.get(rows[0].matchKey).status, action);
  check(f.state.rows[1] === rows[1], true, "unrelated occurrence retained");
  check(f.state.writes, 1); check(f.state.reads, 1);
});
await scenario("Medication inconclusive readback does not alter counts, timeline or cache", async () => {
  const f = medicationFixture({ initialRows: medicationStateRows(), readError: { message: "offline" } });
  await f.act(); const state = deriveMedicationState(f.state.rows);
  check(state.todaySummary, { todayDoses: 2, taken: 0, skipped: 0, missed: 1 });
  check(state.recentAdherenceRows.find(row => row.id === occurrenceId).response, "Awaiting response");
  check(state.cache.medicationOccurrences[0].status, "notified"); check(f.state.success.length, 0);
  check(f.state.writes, 1);
});

const notificationInput = { patientId, type: "general", title: "  Test title  ", message: " Synthetic message ",
  priority: "normal", targetPath: "/patient/reminders", appointmentId: occurrenceId };
const notificationRecord = { id: otherId, patient_id: patientId, type: "general", title: "Test title",
  message: "Synthetic message", priority: "normal", target_path: "/patient/reminders",
  related_appointment_id: occurrenceId, related_medical_record_id: null, related_reminder_id: null };
const typeSource = await read("src/lib/patientNotificationTypes.js");
const uuid = runSource(typeSource.slice(typeSource.indexOf("export function isUuid")).replace("export ", "") + "\nisUuid;", {});
function notificationFixture(result, throws = false) {
  let writes = 0;
  let currentResult = result;
  const api = runSource(hook.slice(hook.indexOf("const allowedPriorities")).replace("export function", "function") +
    "\nuseSendPatientNotification();", {
    useRef: current => ({ current }), useState: initial => [initial, () => {}], useCallback: fn => fn,
    isUuid: uuid, isAllowedPatientNotificationType: value => value === "general",
    isAllowedPatientNotificationTarget: value => value === "/patient/reminders",
    supabase: { rpc: async () => { writes++; if (throws) throw typeof throws === "object" ? throws : Error("transport");
      return await currentResult; }, from: forbidden },
  });
  return { send: () => api.sendPatientNotification(notificationInput), count: () => writes,
    setResult: value => { currentResult = value; } };
}
for (const data of [notificationRecord, [notificationRecord]]) await scenario("Notification valid database receipt", async () => {
  const f = notificationFixture({ data }); check(await f.send(), notificationRecord); check(f.count(), 1);
});
for (const data of [null, {}, [], [notificationRecord, notificationRecord],
  { ...notificationRecord, id: "bad" }, { ...notificationRecord, patient_id: otherId },
  { ...notificationRecord, related_appointment_id: otherId }, { ...notificationRecord, type: "health_tip" },
  { ...notificationRecord, message: "wrong" }, { ...notificationRecord, target_path: "/patient/profile" },
  { ...notificationRecord, related_reminder_id: otherId }]) {
  await scenario(`Notification rejects malformed/mismatched ${JSON.stringify(data)}`, async () => {
    const f = notificationFixture({ data }); await assert.rejects(f.send(), /could not be confirmed/); assertions++;
    await assert.rejects(f.send(), /previous notification/); assertions++; check(f.count(), 1);
  });
}
for (const code of ["42501", "22023", "23503", "P0002"]) await scenario(`Notification rejected ${code}: manual recovery, no automatic retry`, async () => {
  const f = notificationFixture({ data: null, error: { code, message: "permission denied" } });
  await assert.rejects(f.send(), /not authorized/); assertions++;
  check(f.count(), 1, "rejection must not auto retry");
  f.setResult({ data: notificationRecord });
  check(await f.send(), notificationRecord, "deliberate new attempt is allowed"); check(f.count(), 2);
});
for (const options of [{ code: "08006" }, { code: "40003" }, { code: "unknown" }, {},
  { code: "PGRST202" }, { throws: true }, { throws: { code: "42501", message: "unverified thrown error" } }]) {
  await scenario("Notification ambiguous errors do not resolve or repeat", async () => {
    const f = notificationFixture({ error: { code: options.code, message: "uncertain" } }, options.throws);
    await assert.rejects(f.send()); assertions++; await assert.rejects(f.send()); assertions++; check(f.count(), 1);
  });
}
await scenario("Notification contradictory data/error remains inconclusive", async () => {
  const f = notificationFixture({ data: notificationRecord, error: { code: "42501", message: "denied" } });
  await assert.rejects(f.send()); assertions++; await assert.rejects(f.send()); assertions++; check(f.count(), 1);
});
await scenario("Notification synchronous duplicate lock", async () => {
  const pending = deferred(); const f = notificationFixture(pending.promise); const first = f.send();
  await assert.rejects(f.send(), /already being sent/); assertions++; check(f.count(), 1);
  pending.resolve({ data: notificationRecord }); await first;
});

const personalDraft = { displayName: " Synthetic Patient ", birthdate: "1999-01-02", nationality: " Filipino ",
  address: " Synthetic street ", civilStatus: "", phone: "09123456789", bloodType: "AB+" };
const savedPatient = { id: patientId, full_name: "Synthetic Patient", date_of_birth: "1999-01-02",
  nationality: "Filipino", address: "Synthetic street", civil_status: null, contact_number: "09123456789" };
function profileFixture({ patient = savedPatient, readError, mutationError, mutationData = null, pending } = {}) {
  const state = { writes: 0, success: 0, drafts: 0, editing: true, expectedId: null, payload: null, errors: [] };
  const helpers = part(profile, "function cleanText(value)", "function toDateInputValue(value)");
  const code = helpers + part(profile, "  const reconcileProfile =", "  const updatePersonalDraft =") +
    part(profile, "  async function savePersonalEdit()", "  const startEmergencyEdit =") + "\nsavePersonalEdit;";
  const save = runSource(code, {
    profile: { recordId: patientId, userId: otherId }, profileData: { avatar: "" }, personalDraft, onProfileChange: undefined,
    personalSaveLockRef: { current: false },
    isValidPhilippineMobileNumber: () => true,
    updatePatientProfile: async payload => { state.writes++; state.payload = payload;
      if (mutationError) throw Error("mutation failed"); if (pending) await pending; return mutationData; },
    loadPatientProfileSummary: async id => { state.expectedId = id; if (readError) throw Error("readback failed"); return { patient }; },
    mapPatientProfileSummary: summary => summary.patient, normalizeProfile: value => value,
    createPersonalDraft: value => value, createEmergencyDraft: value => value,
    setLoading: () => {}, setSavingPersonal: () => {},
    setPersonalDraft: () => { state.drafts++; }, setEmergencyDraft: () => {}, setProfileData: () => {},
    setEditingPersonal: value => { state.editing = value; },
    showFeedback: (message, tone) => { if (tone === "success") state.success++; if (tone === "error") state.errors.push(message); },
  });
  return { save, state };
}
for (const mutationData of [null, {}, { patient: savedPatient }]) await scenario("Profile confirms normalized supported fields through readback", async () => {
  const f = profileFixture({ mutationData }); await f.save(); check(f.state.errors, [], "profile confirmation errors"); check(f.state.success, 1);
  check(f.state.expectedId, patientId); check("blood_type" in f.state.payload, false);
  check(f.state.payload.civil_status, null); check(f.state.editing, false);
});
for (const options of [{ patient: { ...savedPatient, address: "stale" } }, { patient: { ...savedPatient, id: otherId } },
  { patient: null }, { readError: true }, { mutationError: true }]) {
  await scenario(`Profile preserves edits when unconfirmed ${JSON.stringify(options)}`, async () => {
    const f = profileFixture(options); await f.save(); check(f.state.success, 0); check(f.state.drafts, 0);
    check(f.state.editing, true); check(f.state.errors.length, 1); check(f.state.writes, 1);
  });
}
await scenario("Profile duplicate submission guard and Blood Type read-only rendering", async () => {
  const pending = deferred(); const f = profileFixture({ pending: pending.promise });
  const first = f.save(); await f.save(); check(f.state.writes, 1); pending.resolve(); await first;
  check(/<Info\s+label="Blood Type"/.test(profile), true);
  check(part(profile, "      const submitted =", "      await updatePatientProfile").includes("blood_type"), false);
});
await scenario("Notification modal only closes after validated hook resolution; no delivery claim", async () => {
  const modal = await read("src/components/notifications/SendPatientNotificationModal.jsx");
  check(modal.includes("const notification = await sendPatientNotification("), true);
  check(modal.indexOf("onSent(notification)") > modal.indexOf("await sendPatientNotification("), true);
  check(hook.includes("not FCM or SMS delivery"), true);
});
await scenario("All four caller modules compile in memory without generated output", async () => {
  for (const [source, path] of [[reminder, "Reminder.jsx"], [profile, "Profile.jsx"], [hook, "hook.js"], [booking, "Booking.jsx"]]) {
    const result = await transformWithOxc(source, path, { jsx: { runtime: "automatic" } });
    check(Boolean(result.code), true);
  }
});
console.log(`${scenarios} scenarios / ${assertions} assertions PASS (offline mocked handlers; no database/FCM/SMS calls).`);
