import {
  classifyAppointment,
  formatAppointmentDate,
  formatAppointmentTime,
  getManilaDateKey,
  getManilaTimeKey,
} from "./appointmentDate";

export const appointmentReminderStorageKey = "patient_schedule_reminder_notifications";
export const medicationReminderStorageKey = "patient_medication_reminder_notifications";
export const healthTipsStorageKey = "doctor_health_tips";

export const defaultHealthTips = [
  {
    id: "hydration",
    category: "Nutrition",
    title: "Drink enough water each day.",
    text: "Staying hydrated helps support circulation, digestion, and healthy pregnancy energy.",
  },
  {
    id: "vitamins",
    category: "Nutrition",
    title: "Take your vitamins on time.",
    text: "Consistent prenatal vitamins help support you and your baby's development.",
  },
  {
    id: "rest",
    category: "Wellness",
    title: "Rest when your body needs it.",
    text: "Short rest breaks can help reduce fatigue and keep your daily routine manageable.",
  },
  {
    id: "movement",
    category: "Exercise",
    title: "Stay active and eat nutritious foods.",
    text: "A balanced diet and gentle exercise can help support your baby's healthy growth.",
  },
];

export function getPatientIdentity(profile = {}) {
  const values = [
    profile.recordId,
    profile.patientId,
    profile.displayName,
    profile.email,
    profile.phone,
  ];

  return values
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

export function patientMatchesValue(profile, value) {
  const target = String(value || "").trim().toLowerCase();
  if (!target) return false;

  return getPatientIdentity(profile).some((identity) => identity.toLowerCase() === target);
}

export function patientMatchesReminder(profile, reminder) {
  return (
    patientMatchesValue(profile, reminder?.patientId) ||
    patientMatchesValue(profile, reminder?.patientName) ||
    patientMatchesValue(profile, reminder?.patientEmail)
  );
}

export function readStoredList(storageKey) {
  try {
    const stored = JSON.parse(window.localStorage.getItem(storageKey));
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

export function writeStoredList(storageKey, items) {
  window.localStorage.setItem(storageKey, JSON.stringify(items));
}

export function getLocalDateKey(offset = 0) {
  return getManilaDateKey(new Date(Date.now() + offset * 24 * 60 * 60 * 1000));
}

export function toDateKey(value) {
  return getManilaDateKey(value);
}

export function toTimeKey(value) {
  return getManilaTimeKey(value);
}

export function reminderMatchesTab(reminder, activeTab) {
  const todayDateKey = getLocalDateKey();
  const tomorrowDateKey = getLocalDateKey(1);

  if (activeTab === "Today") return reminder.scheduleDate === todayDateKey;
  if (activeTab === "Tomorrow") return reminder.scheduleDate === tomorrowDateKey;
  if (activeTab === "Upcoming") return reminder.scheduleDate >= todayDateKey;

  return true;
}

export function normalizeHealthTip(tip) {
  if (!tip || typeof tip !== "object") return null;

  const text = String(tip.text || tip.description || "").trim();
  const title = String(tip.title || "").trim();

  if (!text && !title) return null;

  return {
    id: tip.id || `health-tip-${Date.now()}`,
    category: tip.category || "Wellness",
    title: title || tip.category || "Health Tip",
    text: text || title,
    image: tip.image || "",
    icon: tip.icon || "bulb",
    displaySchedule: tip.displaySchedule || "Daily",
  };
}

export function getStoredHealthTips(options = {}) {
  const { includeDefaults = true } = options;
  const storedTips = readStoredList(healthTipsStorageKey)
    .map(normalizeHealthTip)
    .filter(Boolean);

  const defaultTips = includeDefaults
    ? defaultHealthTips.map(normalizeHealthTip)
    : [];

  const mergedTips = [...storedTips, ...defaultTips].filter(Boolean);

  return mergedTips.filter(
    (tip, index, source) => source.findIndex((item) => item.id === tip.id) === index
  );
}

export function mapScheduleRowToReminder(row) {
  const classification = classifyAppointment(row);
  return {
    id: `appointment-${row.id}`,
    type: "scheduleReminder",
    appointmentId: row.id,
    patientId: row.patient_id || row.patient_name || "",
    patientName: row.patient_name || "Patient",
    appointmentType: row.title || "Appointment",
    doctorName: row.doctor_name || "Doctor not recorded",
    scheduleDate: toDateKey(row.start_time),
    scheduleTime: toTimeKey(row.start_time),
    scheduleAt: row.start_time,
    scheduleEndAt: row.end_time,
    scheduleStatus: row.status,
    notifyAt: row.start_time,
    status: classification.displayStatus,
    message: `Upcoming appointment: ${row.title || "Appointment"} on ${formatAppointmentDate(row.start_time)} at ${formatAppointmentTime(row.start_time)}.`,
  };
}
