// Offline only: no database, provider, live environment or Deno listener.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks, stripTypeScriptTypes } from "node:module";

const root = fileURLToPath(new URL("../", import.meta.url));
const functionsRoot = path.join(root, "supabase", "functions") + path.sep;
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");
let networkAttempts = 0;
globalThis.fetch = () => {
  networkAttempts++;
  throw new Error("Live network forbidden in SMS verification");
};

registerHooks({
  load(url, context, nextLoad) {
    let source;
    if (url.startsWith("data:application/typescript;base64,")) {
      source = Buffer.from(url.split(",")[1], "base64").toString("utf8");
    } else if (url.startsWith("file:") && url.endsWith(".ts")) {
      const filename = fileURLToPath(url);
      assert(filename.startsWith(functionsRoot), "Unexpected TypeScript module");
      source = fs.readFileSync(filename, "utf8");
    } else {
      return nextLoad(url, context);
    }
    return {
      format: "module",
      source: stripTypeScriptTypes(source, { mode: "transform" }),
      shortCircuit: true,
    };
  },
});

const tests = [];
globalThis.Deno = {
  test: (name, run) => tests.push({ name, run }),
  env: { get() { throw new Error("Live environment forbidden"); } },
  readTextFile: async url => {
    const filename = fileURLToPath(url);
    assert(filename.startsWith(functionsRoot), "Unexpected fixture read");
    return fs.readFileSync(filename, "utf8");
  },
};

let passed = 0;
let failed = 0;
for (const file of [
  "process-appointment-sms/appointmentSms_test.ts",
  "process-appointment-sms/appointmentSmsHandler_test.ts",
  "process-medication-sms/medicationSms_test.ts",
  "send-notification-sms/iprogSms_test.ts",
  "send-notification-sms/semaphoreSms_test.ts",
  "send-notification-sms/smsDispatchReconciliation_test.ts",
  "send-notification-sms/smsTransport_test.ts",
]) {
  const start = tests.length;
  await import(pathToFileURL(path.join(functionsRoot, file)).href);
  let failures = 0;
  for (const test of tests.slice(start)) {
    try {
      await test.run();
      passed++;
    } catch {
      failed++;
      failures++;
      // Test names are synthetic; do not print request bodies or error payloads.
      console.error(`FAIL ${test.name}`);
    }
  }
  console.log(`${file}: ${tests.length - start - failures} passed, ${failures} failed`);
}

// Source checks, not installed PostgreSQL execution or authorization evidence.
let sourceAssertions = 0;
const check = (condition, label) => { assert(condition, label); sourceAssertions++; };
for (const [file, flag] of [
  ["20260923140000_appointment_reminder_sms_bridge.sql", "appointment_sms_bridge_enabled"],
  ["20260923150000_medication_reminder_sms_bridge.sql", "medication_sms_bridge_enabled"],
]) {
  const sql = read(`supabase/migrations/${file}`).replace(/--[^\n]*/g, "").replace(/\r/g, "");
  const guard = "if pg_catalog.lower(pg_catalog.btrim(coalesce(v_enabled, ''))) <> 'true' then\n      return new;\n    end if;";
  check(sql.includes(guard), "Bridge must fail closed before enqueueing");
  check(sql.indexOf(flag) < sql.indexOf(guard), "Independent bridge setting");
  check(sql.indexOf(guard) < sql.indexOf("perform net.http_post"), "Flag before HTTP enqueue");
  check((sql.match(/net\.http_post/g) || []).length === 1, "Single guarded enqueue");
}
const draft = read("docs/sql-drafts/appointment-event-sms-control.sql").replace(/--[^\n]*/g, "");
for (const required of [
  "create function public.is_appointment_event_sms_enabled()",
  "security definer", "set search_path = ''", "owner to postgres",
  "from public, anon, authenticated", "to service_role",
  "secret.name = 'appointment_event_sms_enabled'", "secret.decrypted_secret = 'true'",
  "count(*) = 1", "returns boolean",
]) check(draft.includes(required), `Draft contract: ${required}`);
check(!/create_secret|update_secret|create or replace|alter table|create policy/i.test(draft),
  "Draft must not enable flags, replace existing RPCs or alter application schema");

// Execute the actual frontend helper with mocked function/RPC responses.
const plain = source => source.replace(/^import\s[\s\S]*?;\r?\n/gm, "")
  .replace(/^export /gm, "").replaceAll("import.meta.env.DEV", "false");
const modules = [
  "src/lib/patientNotificationRoutes.js", "src/lib/patientNotificationTypes.js",
  "src/lib/appointmentSms.js", "src/lib/automaticAppointmentNotification.js",
].map(file => plain(read(file))).join("\n");
let frontendAssertions = 0;
for (const notificationType of ["appointment_created", "appointment_rescheduled", "appointment_cancelled"]) {
  for (const outcome of ["enabled", "disabled", "error"]) {
    const sms = [], notifications = [];
    const context = vm.createContext({
      console: { warn() {} },
      supabase: {
        functions: { invoke: async (name, request) => {
          sms.push({ name, request });
          return outcome === "error" ? { error: { message: "synthetic" } }
            : { data: { ok: true, skipped: outcome === "disabled", sent: outcome === "enabled" }, error: null };
        } },
        rpc: async (name, payload) => {
          notifications.push({ name, payload });
          return { data: { id: "synthetic-notification" }, error: null };
        },
      },
    });
    vm.runInContext(modules + "\nglobalThis.send = sendAutomaticAppointmentNotification;", context);
    const result = await context.send({
      patientId: "11111111-1111-4111-8111-111111111111",
      scheduleId: "22222222-2222-4222-8222-222222222222",
      appointmentEventId: "33333333-3333-4333-8333-333333333333",
      notificationType,
    });
    assert.equal(result.ok, true); frontendAssertions++;
    assert.equal(sms.length, 1); frontendAssertions++;
    assert.equal(notifications.length, 1); frontendAssertions++;
    assert.equal(notifications[0].payload.p_type, notificationType); frontendAssertions++;
    assert.equal(notifications[0].payload.p_target_path, "/patient/appointments"); frontendAssertions++;
    assert.equal(sms[0].request.body.event, notificationType === "appointment_created"
      ? "appointment_confirmed" : notificationType); frontendAssertions++;
  }
}
// Execute the existing registration completion/appointment-notification block,
// stopping before form reset. This does not register anyone or alter the wizard.
const registration = read("src/pages/staff/Staff_Patients.jsx");
const registrationStart = registration.indexOf("      const finishRpcName =");
const registrationEnd = registration.indexOf("      setForm(blankForm);", registrationStart);
assert(registrationStart > 0 && registrationEnd > registrationStart);
const registrationBlock = plain(registration.slice(registrationStart, registrationEnd));
for (const scenario of ["success", "finish-error", "lookup-error", "missing-schedule", "no-walkin"]) {
  const sms = [], notifications = [];
  const patientId = "11111111-1111-4111-8111-111111111111";
  const scheduleId = "22222222-2222-4222-8222-222222222222";
  const context = vm.createContext({
    console: { warn() {} },
    selectedWalkInSlot: scenario === "no-walkin" ? null : { reservationId: "synthetic-reservation" },
    registrationRecord: { id: patientId }, registrationToken: "synthetic-token",
    mapSupabasePatient: record => ({ recordId: record.id }), setPatients: update => update([]),
    supabase: {
      rpc: async name => {
        if (name === "create_patient_notification") {
          notifications.push(name);
          return { data: { id: "synthetic-notification" }, error: null };
        }
        assert(["finish_walkin_patient_registration", "finish_patient_registration"].includes(name));
        return { data: { id: patientId }, error: scenario === "finish-error" ? new Error("synthetic") : null };
      },
      functions: { invoke: async (name, request) => {
        assert.equal(name, "process-appointment-sms");
        sms.push(request);
        return { data: { ok: true, skipped: true }, error: null };
      } },
      from: table => {
        assert.equal(table, "staff_walkin_registration_reservations");
        const query = {
          select() { return query; }, eq() { return query; },
          maybeSingle: async () => ({
            data: { patient_record_id: patientId, schedule_id: scenario === "missing-schedule" ? null : scheduleId },
            error: scenario === "lookup-error" ? { code: "synthetic" } : null,
          }),
        };
        return query;
      },
    },
  });
  vm.runInContext(modules + `\nglobalThis.finish = async () => {${registrationBlock}\nreturn appointmentNotificationResult;};`, context);
  if (scenario === "finish-error") await assert.rejects(context.finish());
  else await context.finish();
  const expected = scenario === "success" ? 1 : 0;
  assert.equal(sms.length, expected); frontendAssertions++;
  assert.equal(notifications.length, expected); frontendAssertions++;
  if (expected) {
    assert.equal(sms[0].body.schedule_id, scheduleId); frontendAssertions++;
    assert.equal(sms[0].body.event, "appointment_confirmed"); frontendAssertions++;
  }
}
assert.equal(networkAttempts, 0);
console.log(JSON.stringify({ passed, failed, sourceAssertions, frontendAssertions, liveNetworkAttempts: networkAttempts }));
if (failed) process.exitCode = 1;
