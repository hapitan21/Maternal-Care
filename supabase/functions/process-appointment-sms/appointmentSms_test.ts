import {
  appointmentSmsEvents,
  type AppointmentEventRow,
  type AppointmentReminderOccurrence,
  type AppointmentReminderRow,
  type AppointmentSmsPlan,
  type AppointmentSmsRow,
  buildAppointmentSmsMessage,
  buildAppointmentSmsPlan,
  formatAppointmentSmsDate,
  formatAppointmentSmsTime,
  orchestrateAppointmentSms,
} from "../_shared/appointmentSms.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
  }
}

const NOW = new Date("2026-10-19T02:00:00.000Z");
const SCHEDULE_ID = "11111111-1111-4111-8111-111111111111";
const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const DOCTOR_ID = "33333333-3333-4333-8333-333333333333";
const REMINDER_ID = "44444444-4444-4444-8444-444444444444";
const APPOINTMENT_EVENT_ID = "55555555-5555-4555-8555-555555555555";

function appointment(
  updates: Partial<AppointmentSmsRow> = {},
): AppointmentSmsRow {
  return {
    id: SCHEDULE_ID,
    patient_id: PATIENT_ID,
    doctor_id: DOCTOR_ID,
    title: "Clinic Appointment",
    description: null,
    start_time: "2026-10-20T01:00:00.000Z",
    end_time: "2026-10-20T01:30:00.000Z",
    status: "scheduled",
    created_at: "2026-09-20T00:00:00.000Z",
    updated_at: "2026-09-20T00:00:00.000Z",
    ...updates,
  };
}

function reminder(
  updates: Partial<AppointmentReminderRow> = {},
): AppointmentReminderRow {
  return {
    id: REMINDER_ID,
    patient_id: PATIENT_ID,
    schedule_id: SCHEDULE_ID,
    reminder_type: "appointment",
    remind_at: "2026-10-19T01:00:00.000Z",
    next_trigger_at: "2026-10-19T01:00:00.000Z",
    status: "pending",
    ...updates,
  };
}

function configuredReminderOccurrence(
  updates: Partial<AppointmentReminderOccurrence> = {},
): AppointmentReminderOccurrence {
  return {
    source: "configured",
    scheduled_for: "2026-10-19T01:00:00.000Z",
    reminder_id: REMINDER_ID,
    reminder_offset_minutes: null,
    ...updates,
  };
}

function fallbackReminderOccurrence(
  updates: Partial<AppointmentReminderOccurrence> = {},
): AppointmentReminderOccurrence {
  return {
    source: "fallback",
    scheduled_for: "2026-10-19T01:00:00.000Z",
    reminder_id: null,
    reminder_offset_minutes: 1440,
    ...updates,
  };
}

function appointmentEvent(
  updates: Partial<AppointmentEventRow> = {},
): AppointmentEventRow {
  return {
    id: APPOINTMENT_EVENT_ID,
    schedule_id: SCHEDULE_ID,
    patient_id: PATIENT_ID,
    event_type: "appointment_rescheduled",
    previous_start_time: "2026-10-20T01:00:00.000Z",
    previous_end_time: "2026-10-20T01:30:00.000Z",
    new_start_time: "2026-10-21T02:00:00.000Z",
    new_end_time: "2026-10-21T02:30:00.000Z",
    created_at: "2026-09-23T04:05:06.789Z",
    ...updates,
  };
}

function createDependencies(transportResult = { ok: true, sent: true, status: "sent" }) {
  const claims = new Map<string, string>();
  const claimPlans: AppointmentSmsPlan[] = [];
  const transportRequests: Array<{ dispatchId: string; message: string }> = [];

  return {
    claimPlans,
    transportRequests,
    dependencies: {
      claimDispatch: (plan: AppointmentSmsPlan) => {
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
        return Promise.resolve(transportResult);
      },
    },
  };
}

Deno.test("confirmation creates the deterministic dispatch key", () => {
  const result = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.confirmed,
    appointment: appointment(),
    now: NOW,
  });

  assertEquals(
    result.plan?.dispatchKey,
    `appointment:${SCHEDULE_ID}:confirmed:sms`,
  );
});

Deno.test("duplicate confirmation invokes transport only once", async () => {
  const harness = createDependencies();
  const input = {
    event: appointmentSmsEvents.confirmed,
    appointment: appointment(),
    now: NOW,
  };

  await orchestrateAppointmentSms(input, harness.dependencies);
  await orchestrateAppointmentSms(input, harness.dependencies);

  assertEquals(harness.transportRequests.length, 1);
});

Deno.test("pending Patient booking request does not create confirmation SMS", () => {
  const result = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.confirmed,
    appointment: appointment({
      description: JSON.stringify({
        source: "patient-booking-request",
        requestedByPatient: true,
        requestStatus: "pending",
      }),
    }),
    now: NOW,
  });

  assertEquals(result.plan, null);
  assertEquals(result.reason, "booking_request_pending");
});

Deno.test("approved booking creates a confirmation event", () => {
  const result = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.confirmed,
    appointment: appointment({
      description: JSON.stringify({
        source: "patient-booking-request",
        requestedByPatient: true,
        requestStatus: "accepted",
      }),
    }),
    now: NOW,
  });

  assertEquals(result.plan?.notificationType, "appointment_confirmed");
});

Deno.test("first real reschedule event produces one claim with its immutable ID", async () => {
  const harness = createDependencies();
  await orchestrateAppointmentSms(
    {
      event: appointmentSmsEvents.rescheduled,
      appointment: appointment(),
      appointmentEvent: appointmentEvent(),
      now: NOW,
    },
    harness.dependencies,
  );

  assertEquals(
    harness.claimPlans[0]?.dispatchKey,
    `appointment:${SCHEDULE_ID}:rescheduled:${APPOINTMENT_EVENT_ID}:sms`,
  );
  assertEquals(harness.claimPlans.length, 1);
});

Deno.test("retrying the same reschedule does not duplicate transport", async () => {
  const harness = createDependencies();
  const input = {
    event: appointmentSmsEvents.rescheduled,
    appointment: appointment(),
    appointmentEvent: appointmentEvent(),
    now: NOW,
  };

  await orchestrateAppointmentSms(input, harness.dependencies);
  await orchestrateAppointmentSms(input, harness.dependencies);

  assertEquals(harness.transportRequests.length, 1);
});

Deno.test("unrelated schedule updates cannot change a reschedule key", () => {
  const first = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.rescheduled,
    appointment: appointment({ updated_at: "2026-09-23T04:05:06.789Z" }),
    appointmentEvent: appointmentEvent(),
    now: NOW,
  });
  const second = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.rescheduled,
    appointment: appointment({ updated_at: "2026-09-24T05:06:07.890Z" }),
    appointmentEvent: appointmentEvent(),
    now: NOW,
  });

  assertEquals(first.plan?.dispatchKey, second.plan?.dispatchKey);
});

Deno.test("a second genuine reschedule event creates a different key", () => {
  const secondEventId = "66666666-6666-4666-8666-666666666666";
  assert(APPOINTMENT_EVENT_ID !== secondEventId, "Event IDs must differ");
  const first = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.rescheduled,
    appointment: appointment(),
    appointmentEvent: appointmentEvent(),
    now: NOW,
  });
  const second = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.rescheduled,
    appointment: appointment(),
    appointmentEvent: appointmentEvent({ id: secondEventId }),
    now: NOW,
  });

  assert(first.plan?.dispatchKey !== second.plan?.dispatchKey, "Keys must differ");
  assert(second.plan?.dispatchKey.includes(secondEventId), "Second event ID must be used");
});

Deno.test("reschedule event schedule mismatch is rejected", () => {
  const result = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.rescheduled,
    appointment: appointment(),
    appointmentEvent: appointmentEvent({
      schedule_id: "77777777-7777-4777-8777-777777777777",
    }),
    now: NOW,
  });
  assertEquals(result.plan, null);
});

Deno.test("reschedule event Patient mismatch is rejected", () => {
  const result = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.rescheduled,
    appointment: appointment(),
    appointmentEvent: appointmentEvent({
      patient_id: "88888888-8888-4888-8888-888888888888",
    }),
    now: NOW,
  });
  assertEquals(result.plan, null);
});

Deno.test("wrong appointment event type is rejected", () => {
  const result = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.rescheduled,
    appointment: appointment(),
    appointmentEvent: appointmentEvent({ event_type: "appointment_cancelled" }),
    now: NOW,
  });
  assertEquals(result.plan, null);
});

Deno.test("reschedule SMS uses the immutable event's new appointment time", () => {
  const result = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.rescheduled,
    appointment: appointment({ start_time: "2026-11-01T08:00:00.000Z" }),
    appointmentEvent: appointmentEvent({
      new_start_time: "2026-10-21T02:00:00.000Z",
      new_end_time: "2026-10-21T02:30:00.000Z",
    }),
    now: NOW,
  });

  assert(result.plan?.message.includes("Oct 21, 2026 at 10:00 AM"), "Event time must be used");
  assert(!result.plan?.message.includes("Nov 1, 2026"), "Current schedule time must not replace event time");
});

Deno.test("a no-time-change result without an event cannot dispatch reschedule SMS", () => {
  const result = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.rescheduled,
    appointment: appointment(),
    appointmentEvent: null,
    now: NOW,
  });

  assertEquals(result.plan, null);
  assertEquals(result.reason, "invalid_appointment_reschedule_event");
});

Deno.test("cancellation creates one deterministic event", () => {
  const result = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.cancelled,
    appointment: appointment({ status: "cancelled" }),
    now: NOW,
  });

  assertEquals(
    result.plan?.dispatchKey,
    `appointment:${SCHEDULE_ID}:cancelled:sms`,
  );
});

Deno.test("duplicate cancellation invokes transport only once", async () => {
  const harness = createDependencies();
  const input = {
    event: appointmentSmsEvents.cancelled,
    appointment: appointment({ status: "cancelled" }),
    now: NOW,
  };

  await orchestrateAppointmentSms(input, harness.dependencies);
  await orchestrateAppointmentSms(input, harness.dependencies);

  assertEquals(harness.transportRequests.length, 1);
});

Deno.test("No Show does not produce cancellation SMS", () => {
  const result = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.cancelled,
    appointment: appointment({ status: "no_show" }),
    now: NOW,
  });
  assertEquals(result.plan, null);
});

Deno.test("checked-in appointment does not generate appointment SMS", () => {
  const result = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.confirmed,
    appointment: appointment({ status: "checked_in" }),
    now: NOW,
  });
  assertEquals(result.plan, null);
});

Deno.test("completed appointment does not generate appointment SMS", () => {
  const result = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.confirmed,
    appointment: appointment({ status: "completed" }),
    now: NOW,
  });
  assertEquals(result.plan, null);
});

Deno.test("eligible reminder creates a timestamped deterministic key", () => {
  const result = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.reminder,
    appointment: appointment(),
    reminder: reminder(),
    reminderOccurrence: configuredReminderOccurrence(),
    now: NOW,
  });

  assertEquals(
    result.plan?.dispatchKey,
    `appointment:${SCHEDULE_ID}:reminder:2026-10-19T01:00:00.000Z:sms`,
  );
});

Deno.test("duplicate reminder execution invokes transport only once", async () => {
  const harness = createDependencies();
  const input = {
    event: appointmentSmsEvents.reminder,
    appointment: appointment(),
    reminder: reminder(),
    reminderOccurrence: configuredReminderOccurrence(),
    now: NOW,
  };

  await orchestrateAppointmentSms(input, harness.dependencies);
  await orchestrateAppointmentSms(input, harness.dependencies);

  assertEquals(harness.transportRequests.length, 1);
});

Deno.test("cancelled appointment does not receive upcoming reminder", () => {
  const result = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.reminder,
    appointment: appointment({ status: "cancelled" }),
    reminder: reminder(),
    reminderOccurrence: configuredReminderOccurrence(),
    now: NOW,
  });
  assertEquals(result.plan, null);
});

Deno.test("completed appointment does not receive upcoming reminder", () => {
  const result = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.reminder,
    appointment: appointment({ status: "completed" }),
    reminder: reminder(),
    reminderOccurrence: configuredReminderOccurrence(),
    now: NOW,
  });
  assertEquals(result.plan, null);
});

Deno.test("same reminder occurrence always produces the same dispatch key", () => {
  const input = {
    event: appointmentSmsEvents.reminder,
    appointment: appointment(),
    reminder: reminder(),
    reminderOccurrence: configuredReminderOccurrence(),
    now: NOW,
  };

  const first = buildAppointmentSmsPlan(input);
  const second = buildAppointmentSmsPlan(input);

  assertEquals(first.plan?.dispatchKey, second.plan?.dispatchKey);
});

Deno.test("a genuinely different reminder occurrence produces a different key", () => {
  const first = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.reminder,
    appointment: appointment(),
    reminder: reminder(),
    reminderOccurrence: configuredReminderOccurrence(),
    now: NOW,
  });
  const second = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.reminder,
    appointment: appointment(),
    reminder: reminder(),
    reminderOccurrence: configuredReminderOccurrence({
      scheduled_for: "2026-10-19T01:30:00.000Z",
    }),
    now: NOW,
  });

  assert(first.plan?.dispatchKey !== second.plan?.dispatchKey, "Keys must differ");
});

Deno.test("configured reminder occurrence maps to its exact claimed time", () => {
  const result = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.reminder,
    appointment: appointment(),
    reminder: reminder({
      next_trigger_at: "2026-10-19T05:00:00.000Z",
    }),
    reminderOccurrence: configuredReminderOccurrence(),
    now: NOW,
  });

  assertEquals(result.plan?.scheduledFor, "2026-10-19T01:00:00.000Z");
  assertEquals(
    result.plan?.dispatchKey,
    `appointment:${SCHEDULE_ID}:reminder:2026-10-19T01:00:00.000Z:sms`,
  );
});

Deno.test("fallback reminder occurrence maps schedule and offset correctly", () => {
  const result = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.reminder,
    appointment: appointment(),
    reminderOccurrence: fallbackReminderOccurrence(),
    now: NOW,
  });

  assertEquals(result.plan?.scheduledFor, "2026-10-19T01:00:00.000Z");
  assertEquals(
    result.plan?.dispatchKey,
    `appointment:${SCHEDULE_ID}:reminder:2026-10-19T01:00:00.000Z:sms`,
  );
});

Deno.test("fallback reminder rejects a timestamp that does not match its offset", () => {
  const result = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.reminder,
    appointment: appointment(),
    reminderOccurrence: fallbackReminderOccurrence({
      scheduled_for: "2026-10-19T02:00:00.000Z",
    }),
    now: new Date("2026-10-19T03:00:00.000Z"),
  });

  assertEquals(result.plan, null);
  assertEquals(result.reason, "fallback_reminder_time_mismatch");
});

Deno.test("reminder orchestration plan never contains a Patient phone number", () => {
  const result = buildAppointmentSmsPlan({
    event: appointmentSmsEvents.reminder,
    appointment: appointment(),
    reminderOccurrence: fallbackReminderOccurrence(),
    now: NOW,
  });

  assert(result.plan, "Expected an eligible reminder plan");
  assert(!("phone" in result.plan), "Plan must not contain phone");
  assert(!("phone_number" in result.plan), "Plan must not contain phone_number");
  assert(!("contact_number" in result.plan), "Plan must not contain contact_number");
});

Deno.test("SMS message excludes clinical appointment fields", () => {
  const message = buildAppointmentSmsMessage(
    appointmentSmsEvents.confirmed,
    appointment({
      title: "High-risk pregnancy diabetes review",
      description: "Diagnosis: preeclampsia; medication: private prescription",
    }),
    NOW,
  ).toLowerCase();

  for (const sensitiveText of [
    "high-risk",
    "diabetes",
    "diagnosis",
    "preeclampsia",
    "medication",
    "prescription",
  ]) {
    assert(!message.includes(sensitiveText), `Message leaked ${sensitiveText}`);
  }
});

Deno.test("date and time formatting use the project Manila timezone", () => {
  assertEquals(
    formatAppointmentSmsDate("2026-10-20T01:00:00.000Z"),
    "Oct 20, 2026",
  );
  assertEquals(
    formatAppointmentSmsTime("2026-10-20T01:00:00.000Z"),
    "9:00 AM",
  );
});

Deno.test("Phase 2 transport runs only when claim may_send is true", async () => {
  let transportCalls = 0;
  const result = await orchestrateAppointmentSms(
    {
      event: appointmentSmsEvents.confirmed,
      appointment: appointment(),
      now: NOW,
    },
    {
      claimDispatch: () =>
        Promise.resolve({
          dispatch_id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
          dispatch_status: "sent",
          newly_claimed: false,
          may_send: false,
        }),
      invokeTransport: () => {
        transportCalls += 1;
        return Promise.resolve({ ok: true, sent: true, status: "sent" });
      },
    },
  );

  assertEquals(result.idempotent, true);
  assertEquals(transportCalls, 0);
});

Deno.test("provider failure does not alter the successful appointment", async () => {
  const savedAppointment = appointment();
  const before = JSON.stringify(savedAppointment);
  const harness = createDependencies({ ok: false, sent: false, status: "failed" });

  const result = await orchestrateAppointmentSms(
    {
      event: appointmentSmsEvents.rescheduled,
      appointment: savedAppointment,
      appointmentEvent: appointmentEvent(),
      now: NOW,
    },
    harness.dependencies,
  );

  assertEquals(result.ok, false);
  assertEquals(JSON.stringify(savedAppointment), before);
});

Deno.test("targeted orchestration tests use injected transport with no network", async () => {
  let injectedTransportCalls = 0;
  const result = await orchestrateAppointmentSms(
    {
      event: appointmentSmsEvents.confirmed,
      appointment: appointment(),
      now: NOW,
    },
    {
      claimDispatch: () =>
        Promise.resolve({
          dispatch_id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
          dispatch_status: "processing",
          newly_claimed: true,
          may_send: true,
        }),
      invokeTransport: () => {
        injectedTransportCalls += 1;
        return Promise.resolve({ ok: true, sent: true, status: "sent" });
      },
    },
  );

  assertEquals(result.sent, true);
  assertEquals(injectedTransportCalls, 1);
});
