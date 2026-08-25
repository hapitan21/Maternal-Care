export const APPOINTMENT_DURATION_MINUTES = 30;

export const APPOINTMENT_TYPES = [
  "Follow-up Prenatal Check-up",
  "Laboratory Test",
  "Ultrasound Examination",
  "Vaccination / Immunization",
];

export const APPOINTMENT_CATEGORIES = [
  {
    id: "prenatal",
    label: "Follow-up Prenatal Check-up",
    icon: "solar:heart-pulse-bold",
    colorClass: "is-prenatal",
  },
  {
    id: "laboratory",
    label: "Laboratory Test",
    icon: "solar:test-tube-bold",
    colorClass: "is-laboratory",
  },
  {
    id: "ultrasound",
    label: "Ultrasound Examination",
    icon: "solar:monitor-camera-bold",
    colorClass: "is-ultrasound",
  },
  {
    id: "vaccination",
    label: "Vaccination / Immunization",
    icon: "solar:syringe-bold",
    colorClass: "is-vaccination",
  },
];

const CATEGORY_BY_TYPE = {
  [normalizeAppointmentType("Follow-up Prenatal Check-up")]: "prenatal",
  [normalizeAppointmentType("Laboratory Test")]: "laboratory",
  [normalizeAppointmentType("Ultrasound Examination")]: "ultrasound",
  [normalizeAppointmentType("Vaccination / Immunization")]: "vaccination",
};

export function normalizeAppointmentType(value = "") {
  return String(value).trim().toLowerCase();
}

export function isKnownAppointmentType(value = "") {
  return APPOINTMENT_TYPES.some(
    (type) => normalizeAppointmentType(type) === normalizeAppointmentType(value)
  );
}

export function getAppointmentTypeCategory(value = "") {
  return CATEGORY_BY_TYPE[normalizeAppointmentType(value)] || "fallback";
}

export function getAppointmentTypeForCategory(categoryId = "") {
  const category = APPOINTMENT_CATEGORIES.find((item) => item.id === categoryId);
  return category ? category.label : "";
}

export function buildLocalAppointmentStartDate(selectedDate, selectedTime) {
  const [year, month, day] = String(selectedDate || "").split("-").map(Number);
  const [hour, minute] = String(selectedTime || "").split(":").map(Number);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  const startDate = new Date(
    year,
    month - 1,
    day,
    hour,
    minute,
    0,
    0
  );

  if (
    Number.isNaN(startDate.getTime()) ||
    startDate.getFullYear() !== year ||
    startDate.getMonth() !== month - 1 ||
    startDate.getDate() !== day ||
    startDate.getHours() !== hour ||
    startDate.getMinutes() !== minute
  ) {
    return null;
  }

  return startDate;
}

export function buildThirtyMinuteAppointmentRange(selectedDate, selectedTime) {
  const startDate = buildLocalAppointmentStartDate(selectedDate, selectedTime);

  if (!startDate) {
    return null;
  }

  const endDate = new Date(
    startDate.getTime() + APPOINTMENT_DURATION_MINUTES * 60 * 1000
  );

  return { startDate, endDate };
}
