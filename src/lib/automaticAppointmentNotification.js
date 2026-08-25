import { supabase } from "./supabaseClient";
import {
  getPatientNotificationType,
  isUuid,
} from "./patientNotificationTypes";

const automaticAppointmentTypes = new Set([
  "appointment_created",
  "appointment_rescheduled",
  "appointment_cancelled",
]);

function logAutomaticNotificationError(notificationType, error) {
  if (!import.meta.env.DEV) return;

  console.warn("[Appointment Notification] automatic notification failed:", {
    notificationType,
    code: error?.code || null,
    message: error?.message || "Unknown notification error",
  });
}

export async function sendAutomaticAppointmentNotification({
  patientId,
  scheduleId,
  notificationType,
}) {
  if (!automaticAppointmentTypes.has(notificationType)) {
    const error = new Error("Unsupported automatic appointment notification type.");
    logAutomaticNotificationError(notificationType, error);
    return { ok: false, error };
  }

  if (!isUuid(patientId) || !isUuid(scheduleId)) {
    const error = new Error(
      "The saved appointment did not return valid Patient and schedule identifiers."
    );
    logAutomaticNotificationError(notificationType, error);
    return { ok: false, error };
  }

  const notification = getPatientNotificationType(notificationType);

  try {
    const { data, error } = await supabase.rpc("create_patient_notification", {
      p_patient_id: patientId,
      p_type: notificationType,
      p_title: notification.title,
      p_message: notification.message,
      p_target_path: "/patient/appointments",
      p_priority: "important",
      p_related_appointment_id: scheduleId,
      p_related_medical_record_id: null,
      p_related_reminder_id: null,
    });

    if (error) {
      logAutomaticNotificationError(notificationType, error);
      return { ok: false, error };
    }

    return { ok: true, notification: data };
  } catch (error) {
    logAutomaticNotificationError(notificationType, error);
    return { ok: false, error };
  }
}
