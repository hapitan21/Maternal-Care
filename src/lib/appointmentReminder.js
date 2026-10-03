import { normalizeAppointmentStatus } from "./appointmentDate.js";

export const APPOINTMENT_REMINDER_MIN_LEAD_MS = 10 * 60 * 1000;
export const APPOINTMENT_REMINDER_LEAD_GUIDANCE =
  "Set the reminder at least 10 minutes before the appointment.";

// datetime-local represents clinic time, independently of the device timezone.
export function clinicReminderLocalToISOString(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || ""));
  if (!match) return "";
  const [, year, month, day, hour, minute, second = "00"] = match;
  const date = new Date(year + "-" + month + "-" + day + "T" + hour + ":" + minute + ":" + second + "+08:00");
  if (!Number.isFinite(date.getTime())) return "";
  // Reject normalized invalid calendar dates, e.g. February 30.
  const local = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  if (local.getUTCFullYear() !== Number(year)
      || local.getUTCMonth() + 1 !== Number(month)
      || local.getUTCDate() !== Number(day)
      || local.getUTCHours() !== Number(hour)
      || local.getUTCMinutes() !== Number(minute)
      || local.getUTCSeconds() !== Number(second)) return "";
  return date.toISOString();
}

export function getAppointmentReminderNotifyAt(appointment, leadTime, customValue = "") {
  if (leadTime === "custom") return clinicReminderLocalToISOString(customValue);
  const scheduleAt = appointment?.scheduleAt || clinicReminderLocalToISOString(
    (appointment?.scheduleDate || "") + "T" + (appointment?.scheduleTime || "")
  );
  const startTime = scheduleAt ? Date.parse(scheduleAt) : Number.NaN;
  if (!Number.isFinite(startTime)) return "";
  const hours = { "1hour": 1, "1day": 24, "3days": 72, "3weeks": 504 }[leadTime] ?? 24;
  return new Date(startTime - hours * 60 * 60 * 1000).toISOString();
}

export function getAppointmentReminderTimingError(remindAt, startAt, nowValue = Date.now()) {
  const due = remindAt ? Date.parse(remindAt) : Number.NaN;
  const start = startAt ? Date.parse(startAt) : Number.NaN;
  const now = Number(nowValue);
  if (![due, start, now].every(Number.isFinite)) return "Choose a valid reminder date and time.";
  if (due <= now) return "Choose a reminder time in the future.";
  if (start - due < APPOINTMENT_REMINDER_MIN_LEAD_MS) return APPOINTMENT_REMINDER_LEAD_GUIDANCE;
  return "";
}

export function getAppointmentReminderStatusLabel(status) {
  switch (String(status || "pending").trim().toLowerCase()) {
    case "pending": return "Pending";
    case "sent": return "Sent";
    case "completed": return "Completed";
    case "cancelled": return "Cancelled";
    case "expired": return "Expired";
    default: return "Unavailable";
  }
}

export function isLocalAppointmentReminderDue(reminder, nowValue = Date.now()) {
  const now = Number(nowValue);
  const due = reminder?.notifyAt ? Date.parse(reminder.notifyAt) : Number.NaN;
  const start = reminder?.scheduleAt ? Date.parse(reminder.scheduleAt) : Number.NaN;
  return ["Pending", "Sent"].includes(reminder?.status)
    && ["scheduled", "rescheduled"].includes(normalizeAppointmentStatus(reminder?.scheduleStatus))
    && Number.isFinite(now) && Number.isFinite(due) && Number.isFinite(start)
    && due <= now && now < start;
}
