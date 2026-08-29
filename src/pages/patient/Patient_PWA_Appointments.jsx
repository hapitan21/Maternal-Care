import { Fragment, useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { supabase } from "../../lib/supabaseClient";
import {
  classifyAppointment,
  getManilaDateKey,
  getManilaTimeKey,
} from "../../lib/appointmentDate";
import { PatientPageHeader } from "../../components/patient/PatientPwaUi";
import "../../styles/patient-PWA-appointments.css";

const scheduleColumns =
  "id, patient_id, patient_name, doctor_name, title, description, start_time, end_time, status";

const TIME_ROWS = Array.from({ length: 11 }, (_, index) => {
  const hour = index + 7;
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour > 12 ? hour - 12 : hour;

  return {
    label: `${String(displayHour).padStart(2, "0")} ${suffix}`,
    hour,
  };
});

const WEEKDAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const SHORT_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function cloneDate(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function toDate(value) {
  return new Date(value);
}

function toManilaCalendarDate(value) {
  const [year, month, day] = getManilaDateKey(value).split("-").map(Number);
  return year && month && day ? new Date(year, month - 1, day) : new Date(value);
}

function getMonday(date) {
  const copied = cloneDate(date);
  const day = copied.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  copied.setDate(copied.getDate() + diff);
  return copied;
}

function addDays(date, amount) {
  const next = cloneDate(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function addMonths(date, amount) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function formatRange(start, end) {
  const sameMonth = start.getMonth() === end.getMonth();
  const sameYear = start.getFullYear() === end.getFullYear();

  if (sameMonth && sameYear) {
    return `${MONTH_NAMES[start.getMonth()]} ${start.getDate()} - ${MONTH_NAMES[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
  }

  if (sameYear) {
    return `${MONTH_NAMES[start.getMonth()]} ${start.getDate()} - ${MONTH_NAMES[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
  }

  return `${MONTH_NAMES[start.getMonth()]} ${start.getDate()}, ${start.getFullYear()} - ${MONTH_NAMES[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
}

function formatTime(date) {
  return date.toLocaleTimeString("en-US", {
    timeZone: "Asia/Manila",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatAppointmentTime(appointment) {
  return `${formatTime(toDate(appointment.start))} - ${formatTime(toDate(appointment.end))}`;
}

function daysUntil(date) {
  const today = cloneDate(new Date());
  const target = cloneDate(date);
  const diff = Math.ceil((target - today) / (1000 * 60 * 60 * 24));

  if (diff < 0) return `${Math.abs(diff)} days ago`;
  if (diff === 0) return "Today";
  if (diff === 1) return "1 day to go";
  return `${diff} days to go`;
}

function buildMonthCells(monthDate) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const mondayIndex = (firstDay.getDay() + 6) % 7;
  const start = addDays(firstDay, -mondayIndex);

  return Array.from({ length: 42 }, (_, index) => {
    const date = addDays(start, index);
    return {
      date,
      muted: date.getMonth() !== month,
    };
  });
}

function getAppointmentOnDate(date, appointments) {
  return appointments.find((appointment) =>
    isSameDay(toManilaCalendarDate(appointment.start), date)
  );
}

function getEventsForCell(day, hour, appointments) {
  return appointments.filter((appointment) => {
    const start = toManilaCalendarDate(appointment.start);
    const appointmentHour = Number(getManilaTimeKey(appointment.start).split(":")[0]);
    return isSameDay(start, day) && appointmentHour === hour;
  });
}

function isCancelledOrCompleted(appointment) {
  const normalized = String(appointment?.status || appointment?.displayStatus || "").toLowerCase();
  return normalized.includes("cancel") || normalized.includes("complete");
}

function isUpcomingAppointment(appointment) {
  if (isCancelledOrCompleted(appointment)) return false;
  return classifyAppointment(appointment).isUpcoming;
}

function getAppointmentSortTime(appointment) {
  const start = toDate(appointment?.start);
  return Number.isNaN(start.getTime()) ? Number.POSITIVE_INFINITY : start.getTime();
}

function getStatusClass(status) {
  const normalized = String(status || "").toLowerCase();

  if (normalized === "completed") return "is-completed";
  if (normalized === "cancelled") return "is-cancelled";
  if (normalized === "missed") return "is-missed";
  if (normalized.includes("checked")) return "is-checked-in";
  return "is-upcoming";
}

function sortAppointmentsAscending(first, second) {
  return getAppointmentSortTime(first) - getAppointmentSortTime(second);
}

function sortAppointmentsDescending(first, second) {
  return getAppointmentSortTime(second) - getAppointmentSortTime(first);
}

function mapScheduleToAppointment(row) {
  const classification = classifyAppointment(row);
  return {
    id: row.id,
    patientId: row.patient_id || "",
    patientName: row.patient_name || "",
    title: row.title || row.description || "Appointment",
    start: row.start_time,
    end: row.end_time,
    doctor: row.doctor_name || "Doctor not recorded",
    status: row.status || "scheduled",
    displayStatus: classification.displayStatus,
    color: "pink",
  };
}

function getRelatedRecord(value) {
  return Array.isArray(value) ? value[0] : value;
}

function mapReminderToAppointment(row) {
  const schedule = getRelatedRecord(row.schedule);

  if (schedule?.id && schedule?.start_time) {
    return mapScheduleToAppointment(schedule);
  }

  if (!row.remind_at) return null;

  const start = toDate(row.remind_at);
  if (Number.isNaN(start.getTime())) return null;

  const end = new Date(start);
  end.setHours(end.getHours() + 1);

  return {
    id: row.schedule_id || `reminder-${row.id}`,
    patientId: row.patient_id || "",
    patientName: row.patients?.full_name || "",
    title: String(row.title || "Appointment Reminder").replace(/\s*Reminder$/i, ""),
    start: start.toISOString(),
    end: end.toISOString(),
    doctor: schedule?.doctor_name || "Doctor not recorded",
    status: row.status || "scheduled",
    displayStatus: classifyAppointment({
      start: start.toISOString(),
      end: end.toISOString(),
      status: row.status,
    }).displayStatus,
    color: "pink",
  };
}

async function loadAuthenticatedPatientRow() {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user?.id) {
    console.error("[Patient Appointment Flow] authenticated user lookup failed:", authError);
    return null;
  }

  console.info("[Patient Appointment Flow] authenticated user ID:", user.id);

  const { data, error } = await supabase
    .rpc("get_patient_own_record")
    .select("id, full_name, patient_id, user_id, email, contact_number")
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[Patient Appointment Flow] patient record fetch error:", error);
    return null;
  }

  console.info("[Patient Appointment Flow] resolved patient database ID:", data?.id || null);
  return data || null;
}

async function fetchPatientScheduleRows(patient) {
  if (!patient?.id) {
    console.warn("[Patient Appointment Flow] no resolved patient database ID; skipping schedule fetch.");
    return [];
  }

  const { data, error } = await supabase
    .from("schedule")
    .select(scheduleColumns)
    .eq("patient_id", patient.id)
    .order("start_time", { ascending: true });

  if (error) {
    console.error("[Patient Appointment Flow] appointment fetch error:", error);
    return [];
  }

  console.info("[Patient Appointment Flow] returned appointment count:", data?.length || 0);
  return data || [];
}

async function fetchPatientAppointmentReminderRows(patient) {
  if (!patient?.id) {
    return [];
  }

  const reminderSelect = `
    id,
    patient_id,
    schedule_id,
    reminder_type,
    title,
    remind_at,
    status,
    schedule (
      ${scheduleColumns}
    )
  `;
  const { data, error } = await supabase
    .from("reminders")
    .select(reminderSelect)
    .eq("reminder_type", "appointment")
    .eq("patient_id", patient.id)
    .order("remind_at", { ascending: true });

  if (error) {
    console.error("[Patient Appointment Flow] appointment reminder fetch error:", error);
    return [];
  }

  return data || [];
}

export default function PatientPWAAppointments({ profile }) {
  const [appointments, setAppointments] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeView, setActiveView] = useState("upcoming");
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });

  useEffect(() => {
    let active = true;

    const loadAppointments = async () => {
      setIsLoading(true);

      const patient = await loadAuthenticatedPatientRow();
      const [scheduleRows, reminderRows] = await Promise.all([
        fetchPatientScheduleRows(patient),
        fetchPatientAppointmentReminderRows(patient),
      ]);

      if (!active) return;

      setIsLoading(false);

      const scheduleAppointments = scheduleRows.map(mapScheduleToAppointment);
      const reminderAppointments = reminderRows
        .filter((row) => Boolean(patient?.id && row.patient_id === patient.id))
        .map(mapReminderToAppointment)
        .filter(Boolean);
      const mapped = [
        ...scheduleAppointments,
        ...reminderAppointments,
      ]
        .filter(
          (appointment, index, source) =>
            source.findIndex((item) => item.id === appointment.id) === index
        )
        .sort(sortAppointmentsAscending);
      setAppointments(mapped);

      const firstVisibleAppointment = mapped.find(isUpcomingAppointment) || null;

      if (firstVisibleAppointment?.start) {
        const appointmentDate = toManilaCalendarDate(firstVisibleAppointment.start);
        setSelectedDate(appointmentDate);
        setCalendarMonth(new Date(appointmentDate.getFullYear(), appointmentDate.getMonth(), 1));
      }
    };

    loadAppointments();

    const handleWindowFocus = () => {
      loadAppointments();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        loadAppointments();
      }
    };

    const channel = supabase
      .channel("patient-pwa-appointments")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "schedule" },
        loadAppointments
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "reminders" },
        loadAppointments
      )
      .subscribe();

    const refreshTimer = window.setInterval(loadAppointments, 10000);

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

  const upcomingAppointments = useMemo(
    () => appointments.filter(isUpcomingAppointment).sort(sortAppointmentsAscending),
    [appointments]
  );
  const historyAppointments = useMemo(
    () => appointments.filter((appointment) => !isUpcomingAppointment(appointment)).sort(sortAppointmentsDescending),
    [appointments]
  );
  const visibleAppointments = activeView === "history"
    ? historyAppointments
    : upcomingAppointments;
  const nextUpcomingAppointment = upcomingAppointments[0] || null;
  const displayedAppointment = nextUpcomingAppointment;
  const displayedDate = displayedAppointment
    ? toManilaCalendarDate(displayedAppointment.start)
    : null;

  const weekStart = useMemo(() => getMonday(selectedDate), [selectedDate]);
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)),
    [weekStart]
  );
  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart]);
  const monthCells = useMemo(() => buildMonthCells(calendarMonth), [calendarMonth]);
  const selectedDayAppointments = useMemo(
    () =>
      visibleAppointments
        .filter((appointment) =>
          isSameDay(toManilaCalendarDate(appointment.start), selectedDate)
        )
        .sort(activeView === "history" ? sortAppointmentsDescending : sortAppointmentsAscending),
    [activeView, selectedDate, visibleAppointments]
  );

  const handleSelectDate = (date) => {
    setSelectedDate(cloneDate(date));
    setCalendarMonth(new Date(date.getFullYear(), date.getMonth(), 1));
  };

  const goToPreviousMonth = () => {
    const nextMonth = addMonths(calendarMonth, -1);
    setCalendarMonth(nextMonth);
  };

  const goToNextMonth = () => {
    const nextMonth = addMonths(calendarMonth, 1);
    setCalendarMonth(nextMonth);
  };

  const handleViewChange = (nextView) => {
    setActiveView(nextView);

    const firstAppointment = nextView === "history"
      ? historyAppointments[0]
      : upcomingAppointments[0];

    if (!firstAppointment?.start) return;

    const appointmentDate = toManilaCalendarDate(firstAppointment.start);
    setSelectedDate(appointmentDate);
    setCalendarMonth(new Date(appointmentDate.getFullYear(), appointmentDate.getMonth(), 1));
  };

  return (
    <section className="pwa-page pwa-appointments-page">
      <PatientPageHeader
        title="My Appointments"
        subtitle="Track upcoming clinic visits and review your appointment history."
        className="pwa-appointments-title"
        actionPlacement="profile-secondary"
        action={(
          <span className="pwa-appointment-total" aria-live="polite">
            <Icon icon="solar:calendar-mark-bold-duotone" />
            <strong>{upcomingAppointments.length}</strong>
            <span>upcoming</span>
          </span>
        )}
      />

      <div className="pwa-appointments-top-grid">
        <section
          className={`pwa-next-appointment-card ${displayedAppointment ? "" : "is-empty"}`}
          aria-label="Next appointment"
        >
          {displayedAppointment && displayedDate ? (
            <button
              type="button"
              className="pwa-appointment-date"
              onClick={() => handleSelectDate(displayedDate)}
              aria-label="Select appointment date"
            >
              <strong>{displayedDate.getDate()}</strong>
              <span>{SHORT_MONTHS[displayedDate.getMonth()]}</span>
            </button>
          ) : null}

          <div className="pwa-appointment-info">
            <span className="pwa-appointment-card-eyebrow">Next appointment</span>
            {displayedAppointment ? (
              <>
                <p>
                  <span className={`pwa-appointment-status ${getStatusClass(displayedAppointment.displayStatus)}`}>
                    {displayedAppointment.displayStatus}
                  </span>
                  <b className="pwa-appointment-dot" aria-hidden="true" />
                  {daysUntil(displayedDate)}
                </p>
                <h2>{displayedAppointment.title}</h2>
                <ul>
                  <li>
                    <Icon icon="solar:clock-circle-linear" />
                    {formatAppointmentTime(displayedAppointment)}
                  </li>
                  <li>
                    <Icon icon="solar:user-rounded-linear" />
                    {displayedAppointment.doctor}
                  </li>
                </ul>
              </>
            ) : (
              <>
                <p>
                  <span className="pwa-appointment-status is-upcoming">
                    {isLoading ? "Loading" : "No Appointment"}
                  </span>
                </p>
                <h2>{isLoading ? "Checking your schedule" : "No upcoming appointment scheduled"}</h2>
                <ul>
                  <li>
                    <Icon icon="solar:calendar-linear" />
                    Your clinic appointments will appear here.
                  </li>
                </ul>
              </>
            )}
          </div>
        </section>

        <section className="pwa-mini-calendar-card" aria-label="Mini calendar">
          <header>
            <div>
              <span className="pwa-calendar-eyebrow">Browse dates</span>
              <h2>
                {MONTH_NAMES[calendarMonth.getMonth()]} {calendarMonth.getFullYear()}
              </h2>
            </div>
            <div>
              <button type="button" aria-label="Previous month" onClick={goToPreviousMonth}>
                <Icon icon="solar:alt-arrow-left-linear" />
              </button>
              <button type="button" aria-label="Next month" onClick={goToNextMonth}>
                <Icon icon="solar:alt-arrow-right-linear" />
              </button>
            </div>
          </header>

          <div className="pwa-calendar-weekdays">
            {WEEKDAY_LABELS.map((day, index) => (
              <span key={`${day}-${index}`}>{day}</span>
            ))}
          </div>

          <div className="pwa-calendar-days">
            {monthCells.map(({ date, muted }, index) => {
              const active = isSameDay(date, selectedDate);
              const hasAppointment = Boolean(getAppointmentOnDate(date, visibleAppointments));

              return (
                <button
                  type="button"
                  key={`${date.toISOString()}-${index}`}
                  className={`${muted ? "is-muted" : ""} ${active ? "is-active" : ""} ${hasAppointment ? "has-appointment" : ""}`}
                  onClick={() => handleSelectDate(date)}
                  aria-label={`${MONTH_NAMES[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
          <p className="pwa-calendar-legend">
            <span aria-hidden="true" /> Dates with {activeView} appointments
          </p>
        </section>
      </div>

      <section className="pwa-weekly-card" aria-label="Weekly appointment timeline">
        <header className="pwa-appointment-section-header">
          <div>
            <span className="pwa-appointment-section-eyebrow">Your schedule</span>
            <h2>Appointment timeline</h2>
            <p>{formatRange(weekStart, weekEnd)}</p>
          </div>
          <div className="pwa-appointment-view-tabs" role="tablist" aria-label="Appointment views">
            <button
              type="button"
              role="tab"
              aria-selected={activeView === "upcoming"}
              className={activeView === "upcoming" ? "is-active" : ""}
              onClick={() => handleViewChange("upcoming")}
            >
              Upcoming <span>{upcomingAppointments.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeView === "history"}
              className={activeView === "history" ? "is-active" : ""}
              onClick={() => handleViewChange("history")}
            >
              History <span>{historyAppointments.length}</span>
            </button>
          </div>
        </header>

        <div className="pwa-mobile-agenda">
          <div className="pwa-mobile-day-strip" aria-label="Select appointment day">
            {weekDays.map((day) => (
              <button
                type="button"
                key={day.toISOString()}
                className={isSameDay(day, selectedDate) ? "is-active" : ""}
                onClick={() => handleSelectDate(day)}
              >
                <small>{SHORT_DAYS[day.getDay()]}</small>
                <strong>{day.getDate()}</strong>
              </button>
            ))}
          </div>

          <div className="pwa-mobile-agenda-list">
            <div className="pwa-mobile-agenda-heading">
              <strong>{SHORT_DAYS[selectedDate.getDay()]}, {MONTH_NAMES[selectedDate.getMonth()]} {selectedDate.getDate()}</strong>
              <span>{selectedDayAppointments.length} {selectedDayAppointments.length === 1 ? "visit" : "visits"}</span>
            </div>
            {selectedDayAppointments.length ? (
              selectedDayAppointments.map((appointment) => (
                <article
                  className="pwa-mobile-agenda-item"
                  key={`${appointment.id}-${appointment.start}`}
                >
                  <time>{formatAppointmentTime(appointment)}</time>
                  <div>
                    <strong>{appointment.title}</strong>
                    <span><Icon icon="solar:user-rounded-linear" />{appointment.doctor}</span>
                  </div>
                  <em className={getStatusClass(appointment.displayStatus)}>
                    {appointment.displayStatus}
                  </em>
                </article>
              ))
            ) : (
              <p className="pwa-mobile-agenda-empty">No appointments for this day.</p>
            )}
          </div>
        </div>

        <div className="pwa-weekly-scroll">
          <div className="pwa-week-header">
            <span />
            {weekDays.map((day) => (
              <button
                type="button"
                key={day.toISOString()}
                className={isSameDay(day, selectedDate) ? "is-active" : ""}
                onClick={() => handleSelectDate(day)}
              >
                <small>{SHORT_DAYS[day.getDay()]}</small>
                <strong>{day.getDate()}</strong>
              </button>
            ))}
          </div>

          <div className="pwa-schedule-grid">
            {TIME_ROWS.map((time) => (
              <Fragment key={time.label}>
                <div className="pwa-time-label">{time.label}</div>
                {weekDays.map((day) => {
                  const cellAppointments = getEventsForCell(day, time.hour, appointments);
                  return (
                    <div
                      key={`${time.label}-${day.toISOString()}`}
                      className={`pwa-time-cell ${isSameDay(day, selectedDate) ? "is-selected-day" : ""}`}
                    >
                      {cellAppointments.map((appointment) => (
                        <button
                          type="button"
                          className="pwa-schedule-event"
                          key={`${appointment.id}-${appointment.start}`}
                          onClick={() => handleSelectDate(toManilaCalendarDate(appointment.start))}
                        >
                          <strong>{appointment.title}</strong>
                          <small>{formatTime(toDate(appointment.start))}</small>
                        </button>
                      ))}
                    </div>
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>
      </section>
    </section>
  );
}
