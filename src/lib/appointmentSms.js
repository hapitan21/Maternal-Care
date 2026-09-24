import { supabase } from "./supabaseClient";
import { isUuid } from "./patientNotificationTypes";

export const appointmentSmsEvents = {
  confirmed: "appointment_confirmed",
  rescheduled: "appointment_rescheduled",
  cancelled: "appointment_cancelled",
};

const supportedAppointmentSmsEvents = new Set(
  Object.values(appointmentSmsEvents)
);

export async function requestAppointmentSms({
  scheduleId,
  event,
  appointmentEventId = null,
}) {
  const requiresAppointmentEvent = event === appointmentSmsEvents.rescheduled;
  if (
    !isUuid(scheduleId) ||
    !supportedAppointmentSmsEvents.has(event) ||
    (requiresAppointmentEvent && !isUuid(appointmentEventId))
  ) {
    return {
      ok: false,
      skipped: true,
      error: new Error("Invalid appointment SMS orchestration request."),
    };
  }

  try {
    const { data, error } = await supabase.functions.invoke(
      "process-appointment-sms",
      {
        body: {
          schedule_id: scheduleId,
          event,
          ...(requiresAppointmentEvent
            ? { appointment_event_id: appointmentEventId }
            : {}),
        },
      }
    );

    if (error) {
      if (import.meta.env.DEV) {
        console.warn("[Appointment SMS] orchestration failed:", {
          event,
          scheduleId,
          message: error.message || "Unknown appointment SMS error",
        });
      }
      return { ok: false, skipped: false, error };
    }

    return { ok: Boolean(data?.ok), skipped: Boolean(data?.skipped), data };
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn("[Appointment SMS] orchestration failed:", {
        event,
        scheduleId,
        message: error?.message || "Unknown appointment SMS error",
      });
    }
    return { ok: false, skipped: false, error };
  }
}
