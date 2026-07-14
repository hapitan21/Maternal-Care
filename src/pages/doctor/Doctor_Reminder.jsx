import React from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";

import { supabase } from "../../lib/supabaseClient";
import "../../styles/doctor-reminder.css";

const scheduleTableName = "schedule";
const remindersTableName = "reminders";
const medicationRemindersTableName = "medication_reminders";
const healthTipsTableName = "health_tips";
const healthTipCategories = ["All", "Nutrition", "Exercise"];
const defaultHealthTips = [
  {
    id: "hydration",
    category: "Nutrition",
    icon: "hydration",
    image: "",
    title: "Hydration",
    text: "Drink atleast 8 glasses of water daily.",
  },
  {
    id: "vitamins",
    category: "Nutrition",
    icon: "vitamins",
    image: "",
    title: "Vitamins",
    text: "Never skip prenatal vitamins.",
  },
  {
    id: "rest",
    category: "Exercise",
    icon: "rest",
    image: "/images/sleep.png",
    title: "Rest",
    text: "Get enough sleep during pregnancy.",
  },
];

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
  const date = new Date();
  date.setDate(date.getDate() + offset);

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

function getReminderDisplayStatus(status, remindAt) {
  const normalizedStatus = String(status || "pending").toLowerCase();

  if (normalizedStatus === "sent") return "Sent";
  if (normalizedStatus === "completed") return "Completed";
  if (normalizedStatus === "cancelled") return "Cancelled";

  const remindTime = remindAt ? new Date(remindAt).getTime() : Number.NaN;

  if (Number.isFinite(remindTime) && remindTime <= Date.now()) {
    return "Sent";
  }

  return "Pending";
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
    status: getReminderDisplayStatus(row.status, row.remind_at),
    databaseStatus: row.status,
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
    type: "medicationReminder",
    patientId: row.patient_id || patient?.id || "",
    patientName: patient?.full_name || "Patient",
    medication: row.medication_name || "Medication",
    dosage: row.dosage || "",
    frequency: row.frequency || "As prescribed",
    scheduleDate: row.start_date || "",
    scheduleTime: primaryTime,
    scheduleTimes: reminderTimes,
    duration: row.duration || getMedicationDuration(row.start_date, row.end_date),
    reminderTiming: "medication",
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
      .from("patients")
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
    .from("patients")
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
    publishedAt: tip.published_at || tip.created_at || "",
  };
}

function mapHealthTipDatabaseRow(row) {
  return normalizeHealthTip(row);
}

function mergeHealthTipsWithDefaults(databaseTips) {
  return [...databaseTips, ...defaultHealthTips].filter(
    (tip, index, source) =>
      source.findIndex(
        (item) =>
          String(item.id || "") === String(tip.id || "") ||
          (String(item.title || "").trim().toLowerCase() ===
            String(tip.title || "").trim().toLowerCase() &&
            String(item.text || "").trim().toLowerCase() ===
              String(tip.text || "").trim().toLowerCase())
      ) === index
  );
}

function getReminderDateTime(scheduleDate) {
  const reminderDate = new Date(`${scheduleDate}T08:00:00`);
  reminderDate.setDate(reminderDate.getDate() - 1);
  return reminderDate.toISOString();
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
  const scheduleDateValue = appointment?.scheduleDate || getLocalDateKey(1);
  const scheduleTimeValue = appointment?.scheduleTime || "08:00";
  const appointmentDate = new Date(`${scheduleDateValue}T${scheduleTimeValue}`);

  if (Number.isNaN(appointmentDate.getTime())) {
    return `Reminder: ${appointment?.patientName || "Patient"} has ${appointment?.appointmentType || "an appointment"} scheduled on ${scheduleDateValue} at ${scheduleTimeValue}.`;
  }

  const appointmentDateLabel = appointmentDate.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const appointmentTimeLabel = appointmentDate.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  return `Reminder: ${appointment?.patientName || "Patient"} has ${appointment?.appointmentType || "an appointment"} scheduled on ${appointmentDateLabel} at ${appointmentTimeLabel}.`;
}

function getScheduleEndDateTime(scheduleDate, scheduleTime) {
  const endDate = new Date(`${scheduleDate}T${scheduleTime || "08:00"}`);
  endDate.setHours(endDate.getHours() + 1);
  return endDate.toISOString();
}

function toDateKey(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toTimeKey(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function mapScheduleAppointment(row) {
  return {
    id: row.id,
    patientId: row.patientRecordId || row.patient_id || "",
    patientName: row.patient_name || "Patient",
    appointmentType: row.title || "Appointment",
    doctorName: row.doctor_name || "Healthcare provider",
    scheduleDate: toDateKey(row.start_time),
    scheduleTime: toTimeKey(row.start_time),
    scheduleAt: row.start_time,
  };
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


function DoctorIcon({ name }) {
  const icons = {
    logo: (
      <>
        <path d="M12 3.5c-4.1 0-7.4 3.3-7.4 7.4 0 5.5 5.7 9.5 6.5 10 .5.4 1.3.4 1.8 0 .8-.5 6.5-4.5 6.5-10 0-4.1-3.3-7.4-7.4-7.4Z" />
        <path d="M9.7 11.5h4.6M12 9.2v4.6" />
      </>
    ),
    home: <path d="M4 10.5 12 4l8 6.5V20h-5v-5.5h-6V20H4v-9.5Z" />,
    calendar: (
      <>
        <rect x="4.5" y="6.5" width="15" height="13.5" rx="2" />
        <path d="M8 4v4M16 4v4M4.5 10.5h15" />
      </>
    ),
    calendarCheck: (
      <>
        <rect x="4.5" y="6.5" width="15" height="13.5" rx="2" />
        <path d="M8 4v4M16 4v4M4.5 10.5h15" />
        <path d="m9 15 2 2 4-4" />
      </>
    ),
    records: (
      <>
        <path d="M7 3.5h7l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V5A1.5 1.5 0 0 1 7.5 3.5Z" />
        <path d="M14 3.5v5h5M9 13h6M9 17h4" />
      </>
    ),
    profile: (
      <>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 20a7 7 0 0 1 14 0" />
      </>
    ),
    mail: (
      <>
        <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
        <path d="m4.5 7 7.5 6 7.5-6" />
      </>
    ),
    phone: (
      <>
        <path d="M7.5 4.5 10 7l-1.6 2.2a12 12 0 0 0 6.4 6.4L17 14l2.5 2.5v3A2.5 2.5 0 0 1 17 22 15 15 0 0 1 2 7a2.5 2.5 0 0 1 2.5-2.5h3Z" />
      </>
    ),
    location: (
      <>
        <path d="M12 21s7-5.4 7-11a7 7 0 1 0-14 0c0 5.6 7 11 7 11Z" />
        <circle cx="12" cy="10" r="2.4" />
      </>
    ),
    building: (
      <>
        <path d="M4 21V6.5A1.5 1.5 0 0 1 5.5 5h8A1.5 1.5 0 0 1 15 6.5V21" />
        <path d="M15 10h3.5A1.5 1.5 0 0 1 20 11.5V21M3 21h18M8 9h3M8 13h3M8 17h3" />
      </>
    ),
    chart: (
      <>
        <path d="M4 19.5h16" />
        <path d="M6.5 16.5v-5" />
        <path d="M11.5 16.5v-9" />
        <path d="M16.5 16.5v-12" />
      </>
    ),
    graphStacked: (
      <>
        <path d="M4 19.5h16" />
        <path d="M6.5 16.5v-5" />
        <path d="M11.5 16.5v-9" />
        <path d="M16.5 16.5v-12" />
        <path d="M8.7 17V9.5H6.2V17" fill="currentColor" stroke="none" />
        <path d="M13.7 17V5.8h-2.5V17" fill="currentColor" stroke="none" />
        <path d="M18.7 17V8.2h-2.5V17" fill="currentColor" stroke="none" />
      </>
    ),
    appointmentSolid: (
      <>
        <path d="M7 3.5h10A2.5 2.5 0 0 1 19.5 6v12A2.5 2.5 0 0 1 17 20.5H7A2.5 2.5 0 0 1 4.5 18V6A2.5 2.5 0 0 1 7 3.5Z" fill="currentColor" stroke="none" />
        <path d="M8 2.5v4M16 2.5v4M7.5 9h9" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M8.2 13.5h3M8.2 16.2h5.5" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" opacity="0.95" />
        <circle cx="15.7" cy="14.9" r="2.2" fill="#ffffff" stroke="none" opacity="0.95" />
      </>
    ),
    pendingAppointment: (
      <>
        <path d="M7 3.5h10A2.5 2.5 0 0 1 19.5 6v12A2.5 2.5 0 0 1 17 20.5H7A2.5 2.5 0 0 1 4.5 18V6A2.5 2.5 0 0 1 7 3.5Z" fill="currentColor" stroke="none" />
        <path d="M8 2.5v4M16 2.5v4M7.5 9h9" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M8.2 13h4.2M8.2 16h3" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" opacity="0.95" />
        <circle cx="16.2" cy="15.5" r="3.6" fill="#fff2dc" stroke="none" />
        <path d="M16.2 13.2v2.6l1.8 1.1" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
    completedAppointment: (
      <>
        <path d="M7 3.5h10A2.5 2.5 0 0 1 19.5 6v12A2.5 2.5 0 0 1 17 20.5H7A2.5 2.5 0 0 1 4.5 18V6A2.5 2.5 0 0 1 7 3.5Z" fill="currentColor" stroke="none" />
        <path d="M8 2.5v4M16 2.5v4M7.5 9h9" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M8.2 13.2h3.2M8.2 16h2.4" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" opacity="0.95" />
        <circle cx="16" cy="15.6" r="3.8" fill="#ddfff4" stroke="none" />
        <path d="m14.2 15.7 1.2 1.3 2.7-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v4l3 2" />
      </>
    ),
    cancelCircle: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="m9 9 6 6M15 9l-6 6" />
      </>
    ),
    bell: (
      <>
        <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z" />
        <path d="M10 21h4" />
      </>
    ),
    logout: (
      <>
        <path d="M14 4H7a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h7" />
        <path d="M10 12h10M17 8l4 4-4 4" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2a2 2 0 0 1-4 0V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 0 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H2.8a2 2 0 0 1 0-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1A2 2 0 0 1 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 .9-1.6v-.2a2 2 0 0 1 4 0V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 0 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6.9h.2a2 2 0 0 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="10" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </>
    ),
    shield: (
      <>
        <path d="M12 3.5 19 6v5.2c0 4.4-2.8 8.2-7 9.3-4.2-1.1-7-4.9-7-9.3V6l7-2.5Z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
    eye: (
      <>
        <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
        <circle cx="12" cy="12" r="2.5" />
      </>
    ),
    eyeOff: (
      <>
        <path d="M3 3 21 21" />
        <path d="M10.7 5.2A10.8 10.8 0 0 1 12 5c6 0 9.5 7 9.5 7a15 15 0 0 1-3 3.8" />
        <path d="M6.6 6.9A15 15 0 0 0 2.5 12s3.5 7 9.5 7a10 10 0 0 0 4.2-.9" />
      </>
    ),
    camera: (
      <>
        <path d="M8 7 9.5 5h5L16 7h2.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-7A2.5 2.5 0 0 1 5.5 7H8Z" />
        <circle cx="12" cy="13" r="3" />
      </>
    ),
    patients: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3.8 19a5.2 5.2 0 0 1 10.4 0" />
        <circle cx="17" cy="10" r="2.5" />
        <path d="M15 19a4.4 4.4 0 0 1 5.2-4.3" />
      </>
    ),
    documentCheck: (
      <>
        <path d="M7 3.5h7l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V5A1.5 1.5 0 0 1 7.5 3.5Z" />
        <path d="M14 3.5v5h5M9 13h4" />
        <path d="m13.5 17 1.5 1.5 3.3-3.5" />
      </>
    ),
    motherCare: (
      <>
        <circle cx="12" cy="5.5" r="2" />
        <path d="M8.5 12.5a3.5 3.5 0 0 1 7 0c0 2.4-1.3 4.6-3.5 6.6-2.2-2-3.5-4.2-3.5-6.6Z" />
        <path d="M7.5 9.5 12 3l4.5 6.5M9 21h6" />
      </>
    ),
    pill: (
      <>
        <path d="M10.4 19.1 4.9 13.6a4 4 0 0 1 5.7-5.7l5.5 5.5a4 4 0 0 1-5.7 5.7Z" />
        <path d="m8 10.9 5.1 5.1" />
      </>
    ),
    bulb: (
      <>
        <path d="M9 18h6" />
        <path d="M10 22h4" />
        <path d="M8.5 14.5a6 6 0 1 1 7 0c-.8.7-1.2 1.6-1.2 2.5H9.7c0-.9-.4-1.8-1.2-2.5Z" />
      </>
    ),
    moreVertical: (
      <>
        <circle cx="12" cy="5" r="1" />
        <circle cx="12" cy="12" r="1" />
        <circle cx="12" cy="19" r="1" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    chevronDown: <path d="m7 10 5 5 5-5" />,
    search: (
      <>
        <circle cx="11" cy="11" r="6" />
        <path d="m16 16 4 4" />
      </>
    ),
  };

  return (
    <svg className="doctor-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {icons[name]}
    </svg>
  );
}

function ReminderProfileMenu() {
  const [isOpen, setIsOpen] = React.useState(false);
  const profileRef = React.useRef(null);

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
    window.localStorage.setItem("doctor_active_section", section);
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
        <span className="doctor-reminder-profile-avatar">KV</span>
        <span className="doctor-reminder-profile-copy">
          <strong>Kempee Vergara</strong>
          <small>Doctor</small>
        </span>
        <Icon icon="ri:arrow-down-s-line" />
      </button>

      {isOpen ? (
        <div className="doctor-reminder-profile-dropdown" role="menu">
          <div className="doctor-reminder-profile-dropdown__header">
            <span className="doctor-reminder-profile-dropdown__avatar">KV</span>
            <span>
              <strong>Kempee Vergara</strong>
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

function DoctorReminderContent({ headerAction = null }) {
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
    repeatReminder: "hourly",
  });
  const [patientSearch, setPatientSearch] = React.useState("");
  const [patientResults, setPatientResults] = React.useState([]);
  const [isSearchingPatients, setIsSearchingPatients] = React.useState(false);
  const [patientSearchMessage, setPatientSearchMessage] = React.useState("");
  const [availableAppointments, setAvailableAppointments] = React.useState([]);
  const [isLoadingAppointments, setIsLoadingAppointments] = React.useState(true);
  const [appointmentsMessage, setAppointmentsMessage] = React.useState("");
  const [reminders, setReminders] = React.useState([]);
  const [medicationReminders, setMedicationReminders] = React.useState([]);
  const [isReminderFormOpen, setIsReminderFormOpen] = React.useState(false);
  const [isMedicationFormOpen, setIsMedicationFormOpen] = React.useState(false);
  const [appointmentReminderFilter, setAppointmentReminderFilter] = React.useState("Today");
  const [medicationReminderFilter, setMedicationReminderFilter] = React.useState("Today");
  const [healthTips, setHealthTips] = React.useState(defaultHealthTips);
  const [healthTipFilter, setHealthTipFilter] = React.useState("All");
  const [viewAllSection, setViewAllSection] = React.useState(null);
  const [isHealthTipFormOpen, setIsHealthTipFormOpen] = React.useState(false);
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
    reminderTiming: "medication",
  });
  const [medicationPatientSearch, setMedicationPatientSearch] = React.useState("");
  const [medicationPatientResults, setMedicationPatientResults] = React.useState([]);
  const [isSearchingMedicationPatients, setIsSearchingMedicationPatients] = React.useState(false);
  const [medicationPatientSearchMessage, setMedicationPatientSearchMessage] = React.useState("");
  const [medicationStatusMessage, setMedicationStatusMessage] = React.useState("");
  const [currentTime, setCurrentTime] = React.useState(() => Date.now());
  const medicationTimeInputRef = React.useRef(null);

  React.useEffect(() => {
    const reminderStatusTimer = window.setInterval(() => {
      setCurrentTime(Date.now());
    }, 15000);

    return () => window.clearInterval(reminderStatusTimer);
  }, []);

  React.useEffect(() => {
    let active = true;

    const loadAppointments = async () => {
      setIsLoadingAppointments(true);

      const [scheduleResult, patientsResult] = await Promise.all([
        supabase
          .from(scheduleTableName)
          .select("id, patient_id, patient_name, doctor_name, title, start_time, status")
          .order("start_time", { ascending: true }),
        supabase
          .from("patients")
          .select("id, full_name, patient_id, status")
          .order("full_name", { ascending: true }),
      ]);

      if (!active) return;

      setIsLoadingAppointments(false);

      if (scheduleResult.error) {
        setAvailableAppointments([]);
        setAppointmentsMessage(`Unable to load appointments: ${scheduleResult.error.message}`);
        return;
      }

      if (patientsResult.error) {
        console.warn("Unable to verify appointment patients:", patientsResult.error);
        setAvailableAppointments((scheduleResult.data || []).map(mapScheduleAppointment));
        setAppointmentsMessage("");
        return;
      }

      const registeredAppointments = (scheduleResult.data || [])
        .map((appointment) =>
          attachRegisteredPatientToAppointment(appointment, patientsResult.data || [])
        )
        .filter(Boolean)
        .map(mapScheduleAppointment);

      setAvailableAppointments(registeredAppointments);
      setAppointmentsMessage(
        registeredAppointments.length
          ? ""
          : "No appointments linked to registered patients are available for reminders."
      );
    };

    loadAppointments();

    const scheduleChannel = supabase
      .channel("reminder-schedule-appointments")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: scheduleTableName },
        loadAppointments
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(scheduleChannel);
    };
  }, []);

  const loadAppointmentReminders = React.useCallback(async () => {
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
        created_at,
        patients (
          id,
          full_name,
          patient_id
        ),
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
      setStatusMessage(`Unable to load reminders: ${error.message}`);
      return;
    }

    setReminders((data || []).map(mapReminderDatabaseRow));
  }, []);

  const loadMedicationReminderRows = React.useCallback(async () => {
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
        created_at,
        patients (
          id,
          full_name,
          patient_id
        )
      `)
      .order("start_date", { ascending: true });

    if (error) {
      console.error("Unable to load medication reminders:", error);
      setMedicationStatusMessage(
        `Unable to load medication reminders: ${error.message}`
      );
      return;
    }

    setMedicationReminders(
      (data || []).map(mapMedicationReminderDatabaseRow)
    );
  }, []);

  const loadHealthTipRows = React.useCallback(async () => {
    setIsLoadingHealthTips(true);

    const { data, error } = await supabase
      .from(healthTipsTableName)
      .select("*")
      .eq("is_active", true)
      .order("published_at", { ascending: false })
      .order("created_at", { ascending: false });

    setIsLoadingHealthTips(false);

    if (error) {
      console.error("Unable to load health tips:", error);
      setHealthTips(defaultHealthTips);
      setHealthTipsMessage(`Unable to load health tips: ${error.message}`);
      return;
    }

    const databaseTips = (data || [])
      .map(mapHealthTipDatabaseRow)
      .filter(Boolean);

    setHealthTips(mergeHealthTipsWithDefaults(databaseTips));
    setHealthTipsMessage("");
  }, []);

  React.useEffect(() => {
    loadAppointmentReminders();
    loadMedicationReminderRows();
    loadHealthTipRows();

    const appointmentReminderChannel = supabase
      .channel("doctor-appointment-reminders")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: remindersTableName },
        loadAppointmentReminders
      )
      .subscribe();

    const medicationReminderChannel = supabase
      .channel("doctor-medication-reminders")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: medicationRemindersTableName,
        },
        loadMedicationReminderRows
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
      supabase.removeChannel(appointmentReminderChannel);
      supabase.removeChannel(medicationReminderChannel);
      supabase.removeChannel(healthTipsChannel);
    };
  }, [
    loadAppointmentReminders,
    loadMedicationReminderRows,
    loadHealthTipRows,
  ]);

  React.useEffect(() => {
    const dueReminderIds = reminders
      .filter((reminder) => {
        const notifyTime = reminder.notifyAt
          ? new Date(reminder.notifyAt).getTime()
          : Number.NaN;

        return (
          String(reminder.databaseStatus || "").toLowerCase() === "pending" &&
          Number.isFinite(notifyTime) &&
          notifyTime <= currentTime
        );
      })
      .map((reminder) => reminder.id);

    if (!dueReminderIds.length) {
      return;
    }

    const markDueRemindersAsSent = async () => {
      const { error } = await supabase
        .from(remindersTableName)
        .update({
          status: "sent",
          sent_at: new Date(currentTime).toISOString(),
        })
        .in("id", dueReminderIds);

      if (error) {
        console.error("Unable to mark reminders as sent:", error);
        return;
      }

      await loadAppointmentReminders();
    };

    markDueRemindersAsSent();
  }, [currentTime, loadAppointmentReminders, reminders]);

  React.useEffect(() => {
    const searchPatients = async () => {
      const query = patientSearch.trim();

      if (query.length < 1) {
        setPatientResults([]);
        setPatientSearchMessage("");
        return;
      }

      setIsSearchingPatients(true);
      setPatientSearchMessage("");

      const { data, error } = await supabase
        .from("patients")
        .select("id, full_name, contact_number")
        .ilike("full_name", `%${query}%`)
        .order("full_name", { ascending: true })
        .limit(8);

      setIsSearchingPatients(false);

      if (error) {
        setPatientResults([]);
        setPatientSearchMessage(error.message);
        return;
      }

      setPatientResults(data ?? []);
      setPatientSearchMessage(data?.length ? "" : "No patients found.");
    };

    const searchTimer = window.setTimeout(searchPatients, 300);
    return () => window.clearTimeout(searchTimer);
  }, [patientSearch]);

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
        .from("patients")
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

  const handleSelectPatient = (patient) => {
    setForm((current) => ({
      ...current,
      patientId: patient.id,
      patientName: patient.full_name,
    }));
    setPatientSearch(patient.full_name);
    setPatientResults([]);
    setPatientSearchMessage("");
  };

  const handleSelectAppointmentForReminder = React.useCallback((appointment) => {
    if (!appointment) return;

    setStatusMessage("");
    setForm((current) => ({
      ...current,
      appointmentId: appointment.id,
      patientId: appointment.patientId || appointment.patientName,
      patientName: appointment.patientName,
      appointmentType: appointment.appointmentType,
      doctorName: appointment.doctorName,
      scheduleDate: appointment.scheduleDate,
      scheduleTime: appointment.scheduleTime,
    }));
    setPatientSearch(appointment.patientName);
    setPatientResults([]);
    setPatientSearchMessage("");
    setIsReminderFormOpen(true);
  }, []);

  const reminderPreviewDetails = React.useMemo(() => {
    const scheduleDateValue = form.scheduleDate || "2025-05-19";
    const scheduleTimeValue = form.scheduleTime || "08:00";
    const appointmentDate = new Date(`${scheduleDateValue}T${scheduleTimeValue}`);

    if (Number.isNaN(appointmentDate.getTime())) {
      return {
        date: "May 19, 2025",
        time: "8:00 AM",
        patient: form.patientName || "Patient",
        type: form.appointmentType || "appointment",
        message: `Reminder: ${form.patientName || "Patient"} has ${form.appointmentType || "an appointment"} scheduled on May 19, 2025 at 8:00 AM.`,
      };
    }

    const appointmentDateLabel = appointmentDate.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    const appointmentTimeLabel = appointmentDate.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });

    return {
      date: appointmentDateLabel,
      time: appointmentTimeLabel,
      patient: form.patientName || "Patient",
      type: form.appointmentType || "appointment",
      message: `Reminder: ${form.patientName || "Patient"} has ${form.appointmentType || "an appointment"} scheduled on ${appointmentDateLabel} at ${appointmentTimeLabel}.`,
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
      reminderTiming: "medication",
    });
    setMedicationPatientSearch("");
    setMedicationPatientResults([]);
    setMedicationPatientSearchMessage("");
  };

  const addMedicationTime = () => {
    const nextTime = normalizeDatabaseTime(medicationForm.scheduleTime);

    if (!nextTime) {
      setMedicationStatusMessage("Choose a medication time before adding it.");
      medicationTimeInputRef.current?.focus();
      medicationTimeInputRef.current?.showPicker?.();
      return;
    }

    if (medicationForm.scheduleTimes.includes(nextTime)) {
      setMedicationStatusMessage(
        `${formatMedicationReminderTime(nextTime)} is already added.`
      );
      medicationTimeInputRef.current?.focus();
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
    medicationTimeInputRef.current?.blur();
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

    const normalizedTimes = Array.from(
      new Set([
        ...medicationForm.scheduleTimes,
        ...(medicationForm.scheduleTime
          ? [medicationForm.scheduleTime]
          : []),
      ])
    )
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
      medicationTimeInputRef.current?.focus();
      return;
    }

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user?.id) {
      console.error("Medication reminder authenticated user lookup failed:", userError);
      setMedicationStatusMessage("Unable to identify the logged-in account. Please sign in again.");
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
      created_by: user.id,
      updated_at: new Date().toISOString(),
    };

    logMedicationReminderDebug("insert payload", {
      authenticatedUserId: user.id,
      patientDatabaseId: medicationForm.patientId,
      medicationTimes: postgresReminderTimes,
      payload,
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

    await loadMedicationReminderRows();
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

    await loadMedicationReminderRows();
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

    await loadMedicationReminderRows();
  };

  const getAppointmentReminderStatus = (reminder) => {
    if (!reminder) return "Upcoming";

    const normalizedStatus = String(
      reminder.databaseStatus || reminder.status || "pending"
    ).toLowerCase();

    if (normalizedStatus === "sent") return "Sent";
    if (normalizedStatus === "completed") return "Completed";
    if (normalizedStatus === "cancelled") return "Cancelled";

    const notifyTime = reminder.notifyAt
      ? new Date(reminder.notifyAt).getTime()
      : Number.NaN;

    if (Number.isFinite(notifyTime) && notifyTime <= currentTime) {
      return "Sent";
    }

    return "Pending";
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    const selectedAppointment =
      availableAppointments.find(
        (appointment) => appointment.id === form.appointmentId
      ) || null;

    if (!selectedAppointment) {
      setStatusMessage(
        "Select an appointment before saving the reminder."
      );
      return;
    }

    const notifyAt = getReminderNotifyAtForAppointment(
      selectedAppointment,
      form.reminderLeadTime,
      form.customNotifyAt
    );

    const notifyTime = new Date(notifyAt).getTime();
    const scheduleTime = new Date(
      selectedAppointment.scheduleAt ||
        `${selectedAppointment.scheduleDate}T${
          selectedAppointment.scheduleTime || "08:00"
        }`
    ).getTime();

    if (
      !Number.isFinite(notifyTime) ||
      !Number.isFinite(scheduleTime) ||
      notifyTime > scheduleTime
    ) {
      setStatusMessage(
        "Choose a valid reminder time before the appointment schedule."
      );
      return;
    }

    setIsSavingReminder(true);
    setStatusMessage("");

    try {
      const patientRecordId = await resolvePatientRecordId(
        selectedAppointment.patientId || form.patientId,
        selectedAppointment.patientName || form.patientName
      );

      if (!patientRecordId) {
        setStatusMessage(
          "This appointment is not linked to an active registered patient. Choose an appointment for a patient that exists in Supabase."
        );
        setIsSavingReminder(false);
        return;
      }

      const existingReminder =
        remindersByAppointmentId[selectedAppointment.id];

      const payload = {
        patient_id: patientRecordId,
        schedule_id: selectedAppointment.id,
        reminder_type: "appointment",
        title: `${
          selectedAppointment.appointmentType || "Appointment"
        } Reminder`,
        message:
          form.message.trim() ||
          buildAppointmentReminderMessage(selectedAppointment),
        remind_at: notifyAt,
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

      if (error) {
        throw error;
      }

      await loadAppointmentReminders();

      setForm({
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
        repeatReminder: "hourly",
      });
      setPatientSearch("");
      setPatientResults([]);
      setPatientSearchMessage("");
      setIsReminderFormOpen(false);
      setStatusMessage(
        existingReminder
          ? "Appointment reminder updated successfully."
          : "Appointment reminder saved successfully."
      );
    } catch (error) {
      console.error("Appointment reminder save failed:", error);
      setStatusMessage(
        `Unable to save appointment reminder: ${
          error?.message || "Unknown error"
        }`
      );
    } finally {
      setIsSavingReminder(false);
    }
  };

  const handleHealthTipChange = (event) => {
    const { name, value } = event.target;
    setHealthTipForm((current) => ({
      ...current,
      [name]: value,
    }));
  };

  const addHealthTip = async (event) => {
    event.preventDefault();

    const title = healthTipForm.title.trim();
    const content = healthTipForm.text.trim();

    if (!title || !content) {
      setHealthTipsMessage("Enter both a title and a description.");
      return;
    }

    setIsSavingHealthTip(true);
    setHealthTipsMessage("");

    try {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user?.id) {
        throw userError || new Error("No authenticated Doctor account found.");
      }

      const basePayload = {
        created_by: user.id,
        patient_id: null,
        category: healthTipForm.category,
        title,
        content,
        image_url: null,
        is_active: true,
        published_at: new Date().toISOString(),
      };

      let saveResult = await supabase
        .from(healthTipsTableName)
        .insert([
          {
            ...basePayload,
            display_schedule: healthTipForm.displaySchedule,
          },
        ])
        .select("*")
        .single();

      /*
       * The original health_tips table may not have display_schedule yet.
       * Retry with the original schema so saving still works.
       */
      if (
        saveResult.error &&
        /display_schedule/i.test(saveResult.error.message || "")
      ) {
        saveResult = await supabase
          .from(healthTipsTableName)
          .insert([basePayload])
          .select("*")
          .single();
      }

      if (saveResult.error) {
        throw saveResult.error;
      }

      await loadHealthTipRows();

      setHealthTipForm({
        category: "Nutrition",
        icon: "bulb",
        title: "",
        text: "",
        displaySchedule: "Daily",
      });
      setHealthTipFilter("All");
      setIsHealthTipFormOpen(false);
      setHealthTipsMessage("Health tip saved successfully.");
    } catch (error) {
      console.error("Health tip save failed:", error);
      setHealthTipsMessage(
        `Unable to save health tip: ${error?.message || "Unknown error"}`
      );
    } finally {
      setIsSavingHealthTip(false);
    }
  };

  const todayDateKey = getLocalDateKey();
  const tomorrowDateKey = getLocalDateKey(1);
  const remindersByAppointmentId = React.useMemo(() => {
    return reminders.reduce((acc, reminder) => {
      if (reminder.appointmentId) {
        acc[reminder.appointmentId] = reminder;
      }
      return acc;
    }, {});
  }, [reminders]);
  const appointmentRows = availableAppointments.filter((appointment) => {
    if (appointmentReminderFilter === "Today") return appointment.scheduleDate === todayDateKey;
    if (appointmentReminderFilter === "Tomorrow") return appointment.scheduleDate === tomorrowDateKey;
    if (appointmentReminderFilter === "Upcoming") return appointment.scheduleDate >= todayDateKey;
    return true;
  });
  const visibleAppointmentRows = appointmentRows.slice(0, appointmentReminderFilter === "All" ? 8 : 3);
  const medicationRows = medicationReminders.filter((reminder) => {
    if (medicationReminderFilter === "Today") return reminder.scheduleDate === todayDateKey;
    if (medicationReminderFilter === "Tomorrow") return reminder.scheduleDate === tomorrowDateKey;
    if (medicationReminderFilter === "Upcoming") return reminder.scheduleDate >= todayDateKey;
    return true;
  });
  const visibleMedicationRows = medicationRows.slice(0, 3);
  const filteredHealthTips =
    healthTipFilter === "All" ? healthTips : healthTips.filter((tip) => tip.category === healthTipFilter);
  const visibleHealthTips = filteredHealthTips.slice(0, 3);
  const isAnyModalOpen =
    isReminderFormOpen || isMedicationFormOpen || isHealthTipFormOpen || Boolean(viewAllSection);

  const openReminderForm = () => {
    const nextAppointment =
      appointmentRows.find((appointment) => !remindersByAppointmentId[appointment.id]) ||
      appointmentRows[0] ||
      availableAppointments[0];

    if (nextAppointment) {
      handleSelectAppointmentForReminder(nextAppointment);
      return;
    }

    setStatusMessage("");
    setAppointmentsMessage("No saved appointments are available for reminders yet.");
  };

  const closeReminderForm = () => {
    setIsReminderFormOpen(false);
    setStatusMessage("");
    setPatientResults([]);
    setPatientSearchMessage("");
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
    setIsHealthTipFormOpen(true);
  };

  const closeHealthTipForm = () => {
    setIsHealthTipFormOpen(false);
  };

  const closeViewAll = () => {
    setViewAllSection(null);
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
    };

    document.body.classList.add("doctor-reminder-modal-open");
    window.addEventListener("keydown", handleEscape);

    return () => {
      document.body.classList.remove("doctor-reminder-modal-open");
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isAnyModalOpen]);

  return (
    <section className="doctor-reminder-page">
      <header className="doctor-dashboard-header doctor-reminder-header">
        <div className="doctor-reminder-title-block">
          <h1>Reminder</h1>
          <p>Manage patient daily health protocols and checkup schedules.</p>
        </div>
        {headerAction || <ReminderProfileMenu />}
      </header>

      <div className="doctor-reminder-layout">
        <section className="doctor-reminder-card doctor-reminder-appointments-card">
          <header className="doctor-reminder-card__header">
            <span className="doctor-reminder-card__icon"><Icon icon="solar:calendar-mark-bold" /></span>
            <h2>Appointment Reminder</h2>
            <button type="button" onClick={() => setViewAllSection("appointments")}>View All</button>
          </header>
          <div className="doctor-reminder-toolbar">
            <div className="doctor-reminder-tabs" aria-label="Appointment reminder filters">
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
            <button className="doctor-reminder-primary-action" type="button" onClick={openReminderForm}>
              Set Reminder
            </button>
          </div>
          <div className="doctor-reminder-appointment-table">
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

        <section className="doctor-reminder-card doctor-health-tips-card">
          <header className="doctor-reminder-card__header">
            <span className="doctor-reminder-card__icon"><Icon icon="solar:lightbulb-bold" /></span>
            <h2>Health Tips</h2>
            <button type="button" onClick={() => setViewAllSection("healthTips")}>View All</button>
          </header>
          <div className="doctor-health-tips-panel">
            <div className="doctor-health-tip-tabs" aria-label="Health tip filters">
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
              {visibleHealthTips.length === 0 ? (
                <article className="doctor-health-tip-empty">
                  <span className="doctor-health-tip-logo"><Icon icon="solar:lightbulb-linear" /></span>
                  <p>No health tips in this category yet.</p>
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

        <section className="doctor-reminder-card doctor-medication-card">
          <header className="doctor-reminder-card__header">
            <span className="doctor-reminder-card__icon"><Icon icon="solar:calendar-mark-bold" /></span>
            <h2>Medication Reminder</h2>
            <button type="button" onClick={() => setViewAllSection("medications")}>View All</button>
          </header>
          <div className="doctor-reminder-toolbar doctor-medication-toolbar">
            <div className="doctor-reminder-tabs" aria-label="Medication reminder filters">
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
            <button className="doctor-reminder-primary-action" type="button" onClick={openMedicationForm}>
              Add Medication
            </button>
          </div>
          {medicationStatusMessage ? <p className="doctor-reminder-message">{medicationStatusMessage}</p> : null}
          <div className="doctor-medication-table">
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
                <mark>{reminder.status}</mark>
                <span className="doctor-medication-actions">
                  <button
                    type="button"
                    title="Mark complete"
                    onClick={() => updateMedicationStatus(reminder.id, "Complete")}
                  >
                    <Icon icon="carbon:notification" />
                  </button>
                  <button
                    type="button"
                    title="Delete reminder"
                    onClick={() => deleteMedicationReminder(reminder.id)}
                  >
                    <Icon icon="charm:menu-kebab" />
                  </button>
                </span>
              </div>
            )) : (
              <div className="doctor-reminder-appointment-empty">No medication reminders yet.</div>
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
                    ? `${availableAppointments.length} appointment${availableAppointments.length === 1 ? "" : "s"}`
                    : viewAllSection === "medications"
                      ? `${medicationReminders.length} medication reminder${medicationReminders.length === 1 ? "" : "s"}`
                      : `${healthTips.length} health tip${healthTips.length === 1 ? "" : "s"}`}
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
                  {availableAppointments.length > 0 ? (
                    availableAppointments.map((appointment) => {
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
                    <div className="doctor-reminder-appointment-empty">No saved appointments found.</div>
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
                  {medicationReminders.length > 0 ? medicationReminders.map((reminder) => (
                    <div className="doctor-medication-row" key={reminder.id || `${reminder.patientName}-${reminder.medication}-all`}>
                      <span>{reminder.patientName || reminder.patient}</span>
                      <span>{reminder.medication}</span>
                      <span>{reminder.dosage}</span>
                      <span>{reminder.schedule || `${formatReminderDisplayTime(reminder.scheduleTime)} daily`}</span>
                      <mark>{reminder.status}</mark>
                      <span className="doctor-medication-actions">
                        <button
                          type="button"
                          title="Mark complete"
                          onClick={() => updateMedicationStatus(reminder.id, "Complete")}
                        >
                          <Icon icon="carbon:notification" />
                        </button>
                        <button
                          type="button"
                          title="Delete reminder"
                          onClick={() => deleteMedicationReminder(reminder.id)}
                        >
                          <Icon icon="charm:menu-kebab" />
                        </button>
                      </span>
                    </div>
                  )) : (
                    <div className="doctor-reminder-appointment-empty">No medication reminders yet.</div>
                  )}
                </div>
              </div>
            ) : (
              <div className="doctor-reminder-view-all__content doctor-reminder-view-all__tips">
                {healthTips.length > 0 ? (
                  healthTips.map((tip) => (
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
                        <small>{tip.category}</small>
                        <p>{tip.text}</p>
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="doctor-reminder-view-all__empty">No health tips yet.</div>
                )}
              </div>
            )}
          </section>
        </div>,
        document.body
      ) : null}

      {isReminderFormOpen ? createPortal(
        <div className="doctor-reminder-modal" role="dialog" aria-modal="true" aria-labelledby="doctor-reminder-form-title" onClick={closeReminderForm}>
          <form className="doctor-panel doctor-reminder-form doctor-reminder-form--appointment" onSubmit={handleSubmit} onClick={(event) => event.stopPropagation()}>
            <div className="doctor-reminder-form__title">
              <div>
                <h2 id="doctor-reminder-form-title">Set Reminder</h2>
                <p>Configure reminder preferences to send timely notifications before the patient's appointment.</p>
              </div>
              <button className="doctor-reminder-modal-close" type="button" aria-label="Close reminder form" onClick={closeReminderForm}>&times;</button>
            </div>

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
                  <label className="doctor-reminder-option" key={value}>
                    <input
                      className={value === "custom" ? "doctor-reminder-option-radio-hidden" : ""}
                      type="radio"
                      name="reminderLeadTime"
                      value={value}
                      checked={form.reminderLeadTime === value}
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
              <div className="doctor-reminder-repeat-options">
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
                ) : (
                  <p>
                    Reminder: <strong className="doctor-reminder-preview-accent">{reminderPreviewDetails.patient}</strong>{" "}
                    has <strong className="doctor-reminder-preview-accent">{reminderPreviewDetails.type}</strong>{" "}
                    scheduled on{" "}
                    <strong className="doctor-reminder-preview-accent">{reminderPreviewDetails.date}</strong>{" "}
                    at <strong className="doctor-reminder-preview-accent">{reminderPreviewDetails.time}</strong>.
                  </p>
                )}
              </div>
            </div>

            {statusMessage ? <p className="doctor-reminder-message">{statusMessage}</p> : null}

            <div className="doctor-reminder-form__actions">
              <button type="submit" disabled={isSavingReminder}>
                {isSavingReminder ? "Saving..." : "Save"}
              </button>
              <button type="button" onClick={closeReminderForm}>
                Cancel
              </button>
            </div>
          </form>
        </div>,
        document.body
      ) : null}

      {isMedicationFormOpen ? createPortal(
        <div className="doctor-reminder-modal" role="dialog" aria-modal="true" aria-labelledby="doctor-medication-form-title" onClick={closeMedicationForm}>
          <form className="doctor-panel doctor-medication-reminder-form" onSubmit={addMedicationReminder} onClick={(event) => event.stopPropagation()}>
            <div className="doctor-medication-reminder-form__title">
              <div>
                <h2 id="doctor-medication-form-title">Add Medication Reminder</h2>
                <p>Fill in the details to set reminder for your patient.</p>
              </div>
              <button
                className="doctor-medication-reminder-close"
                type="button"
                aria-label="Close medication reminder form"
                onClick={closeMedicationForm}
              >
                &times;
              </button>
            </div>

            <section className="doctor-medication-reminder-section">
              <h3>Patient Information</h3>
              <label className="doctor-medication-reminder-field doctor-medication-reminder-field--patient doctor-patient-search">
                <span>Patient <b>*</b></span>
                <input
                  type="text"
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
                  <span>Time(s)<b>*</b></span>
                  <div className="doctor-medication-reminder-time-row">
                    <div className="doctor-medication-reminder-time-chips">
                      {medicationForm.scheduleTimes.map((timeValue, timeIndex) => (
                        <span className="doctor-medication-reminder-time-chip" key={`${timeValue}-${timeIndex}`}>
                          {formatMedicationReminderTime(timeValue)}
                          <button type="button" aria-label={`Remove ${formatMedicationReminderTime(timeValue)}`} onClick={() => removeMedicationTime(timeIndex)}>
                            x
                          </button>
                        </span>
                      ))}
                    </div>
                    <input
                      className="doctor-medication-reminder-time-input"
                      ref={medicationTimeInputRef}
                      name="scheduleTime"
                      type="time"
                      value={medicationForm.scheduleTime}
                      onChange={handleMedicationChange}
                      aria-label="Medication reminder time"
                    />
                    <button className="doctor-medication-reminder-add-time" type="button" onClick={addMedicationTime}>
                      + Add Time
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
                value={medicationForm.message}
                onChange={handleMedicationChange}
              />
            </section>

            <section className="doctor-medication-reminder-section doctor-medication-reminder-section--settings">
              <h3>Reminder Settings</h3>
              <p>When should the patient be reminded?</p>
              <div className="doctor-medication-reminder-radios">
                {[
                  ["medication", "At the time of medication"],
                  ["daily", "Daily"],
                  ["hourly", "Every Hour"],
                ].map(([value, label]) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="reminderTiming"
                      value={value}
                      checked={medicationForm.reminderTiming === value}
                      onChange={handleMedicationChange}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </section>

            {medicationStatusMessage ? <p className="doctor-reminder-message">{medicationStatusMessage}</p> : null}

            <div className="doctor-medication-reminder-actions">
              <button type="submit" disabled={isSavingMedicationReminder}>
                {isSavingMedicationReminder ? "Saving..." : "Save"}
              </button>
              <button
                type="button"
                onClick={closeMedicationForm}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>,
        document.body
      ) : null}

      {isHealthTipFormOpen ? createPortal(
        <div className="doctor-reminder-modal" role="dialog" aria-modal="true" aria-labelledby="doctor-health-tip-form-title" onClick={closeHealthTipForm}>
          <form className="doctor-panel doctor-health-tip-form doctor-health-tip-form--detailed" onSubmit={addHealthTip} onClick={(event) => event.stopPropagation()}>
            <div className="doctor-health-tip-form__title">
              <div className="doctor-health-tip-form__headline">
                <span className="doctor-health-tip-form__icon" aria-hidden="true">
                  <Icon icon="solar:sun-2-bold" />
                </span>
                <div>
                  <h2 id="doctor-health-tip-form-title">Add Health Tip</h2>
                  <p>Create a helpful health tip for your patients.</p>
                </div>
              </div>
              <button className="doctor-health-tip-form__close" type="button" aria-label="Close health tip form" onClick={closeHealthTipForm}>
                <Icon icon="material-symbols:close-rounded" />
              </button>
            </div>

            <label className="doctor-health-tip-form__field doctor-health-tip-form__field--category">
              <span>Tip Category<b>*</b></span>
              <select name="category" value={healthTipForm.category} onChange={handleHealthTipChange} required>
                {healthTipCategories.filter((category) => category !== "All").map((category) => (
                  <option key={category}>{category}</option>
                ))}
              </select>
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
            </label>

            <label className="doctor-health-tip-form__field doctor-health-tip-form__field--wide">
              <span>Tip Description<b>*</b></span>
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

            <div className="doctor-health-tip-form__actions">
              <button type="submit" disabled={isSavingHealthTip}>
                <Icon icon="solar:download-minimalistic-outline" />
                {isSavingHealthTip ? "Saving..." : "Save"}
              </button>
              <button type="button" onClick={closeHealthTipForm}>Cancel</button>
            </div>
          </form>
        </div>,
        document.body
      ) : null}
    </section>
  );
}

export default DoctorReminderContent;
