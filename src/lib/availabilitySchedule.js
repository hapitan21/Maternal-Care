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
