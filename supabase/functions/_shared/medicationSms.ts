export const MEDICATION_SMS_TIME_ZONE = "Asia/Manila";
export const MEDICATION_SMS_EVENT = "medication_reminder" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INACTIVE_PATIENT_STATUSES = new Set([
  "inactive",
  "archived",
  "deleted",
]);
const ALLOWED_REQUEST_FIELDS = new Set([
  "event",
  "medication_occurrence_id",
]);

type JsonObject = Record<string, unknown>;

export type MedicationReminderSmsRequest = {
  event: typeof MEDICATION_SMS_EVENT;
  medicationOccurrenceId: string;
};

export type MedicationReminderRow = {
  id: string;
  patient_id: string;
  status: string;
  start_date: string;
  end_date: string | null;
};

export type MedicationOccurrenceRow = {
  id: string;
  medication_reminder_id: string;
  patient_id: string;
  scheduled_for: string;
  status: string;
  notification_id: string | null;
  notified_at: string | null;
  action_at: string | null;
  missed_at: string | null;
};

export type MedicationPatientRow = {
  id: string;
  user_id: string | null;
  status: string | null;
  account_status: string | null;
  archived_at: string | null;
};

export type MedicationNotificationRow = {
  id: string;
  patient_id: string;
  user_id: string;
  type: string;
};

export type MedicationSmsPlan = {
  dispatchKey: string;
  notificationType: typeof MEDICATION_SMS_EVENT;
  patientId: string;
  medicationReminderId: string;
  medicationOccurrenceId: string;
  relatedNotificationId: string;
  scheduledFor: string;
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

type MedicationSmsDependencies = {
  claimDispatch: (plan: MedicationSmsPlan) => Promise<ClaimResult>;
  invokeTransport: (request: {
    dispatchId: string;
    message: string;
  }) => Promise<TransportResult>;
};

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedStatus(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function parseTimestamp(value: unknown): Date | null {
  const parsed = new Date(String(value || ""));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getManilaDateKey(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MEDICATION_SMS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function parseMedicationSmsRequest(
  payload: unknown,
):
  | { ok: true; request: MedicationReminderSmsRequest }
  | { ok: false; error: string } {
  if (!isJsonObject(payload)) {
    return { ok: false, error: "invalid_request_body" };
  }

  if (Object.keys(payload).some((key) => !ALLOWED_REQUEST_FIELDS.has(key))) {
    return { ok: false, error: "unexpected_request_field" };
  }

  const event = typeof payload.event === "string" ? payload.event.trim() : "";
  const medicationOccurrenceId =
    typeof payload.medication_occurrence_id === "string"
      ? payload.medication_occurrence_id.trim()
      : "";

  if (event !== MEDICATION_SMS_EVENT) {
    return { ok: false, error: "unsupported_medication_event" };
  }
  if (!UUID_PATTERN.test(medicationOccurrenceId)) {
    return { ok: false, error: "invalid_medication_occurrence_id" };
  }

  return {
    ok: true,
    request: {
      event: MEDICATION_SMS_EVENT,
      medicationOccurrenceId,
    },
  };
}

export function buildMedicationSmsMessage(): string {
  return "Maternal Care reminder: It is time for your scheduled medication. Please check the app for details.";
}

export function buildMedicationSmsPlan({
  occurrence,
  reminder,
  patient,
  notification,
  now = new Date(),
}: {
  occurrence: MedicationOccurrenceRow | null;
  reminder: MedicationReminderRow | null;
  patient: MedicationPatientRow | null;
  notification: MedicationNotificationRow | null;
  now?: Date;
}): { plan: MedicationSmsPlan | null; reason: string | null } {
  if (!occurrence?.id) {
    return { plan: null, reason: "medication_occurrence_not_found" };
  }

  if (normalizedStatus(occurrence.status) !== "notified") {
    return { plan: null, reason: "medication_occurrence_not_sendable" };
  }

  if (
    !occurrence.notification_id ||
    !occurrence.notified_at ||
    occurrence.action_at ||
    occurrence.missed_at
  ) {
    return { plan: null, reason: "medication_occurrence_not_sendable" };
  }

  const scheduledFor = parseTimestamp(occurrence.scheduled_for);
  if (!scheduledFor || scheduledFor.getTime() > now.getTime()) {
    return { plan: null, reason: "invalid_medication_occurrence_time" };
  }
  if (scheduledFor.getTime() <= now.getTime() - 2 * 60 * 60 * 1000) {
    return { plan: null, reason: "medication_occurrence_expired" };
  }

  if (
    !reminder ||
    reminder.id !== occurrence.medication_reminder_id ||
    reminder.patient_id !== occurrence.patient_id ||
    normalizedStatus(reminder.status) !== "active"
  ) {
    return { plan: null, reason: "medication_reminder_inactive" };
  }

  const occurrenceDate = getManilaDateKey(scheduledFor);
  if (
    !reminder.start_date ||
    occurrenceDate < reminder.start_date ||
    (reminder.end_date !== null && occurrenceDate > reminder.end_date)
  ) {
    return { plan: null, reason: "medication_occurrence_outside_schedule" };
  }

  if (
    !patient ||
    patient.id !== occurrence.patient_id ||
    !patient.user_id ||
    normalizedStatus(patient.account_status) !== "active" ||
    patient.archived_at !== null ||
    INACTIVE_PATIENT_STATUSES.has(normalizedStatus(patient.status))
  ) {
    return { plan: null, reason: "patient_not_medication_sms_eligible" };
  }

  if (
    !notification ||
    notification.id !== occurrence.notification_id ||
    notification.patient_id !== occurrence.patient_id ||
    notification.user_id !== patient.user_id ||
    normalizedStatus(notification.type) !== MEDICATION_SMS_EVENT
  ) {
    return { plan: null, reason: "invalid_medication_notification" };
  }

  return {
    plan: {
      dispatchKey: `medication:${occurrence.id}:sms`,
      notificationType: MEDICATION_SMS_EVENT,
      patientId: occurrence.patient_id,
      medicationReminderId: occurrence.medication_reminder_id,
      medicationOccurrenceId: occurrence.id,
      relatedNotificationId: occurrence.notification_id,
      scheduledFor: scheduledFor.toISOString(),
      message: buildMedicationSmsMessage(),
    },
    reason: null,
  };
}

export async function orchestrateMedicationSms(
  input: {
    occurrence: MedicationOccurrenceRow | null;
    reminder: MedicationReminderRow | null;
    patient: MedicationPatientRow | null;
    notification: MedicationNotificationRow | null;
    now?: Date;
  },
  dependencies: MedicationSmsDependencies,
) {
  const planning = buildMedicationSmsPlan(input);
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
