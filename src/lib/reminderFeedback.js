import { formatAppointmentDate, formatAppointmentTime } from "./appointmentDate.js";

export function buildReminderSuccessToast(result) {
  const saved = result.savedReminder;
  const repeat = { none: "No repeat", daily: "Daily", hourly: "Every Hour" }[saved.repeat_mode] || "No repeat";
  return {
    title: result.updated ? "Reminder updated" : "Reminder scheduled",
    message: `${result.appointment.patientName || "The Patient"} will receive a reminder on ${formatAppointmentDate(saved.remind_at)} at ${formatAppointmentTime(saved.remind_at)}.`,
    details: [
      `Appointment: ${formatAppointmentDate(result.appointmentAt)} at ${formatAppointmentTime(result.appointmentAt)}`,
      `Repeat: ${repeat}`,
    ],
  };
}
