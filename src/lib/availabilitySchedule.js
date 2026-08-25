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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateValue || ""))) return -1;
  const date = new Date(`${dateValue}T00:00:00+08:00`);
  return Number.isNaN(date.getTime()) ? -1 : date.getDay();
}
