import {
  formatAppointmentDate,
  formatAppointmentTime,
  getManilaDateKey,
} from "./appointmentDate.js";
import {
  MEDICATION_ADHERENCE_ACTIVE_FOLLOWUP_STATUSES,
  formatMedicationFollowupStatus,
  isActiveMedicationAdherenceFollowup,
} from "./medicationAdherenceFollowups.js";

export const MEDICATION_FOLLOWUP_QUEUE_PAGE_SIZE = 25;
export const MEDICATION_FOLLOWUP_QUEUE_MAX_CASES = 100;

export const MEDICATION_FOLLOWUP_QUEUE_CATEGORIES = [
  { value: "all", label: "All Active" },
  { value: "attention", label: "Requires Attention" },
  { value: "overdue", label: "Overdue" },
  { value: "due_today", label: "Due Today" },
  { value: "upcoming", label: "Upcoming" },
  { value: "unscheduled", label: "Unscheduled" },
];

export const MEDICATION_FOLLOWUP_QUEUE_STATUSES = [
  { value: "all", label: "All Statuses" },
  { value: "open", label: "Open" },
  { value: "contacted", label: "Contacted" },
  { value: "monitoring", label: "Monitoring" },
];

export const MEDICATION_FOLLOWUP_QUEUE_SEVERITIES = [
  { value: "all", label: "All Severities" },
  { value: "warning", label: "Warning" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

export const MEDICATION_FOLLOWUP_QUEUE_ESCALATIONS = [
  { value: "all", label: "All Escalations" },
  { value: "due_today", label: "Due Today" },
  { value: "recently_overdue", label: "Recently Overdue" },
  { value: "high", label: "High Escalation" },
  { value: "critical", label: "Critical Escalation" },
  { value: "snoozed", label: "Snoozed" },
];

export const MEDICATION_FOLLOWUP_CONTROL_EVENT_TYPES = [
  "attention_acknowledged",
  "attention_snoozed",
  "followup_scheduled",
  "status_changed",
  "patient_contacted",
  "resolved",
  "doctor_reassigned",
];

export const MEDICATION_FOLLOWUP_CONTROL_EVENT_LIMIT = 500;

export const MEDICATION_FOLLOWUP_QUEUE_SORTS = [
  { value: "priority", label: "Priority" },
  { value: "next_follow_up", label: "Next Follow-up" },
  { value: "newest", label: "Newest Case" },
  { value: "oldest", label: "Oldest Case" },
];

const activeStatusSet = new Set(MEDICATION_ADHERENCE_ACTIVE_FOLLOWUP_STATUSES);
const severityPriority = {
  critical: 0,
  high: 1,
  warning: 2,
  normal: 3,
};
const severityLabels = {
  critical: "Critical",
  high: "High",
  warning: "Warning",
  normal: "Normal",
};
const unconditionalSnoozeInvalidatingEventTypes = new Set([
  "status_changed",
  "resolved",
  "doctor_reassigned",
]);
const scheduledSnoozeInvalidatingEventTypes = new Set([
  "followup_scheduled",
  "patient_contacted",
]);

function getTime(value, fallback = Number.POSITIVE_INFINITY) {
  const time = new Date(value || "").getTime();
  return Number.isFinite(time) ? time : fallback;
}

function getCalendarDayDifference(fromDateKey, toDateKey) {
  const from = Date.parse(`${fromDateKey}T00:00:00Z`);
  const to = Date.parse(`${toDateKey}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

function isArchivedPatient(patient) {
  const status = String(patient?.status || "").trim().toLowerCase();
  return (
    !patient ||
    Boolean(patient.archived_at) ||
    ["archived", "deleted"].includes(status)
  );
}

export function getMedicationFollowupQueueCategory(followup, now = new Date()) {
  if (!isActiveMedicationAdherenceFollowup(followup)) return "inactive";
  if (!followup?.next_follow_up_at) return "unscheduled";

  const dueAt = new Date(followup.next_follow_up_at);
  if (Number.isNaN(dueAt.getTime())) return "unscheduled";
  if (dueAt.getTime() <= now.getTime()) return "overdue";

  const dueDateKey = getManilaDateKey(dueAt);
  const todayKey = getManilaDateKey(now);
  if (dueDateKey === todayKey) return "due_today";
  return dueDateKey > todayKey ? "upcoming" : "overdue";
}

export function getMedicationFollowupEscalation(followup, now = new Date()) {
  const category = getMedicationFollowupQueueCategory(followup, now);
  if (category === "due_today") {
    return {
      key: "due_today",
      label: "Due Today",
      rank: 1,
      overdueMilliseconds: 0,
      relativeText: formatMedicationFollowupQueueRelativeDue(
        followup,
        category,
        now
      ),
      requiresAttention: true,
    };
  }

  if (category !== "overdue") {
    return {
      key: "none",
      label: "No Escalation",
      rank: 0,
      overdueMilliseconds: 0,
      relativeText: formatMedicationFollowupQueueRelativeDue(
        followup,
        category,
        now
      ),
      requiresAttention: false,
    };
  }

  const dueAt = new Date(followup.next_follow_up_at);
  const overdueMilliseconds = Math.max(0, now.getTime() - dueAt.getTime());
  const day = 86_400_000;
  const definition =
    overdueMilliseconds >= 3 * day
      ? { key: "critical", label: "Critical Escalation", rank: 4 }
      : overdueMilliseconds >= day
        ? { key: "high", label: "High Escalation", rank: 3 }
        : { key: "recently_overdue", label: "Recently Overdue", rank: 2 };

  return {
    ...definition,
    overdueMilliseconds,
    relativeText: formatMedicationFollowupQueueRelativeDue(
      followup,
      category,
      now
    ),
    requiresAttention: true,
  };
}

function compareControlEventsNewest(first, second) {
  const timeDifference = getTime(second.created_at, 0) - getTime(first.created_at, 0);
  return timeDifference || String(second.id || "").localeCompare(String(first.id || ""));
}

export function getMedicationFollowupAttentionControl(
  followup,
  events,
  now = new Date()
) {
  const relevantEvents = (events || [])
    .filter((event) => event?.followup_id === followup?.id)
    .sort(compareControlEventsNewest);
  const latestSnoozeIndex = relevantEvents.findIndex(
    (event) => event.event_type === "attention_snoozed"
  );
  const latestSnooze =
    latestSnoozeIndex >= 0 ? relevantEvents[latestSnoozeIndex] : null;
  const snoozeInvalidated =
    latestSnoozeIndex > 0 &&
    relevantEvents.slice(0, latestSnoozeIndex).some(
      (event) =>
        unconditionalSnoozeInvalidatingEventTypes.has(event.event_type) ||
        (scheduledSnoozeInvalidatingEventTypes.has(event.event_type) &&
          Boolean(event.next_follow_up_at))
    );
  const snoozedUntil = latestSnooze?.next_follow_up_at || null;
  const snoozeTime = new Date(snoozedUntil || "").getTime();
  const isSnoozed =
    Boolean(latestSnooze) &&
    !snoozeInvalidated &&
    Number.isFinite(snoozeTime) &&
    snoozeTime > now.getTime();

  const latestScheduleIndex = relevantEvents.findIndex(
    (event) =>
      scheduledSnoozeInvalidatingEventTypes.has(event.event_type) &&
      Boolean(event.next_follow_up_at)
  );
  const acknowledgementIndex = relevantEvents.findIndex(
    (event) => event.event_type === "attention_acknowledged"
  );
  const acknowledgement =
    acknowledgementIndex >= 0 &&
    (latestScheduleIndex < 0 || acknowledgementIndex < latestScheduleIndex)
      ? relevantEvents[acknowledgementIndex]
      : null;

  return {
    acknowledgement,
    latestSnooze,
    snoozedUntil,
    isSnoozed,
  };
}

export function formatMedicationFollowupQueueRelativeDue(
  followup,
  category,
  now = new Date()
) {
  if (category === "unscheduled") return "Not scheduled";

  const dueAt = new Date(followup?.next_follow_up_at || "");
  if (Number.isNaN(dueAt.getTime())) return "Not scheduled";

  if (category === "overdue") {
    const elapsedMinutes = Math.max(
      1,
      Math.floor((now.getTime() - dueAt.getTime()) / 60_000)
    );
    if (elapsedMinutes < 60) {
      return `Overdue by ${elapsedMinutes} minute${elapsedMinutes === 1 ? "" : "s"}`;
    }

    const elapsedHours = Math.floor(elapsedMinutes / 60);
    const remainingMinutes = elapsedMinutes % 60;
    if (elapsedHours < 24) {
      return `Overdue by ${elapsedHours} hour${elapsedHours === 1 ? "" : "s"}${
        remainingMinutes
          ? ` ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}`
          : ""
      }`;
    }

    const elapsedDays = Math.floor(elapsedHours / 24);
    return `Overdue by ${elapsedDays} day${elapsedDays === 1 ? "" : "s"}`;
  }

  const dueTime = formatAppointmentTime(dueAt);
  if (category === "due_today") {
    const remainingMinutes = Math.max(
      1,
      Math.ceil((dueAt.getTime() - now.getTime()) / 60_000)
    );
    if (remainingMinutes < 60) {
      return `Due in ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}`;
    }

    const remainingHours = Math.floor(remainingMinutes / 60);
    const extraMinutes = remainingMinutes % 60;
    return `Due in ${remainingHours} hour${remainingHours === 1 ? "" : "s"}${
      extraMinutes
        ? ` ${extraMinutes} minute${extraMinutes === 1 ? "" : "s"}`
        : ""
    }`;
  }

  const dayDifference = getCalendarDayDifference(
    getManilaDateKey(now),
    getManilaDateKey(dueAt)
  );
  if (dayDifference === 1) return `Due tomorrow at ${dueTime}`;
  return `Due ${formatAppointmentDate(dueAt)} at ${dueTime}`;
}

export function buildMedicationFollowupQueueItems({
  followups,
  patients,
  events = [],
  doctorName,
  now = new Date(),
}) {
  const patientById = new Map(
    (patients || []).map((patient) => [patient.id, patient])
  );
  const casesById = new Map();
  const eventsById = new Map();

  (events || []).forEach((event) => {
    if (event?.id) eventsById.set(event.id, event);
  });
  const controlEvents = Array.from(eventsById.values());

  (followups || []).forEach((followup) => {
    if (
      followup?.id &&
      activeStatusSet.has(String(followup.status || "").trim().toLowerCase())
    ) {
      casesById.set(followup.id, followup);
    }
  });

  return Array.from(casesById.values()).map((followup) => {
    const patientRecord = patientById.get(followup.patient_id) || null;
    const archived = isArchivedPatient(patientRecord);
    const category = getMedicationFollowupQueueCategory(followup, now);
    const escalation = getMedicationFollowupEscalation(followup, now);
    const attentionControl = getMedicationFollowupAttentionControl(
      followup,
      controlEvents,
      now
    );
    const patient = archived
      ? {
          id: followup.patient_id,
          patient_id: "Not available",
          full_name: "Archived Patient",
          isArchived: true,
        }
      : {
          ...patientRecord,
          isArchived: false,
        };

    return {
      id: followup.id,
      followup,
      patient,
      patientName: patient.full_name || "Patient",
      patientDisplayId: patient.patient_id || "Not assigned",
      assignedDoctorName:
        followup.assigned_doctor?.full_name || doctorName || "Assigned Doctor",
      category,
      escalation,
      attentionControl,
      isSnoozed: attentionControl.isSnoozed,
      requiresAttention:
        escalation.requiresAttention && !attentionControl.isSnoozed,
      escalationKey: attentionControl.isSnoozed
        ? "snoozed"
        : escalation.key,
      escalationLabel: attentionControl.isSnoozed
        ? "Snoozed"
        : escalation.label,
      categoryLabel:
        MEDICATION_FOLLOWUP_QUEUE_CATEGORIES.find(
          (item) => item.value === category
        )?.label || "Active",
      relativeDue: formatMedicationFollowupQueueRelativeDue(
        followup,
        category,
        now
      ),
      statusLabel: formatMedicationFollowupStatus(followup.status),
      severityLabel:
        severityLabels[followup.severity_snapshot] || "Warning",
    };
  });
}

export function summarizeMedicationFollowupQueue(items) {
  const summary = {
    all: items.length,
    attention: 0,
    overdue: 0,
    due_today: 0,
    upcoming: 0,
    unscheduled: 0,
    due_today_escalation: 0,
    recently_overdue: 0,
    high_escalation: 0,
    critical_escalation: 0,
    snoozed: 0,
  };

  items.forEach((item) => {
    if (Object.hasOwn(summary, item.category)) summary[item.category] += 1;
    if (item.isSnoozed) {
      summary.snoozed += 1;
    } else if (item.requiresAttention) {
      summary.attention += 1;
      if (item.escalation.key === "due_today") {
        summary.due_today_escalation += 1;
      } else if (item.escalation.key === "recently_overdue") {
        summary.recently_overdue += 1;
      } else if (item.escalation.key === "high") {
        summary.high_escalation += 1;
      } else if (item.escalation.key === "critical") {
        summary.critical_escalation += 1;
      }
    }
  });
  return summary;
}

function comparePriority(left, right) {
  const escalationDifference =
    (right.requiresAttention ? right.escalation.rank : 0) -
    (left.requiresAttention ? left.escalation.rank : 0);
  if (escalationDifference) return escalationDifference;

  const severityDifference =
    (severityPriority[left.followup.severity_snapshot] ?? 9) -
    (severityPriority[right.followup.severity_snapshot] ?? 9);
  if (severityDifference) return severityDifference;

  const scheduleDifference =
    getTime(left.followup.next_follow_up_at) -
    getTime(right.followup.next_follow_up_at);
  if (scheduleDifference) return scheduleDifference;

  return (
    getTime(left.followup.created_at, 0) -
    getTime(right.followup.created_at, 0)
  );
}

export function compareMedicationFollowupAttention(left, right) {
  const escalationDifference = right.escalation.rank - left.escalation.rank;
  if (escalationDifference) return escalationDifference;

  const severityDifference =
    (severityPriority[left.followup.severity_snapshot] ?? 9) -
    (severityPriority[right.followup.severity_snapshot] ?? 9);
  if (severityDifference) return severityDifference;

  const scheduleDifference =
    getTime(left.followup.next_follow_up_at) -
    getTime(right.followup.next_follow_up_at);
  if (scheduleDifference) return scheduleDifference;

  return String(left.id || "").localeCompare(String(right.id || ""));
}

export function getMedicationFollowupAttentionItems(items) {
  return (items || [])
    .filter((item) => item.requiresAttention)
    .sort(compareMedicationFollowupAttention);
}

export function filterAndSortMedicationFollowupQueue(
  items,
  {
    category = "all",
    status = "all",
    severity = "all",
    escalation = "all",
    search = "",
    sort = "priority",
  } = {}
) {
  const normalizedSearch = String(search || "").trim().toLowerCase();
  const filtered = (items || []).filter((item) => {
    const matchesCategory =
      category === "all" ||
      (category === "attention"
        ? item.requiresAttention
        : item.category === category);
    const matchesStatus =
      status === "all" || item.followup.status === status;
    const matchesSeverity =
      severity === "all" || item.followup.severity_snapshot === severity;
    const matchesEscalation =
      escalation === "all" || item.escalationKey === escalation;
    const matchesSearch =
      !normalizedSearch ||
      item.patientName.toLowerCase().includes(normalizedSearch) ||
      item.patientDisplayId.toLowerCase().includes(normalizedSearch);
    return (
      matchesCategory &&
      matchesStatus &&
      matchesSeverity &&
      matchesEscalation &&
      matchesSearch
    );
  });

  return filtered.sort((left, right) => {
    if (sort === "newest") {
      return (
        getTime(right.followup.created_at, 0) -
        getTime(left.followup.created_at, 0)
      );
    }
    if (sort === "oldest") {
      return (
        getTime(left.followup.created_at, 0) -
        getTime(right.followup.created_at, 0)
      );
    }
    if (sort === "next_follow_up") {
      const nextDifference =
        getTime(left.followup.next_follow_up_at) -
        getTime(right.followup.next_follow_up_at);
      return (
        nextDifference ||
        getTime(left.followup.created_at, 0) -
          getTime(right.followup.created_at, 0)
      );
    }
    return comparePriority(left, right);
  });
}

export function getMedicationFollowupQueueEmptyMessage({
  category,
  hasActiveFilters,
}) {
  if (hasActiveFilters) return "No follow-ups match the selected filters.";
  if (category === "attention") {
    return "No medication follow-ups are due or overdue.";
  }
  if (category === "overdue") return "No overdue medication follow-ups.";
  if (category === "due_today") {
    return "No medication follow-ups are due later today.";
  }
  if (category === "upcoming") return "No upcoming medication follow-ups.";
  if (category === "unscheduled") {
    return "No active follow-ups are waiting to be scheduled.";
  }
  return "No active medication follow-ups are assigned to you.";
}
