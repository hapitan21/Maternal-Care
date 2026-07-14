import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { supabase } from "../../lib/supabaseClient";
import {
  getStoredHealthTips,
  mapScheduleRowToReminder,
  patientMatchesValue,
} from "../../lib/patientData";

const reminderTabs = ["Today", "Tomorrow", "Upcoming"];
const statusOptions = ["Pending", "Completed", "Missed"];

const fallbackHealthTips = [
  {
    id: "hydration",
    category: "Nutrition",
    title: "Hydration",
    text: "Drink at least 8 glasses of water daily.",
    displaySchedule: "Daily",
  },
  {
    id: "vitamins",
    category: "Nutrition",
    title: "Vitamins",
    text: "Never skip prenatal vitamins.",
    displaySchedule: "Daily",
  },
  {
    id: "rest",
    category: "Exercise",
    title: "Rest",
    text: "Get enough sleep during pregnancy.",
    displaySchedule: "Daily",
  },
];

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

function mergeHealthTipsWithFallback(databaseTips) {
  return [...databaseTips, ...fallbackHealthTips].filter(
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
    .from("patients")
    .select("id, full_name, patient_id, user_id, email, contact_number")
    .eq("user_id", user.id)
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

  const { data, error } = await supabase
    .from("schedule")
    .select(columns)
    .eq("patient_id", patient.id)
    .gte("start_time", new Date().toISOString())
    .order("start_time", { ascending: true });

  if (error) {
    console.error("[Patient Appointment Flow] reminder appointment fetch error:", error);
    return [];
  }

  console.info("[Patient Appointment Flow] reminder returned appointment count:", data?.length || 0);

  return (data || [])
    .filter((row) => new Date(row.start_time) >= new Date())
    .filter(
      (row, index, source) =>
        source.findIndex((item) => String(item.id) === String(row.id)) === index
    );
}

function getLocalDateKey(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);

  if (Number.isNaN(value.getTime())) {
    return "";
  }

  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function addDays(dateValue, amount) {
  const date = new Date(`${dateValue}T00:00:00`);
  date.setDate(date.getDate() + amount);
  return getLocalDateKey(date);
}

function normalizeDatabaseTime(value) {
  if (!value) return "";
  return String(value).slice(0, 5);
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
  if (normalizedStatus === "paused") return "Pending";
  return "Pending";
}

function mapReminderDatabaseRow(row) {
  const appointment = getRelatedRecord(row.schedule);
  const patient = getRelatedRecord(row.patients);
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
    scheduleDate: getLocalDateKey(scheduleAt),
    scheduleTime: scheduleAt
      ? `${String(new Date(scheduleAt).getHours()).padStart(2, "0")}:${String(
          new Date(scheduleAt).getMinutes()
        ).padStart(2, "0")}`
      : "",
    scheduleAt,
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

  const firstPossibleDate =
    reminder.startDate > today ? reminder.startDate : today;

  return isDateInsideMedicationRange(firstPossibleDate, reminder)
    ? firstPossibleDate
    : "";
}

function buildMedicationOccurrences(reminders, tab) {
  return reminders.flatMap((reminder) => {
    const occurrenceDate = getMedicationOccurrenceDate(reminder, tab);

    if (!occurrenceDate) {
      return [];
    }

    return reminder.reminderTimes.map((timeValue, index) => {
      const scheduleAt = `${occurrenceDate}T${timeValue || "08:00"}:00`;

      return {
        ...reminder,
        id: `${reminder.databaseId}-${occurrenceDate}-${timeValue}-${index}`,
        scheduleDate: occurrenceDate,
        scheduleTime: timeValue,
        scheduleAt,
        notifyAt: scheduleAt,
      };
    });
  });
}

function buildMedicationCards(reminders, tab) {
  return reminders
    .map((reminder) => {
      const occurrenceDate = getMedicationOccurrenceDate(reminder, tab);

      if (!occurrenceDate) {
        return null;
      }

      const sortedTimes = [...reminder.reminderTimes]
        .map(normalizeDatabaseTime)
        .filter(Boolean)
        .sort();
      const firstTime = sortedTimes[0] || "08:00";

      return {
        ...reminder,
        id: `${reminder.databaseId}-${occurrenceDate}`,
        scheduleDate: occurrenceDate,
        scheduleTime: firstTime,
        reminderTimes: sortedTimes,
        scheduleAt: `${occurrenceDate}T${firstTime}:00`,
        notifyAt: `${occurrenceDate}T${firstTime}:00`,
      };
    })
    .filter(Boolean);
}

async function sendPatientNotification(reminder, kind) {
  if (
    typeof window === "undefined" ||
    !("Notification" in window) ||
    Notification.permission !== "granted"
  ) {
    return;
  }

  const title =
    kind === "medication"
      ? "Medication Reminder"
      : "Appointment Reminder";

  const body =
    reminder.message ||
    (kind === "medication"
      ? `Time to take ${reminder.medication || "your medication"}.`
      : "You have an appointment reminder.");

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
  const date = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "---";
  return date.toLocaleDateString("en-US", { month: "short" });
}

function formatAppointmentDay(dateValue) {
  const date = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "--";
  return String(date.getDate());
}

function formatAppointmentWeekday(dateValue) {
  const date = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "---";
  return date.toLocaleDateString("en-US", { weekday: "short" });
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
  const [activeTab, setActiveTab] = useState("Today");
  const [tipIndex, setTipIndex] = useState(0);
  const [openStatusKey, setOpenStatusKey] = useState(null);
  const [statusOverrides, setStatusOverrides] = useState({});
  const [appointmentReminders, setAppointmentReminders] = useState([]);
  const [medicationReminders, setMedicationReminders] = useState([]);
  const [scheduleReminders, setScheduleReminders] = useState([]);
  const [healthTips, setHealthTips] = useState(fallbackHealthTips);
  const [isLoadingMedicationReminders, setIsLoadingMedicationReminders] = useState(true);
  const [medicationReminderError, setMedicationReminderError] = useState("");
  const notifiedReminderKeys = useRef(new Set());

  const medicationList = useMemo(
    () =>
      buildMedicationCards(medicationReminders, activeTab).sort(
        (first, second) =>
          new Date(first.scheduleAt) - new Date(second.scheduleAt)
      ),
    [activeTab, medicationReminders]
  );

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
    const now = new Date();

    return (
      appointmentList.find(
        (reminder) =>
          new Date(
            reminder.scheduleAt ||
              `${reminder.scheduleDate}T${
                reminder.scheduleTime || "00:00"
              }`
          ) >= now
      ) ||
      appointmentList[0] ||
      null
    );
  }, [appointmentList]);

  const safeTipIndex = healthTips.length
    ? Math.min(tipIndex, healthTips.length - 1)
    : 0;

  const activeTip = healthTips[safeTipIndex];

  useEffect(() => {
    let active = true;

    const loadSupabaseReminders = async () => {
      setIsLoadingMedicationReminders(true);
      setMedicationReminderError("");
      const patient = await loadAuthenticatedPatientRow();
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
          patients (
            id,
            full_name,
            patient_id
          )
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
        setAppointmentReminders([]);
        setMedicationReminders([]);
        setIsLoadingMedicationReminders(false);
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
          setHealthTips(fallbackHealthTips);
        } else {
          setHealthTips(
            mergeHealthTipsWithFallback(
              [
                ...(healthTipsResult.data || []).map(mapHealthTipDatabaseRow),
                ...getStoredHealthTips(),
              ].filter(Boolean)
            )
          );
        }

        return;
      }

      const [appointmentResult, medicationResult, healthTipsResult] =
        await Promise.all([
          appointmentQuery,
          medicationQuery,
          healthTipsQuery,
        ]);

      if (!active) {
        return;
      }

      if (appointmentResult.error) {
        console.error(
          "Patient appointment reminders load failed:",
          appointmentResult.error
        );
        setAppointmentReminders([]);
      } else {
        setAppointmentReminders(
          (appointmentResult.data || [])
            .filter((row) => Boolean(patient?.id && row.patient_id === patient.id))
            .map(mapReminderDatabaseRow)
        );
      }

      if (medicationResult.error) {
        console.error(
          "Patient medication reminders load failed:",
          medicationResult.error
        );
        logMedicationReminderDebug("query error", {
          patientDatabaseId: patient?.id || null,
          error: medicationResult.error,
        });
        setMedicationReminders([]);
        setMedicationReminderError(
          `Unable to load medication reminders: ${medicationResult.error.message}`
        );
      } else {
        logMedicationReminderDebug("returned medication reminder count", {
          patientDatabaseId: patient?.id || null,
          count: medicationResult.data?.length || 0,
        });
        setMedicationReminders(
          (medicationResult.data || [])
            .filter((row) => Boolean(patient?.id && row.patient_id === patient.id))
            .map(mapMedicationDatabaseRow)
        );
        setMedicationReminderError("");
      }

      setIsLoadingMedicationReminders(false);

      if (healthTipsResult.error) {
        console.error(
          "Patient health tips load failed:",
          healthTipsResult.error
        );
        setHealthTips(fallbackHealthTips);
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

        setHealthTips(mergeHealthTipsWithFallback(databaseTips));
        setTipIndex(0);
      }
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
  }, [profile]);

  useEffect(() => {
    let active = true;

    const loadPatientSchedule = async () => {
      const patient = await loadAuthenticatedPatientRow();
      const scheduleRows = await fetchPatientScheduleRows(patient);

      if (!active) return;

      setScheduleReminders(
        scheduleRows
          .map(mapScheduleRowToReminder)
      );
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
          sendPatientNotification(reminder, "appointment");
        }
      });

      buildMedicationOccurrences(
        medicationReminders,
        "Today"
      ).forEach((reminder) => {
        const notificationKey = `medication-${reminder.id}`;
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
          sendPatientNotification(reminder, "medication");
        }
      });
    };

    notifyDueReminders();
    const timer = window.setInterval(notifyDueReminders, 15000);

    return () => {
      window.clearInterval(timer);
    };
  }, [appointmentReminders, medicationReminders]);

  const handleStatusChange = (key, value) => {
    setStatusOverrides((previous) => ({
      ...previous,
      [key]: value,
    }));
    setOpenStatusKey(null);
  };

  return (
    <section className="pwa-page pwa-reminders-page">
      <header className="pwa-page-title pwa-reminders-title">
        <h1>My Reminders</h1>
      </header>

      <div className="pwa-reminder-top-grid">
        <section className="pwa-reminder-card pwa-upcoming-card">
          <ReminderHeader
            icon="solar:calendar-bold-duotone"
            title="Upcoming Appointments"
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
                    <h3>
                      <span>
                        {formatAppointmentTime(
                          upcomingAppointment.scheduleTime
                        )}
                      </span>{" "}
                      {upcomingAppointment.appointmentType}
                    </h3>
                    <em>
                      {upcomingAppointment.status || "Pending"}
                    </em>
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
                    No appointment reminders yet.
                  </strong>
                  <span>
                    Saved reminders and upcoming appointments from
                    your clinic will appear here.
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
          />

          <article className="pwa-daily-tip">
            <div className="pwa-tip-phone" aria-hidden="true">
              <div className="pwa-tip-phone-screen">
                <span>🤰</span>
              </div>
            </div>

            <div className="pwa-tip-copy">
              <h3>
                {activeTip?.title || "No health tips yet."}
              </h3>
              <p>
                {activeTip?.text ||
                  "Doctor health tips will appear here when added."}
              </p>
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
        />

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
              onClick={() => {
                setActiveTab(tab);
                setOpenStatusKey(null);
              }}
              role="tab"
              aria-selected={activeTab === tab}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="pwa-medication-list">
          {isLoadingMedicationReminders ? (
            <article className="pwa-medication-row pwa-medication-row--empty">
              <div className="pwa-medication-copy">
                <h3>Loading medication reminders...</h3>
                <p>Checking reminders linked to your patient record.</p>
              </div>
            </article>
          ) : medicationReminderError ? (
            <article className="pwa-medication-row pwa-medication-row--empty">
              <div className="pwa-medication-copy">
                <h3>Medication reminders could not be loaded.</h3>
                <p>{medicationReminderError}</p>
              </div>
            </article>
          ) : medicationList.length > 0 ? (
            medicationList.map((item) => {
              const key =
                item.id ||
                `${activeTab}-${item.scheduleTime}-${item.medication}`;

              const status =
                statusOverrides[key] ||
                item.status ||
                "Pending";

              return (
                <article
                  className="pwa-medication-row"
                  key={key}
                >
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
                      <Icon icon="solar:clipboard-list-linear" />{" "}
                      {item.dosage}
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
                    <button
                      type="button"
                      className={`pwa-status-chip is-${getStatusClass(
                        status
                      )}`}
                      onClick={() =>
                        setOpenStatusKey(
                          openStatusKey === key ? null : key
                        )
                      }
                      aria-expanded={openStatusKey === key}
                    >
                      {status}
                    </button>

                    {openStatusKey === key ? (
                      <div className="pwa-status-menu">
                        {statusOptions.map((option) => (
                          <button
                            type="button"
                            key={option}
                            className={`is-${getStatusClass(
                              option
                            )}`}
                            onClick={() =>
                              handleStatusChange(key, option)
                            }
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <button
                    type="button"
                    className="pwa-row-chevron"
                    aria-label={`Open ${item.medication}`}
                  >
                    <Icon icon="solar:alt-arrow-right-linear" />
                  </button>
                </article>
              );
            })
          ) : (
            <article className="pwa-medication-row pwa-medication-row--empty">
              <div className="pwa-medication-copy">
                <h3>No medication reminders yet.</h3>
                <p>
                  No medication reminders match the selected {activeTab.toLowerCase()} tab.
                </p>
              </div>
            </article>
          )}
        </div>
      </section>
    </section>
  );
}

function ReminderHeader({ icon, title, tone = "pink" }) {
  return (
    <header className="pwa-reminder-card-header">
      <span className={`is-${tone}`}>
        <Icon icon={icon} />
      </span>
      <h2>{title}</h2>
      <button type="button">View All</button>
    </header>
  );
}
