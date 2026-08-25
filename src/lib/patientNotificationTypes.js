import { getPatientNotificationConfig } from "./patientNotificationRoutes";

const typeDefinitions = [
  {
    value: "appointment_created",
    label: "Appointment Created",
    title: "New Appointment Scheduled",
    message: "A new clinic appointment has been scheduled for you.",
  },
  {
    value: "appointment_reminder",
    label: "Appointment Reminder",
    title: "Upcoming Appointment",
    message: "You have an upcoming clinic appointment.",
  },
  {
    value: "appointment_rescheduled",
    label: "Appointment Rescheduled",
    title: "Appointment Rescheduled",
    message: "Your clinic appointment schedule has been updated.",
  },
  {
    value: "appointment_cancelled",
    label: "Appointment Cancelled",
    title: "Appointment Cancelled",
    message:
      "Your clinic appointment has been cancelled. Please contact the clinic if you need assistance.",
  },
  {
    value: "medication_reminder",
    label: "Medication Reminder",
    title: "Medication Reminder",
    message: "You have a medication reminder from your healthcare provider.",
  },
  {
    value: "doctor_reminder",
    label: "Doctor Reminder",
    title: "Reminder from Your Doctor",
    message: "You have a new reminder from your healthcare provider.",
  },
  {
    value: "health_tip",
    label: "Health Tip",
    title: "New Health Tip",
    message: "A new health tip is available in your Patient account.",
  },
  {
    value: "medical_record_available",
    label: "Medical Record Available",
    title: "Medical Record Available",
    message: "A new medical record is available. Tap to view it securely.",
  },
  {
    value: "laboratory_result_available",
    label: "Laboratory Result Available",
    title: "Laboratory Result Available",
    message: "A new laboratory result is available. Tap to view it securely.",
  },
  {
    value: "prescription_available",
    label: "Prescription Available",
    title: "New Prescription Available",
    message: "A new prescription is available in your medical record.",
  },
  {
    value: "account_notification",
    label: "Account Notification",
    title: "Patient Account Update",
    message: "An account update is available in your Patient profile.",
  },
  {
    value: "general",
    label: "General Notification",
    title: "Message from Maternal Care",
    message: "You have a new message from your Maternal Care team.",
  },
];

export const PATIENT_NOTIFICATION_TYPES = typeDefinitions.map((definition) => {
  const routeConfig = getPatientNotificationConfig(definition.value);

  return {
    ...definition,
    icon: routeConfig.icon,
    targetPath: routeConfig.targetPath,
  };
});

export const PATIENT_NOTIFICATION_PRIORITIES = [
  { value: "normal", label: "Normal" },
  { value: "important", label: "Important" },
  { value: "urgent", label: "Urgent" },
];

export const PATIENT_NOTIFICATION_TARGET_LABELS = {
  "/patient/appointments": "Patient Appointments",
  "/patient/reminders": "Patient Reminders",
  "/patient/reminders/medications": "Medication Schedule & Adherence",
  "/patient/medical-records": "Patient Medical Records",
  "/patient/profile": "Patient Profile",
};

const notificationTypesByValue = new Map(
  PATIENT_NOTIFICATION_TYPES.map((definition) => [definition.value, definition])
);
const allowedTargets = new Set(
  PATIENT_NOTIFICATION_TYPES.map((definition) => definition.targetPath)
);

export function getPatientNotificationType(value) {
  return notificationTypesByValue.get(value) || notificationTypesByValue.get("general");
}

export function isAllowedPatientNotificationType(value) {
  return notificationTypesByValue.has(value);
}

export function isAllowedPatientNotificationTarget(value) {
  return allowedTargets.has(value);
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "").trim()
  );
}
