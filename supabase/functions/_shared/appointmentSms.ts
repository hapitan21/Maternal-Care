export const APPOINTMENT_SMS_TIME_ZONE = "Asia/Manila";

export const appointmentSmsEvents = {
  confirmed: "appointment_confirmed",
  rescheduled: "appointment_rescheduled",
  cancelled: "appointment_cancelled",
  reminder: "appointment_reminder",
} as const;

export type AppointmentSmsEvent =
  (typeof appointmentSmsEvents)[keyof typeof appointmentSmsEvents];

export type AppointmentSmsRow = {
  id: string;
  patient_id: string;
  doctor_id: string | null;
  title: string | null;
  description: string | null;
  start_time: string;
  end_time: string | null;
  status: string;
  created_at: string | null;
  updated_at: string | null;
};

export type AppointmentReminderRow = {
  id: string;
  patient_id: string;
  schedule_id: string;
  reminder_type: string;
  remind_at: string;
  next_trigger_at: string | null;
  status: string;
};

export type AppointmentReminderOccurrence = {
  source: "configured" | "fallback";
  scheduled_for: string;
  reminder_id: string | null;
  reminder_offset_minutes: number | null;
};

export type AppointmentEventRow = {
  id: string;
  schedule_id: string;
  patient_id: string;
  event_type: string;
  previous_start_time: string | null;
  previous_end_time: string | null;
  new_start_time: string;
  new_end_time: string;
  created_at: string;
};

export type AppointmentSmsPlan = {
  dispatchKey: string;
  notificationType: AppointmentSmsEvent;
  patientId: string;
  scheduleId: string;
  scheduledFor: string | null;
  message: string;
};

type ClaimResult = {
  dispatch_id: string;
  dispatch_status: string;
  newly_claimed: boolean;
  may_send: boolean;
  retry_eligible?: boolean;
};

type TransportResult = {
  ok?: boolean;
  sent?: boolean;
  status?: string;
  [key: string]: unknown;
};

type AppointmentSmsDependencies = {
  claimDispatch: (plan: AppointmentSmsPlan) => Promise<ClaimResult>;
  invokeTransport: (request: {
    dispatchId: string;
    message: string;
  }) => Promise<TransportResult>;
};

function parseTimestamp(value: unknown): Date | null {
  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeTimestamp(value: unknown): string | null {
  return parseTimestamp(value)?.toISOString() || null;
}

function normalizeStatus(value: unknown): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (["scheduled", "pending", "accepted"].includes(normalized)) {
    return "scheduled";
  }
  if (["cancel", "cancelled", "canceled"].includes(normalized)) {
    return "cancelled";
  }
  if (["no_show", "noshow", "missed", "absent"].includes(normalized)) {
    return "missed";
  }
  if (["complete", "completed", "done"].includes(normalized)) {
    return "completed";
  }
  if (["check_in", "checked_in", "checkedin"].includes(normalized)) {
    return "checked_in";
  }

  return normalized;
}

function parseDescription(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim().startsWith("{")) return {};

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function isPendingPatientBooking(appointment: AppointmentSmsRow): boolean {
  const details = parseDescription(appointment.description);
  const requestStatus = String(
    details.requestStatus || details.request_status || "",
  )
    .trim()
    .toLowerCase();
  const requestedByPatient = details.requestedByPatient === true ||
    details.requestedByPatient === "true";

  return requestedByPatient && requestStatus !== "accepted";
}

export function formatAppointmentSmsDate(value: string): string {
  const date = parseTimestamp(value);
  if (!date) return "";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: APPOINTMENT_SMS_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function formatAppointmentSmsTime(value: string): string {
  const date = parseTimestamp(value);
  if (!date) return "";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: APPOINTMENT_SMS_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function getManilaDateKey(value: string | Date): string {
  const date = parseTimestamp(value);
  if (!date) return "";

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APPOINTMENT_SMS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isTomorrowInManila(appointmentTime: string, now: Date): boolean {
  const todayKey = getManilaDateKey(now);
  if (!todayKey) return false;

  const tomorrow = new Date(`${todayKey}T00:00:00+08:00`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return getManilaDateKey(appointmentTime) === getManilaDateKey(tomorrow);
}

export function buildAppointmentSmsMessage(
  event: AppointmentSmsEvent,
  appointment: AppointmentSmsRow,
  now = new Date(),
): string {
  const date = formatAppointmentSmsDate(appointment.start_time);
  const time = formatAppointmentSmsTime(appointment.start_time);

  switch (event) {
    case appointmentSmsEvents.confirmed:
      return `Maternal Care: Your appointment is confirmed for ${date} at ${time}. Please arrive 15 minutes early.`;
    case appointmentSmsEvents.rescheduled:
      return `Maternal Care: Your appointment has been rescheduled to ${date} at ${time}. Please check the app for details.`;
    case appointmentSmsEvents.cancelled:
      return `Maternal Care: Your appointment on ${date} at ${time} has been cancelled. Please check the app for details.`;
    case appointmentSmsEvents.reminder:
      return isTomorrowInManila(appointment.start_time, now)
        ? `Maternal Care reminder: You have an appointment tomorrow at ${time}. Please arrive 15 minutes early.`
        : `Maternal Care reminder: You have an appointment on ${date} at ${time}. Please arrive 15 minutes early.`;
  }
}

export function buildAppointmentSmsPlan({
  event,
  appointment,
  appointmentEvent = null,
  reminder = null,
  reminderOccurrence = null,
  now = new Date(),
}: {
  event: AppointmentSmsEvent;
  appointment: AppointmentSmsRow;
  appointmentEvent?: AppointmentEventRow | null;
  reminder?: AppointmentReminderRow | null;
  reminderOccurrence?: AppointmentReminderOccurrence | null;
  now?: Date;
}): { plan: AppointmentSmsPlan | null; reason: string | null } {
  const status = normalizeStatus(appointment.status);
  const appointmentStart = parseTimestamp(appointment.start_time);

  if (!appointment.id || !appointment.patient_id || !appointmentStart) {
    return { plan: null, reason: "invalid_appointment" };
  }

  if (isPendingPatientBooking(appointment)) {
    return { plan: null, reason: "booking_request_pending" };
  }

  let dispatchKey = "";
  let scheduledFor: string | null = null;

  if (event === appointmentSmsEvents.confirmed) {
    if (status !== "scheduled") {
      return { plan: null, reason: "appointment_not_confirmed" };
    }
    dispatchKey = `appointment:${appointment.id}:confirmed:sms`;
  } else if (event === appointmentSmsEvents.rescheduled) {
    if (
      status !== "scheduled" ||
      !appointmentEvent ||
      appointmentEvent.schedule_id !== appointment.id ||
      appointmentEvent.patient_id !== appointment.patient_id ||
      appointmentEvent.event_type !== appointmentSmsEvents.rescheduled
    ) {
      return { plan: null, reason: "invalid_appointment_reschedule_event" };
    }
    const eventStart = parseTimestamp(appointmentEvent.new_start_time);
    const eventEnd = parseTimestamp(appointmentEvent.new_end_time);
    if (!eventStart || !eventEnd || eventEnd <= eventStart) {
      return { plan: null, reason: "invalid_appointment_reschedule_time" };
    }
    dispatchKey =
      `appointment:${appointment.id}:rescheduled:${appointmentEvent.id}:sms`;
    scheduledFor = eventStart.toISOString();
  } else if (event === appointmentSmsEvents.cancelled) {
    if (status !== "cancelled") {
      return { plan: null, reason: "appointment_not_cancelled" };
    }
    dispatchKey = `appointment:${appointment.id}:cancelled:sms`;
  } else if (event === appointmentSmsEvents.reminder) {
    if (status !== "scheduled" || appointmentStart.getTime() <= now.getTime()) {
      return { plan: null, reason: "appointment_not_reminder_eligible" };
    }
    const reminderTimestamp = normalizeTimestamp(
      reminderOccurrence?.scheduled_for,
    );
    if (!reminderTimestamp) {
      return { plan: null, reason: "invalid_reminder_timestamp" };
    }
    if (new Date(reminderTimestamp).getTime() > now.getTime()) {
      return { plan: null, reason: "appointment_reminder_not_due" };
    }

    if (reminderOccurrence?.source === "configured") {
      if (
        !reminder ||
        !reminderOccurrence.reminder_id ||
        reminder.id !== reminderOccurrence.reminder_id ||
        reminder.schedule_id !== appointment.id ||
        reminder.patient_id !== appointment.patient_id ||
        String(reminder.reminder_type || "").trim().toLowerCase() !==
          "appointment"
      ) {
        return { plan: null, reason: "invalid_appointment_reminder" };
      }
    } else if (reminderOccurrence?.source === "fallback") {
      const offsetMinutes = reminderOccurrence.reminder_offset_minutes;
      if (
        reminderOccurrence.reminder_id !== null ||
        (offsetMinutes !== 1440 && offsetMinutes !== 120)
      ) {
        return { plan: null, reason: "invalid_fallback_reminder" };
      }

      const expectedTimestamp = new Date(
        appointmentStart.getTime() - offsetMinutes * 60_000,
      ).toISOString();
      if (reminderTimestamp !== expectedTimestamp) {
        return { plan: null, reason: "fallback_reminder_time_mismatch" };
      }
    } else {
      return { plan: null, reason: "invalid_appointment_reminder" };
    }

    dispatchKey =
      `appointment:${appointment.id}:reminder:${reminderTimestamp}:sms`;
    scheduledFor = reminderTimestamp;
  } else {
    return { plan: null, reason: "unsupported_appointment_event" };
  }

  return {
    plan: {
      dispatchKey,
      notificationType: event,
      patientId: appointment.patient_id,
      scheduleId: appointment.id,
      scheduledFor,
      message: buildAppointmentSmsMessage(
        event,
        event === appointmentSmsEvents.rescheduled && appointmentEvent
          ? {
            ...appointment,
            start_time: appointmentEvent.new_start_time,
            end_time: appointmentEvent.new_end_time,
          }
          : appointment,
        now,
      ),
    },
    reason: null,
  };
}

export async function orchestrateAppointmentSms(
  input: {
    event: AppointmentSmsEvent;
    appointment: AppointmentSmsRow;
    appointmentEvent?: AppointmentEventRow | null;
    reminder?: AppointmentReminderRow | null;
    reminderOccurrence?: AppointmentReminderOccurrence | null;
    now?: Date;
  },
  dependencies: AppointmentSmsDependencies,
) {
  const planning = buildAppointmentSmsPlan(input);
  if (!planning.plan) {
    return {
      ok: true,
      sent: false,
      skipped: true,
      reason: planning.reason,
    };
  }

  const claim = await dependencies.claimDispatch(planning.plan);
  if (!claim.newly_claimed || !claim.may_send) {
    return {
      ok: true,
      sent: false,
      skipped: true,
      idempotent: true,
      reason: "dispatch_already_claimed",
      dispatchId: claim.dispatch_id,
      dispatchStatus: claim.dispatch_status,
    };
  }

  const transport = await dependencies.invokeTransport({
    dispatchId: claim.dispatch_id,
    message: planning.plan.message,
  });

  return {
    ok: transport.ok === true && transport.sent === true,
    sent: transport.sent === true,
    skipped: false,
    dispatchId: claim.dispatch_id,
    dispatchStatus: transport.status || null,
    transport,
  };
}
