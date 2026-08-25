export const APPOINTMENT_TIME_ZONE = "Asia/Manila";

export const appointmentStatuses = {
  scheduled: "scheduled",
  checkedIn: "checked_in",
  completed: "completed",
  cancelled: "cancelled",
  missed: "missed",
};

const COMPLETED_STATUSES = new Set([appointmentStatuses.completed]);
const CANCELLED_STATUSES = new Set([appointmentStatuses.cancelled]);
const MISSED_STATUSES = new Set([appointmentStatuses.missed]);
const CHECKED_IN_STATUSES = new Set([appointmentStatuses.checkedIn]);

export const appointmentOverviewStatuses = {
  completed: "completed",
  upcoming: "upcoming",
  canceled: "canceled",
  missed: "missed",
  excluded: "excluded",
};

export function normalizeAppointmentStatus(status) {
  const normalized = String(status || appointmentStatuses.scheduled)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (["scheduled", "pending", "accepted"].includes(normalized)) {
    return appointmentStatuses.scheduled;
  }
  if (["checked_in", "check_in", "checkedin"].includes(normalized)) {
    return appointmentStatuses.checkedIn;
  }
  if (["completed", "complete", "done"].includes(normalized)) {
    return appointmentStatuses.completed;
  }
  if (["cancelled", "canceled", "cancel"].includes(normalized)) {
    return appointmentStatuses.cancelled;
  }
  if (["missed", "no_show", "noshow", "absent"].includes(normalized)) {
    return appointmentStatuses.missed;
  }

  return normalized || appointmentStatuses.scheduled;
}

export function getAppointmentStatusLabel(status) {
  switch (normalizeAppointmentStatus(status)) {
    case appointmentStatuses.checkedIn:
      return "Checked-in";
    case appointmentStatuses.completed:
      return "Completed";
    case appointmentStatuses.cancelled:
      return "Cancelled";
    case appointmentStatuses.missed:
      return "Missed";
    case appointmentStatuses.scheduled:
      return "Pending";
    default:
      return "Unknown";
  }
}

export function getAppointmentStatusClass(status) {
  switch (normalizeAppointmentStatus(status)) {
    case appointmentStatuses.checkedIn:
      return "checked-in";
    case appointmentStatuses.completed:
      return "completed";
    case appointmentStatuses.cancelled:
      return "cancelled";
    case appointmentStatuses.missed:
      return "missed";
    default:
      return "pending";
  }
}

export function isPendingAppointmentStatus(status) {
  return normalizeAppointmentStatus(status) === appointmentStatuses.scheduled;
}

export function isCheckedInAppointmentStatus(status) {
  return normalizeAppointmentStatus(status) === appointmentStatuses.checkedIn;
}

export function isClosedAppointmentStatus(status) {
  return [
    appointmentStatuses.completed,
    appointmentStatuses.cancelled,
    appointmentStatuses.missed,
  ].includes(normalizeAppointmentStatus(status));
}

export function normalizeAppointmentOverviewStatus(status) {
  const normalized = normalizeAppointmentStatus(status);

  if (["archived", "deleted"].includes(normalized)) {
    return appointmentOverviewStatuses.excluded;
  }
  if (normalized === appointmentStatuses.completed) {
    return appointmentOverviewStatuses.completed;
  }
  if (normalized === appointmentStatuses.cancelled) {
    return appointmentOverviewStatuses.canceled;
  }
  if (normalized === appointmentStatuses.missed) {
    return appointmentOverviewStatuses.missed;
  }
  return appointmentOverviewStatuses.upcoming;
}

export function parseAppointmentTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getAppointmentTimestamp(appointment, keys) {
  for (const key of keys) {
    const value = parseAppointmentTimestamp(appointment?.[key]);
    if (value) return value;
  }
  return null;
}

export function getAppointmentStart(appointment) {
  return getAppointmentTimestamp(appointment, ["start_time", "startTime", "start"]);
}

export function getAppointmentEnd(appointment) {
  return (
    getAppointmentTimestamp(appointment, ["end_time", "endTime", "end"]) ||
    getAppointmentStart(appointment)
  );
}

export function getManilaDateKey(value = new Date()) {
  const date = parseAppointmentTimestamp(value);
  if (!date) return "";

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APPOINTMENT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function getManilaTimeKey(value = new Date()) {
  const date = parseAppointmentTimestamp(value);
  if (!date) return "";

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: APPOINTMENT_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}`;
}

export function toManilaISOString(dateValue, timeValue = "00:00") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateValue || ""))) return "";
  if (!/^\d{2}:\d{2}$/.test(String(timeValue || ""))) return "";

  const date = new Date(`${dateValue}T${timeValue}:00+08:00`);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function getManilaDayRange(value = new Date()) {
  const dateKey = getManilaDateKey(value);
  if (!dateKey) return null;

  const start = new Date(`${dateKey}T00:00:00+08:00`);
  return {
    start,
    end: new Date(start.getTime() + 24 * 60 * 60 * 1000),
  };
}

export function getStoredAppointmentStatusLabel(status) {
  const normalized = normalizeAppointmentStatus(status);
  if (COMPLETED_STATUSES.has(normalized)) return "Completed";
  if (CANCELLED_STATUSES.has(normalized)) return "Cancelled";
  if (MISSED_STATUSES.has(normalized)) return "No show";
  if (CHECKED_IN_STATUSES.has(normalized)) return "Checked in";
  return "Pending";
}

export function classifyAppointment(appointment, nowValue = new Date()) {
  const now = parseAppointmentTimestamp(nowValue) || new Date();
  const start = getAppointmentStart(appointment);
  const end = getAppointmentEnd(appointment);
  const normalizedStatus = normalizeAppointmentStatus(appointment?.status);
  const storedStatus = getStoredAppointmentStatusLabel(normalizedStatus);
  const isCompleted = COMPLETED_STATUSES.has(normalizedStatus);
  const isCancelled = CANCELLED_STATUSES.has(normalizedStatus);
  const isMissed = MISSED_STATUSES.has(normalizedStatus);
  const isCheckedIn = CHECKED_IN_STATUSES.has(normalizedStatus);
  const isTerminal = isCompleted || isCancelled || isMissed;

  let category = "invalid";
  if (isCompleted) category = "completed";
  else if (isCancelled) category = "cancelled";
  else if (isMissed) category = "missed";
  else if (start && end && end.getTime() < now.getTime()) category = "overdue";
  else if (start && start.getTime() > now.getTime()) category = "upcoming";
  else if (start && end && end.getTime() >= now.getTime()) category = "current";
  else if (start) category = "overdue";

  const isUpcoming = category === "upcoming" || category === "current";
  const isHistory = !isUpcoming;

  return {
    category,
    start,
    end,
    isToday: Boolean(start && getManilaDateKey(start) === getManilaDateKey(now)),
    isUpcoming,
    isHistory,
    isActionable: isUpcoming && !isTerminal,
    isTerminal,
    isCheckedIn,
    storedStatus,
    displayStatus: category === "overdue" ? "Overdue" : storedStatus,
  };
}

export function compareUpcomingAppointments(first, second) {
  const firstStart = getAppointmentStart(first)?.getTime() ?? Number.POSITIVE_INFINITY;
  const secondStart = getAppointmentStart(second)?.getTime() ?? Number.POSITIVE_INFINITY;
  return firstStart - secondStart;
}

export function compareHistoryAppointments(first, second) {
  const firstStart = getAppointmentStart(first)?.getTime() ?? Number.NEGATIVE_INFINITY;
  const secondStart = getAppointmentStart(second)?.getTime() ?? Number.NEGATIVE_INFINITY;
  return secondStart - firstStart;
}

export function formatAppointmentDate(value, options = {}) {
  const date = parseAppointmentTimestamp(value);
  if (!date) return "-";
  return date.toLocaleDateString("en-US", {
    timeZone: APPOINTMENT_TIME_ZONE,
    month: "long",
    day: "numeric",
    year: "numeric",
    ...options,
  });
}

export function formatAppointmentTime(value, options = {}) {
  const date = parseAppointmentTimestamp(value);
  if (!date) return "-";
  return date.toLocaleTimeString("en-US", {
    timeZone: APPOINTMENT_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    ...options,
  });
}
