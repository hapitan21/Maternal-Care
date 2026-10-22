export const availabilityDayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function getAvailabilityDayIndex(dayName) {
  return availabilityDayNames.indexOf(String(dayName || "").trim());
}

export function getAvailabilityDayOfWeek(dateValue) {
  if (typeof dateValue !== "string" || dateValue.length !== 10) return -1;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  if (!match) return -1;
  const [, year, month, day] = match.map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return -1;

  // This is a clinic calendar day, not an instant. UTC arithmetic avoids the
  // browser timezone; setUTCFullYear also preserves years 0001 through 0099.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day) return -1;
  return date.getUTCDay();
}

function getTimeMinutes(value) {
  const match = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(String(value || ""));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function getAvailabilityWindowForDate(rows, dateValue) {
  const dayOfWeek = getAvailabilityDayOfWeek(dateValue);
  const row = dayOfWeek < 0 || !Array.isArray(rows)
    ? null
    : rows.find((item) => item.day_of_week != null && Number(item.day_of_week) === dayOfWeek);
  if (!row?.is_available) return null;

  const startMinute = getTimeMinutes(row.start_time);
  const endMinute = getTimeMinutes(row.end_time);
  if (startMinute === null || endMinute === null || endMinute <= startMinute) return null;
  return { startMinute, endMinute };
}
