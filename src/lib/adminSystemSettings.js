import { supabase } from "./supabaseClient";

export const persistentSettingsSections = new Set([
  "general",
  "appointments",
  "notifications",
]);

const sectionKeys = {
  general: [
    "systemName",
    "clinicName",
    "clinicEmail",
    "contactNumber",
    "clinicAddress",
    "timezone",
  ],
  appointments: [
    "clinicOpeningTime",
    "clinicClosingTime",
    "appointmentDuration",
    "bookingInterval",
    "cancellationWindow",
    "maximumDailyAppointments",
  ],
  notifications: [
    "appointmentReminders",
    "medicationReminderAlerts",
    "browserPushNotifications",
    "appointmentReminderTiming",
    "secondReminder",
  ],
};

function firstRow(data) {
  return (Array.isArray(data) ? data[0] : data) || null;
}

function normalizeTime(value, fallback) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : fallback;
}

function formatReminder(hours) {
  const numericHours = Number(hours);
  if (!Number.isFinite(numericHours)) return "24 hours before";
  return `${numericHours} ${numericHours === 1 ? "hour" : "hours"} before`;
}

function parseReminder(value) {
  if (value === "Disabled") return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanValue(value, fallback) {
  return typeof value === "boolean" ? value : Boolean(fallback);
}

function logRpcError(context, error) {
  if (!import.meta.env.DEV || !error) return;

  console.error(`Admin System Settings ${context} failed:`, {
    code: error.code || "unknown",
    message: error.message || "",
    details: error.details || "",
    hint: error.hint || "",
  });
}

export function normalizeAdminSystemSettings(data, fallback) {
  const row = firstRow(data);
  if (!row) return null;

  return {
    ...fallback,
    systemName: String(row.system_name ?? fallback.systemName),
    clinicName: String(row.clinic_name ?? fallback.clinicName),
    clinicEmail: String(row.clinic_email ?? fallback.clinicEmail),
    contactNumber: String(row.contact_number ?? fallback.contactNumber),
    clinicAddress: String(row.clinic_address ?? fallback.clinicAddress),
    timezone: String(row.timezone ?? fallback.timezone),
    clinicOpeningTime: normalizeTime(
      row.clinic_opening_time,
      fallback.clinicOpeningTime
    ),
    clinicClosingTime: normalizeTime(
      row.clinic_closing_time,
      fallback.clinicClosingTime
    ),
    appointmentDuration: String(
      row.default_appointment_duration_minutes ?? fallback.appointmentDuration
    ),
    bookingInterval: String(
      row.booking_interval_minutes ?? fallback.bookingInterval
    ),
    cancellationWindow: String(
      row.cancellation_window_hours ?? fallback.cancellationWindow
    ),
    maximumDailyAppointments: String(
      row.maximum_daily_appointments ?? fallback.maximumDailyAppointments
    ),
    appointmentReminders: booleanValue(
      row.appointment_reminders_enabled,
      fallback.appointmentReminders
    ),
    medicationReminderAlerts: booleanValue(
      row.medication_reminder_alerts_enabled,
      fallback.medicationReminderAlerts
    ),

    // Hidden compatibility values required by the current Supabase RPC.
    // They are loaded from the database and sent back unchanged, but are
    // intentionally not part of sectionKeys or rendered in the Admin UI.
    medicationAdherenceAlerts: booleanValue(
      row.medication_adherence_alerts_enabled,
      fallback.medicationAdherenceAlerts
    ),
    doctorFollowupAlerts: booleanValue(
      row.doctor_followup_alerts_enabled,
      fallback.doctorFollowupAlerts
    ),

    browserPushNotifications: booleanValue(
      row.browser_push_notifications_enabled,
      fallback.browserPushNotifications
    ),
    appointmentReminderTiming: formatReminder(
      row.appointment_reminder_hours_before
    ),
    secondReminder:
      row.second_reminder_hours_before == null
        ? "Disabled"
        : formatReminder(row.second_reminder_hours_before),
    dateFormat: String(row.date_format ?? fallback.dateFormat),
    timeFormat: String(row.time_format ?? fallback.timeFormat),
    recordsPerPage: String(row.records_per_page ?? fallback.recordsPerPage),
    dashboardRefreshInterval: String(
      row.dashboard_refresh_seconds ?? fallback.dashboardRefreshInterval
    ),
  };
}

export function hasSettingsSectionChanges(values, baseline, section) {
  return (sectionKeys[section] || []).some(
    (key) => values[key] !== baseline[key]
  );
}

export function mergeSettingsSection(current, saved, section) {
  return (sectionKeys[section] || []).reduce(
    (next, key) => ({ ...next, [key]: saved[key] }),
    current
  );
}

function validateInteger(value, minimum, maximum, label) {
  const numericValue = Number(value);
  if (
    !Number.isInteger(numericValue) ||
    numericValue < minimum ||
    numericValue > maximum
  ) {
    return `${label} must be between ${minimum} and ${maximum}.`;
  }

  return "";
}

export function validateSettingsSection(section, values) {
  if (section === "general") {
    const systemName = values.systemName.trim();
    const clinicName = values.clinicName.trim();
    const email = values.clinicEmail.trim();

    if (!systemName) return "System Name is required.";
    if (systemName.length > 160)
      return "System Name cannot exceed 160 characters.";
    if (!clinicName) return "Clinic Name is required.";
    if (clinicName.length > 160)
      return "Clinic Name cannot exceed 160 characters.";
    if (email && !/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email))
      return "Enter a valid Clinic Email.";
    if (email.length > 254)
      return "Clinic Email cannot exceed 254 characters.";
    if (values.contactNumber.trim().length > 50)
      return "Contact Number cannot exceed 50 characters.";
    if (values.clinicAddress.trim().length > 500)
      return "Clinic Address cannot exceed 500 characters.";
    if (!values.timezone.trim()) return "Timezone is required.";
    if (values.timezone.trim().length > 80)
      return "Timezone cannot exceed 80 characters.";

    return "";
  }

  if (section === "appointments") {
    if (!values.clinicOpeningTime || !values.clinicClosingTime)
      return "Clinic opening and closing times are required.";
    if (values.clinicClosingTime <= values.clinicOpeningTime)
      return "Clinic Closing Time must be later than Clinic Opening Time.";

    return (
      validateInteger(
        values.appointmentDuration,
        15,
        240,
        "Default Appointment Duration"
      ) ||
      validateInteger(values.bookingInterval, 5, 240, "Booking Interval") ||
      validateInteger(
        values.cancellationWindow,
        0,
        168,
        "Cancellation Window"
      ) ||
      validateInteger(
        values.maximumDailyAppointments,
        1,
        500,
        "Maximum Daily Appointments"
      )
    );
  }

  if (section === "notifications") {
    const primaryReminder = parseReminder(values.appointmentReminderTiming);
    const secondReminder = parseReminder(values.secondReminder);

    if (!primaryReminder || primaryReminder < 1 || primaryReminder > 168)
      return "Select a valid Appointment Reminder Timing.";

    if (
      secondReminder !== null &&
      (secondReminder < 1 ||
        secondReminder > 168 ||
        secondReminder >= primaryReminder)
    ) {
      return "Second Reminder must occur after the primary reminder and before the appointment.";
    }

    return "";
  }

  return "";
}

function buildUpdateParameters(section, values) {
  return {
    p_section: section,
    p_system_name: values.systemName.trim(),
    p_clinic_name: values.clinicName.trim(),
    p_clinic_email: values.clinicEmail.trim(),
    p_contact_number: values.contactNumber.trim(),
    p_clinic_address: values.clinicAddress.trim(),
    p_timezone: values.timezone.trim(),
    p_clinic_opening_time: values.clinicOpeningTime,
    p_clinic_closing_time: values.clinicClosingTime,
    p_default_appointment_duration_minutes: Number(values.appointmentDuration),
    p_booking_interval_minutes: Number(values.bookingInterval),
    p_cancellation_window_hours: Number(values.cancellationWindow),
    p_maximum_daily_appointments: Number(values.maximumDailyAppointments),
    p_appointment_reminders_enabled: values.appointmentReminders,
    p_medication_reminder_alerts_enabled: values.medicationReminderAlerts,

    // Required by the currently deployed Supabase RPC. These values remain
    // hidden from the UI and are simply round-tripped unchanged.
    p_medication_adherence_alerts_enabled: values.medicationAdherenceAlerts,
    p_doctor_followup_alerts_enabled: values.doctorFollowupAlerts,

    p_browser_push_notifications_enabled: values.browserPushNotifications,
    p_appointment_reminder_hours_before: parseReminder(
      values.appointmentReminderTiming
    ),
    p_second_reminder_hours_before: parseReminder(values.secondReminder),
    p_date_format: values.dateFormat,
    p_time_format: values.timeFormat,
    p_records_per_page: Number(values.recordsPerPage),
    p_dashboard_refresh_seconds: Number(values.dashboardRefreshInterval),
  };
}

export async function loadAdminSystemSettings(fallback) {
  const { data, error } = await supabase.rpc("get_admin_system_settings");

  if (error) {
    logRpcError("load", error);
    return { settings: null, error: "Unable to load system settings." };
  }

  const settings = normalizeAdminSystemSettings(data, fallback);
  return settings
    ? { settings, error: "" }
    : { settings: null, error: "Unable to load system settings." };
}

export async function updateAdminSystemSettings(section, values) {
  const { data, error } = await supabase.rpc(
    "update_admin_system_settings",
    buildUpdateParameters(section, values)
  );

  if (error) {
    logRpcError("update", error);
    return {
      settings: null,
      error: "Unable to save settings. Please try again.",
    };
  }

  const settings = normalizeAdminSystemSettings(data, values);
  return settings
    ? { settings, error: "" }
    : { settings: null, error: "Unable to save settings. Please try again." };
}
