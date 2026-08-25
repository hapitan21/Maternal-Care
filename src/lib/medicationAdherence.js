import {
  getManilaDateKey,
  toManilaISOString,
} from "./appointmentDate.js";
import {
  normalizePatientAccountStatus,
  patientAccountStatuses,
} from "./patientAccountStatus.js";

export const MEDICATION_ADHERENCE_COMPLETED_STATUSES = new Set([
  "taken",
  "skipped",
  "missed",
]);

export const MEDICATION_ADHERENCE_ALERT_SEVERITIES = {
  normal: "normal",
  warning: "warning",
  high: "high",
  critical: "critical",
};

export const MEDICATION_ADHERENCE_NOTIFICATION_DRAFT = {
  type: "medication_reminder",
  title: "Medication Reminder Follow-up",
  message:
    "Please review your medication reminders. Contact the clinic if you need assistance with your medication schedule.",
  priority: "important",
};

export const MEDICATION_ADHERENCE_FOLLOWUP_NOTIFICATION_CONTEXT = {
  type: "medication_reminder",
  title: "Medication Follow-up",
  message:
    "Please review your medication schedule and recorded doses. Contact the clinic if you need help following your medication plan.",
  priority: "important",
  targetPath: "/patient/reminders/medications",
  triggerLabel: "Send Follow-up Message",
  contextLabel: "Medication adherence follow-up",
  contextHelper:
    "This is a manual message from your Doctor and does not create or change a medication schedule.",
};

const severityLabels = {
  [MEDICATION_ADHERENCE_ALERT_SEVERITIES.normal]: "Normal",
  [MEDICATION_ADHERENCE_ALERT_SEVERITIES.warning]: "Needs Attention",
  [MEDICATION_ADHERENCE_ALERT_SEVERITIES.high]: "High Priority",
  [MEDICATION_ADHERENCE_ALERT_SEVERITIES.critical]: "Critical Follow-up",
};

const severitySortOrder = {
  [MEDICATION_ADHERENCE_ALERT_SEVERITIES.critical]: 0,
  [MEDICATION_ADHERENCE_ALERT_SEVERITIES.high]: 1,
  [MEDICATION_ADHERENCE_ALERT_SEVERITIES.warning]: 2,
  [MEDICATION_ADHERENCE_ALERT_SEVERITIES.normal]: 3,
};

export function normalizeMedicationAdherenceStatus(status) {
  return String(status || "").trim().toLowerCase();
}

export function addManilaCalendarDays(dateValue, amount) {
  const date = new Date(`${dateValue}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return "";

  date.setUTCDate(date.getUTCDate() + amount);
  return getManilaDateKey(date);
}

export function getMedicationAdherenceAlertDateRange(value = new Date()) {
  const endDate = getManilaDateKey(value);
  const startDate = addManilaCalendarDays(endDate, -6);
  const endExclusiveDate = addManilaCalendarDays(endDate, 1);

  return {
    startDate,
    endDate,
    startIso: toManilaISOString(startDate, "00:00"),
    endIso: toManilaISOString(endExclusiveDate, "00:00"),
  };
}

export function isEligibleMedicationAdherenceAlertPatient(patient) {
  if (!patient?.id || !patient?.user_id || patient?.archived_at) {
    return false;
  }

  const lifecycleStatus = String(patient.status || "").trim().toLowerCase();
  if (["inactive", "archived", "deleted"].includes(lifecycleStatus)) {
    return false;
  }

  return (
    normalizePatientAccountStatus(patient.account_status) ===
    patientAccountStatuses.active
  );
}

export function calculateMedicationAdherenceAlert(occurrences) {
  const completedOccurrences = (Array.isArray(occurrences) ? occurrences : [])
    .map((occurrence) => ({
      occurrence,
      status: normalizeMedicationAdherenceStatus(occurrence?.status),
      scheduledTime: new Date(occurrence?.scheduled_for || "").getTime(),
    }))
    .filter(
      (item) =>
        MEDICATION_ADHERENCE_COMPLETED_STATUSES.has(item.status) &&
        Number.isFinite(item.scheduledTime)
    )
    .sort((first, second) => {
      if (first.scheduledTime !== second.scheduledTime) {
        return first.scheduledTime - second.scheduledTime;
      }

      return String(first.occurrence?.id || "").localeCompare(
        String(second.occurrence?.id || "")
      );
    });

  let takenCount = 0;
  let skippedCount = 0;
  let missedCount = 0;
  let currentMissedStreak = 0;
  let maximumMissedStreak = 0;
  let latestMissedAt = null;

  completedOccurrences.forEach((item) => {
    if (item.status === "taken") {
      takenCount += 1;
      currentMissedStreak = 0;
      return;
    }

    if (item.status === "skipped") {
      skippedCount += 1;
      currentMissedStreak = 0;
      return;
    }

    missedCount += 1;
    currentMissedStreak += 1;
    maximumMissedStreak = Math.max(maximumMissedStreak, currentMissedStreak);
    latestMissedAt = item.occurrence.scheduled_for;
  });

  const totalCompletedOutcomes = completedOccurrences.length;
  const adherenceRate = totalCompletedOutcomes
    ? Math.round((takenCount / totalCompletedOutcomes) * 100)
    : null;

  let severity = MEDICATION_ADHERENCE_ALERT_SEVERITIES.normal;

  if (maximumMissedStreak >= 3) {
    severity = MEDICATION_ADHERENCE_ALERT_SEVERITIES.critical;
  } else if (totalCompletedOutcomes >= 3 && adherenceRate < 50) {
    severity = MEDICATION_ADHERENCE_ALERT_SEVERITIES.high;
  } else if (totalCompletedOutcomes >= 3 && adherenceRate < 80) {
    severity = MEDICATION_ADHERENCE_ALERT_SEVERITIES.warning;
  }

  return {
    totalCompletedOutcomes,
    takenCount,
    skippedCount,
    missedCount,
    adherenceRate,
    currentMissedStreak,
    maximumMissedStreak,
    severity,
    severityLabel: severityLabels[severity],
    latestMissedAt,
    mostRecentCompletedAt:
      completedOccurrences.at(-1)?.occurrence?.scheduled_for || null,
    shouldAlert: severity !== MEDICATION_ADHERENCE_ALERT_SEVERITIES.normal,
  };
}

export function compareMedicationAdherenceAlerts(first, second) {
  const severityDifference =
    severitySortOrder[first?.severity] - severitySortOrder[second?.severity];
  if (severityDifference) return severityDifference;

  const firstRate = Number.isFinite(first?.adherenceRate)
    ? first.adherenceRate
    : Number.POSITIVE_INFINITY;
  const secondRate = Number.isFinite(second?.adherenceRate)
    ? second.adherenceRate
    : Number.POSITIVE_INFINITY;
  if (firstRate !== secondRate) return firstRate - secondRate;

  if (first?.missedCount !== second?.missedCount) {
    return (second?.missedCount || 0) - (first?.missedCount || 0);
  }

  return String(first?.patientName || "").localeCompare(
    String(second?.patientName || "")
  );
}
