const notificationTypeConfig = {
  appointment_created: {
    icon: "solar:calendar-add-bold",
    targetPath: "/patient/appointments",
  },
  appointment_reminder: {
    icon: "solar:alarm-bold",
    targetPath: "/patient/appointments",
  },
  appointment_rescheduled: {
    icon: "solar:calendar-mark-bold",
    targetPath: "/patient/appointments",
  },
  appointment_cancelled: {
    icon: "solar:calendar-cross-bold",
    targetPath: "/patient/appointments",
  },
  medication_reminder: {
    icon: "solar:pill-bold",
    targetPath: "/patient/reminders/medications",
  },
  doctor_reminder: {
    icon: "solar:bell-bing-bold",
    targetPath: "/patient/reminders",
  },
  health_tip: {
    icon: "solar:lightbulb-bolt-bold",
    targetPath: "/patient/reminders",
  },
  medical_record_available: {
    icon: "solar:document-medicine-bold",
    targetPath: "/patient/medical-records",
  },
  laboratory_result_available: {
    icon: "solar:test-tube-bold",
    targetPath: "/patient/medical-records",
  },
  prescription_available: {
    icon: "solar:clipboard-list-bold",
    targetPath: "/patient/medical-records",
  },
  account_notification: {
    icon: "solar:shield-user-bold",
    targetPath: "/patient/profile",
  },
  general: {
    icon: "solar:bell-bold",
    targetPath: "/patient/reminders",
  },
};

const allowedPatientTargets = new Set([
  "/patient/dashboard",
  "/patient/appointments",
  "/patient/reminders",
  "/patient/reminders/medications",
  "/patient/medical-records",
  "/patient/profile",
  "/patient/settings",
]);

export function getPatientNotificationConfig(type) {
  return notificationTypeConfig[type] || notificationTypeConfig.general;
}

export function getSafePatientNotificationTarget(notification) {
  const configuredTarget = getPatientNotificationConfig(notification?.type).targetPath;
  const requestedTarget = notification?.target_path;

  if (notification?.type === "medication_reminder") {
    return configuredTarget;
  }

  if (requestedTarget && allowedPatientTargets.has(requestedTarget)) {
    return requestedTarget;
  }

  return configuredTarget || "/patient/reminders";
}
