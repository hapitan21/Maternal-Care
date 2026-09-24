import {
  buildMedicationSmsMessage,
  buildMedicationSmsPlan,
  MEDICATION_SMS_EVENT,
  type MedicationNotificationRow,
  type MedicationOccurrenceRow,
  type MedicationPatientRow,
  type MedicationReminderRow,
  type MedicationSmsPlan,
  orchestrateMedicationSms,
  parseMedicationSmsRequest,
} from "../_shared/medicationSms.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
  }
}

const NOW = new Date("2026-10-19T01:05:00.000Z");
const OCCURRENCE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_OCCURRENCE_ID = "22222222-2222-4222-8222-222222222222";
const REMINDER_ID = "33333333-3333-4333-8333-333333333333";
const PATIENT_ID = "44444444-4444-4444-8444-444444444444";
const USER_ID = "55555555-5555-4555-8555-555555555555";
const NOTIFICATION_ID = "66666666-6666-4666-8666-666666666666";

type MedicationSmsInput = {
  occurrence: MedicationOccurrenceRow | null;
  reminder: MedicationReminderRow | null;
  patient: MedicationPatientRow | null;
  notification: MedicationNotificationRow | null;
  now: Date;
};

function occurrence(
  updates: Partial<MedicationOccurrenceRow> = {},
): MedicationOccurrenceRow {
  return {
    id: OCCURRENCE_ID,
    medication_reminder_id: REMINDER_ID,
    patient_id: PATIENT_ID,
    scheduled_for: "2026-10-19T01:00:00.000Z",
    status: "notified",
    notification_id: NOTIFICATION_ID,
    notified_at: "2026-10-19T01:00:05.000Z",
    action_at: null,
    missed_at: null,
    ...updates,
  };
}

function reminder(
  updates: Partial<MedicationReminderRow> = {},
): MedicationReminderRow {
  return {
    id: REMINDER_ID,
    patient_id: PATIENT_ID,
    status: "active",
    start_date: "2026-10-01",
    end_date: "2026-10-31",
    ...updates,
  };
}

function patient(
  updates: Partial<MedicationPatientRow> = {},
): MedicationPatientRow {
  return {
    id: PATIENT_ID,
    user_id: USER_ID,
    status: "active",
    account_status: "active",
    archived_at: null,
    ...updates,
  };
}

function notification(
  updates: Partial<MedicationNotificationRow> = {},
): MedicationNotificationRow {
  return {
    id: NOTIFICATION_ID,
    patient_id: PATIENT_ID,
    user_id: USER_ID,
    type: MEDICATION_SMS_EVENT,
    ...updates,
  };
}

function validInput(
  updates: Partial<MedicationSmsInput> = {},
): MedicationSmsInput {
  return {
    occurrence: occurrence(),
    reminder: reminder(),
    patient: patient(),
    notification: notification(),
    now: NOW,
    ...updates,
  };
}

function createDependencies() {
  const claims = new Map<string, string>();
  const claimPlans: MedicationSmsPlan[] = [];
  const transportRequests: Array<{ dispatchId: string; message: string }> = [];

  return {
    claimPlans,
    transportRequests,
    dependencies: {
      claimDispatch: (plan: MedicationSmsPlan) => {
        claimPlans.push(plan);
        const existingDispatchId = claims.get(plan.dispatchKey);
        if (existingDispatchId) {
          return Promise.resolve({
            dispatch_id: existingDispatchId,
            dispatch_status: "sent",
            newly_claimed: false,
            may_send: false,
          });
        }

        const dispatchId =
          `aaaaaaaa-aaaa-4aaa-8aaa-${String(claims.size + 1).padStart(12, "0")}`;
        claims.set(plan.dispatchKey, dispatchId);
        return Promise.resolve({
          dispatch_id: dispatchId,
          dispatch_status: "processing",
          newly_claimed: true,
          may_send: true,
        });
      },
      invokeTransport: (request: { dispatchId: string; message: string }) => {
        transportRequests.push(request);
        return Promise.resolve({ ok: true, sent: true, status: "sent" });
      },
    },
  };
}

Deno.test("same medication occurrence produces the same deterministic key", () => {
  const first = buildMedicationSmsPlan(validInput());
  const second = buildMedicationSmsPlan(validInput());

  assertEquals(first.plan?.dispatchKey, `medication:${OCCURRENCE_ID}:sms`);
  assertEquals(first.plan?.dispatchKey, second.plan?.dispatchKey);
});

Deno.test("same medication occurrence cannot invoke transport twice", async () => {
  const harness = createDependencies();

  await orchestrateMedicationSms(validInput(), harness.dependencies);
  await orchestrateMedicationSms(validInput(), harness.dependencies);

  assertEquals(harness.claimPlans.length, 2);
  assertEquals(harness.transportRequests.length, 1);
});

Deno.test("different medication occurrences produce different keys", () => {
  const first = buildMedicationSmsPlan(validInput());
  const second = buildMedicationSmsPlan(
    validInput({ occurrence: occurrence({ id: OTHER_OCCURRENCE_ID }) }),
  );

  assert(first.plan?.dispatchKey !== second.plan?.dispatchKey, "Keys must differ");
});

Deno.test("nonexistent medication occurrence is rejected before Phase 1", async () => {
  const harness = createDependencies();
  const result = await orchestrateMedicationSms(
    validInput({ occurrence: null }),
    harness.dependencies,
  );

  assertEquals(result.reason, "medication_occurrence_not_found");
  assertEquals(harness.claimPlans.length, 0);
  assertEquals(harness.transportRequests.length, 0);
});

Deno.test("inactive medication reminder is rejected before Phase 1", async () => {
  const harness = createDependencies();
  const result = await orchestrateMedicationSms(
    validInput({ reminder: reminder({ status: "cancelled" }) }),
    harness.dependencies,
  );

  assertEquals(result.reason, "medication_reminder_inactive");
  assertEquals(harness.claimPlans.length, 0);
});

Deno.test("medication orchestration request rejects Patient phone fields", () => {
  const result = parseMedicationSmsRequest({
    event: MEDICATION_SMS_EVENT,
    medication_occurrence_id: OCCURRENCE_ID,
    phone_number: "+639171234567",
  });

  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error, "unexpected_request_field");
});

Deno.test("medication orchestration request accepts only event and occurrence ID", () => {
  const result = parseMedicationSmsRequest({
    event: MEDICATION_SMS_EVENT,
    medication_occurrence_id: OCCURRENCE_ID,
  });

  assertEquals(result.ok, true);
});

Deno.test("medication SMS message is privacy-safe", () => {
  const message = buildMedicationSmsMessage().toLowerCase();

  for (const sensitiveText of [
    "insulin",
    "metformin",
    "dosage",
    "diagnosis",
    "preeclampsia",
    "pregnancy risk",
    "patient name",
  ]) {
    assert(!message.includes(sensitiveText), `Message leaked ${sensitiveText}`);
  }
  assert(message.includes("maternal care"), "Service identity is required");
});

for (const actionStatus of ["taken", "skipped"] as const) {
  Deno.test(`${actionStatus} occurrence remains unchanged and cannot send`, async () => {
    const savedOccurrence = occurrence({
      status: actionStatus,
      action_at: "2026-10-19T01:02:00.000Z",
    });
    const before = JSON.stringify(savedOccurrence);
    const harness = createDependencies();
    const result = await orchestrateMedicationSms(
      validInput({ occurrence: savedOccurrence }),
      harness.dependencies,
    );

    assertEquals(result.reason, "medication_occurrence_not_sendable");
    assertEquals(harness.claimPlans.length, 0);
    assertEquals(harness.transportRequests.length, 0);
    assertEquals(JSON.stringify(savedOccurrence), before);
  });
}

Deno.test("tests use injected transport and make no network request", async () => {
  const harness = createDependencies();
  const result = await orchestrateMedicationSms(
    validInput(),
    harness.dependencies,
  );

  assertEquals(result.sent, true);
  assertEquals(harness.transportRequests.length, 1);
});
