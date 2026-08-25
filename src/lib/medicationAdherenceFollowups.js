import {
  APPOINTMENT_TIME_ZONE,
  formatAppointmentDate,
  formatAppointmentTime,
  getManilaDateKey,
  toManilaISOString,
} from "./appointmentDate.js";

export const MEDICATION_ADHERENCE_FOLLOWUP_STATUSES = {
  open: "open",
  contacted: "contacted",
  monitoring: "monitoring",
  resolved: "resolved",
};

export const MEDICATION_ADHERENCE_ACTIVE_FOLLOWUP_STATUSES = [
  MEDICATION_ADHERENCE_FOLLOWUP_STATUSES.open,
  MEDICATION_ADHERENCE_FOLLOWUP_STATUSES.contacted,
  MEDICATION_ADHERENCE_FOLLOWUP_STATUSES.monitoring,
];

export const MEDICATION_ADHERENCE_FOLLOWUP_STATUS_LABELS = {
  open: "Open",
  contacted: "Contacted",
  monitoring: "Monitoring",
  resolved: "Resolved",
};

export const MEDICATION_ADHERENCE_FOLLOWUP_SEVERITY_LABELS = {
  warning: "Needs Attention",
  high: "High Priority",
  critical: "Critical Follow-up",
  normal: "Normal",
};

export const MEDICATION_ADHERENCE_FOLLOWUP_CONTACT_METHODS = [
  { value: "phone", label: "Phone" },
  { value: "sms", label: "SMS" },
  { value: "email", label: "Email" },
  { value: "in_app_notification", label: "In-app notification" },
  { value: "in_person", label: "In person" },
  { value: "other", label: "Other" },
];

export const MEDICATION_ADHERENCE_FOLLOWUP_EVENT_LABELS = {
  followup_started: "Follow-up started",
  note_added: "Follow-up note added",
  contact_attempt: "Contact attempt recorded",
  patient_contacted: "Patient contacted",
  notification_sent: "In-app notification sent",
  status_changed: "Follow-up status changed",
  followup_scheduled: "Follow-up scheduled",
  resolved: "Follow-up resolved",
  reopened: "Follow-up reopened",
  attention_acknowledged: "Alert acknowledged",
  attention_snoozed: "Alert snoozed",
  doctor_reassigned: "Doctor reassigned",
};

const validSnapshotSeverities = new Set(["warning", "high", "critical"]);
const activeStatusSet = new Set(MEDICATION_ADHERENCE_ACTIVE_FOLLOWUP_STATUSES);
const allowedTransitions = {
  open: new Set(["contacted", "monitoring"]),
  contacted: new Set(["monitoring", "resolved"]),
  monitoring: new Set(["contacted", "resolved"]),
  resolved: new Set(),
};

export function isActiveMedicationAdherenceFollowup(followup) {
  return activeStatusSet.has(String(followup?.status || "").trim().toLowerCase());
}

export function validateMedicationAdherenceFollowupSnapshot(snapshot) {
  const errors = [];
  const severity = String(snapshot?.severity || "").trim().toLowerCase();
  const countKeys = [
    "totalCompletedOutcomes",
    "takenCount",
    "skippedCount",
    "missedCount",
    "maximumMissedStreak",
  ];

  if (!validSnapshotSeverities.has(severity)) {
    errors.push("A valid alert severity is required.");
  }

  countKeys.forEach((key) => {
    if (!Number.isInteger(snapshot?.[key]) || snapshot[key] < 0) {
      errors.push(`${key} must be a non-negative integer.`);
    }
  });

  if (
    Number.isInteger(snapshot?.totalCompletedOutcomes) &&
    Number.isInteger(snapshot?.takenCount) &&
    Number.isInteger(snapshot?.skippedCount) &&
    Number.isInteger(snapshot?.missedCount) &&
    snapshot.totalCompletedOutcomes !==
      snapshot.takenCount + snapshot.skippedCount + snapshot.missedCount
  ) {
    errors.push("Completed outcome counts do not match their total.");
  }

  if (
    snapshot?.adherenceRate !== null &&
    snapshot?.adherenceRate !== undefined &&
    (!Number.isFinite(snapshot.adherenceRate) ||
      snapshot.adherenceRate < 0 ||
      snapshot.adherenceRate > 100)
  ) {
    errors.push("Adherence rate must be between 0 and 100.");
  }

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(String(snapshot?.analysisWindowStart || "")) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(String(snapshot?.analysisWindowEnd || "")) ||
    snapshot.analysisWindowEnd < snapshot.analysisWindowStart
  ) {
    errors.push("A valid analysis period is required.");
  }

  return errors;
}

export function canTransitionMedicationAdherenceFollowup(fromStatus, toStatus) {
  const from = String(fromStatus || "").trim().toLowerCase();
  const to = String(toStatus || "").trim().toLowerCase();
  return Boolean(allowedTransitions[from]?.has(to));
}

export function validateMedicationAdherenceFollowupResolution(
  followup,
  resolutionSummary
) {
  const summary = String(resolutionSummary || "").trim();
  if (!canTransitionMedicationAdherenceFollowup(followup?.status, "resolved")) {
    return "This follow-up cannot be resolved from its current status.";
  }
  if (!summary) return "A resolution summary is required.";
  if (summary.length > 2000) {
    return "Resolution summary must not exceed 2000 characters.";
  }
  return "";
}

export function buildMedicationAdherenceFollowupSnapshot(alert, dateRange) {
  const snapshot = {
    severity: String(alert?.severity || "").trim().toLowerCase(),
    adherenceRate:
      alert?.adherenceRate === null || alert?.adherenceRate === undefined
        ? null
        : Number(alert.adherenceRate),
    totalCompletedOutcomes: Number(alert?.totalCompletedOutcomes),
    takenCount: Number(alert?.takenCount),
    skippedCount: Number(alert?.skippedCount),
    missedCount: Number(alert?.missedCount),
    maximumMissedStreak: Number(alert?.maximumMissedStreak),
    analysisWindowStart: String(dateRange?.startDate || ""),
    analysisWindowEnd: String(dateRange?.endDate || ""),
    latestCompletedDoseAt: alert?.mostRecentCompletedAt || null,
  };
  const errors = validateMedicationAdherenceFollowupSnapshot(snapshot);
  if (errors.length) throw new Error(errors[0]);
  return snapshot;
}

export function getMedicationFollowupDateTimeIso(dateValue, timeValue) {
  if (!dateValue && !timeValue) return null;
  const iso = toManilaISOString(dateValue, timeValue);
  if (!iso) throw new Error("Enter a valid follow-up date and time.");
  return iso;
}

export function getMedicationFollowupSnoozeUntil({
  option,
  now = new Date(),
  customDate = "",
  customTime = "",
}) {
  if (option === "30_minutes") {
    return new Date(now.getTime() + 30 * 60_000).toISOString();
  }
  if (option === "1_hour") {
    return new Date(now.getTime() + 60 * 60_000).toISOString();
  }
  if (option === "4_hours") {
    return new Date(now.getTime() + 4 * 60 * 60_000).toISOString();
  }
  if (option === "tomorrow_morning") {
    const today = getManilaDateKey(now);
    const nextDate = new Date(`${today}T00:00:00Z`);
    if (Number.isNaN(nextDate.getTime())) return null;
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    return toManilaISOString(nextDate.toISOString().slice(0, 10), "08:00");
  }
  if (option === "custom") {
    return toManilaISOString(customDate, customTime);
  }
  return null;
}

export function getMedicationFollowupDueState(followup, now = new Date()) {
  if (!isActiveMedicationAdherenceFollowup(followup) || !followup?.next_follow_up_at) {
    return "none";
  }

  const dueAt = new Date(followup.next_follow_up_at);
  if (Number.isNaN(dueAt.getTime())) return "none";

  const dueDate = getManilaDateKey(dueAt);
  const today = getManilaDateKey(now);
  if (dueAt.getTime() < now.getTime()) return "overdue";
  if (dueDate === today) return "today";
  return "upcoming";
}

export function formatMedicationFollowupDateTime(value, fallback = "Not scheduled") {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return `${formatAppointmentDate(date)} at ${formatAppointmentTime(date)}`;
}

export function formatMedicationFollowupDate(value, fallback = "Not recorded") {
  if (!value) return fallback;
  return formatAppointmentDate(value);
}

export function formatMedicationFollowupStatus(status) {
  return (
    MEDICATION_ADHERENCE_FOLLOWUP_STATUS_LABELS[
      String(status || "").trim().toLowerCase()
    ] || "Open"
  );
}

export function formatMedicationFollowupRate(value) {
  const rate = Number(value);
  return value === null || value === undefined || !Number.isFinite(rate)
    ? "-"
    : `${rate}%`;
}

export function formatMedicationFollowupSeverity(severity) {
  return (
    MEDICATION_ADHERENCE_FOLLOWUP_SEVERITY_LABELS[
      String(severity || "").trim().toLowerCase()
    ] || "Needs Attention"
  );
}

export function formatMedicationFollowupContactMethod(method) {
  const match = MEDICATION_ADHERENCE_FOLLOWUP_CONTACT_METHODS.find(
    (item) => item.value === method
  );
  return match?.label || "";
}

export function formatMedicationFollowupEventLabel(eventType) {
  return MEDICATION_ADHERENCE_FOLLOWUP_EVENT_LABELS[eventType] || "Follow-up activity";
}

export function formatMedicationFollowupDateInput(value = new Date()) {
  return getManilaDateKey(value);
}

export function formatMedicationFollowupTimeZoneLabel() {
  return APPOINTMENT_TIME_ZONE;
}

export function getMedicationFollowupNotificationId(result) {
  const row = Array.isArray(result) ? result[0] : result;
  const id = String(row?.id || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id
  )
    ? id
    : "";
}
