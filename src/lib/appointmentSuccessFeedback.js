import { formatAppointmentDate, formatAppointmentTime } from "./appointmentDate.js";

// Prefer the saved row; the successful operation's input supplies any omitted fields.
export function buildAppointmentSuccessFeedback(action, appointment, fallback = {}) {
  const patientName = String(
    appointment?.patient_name || appointment?.name || fallback.patient_name || fallback.name || "Patient"
  ).trim() || "Patient";
  const startTime = appointment?.start_time || appointment?.startTime || fallback.start_time || fallback.startTime;
  const date = formatAppointmentDate(startTime, { day: "2-digit" });
  const time = formatAppointmentTime(startTime);
  const when = date !== "-" && time !== "-" ? `${date} at ${time}` : "the scheduled time";

  switch (action) {
    case "created":
      return { title: "Appointment created", message: `${patientName} has been scheduled for ${when}.` };
    case "rescheduled":
      return { title: "Appointment rescheduled", message: `${patientName}'s appointment has been moved to ${when}.` };
    case "cancelled":
      return { title: "Appointment cancelled", message: `${patientName}'s appointment on ${when} has been cancelled.` };
    case "no-show":
      return { title: "Appointment marked as No Show", message: `${patientName}'s appointment has been marked as No Show.` };
    default:
      throw new Error(`Unsupported appointment success action: ${action}`);
  }
}
