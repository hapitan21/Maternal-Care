import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import { PatientPageHeader } from "../../components/patient/PatientPwaUi";
import {
  getStoredHealthTips,
  mapScheduleRowToReminder,
  patientMatchesValue,
} from "../../lib/patientData";
import {
  classifyAppointment,
  getManilaDateKey,
  getManilaDayRange,
  getManilaTimeKey,
  toManilaISOString,
} from "../../lib/appointmentDate";

const reminderTabs = ["Today", "Tomorrow", "Upcoming"];
const medicationOccurrenceStatuses = new Set([
  "processing",
  "notified",
  "taken",
  "skipped",
  "missed",
  "failed",
]);

function mapHealthTipDatabaseRow(row) {
  if (!row || typeof row !== "object") {
    return null;
  }

  const content = String(row.content || "").trim();

  if (!content) {
    return null;
  }

  return {
    id: row.id,
    category: row.category || "General Health",
    title: row.title || row.category || "Health Tip",
    text: content,
    image: row.image_url || "",
    displaySchedule: row.display_schedule || "Daily",
    patientId: row.patient_id || "",
    publishedAt: row.published_at || row.created_at || "",
  };
}

function dedupeHealthTips(databaseTips) {
  return databaseTips.filter(
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

function getStatusClass(status) {
  return String(status || "Pending")
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function isCancelledOrCompletedStatus(status) {
  const normalized = String(status || "").toLowerCase();
  return normalized.includes("cancel") || normalized.includes("complete");
}

function getRelatedRecord(value) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function logMedicationReminderDebug(label, details = {}) {
  if (import.meta.env.DEV) {
    console.info(`[Patient Medication Reminder Flow] ${label}:`, details);
  }
}

async function loadAuthenticatedPatientRow() {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user?.id) {
    console.error("[Patient Appointment Flow] reminder authenticated user lookup failed:", authError);
    return null;
  }

  console.info("[Patient Appointment Flow] reminder authenticated user ID:", user.id);
  logMedicationReminderDebug("authenticated user", {
    authenticatedUserId: user.id,
  });

  const { data, error } = await supabase
    .rpc("get_patient_own_record")
    .select("id, full_name, patient_id, user_id, email, contact_number")
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[Patient Appointment Flow] reminder patient record fetch error:", error);
    return null;
  }

  console.info("[Patient Appointment Flow] reminder resolved patient database ID:", data?.id || null);
  logMedicationReminderDebug("resolved patient", {
    patientDatabaseId: data?.id || null,
  });
  return data || null;
}

async function fetchPatientScheduleRows(patient) {
  const columns =
    "id, patient_id, patient_name, doctor_name, title, description, start_time, end_time, status";

  if (!patient?.id) {
    console.warn("[Patient Appointment Flow] reminder no resolved patient database ID; skipping schedule fetch.");
    return [];
  }

  const todayRange = getManilaDayRange();
  const { data, error } = await supabase
    .from("schedule")
    .select(columns)
    .eq("patient_id", patient.id)
    .gte("start_time", todayRange.start.toISOString())
    .order("start_time", { ascending: true });

  if (error) {
    console.error("[Patient Appointment Flow] reminder appointment fetch error:", error);
    return [];
  }

  console.info("[Patient Appointment Flow] reminder returned appointment count:", data?.length || 0);

  return (data || [])
    .filter((row) => classifyAppointment(row).isUpcoming)
    .filter(
      (row, index, source) =>
        source.findIndex((item) => String(item.id) === String(row.id)) === index
    );
}

function getLocalDateKey(date = new Date()) {
  return getManilaDateKey(date);
}

function addDays(dateValue, amount) {
  const date = new Date(`${dateValue}T00:00:00+08:00`);
  date.setTime(date.getTime() + amount * 24 * 60 * 60 * 1000);
  return getLocalDateKey(date);
}

function normalizeDatabaseTime(value) {
  if (!value) return "";
  return String(value).slice(0, 5);
}

function normalizeMedicationScheduledMinute(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  date.setSeconds(0, 0);
  return date.toISOString();
}

function formatDatabaseReminderStatus(status, remindAt) {
  const normalizedStatus = String(status || "pending").toLowerCase();

  if (normalizedStatus === "sent") return "Sent";
  if (normalizedStatus === "completed") return "Completed";
  if (normalizedStatus === "cancelled") return "Missed";

  const remindTime = remindAt ? new Date(remindAt).getTime() : Number.NaN;

  if (Number.isFinite(remindTime) && remindTime <= Date.now()) {
    return "Sent";
  }

  return "Pending";
}

function formatMedicationStatus(status) {
  const normalizedStatus = String(status || "active").toLowerCase();

  if (normalizedStatus === "completed") return "Completed";
  if (normalizedStatus === "cancelled") return "Missed";
  if (normalizedStatus === "paused") return "Paused";
  return "Pending";
}

function mapReminderDatabaseRow(row) {
  const appointment = getRelatedRecord(row.schedule);
  const patient = getRelatedRecord(row.patients);
  const scheduleAt = appointment?.start_time || row.remind_at;
  const scheduleStatus = appointment?.status || row.status || "scheduled";

  return {
    id: row.id,
    type: "scheduleReminder",
    appointmentId: row.schedule_id || appointment?.id || "",
    patientId: row.patient_id || patient?.id || "",
    patientName:
      patient?.full_name || appointment?.patient_name || "Patient",
    appointmentType:
      appointment?.title || row.title || "Appointment",
    doctorName: appointment?.doctor_name || "Doctor not recorded",
    scheduleDate: getLocalDateKey(scheduleAt),
    scheduleTime: getManilaTimeKey(scheduleAt),
    scheduleAt,
    scheduleEndAt: appointment?.end_time || scheduleAt,
    scheduleStatus,
    notifyAt: row.remind_at,
    message: row.message || "",
    status: formatDatabaseReminderStatus(row.status, row.remind_at),
    sentAt: row.sent_at,
  };
}

function mapMedicationDatabaseRow(row) {
  const patient = getRelatedRecord(row.patients);
  const reminderTimes = Array.isArray(row.reminder_times)
    ? row.reminder_times.map(normalizeDatabaseTime).filter(Boolean)
    : [];

  return {
    id: row.id,
    databaseId: row.id,
    type: "medicationReminder",
    patientId: row.patient_id || patient?.id || "",
    patientName: patient?.full_name || "Patient",
    medication: row.medication_name || "Medication",
    dosage: row.dosage || "",
    frequency: row.frequency || "As prescribed",
    duration: row.duration || "",
    prescriptionReference: row.prescription_reference || "",
    reminderTimes: reminderTimes.length ? reminderTimes : ["08:00"],
    startDate: row.start_date || "",
    endDate: row.end_date || "",
    message: row.instructions || "",
    status: formatMedicationStatus(row.status),
    databaseStatus: row.status,
    isActive:
      String(row.status || "active").trim().toLowerCase() === "active",
  };
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

function getMedicationOccurrenceDate(reminder, tab) {
  const today = getLocalDateKey();
  const tomorrow = addDays(today, 1);

  if (tab === "Today") {
    return isDateInsideMedicationRange(today, reminder) ? today : "";
  }

  if (tab === "Tomorrow") {
    return isDateInsideMedicationRange(tomorrow, reminder)
      ? tomorrow
      : "";
  }

  const upcomingStart = addDays(today, 2);
  const firstPossibleDate =
    reminder.startDate > upcomingStart ? reminder.startDate : upcomingStart;

  return isDateInsideMedicationRange(firstPossibleDate, reminder)
    ? firstPossibleDate
    : "";
}

function getMedicationOccurrenceKey(
  medicationReminderId,
  scheduledValue,
  scheduleTime
) {
  const scheduledAt = scheduleTime
    ? toManilaISOString(scheduledValue, normalizeDatabaseTime(scheduleTime))
    : scheduledValue;
  const normalizedTimestamp = normalizeMedicationScheduledMinute(scheduledAt);

  return [
    String(medicationReminderId || ""),
    normalizedTimestamp,
  ].join("|");
}

function isMedicationOccurrenceInTab(occurrence, tab) {
  if (
    !occurrence?.scheduleDate ||
    !medicationOccurrenceStatuses.has(occurrence.status)
  ) {
    return false;
  }

  const today = getLocalDateKey();
  const tomorrow = addDays(today, 1);

  if (tab === "Today") {
    return occurrence.scheduleDate === today;
  }

  if (tab === "Tomorrow") {
    return occurrence.scheduleDate === tomorrow;
  }

  return occurrence.scheduleDate > tomorrow;
}

function shouldIncludeNoOccurrenceMedicationRow(reminder, scheduleAt) {
  if (!reminder.isActive || !scheduleAt) {
    return false;
  }

  const scheduleTime = new Date(scheduleAt).getTime();

  return Number.isFinite(scheduleTime) && scheduleTime > Date.now();
}

function buildMedicationScheduleRow(
  reminder,
  scheduleDate,
  scheduleTime,
  scheduleAt,
  occurrence,
  index
) {
  const normalizedScheduledAt =
    normalizeMedicationScheduledMinute(scheduleAt) || scheduleAt;
  const matchKey = getMedicationOccurrenceKey(
    reminder.databaseId,
    normalizedScheduledAt
  );
  const status = getMedicationOccurrenceStatus(
    {
      ...reminder,
      scheduleAt: normalizedScheduledAt,
    },
    occurrence
  );

  return {
    ...reminder,
    id: `${reminder.databaseId}-${normalizedScheduledAt || scheduleDate}-${index}`,
    scheduleDate,
    scheduleTime,
    scheduleAt: normalizedScheduledAt,
    notifyAt: normalizedScheduledAt,
    occurrence,
    matchKey,
    reminderTimes: scheduleTime ? [scheduleTime] : [],
    status: status.label,
    statusClassName: status.className,
    canMarkMedicationAction: status.canAct,
  };
}

function buildMedicationOccurrences(
  reminders,
  tab,
  medicationOccurrences = [],
  medicationOccurrenceMap = new Map()
) {
  const reminderById = new Map(
    reminders.map((reminder) => [String(reminder.databaseId), reminder])
  );
  const rowsByKey = new Map();

  medicationOccurrences
    .filter((occurrence) => isMedicationOccurrenceInTab(occurrence, tab))
    .forEach((occurrence, index) => {
      const reminder = reminderById.get(
        String(occurrence.medicationReminderId || "")
      );

      if (!reminder) {
        return;
      }

      const matchKey =
        occurrence.matchKey ||
        getMedicationOccurrenceKey(
          occurrence.medicationReminderId,
          occurrence.normalizedScheduledFor || occurrence.scheduledFor
        );

      if (rowsByKey.has(matchKey)) {
        return;
      }

      rowsByKey.set(
        matchKey,
        buildMedicationScheduleRow(
          reminder,
          occurrence.scheduleDate,
          occurrence.scheduleTime,
          occurrence.normalizedScheduledFor || occurrence.scheduledFor,
          occurrence,
          index
        )
      );
    });

  reminders.forEach((reminder) => {
    const occurrenceDate = getMedicationOccurrenceDate(reminder, tab);

    if (!occurrenceDate) {
      return;
    }

    reminder.reminderTimes.forEach((timeValue, index) => {
      const scheduleTime = normalizeDatabaseTime(timeValue) || "08:00";
      const scheduleAt = toManilaISOString(occurrenceDate, scheduleTime);
      const matchKey = getMedicationOccurrenceKey(
        reminder.databaseId,
        scheduleAt
      );
      const occurrence = medicationOccurrenceMap.get(matchKey) || null;

      if (rowsByKey.has(matchKey)) {
        return;
      }

      if (
        !occurrence &&
        !shouldIncludeNoOccurrenceMedicationRow(reminder, scheduleAt)
      ) {
        return;
      }

      rowsByKey.set(
        matchKey,
        buildMedicationScheduleRow(
          reminder,
          occurrenceDate,
          scheduleTime,
          scheduleAt,
          occurrence,
          index
        )
      );
    });
  });

  return Array.from(rowsByKey.values()).sort(
    (first, second) =>
      new Date(first.scheduleAt || 0) - new Date(second.scheduleAt || 0)
  );
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
    historyStart: new Date(
      todayRange.start.getTime() - 6 * 24 * 60 * 60 * 1000
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

function mapMedicationOccurrenceRow(row) {
  const normalizedScheduledFor =
    normalizeMedicationScheduledMinute(row.scheduled_for);
  const scheduleDate = getManilaDateKey(
    normalizedScheduledFor || row.scheduled_for
  );
  const scheduleTime = getManilaTimeKey(
    normalizedScheduledFor || row.scheduled_for
  );

  return {
    id: row.id,
    medicationReminderId: row.medication_reminder_id,
    patientId: row.patient_id,
    scheduledFor: row.scheduled_for,
    normalizedScheduledFor,
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
      normalizedScheduledFor || row.scheduled_for
    ),
  };
}

function getMedicationOccurrenceStatus(item, occurrence) {
  if (occurrence?.status === "processing") {
    return {
      label: "PROCESSING",
      className: "processing",
      canAct: false,
    };
  }

  if (occurrence?.status === "notified") {
    return {
      label: "DUE",
      className: "due",
      canAct: true,
    };
  }

  if (occurrence?.status === "taken") {
    return {
      label: "TAKEN",
      className: "taken",
      canAct: false,
    };
  }

  if (occurrence?.status === "skipped") {
    return {
      label: "SKIPPED",
      className: "skipped",
      canAct: false,
    };
  }

  if (occurrence?.status === "missed") {
    return {
      label: "MISSED",
      className: "missed",
      canAct: false,
    };
  }

  if (occurrence?.status === "failed") {
    return {
      label: "UNAVAILABLE",
      className: "unavailable",
      canAct: false,
    };
  }

  if (!item.isActive) {
    return {
      label: item.status || "Inactive",
      className: getStatusClass(item.status || "Inactive"),
      canAct: false,
    };
  }

  if (!occurrence) {
    const scheduleTime = item.scheduleAt
      ? new Date(item.scheduleAt).getTime()
      : Number.NaN;

    if (!Number.isFinite(scheduleTime)) {
      return {
        label: "UNAVAILABLE",
        className: "unavailable",
        canAct: false,
      };
    }

    if (scheduleTime <= Date.now()) {
      return {
        label: "PENDING",
        className: "pending",
        canAct: false,
      };
    }

    return {
      label: "UPCOMING",
      className: "upcoming",
      canAct: false,
    };
  }

  return {
    label: "UPCOMING",
    className: "upcoming",
    canAct: false,
  };
}

function formatMedicationTimestampDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("en-US", {
    timeZone: "Asia/Manila",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatMedicationTimestampTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString("en-US", {
    timeZone: "Asia/Manila",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getMedicationResponseLabel(occurrence) {
  const status = String(occurrence?.status || "").toLowerCase();

  if (status === "taken" || status === "skipped") {
    return occurrence.actionAt
      ? `${formatMedicationTimestampDate(occurrence.actionAt)} ${formatMedicationTimestampTime(occurrence.actionAt)}`
      : "-";
  }

  if (status === "missed") {
    return occurrence.missedAt
      ? `${formatMedicationTimestampDate(occurrence.missedAt)} ${formatMedicationTimestampTime(occurrence.missedAt)}`
      : "-";
  }

  if (status === "notified") return "Awaiting response";
  if (status === "processing") return "Processing";
  if (status === "failed") return "Reminder unavailable";
  return "-";
}

async function sendPatientNotification(reminder) {
  if (
    typeof window === "undefined" ||
    !("Notification" in window) ||
    Notification.permission !== "granted"
  ) {
    return;
  }

  const title = "Appointment Reminder";
  const body = reminder.message || "You have an appointment reminder.";

  try {
    const registration =
      "serviceWorker" in navigator
        ? await navigator.serviceWorker.getRegistration()
        : null;

    if (registration?.showNotification) {
      await registration.showNotification(title, {
        body,
        icon: "/images/maternal-care-logo.png",
        badge: "/favicon.svg",
        data: { url: "/patient/reminders" },
      });
      return;
    }

    new Notification(title, {
      body,
      icon: "/images/maternal-care-logo.png",
    });
  } catch {
    new Notification(title, {
      body,
      icon: "/images/maternal-care-logo.png",
    });
  }
}

function formatAppointmentMonth(dateValue) {
  const date = new Date(`${dateValue}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return "---";
  return date.toLocaleDateString("en-US", { timeZone: "Asia/Manila", month: "short" });
}

function formatAppointmentDay(dateValue) {
  const day = Number(String(dateValue || "").split("-")[2]);
  return Number.isFinite(day) && day > 0 ? String(day) : "--";
}

function formatAppointmentWeekday(dateValue) {
  const date = new Date(`${dateValue}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return "---";
  return date.toLocaleDateString("en-US", { timeZone: "Asia/Manila", weekday: "short" });
}

function formatAppointmentTime(timeValue) {
  if (!timeValue) return "";

  const [hour = "0", minute = "00"] = String(timeValue).split(":");
  const date = new Date();
  date.setHours(Number(hour), Number(minute), 0, 0);

  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function PatientPWAReminder({ profile }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [activeTab, setActiveTab] = useState("Today");
  const [tipIndex, setTipIndex] = useState(0);
  const [viewAllSection, setViewAllSection] = useState("");
  const [skipTarget, setSkipTarget] = useState(null);
  const [medicationActionSuccess, setMedicationActionSuccess] = useState("");
  const [medicationReloadToken, setMedicationReloadToken] = useState(0);
  const [patientRecordId, setPatientRecordId] = useState(
    profile?.recordId || ""
  );
  const [appointmentReminders, setAppointmentReminders] = useState([]);
  const [medicationReminders, setMedicationReminders] = useState([]);
  const [medicationOccurrences, setMedicationOccurrences] = useState([]);
  const [scheduleReminders, setScheduleReminders] = useState([]);
  const [healthTips, setHealthTips] = useState([]);
  const [isLoadingAppointmentReminders, setIsLoadingAppointmentReminders] = useState(true);
  const [isLoadingScheduleReminders, setIsLoadingScheduleReminders] = useState(true);
  const [isLoadingHealthTips, setIsLoadingHealthTips] = useState(true);
  const [isLoadingMedicationReminders, setIsLoadingMedicationReminders] = useState(true);
  const [isLoadingMedicationOccurrences, setIsLoadingMedicationOccurrences] = useState(false);
  const [medicationReminderError, setMedicationReminderError] = useState("");
  const [medicationActionState, setMedicationActionState] = useState({
    key: "",
    action: "",
  });
  const [medicationActionError, setMedicationActionError] = useState({
    key: "",
    message: "",
  });
  const notifiedReminderKeys = useRef(new Set());
  const loadedStateRef = useRef({
    appointments: false,
    schedule: false,
    healthTips: false,
    medication: false,
  });

  const medicationOccurrenceMap = useMemo(() => {
    return new Map(
      medicationOccurrences.map((occurrence) => [
        occurrence.matchKey,
        occurrence,
      ])
    );
  }, [medicationOccurrences]);

  const medicationList = useMemo(() => {
    return buildMedicationOccurrences(
      medicationReminders,
      activeTab,
      medicationOccurrences,
      medicationOccurrenceMap
    );
  }, [
    activeTab,
    medicationOccurrenceMap,
    medicationOccurrences,
    medicationReminders,
  ]);

  const todayMedicationList = useMemo(() => {
    return buildMedicationOccurrences(
      medicationReminders,
      "Today",
      medicationOccurrences,
      medicationOccurrenceMap
    );
  }, [
    medicationOccurrenceMap,
    medicationOccurrences,
    medicationReminders,
  ]);

  const appointmentList = useMemo(() => {
    const explicitAppointmentIds = new Set(
      appointmentReminders.map((reminder) => reminder.appointmentId)
    );

    const derivedReminders = scheduleReminders.filter(
      (reminder) =>
        !explicitAppointmentIds.has(reminder.appointmentId)
    );

    return [...appointmentReminders, ...derivedReminders].sort(
      (first, second) =>
        new Date(
          first.scheduleAt ||
            `${first.scheduleDate}T${
              first.scheduleTime || "00:00"
            }`
        ) -
        new Date(
          second.scheduleAt ||
            `${second.scheduleDate}T${
              second.scheduleTime || "00:00"
            }`
        )
    );
  }, [appointmentReminders, scheduleReminders]);

  const upcomingAppointment = useMemo(() => {
    return appointmentList.find((reminder) =>
      classifyAppointment({
        start:
          reminder.scheduleAt ||
          toManilaISOString(reminder.scheduleDate, reminder.scheduleTime || "00:00"),
        end: reminder.scheduleEndAt,
        status: reminder.scheduleStatus,
      }).isUpcoming
    ) || null;
  }, [appointmentList]);

  const isLoadingAppointmentData =
    isLoadingAppointmentReminders || isLoadingScheduleReminders;

  const safeTipIndex = healthTips.length
    ? Math.min(tipIndex, healthTips.length - 1)
    : 0;

  const activeTip = healthTips[safeTipIndex];
  const isHealthTipsViewAllOpen = viewAllSection === "healthTips";
  const isViewAllOpen = isHealthTipsViewAllOpen;
  const isMedicationScheduleScreen =
    location.pathname.replace(/\/$/, "") === "/patient/reminders/medications";

  const closeViewAllModal = () => {
    setViewAllSection("");
  };

  const loadMedicationOccurrenceRows = async (patientId) => {
    if (!patientId) {
      setMedicationOccurrences([]);
      setIsLoadingMedicationOccurrences(false);
      return [];
    }

    const queryRange = getMedicationOccurrenceQueryRange();

    if (!queryRange) {
      setMedicationOccurrences([]);
      setIsLoadingMedicationOccurrences(false);
      return [];
    }

    setIsLoadingMedicationOccurrences(true);

    const { data, error } = await supabase
      .from("medication_reminder_occurrences")
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
      .eq("patient_id", patientId)
      .gte("scheduled_for", queryRange.historyStart || queryRange.start)
      .lt("scheduled_for", queryRange.end)
      .order("scheduled_for", { ascending: true });

    setIsLoadingMedicationOccurrences(false);

    if (error) {
      if (isMissingMedicationOccurrenceError(error)) {
        setMedicationOccurrences([]);
        return [];
      }

      console.error("Patient medication occurrence load failed:", error);
      setMedicationOccurrences([]);
      return [];
    }

    const rows = (data || []).map(mapMedicationOccurrenceRow);
    setMedicationOccurrences(rows);
    return rows;
  };

  const handleMedicationOccurrenceAction = async (item, action, options = {}) => {
    const occurrenceId = item?.occurrence?.id;
    const actionKey = item?.matchKey || "";

    if (!occurrenceId || !actionKey) {
      return;
    }

    if (action === "skipped" && !options.confirmed) {
      setSkipTarget(item);
      return;
    }

    setMedicationActionState({ key: actionKey, action });
    setMedicationActionError({ key: "", message: "" });
    setMedicationActionSuccess("");
    if (action === "skipped") {
      setSkipTarget(null);
    }

    const { data, error } = await supabase.rpc(
      "mark_medication_reminder_occurrence",
      {
        p_occurrence_id: occurrenceId,
        p_action: action,
      }
    );

    if (error) {
      setMedicationActionState({ key: "", action: "" });
      setMedicationActionError({
        key: actionKey,
        message: "Unable to update this reminder. Please try again.",
      });
      return;
    }

    const result = Array.isArray(data) ? data[0] : data;
    const nextStatus = String(result?.status || action).toLowerCase();
    const actionAt = new Date().toISOString();

    setMedicationOccurrences((current) =>
      current.map((occurrence) =>
        occurrence.id === occurrenceId
          ? {
              ...occurrence,
              status: nextStatus,
              actionAt,
              missedAt: "",
              errorCode: "",
            }
          : occurrence
      )
    );
    setMedicationActionState({ key: "", action: "" });
    setMedicationActionSuccess(
      action === "skipped"
        ? "Medication dose recorded as skipped."
        : "Medication dose recorded as taken."
    );

    await loadMedicationOccurrenceRows(item.patientId || patientRecordId);
  };

  useEffect(() => {
    if (!isViewAllOpen) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setViewAllSection("");
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isViewAllOpen]);

  useEffect(() => {
    let active = true;

    const loadSupabaseReminders = async () => {
      if (!loadedStateRef.current.appointments) {
        setIsLoadingAppointmentReminders(true);
      }
      if (!loadedStateRef.current.healthTips) {
        setIsLoadingHealthTips(true);
      }
      if (!loadedStateRef.current.medication) {
        setIsLoadingMedicationReminders(true);
      }
      setIsLoadingMedicationOccurrences(true);
      setMedicationReminderError("");
      const patient = await loadAuthenticatedPatientRow();
      setPatientRecordId(patient?.id || profile?.recordId || "");
      let appointmentQuery = supabase
        .from("reminders")
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

      let medicationQuery = supabase
        .from("medication_reminders")
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

      const healthTipsQuery = supabase
        .from("health_tips")
        .select("*")
        .eq("is_active", true)
        .order("published_at", { ascending: false })
        .order("created_at", { ascending: false });

      if (patient?.id) {
        appointmentQuery = appointmentQuery.eq("patient_id", patient.id);
        medicationQuery = medicationQuery.eq("patient_id", patient.id);
      } else {
        if (!loadedStateRef.current.appointments) {
          setAppointmentReminders([]);
        }
        if (!loadedStateRef.current.medication) {
          setMedicationReminders([]);
        }
        loadedStateRef.current.appointments = true;
        loadedStateRef.current.medication = true;
        setMedicationOccurrences([]);
        setIsLoadingMedicationOccurrences(false);
        setIsLoadingMedicationReminders(false);
        setIsLoadingAppointmentReminders(false);
        setMedicationReminderError(
          "Unable to load medication reminders because no patient record is linked to this account."
        );

        const healthTipsResult = await healthTipsQuery;

        if (!active) {
          return;
        }

        if (healthTipsResult.error) {
          console.error(
            "Patient health tips load failed:",
            healthTipsResult.error
          );
          if (!loadedStateRef.current.healthTips) {
            setHealthTips([]);
          }
        } else {
          setHealthTips(
            dedupeHealthTips(
              [
                ...(healthTipsResult.data || []).map(mapHealthTipDatabaseRow),
                ...getStoredHealthTips({ includeDefaults: false }),
              ].filter(Boolean)
            )
          );
        }
        loadedStateRef.current.healthTips = true;
        setIsLoadingHealthTips(false);

        return;
      }

      const occurrenceQueryRange = getMedicationOccurrenceQueryRange();
      const occurrenceQuery = occurrenceQueryRange
        ? supabase
            .from("medication_reminder_occurrences")
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
            .eq("patient_id", patient.id)
            .gte("scheduled_for", occurrenceQueryRange.historyStart || occurrenceQueryRange.start)
            .lt("scheduled_for", occurrenceQueryRange.end)
            .order("scheduled_for", { ascending: true })
        : Promise.resolve({ data: [], error: null });

      const [
        appointmentResult,
        medicationResult,
        healthTipsResult,
        occurrenceResult,
      ] =
        await Promise.all([
          appointmentQuery,
          medicationQuery,
          healthTipsQuery,
          occurrenceQuery,
        ]);

      if (!active) {
        return;
      }

      if (appointmentResult.error) {
        console.error(
          "Patient appointment reminders load failed:",
          appointmentResult.error
        );
        if (!loadedStateRef.current.appointments) {
          setAppointmentReminders([]);
        }
      } else {
        setAppointmentReminders(
          (appointmentResult.data || [])
            .filter((row) => Boolean(patient?.id && row.patient_id === patient.id))
            .map(mapReminderDatabaseRow)
            .filter(
              (reminder) =>
                !isCancelledOrCompletedStatus(reminder.scheduleStatus) &&
                classifyAppointment({
                  start:
                    reminder.scheduleAt ||
                    toManilaISOString(reminder.scheduleDate, reminder.scheduleTime || "00:00"),
                  end: reminder.scheduleEndAt,
                  status: reminder.scheduleStatus,
                }).isUpcoming
            )
        );
      }
      loadedStateRef.current.appointments = true;
      setIsLoadingAppointmentReminders(false);

      if (medicationResult.error) {
        console.error(
          "Patient medication reminders load failed:",
          medicationResult.error
        );
        logMedicationReminderDebug("query error", {
          patientDatabaseId: patient?.id || null,
          error: medicationResult.error,
        });
        if (!loadedStateRef.current.medication) {
          setMedicationReminders([]);
          setMedicationReminderError(
            `Unable to load medication reminders: ${medicationResult.error.message}`
          );
        } else {
          setMedicationReminderError("");
        }
      } else {
        logMedicationReminderDebug("returned medication reminder count", {
          patientDatabaseId: patient?.id || null,
          count: medicationResult.data?.length || 0,
        });
        setMedicationReminders(
          (medicationResult.data || [])
            .filter((row) => Boolean(patient?.id && row.patient_id === patient.id))
            .map((row) => ({ ...row, patients: patient }))
            .map(mapMedicationDatabaseRow)
        );
        setMedicationReminderError("");
      }

      loadedStateRef.current.medication = true;
      setIsLoadingMedicationReminders(false);

      if (occurrenceResult.error) {
        if (!isMissingMedicationOccurrenceError(occurrenceResult.error)) {
          console.error(
            "Patient medication occurrences load failed:",
            occurrenceResult.error
          );
        }
        setMedicationOccurrences([]);
      } else {
        setMedicationOccurrences(
          (occurrenceResult.data || []).map(mapMedicationOccurrenceRow)
        );
      }
      setIsLoadingMedicationOccurrences(false);

      if (healthTipsResult.error) {
        console.error(
          "Patient health tips load failed:",
          healthTipsResult.error
        );
        if (!loadedStateRef.current.healthTips) {
          setHealthTips([]);
        }
      } else {
        const databaseTips = (healthTipsResult.data || [])
          .filter(
            (row) =>
              !row.patient_id ||
              patientMatchesValue(profile, row.patient_id) ||
              Boolean(patient?.id && row.patient_id === patient.id)
          )
          .map(mapHealthTipDatabaseRow)
          .filter(Boolean);

        setHealthTips(dedupeHealthTips(databaseTips));
        setTipIndex(0);
      }
      loadedStateRef.current.healthTips = true;
      setIsLoadingHealthTips(false);
    };

    loadSupabaseReminders();

    const handleWindowFocus = () => {
      loadSupabaseReminders();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        loadSupabaseReminders();
      }
    };

    const appointmentReminderChannel = supabase
      .channel("patient-appointment-reminders")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "reminders" },
        loadSupabaseReminders
      )
      .subscribe();

    const medicationReminderChannel = supabase
      .channel("patient-medication-reminders")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "medication_reminders",
        },
        loadSupabaseReminders
      )
      .subscribe();

    const healthTipsChannel = supabase
      .channel("patient-health-tips")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "health_tips" },
        loadSupabaseReminders
      )
      .subscribe();

    const refreshTimer = window.setInterval(loadSupabaseReminders, 15000);

    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      active = false;
      window.clearInterval(refreshTimer);
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      supabase.removeChannel(appointmentReminderChannel);
      supabase.removeChannel(medicationReminderChannel);
      supabase.removeChannel(healthTipsChannel);
    };
  }, [profile, medicationReloadToken]);

  useEffect(() => {
    let active = true;

    const loadPatientSchedule = async () => {
      if (!loadedStateRef.current.schedule) {
        setIsLoadingScheduleReminders(true);
      }
      const patient = await loadAuthenticatedPatientRow();
      const scheduleRows = await fetchPatientScheduleRows(patient);

      if (!active) return;

      setScheduleReminders(
        scheduleRows
          .map(mapScheduleRowToReminder)
      );
      loadedStateRef.current.schedule = true;
      setIsLoadingScheduleReminders(false);
    };

    loadPatientSchedule();

    const handleWindowFocus = () => {
      loadPatientSchedule();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        loadPatientSchedule();
      }
    };

    const channel = supabase
      .channel("patient-reminder-schedule")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "schedule" },
        loadPatientSchedule
      )
      .subscribe();

    const refreshTimer = window.setInterval(loadPatientSchedule, 15000);

    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      active = false;
      window.clearInterval(refreshTimer);
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      supabase.removeChannel(channel);
    };
  }, [profile]);

  useEffect(() => {
    const notifyDueReminders = () => {
      const now = Date.now();

      appointmentReminders.forEach((reminder) => {
        const notificationKey = `appointment-${reminder.id}`;
        const notifyTime = reminder.notifyAt
          ? new Date(reminder.notifyAt).getTime()
          : Number.NaN;

        if (
          !notifiedReminderKeys.current.has(notificationKey) &&
          Number.isFinite(notifyTime) &&
          notifyTime <= now &&
          !["Completed", "Missed"].includes(reminder.status)
        ) {
          notifiedReminderKeys.current.add(notificationKey);
          sendPatientNotification(reminder);
        }
      });
    };

    notifyDueReminders();
    const timer = window.setInterval(notifyDueReminders, 15000);

    return () => {
      window.clearInterval(timer);
    };
  }, [appointmentReminders]);

  const todaySummary = useMemo(() => {
    const taken = todayMedicationList.filter(
      (item) => item.occurrence?.status === "taken"
    ).length;
    const skipped = todayMedicationList.filter(
      (item) => item.occurrence?.status === "skipped"
    ).length;
    const missed = todayMedicationList.filter(
      (item) => item.occurrence?.status === "missed"
    ).length;
    const todayDoses = todayMedicationList.length;

    return { todayDoses, taken, skipped, missed };
  }, [todayMedicationList]);

  const recentAdherenceRows = useMemo(() => {
    const today = getLocalDateKey();
    const startDate = addDays(today, -6);
    const reminderById = new Map(
      medicationReminders.map((reminder) => [reminder.databaseId, reminder])
    );

    return medicationOccurrences
      .filter(
        (occurrence) =>
          occurrence.scheduleDate >= startDate &&
          occurrence.scheduleDate <= today
      )
      .map((occurrence) => {
        const reminder = reminderById.get(occurrence.medicationReminderId);
        const statusMeta = getMedicationOccurrenceStatus(
          {
            isActive: true,
            scheduleAt: occurrence.scheduledFor,
          },
          occurrence
        );

        return {
          ...occurrence,
          medication: reminder?.medication || "Medication",
          statusLabel: statusMeta.label,
          statusClassName: statusMeta.className,
          response: getMedicationResponseLabel(occurrence),
        };
      })
      .sort(
        (first, second) =>
          new Date(second.scheduledFor) - new Date(first.scheduledFor)
      )
      .slice(0, 10);
  }, [medicationOccurrences, medicationReminders]);

  if (isMedicationScheduleScreen) {
    return (
      <>
        <MedicationScheduleAdherenceScreen
          actionError={medicationActionError}
          actionState={medicationActionState}
          activeTab={activeTab}
          error={medicationReminderError}
          historyRows={recentAdherenceRows}
          isLoading={
            isLoadingMedicationReminders ||
            isLoadingMedicationOccurrences
          }
          items={medicationList}
          onBack={() => navigate("/patient/reminders")}
          onOccurrenceAction={handleMedicationOccurrenceAction}
          onRefresh={() => setMedicationReloadToken((current) => current + 1)}
          onTabChange={(tab) => {
            setActiveTab(tab);
            setMedicationReloadToken((current) => current + 1);
          }}
          summary={todaySummary}
          successMessage={medicationActionSuccess}
        />
        <SkipMedicationDialog
          actionState={medicationActionState}
          item={skipTarget}
          onCancel={() => setSkipTarget(null)}
          onConfirm={() =>
            handleMedicationOccurrenceAction(skipTarget, "skipped", {
              confirmed: true,
            })
          }
        />
      </>
    );
  }

  return (
    <section className="pwa-page pwa-reminders-page">
      <PatientPageHeader
        title="My Reminders"
        subtitle="See your next visit, medication schedule, and daily care guidance."
        className="pwa-reminders-title"
        action={(
          <span className="pwa-reminders-today" aria-live="polite">
            <Icon icon="solar:pills-3-bold-duotone" />
            <strong>{todaySummary.todayDoses}</strong>
            <span>{todaySummary.todayDoses === 1 ? "dose" : "doses"} today</span>
          </span>
        )}
      />

      <div className="pwa-reminder-top-grid">
        <section className="pwa-reminder-card pwa-upcoming-card">
          <ReminderHeader
            icon="solar:calendar-bold-duotone"
            title="Upcoming Appointments"
            onViewAll={() => navigate("/patient/appointments")}
            viewAllLabel="View all upcoming appointments"
          />

          <article className="pwa-upcoming-inner">
            {upcomingAppointment ? (
              <>
                <div className="pwa-reminder-appointment-main">
                  <div className="pwa-reminder-date-box">
                    <span>
                      {formatAppointmentMonth(
                        upcomingAppointment.scheduleDate
                      )}
                    </span>
                    <strong>
                      {formatAppointmentDay(
                        upcomingAppointment.scheduleDate
                      )}
                    </strong>
                    <small>
                      {formatAppointmentWeekday(
                        upcomingAppointment.scheduleDate
                      )}
                    </small>
                  </div>

                  <div className="pwa-reminder-appointment-copy">
                    <h3>{upcomingAppointment.appointmentType}</h3>
                    <div className="pwa-reminder-appointment-meta">
                      <span>
                        <Icon icon="solar:clock-circle-linear" />
                        {formatAppointmentTime(upcomingAppointment.scheduleTime)}
                      </span>
                      <em>{upcomingAppointment.status || "Pending"}</em>
                    </div>
                    <p>
                      <Icon icon="solar:briefcase-medical-linear" />{" "}
                      {upcomingAppointment.doctorName ||
                        "Healthcare provider"}
                    </p>
                  </div>
                </div>

                <div className="pwa-reminder-note">
                  <Icon icon="solar:bell-bing-bold" />
                  <div>
                    <strong>
                      {upcomingAppointment.message ||
                        "You have an appointment reminder."}
                    </strong>
                    <span>
                      Reminder status:{" "}
                      {upcomingAppointment.status || "Pending"}
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <div className="pwa-reminder-note">
                <Icon icon="solar:bell-bing-bold" />
                <div>
                  <strong>
                    {isLoadingAppointmentData
                      ? "Loading appointment reminders..."
                      : "No upcoming appointments."}
                  </strong>
                  <span>
                    {isLoadingAppointmentData
                      ? "Checking saved reminders and clinic appointments."
                      : "Saved reminders and upcoming appointments from your clinic will appear here."}
                  </span>
                </div>
              </div>
            )}
          </article>
        </section>

        <section className="pwa-reminder-card pwa-health-tips-card">
          <ReminderHeader
            icon="solar:lightbulb-bold-duotone"
            title="Daily Health Tips"
            tone="blue"
            onViewAll={() => setViewAllSection("healthTips")}
            viewAllLabel="View all daily health tips"
          />

          <article className="pwa-daily-tip">
            <div className="pwa-tip-phone" aria-hidden="true">
              <div className="pwa-tip-phone-screen">
                {activeTip ? (
                  <img
                    src={activeTip.image || "/images/preggy.png"}
                    alt=""
                  />
                ) : (
                  <Icon icon="solar:lightbulb-bold-duotone" />
                )}
              </div>
            </div>

            <div className="pwa-tip-copy">
              {isLoadingHealthTips && !healthTips.length ? (
                <>
                  <h3>Loading health tips...</h3>
                  <p>Checking daily guidance from your clinic.</p>
                </>
              ) : (
                <>
                  <h3>
                    {activeTip?.title ||
                      "No health tips are currently available."}
                  </h3>
                  {activeTip?.text ? <p>{activeTip.text}</p> : null}
                </>
              )}
            </div>
          </article>

          <div
            className="pwa-tip-dots"
            aria-label="Health tip carousel"
          >
            {healthTips.map((_, index) => (
              <button
                type="button"
                key={index}
                className={
                  index === safeTipIndex ? "is-active" : ""
                }
                onClick={() => setTipIndex(index)}
                aria-label={`Show health tip ${index + 1}`}
              />
            ))}
          </div>
        </section>
      </div>

      <section className="pwa-medication-card">
        <ReminderHeader
          icon="solar:case-round-minimalistic-bold-duotone"
          title="Medication Reminders"
          tone="violet"
          onViewAll={() => navigate("/patient/reminders/medications")}
          viewAllLabel="View all medication reminders"
        />

        <p className="pwa-medication-card-copy">
          Review each scheduled dose and record whether it was taken or skipped.
        </p>

        <div
          className="pwa-medication-tabs"
          role="tablist"
          aria-label="Medication reminder days"
        >
          {reminderTabs.map((tab) => (
            <button
              type="button"
              key={tab}
              className={
                activeTab === tab ? "is-active" : ""
              }
              onClick={() => setActiveTab(tab)}
              role="tab"
              aria-selected={activeTab === tab}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="pwa-medication-list">
          <MedicationReminderRows
            actionError={medicationActionError}
            actionState={medicationActionState}
            activeTab={activeTab}
            error={medicationReminderError}
            isLoading={
              isLoadingMedicationReminders ||
              isLoadingMedicationOccurrences
            }
            items={medicationList}
            onOccurrenceAction={handleMedicationOccurrenceAction}
            onOpenSchedule={() => navigate("/patient/reminders/medications")}
          />
        </div>
      </section>

      {isViewAllOpen ? (
        <div
          className="patient-reminder-view-all-backdrop"
          onClick={closeViewAllModal}
          role="presentation"
        >
          <section
            aria-labelledby="patient-reminder-view-all-title"
            aria-modal="true"
            className="patient-reminder-view-all-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header className="patient-reminder-view-all-header">
              <div>
                <h2 id="patient-reminder-view-all-title">
                  {isHealthTipsViewAllOpen
                    ? "All Daily Health Tips"
                    : "All Medication Reminders"}
                </h2>
                <p>
                  {isHealthTipsViewAllOpen
                    ? `${healthTips.length} active ${
                        healthTips.length === 1 ? "tip" : "tips"
                      }`
                    : `${medicationList.length} ${
                        activeTab.toLowerCase()
                      } ${
                        medicationList.length === 1
                          ? "reminder"
                          : "reminders"
                      }`}
                </p>
              </div>
              <button
                aria-label="Close view all reminders"
                className="patient-reminder-view-all-close"
                onClick={closeViewAllModal}
                type="button"
              >
                <Icon icon="solar:close-circle-bold" />
              </button>
            </header>

            {isHealthTipsViewAllOpen ? (
              <div className="patient-reminder-health-tip-list">
                {isLoadingHealthTips && !healthTips.length ? (
                  <article className="patient-reminder-view-all-empty">
                    <h3>Loading health tips...</h3>
                    <p>Checking daily guidance from your clinic.</p>
                  </article>
                ) : healthTips.length ? (
                  healthTips.map((tip) => (
                    <article
                      className="patient-reminder-health-tip-item"
                      key={tip.id || `${tip.title}-${tip.text}`}
                    >
                      <div className="patient-reminder-health-tip-image">
                        {tip.image ? (
                          <img src={tip.image} alt="" />
                        ) : (
                          <Icon icon="solar:lightbulb-bold-duotone" />
                        )}
                      </div>
                      <div>
                        <span>{tip.displaySchedule || "Daily"}</span>
                        <h3>{tip.title}</h3>
                        <p>{tip.text}</p>
                      </div>
                    </article>
                  ))
                ) : (
                  <article className="patient-reminder-view-all-empty">
                    <h3>No health tips are currently available.</h3>
                  </article>
                )}
              </div>
            ) : null}

          </section>
        </div>
      ) : null}

      <SkipMedicationDialog
        actionState={medicationActionState}
        item={skipTarget}
        onCancel={() => setSkipTarget(null)}
        onConfirm={() =>
          handleMedicationOccurrenceAction(skipTarget, "skipped", {
            confirmed: true,
          })
        }
      />
    </section>
  );
}

function MedicationScheduleAdherenceScreen({
  actionError,
  actionState,
  activeTab,
  error,
  historyRows,
  isLoading,
  items,
  onBack,
  onOccurrenceAction,
  onRefresh,
  onTabChange,
  summary,
  successMessage,
}) {
  const recordedDoses = summary.taken + summary.skipped + summary.missed;
  const adherencePercentage = recordedDoses
    ? Math.round((summary.taken / recordedDoses) * 100)
    : 0;
  const emptyTextByTab = {
    Today: "No medication doses are scheduled for today.",
    Tomorrow: "No medication doses are scheduled for tomorrow.",
    Upcoming: "No upcoming medication doses were found.",
  };
  const summaryCards = [
    {
      label: "Today's Doses",
      value: summary.todayDoses,
      icon: "solar:pills-3-bold",
      tone: "purple",
    },
    {
      label: "Taken",
      value: summary.taken,
      icon: "solar:check-circle-bold",
      tone: "green",
    },
    {
      label: "Skipped",
      value: summary.skipped,
      icon: "solar:minus-circle-bold",
      tone: "amber",
    },
    {
      label: "Missed",
      value: summary.missed,
      icon: "solar:close-circle-bold",
      tone: "red",
    },
  ];

  return (
    <section className="pwa-page pwa-medication-adherence-page">
      <div className="pwa-medication-adherence-title">
        <button type="button" onClick={onBack}>
          <Icon icon="solar:alt-arrow-left-linear" />
          Back to Reminders
        </button>
        <PatientPageHeader
          title="Medication Schedule & Adherence"
          subtitle="Review due doses and your recent medication history."
          className="pwa-medication-schedule-title"
        />
      </div>

      <section className="pwa-medication-adherence-banner">
        <span aria-hidden="true">
          <Icon icon="solar:bell-bing-bold-duotone" />
        </span>
        <div>
          <h2>Keep your medication record up to date</h2>
          <p>
            Mark each due dose as Taken or Skip. Unanswered doses are recorded
            as Missed after two hours.
          </p>
        </div>
        <strong className="pwa-medication-adherence-rate">
          {adherencePercentage}% today
        </strong>
      </section>

      <section className="pwa-medication-summary-grid" aria-label="Today's medication summary">
        {summaryCards.map((card) => (
          <article className={`pwa-medication-summary-card is-${card.tone}`} key={card.label}>
            <span aria-hidden="true">
              <Icon icon={card.icon} />
            </span>
            <div>
              <p>{card.label}</p>
              <strong>{card.value}</strong>
            </div>
          </article>
        ))}
      </section>

      <section className="pwa-medication-schedule-toolbar">
        <div className="pwa-medication-tabs" role="tablist" aria-label="Medication schedule dates">
          {reminderTabs.map((tab) => (
            <button
              type="button"
              key={tab}
              className={activeTab === tab ? "is-active" : ""}
              onClick={() => onTabChange(tab)}
              role="tab"
              aria-current={activeTab === tab ? "page" : undefined}
              aria-selected={activeTab === tab}
            >
              {tab}
            </button>
          ))}
        </div>
        <button
          className="pwa-medication-refresh"
          disabled={isLoading}
          onClick={onRefresh}
          type="button"
        >
          <Icon icon="solar:refresh-linear" />
          Refresh
        </button>
      </section>

      {successMessage ? (
        <p className="pwa-medication-success" role="status">{successMessage}</p>
      ) : null}

      <section className="pwa-medication-schedule-card">
        <header>
          <h2>{activeTab} Medication Schedule</h2>
          <p>{items.length} {items.length === 1 ? "dose" : "doses"}</p>
        </header>
        <MedicationReminderRows
          actionError={actionError}
          actionState={actionState}
          activeTab={activeTab}
          emptyText={emptyTextByTab[activeTab]}
          error={error}
          isLoading={isLoading}
          items={items}
          onOccurrenceAction={onOccurrenceAction}
          variant="schedule"
        />
      </section>

      <section className="pwa-medication-history-card">
        <header>
          <h2>Recent Adherence History</h2>
          <p>Last 7 days</p>
        </header>
        <MedicationAdherenceHistory rows={historyRows} />
      </section>
    </section>
  );
}

function MedicationAdherenceHistory({ rows }) {
  if (!rows.length) {
    return (
      <div className="pwa-medication-history-empty">
        No medication adherence history is available yet.
      </div>
    );
  }

  return (
    <div className="pwa-medication-history-table-wrap">
      <table className="pwa-medication-history-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Time</th>
            <th>Medication</th>
            <th>Status</th>
            <th>Response</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{formatMedicationTimestampDate(row.scheduledFor)}</td>
              <td>{formatMedicationTimestampTime(row.scheduledFor)}</td>
              <td>{row.medication}</td>
              <td>
                <span className={`pwa-status-chip is-${row.statusClassName}`}>
                  {row.statusLabel}
                </span>
              </td>
              <td>{row.response}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SkipMedicationDialog({ actionState, item, onCancel, onConfirm }) {
  if (!item) return null;

  const isSkipping = actionState?.key === item.matchKey && actionState.action === "skipped";

  return (
    <div className="pwa-medication-skip-backdrop" role="presentation" onClick={isSkipping ? undefined : onCancel}>
      <section
        aria-labelledby="pwa-medication-skip-title"
        aria-modal="true"
        className="pwa-medication-skip-dialog"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="pwa-medication-skip-title">Skip this medication dose?</h2>
        <p>This dose will be recorded as skipped in your medication adherence history.</p>
        <div>
          <button type="button" onClick={onCancel} disabled={isSkipping}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={isSkipping}>
            {isSkipping ? "Saving..." : "Skip Dose"}
          </button>
        </div>
      </section>
    </div>
  );
}

function MedicationReminderRows({
  actionError,
  actionState,
  activeTab,
  emptyText,
  error,
  isLoading,
  items,
  onOccurrenceAction,
  onOpenSchedule,
  variant = "compact",
}) {
  if (isLoading) {
    return (
      <article className="pwa-medication-row pwa-medication-row--empty is-loading" aria-busy="true">
        <span className="pwa-medication-state-icon" aria-hidden="true">
          <Icon icon="solar:refresh-circle-bold" />
        </span>
        <div className="pwa-medication-copy">
          <h3>Loading medication reminders...</h3>
          <p>Checking the latest schedule linked to your patient record.</p>
        </div>
      </article>
    );
  }

  if (error) {
    return (
      <article className="pwa-medication-row pwa-medication-row--empty is-error" role="alert">
        <span className="pwa-medication-state-icon" aria-hidden="true">
          <Icon icon="solar:danger-triangle-bold" />
        </span>
        <div className="pwa-medication-copy">
          <h3>Medication schedule could not be loaded. Please try again.</h3>
          <p>Use Refresh to check your medication schedule again.</p>
        </div>
      </article>
    );
  }

  if (!items.length) {
    return (
      <article className="pwa-medication-row pwa-medication-row--empty">
        <span className="pwa-medication-state-icon" aria-hidden="true">
          <Icon icon="solar:pills-3-bold-duotone" />
        </span>
        <div className="pwa-medication-copy">
          <h3>{emptyText || "No medication reminders for this period."}</h3>
          <p>{emptyText ? "" : `No medication reminders match the selected ${activeTab.toLowerCase()} tab.`}</p>
          {onOpenSchedule ? (
            <button className="pwa-medication-empty-action" onClick={onOpenSchedule} type="button">
              Open medication schedule
              <Icon icon="solar:arrow-right-linear" />
            </button>
          ) : null}
        </div>
      </article>
    );
  }

  return items.map((item) => {
    const key =
      item.id ||
      `${activeTab}-${item.scheduleTime}-${item.medication}`;

    const status = item.status || "Pending";
    const statusClassName = item.statusClassName || getStatusClass(status);
    const isSubmittingAction = actionState?.key === item.matchKey;
    const rowActionError =
      actionError?.key === item.matchKey ? actionError.message : "";

    return (
      <article className={`pwa-medication-row pwa-medication-row--${variant}`} key={key}>
        <div className="pwa-medication-times" aria-label="Medication times">
          {item.reminderTimes.map((timeValue) => (
            <time key={`${key}-${timeValue}`}>
              {formatAppointmentTime(timeValue)}
            </time>
          ))}
        </div>

        <div className="pwa-medication-copy">
          <h3>{item.medication}</h3>
          <p>
            <Icon icon="solar:clipboard-list-linear" /> {item.dosage}
            <Icon icon="solar:refresh-linear" />{" "}
            {item.frequency || "As prescribed"}
          </p>
          {item.duration || item.message ? (
            <p className="pwa-medication-details">
              {item.duration ? `Duration: ${item.duration}` : null}
              {item.duration && item.message ? " | " : null}
              {item.message || null}
            </p>
          ) : null}
        </div>

        <div className="pwa-status-wrap">
          <span
            className={`pwa-status-chip is-${statusClassName}`}
          >
            {status}
          </span>
          {item.canMarkMedicationAction ? (
            <div className="pwa-medication-actions">
              <button
                aria-label={`Mark ${item.medication} as taken`}
                className="pwa-medication-action-primary"
                disabled={isSubmittingAction}
                onClick={() => onOccurrenceAction(item, "taken")}
                type="button"
              >
                {isSubmittingAction && actionState.action === "taken"
                  ? "Saving..."
                  : "Taken"}
              </button>
              <button
                aria-label={`Skip ${item.medication} reminder`}
                className="pwa-medication-action-secondary"
                disabled={isSubmittingAction}
                onClick={() => onOccurrenceAction(item, "skipped")}
                type="button"
              >
                {isSubmittingAction && actionState.action === "skipped"
                  ? "Saving..."
                  : "Skip"}
              </button>
            </div>
          ) : null}
          {rowActionError ? (
            <p className="pwa-medication-action-error" role="alert">
              {rowActionError}
            </p>
          ) : null}
        </div>

        {onOpenSchedule ? (
          <button
            aria-label="Open Medication Schedule and Adherence"
            className="pwa-row-chevron pwa-row-chevron-button"
            onClick={onOpenSchedule}
            type="button"
          >
            <Icon icon="solar:alt-arrow-right-linear" />
          </button>
        ) : null}
      </article>
    );
  });
}

function ReminderHeader({
  icon,
  onViewAll,
  title,
  tone = "pink",
  viewAllLabel,
}) {
  return (
    <header className="pwa-reminder-card-header">
      <span className={`is-${tone}`}>
        <Icon icon={icon} />
      </span>
      <h2>{title}</h2>
      <button
        aria-label={viewAllLabel}
        className="patient-reminder-view-all"
        onClick={onViewAll}
        type="button"
      >
        View All
        <Icon icon="solar:arrow-right-linear" />
      </button>
    </header>
  );
}
