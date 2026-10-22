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
    label: "Prenatal Check-up",
    icon: "solar:heart-pulse-bold",
    colorClass: "is-prenatal",
    color: "#FF2F7D",
    background: "#FFE4EF",
  },
  {
    id: "initial-prenatal",
    label: "Initial Prenatal Check-up",
    icon: "solar:medical-kit-bold",
    colorClass: "is-initial-prenatal",
    color: "#F97345",
    background: "#FFECDF",
  },
  {
    id: "follow-up",
    label: "Follow-up Consultation",
    icon: "solar:stethoscope-bold",
    colorClass: "is-follow-up",
    color: "#8B5CF6",
    background: "#F0E8FF",
  },
  {
    id: "laboratory",
    label: "Laboratory Test",
    icon: "solar:test-tube-bold",
    colorClass: "is-laboratory",
    color: "#008E99",
    background: "#DDF7F8",
  },
  {
    id: "ultrasound",
    label: "Ultrasound Examination",
    icon: "solar:monitor-camera-bold",
    colorClass: "is-ultrasound",
    color: "#5064F5",
    background: "#E5E9FF",
  },
  {
    id: "vaccination",
    label: "Vaccination / Immunization",
    icon: "solar:syringe-bold",
    colorClass: "is-vaccination",
    color: "#B94AEC",
    background: "#F4E2FF",
  },
];

const CATEGORY_BY_TYPE = {
  [normalizeAppointmentType("Prenatal Check-up")]: "prenatal",
  [normalizeAppointmentType("Follow-up Prenatal Check-up")]: "prenatal",
  [normalizeAppointmentType("Initial Prenatal Check-up")]: "initial-prenatal",
  [normalizeAppointmentType("Follow-up Consultation")]: "follow-up",
  [normalizeAppointmentType("Follow up Consultation")]: "follow-up",
  [normalizeAppointmentType("Laboratory Test")]: "laboratory",
  [normalizeAppointmentType("Ultrasound Examination")]: "ultrasound",
  [normalizeAppointmentType("Vaccination / Immunization")]: "vaccination",
};

const COMPLETED_APPOINTMENT_STATUS_COLORS = {
  color: "#159B53",
  background: "#E1F7E9",
};

export function normalizeAppointmentType(value = "") {
  return String(value).trim().toLowerCase();
}

// Display only: keep stored type values and clinical visit routing unchanged.
export function getAppointmentTypeLabel(value = "") {
  return normalizeAppointmentType(value) === normalizeAppointmentType("Follow-up Prenatal Check-up")
    ? "Prenatal Check-up"
    : value;
}

export function isKnownAppointmentType(value = "") {
  return APPOINTMENT_TYPES.some(
    (type) => normalizeAppointmentType(type) === normalizeAppointmentType(value)
  );
}

export function getAppointmentTypeCategory(value = "") {
  return CATEGORY_BY_TYPE[normalizeAppointmentType(value)] || "fallback";
}

export function getAppointmentCategoryStyle(categoryId = "") {
  const category = APPOINTMENT_CATEGORIES.find((item) => item.id === categoryId);
  if (!category) return undefined;

  return {
    "--appointment-category-color": category.color,
    "--appointment-category-background": category.background,
  };
}

export function isCompletedAppointmentStatus(status = "") {
  return String(status).trim().toLowerCase() === "completed";
}

export function getCompletedAppointmentStatusStyle() {
  return {
    "--appointment-status-color": COMPLETED_APPOINTMENT_STATUS_COLORS.color,
    "--appointment-status-background": COMPLETED_APPOINTMENT_STATUS_COLORS.background,
  };
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
