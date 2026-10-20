import { formatAppointmentDate, getManilaDateKey } from "./appointmentDate.js";

export function isValidCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const [year, month, day] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return year > 0 && month >= 1 && month <= 12 && day >= 1 &&
    day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function getAppointmentDateRangeError({ from = "", to = "" } = {}) {
  if ((from && !isValidCalendarDate(from)) || (to && !isValidCalendarDate(to))) {
    return "Enter a valid From and To date, or leave either blank.";
  }
  return from && to && to < from ? "To date must be on or after From date." : "";
}

export function matchesAppointmentDateRange(value, range = {}) {
  const { from = "", to = "" } = range;
  if (getAppointmentDateRangeError(range)) return false;
  if (!from && !to) return true;
  // Never let getManilaDateKey's default argument turn an undated row into today.
  if (!value) return false;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? (isValidCalendarDate(value) ? value : "") : getManilaDateKey(value);
  return Boolean(date && (!from || date >= from) && (!to || date <= to));
}

export function formatAppointmentDateRange({ from = "", to = "" } = {}) {
  const label = (date) => formatAppointmentDate(`${date}T12:00:00+08:00`);
  if (from && to) return `${label(from)} - ${label(to)}`;
  if (from) return `From ${label(from)}`;
  if (to) return `Until ${label(to)}`;
  return "All dates";
}
