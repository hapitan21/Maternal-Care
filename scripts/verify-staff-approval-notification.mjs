// Offline: execute the actual approval handler, notification hook and SMS helper
// in a VM with synthetic data and in-memory RPC/transport mocks. No output files.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { parse } from "espree";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const source = await read("src/pages/staff/Staff_Appointments.jsx");
const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true }, range: true });
const component = ast.body.find(node => node.type === "FunctionDeclaration" && node.id.name === "StaffAppointmentsContent");
const declarations = component.body.body.filter(node => node.type === "VariableDeclaration").flatMap(node => node.declarations);
const callback = declarations.find(node => node.id.name === "acceptPatientRequest").init.arguments[0];
const handler = source.slice(...callback.range);
const plainModule = text => text.replace(/^import\s[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, "").replaceAll("import.meta.env.DEV", "false");
const modules = (await Promise.all([
  read("src/lib/patientNotificationRoutes.js"),
  read("src/lib/patientNotificationTypes.js"),
  read("src/hooks/useSendPatientNotification.js"),
  read("src/lib/appointmentSms.js"),
])).map(plainModule).join("\n");
const patientId = "11111111-1111-4111-8111-111111111111";
const scheduleId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const notificationId = "44444444-4444-4444-8444-444444444444";
const request = { id: 424242, patient_id: patientId };
const acceptance = { request_id: request.id, status: "accepted", patient_id: patientId, schedule_id: scheduleId };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
let scenarios = 0, assertions = 0;
const check = (actual, expected, label) => {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, label);
  assertions++;
};
const scenario = async (name, run) => {
  await run(); scenarios++; console.log(`PASS ${name}`);
};

function fixture(options = {}) {
  const state = { approvals: [], notifications: [], smsRequests: [], transports: [], receipts: [],
    successes: [], errors: [], warnings: [], busy: false, pending: [request], refreshes: 0 };
  const context = vm.createContext({
    console: { error() {}, warn: (...args) => state.warnings.push(args.map(String)) },
    useRef: value => ({ current: value }), useState: () => [false, () => {}], useCallback: fn => fn,
    isReviewingRequest: Boolean(options.busy), requestDoctorId: options.noDoctor ? "" : otherId,
    requestApprovalInFlightRef: { current: false }, acceptedRequestIdsRef: { current: new Set() },
    supabase: {
      rpc: async (name, payload) => {
        if (name === "accept_patient_appointment_request") {
          state.approvals.push(payload);
          if (options.approvalThrows) throw Error("synthetic approval transport timeout");
          return await (options.approvalResult ?? { data: acceptance, error: null });
        }
        assert.equal(name, "create_patient_notification", "No other RPC is allowed");
        state.notifications.push(payload);
        if (options.notificationThrows) throw Error("synthetic notification timeout");
        const record = { id: notificationId, ...Object.fromEntries(Object.entries(payload).map(([key, value]) => [key.slice(2), value])) };
        const result = options.notificationResult === undefined ? { data: record, error: null } : await options.notificationResult;
        if (result?.data) state.receipts.push(result.data);
        return result;
      },
      functions: { invoke: async (name, payload) => {
        assert.equal(name, "process-appointment-sms", "No other transport is allowed");
        state.transports.push(payload);
        if (options.smsThrows) throw Error("synthetic SMS transport timeout");
        return options.smsResult ?? { data: { ok: true, skipped: false }, error: null };
      } },
    },
    setIsReviewingRequest: value => { state.busy = value; },
    setRequestActionError: value => { state.errors.push(value); },
    setBookingRequests: update => { state.pending = update(state.pending); },
    setSelectedRequest() {}, setRequestDoctorId() {},
    showSuccessMessage: message => state.successes.push(message),
    loadAppointments: async () => { state.refreshes++; },
    loadBookingRequests: async () => { state.refreshes++; },
    refreshRequestNotifications: async () => { state.refreshes++; },
  });
  vm.runInContext(modules, context);
  context.sendPatientNotification = vm.runInContext("useSendPatientNotification().sendPatientNotification", context);
  const sms = vm.runInContext("requestAppointmentSms", context);
  context.requestAppointmentSms = async payload => {
    state.smsRequests.push(payload);
    if (options.smsHelperThrows) throw Error("synthetic SMS helper failure");
    return sms(payload);
  };
  const approve = vm.runInContext(`(${handler})`, context);
  return { state, approve: (value = request) => approve(value), context };
}
const approved = f => {
  check(f.state.successes.length, 1, "approval remains successful");
  check(f.state.errors.filter(Boolean), [], "delivery must not report approval failure");
  check(f.state.pending.length, 0); check(f.state.busy, false); check(f.state.refreshes, 3);
};
const noDelivery = f => {
  check(f.state.notifications.length, 0); check(f.state.smsRequests.length, 0);
  check(f.state.transports.length, 0); check(f.state.successes.length, 0);
};

await scenario("Hook and duplicate guards initialize unconditionally at component level", async () => {
  const hook = declarations.find(node => node.init?.callee?.name === "useSendPatientNotification");
  check(Boolean(hook), true);
  check(component.body.body.findIndex(node => node.declarations?.includes(hook)) < component.body.body.findIndex(node => node.type === "IfStatement"), true);
  check(handler.includes("useSendPatientNotification("), false);
  check(handler.includes("sendAutomaticAppointmentNotification"), false);
  check((handler.match(/await requestAppointmentSms\(/g) || []).length, 1);
  check(declarations.find(node => node.id.name === "acceptPatientRequest").init.arguments[1].elements.some(node => node.name === "sendPatientNotification"), true);
});
await scenario("Verified acceptance creates one notification with exact privacy-safe linkage and one SMS", async () => {
  const f = fixture(); await f.approve(); await flush(); approved(f);
  check(f.state.approvals, [{ p_request_id: request.id, p_doctor_id: otherId }]);
  check(f.state.notifications, [{ p_patient_id: patientId, p_type: "appointment_created",
    p_title: "New Appointment Scheduled", p_message: "A new clinic appointment has been scheduled for you.",
    p_target_path: "/patient/appointments", p_priority: "important", p_related_appointment_id: scheduleId,
    p_related_medical_record_id: null, p_related_reminder_id: null }]);
  check(f.state.smsRequests, [{ scheduleId, event: "appointment_confirmed" }]);
  check(f.state.transports, [{ body: { schedule_id: scheduleId, event: "appointment_confirmed" } }]);
  check(f.state.receipts.length, 1);
});
for (const [label, options, value] of [
  ["busy", { busy: true }, request], ["missing Doctor", { noDoctor: true }, request], ["missing request ID", {}, {}],
]) await scenario(`Guarded ${label} has no external effects`, async () => {
  const f = fixture(options); await f.approve(value); noDelivery(f); check(f.state.approvals.length, 0);
});
for (const code of ["42501", "22023", "P0002", "08006"]) await scenario(`Approval error ${code} requests neither channel`, async () => {
  const f = fixture({ approvalResult: { data: null, error: { code, message: "synthetic rejection" } } });
  await f.approve(); noDelivery(f); check(f.state.busy, false); check(f.state.pending.length, 1);
});
await scenario("Thrown approval timeout requests neither channel", async () => {
  const f = fixture({ approvalThrows: true });
  await assert.rejects(f.approve(), /approval transport timeout/); assertions++;
  noDelivery(f); check(f.state.busy, false);
});
for (const data of [null, {}, [], { ...acceptance, status: "pending" }, { ...acceptance, status: "rejected" },
  { ...acceptance, request_id: 999 }, { ...acceptance, request_id: undefined }]) {
  await scenario("Unverified acceptance receipt requests neither channel", async () => {
    const f = fixture({ approvalResult: { data, error: null } }); await f.approve();
    noDelivery(f); check(f.state.errors.at(-1).includes("could not be confirmed"), true);
  });
}
for (const changes of [{ patient_id: otherId }, { patient_id: "invalid" }, { patient_id: undefined },
  { schedule_id: "invalid" }, { schedule_id: request.id }, { schedule_id: undefined }]) {
  await scenario(`Unverified ownership or internal UUID skips notification: ${JSON.stringify(changes)}`, async () => {
    const f = fixture({ approvalResult: { data: { ...acceptance, ...changes }, error: null } });
    await f.approve(); await flush(); approved(f); check(f.state.notifications.length, 0);
    check(f.state.warnings.length, 1);
    if (changes.patient_id) check(f.state.transports.length, 1, "Patient mismatch must not block canonical SMS");
  });
}
for (const options of [
  { notificationResult: { data: null, error: { code: "42501", message: "permission denied" } } },
  { notificationResult: { data: null, error: { code: "08006", message: "timeout" } } },
  { notificationResult: { data: {} } }, { notificationThrows: true },
]) await scenario("Notification rejection/uncertainty preserves approval and SMS without retry", async () => {
  const f = fixture(options); await f.approve(); await flush(); await f.approve(); await flush(); approved(f);
  check(f.state.notifications.length, 1); check(f.state.smsRequests.length, 1);
  check(f.state.transports.length, 1); check(f.state.approvals.length, 1); check(f.state.warnings.length, 1);
});
await scenario("Pending notification does not delay SMS or successful approval", async () => {
  const pending = deferred(), f = fixture({ notificationResult: pending.promise });
  await f.approve(); approved(f); check(f.state.transports.length, 1); check(f.state.receipts.length, 0);
  await f.approve(); check(f.state.notifications.length, 1);
  pending.resolve({ data: null, error: { code: "08006", message: "synthetic timeout" } });
  await flush(); check(f.state.warnings.length, 1); approved(f);
});
for (const options of [
  { smsResult: { data: { ok: false } } }, { smsResult: { error: { message: "synthetic SMS rejection" } } },
  { smsThrows: true }, { smsHelperThrows: true },
]) await scenario("SMS failure leaves notification receipt and approval successful", async () => {
  const f = fixture(options); await f.approve(); await flush(); approved(f);
  check(f.state.notifications.length, 1); check(f.state.receipts.length, 1); check(f.state.smsRequests.length, 1);
});
await scenario("SMS pending does not prevent notification creation", async () => {
  const f = fixture(), pending = deferred();
  f.context.requestAppointmentSms = async payload => { f.state.smsRequests.push(payload); return pending.promise; };
  const first = f.approve(); await flush(); check(f.state.receipts.length, 1);
  await f.approve(); check(f.state.approvals.length, 1); check(f.state.smsRequests.length, 1);
  pending.resolve({ ok: false }); await first; approved(f);
});
await scenario("Same-tick and stale repeated clicks do not repeat acceptance, notification or SMS", async () => {
  const pending = deferred(), f = fixture({ approvalResult: pending.promise });
  const first = f.approve(); await f.approve(); check(f.state.approvals.length, 1);
  pending.resolve({ data: acceptance, error: null }); await first; await flush();
  await f.approve(); await flush(); approved(f);
  check(f.state.approvals.length, 1); check(f.state.notifications.length, 1); check(f.state.transports.length, 1);
});
await scenario("Hook uncertainty survives another accepted request without blind notification retry", async () => {
  const f = fixture({ notificationThrows: true }); await f.approve(); await flush();
  // A second synthetic request receives a deliberately matching acceptance receipt.
  f.context.supabase.rpc = async (name, payload) => {
    assert.equal(name, "accept_patient_appointment_request", "Uncertain hook must block notification RPC");
    f.state.approvals.push(payload);
    return { data: { ...acceptance, request_id: 424243 }, error: null };
  };
  await f.approve({ ...request, id: 424243 }); await flush();
  check(f.state.notifications.length, 1); check(f.state.smsRequests.length, 2);
  check(f.state.successes.length, 2); check(f.state.errors.filter(Boolean), []);
});
console.log(`${scenarios} scenarios / ${assertions} assertions PASS; 0 failures. Offline mocks only.`);
