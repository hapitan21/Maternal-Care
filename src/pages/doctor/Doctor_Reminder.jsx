import React from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";

import AppointmentTimePicker from "../../components/appointments/AppointmentTimePicker";
import { ClinicalWorkflowHeader } from "../../components/clinical/ClinicalWorkflowUi";
import { supabase } from "../../lib/supabaseClient";
import { loadAuthenticatedDoctor } from "../../hooks/useAuthenticatedDoctor";
import {
  classifyAppointment,
  formatAppointmentDate,
  formatAppointmentTime,
  getManilaDateKey,
  getManilaDayRange,
  getManilaTimeKey,
  toManilaISOString,
} from "../../lib/appointmentDate";
import "../../styles/doctor-reminder.css";
import "../../styles/clinical-workflow-ui-system.css";

const scheduleTableName = "schedule";
const remindersTableName = "reminders";
const medicationRemindersTableName = "medication_reminders";
const medicationReminderOccurrencesTableName = "medication_reminder_occurrences";
const healthTipsTableName = "health_tips";
const healthTipCategories = ["All", "Nutrition", "Exercise"];
const healthTipManagementFilters = ["Active", "Archived", "All"];

const healthTipImages = {
  hydration: "",
  vitamins: "",
  rest: "/images/sleep.png",
  water: "",
  sleep: "/images/sleep.png",
};

const reminderTipIcons = {
  hydration: "mingcute:drop-fill",
  vitamins: "solar:medical-kit-bold",
  rest: "solar:moon-sleep-bold",
  bulb: "mingcute:drop-fill",
  pill: "solar:medical-kit-bold",
  motherCare: "solar:moon-sleep-bold",
  calendarCheck: "mingcute:calendar-line",
};

function getHealthTipImage(tip) {
  return tip.image || healthTipImages[tip.id] || "";
}

function getLocalDateKey(offset = 0) {
  return getManilaDateKey(new Date(Date.now() + offset * 24 * 60 * 60 * 1000));
}

function addDays(dateValue, amount) {
  const date = new Date(`${dateValue}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return "";
  date.setTime(date.getTime() + amount * 24 * 60 * 60 * 1000);
  return getManilaDateKey(date);
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "").trim()
  );
}

function getRelatedRecord(value) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function normalizeIdentity(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeDatabaseTime(value) {
  if (!value) return "";
  return String(value).slice(0, 5);
}

function normalizePostgresTime(value) {
  const normalized = normalizeDatabaseTime(value);

  if (!/^\d{2}:\d{2}$/.test(normalized)) {
    return "";
  }

  return `${normalized}:00`;
}

function formatSupabaseError(error) {
  return [
    error?.message,
    error?.details,
    error?.hint,
    error?.code ? `Code: ${error.code}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function logMedicationReminderDebug(label, details = {}) {
  if (import.meta.env.DEV) {
    console.info(`[Medication Reminder Flow] ${label}:`, details);
  }
}

function getReminderDisplayStatus(
  status,
  remindAt,
  sentAt,
  nowValue = Date.now(),
  repeatMode = "none",
  nextTriggerAt = ""
) {
  const normalizedStatus = String(status || "pending").toLowerCase();
  const normalizedRepeatMode = String(repeatMode || "none").toLowerCase();

  if (normalizedStatus === "cancelled") return "Cancelled";
  if (normalizedStatus === "completed") return "Completed";
  if (normalizedStatus === "sent") return "Sent";

  const triggerAt = nextTriggerAt || remindAt;
  const triggerTime = triggerAt ? new Date(triggerAt).getTime() : Number.NaN;

  if (Number.isFinite(triggerTime) && triggerTime <= nowValue) {
    return "Due";
  }

  if (normalizedRepeatMode !== "none" && sentAt) {
    return "Repeating";
  }

  return "Scheduled";
}

function getMedicationDisplayStatus(status) {
  const normalizedStatus = String(status || "active").toLowerCase();

  if (normalizedStatus === "completed") return "Complete";
  if (normalizedStatus === "cancelled") return "Cancelled";
  if (normalizedStatus === "paused") return "Paused";
  return "Pending";
}

function getMedicationDatabaseStatus(status) {
  if (status === "Complete" || status === "Completed") return "completed";
  if (status === "Cancelled" || status === "Missed") return "cancelled";
  if (status === "Paused") return "paused";
  return "active";
}

function getStatusClass(status) {
  return String(status || "Pending")
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function isDateInsideMedicationRange(dateValue, reminder) {
  if (!dateValue || !reminder.startDate) {
    return false;
  }

  if (dateValue < reminder.startDate) {
    return false;
  }

  if (reminder.endDate && dateValue > reminder.endDate) {
    return false;
  }

  return true;
}

function getMedicationOccurrenceDate(reminder, filter) {
  const today = getLocalDateKey();
  const tomorrow = addDays(today, 1);

  if (filter === "Today") {
    return isDateInsideMedicationRange(today, reminder) ? today : "";
  }

  if (filter === "Tomorrow") {
    return isDateInsideMedicationRange(tomorrow, reminder) ? tomorrow : "";
  }

  const firstPossibleDate =
    reminder.startDate > today ? reminder.startDate : today;

  if (filter === "Upcoming") {
    return isDateInsideMedicationRange(firstPossibleDate, reminder)
      ? firstPossibleDate
      : "";
  }

  if (isDateInsideMedicationRange(firstPossibleDate, reminder)) {
    return firstPossibleDate;
  }

  return reminder.startDate || "";
}

function getMedicationOccurrenceKey(
  medicationReminderId,
  scheduleDate,
  scheduleTime
) {
  return [
    String(medicationReminderId || ""),
    String(scheduleDate || ""),
    normalizeDatabaseTime(scheduleTime),
  ].join("|");
}

function getMedicationOccurrenceQueryRange() {
  const todayRange = getManilaDayRange();

  if (!todayRange) {
    return null;
  }

  return {
    start: todayRange.start.toISOString(),
    end: new Date(
      todayRange.start.getTime() + 8 * 24 * 60 * 60 * 1000
    ).toISOString(),
  };
}

function isMissingMedicationOccurrenceError(error) {
  const message = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();

  return (
    error?.code === "42P01" ||
    error?.code === "42703" ||
    error?.code === "PGRST200" ||
    error?.code === "PGRST204" ||
    error?.code === "PGRST205" ||
    message.includes("schema cache") ||
    message.includes("could not find") ||
    message.includes("does not exist")
  );
}

function mapMedicationOccurrenceDatabaseRow(row) {
  const scheduleDate = getManilaDateKey(row.scheduled_for);
  const scheduleTime = getManilaTimeKey(row.scheduled_for);

  return {
    id: row.id,
    medicationReminderId: row.medication_reminder_id,
    patientId: row.patient_id,
    scheduledFor: row.scheduled_for,
    scheduleDate,
    scheduleTime,
    status: String(row.status || "").trim().toLowerCase(),
    notificationId: row.notification_id || "",
    notifiedAt: row.notified_at || "",
    actionAt: row.action_at || "",
    missedAt: row.missed_at || "",
    errorCode: row.error_code || "",
    matchKey: getMedicationOccurrenceKey(
      row.medication_reminder_id,
      scheduleDate,
      scheduleTime
    ),
  };
}

function getDoctorMedicationOccurrenceStatus(reminder, occurrence, nowValue) {
  if (occurrence?.status === "processing") {
    return { label: "PROCESSING", className: "processing" };
  }

  if (occurrence?.status === "notified") {
    return { label: "DUE", className: "due" };
  }

  if (occurrence?.status === "taken") {
    return { label: "TAKEN", className: "taken" };
  }

  if (occurrence?.status === "skipped") {
    return { label: "SKIPPED", className: "skipped" };
  }

  if (occurrence?.status === "missed") {
    return { label: "MISSED", className: "missed" };
  }

  if (occurrence?.status === "failed") {
    return { label: "UNAVAILABLE", className: "unavailable" };
  }

  if (!reminder.isActive) {
    const status = reminder.courseStatus || reminder.status || "Inactive";
    return { label: status, className: getStatusClass(status) };
  }

  const scheduleAt = toManilaISOString(
    reminder.scheduleDate,
    reminder.scheduleTime || "08:00"
  );
  const scheduleTime = scheduleAt ? new Date(scheduleAt).getTime() : Number.NaN;

  if (Number.isFinite(scheduleTime) && scheduleTime <= nowValue) {
    return { label: "PENDING", className: "pending" };
  }

  return { label: "UPCOMING", className: "upcoming" };
}

function buildDoctorMedicationScheduleRows(
  medicationReminders,
  medicationOccurrenceMap,
  filter,
  nowValue,
  occurrenceDataStatus = "ready"
) {
  return medicationReminders
    .flatMap((reminder) => {
      const occurrenceDate = getMedicationOccurrenceDate(reminder, filter);

      if (!occurrenceDate) {
        return [];
      }

      const reminderTimes = reminder.scheduleTimes?.length
        ? reminder.scheduleTimes
        : [reminder.scheduleTime || "08:00"];

      return reminderTimes.map((timeValue, index) => {
        const scheduleTime = normalizeDatabaseTime(timeValue) || "08:00";
        const matchKey = getMedicationOccurrenceKey(
          reminder.sourceReminderId || reminder.id,
          occurrenceDate,
          scheduleTime
        );
        const occurrence = medicationOccurrenceMap.get(matchKey) || null;
        const status =
          !occurrence && reminder.isActive && occurrenceDataStatus !== "ready"
            ? occurrenceDataStatus === "loading"
              ? { label: "CHECKING", className: "processing" }
              : { label: "UNAVAILABLE", className: "unavailable" }
            : getDoctorMedicationOccurrenceStatus(
                {
                  ...reminder,
                  scheduleDate: occurrenceDate,
                  scheduleTime,
                },
                occurrence,
                nowValue
              );

        return {
          ...reminder,
          id: `${reminder.sourceReminderId || reminder.id}-${occurrenceDate}-${scheduleTime}-${index}`,
          sourceReminderId: reminder.sourceReminderId || reminder.id,
          scheduleDate: occurrenceDate,
          scheduleTime,
          scheduleAt: toManilaISOString(occurrenceDate, scheduleTime),
          notifyAt: toManilaISOString(occurrenceDate, scheduleTime),
          schedule: `${formatReminderDisplayDate(occurrenceDate)} ${formatMedicationReminderTime(scheduleTime)} - ${reminder.frequency || "As prescribed"}`,
          occurrence,
          matchKey,
          status: status.label,
          statusClassName: status.className,
        };
      });
    })
    .sort(
      (first, second) =>
        new Date(first.scheduleAt || 0) - new Date(second.scheduleAt || 0)
    );
}

function getMedicationEndDate(startDate, duration) {
  if (!startDate || !duration || duration === "Until finished") {
    return null;
  }

  const durationMatch = String(duration).match(/^(\d+)\s+days?$/i);

  if (!durationMatch) {
    return null;
  }

  const dayCount = Number(durationMatch[1]);
  const endDate = new Date(`${startDate}T00:00:00`);

  if (Number.isNaN(endDate.getTime()) || dayCount < 1) {
    return null;
  }

  endDate.setDate(endDate.getDate() + dayCount - 1);

  const year = endDate.getFullYear();
  const month = String(endDate.getMonth() + 1).padStart(2, "0");
  const day = String(endDate.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function getMedicationDuration(startDate, endDate) {
  if (!startDate || !endDate) {
    return "Until finished";
  }

  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return "Until finished";
  }

  const dayCount = Math.max(
    1,
    Math.round((end.getTime() - start.getTime()) / 86400000) + 1
  );

  return `${dayCount} day${dayCount === 1 ? "" : "s"}`;
}

function getReminderLeadTimeFromStoredReminder(appointment, reminder) {
  if (!appointment?.scheduleAt || !reminder?.notifyAt) {
    return "1day";
  }

  const appointmentTime = new Date(appointment.scheduleAt).getTime();
  const reminderTime = new Date(reminder.notifyAt).getTime();

  if (!Number.isFinite(appointmentTime) || !Number.isFinite(reminderTime)) {
    return "1day";
  }

  const differenceHours = (appointmentTime - reminderTime) / 3600000;
  const presets = [
    ["1hour", 1],
    ["1day", 24],
    ["3days", 72],
    ["3weeks", 504],
  ];

  const matchedPreset = presets.find(
    ([, hours]) => Math.abs(differenceHours - hours) < 0.05
  );

  return matchedPreset?.[0] || "custom";
}

function toReminderDateTimeLocalValue(value) {
  if (!value) return "";

  const dateKey = getManilaDateKey(value);
  const timeKey = getManilaTimeKey(value);

  return dateKey && timeKey ? `${dateKey}T${timeKey}` : "";
}

function mapReminderDatabaseRow(row) {
  const patient = getRelatedRecord(row.patients);
  const appointment = getRelatedRecord(row.schedule);
  const scheduleAt = appointment?.start_time || row.remind_at;

  return {
    id: row.id,
    type: "scheduleReminder",
    appointmentId: row.schedule_id || appointment?.id || "",
    patientId: row.patient_id || patient?.id || "",
    patientName:
      patient?.full_name || appointment?.patient_name || "Patient",
    appointmentType:
      appointment?.title || row.title || "Appointment",
    doctorName: appointment?.doctor_name || "Healthcare provider",
    scheduleDate: toDateKey(scheduleAt),
    scheduleTime: toTimeKey(scheduleAt),
    scheduleAt,
    message: row.message || "",
    notifyAt: row.remind_at,
    status: getReminderDisplayStatus(
      row.status,
      row.remind_at,
      row.sent_at,
      Date.now(),
      row.repeat_mode,
      row.next_trigger_at
    ),
    databaseStatus: row.status,
    repeatMode: row.repeat_mode || "none",
    nextTriggerAt: row.next_trigger_at || "",
    repeatUntil: row.repeat_until || "",
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

function mapMedicationReminderDatabaseRow(row) {
  const patient = getRelatedRecord(row.patients);
  const reminderTimes = Array.isArray(row.reminder_times)
    ? row.reminder_times.map(normalizeDatabaseTime).filter(Boolean)
    : [];

  const primaryTime = reminderTimes[0] || "08:00";

  return {
    id: row.id,
    sourceReminderId: row.id,
    type: "medicationReminder",
    patientId: row.patient_id || patient?.id || "",
    patientName: patient?.full_name || "Patient",
    medication: row.medication_name || "Medication",
    dosage: row.dosage || "",
    frequency: row.frequency || "As prescribed",
    scheduleDate: row.start_date || "",
    scheduleTime: primaryTime,
    scheduleTimes: reminderTimes,
    startDate: row.start_date || "",
    endDate: row.end_date || "",
    duration: row.duration || getMedicationDuration(row.start_date, row.end_date),
    schedule: `${formatReminderDisplayDate(row.start_date)} ${reminderTimes
      .map(formatMedicationReminderTime)
      .join(", ")} - ${row.frequency || "As prescribed"}`,
    status: getMedicationDisplayStatus(row.status),
    message: row.instructions || "",
    notifyAt: row.start_date
      ? getScheduleDateTime(row.start_date, primaryTime)
      : "",
    scheduleAt: row.start_date
      ? getScheduleDateTime(row.start_date, primaryTime)
      : "",
    createdAt: row.created_at,
    databaseStatus: row.status,
    courseStatus: getMedicationDisplayStatus(row.status),
    isActive:
      String(row.status || "active").trim().toLowerCase() === "active",
  };
}

async function resolvePatientRecordId(candidateId, patientName) {
  if (isUuid(candidateId)) {
    return candidateId;
  }

  const normalizedCandidateId = String(candidateId || "").trim();
  const normalizedName = String(patientName || "").trim();

  if (normalizedCandidateId) {
    const { data, error } = await supabase
      .rpc("get_doctor_patient_directory")
      .select("id")
      .eq("patient_id", normalizedCandidateId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (data?.id) {
      return data.id;
    }
  }

  if (!normalizedName) {
    return "";
  }

  const { data, error } = await supabase
    .rpc("get_doctor_patient_directory")
    .select("id")
    .ilike("full_name", normalizedName)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data?.id || "";
}

function isRegisteredPatientForAppointment(patient, appointment) {
  const appointmentPatientId = String(appointment?.patient_id || "").trim();
  const appointmentPatientName = normalizeIdentity(appointment?.patient_name);

  return (
    Boolean(patient?.id && appointmentPatientId === patient.id) ||
    Boolean(patient?.patient_id && appointmentPatientId === patient.patient_id) ||
    Boolean(
      patient?.full_name &&
        appointmentPatientName &&
        appointmentPatientName === normalizeIdentity(patient.full_name)
    )
  );
}

function attachRegisteredPatientToAppointment(appointment, patients) {
  const registeredPatient = patients.find((patient) =>
    isRegisteredPatientForAppointment(patient, appointment)
  );

  if (!registeredPatient?.id) {
    return null;
  }

  return {
    ...appointment,
    patientRecordId: registeredPatient.id,
    patient_id: registeredPatient.id,
    patient_name: registeredPatient.full_name || appointment.patient_name,
  };
}

function inferHealthTipIcon(tip) {
  const searchableText = `${tip?.title || ""} ${tip?.content || tip?.text || ""}`
    .toLowerCase();
  const category = String(tip?.category || "").toLowerCase();

  if (/vitamin|prenatal|supplement|medicine|medication/.test(searchableText)) {
    return "vitamins";
  }

  if (/sleep|rest|relax/.test(searchableText) || category === "exercise") {
    return "rest";
  }

  if (/water|hydrat|drink/.test(searchableText) || category === "nutrition") {
    return "hydration";
  }

  return "bulb";
}

function normalizeHealthTip(tip) {
  if (!tip || typeof tip !== "object") {
    return null;
  }

  const title = String(tip.title || "").trim();
  const text = String(tip.content ?? tip.text ?? "").trim();

  if (!text) {
    return null;
  }

  return {
    id:
      tip.id ||
      `health-tip-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    category: tip.category || "Nutrition",
    icon: tip.icon || tip.icon_key || inferHealthTipIcon(tip),
    image: tip.image_url || tip.image || "",
    title: title || tip.category || "Health Tip",
    text,
    displaySchedule:
      tip.display_schedule || tip.displaySchedule || "Daily",
    patientId: tip.patient_id || "",
    createdBy: tip.created_by || "",
    isActive: tip.is_active !== false,
    status: tip.status || (tip.is_active === false ? "archived" : "active"),
    publishedAt: tip.published_at || tip.created_at || "",
    updatedAt: tip.updated_at || "",
    databaseBacked: tip.databaseBacked === true,
  };
}

function mapHealthTipDatabaseRow(row) {
  return normalizeHealthTip({ ...row, databaseBacked: true });
}

function getScheduleDateTime(scheduleDate, scheduleTime) {
  return new Date(`${scheduleDate}T${scheduleTime || "08:00"}`).toISOString();
}

function getReminderNotifyAtForAppointment(appointment, reminderLeadTime, customNotifyAt = "") {
  if (reminderLeadTime === "custom") {
    return customNotifyAt ? new Date(customNotifyAt).toISOString() : "";
  }

  if (!appointment?.scheduleDate || !appointment?.scheduleTime) {
    return "";
  }

  const scheduleDate = new Date(`${appointment.scheduleDate}T${appointment.scheduleTime}`);
  const leadTimeHours = {
    "1hour": 1,
    "1day": 24,
    "3days": 72,
    "3weeks": 504,
  }[reminderLeadTime] ?? 24;

  scheduleDate.setHours(scheduleDate.getHours() - leadTimeHours);
  return scheduleDate.toISOString();
}

function buildAppointmentReminderMessage(appointment) {
  const scheduleAt = appointment?.scheduleAt || toManilaISOString(
    appointment?.scheduleDate,
    appointment?.scheduleTime
  );

  if (!scheduleAt) {
    return `Reminder: ${appointment?.patientName || "Patient"} has ${appointment?.appointmentType || "an appointment"} scheduled.`;
  }

  const appointmentDateLabel = formatAppointmentDate(scheduleAt);
  const appointmentTimeLabel = formatAppointmentTime(scheduleAt);

  return `Reminder: ${appointment?.patientName || "Patient"} has ${appointment?.appointmentType || "an appointment"} scheduled on ${appointmentDateLabel} at ${appointmentTimeLabel}.`;
}

function toDateKey(value) {
  return getManilaDateKey(value);
}

function toTimeKey(value) {
  return getManilaTimeKey(value);
}

function mapScheduleAppointment(row) {
  return {
    id: row.id,
    patientId: row.patientRecordId || row.patient_id || "",
    patientName: row.patient_name || "Patient",
    appointmentType: row.title || "Appointment",
    doctorName: row.doctor_name || "Doctor not recorded",
    scheduleDate: toDateKey(row.start_time),
    scheduleTime: toTimeKey(row.start_time),
    scheduleAt: row.start_time,
    scheduleEndAt: row.end_time,
    scheduleStatus: row.status,
  };
}

function isAppointmentReminderEligible(appointment, nowValue = new Date()) {
  return classifyAppointment(
    {
      start: appointment?.scheduleAt,
      end: appointment?.scheduleEndAt,
      status: appointment?.scheduleStatus,
    },
    nowValue
  ).isActionable;
}

function formatMedicationReminderTime(timeValue) {
  if (!timeValue) {
    return "";
  }

  const [hour = "0", minute = "00"] = timeValue.split(":");
  const date = new Date();
  date.setHours(Number(hour), Number(minute), 0, 0);

  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatReminderDisplayDate(dateValue) {
  if (!dateValue) {
    return "";
  }

  const date = new Date(`${dateValue}T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    return dateValue;
  }

  return date.toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
  }).replace(/\//g, "-");
}

function formatReminderDisplayTime(timeValue) {
  if (!timeValue) {
    return "";
  }

  const [hour = "0", minute = "00"] = String(timeValue).split(":");
  const date = new Date();
  date.setHours(Number(hour), Number(minute), 0, 0);

  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).toLowerCase();
}


function getDoctorInitials(name) {
  const initials = String(name || "Doctor")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

  return initials || "DR";
}

function ReminderProfileMenu({ doctorIdentity }) {
  const [isOpen, setIsOpen] = React.useState(false);
  const profileRef = React.useRef(null);
  const displayName = doctorIdentity?.loading
    ? "Loading Doctor profile..."
    : doctorIdentity?.error
      ? "Doctor profile not found"
      : doctorIdentity?.doctorDisplayName || "Doctor";
  const initials = getDoctorInitials(displayName);

  React.useEffect(() => {
    if (!isOpen) return undefined;

    const handleClickOutside = (event) => {
      if (profileRef.current && !profileRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    const handleEscape = (event) => {
      if (event.key === "Escape") setIsOpen(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  const goToDoctorSection = (section) => {
    setIsOpen(false);
    window.dispatchEvent(new CustomEvent("doctor:navigate", { detail: { section } }));
  };

  return (
    <div className={`doctor-reminder-profile-wrap ${isOpen ? "is-open" : ""}`} ref={profileRef}>
      <button
        className="doctor-reminder-profile-card"
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className="doctor-reminder-profile-avatar">{initials}</span>
        <span className="doctor-reminder-profile-copy">
          <strong>{displayName}</strong>
          <small>Doctor</small>
        </span>
        <Icon icon="ri:arrow-down-s-line" />
      </button>

      {isOpen ? (
        <div className="doctor-reminder-profile-dropdown" role="menu">
          <div className="doctor-reminder-profile-dropdown__header">
            <span className="doctor-reminder-profile-dropdown__avatar">{initials}</span>
            <span>
              <strong>{displayName}</strong>
              <small>Doctor Account</small>
            </span>
          </div>

          <div className="doctor-reminder-profile-dropdown__divider" />

          <button type="button" role="menuitem" onClick={() => goToDoctorSection("profile")}>
            <Icon icon="solar:user-linear" />
            View Profile
          </button>
          <button type="button" role="menuitem" onClick={() => goToDoctorSection("settings")}>
            <Icon icon="solar:settings-linear" />
            Settings
          </button>
          <button className="is-danger" type="button" role="menuitem" onClick={() => goToDoctorSection("logout")}>
            <Icon icon="solar:logout-2-linear" />
            Logout
          </button>
        </div>
      ) : null}
    </div>
  );
}

function DoctorReminderContent({ headerAction = null, doctorIdentity = null }) {
  const [form, setForm] = React.useState({
    appointmentId: "",
    patientId: "",
    patientName: "",
    scheduleDate: "",
    scheduleTime: "",
    appointmentType: "Prenatal Checkup",
    doctorName: "",
    message: "",
    reminderLeadTime: "1day",
    customNotifyAt: "",
    repeatReminder: "none",
  });
  const [reminderFormSource, setReminderFormSource] = React.useState("global");
  const [reminderTargetMode, setReminderTargetMode] = React.useState("single");
  const [selectedAppointmentIds, setSelectedAppointmentIds] = React.useState([]);
  const [availableAppointments, setAvailableAppointments] = React.useState([]);
  const [isLoadingAppointments, setIsLoadingAppointments] = React.useState(true);
  const [appointmentsMessage, setAppointmentsMessage] = React.useState("");
  const [reminders, setReminders] = React.useState([]);
  const [isLoadingAppointmentReminders, setIsLoadingAppointmentReminders] =
    React.useState(true);
  const [appointmentRemindersMessage, setAppointmentRemindersMessage] =
    React.useState("");
  const [appointmentRemindersLoadError, setAppointmentRemindersLoadError] =
    React.useState("");
  const [medicationReminders, setMedicationReminders] = React.useState([]);
  const [isLoadingMedicationReminders, setIsLoadingMedicationReminders] =
    React.useState(true);
  const [medicationRemindersMessage, setMedicationRemindersMessage] =
    React.useState("");
  const [medicationOccurrences, setMedicationOccurrences] = React.useState([]);
  const [medicationOccurrenceStatus, setMedicationOccurrenceStatus] =
    React.useState("loading");
  const [medicationOccurrencesMessage, setMedicationOccurrencesMessage] =
    React.useState("");
  const [isReminderFormOpen, setIsReminderFormOpen] = React.useState(false);
  const [isMedicationFormOpen, setIsMedicationFormOpen] = React.useState(false);
  const [appointmentReminderFilter, setAppointmentReminderFilter] = React.useState("Today");
  const [medicationReminderFilter, setMedicationReminderFilter] = React.useState("Today");
  const [healthTips, setHealthTips] = React.useState([]);
  const [healthTipFilter, setHealthTipFilter] = React.useState("All");
  const [viewAllSection, setViewAllSection] = React.useState(null);
  const [isHealthTipFormOpen, setIsHealthTipFormOpen] = React.useState(false);
  const [healthTipFormMode, setHealthTipFormMode] = React.useState("add");
  const [editingHealthTipId, setEditingHealthTipId] = React.useState("");
  const [healthTipFormErrors, setHealthTipFormErrors] = React.useState({});
  const [healthTipManagementFilter, setHealthTipManagementFilter] = React.useState("Active");
  const [healthTipActionMenu, setHealthTipActionMenu] = React.useState(null);
  const [deleteHealthTipTarget, setDeleteHealthTipTarget] = React.useState(null);
  const [isDeletingHealthTip, setIsDeletingHealthTip] = React.useState(false);
  const [healthTipForm, setHealthTipForm] = React.useState({
    category: "Nutrition",
    icon: "bulb",
    title: "",
    text: "",
    displaySchedule: "Daily",
  });
  const [statusMessage, setStatusMessage] = React.useState("");
  const [isSavingReminder, setIsSavingReminder] = React.useState(false);
  const [isSavingMedicationReminder, setIsSavingMedicationReminder] = React.useState(false);
  const [isLoadingHealthTips, setIsLoadingHealthTips] = React.useState(true);
  const [isSavingHealthTip, setIsSavingHealthTip] = React.useState(false);
  const [healthTipsMessage, setHealthTipsMessage] = React.useState("");
  const [medicationForm, setMedicationForm] = React.useState({
    patientId: "",
    patientName: "",
    prescriptionReference: "",
    medication: "",
    dosage: "",
    scheduleDate: "",
    scheduleTime: "",
    scheduleTimes: [],
    frequency: "",
    duration: "",
    message: "",
  });
  const [medicationPatientSearch, setMedicationPatientSearch] = React.useState("");
  const [medicationPatientResults, setMedicationPatientResults] = React.useState([]);
  const [isSearchingMedicationPatients, setIsSearchingMedicationPatients] = React.useState(false);
  const [medicationPatientSearchMessage, setMedicationPatientSearchMessage] = React.useState("");
  const [medicationStatusMessage, setMedicationStatusMessage] = React.useState("");
  const [currentTime, setCurrentTime] = React.useState(() => Date.now());
  const medicationTimePickerRef = React.useRef(null);

  React.useEffect(() => {
    const reminderStatusTimer = window.setInterval(() => {
      setCurrentTime(Date.now());
    }, 60000);

    return () => window.clearInterval(reminderStatusTimer);
  }, []);

  const loadAppointments = React.useCallback(async () => {
    setIsLoadingAppointments(true);

    const [scheduleResult, patientsResult] = await Promise.all([
      supabase
        .from(scheduleTableName)
        .select(
          "id, patient_id, patient_name, doctor_name, title, start_time, end_time, status"
        )
        .order("start_time", { ascending: true }),
      supabase
        .rpc("get_doctor_patient_directory")
        .select("id, full_name, patient_id, status")
        .order("full_name", { ascending: true }),
    ]);

    setIsLoadingAppointments(false);

    if (scheduleResult.error) {
      setAvailableAppointments([]);
      setAppointmentsMessage(
        `Unable to load appointments: ${scheduleResult.error.message}`
      );
      return;
    }

    if (patientsResult.error) {
      console.warn("Unable to verify appointment patients:", patientsResult.error);
      setAvailableAppointments(
        (scheduleResult.data || []).map(mapScheduleAppointment)
      );
      setAppointmentsMessage("");
      return;
    }

    const registeredAppointments = (scheduleResult.data || [])
      .map((appointment) =>
        attachRegisteredPatientToAppointment(
          appointment,
          patientsResult.data || []
        )
      )
      .filter(Boolean)
      .map(mapScheduleAppointment);

    setAvailableAppointments(registeredAppointments);
    setAppointmentsMessage(
      registeredAppointments.length
        ? ""
        : "No appointments linked to registered patients are available for reminders."
    );
  }, []);

  const loadAppointmentReminders = React.useCallback(async () => {
    setIsLoadingAppointmentReminders(true);
    setAppointmentRemindersLoadError("");
    setAppointmentRemindersMessage((currentMessage) =>
      currentMessage.startsWith("Unable to load appointment reminders:")
        ? ""
        : currentMessage
    );
    const { data, error } = await supabase
      .from(remindersTableName)
      .select(`
        id,
        patient_id,
        schedule_id,
        reminder_type,
        title,
        message,
        remind_at,
        status,
        sent_at,
        repeat_mode,
        next_trigger_at,
        repeat_until,
        created_at,
        schedule (
          id,
          patient_id,
          patient_name,
          doctor_name,
          title,
          start_time,
          end_time,
          status
        )
      `)
      .order("remind_at", { ascending: true });

    if (error) {
      console.error("Unable to load appointment reminders:", error);
      setReminders([]);
      setAppointmentRemindersLoadError(error.message || "Unknown error");
      setAppointmentRemindersMessage(
        `Unable to load appointment reminders: ${error.message}`
      );
      setIsLoadingAppointmentReminders(false);
      return;
    }

    setAppointmentRemindersLoadError("");
    setReminders((data || []).map(mapReminderDatabaseRow));
    setIsLoadingAppointmentReminders(false);
  }, []);

  const loadMedicationReminderRows = React.useCallback(async () => {
    setIsLoadingMedicationReminders(true);
    setMedicationRemindersMessage("");
    const { data, error } = await supabase
      .from(medicationRemindersTableName)
      .select(`
        id,
        patient_id,
        prescription_reference,
        medication_name,
        dosage,
        frequency,
        duration,
        reminder_times,
        instructions,
        start_date,
        end_date,
        status,
        created_at
      `)
      .order("start_date", { ascending: true });

    if (error) {
      console.error("Unable to load medication reminders:", error);
      setMedicationReminders([]);
      setMedicationRemindersMessage(
        `Unable to load medication reminders: ${error.message}`
      );
      setIsLoadingMedicationReminders(false);
      return;
    }

    const patientIds = Array.from(
      new Set((data || []).map((row) => row.patient_id).filter(Boolean))
    );
    const patientResult = patientIds.length
      ? await supabase
          .rpc("get_doctor_patient_directory")
          .select("id, full_name, patient_id")
          .in("id", patientIds)
      : { data: [], error: null };

    if (patientResult.error) {
      console.error("Unable to resolve medication reminder Patients:", patientResult.error);
      setMedicationReminders([]);
      setMedicationRemindersMessage(
        `Unable to load medication reminders: ${patientResult.error.message}`
      );
      setIsLoadingMedicationReminders(false);
      return;
    }

    const patientsById = new Map(
      (patientResult.data || []).map((patient) => [patient.id, patient])
    );
    setMedicationReminders(
      (data || []).map((row) => ({
        ...row,
        patients: patientsById.get(row.patient_id) || null,
      })).map(mapMedicationReminderDatabaseRow)
    );
    setIsLoadingMedicationReminders(false);
  }, []);

  const loadMedicationOccurrenceRows = React.useCallback(async () => {
    setMedicationOccurrenceStatus("loading");
    setMedicationOccurrencesMessage("");
    const queryRange = getMedicationOccurrenceQueryRange();

    if (!queryRange) {
      setMedicationOccurrences([]);
      setMedicationOccurrenceStatus("error");
      setMedicationOccurrencesMessage(
        "Medication dose status is unavailable because the date range could not be determined."
      );
      return;
    }

    const { data, error } = await supabase
      .from(medicationReminderOccurrencesTableName)
      .select(
        `
          id,
          medication_reminder_id,
          patient_id,
          scheduled_for,
          status,
          notification_id,
          notified_at,
          action_at,
          missed_at,
          error_code,
          updated_at
        `
      )
      .gte("scheduled_for", queryRange.start)
      .lt("scheduled_for", queryRange.end)
      .order("scheduled_for", { ascending: true });

    if (error) {
      if (!isMissingMedicationOccurrenceError(error)) {
        console.error("Unable to load medication occurrences:", error);
      }
      setMedicationOccurrences([]);
      setMedicationOccurrenceStatus("error");
      setMedicationOccurrencesMessage(
        isMissingMedicationOccurrenceError(error)
          ? "Medication dose status is not available yet."
          : `Unable to load medication dose status: ${error.message}`
      );
      return;
    }

    setMedicationOccurrences(
      (data || []).map(mapMedicationOccurrenceDatabaseRow)
    );
    setMedicationOccurrenceStatus("ready");
  }, []);

  const loadMedicationReminderData = React.useCallback(async () => {
    await Promise.all([
      loadMedicationReminderRows(),
      loadMedicationOccurrenceRows(),
    ]);
  }, [loadMedicationOccurrenceRows, loadMedicationReminderRows]);

  const loadHealthTipRows = React.useCallback(async () => {
    setIsLoadingHealthTips(true);

    const { data, error } = await supabase
      .from(healthTipsTableName)
      .select("*")
      .order("published_at", { ascending: false })
      .order("created_at", { ascending: false });

    setIsLoadingHealthTips(false);

    if (error) {
      console.error("Unable to load health tips:", error);
      setHealthTips([]);
      setHealthTipsMessage(`Unable to load health tips: ${error.message}`);
      return;
    }

    const databaseTips = (data || [])
      .map(mapHealthTipDatabaseRow)
      .filter(Boolean);

    setHealthTips(databaseTips);
    setHealthTipsMessage("");
  }, []);

  React.useEffect(() => {
    const initialLoadTimer = window.setTimeout(() => {
      loadAppointments();
      loadAppointmentReminders();
      loadMedicationReminderData();
      loadHealthTipRows();
    }, 0);

    const appointmentDataChannel = supabase
      .channel("doctor-reminder-appointment-data")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: scheduleTableName },
        loadAppointments
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: remindersTableName },
        loadAppointmentReminders
      )
      .subscribe();

    const medicationDataChannel = supabase
      .channel("doctor-reminder-medication-data")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: medicationRemindersTableName,
        },
        loadMedicationReminderRows
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: medicationReminderOccurrencesTableName,
        },
        loadMedicationOccurrenceRows
      )
      .subscribe();

    const healthTipsChannel = supabase
      .channel("doctor-health-tips")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: healthTipsTableName },
        loadHealthTipRows
      )
      .subscribe();

    return () => {
      window.clearTimeout(initialLoadTimer);
      supabase.removeChannel(appointmentDataChannel);
      supabase.removeChannel(medicationDataChannel);
      supabase.removeChannel(healthTipsChannel);
    };
  }, [
    loadAppointments,
    loadAppointmentReminders,
    loadMedicationOccurrenceRows,
    loadMedicationReminderData,
    loadMedicationReminderRows,
    loadHealthTipRows,
  ]);

  React.useEffect(() => {
    if (
      !appointmentRemindersMessage ||
      appointmentRemindersMessage.startsWith("Unable to load appointment reminders:")
    ) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setAppointmentRemindersMessage("");
    }, 4000);

    return () => window.clearTimeout(timeoutId);
  }, [appointmentRemindersMessage]);


  React.useEffect(() => {
    const searchMedicationPatients = async () => {
      const query = medicationPatientSearch.trim();

      if (query.length < 1) {
        setMedicationPatientResults([]);
        setMedicationPatientSearchMessage("");
        return;
      }

      setIsSearchingMedicationPatients(true);
      setMedicationPatientSearchMessage("");

      const { data, error } = await supabase
        .rpc("get_doctor_patient_directory")
        .select("id, full_name, contact_number")
        .ilike("full_name", `%${query}%`)
        .order("full_name", { ascending: true })
        .limit(8);

      setIsSearchingMedicationPatients(false);

      if (error) {
        setMedicationPatientResults([]);
        setMedicationPatientSearchMessage(error.message);
        return;
      }

      setMedicationPatientResults(data ?? []);
      setMedicationPatientSearchMessage(data?.length ? "" : "No patients found.");
    };

    const searchTimer = window.setTimeout(searchMedicationPatients, 300);
    return () => window.clearTimeout(searchTimer);
  }, [medicationPatientSearch]);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({
      ...current,
      [name]: value,
    }));
  };

  const resetAppointmentReminderForm = React.useCallback(() => {
    setForm({
      appointmentId: "",
      patientId: "",
      patientName: "",
      scheduleDate: "",
      scheduleTime: "",
      appointmentType: "",
      doctorName: "",
      message: "",
      reminderLeadTime: "1day",
      customNotifyAt: "",
      repeatReminder: "none",
    });
    setReminderTargetMode("single");
    setSelectedAppointmentIds([]);
  }, []);

  const handleSelectAppointmentForReminder = React.useCallback((appointment, source = "row") => {
    if (!appointment || !isAppointmentReminderEligible(appointment, currentTime)) {
      setStatusMessage("This appointment is no longer eligible for a reminder.");
      return;
    }

    const existingReminder =
      reminders.find((reminder) => reminder.appointmentId === appointment.id) || null;
    const reminderLeadTime = existingReminder
      ? getReminderLeadTimeFromStoredReminder(appointment, existingReminder)
      : "1day";

    setStatusMessage("");
    setReminderFormSource(source);
    setReminderTargetMode("single");
    setSelectedAppointmentIds([]);
    setForm((current) => ({
      ...current,
      appointmentId: appointment.id,
      patientId: appointment.patientId || appointment.patientName,
      patientName: appointment.patientName,
      appointmentType: appointment.appointmentType,
      doctorName: appointment.doctorName,
      scheduleDate: appointment.scheduleDate,
      scheduleTime: appointment.scheduleTime,
      message: existingReminder?.message || "",
      reminderLeadTime,
      customNotifyAt:
        reminderLeadTime === "custom"
          ? toReminderDateTimeLocalValue(existingReminder?.notifyAt)
          : "",
      repeatReminder: existingReminder?.repeatMode || "none",
    }));
    setIsReminderFormOpen(true);
  }, [currentTime, reminders]);

  const handleReminderAppointmentChange = (event) => {
    const appointmentId = event.target.value;

    if (!appointmentId) {
      resetAppointmentReminderForm();
      setStatusMessage("");
      return;
    }

    const appointment =
      availableAppointments.find(
        (item) =>
          item.id === appointmentId &&
          isAppointmentReminderEligible(item, currentTime)
      ) || null;

    if (!appointment) {
      resetAppointmentReminderForm();
      setStatusMessage("The selected appointment could not be found.");
      return;
    }

    handleSelectAppointmentForReminder(appointment, reminderFormSource);
  };

  const handleReminderTargetModeChange = (mode) => {
    setReminderTargetMode(mode);
    setSelectedAppointmentIds([]);
    setStatusMessage("");
    setForm((current) => ({
      ...current,
      appointmentId: "",
      patientId: "",
      patientName: "",
      scheduleDate: "",
      scheduleTime: "",
      appointmentType: "",
      doctorName: "",
      reminderLeadTime:
        mode !== "single" && current.reminderLeadTime === "custom"
          ? "1day"
          : current.reminderLeadTime,
      customNotifyAt: mode === "single" ? current.customNotifyAt : "",
    }));
  };

  const reminderPreviewDetails = React.useMemo(() => {
    if (!form.patientName || !form.scheduleDate || !form.scheduleTime) {
      return null;
    }

    const scheduleAt = toManilaISOString(
      form.scheduleDate,
      form.scheduleTime
    );
    if (!scheduleAt) return null;

    return {
      date: formatAppointmentDate(scheduleAt),
      time: formatAppointmentTime(scheduleAt),
      patient: form.patientName,
      type: form.appointmentType || "appointment",
    };
  }, [form.appointmentType, form.patientName, form.scheduleDate, form.scheduleTime]);

  const handleMedicationChange = (event) => {
    const { name, value } = event.target;
    setMedicationForm((current) => ({
      ...current,
      [name]: value,
    }));
  };

  const handleSelectMedicationPatient = (patient) => {
    setMedicationForm((current) => ({
      ...current,
      patientId: patient.id,
      patientName: patient.full_name,
    }));
    logMedicationReminderDebug("selected patient", {
      patientDatabaseId: patient.id,
    });
    setMedicationPatientSearch(patient.full_name);
    setMedicationPatientResults([]);
    setMedicationPatientSearchMessage("");
  };

  const resetMedicationForm = () => {
    setMedicationForm({
      patientId: "",
      patientName: "",
      prescriptionReference: "",
      medication: "",
      dosage: "",
      scheduleDate: "",
      scheduleTime: "",
      scheduleTimes: [],
      frequency: "",
      duration: "",
      message: "",
    });
    setMedicationPatientSearch("");
    setMedicationPatientResults([]);
    setMedicationPatientSearchMessage("");
  };

  const handleAddScheduleTime = () => {
    const nextTime = normalizeDatabaseTime(medicationForm.scheduleTime);

    if (!nextTime) {
      setMedicationStatusMessage("Choose a medication time before adding it.");
      medicationTimePickerRef.current?.open();
      return;
    }

    if (medicationForm.scheduleTimes.includes(nextTime)) {
      setMedicationStatusMessage(
        `${formatMedicationReminderTime(nextTime)} is already added.`
      );
      medicationTimePickerRef.current?.focus();
      return;
    }

    setMedicationForm((current) => ({
      ...current,
      scheduleTime: "",
      scheduleTimes: Array.from(new Set([...current.scheduleTimes, nextTime])).sort(),
    }));
    setMedicationStatusMessage("");
    logMedicationReminderDebug("selected medication times", {
      medicationTimes: Array.from(
        new Set([...medicationForm.scheduleTimes, nextTime])
      ).sort(),
    });
  };

  const handleMedicationTimeChange = (value) => {
    setMedicationForm((current) => ({
      ...current,
      scheduleTime: value,
    }));
    setMedicationStatusMessage("");
  };

  const removeMedicationTime = (timeIndex) => {
    setMedicationForm((current) => {
      const nextTimes = current.scheduleTimes.filter((_, index) => index !== timeIndex);

      return {
        ...current,
        scheduleTimes: nextTimes,
      };
    });
  };

  const addMedicationReminder = async (event) => {
    event.preventDefault();

    const patientNameValue =
      medicationForm.patientName.trim() ||
      medicationPatientSearch.trim();

    if (!medicationForm.patientId || !isUuid(medicationForm.patientId)) {
      setMedicationStatusMessage(
        "Select a registered patient from the search results."
      );
      return;
    }

    if (!patientNameValue) {
      setMedicationStatusMessage("Select a registered patient from the search results.");
      return;
    }

    if (!medicationForm.prescriptionReference.trim()) {
      setMedicationStatusMessage("Enter the RX number or prescription reference.");
      return;
    }

    if (!medicationForm.medication.trim()) {
      setMedicationStatusMessage("Enter the medication name.");
      return;
    }

    if (!medicationForm.dosage.trim()) {
      setMedicationStatusMessage("Select or enter the dosage.");
      return;
    }

    if (!medicationForm.frequency) {
      setMedicationStatusMessage("Select the medication frequency.");
      return;
    }

    if (!medicationForm.duration) {
      setMedicationStatusMessage("Select the medication duration.");
      return;
    }

    if (!medicationForm.scheduleDate) {
      setMedicationStatusMessage("Choose the medication start date.");
      return;
    }

    const normalizedTimes = Array.from(new Set(medicationForm.scheduleTimes))
      .map(normalizeDatabaseTime)
      .filter(Boolean)
      .sort();

    const postgresReminderTimes = normalizedTimes
      .map(normalizePostgresTime)
      .filter(Boolean);

    if (!postgresReminderTimes.length) {
      setMedicationStatusMessage(
        "Add at least one medication reminder time."
      );
      medicationTimePickerRef.current?.open();
      return;
    }

    let authenticatedDoctor;

    try {
      authenticatedDoctor = await loadAuthenticatedDoctor();
    } catch (identityError) {
      console.error("Medication reminder Doctor identity lookup failed:", identityError);
      setMedicationStatusMessage(
        identityError?.message || "Unable to identify the logged-in Doctor."
      );
      return;
    }

    setIsSavingMedicationReminder(true);
    setMedicationStatusMessage("");

    const payload = {
      patient_id: medicationForm.patientId,
      prescription_reference: medicationForm.prescriptionReference.trim(),
      medication_name: medicationForm.medication.trim(),
      dosage: medicationForm.dosage.trim(),
      frequency: medicationForm.frequency,
      duration: medicationForm.duration,
      reminder_times: postgresReminderTimes,
      instructions:
        medicationForm.message.trim() ||
        `Take ${medicationForm.dosage.trim()} of ${medicationForm.medication.trim()} ${medicationForm.frequency.toLowerCase()}.`,
      start_date: medicationForm.scheduleDate,
      end_date: getMedicationEndDate(
        medicationForm.scheduleDate,
        medicationForm.duration
      ),
      status: "active",
      created_by: authenticatedDoctor.authUser.id,
      updated_at: new Date().toISOString(),
    };

    logMedicationReminderDebug("insert payload", {
      authenticatedUserId: authenticatedDoctor.authUser.id,
      patientDatabaseId: medicationForm.patientId,
      medicationTimes: postgresReminderTimes,
    });

    const { error } = await supabase
      .from(medicationRemindersTableName)
      .insert([payload]);

    setIsSavingMedicationReminder(false);

    if (error) {
      console.error("Medication reminder insert failed:", error);
      logMedicationReminderDebug("insert error", { error });
      setMedicationStatusMessage(
        `Unable to save medication reminder: ${formatSupabaseError(error)}`
      );
      return;
    }

    await loadMedicationReminderData();
    resetMedicationForm();
    setMedicationStatusMessage("Medication reminder saved successfully.");
    setIsMedicationFormOpen(false);
  };

  const updateMedicationStatus = async (reminderId, status) => {
    const { error } = await supabase
      .from(medicationRemindersTableName)
      .update({ status: getMedicationDatabaseStatus(status) })
      .eq("id", reminderId);

    if (error) {
      console.error("Medication reminder status update failed:", error);
      setMedicationStatusMessage(
        `Unable to update medication reminder: ${error.message}`
      );
      return;
    }

    await loadMedicationReminderData();
  };

  const deleteMedicationReminder = async (reminderId) => {
    const shouldDelete = window.confirm(
      "Delete this medication reminder?"
    );

    if (!shouldDelete) {
      return;
    }

    const { error } = await supabase
      .from(medicationRemindersTableName)
      .delete()
      .eq("id", reminderId);

    if (error) {
      console.error("Medication reminder delete failed:", error);
      setMedicationStatusMessage(
        `Unable to delete medication reminder: ${error.message}`
      );
      return;
    }

    await loadMedicationReminderData();
  };

  const getAppointmentReminderStatus = (reminder) => {
    if (isLoadingAppointmentReminders) return "Checking";
    if (appointmentRemindersLoadError) return "Unavailable";
    if (!reminder) return "Not Set";
    return getReminderDisplayStatus(
      reminder.databaseStatus,
      reminder.notifyAt,
      reminder.sentAt,
      currentTime,
      reminder.repeatMode,
      reminder.nextTriggerAt
    );
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    const selectedAppointment = availableAppointments.find(
      (appointment) =>
        appointment.id === form.appointmentId &&
        isAppointmentReminderEligible(appointment, currentTime)
    ) || null;
    const appointmentsToSave = isBulkReminderMode
      ? selectedBulkAppointments
      : selectedAppointment
        ? [selectedAppointment]
        : [];

    if (!appointmentsToSave.length) {
      setStatusMessage(
        isBulkReminderMode
          ? "Select at least one appointment without an existing reminder."
          : "Select an appointment before saving the reminder."
      );
      return;
    }

    if (isBulkReminderMode && form.reminderLeadTime === "custom") {
      setStatusMessage(
        "Custom date/time is available for individual reminders only."
      );
      return;
    }

    const repeatStepMs =
      form.repeatReminder === "hourly"
        ? 60 * 60 * 1000
        : form.repeatReminder === "daily"
          ? 24 * 60 * 60 * 1000
          : 0;

    setIsSavingReminder(true);
    setStatusMessage("");
    const results = [];

    for (const appointment of appointmentsToSave) {
      try {
        const notifyAt = getReminderNotifyAtForAppointment(
          appointment,
          form.reminderLeadTime,
          form.customNotifyAt
        );
        const notifyTime = new Date(notifyAt).getTime();
        const scheduleTime = new Date(
          appointment.scheduleAt ||
            `${appointment.scheduleDate}T${appointment.scheduleTime || "08:00"}`
        ).getTime();

        if (
          !Number.isFinite(notifyTime) ||
          !Number.isFinite(scheduleTime) ||
          notifyTime >= scheduleTime
        ) {
          throw new Error("The reminder time must be before the appointment.");
        }

        if (repeatStepMs && notifyTime + repeatStepMs >= scheduleTime) {
          throw new Error(
            form.repeatReminder === "hourly"
              ? "No hourly repeat fits before the appointment."
              : "No daily repeat fits before the appointment."
          );
        }

        const patientRecordId = await resolvePatientRecordId(
          appointment.patientId,
          appointment.patientName
        );
        if (!patientRecordId) {
          throw new Error("The appointment is not linked to an active Patient.");
        }

        const existingReminder = remindersByAppointmentId[appointment.id];
        if (isBulkReminderMode && existingReminder) {
          throw new Error("An appointment reminder is already configured.");
        }

        const payload = {
          patient_id: patientRecordId,
          schedule_id: appointment.id,
          reminder_type: "appointment",
          title: `${appointment.appointmentType || "Appointment"} Reminder`,
          message:
            form.message.trim() || buildAppointmentReminderMessage(appointment),
          remind_at: notifyAt,
          repeat_mode: form.repeatReminder,
          next_trigger_at: notifyAt,
          repeat_until:
            form.repeatReminder === "none"
              ? null
              : appointment.scheduleAt ||
                toManilaISOString(
                  appointment.scheduleDate,
                  appointment.scheduleTime
                ),
          status: "pending",
          sent_at: null,
        };

        const reminderQuery = existingReminder?.id
          ? supabase
              .from(remindersTableName)
              .update(payload)
              .eq("id", existingReminder.id)
          : supabase.from(remindersTableName).insert([payload]);
        const { error } = await reminderQuery;
        if (error) throw error;

        results.push({ appointment, success: true, updated: Boolean(existingReminder) });
      } catch (error) {
        console.error("Appointment reminder save failed:", {
          appointmentId: appointment.id,
          error,
        });
        results.push({
          appointment,
          success: false,
          error: error?.message || "Unknown error",
        });
      }
    }

    await loadAppointmentReminders();
    setIsSavingReminder(false);

    const successfulResults = results.filter((result) => result.success);
    const failedResults = results.filter((result) => !result.success);
    const repeatLabel = {
      none: "No repeat",
      daily: "Daily",
      hourly: "Every Hour",
    }[form.repeatReminder] || "No repeat";

    if (!isBulkReminderMode) {
      const result = results[0];
      if (!result?.success) {
        setStatusMessage(
          `Unable to save appointment reminder: ${result?.error || "Unknown error"}`
        );
        return;
      }

      resetAppointmentReminderForm();
      setIsReminderFormOpen(false);
      setAppointmentRemindersMessage(
        result.updated
          ? `Appointment reminder updated successfully. Repeat: ${repeatLabel}.`
          : `Appointment reminder saved successfully. Repeat: ${repeatLabel}.`
      );
      return;
    }

    const successCount = successfulResults.length;
    const failureCount = failedResults.length;
    if (!failureCount) {
      resetAppointmentReminderForm();
      setIsReminderFormOpen(false);
      setAppointmentRemindersMessage(
        `${successCount} appointment reminder${successCount === 1 ? "" : "s"} scheduled successfully.`
      );
      return;
    }

    const successfulIds = new Set(
      successfulResults.map((result) => result.appointment.id)
    );
    setSelectedAppointmentIds((current) =>
      current.filter((appointmentId) => !successfulIds.has(appointmentId))
    );
    const failedAppointments = failedResults
      .map(
        (result) =>
          `${result.appointment.patientName} — ${formatReminderDisplayDate(
            result.appointment.scheduleDate
          )}: ${result.error}`
      )
      .join("; ");
    setStatusMessage(
      `${successCount} reminder${successCount === 1 ? "" : "s"} scheduled; ${failureCount} failed. ${failedAppointments}`
    );
  };

  const handleHealthTipChange = (event) => {
    const { name, value } = event.target;
    setHealthTipForm((current) => ({
      ...current,
      [name]: value,
    }));
    setHealthTipFormErrors((current) => ({
      ...current,
      [name === "text" ? "text" : name]: "",
    }));
  };

  const resetHealthTipForm = () => {
    setHealthTipForm({
      category: "Nutrition",
      icon: "bulb",
      title: "",
      text: "",
      displaySchedule: "Daily",
    });
    setEditingHealthTipId("");
    setHealthTipFormMode("add");
    setHealthTipFormErrors({});
  };

  const validateHealthTipForm = () => {
    const errors = {};

    if (!healthTipForm.title.trim()) {
      errors.title = "Title is required.";
    }

    if (!healthTipForm.category.trim()) {
      errors.category = "Category is required.";
    }

    if (!healthTipForm.text.trim()) {
      errors.text = "Message is required.";
    }

    setHealthTipFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const saveHealthTip = async (event) => {
    event.preventDefault();

    const title = healthTipForm.title.trim();
    const category = healthTipForm.category.trim();
    const content = healthTipForm.text.trim();

    if (!validateHealthTipForm()) {
      setHealthTipsMessage("Complete the required health tip fields.");
      return;
    }

    setIsSavingHealthTip(true);
    setHealthTipsMessage("");

    try {
      const authenticatedDoctor = await loadAuthenticatedDoctor();

      const basePayload = {
        patient_id: null,
        category,
        title,
        content,
        image_url: null,
        is_active: true,
        updated_at: new Date().toISOString(),
      };

      const payloadWithSchedule = {
        ...basePayload,
        display_schedule: healthTipForm.displaySchedule,
      };

      let saveResult;

      if (healthTipFormMode === "edit") {
        saveResult = await supabase
          .from(healthTipsTableName)
          .update(payloadWithSchedule)
          .eq("id", editingHealthTipId)
          .select("*")
          .single();
      } else {
        saveResult = await supabase
          .from(healthTipsTableName)
          .insert([
            {
              ...payloadWithSchedule,
              created_by: authenticatedDoctor.authUser.id,
              published_at: new Date().toISOString(),
            },
          ])
          .select("*")
          .single();
      }

      /*
       * The original health_tips table may not have display_schedule yet.
       * Retry with the original schema so saving still works.
       */
      if (
        saveResult.error &&
        /display_schedule/i.test(saveResult.error.message || "")
      ) {
        if (healthTipFormMode === "edit") {
          saveResult = await supabase
            .from(healthTipsTableName)
            .update(basePayload)
            .eq("id", editingHealthTipId)
            .select("*")
            .single();
        } else {
          saveResult = await supabase
            .from(healthTipsTableName)
            .insert([
              {
                ...basePayload,
                created_by: authenticatedDoctor.authUser.id,
                published_at: new Date().toISOString(),
              },
            ])
            .select("*")
            .single();
        }
      }

      if (saveResult.error) {
        throw saveResult.error;
      }

      await loadHealthTipRows();

      resetHealthTipForm();
      setHealthTipFilter("All");
      setIsHealthTipFormOpen(false);
      setHealthTipManagementFilter("Active");
      setHealthTipsMessage(
        healthTipFormMode === "edit"
          ? "Health tip updated successfully."
          : "Health tip added successfully."
      );
    } catch (error) {
      console.error("Health tip save failed:", error);
      setHealthTipsMessage(
        "Unable to save health tip. Please check your permissions and try again."
      );
    } finally {
      setIsSavingHealthTip(false);
    }
  };

  const updateHealthTipActiveState = async (tip, isActive) => {
    if (!tip?.databaseBacked) {
      setHealthTipsMessage("Only saved health tips can be managed.");
      return;
    }

    setHealthTipsMessage("");

    const { error } = await supabase
      .from(healthTipsTableName)
      .update({
        is_active: isActive,
        updated_at: new Date().toISOString(),
      })
      .eq("id", tip.id);

    if (error) {
      console.error("Health tip archive/restore failed:", error);
      setHealthTipsMessage(
        /is_active/i.test(error.message || "")
          ? "Health tip archiving requires an is_active column on the health_tips table."
          : "Unable to update health tip status. Please check your permissions and try again."
      );
      return;
    }

    await loadHealthTipRows();
    setHealthTipManagementFilter(isActive ? "Active" : "Archived");
    setHealthTipsMessage(
      isActive
        ? "Health tip restored successfully."
        : "Health tip archived successfully."
    );
  };

  const deleteHealthTip = async () => {
    if (!deleteHealthTipTarget?.id || isDeletingHealthTip) return;

    setIsDeletingHealthTip(true);
    setHealthTipsMessage("");

    const { error } = await supabase
      .from(healthTipsTableName)
      .delete()
      .eq("id", deleteHealthTipTarget.id);

    setIsDeletingHealthTip(false);

    if (error) {
      console.error("Health tip delete failed:", error);
      setHealthTipsMessage(
        "Unable to delete health tip. Please check your permissions and try again."
      );
      return;
    }

    setDeleteHealthTipTarget(null);
    await loadHealthTipRows();
    setHealthTipsMessage("Health tip deleted permanently.");
  };

  const todayDateKey = getLocalDateKey();
  const tomorrowDateKey = getLocalDateKey(1);
  const remindersByAppointmentId = Object.fromEntries(
    reminders
      .filter((reminder) => reminder.appointmentId)
      .map((reminder) => [reminder.appointmentId, reminder])
  );
  const reminderTargetAppointments = availableAppointments.filter((appointment) =>
    isAppointmentReminderEligible(appointment, currentTime)
  );
  const bulkSelectableAppointments = reminderTargetAppointments.filter(
    (appointment) => !remindersByAppointmentId[appointment.id]
  );
  const selectedBulkAppointments =
    reminderTargetMode === "all_without"
      ? bulkSelectableAppointments
      : bulkSelectableAppointments.filter((appointment) =>
          selectedAppointmentIds.includes(appointment.id)
        );
  const isBulkReminderMode =
    reminderFormSource === "global" && reminderTargetMode !== "single";
  const allBulkAppointmentsSelected =
    bulkSelectableAppointments.length > 0 &&
    selectedAppointmentIds.length === bulkSelectableAppointments.length;
  const appointmentRows = reminderTargetAppointments.filter((appointment) => {
    if (appointmentReminderFilter === "Today") return appointment.scheduleDate === todayDateKey;
    if (appointmentReminderFilter === "Tomorrow") return appointment.scheduleDate === tomorrowDateKey;
    if (appointmentReminderFilter === "Upcoming") return true;
    return true;
  });
  const visibleAppointmentRows = appointmentRows.slice(0, appointmentReminderFilter === "All" ? 8 : 3);
  const selectedReminderAppointment =
    reminderTargetAppointments.find(
      (appointment) => appointment.id === form.appointmentId
    ) || null;

  const toggleBulkAppointment = (appointmentId) => {
    setSelectedAppointmentIds((current) =>
      current.includes(appointmentId)
        ? current.filter((id) => id !== appointmentId)
        : [...current, appointmentId]
    );
  };

  const toggleAllBulkAppointments = () => {
    setSelectedAppointmentIds(
      allBulkAppointmentsSelected
        ? []
        : bulkSelectableAppointments.map((appointment) => appointment.id)
    );
  };
  const medicationOccurrenceMap = React.useMemo(() => {
    return new Map(
      medicationOccurrences.map((occurrence) => [
        occurrence.matchKey,
        occurrence,
      ])
    );
  }, [medicationOccurrences]);
  const medicationRows = React.useMemo(
    () =>
      buildDoctorMedicationScheduleRows(
        medicationReminders,
        medicationOccurrenceMap,
        medicationReminderFilter,
        currentTime,
        medicationOccurrenceStatus
      ),
    [
      currentTime,
      medicationOccurrenceMap,
      medicationOccurrenceStatus,
      medicationReminderFilter,
      medicationReminders,
    ]
  );
  const allMedicationRows = React.useMemo(
    () =>
      buildDoctorMedicationScheduleRows(
        medicationReminders,
        medicationOccurrenceMap,
        "All",
        currentTime,
        medicationOccurrenceStatus
      ),
    [
      currentTime,
      medicationOccurrenceMap,
      medicationOccurrenceStatus,
      medicationReminders,
    ]
  );
  const visibleMedicationRows = medicationRows.slice(0, 3);
  const activeHealthTips = healthTips.filter((tip) => tip.isActive !== false);
  const filteredHealthTips =
    healthTipFilter === "All" ? activeHealthTips : activeHealthTips.filter((tip) => tip.category === healthTipFilter);
  const visibleHealthTips = filteredHealthTips.slice(0, 3);
  const databaseHealthTips = healthTips.filter((tip) => tip.databaseBacked);
  const managedHealthTips = databaseHealthTips.filter((tip) => {
    if (healthTipManagementFilter === "Active") return tip.isActive !== false;
    if (healthTipManagementFilter === "Archived") return tip.isActive === false;
    return true;
  });
  const activeHealthTipMenuTip = healthTipActionMenu
    ? databaseHealthTips.find((tip) => tip.id === healthTipActionMenu.tipId) || null
    : null;
  const isAnyModalOpen =
    isReminderFormOpen ||
    isMedicationFormOpen ||
    isHealthTipFormOpen ||
    Boolean(viewAllSection) ||
    Boolean(deleteHealthTipTarget);

  const openReminderForm = () => {
    if (!reminderTargetAppointments.length) {
      setStatusMessage("");
      setAppointmentsMessage(
        "No upcoming appointments linked to registered patients are available for reminders yet."
      );
      return;
    }

    // The global Set Reminder button must never silently target the first patient.
    // Open a blank form and require the Doctor to explicitly choose one appointment.
    resetAppointmentReminderForm();
    setReminderFormSource("global");
    setStatusMessage("");
    setIsReminderFormOpen(true);
  };

  const closeReminderForm = () => {
    setIsReminderFormOpen(false);
    setStatusMessage("");
  };

  const openMedicationForm = () => {
    setMedicationStatusMessage("");
    setIsMedicationFormOpen(true);
  };

  const closeMedicationForm = () => {
    setIsMedicationFormOpen(false);
    setMedicationStatusMessage("");
  };

  const openHealthTipForm = () => {
    resetHealthTipForm();
    setHealthTipsMessage("");
    setIsHealthTipFormOpen(true);
  };

  const openEditHealthTipForm = (tip) => {
    if (!tip?.databaseBacked) {
      setHealthTipsMessage("Only saved health tips can be edited.");
      return;
    }

    // Close the View All modal first so the edit form cannot open behind it.
    setViewAllSection(null);
    setHealthTipActionMenu(null);

    setHealthTipFormMode("edit");
    setEditingHealthTipId(tip.id);
    setHealthTipForm({
      category: tip.category || "Nutrition",
      icon: tip.icon || "bulb",
      title: tip.title || "",
      text: tip.text || "",
      displaySchedule: tip.displaySchedule || "Daily",
    });
    setHealthTipFormErrors({});
    setHealthTipsMessage("");
    setIsHealthTipFormOpen(true);
  };

  const closeHealthTipForm = () => {
    setIsHealthTipFormOpen(false);
    setHealthTipFormErrors({});
    setHealthTipActionMenu(null);
  };

  const openHealthTipsViewAll = () => {
    setHealthTipManagementFilter("Active");
    setHealthTipActionMenu(null);
    setViewAllSection("healthTips");
  };

  const closeViewAll = () => {
    setViewAllSection(null);
    setHealthTipActionMenu(null);
  };

  const getHealthTipMenuPosition = (button) => {
    const rect = button.getBoundingClientRect();
    const menuWidth = 170;
    const menuHeight = 138;
    const viewportPadding = 12;
    const belowTop = rect.bottom + 6;
    const aboveTop = rect.top - menuHeight - 6;
    const hasRoomBelow = belowTop + menuHeight <= window.innerHeight - viewportPadding;

    return {
      top: Math.max(
        viewportPadding,
        Math.min(
          hasRoomBelow ? belowTop : aboveTop,
          window.innerHeight - menuHeight - viewportPadding
        )
      ),
      left: Math.max(
        viewportPadding,
        Math.min(
          rect.right - menuWidth,
          window.innerWidth - menuWidth - viewportPadding
        )
      ),
    };
  };

  const openHealthTipActionMenu = (tip, event) => {
    event.stopPropagation();
    const position = getHealthTipMenuPosition(event.currentTarget);

    setHealthTipActionMenu((current) =>
      current?.tipId === tip.id
        ? null
        : {
            tipId: tip.id,
            ...position,
          }
    );
  };

  const handleHealthTipAction = (tip, action) => {
    setHealthTipActionMenu(null);

    if (action === "edit") {
      openEditHealthTipForm(tip);
      return;
    }

    if (action === "archive") {
      updateHealthTipActiveState(tip, false);
      return;
    }

    if (action === "restore") {
      updateHealthTipActiveState(tip, true);
      return;
    }

    if (action === "delete") {
      // Close View All first so the confirmation dialog is always visible.
      setViewAllSection(null);
      setDeleteHealthTipTarget(tip);
    }
  };

  React.useEffect(() => {
    if (!isAnyModalOpen) {
      return undefined;
    }

    const handleEscape = (event) => {
      if (event.key !== "Escape") {
        return;
      }

      closeReminderForm();
      closeMedicationForm();
      closeHealthTipForm();
      closeViewAll();
      setDeleteHealthTipTarget(null);
      setHealthTipActionMenu(null);
    };

    document.body.classList.add("doctor-reminder-modal-open");
    window.addEventListener("keydown", handleEscape);

    return () => {
      document.body.classList.remove("doctor-reminder-modal-open");
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isAnyModalOpen]);

  React.useEffect(() => {
    if (!healthTipActionMenu) {
      return undefined;
    }

    const closeMenu = () => setHealthTipActionMenu(null);
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);

    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [healthTipActionMenu]);

  return (
    <section className="doctor-reminder-page clinical-workflow clinical-workflow--reminders">
      <ClinicalWorkflowHeader
        title="Reminders"
        subtitle="Manage appointment alerts, medication schedules, and patient health guidance."
        action={headerAction || <ReminderProfileMenu doctorIdentity={doctorIdentity} />}
        className="doctor-dashboard-header doctor-reminder-header"
      />

      <div className="doctor-reminder-layout">
        <section className="doctor-reminder-card doctor-reminder-appointments-card clinical-workflow-card">
          <header className="doctor-reminder-card__header clinical-workflow-card-header">
            <span className="doctor-reminder-card__icon"><Icon icon="solar:calendar-mark-bold" /></span>
            <h2>Appointment Reminder</h2>
            <button type="button" onClick={() => setViewAllSection("appointments")}>View All</button>
          </header>
          <div className="doctor-reminder-toolbar">
            <div className="doctor-reminder-tabs clinical-workflow-tabs" aria-label="Appointment reminder filters">
              {["Today", "Tomorrow", "Upcoming"].map((filter) => (
                <button
                  className={appointmentReminderFilter === filter ? "is-active" : ""}
                  type="button"
                  key={filter}
                  onClick={() => setAppointmentReminderFilter(filter)}
                >
                  {filter}
                </button>
              ))}
            </div>
            <button className="doctor-reminder-primary-action clinical-workflow-primary-action" type="button" onClick={openReminderForm}>
              Set Reminder
            </button>
          </div>
          {appointmentRemindersMessage ? (
            <p className="doctor-reminder-message">
              {appointmentRemindersMessage}
            </p>
          ) : null}
          <div className="doctor-reminder-appointment-table clinical-workflow-table">
            <div className="doctor-reminder-appointment-head">
              <span>Patient</span>
              <span>Date</span>
              <span>Time</span>
              <span>Type</span>
              <span>Status</span>
              <span>Action</span>
            </div>
            {visibleAppointmentRows.length > 0 ? (
              visibleAppointmentRows.map((appointment) => {
                const reminder = remindersByAppointmentId[appointment.id];

                return (
                  <div className="doctor-reminder-appointment-row" key={appointment.id}>
                    <span className="doctor-reminder-patient-cell">
                      <span className="doctor-reminder-avatar-dot">{appointment.patientName.charAt(0).toUpperCase()}</span>
                      {appointment.patientName}
                    </span>
                    <span>{formatReminderDisplayDate(appointment.scheduleDate)}</span>
                    <span>{formatReminderDisplayTime(appointment.scheduleTime)}</span>
                    <span>{appointment.appointmentType}</span>
                    <mark>{getAppointmentReminderStatus(reminder)}</mark>
                    <span>
                      <button
                        className="doctor-reminder-row-action"
                        type="button"
                        onClick={() => handleSelectAppointmentForReminder(appointment)}
                      >
                        {reminder ? "Edit" : "Set"}
                      </button>
                    </span>
                  </div>
                );
              })
            ) : (
              <div className="doctor-reminder-appointment-empty">
                {isLoadingAppointments ? "Loading appointments..." : appointmentsMessage || "No saved appointments found."}
              </div>
            )}
          </div>
        </section>

        <section className="doctor-reminder-card doctor-health-tips-card clinical-workflow-card">
          <header className="doctor-reminder-card__header clinical-workflow-card-header">
            <span className="doctor-reminder-card__icon"><Icon icon="solar:lightbulb-bold" /></span>
            <h2>Health Tips</h2>
            <button type="button" onClick={openHealthTipsViewAll}>View All</button>
          </header>
          <div className="doctor-health-tips-panel">
            <div className="doctor-health-tip-tabs clinical-workflow-tabs" aria-label="Health tip filters">
              {healthTipCategories.map((tab) => (
                <button
                  className={healthTipFilter === tab ? "is-active" : ""}
                  type="button"
                  key={tab}
                  onClick={() => setHealthTipFilter(tab)}
                >
                  {tab}
                </button>
              ))}
            </div>
            <div className="doctor-health-tip-list">
              {visibleHealthTips.map((tip) => (
                <article key={tip.id}>
                  <span className="doctor-health-tip-logo">
                    {getHealthTipImage(tip) ? (
                      <img src={getHealthTipImage(tip)} alt="" aria-hidden="true" />
                    ) : (
                      <Icon icon={reminderTipIcons[tip.icon] || "solar:lightbulb-linear"} />
                    )}
                  </span>
                  <div>
                    <strong>{tip.title || tip.category}</strong>
                    <p>{tip.text}</p>
                  </div>
                </article>
              ))}
              {!isLoadingHealthTips && !healthTipsMessage && visibleHealthTips.length === 0 ? (
                <article className="doctor-health-tip-empty">
                  <span className="doctor-health-tip-logo"><Icon icon="solar:lightbulb-linear" /></span>
                  <p>No health tips available.</p>
                </article>
              ) : null}
            </div>
            {isLoadingHealthTips ? (
              <p className="doctor-reminder-message">Loading health tips...</p>
            ) : healthTipsMessage ? (
              <p className="doctor-reminder-message">{healthTipsMessage}</p>
            ) : null}
            <button className="doctor-reminder-outline-action" type="button" onClick={openHealthTipForm}>
              <Icon icon="ic:round-plus" />
              Add Health Tip
            </button>
          </div>
        </section>

        <section className="doctor-reminder-card doctor-medication-card clinical-workflow-card">
          <header className="doctor-reminder-card__header clinical-workflow-card-header">
            <span className="doctor-reminder-card__icon"><Icon icon="solar:calendar-mark-bold" /></span>
            <h2>Medication Reminder</h2>
            <button type="button" onClick={() => setViewAllSection("medications")}>View All</button>
          </header>
          <div className="doctor-reminder-toolbar doctor-medication-toolbar">
            <div className="doctor-reminder-tabs clinical-workflow-tabs" aria-label="Medication reminder filters">
              {["Today", "Tomorrow", "Upcoming"].map((filter) => (
                <button
                  className={medicationReminderFilter === filter ? "is-active" : ""}
                  type="button"
                  key={filter}
                  onClick={() => setMedicationReminderFilter(filter)}
                >
                  {filter}
                </button>
              ))}
            </div>
            <button className="doctor-reminder-primary-action clinical-workflow-primary-action" type="button" onClick={openMedicationForm}>
              Add Medication
            </button>
          </div>
          {medicationRemindersMessage ? (
            <p className="doctor-reminder-message">{medicationRemindersMessage}</p>
          ) : null}
          {medicationOccurrencesMessage ? (
            <p className="doctor-reminder-message">{medicationOccurrencesMessage}</p>
          ) : null}
          {medicationStatusMessage ? <p className="doctor-reminder-message">{medicationStatusMessage}</p> : null}
          <div className="doctor-medication-table clinical-workflow-table">
            <div className="doctor-medication-head">
              <span>Patient</span>
              <span>Medication</span>
              <span>Dosage</span>
              <span>Schedule</span>
              <span>Status</span>
              <span>Action</span>
            </div>
            {visibleMedicationRows.length > 0 ? visibleMedicationRows.map((reminder) => (
              <div className="doctor-medication-row" key={reminder.id || `${reminder.patientName}-${reminder.medication}`}>
                <span>{reminder.patientName || reminder.patient}</span>
                <span>{reminder.medication}</span>
                <span>{reminder.dosage}</span>
                <span>{reminder.schedule || `${formatReminderDisplayTime(reminder.scheduleTime)} daily`}</span>
                <mark className={`is-${reminder.statusClassName || getStatusClass(reminder.status)}`}>
                  {reminder.status}
                </mark>
                <span className="doctor-medication-actions">
                  <button
                    type="button"
                    title="Mark complete"
                    onClick={() => updateMedicationStatus(reminder.sourceReminderId || reminder.id, "Complete")}
                  >
                    <Icon icon="carbon:notification" />
                  </button>
                  <button
                    type="button"
                    title="Delete reminder"
                    onClick={() => deleteMedicationReminder(reminder.sourceReminderId || reminder.id)}
                  >
                    <Icon icon="charm:menu-kebab" />
                  </button>
                </span>
              </div>
            )) : (
              <div className="doctor-reminder-appointment-empty">
                {isLoadingMedicationReminders
                  ? "Loading medication reminders..."
                  : medicationRemindersMessage || "No medication reminders yet."}
              </div>
            )}
          </div>
        </section>
      </div>

      {viewAllSection ? createPortal(
        <div
          className="doctor-reminder-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="doctor-reminder-view-all-title"
          onClick={closeViewAll}
        >
          <section
            className="doctor-panel doctor-reminder-view-all"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="doctor-reminder-view-all__header">
              <div>
                <h2 id="doctor-reminder-view-all-title">
                  {viewAllSection === "appointments" ? "All Appointment Reminders" : viewAllSection === "medications" ? "All Medication Reminders" : "All Health Tips"}
                </h2>
                <p>
                  {viewAllSection === "appointments"
                    ? `${reminderTargetAppointments.length} appointment${reminderTargetAppointments.length === 1 ? "" : "s"}`
                    : viewAllSection === "medications"
                      ? `${allMedicationRows.length} medication schedule row${allMedicationRows.length === 1 ? "" : "s"}`
                      : `${managedHealthTips.length} ${healthTipManagementFilter.toLowerCase()} health tip${managedHealthTips.length === 1 ? "" : "s"} (${databaseHealthTips.length} total)`}
                </p>
              </div>
              <button type="button" aria-label="Close view all" onClick={closeViewAll}>&times;</button>
            </header>

            {viewAllSection === "appointments" ? (
              <div className="doctor-reminder-view-all__content doctor-reminder-view-all__appointments">
                <div className="doctor-reminder-appointment-table">
                  <div className="doctor-reminder-appointment-head">
                    <span>Patient</span>
                    <span>Date</span>
                    <span>Time</span>
                    <span>Type</span>
                    <span>Status</span>
                    <span>Action</span>
                  </div>
                  {reminderTargetAppointments.length > 0 ? (
                    reminderTargetAppointments.map((appointment) => {
                      const reminder = remindersByAppointmentId[appointment.id];

                      return (
                        <div className="doctor-reminder-appointment-row" key={appointment.id}>
                          <span className="doctor-reminder-patient-cell">
                            <span className="doctor-reminder-avatar-dot">
                              {(appointment.patientName || "P").charAt(0).toUpperCase()}
                            </span>
                            {appointment.patientName || "Patient"}
                          </span>
                          <span>{formatReminderDisplayDate(appointment.scheduleDate)}</span>
                          <span>{formatReminderDisplayTime(appointment.scheduleTime)}</span>
                          <span>{appointment.appointmentType}</span>
                          <mark>{getAppointmentReminderStatus(reminder)}</mark>
                          <span>
                            <button
                              className="doctor-reminder-row-action"
                              type="button"
                              onClick={() => {
                                closeViewAll();
                                handleSelectAppointmentForReminder(appointment);
                              }}
                            >
                              {reminder ? "Edit" : "Set"}
                            </button>
                          </span>
                        </div>
                      );
                    })
                  ) : (
                    <div className="doctor-reminder-appointment-empty">
                      {isLoadingAppointments
                        ? "Loading appointments..."
                        : appointmentsMessage || "No saved appointments found."}
                    </div>
                  )}
                </div>
              </div>
            ) : viewAllSection === "medications" ? (
              <div className="doctor-reminder-view-all__content doctor-reminder-view-all__medications">
                <div className="doctor-medication-table">
                  <div className="doctor-medication-head">
                    <span>Patient</span>
                    <span>Medication</span>
                    <span>Dosage</span>
                    <span>Schedule</span>
                    <span>Status</span>
                    <span>Action</span>
                  </div>
                  {allMedicationRows.length > 0 ? allMedicationRows.map((reminder) => (
                    <div className="doctor-medication-row" key={reminder.id || `${reminder.patientName}-${reminder.medication}-all`}>
                      <span>{reminder.patientName || reminder.patient}</span>
                      <span>{reminder.medication}</span>
                      <span>{reminder.dosage}</span>
                      <span>{reminder.schedule || `${formatReminderDisplayTime(reminder.scheduleTime)} daily`}</span>
                      <mark className={`is-${reminder.statusClassName || getStatusClass(reminder.status)}`}>
                        {reminder.status}
                      </mark>
                      <span className="doctor-medication-actions">
                        <button
                          type="button"
                          title="Mark complete"
                          onClick={() => updateMedicationStatus(reminder.sourceReminderId || reminder.id, "Complete")}
                        >
                          <Icon icon="carbon:notification" />
                        </button>
                        <button
                          type="button"
                          title="Delete reminder"
                          onClick={() => deleteMedicationReminder(reminder.sourceReminderId || reminder.id)}
                        >
                          <Icon icon="charm:menu-kebab" />
                        </button>
                      </span>
                    </div>
                  )) : (
                    <div className="doctor-reminder-appointment-empty">
                      {isLoadingMedicationReminders
                        ? "Loading medication reminders..."
                        : medicationRemindersMessage || "No medication reminders yet."}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div
                className="doctor-reminder-view-all__content doctor-reminder-view-all__tips"
                onScroll={() => setHealthTipActionMenu(null)}
              >
                <div className="doctor-health-tip-management-tabs" aria-label="Health tip status filters">
                  {healthTipManagementFilters.map((filter) => (
                    <button
                      key={filter}
                      type="button"
                      className={healthTipManagementFilter === filter ? "is-active" : ""}
                      onClick={() => {
                        setHealthTipActionMenu(null);
                        setHealthTipManagementFilter(filter);
                      }}
                    >
                      {filter}
                    </button>
                  ))}
                </div>

                {healthTipsMessage ? (
                  <p className="doctor-reminder-message doctor-health-tip-management-message">
                    {healthTipsMessage}
                  </p>
                ) : null}

                {managedHealthTips.length > 0 ? (
                  managedHealthTips.map((tip) => (
                    <article className="doctor-health-tip-management-card" key={tip.id}>
                      <span className="doctor-health-tip-logo">
                        {getHealthTipImage(tip) ? (
                          <img src={getHealthTipImage(tip)} alt="" aria-hidden="true" />
                        ) : (
                          <Icon icon={reminderTipIcons[tip.icon] || "solar:lightbulb-linear"} />
                        )}
                      </span>
                      <div className="doctor-health-tip-management-copy">
                        <strong>{tip.title || tip.category}</strong>
                        <small>
                          {tip.category}
                          {tip.isActive === false ? " · Archived" : ""}
                        </small>
                        <p>{tip.text}</p>
                      </div>
                      <button
                        className="doctor-health-tip-menu-button"
                        type="button"
                        aria-label={`Manage ${tip.title || tip.category} health tip`}
                        aria-haspopup="menu"
                        aria-expanded={healthTipActionMenu?.tipId === tip.id}
                        onClick={(event) => openHealthTipActionMenu(tip, event)}
                      >
                        <Icon icon="charm:menu-kebab" aria-hidden="true" />
                      </button>
                    </article>
                  ))
                ) : !healthTipsMessage ? (
                  <div className="doctor-reminder-view-all__empty">
                    {isLoadingHealthTips
                      ? "Loading health tips..."
                      : "No health tips found for this filter."}
                  </div>
                ) : null}
              </div>
            )}
          </section>
        </div>,
        document.body
      ) : null}

      {activeHealthTipMenuTip && healthTipActionMenu ? createPortal(
        <div
          className="doctor-health-tip-action-menu"
          role="menu"
          style={{
            top: `${healthTipActionMenu.top}px`,
            left: `${healthTipActionMenu.left}px`,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => handleHealthTipAction(activeHealthTipMenuTip, "edit")}
          >
            Edit
          </button>
          {activeHealthTipMenuTip.isActive === false ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => handleHealthTipAction(activeHealthTipMenuTip, "restore")}
            >
              Restore
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => handleHealthTipAction(activeHealthTipMenuTip, "archive")}
            >
              Archive
            </button>
          )}
          <button
            className="is-danger"
            type="button"
            role="menuitem"
            onClick={() => handleHealthTipAction(activeHealthTipMenuTip, "delete")}
          >
            Delete
          </button>
        </div>,
        document.body
      ) : null}

      {deleteHealthTipTarget ? createPortal(
        <div
          className="doctor-reminder-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="doctor-health-tip-delete-title"
          onClick={() => {
            if (!isDeletingHealthTip) setDeleteHealthTipTarget(null);
          }}
        >
          <section
            className="doctor-panel doctor-health-tip-delete-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="doctor-health-tip-delete-title">Delete Health Tip?</h2>
            <p>This permanently deletes the health tip. This action cannot be undone.</p>
            <div>
              <button
                type="button"
                onClick={() => setDeleteHealthTipTarget(null)}
                disabled={isDeletingHealthTip}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={deleteHealthTip}
                disabled={isDeletingHealthTip}
              >
                {isDeletingHealthTip ? "Deleting..." : "Delete Permanently"}
              </button>
            </div>
          </section>
        </div>,
        document.body
      ) : null}

      {isReminderFormOpen ? createPortal(
        <div className="doctor-reminder-modal clinical-workflow-backdrop" role="dialog" aria-modal="true" aria-labelledby="doctor-reminder-form-title" onClick={closeReminderForm}>
          <form className="doctor-panel doctor-reminder-dialog doctor-reminder-form doctor-reminder-form--appointment clinical-workflow-dialog" onSubmit={handleSubmit} onClick={(event) => event.stopPropagation()}>
            <header className="doctor-reminder-dialog__header doctor-reminder-form__title">
              <div className="doctor-reminder-dialog__headline">
                <span className="doctor-reminder-dialog__icon" aria-hidden="true">
                  <Icon icon="solar:alarm-bold-duotone" />
                </span>
                <div>
                  <h2 id="doctor-reminder-form-title">
                    {isBulkReminderMode
                      ? "Set Appointment Reminders"
                      : remindersByAppointmentId[form.appointmentId]
                      ? "Edit Reminder"
                      : "Set Reminder"}
                  </h2>
                  <p>
                    {isBulkReminderMode
                      ? "Choose appointments, then apply one relative reminder rule to each schedule."
                      : "Select one appointment, then choose when that Patient should be notified."}
                  </p>
                </div>
              </div>
              <button className="doctor-reminder-modal-close" type="button" aria-label="Close reminder form" onClick={closeReminderForm}>
                <Icon icon="material-symbols:close-rounded" />
              </button>
            </header>

            <div className="doctor-reminder-dialog__body doctor-reminder-form__body">

            <section className="doctor-reminder-target-block" aria-label="Reminder target">
              <div className="doctor-reminder-preference-heading">
                <strong>Reminder Target</strong>
                <span>
                  {isBulkReminderMode
                    ? "Select eligible appointments without configured reminders."
                    : "Select exactly one Patient appointment."}
                </span>
              </div>

              {reminderFormSource === "global" ? (
                <div className="doctor-reminder-target-modes" role="radiogroup" aria-label="Reminder target mode">
                  {[
                    {
                      value: "single",
                      title: "One Appointment",
                      description: "Choose one Patient schedule.",
                    },
                    {
                      value: "multiple",
                      title: "Multiple Appointments",
                      description: "Select several eligible schedules.",
                    },
                    {
                      value: "all_without",
                      title: "All Missing Reminders",
                      description: "Apply a reminder to every eligible upcoming appointment without one.",
                    },
                  ].map(({ value, title, description }) => (
                    <label className="doctor-reminder-target-mode" key={value}>
                      <input
                        className="doctor-reminder-target-mode-radio"
                        type="radio"
                        name="reminderTargetMode"
                        value={value}
                        checked={reminderTargetMode === value}
                        disabled={isSavingReminder}
                        onChange={() => handleReminderTargetModeChange(value)}
                      />
                      <span className="doctor-reminder-target-mode-copy">
                        <strong>{title}</strong>
                        <small>{description}</small>
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}

              {reminderTargetMode === "single" ? (
                <>
                  <label className="doctor-reminder-target-field">
                    <span>Patient / Appointment <b>*</b></span>
                    <select
                      value={form.appointmentId}
                      onChange={handleReminderAppointmentChange}
                      disabled={isLoadingAppointments || isSavingReminder}
                      required
                    >
                      <option value="">Select an appointment...</option>
                      {reminderTargetAppointments.map((appointment) => (
                        <option key={appointment.id} value={appointment.id}>
                          {appointment.patientName} — {appointment.appointmentType} —{" "}
                          {formatReminderDisplayDate(appointment.scheduleDate)}{" "}
                          {formatReminderDisplayTime(appointment.scheduleTime)}
                        </option>
                      ))}
                    </select>
                  </label>

                  {selectedReminderAppointment ? (
                    <div className="doctor-reminder-target-summary">
                      <div>
                        <span>Patient</span>
                        <strong>{selectedReminderAppointment.patientName}</strong>
                      </div>
                      <div>
                        <span>Appointment</span>
                        <strong>{selectedReminderAppointment.appointmentType}</strong>
                      </div>
                      <div>
                        <span>Schedule</span>
                        <strong>
                          {formatReminderDisplayDate(selectedReminderAppointment.scheduleDate)}{" "}
                          {formatReminderDisplayTime(selectedReminderAppointment.scheduleTime)}
                        </strong>
                      </div>
                      <div>
                        <span>Reminder</span>
                        <strong>
                          {remindersByAppointmentId[selectedReminderAppointment.id]
                            ? "Existing reminder"
                            : "New reminder"}
                        </strong>
                      </div>
                    </div>
                  ) : (
                    <p className="doctor-reminder-target-hint">
                      Choose the Patient appointment that should receive this reminder.
                    </p>
                  )}
                </>
              ) : (
                <div className="doctor-reminder-bulk-targets">
                  {reminderTargetMode === "multiple" ? (
                    <div className="doctor-reminder-bulk-toolbar">
                      <label className="doctor-reminder-bulk-select-all">
                        <input
                          type="checkbox"
                          checked={allBulkAppointmentsSelected}
                          disabled={!bulkSelectableAppointments.length || isSavingReminder}
                          onChange={toggleAllBulkAppointments}
                        />
                        <span>
                          <strong>Select all eligible</strong>
                          <small>Only appointments without a configured reminder.</small>
                        </span>
                      </label>
                      <span className="doctor-reminder-bulk-selected-count">
                        {selectedBulkAppointments.length} selected
                      </span>
                    </div>
                  ) : (
                    <p className="doctor-reminder-bulk-count">
                      <strong>{selectedBulkAppointments.length}</strong>{" "}
                      appointment{selectedBulkAppointments.length === 1 ? "" : "s"} will receive a reminder.
                    </p>
                  )}

                  <div className="doctor-reminder-bulk-list">
                    {(reminderTargetMode === "all_without"
                      ? bulkSelectableAppointments
                      : reminderTargetAppointments
                    ).map((appointment) => {
                      const existingReminder = remindersByAppointmentId[appointment.id];
                      const disabled = Boolean(existingReminder) || reminderTargetMode === "all_without";
                      const checked = reminderTargetMode === "all_without"
                        ? true
                        : selectedAppointmentIds.includes(appointment.id);

                      return (
                        <label
                          className={`doctor-reminder-bulk-row ${existingReminder ? "is-disabled" : ""}`}
                          key={appointment.id}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled || isSavingReminder}
                            onChange={() => toggleBulkAppointment(appointment.id)}
                          />
                          <span className="doctor-reminder-bulk-copy">
                            <strong>{appointment.patientName}</strong>
                            <span>{appointment.appointmentType}</span>
                            <small>
                              {formatReminderDisplayDate(appointment.scheduleDate)} •{" "}
                              {formatReminderDisplayTime(appointment.scheduleTime)}
                            </small>
                          </span>
                          <em className={existingReminder ? "has-reminder" : "not-set"}>
                            {existingReminder
                              ? getAppointmentReminderStatus(existingReminder).toUpperCase()
                              : "NOT SET"}
                          </em>
                        </label>
                      );
                    })}
                  </div>

                  {!bulkSelectableAppointments.length ? (
                    <p className="doctor-reminder-target-hint">
                      Every eligible upcoming appointment already has a configured reminder.
                    </p>
                  ) : null}
                </div>
              )}
            </section>

            <div className="doctor-reminder-preference-block">
              <div className="doctor-reminder-preference-heading">
                <strong>Reminder Time</strong>
                <span>When should the reminder trigger?</span>
              </div>
              <div className="doctor-reminder-option-grid">
                {[
                  ["1hour", "1 hour", "before"],
                  ["1day", "1 day", "before"],
                  ["3days", "3 days", "before"],
                  ["3weeks", "3 weeks", "before"],
                  ["custom", "Custom", ""],
                ].map(([value, label, helper]) => (
                  <label
                    className={`doctor-reminder-option ${value === "custom" && isBulkReminderMode ? "is-disabled" : ""}`}
                    key={value}
                  >
                    <input
                      className={value === "custom" ? "doctor-reminder-option-radio-hidden" : ""}
                      type="radio"
                      name="reminderLeadTime"
                      value={value}
                      checked={form.reminderLeadTime === value}
                      disabled={value === "custom" && isBulkReminderMode}
                      onChange={handleChange}
                    />
                    {value === "custom" ? (
                      <Icon className="doctor-reminder-option-custom-icon" icon="solar:calendar-linear" />
                    ) : null}
                    <span>{label}</span>
                    {helper ? <small>{helper}</small> : null}
                  </label>
                ))}
              </div>
              {isBulkReminderMode ? (
                <p className="doctor-reminder-target-hint">
                  Custom date/time is available for individual reminders only.
                </p>
              ) : null}
              {form.reminderLeadTime === "custom" ? (
                <input
                  className="doctor-reminder-custom-time"
                  name="customNotifyAt"
                  type="datetime-local"
                  value={form.customNotifyAt}
                  onChange={handleChange}
                />
              ) : null}
            </div>

            <div className="doctor-reminder-preference-block">
              <div className="doctor-reminder-preference-heading doctor-reminder-preference-heading--inline">
                <strong>Repeat Reminder?</strong>
                <span>(Optional)</span>
              </div>
              <div className="doctor-reminder-repeat-options" role="radiogroup" aria-label="Repeat reminder frequency">
                {[
                  ["none", "No repeat"],
                  ["daily", "Daily"],
                  ["hourly", "Every Hour"],
                ].map(([value, label]) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="repeatReminder"
                      value={value}
                      checked={form.repeatReminder === value}
                      onChange={handleChange}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="doctor-reminder-preference-block">
              <div className="doctor-reminder-preference-heading doctor-reminder-preference-heading--inline">
                <strong>Message Preview</strong>
                <span>(Optional)</span>
              </div>
              <label className="doctor-reminder-message-input">
                <input
                  name="message"
                  type="text"
                  placeholder="Optional custom message"
                  value={form.message}
                  onChange={handleChange}
                />
              </label>
              <div className="doctor-reminder-preview">
                <span aria-hidden="true">“</span>
                {form.message.trim() ? (
                  <p>{form.message.trim()}</p>
                ) : isBulkReminderMode && selectedBulkAppointments.length ? (
                  <p>
                    Each of the <strong className="doctor-reminder-preview-accent">
                      {selectedBulkAppointments.length} selected appointments
                    </strong>{" "}
                    will receive its own appointment-specific reminder message and relative trigger time.
                  </p>
                ) : reminderPreviewDetails ? (
                  <p>
                    Reminder: <strong className="doctor-reminder-preview-accent">{reminderPreviewDetails.patient}</strong>{" "}
                    has <strong className="doctor-reminder-preview-accent">{reminderPreviewDetails.type}</strong>{" "}
                    scheduled on{" "}
                    <strong className="doctor-reminder-preview-accent">{reminderPreviewDetails.date}</strong>{" "}
                    at <strong className="doctor-reminder-preview-accent">{reminderPreviewDetails.time}</strong>.
                  </p>
                ) : (
                  <p>Select a patient, date, and time to preview this reminder.</p>
                )}
              </div>
            </div>

              {statusMessage ? <p className="doctor-reminder-message">{statusMessage}</p> : null}
            </div>

            <footer className="doctor-reminder-dialog__actions doctor-reminder-form__actions">
              <button type="button" onClick={closeReminderForm}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  (isBulkReminderMode
                    ? selectedBulkAppointments.length === 0
                    : !form.appointmentId) ||
                  isSavingReminder ||
                  doctorIdentity?.loading ||
                  Boolean(doctorIdentity?.error)
                }
              >
                {isSavingReminder
                  ? "Saving..."
                  : isBulkReminderMode
                    ? `Save ${selectedBulkAppointments.length} Reminder${selectedBulkAppointments.length === 1 ? "" : "s"}`
                    : "Save Reminder"}
              </button>
            </footer>
          </form>
        </div>,
        document.body
      ) : null}

      {isMedicationFormOpen ? createPortal(
        <div className="doctor-reminder-modal clinical-workflow-backdrop" role="dialog" aria-modal="true" aria-labelledby="doctor-medication-form-title" onClick={closeMedicationForm}>
          <form className="doctor-panel doctor-reminder-dialog doctor-medication-reminder-form clinical-workflow-dialog clinical-workflow-dialog--medication" data-time-picker-boundary onSubmit={addMedicationReminder} onClick={(event) => event.stopPropagation()}>
            <header className="doctor-reminder-dialog__header doctor-medication-reminder-form__title">
              <div className="doctor-reminder-dialog__headline">
                <span className="doctor-reminder-dialog__icon" aria-hidden="true">
                  <Icon icon="solar:pills-3-bold-duotone" />
                </span>
                <div>
                  <h2 id="doctor-medication-form-title">Add Medication Reminder</h2>
                  <p>Add the prescription details and the Patient's medication schedule.</p>
                </div>
              </div>
              <button
                className="doctor-medication-reminder-close"
                type="button"
                aria-label="Close medication reminder form"
                onClick={closeMedicationForm}
              >
                <Icon icon="material-symbols:close-rounded" />
              </button>
            </header>

            <div className="doctor-reminder-dialog__body doctor-medication-reminder-form__body">

            <section className="doctor-medication-reminder-section">
              <h3>Patient Information</h3>
              <label className="doctor-medication-reminder-field doctor-medication-reminder-field--patient doctor-patient-search">
                <span>Patient <b>*</b></span>
                <input
                  type="text"
                  placeholder="Search Patient by name or ID"
                  value={medicationPatientSearch}
                  onChange={(event) => {
                    setMedicationPatientSearch(event.target.value);
                    setMedicationForm((current) => ({
                      ...current,
                      patientId: "",
                      patientName: "",
                    }));
                  }}
                />
                {isSearchingMedicationPatients ? <span className="doctor-patient-search__hint">Searching...</span> : null}
                {medicationPatientSearchMessage ? <span className="doctor-patient-search__hint">{medicationPatientSearchMessage}</span> : null}
                {medicationPatientResults.length > 0 ? (
                  <div className="doctor-patient-results">
                    {medicationPatientResults.map((patient) => (
                      <button type="button" key={patient.id} onClick={() => handleSelectMedicationPatient(patient)}>
                        <strong>{patient.full_name}</strong>
                        <span>{patient.contact_number || "No contact number"}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </label>
            </section>

            <section className="doctor-medication-reminder-section">
              <h3>Medication Details</h3>
              <div className="doctor-medication-reminder-grid">
                <label className="doctor-medication-reminder-field">
                  <span>RX / Prescription Reference<b>*</b></span>
                  <input
                    name="prescriptionReference"
                    type="text"
                    placeholder="Enter RX number or prescription reference"
                    value={medicationForm.prescriptionReference}
                    onChange={handleMedicationChange}
                  />
                </label>

                <label className="doctor-medication-reminder-field">
                  <span>Medication Name<b>*</b></span>
                  <input
                    name="medication"
                    type="text"
                    placeholder="Enter Medication Name"
                    value={medicationForm.medication}
                    onChange={handleMedicationChange}
                  />
                </label>

                <label className="doctor-medication-reminder-field">
                  <span>Dosage<b>*</b></span>
                  <select name="dosage" value={medicationForm.dosage} onChange={handleMedicationChange}>
                    <option value="">e.g., 1 tablet, 5ml</option>
                    <option>1 tablet</option>
                    <option>2 tablets</option>
                    <option>5 ml</option>
                    <option>10 ml</option>
                    <option>As prescribed</option>
                  </select>
                </label>

                <label className="doctor-medication-reminder-field">
                  <span>Frequency<b>*</b></span>
                  <select name="frequency" value={medicationForm.frequency} onChange={handleMedicationChange}>
                    <option value="">Select Frequency</option>
                    <option>Once daily</option>
                    <option>Twice daily</option>
                    <option>Every morning</option>
                    <option>Every night</option>
                    <option>As prescribed</option>
                  </select>
                </label>

                <label className="doctor-medication-reminder-field">
                  <span>Duration<b>*</b></span>
                  <select name="duration" value={medicationForm.duration} onChange={handleMedicationChange}>
                    <option value="">Select Duration</option>
                    <option>3 days</option>
                    <option>7 days</option>
                    <option>14 days</option>
                    <option>30 days</option>
                    <option>Until finished</option>
                  </select>
                </label>
              </div>
            </section>

            <section className="doctor-medication-reminder-section">
              <h3>Schedule</h3>
              <div className="doctor-medication-reminder-grid doctor-medication-reminder-grid--schedule">
                <label className="doctor-medication-reminder-field">
                  <span>Start Date<b>*</b></span>
                  <input
                    name="scheduleDate"
                    type="text"
                    placeholder="dd/mm/yyyy"
                    value={medicationForm.scheduleDate}
                    onFocus={(event) => {
                      event.target.type = "date";
                    }}
                    onBlur={(event) => {
                      if (!event.target.value) {
                        event.target.type = "text";
                      }
                    }}
                    onChange={handleMedicationChange}
                  />
                </label>

                <div className="doctor-medication-reminder-field doctor-medication-reminder-times">
                  <span id="doctor-medication-reminder-time-label">Time(s)<b>*</b></span>
                  <div className="doctor-medication-reminder-time-row">
                    <div className="doctor-medication-reminder-time-chips">
                      {medicationForm.scheduleTimes.map((timeValue, timeIndex) => (
                        <span className="doctor-medication-reminder-time-chip" key={`${timeValue}-${timeIndex}`}>
                          {formatMedicationReminderTime(timeValue)}
                          <button type="button" aria-label={`Remove ${formatMedicationReminderTime(timeValue)}`} onClick={() => removeMedicationTime(timeIndex)}>
                            &times;
                          </button>
                        </span>
                      ))}
                    </div>
                    <div className="doctor-medication-reminder-time-picker-control">
                      <AppointmentTimePicker
                        ref={medicationTimePickerRef}
                        id="doctor-medication-reminder-time"
                        label="Medication reminder time"
                        labelId="doctor-medication-reminder-time-label"
                        value={medicationForm.scheduleTime}
                        onChange={handleMedicationTimeChange}
                        className="doctor-medication-reminder-time-picker"
                        required
                      />
                    </div>
                    <button
                      className="doctor-medication-reminder-confirm-time"
                      type="button"
                      onClick={handleAddScheduleTime}
                    >
                      Add
                    </button>
                  </div>
                </div>
              </div>
            </section>

            <section className="doctor-medication-reminder-section doctor-medication-reminder-section--notes">
              <h3>
                Additional Notes
                <span>(Optional)</span>
              </h3>
              <textarea
                name="message"
                placeholder="Add special instructions or notes for the Patient"
                value={medicationForm.message}
                onChange={handleMedicationChange}
              />
            </section>

              {medicationStatusMessage ? <p className="doctor-reminder-message">{medicationStatusMessage}</p> : null}
            </div>

            <footer className="doctor-reminder-dialog__actions doctor-medication-reminder-actions">
              <button
                type="button"
                onClick={closeMedicationForm}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  isSavingMedicationReminder ||
                  doctorIdentity?.loading ||
                  Boolean(doctorIdentity?.error)
                }
              >
                {isSavingMedicationReminder ? "Saving..." : "Save Reminder"}
              </button>
            </footer>
          </form>
        </div>,
        document.body
      ) : null}

      {isHealthTipFormOpen ? createPortal(
        <div className="doctor-reminder-modal clinical-workflow-backdrop" role="dialog" aria-modal="true" aria-labelledby="doctor-health-tip-form-title" onClick={closeHealthTipForm}>
          <form className="doctor-panel doctor-reminder-dialog doctor-health-tip-form doctor-health-tip-form--detailed clinical-workflow-dialog clinical-workflow-dialog--health-tip" onSubmit={saveHealthTip} onClick={(event) => event.stopPropagation()}>
            <header className="doctor-reminder-dialog__header doctor-health-tip-form__title">
              <div className="doctor-reminder-dialog__headline doctor-health-tip-form__headline">
                <span className="doctor-reminder-dialog__icon doctor-health-tip-form__icon" aria-hidden="true">
                  <Icon icon="solar:sun-2-bold" />
                </span>
                <div>
                  <h2 id="doctor-health-tip-form-title">
                    {healthTipFormMode === "edit" ? "Edit Health Tip" : "Add Health Tip"}
                  </h2>
                  <p>
                    {healthTipFormMode === "edit"
                      ? "Update this patient-facing health tip."
                      : "Create a helpful health tip for your patients."}
                  </p>
                </div>
              </div>
              <button className="doctor-health-tip-form__close" type="button" aria-label="Close health tip form" onClick={closeHealthTipForm}>
                <Icon icon="material-symbols:close-rounded" />
              </button>
            </header>

            <div className="doctor-reminder-dialog__body doctor-health-tip-form__body">

            <label className="doctor-health-tip-form__field doctor-health-tip-form__field--category">
              <span>Tip Category<b>*</b></span>
              <select name="category" value={healthTipForm.category} onChange={handleHealthTipChange} required>
                {healthTipCategories.filter((category) => category !== "All").map((category) => (
                  <option key={category}>{category}</option>
                ))}
              </select>
              {healthTipFormErrors.category ? (
                <small className="doctor-health-tip-form__error">{healthTipFormErrors.category}</small>
              ) : null}
            </label>

            <label className="doctor-health-tip-form__field doctor-health-tip-form__field--wide">
              <span>Title<b>*</b></span>
              <div className="doctor-health-tip-form__counted-control">
                <input
                  name="title"
                  type="text"
                  maxLength={100}
                  required
                  placeholder="Enter a short title for the tip..."
                  value={healthTipForm.title}
                  onChange={handleHealthTipChange}
                />
                <small>{healthTipForm.title.length}/100</small>
              </div>
              {healthTipFormErrors.title ? (
                <small className="doctor-health-tip-form__error">{healthTipFormErrors.title}</small>
              ) : null}
            </label>

            <label className="doctor-health-tip-form__field doctor-health-tip-form__field--wide">
              <span>Message<b>*</b></span>
              <div className="doctor-health-tip-form__counted-control doctor-health-tip-form__counted-control--textarea">
                <textarea
                  name="text"
                  maxLength={500}
                  required
                  placeholder="Enter the health tips details..."
                  value={healthTipForm.text}
                  onChange={handleHealthTipChange}
                />
                <small>{healthTipForm.text.length}/500</small>
              </div>
              {healthTipFormErrors.text ? (
                <small className="doctor-health-tip-form__error">{healthTipFormErrors.text}</small>
              ) : null}
            </label>

            <label className="doctor-health-tip-form__field doctor-health-tip-form__field--category">
              <span>Display Schedule<b>*</b></span>
              <select name="displaySchedule" value={healthTipForm.displaySchedule} onChange={handleHealthTipChange} required>
                <option>Daily</option>
                <option>Weekly</option>
                <option>Every appointment</option>
                <option>Pregnancy milestone</option>
              </select>
            </label>

            </div>

            <footer className="doctor-reminder-dialog__actions doctor-health-tip-form__actions">
              <button type="button" onClick={closeHealthTipForm}>Cancel</button>
              <button
                type="submit"
                disabled={
                  isSavingHealthTip ||
                  doctorIdentity?.loading ||
                  Boolean(doctorIdentity?.error)
                }
              >
                <Icon icon="solar:download-minimalistic-outline" />
                {isSavingHealthTip
                  ? "Saving..."
                  : healthTipFormMode === "edit"
                    ? "Save Changes"
                    : "Add Health Tip"}
              </button>
            </footer>
          </form>
        </div>,
        document.body
      ) : null}
    </section>
  );
}

export default DoctorReminderContent;
