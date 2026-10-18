import { isLocalAppointmentReminderDue } from "./appointmentReminder.js";

// Survives route unmounts even when browser storage is unavailable.
const presented = new Set();

export async function sendPatientAppointmentBrowserReminder({
  reminder, patientId, icon, now = Date.now(),
  notification = globalThis.Notification,
  serviceWorker = globalThis.navigator?.serviceWorker,
  storage,
}) {
  if (!patientId || !reminder?.id || !isLocalAppointmentReminderDue(reminder, now)) return "not-due";
  if (!notification || notification.permission !== "granted") return "unavailable";
  const key = "maternal-appointment-browser-v1:" + [patientId, reminder.id,
    new Date(reminder.notifyAt).toISOString()].map(encodeURIComponent).join(":");
  try { storage ??= globalThis.localStorage; } catch { /* In-memory guard still applies. */ }
  if (presented.has(key)) return "already-presented";
  try {
    if (storage?.getItem(key)) { presented.add(key); return "already-presented"; }
  } catch { /* Restricted browser storage. */ }

  // Claim before asynchronous presentation: do not retry an uncertain outcome on navigation.
  presented.add(key);
  try { storage?.setItem(key, "1"); } catch { /* The current app lifetime remains guarded. */ }
  const title = "Appointment Reminder";
  const options = {
    body: reminder.message || "You have an appointment reminder.",
    icon, badge: "/icons/maternal-care-icon-192.png", tag: key,
    data: { url: "/patient/reminders" },
  };
  let registration;
  try { registration = await serviceWorker?.getRegistration(); } catch { /* Use browser API. */ }
  try {
    if (registration?.showNotification) await registration.showNotification(title, options);
    else new notification(title, options);
    return "shown";
  } catch {
    // A failed promise is not proof that no notification was presented.
    return "uncertain";
  }
}
