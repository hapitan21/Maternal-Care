import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { createPortal } from "react-dom";
import { supabase } from "../../lib/supabaseClient";
import { getStaffSettings, staffSettingsUpdatedEvent } from "../../lib/staffProfile";
import "../../styles/staff-appointments.css";

const scheduleTableName = "schedule";
const scheduleColumns =
  "id, maternal_appointment_id, patient_id, patient_name, doctor_name, title, description, start_time, end_time, status";
const patientLookupColumns =
  "id, full_name, patient_id, age, contact_number, address, expected_delivery_date, gestational_age, risk_level, status";

const filters = ["All", "Pending", "Completed", "Cancelled"];

const statusOptions = [
  { value: "Pending", label: "Pending", className: "is-pending" },
  { value: "Checked in", label: "Checked in", className: "is-checked" },
  { value: "Completed", label: "Completed", className: "is-completed" },
  { value: "Cancelled", label: "Cancelled", className: "is-cancel" },
  { value: "No show", label: "No show", className: "is-no-show" },
];

function getStatusClass(status) {
  if (status === "Pending") return "is-pending";
  if (status === "Checked in") return "is-checked";
  if (status === "Completed") return "is-completed";
  if (status === "Cancel" || status === "Cancelled") return "is-cancel";
  if (status === "No show") return "is-no-show";
  return "is-pending";
}


const categoryList = [
  {
    id: "checkup",
    label: "Check-up",
    icon: "solar:heart-bold",
    colorClass: "is-checkup",
  },
  {
    id: "consultation",
    label: "Consultation",
    icon: "solar:chat-round-dots-bold",
    colorClass: "is-consultation",
  },
  {
    id: "education",
    label: "Education",
    icon: "solar:map-arrow-right-bold",
    colorClass: "is-education",
  },
  {
    id: "reminder",
    label: "Reminder",
    icon: "solar:bell-bing-bold",
    colorClass: "is-reminder",
  },
];

const appointmentTypeOptions = [
  "Prenatal Check-up",
  "Ultrasound Appointment",
  "Laboratory Test",
  "High-Risk Pregnancy Consultation",
  "Follow-up Consultation",
  "Health Education",
  "Appointment Reminder",
];

function getCategoryFromAppointmentType(appointmentType) {
  const normalized = appointmentType.toLowerCase();
  if (normalized.includes("consultation")) return "consultation";
  if (normalized.includes("education")) return "education";
  if (normalized.includes("reminder")) return "reminder";
  return "checkup";
}

function getLocalDateKey(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getStartOfWeek(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function addMonths(date, amount) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function isSameDay(first, second) {
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

function formatCalendarRange(date) {
  const start = getStartOfWeek(date);
  const end = addDays(start, 6);

  return `${start.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })} - ${end.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;
}

function formatMonthTitle(date) {
  return date.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function buildMiniMonthDays(monthDate, activeDate) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const start = addDays(firstDay, -firstDay.getDay());

  return Array.from({ length: 35 }, (_, index) => {
    const date = addDays(start, index);
    return {
      date,
      value: date.getDate(),
      disabled: date.getMonth() !== month,
      active: isSameDay(date, activeDate),
      hasEvent: false,
    };
  });
}

function addOneHour(timeValue) {
  const [hour, minute] = timeValue.split(":").map(Number);
  const date = new Date();
  date.setHours(Number.isFinite(hour) ? hour : 8, Number.isFinite(minute) ? minute : 0, 0, 0);
  date.setHours(date.getHours() + 1);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function toLocalDateTimeIso(dateValue, timeValue) {
  return new Date(`${dateValue}T${timeValue || "08:00"}:00`).toISOString();
}

function createBlankAppointmentForm(settings = getStaffSettings()) {
  const today = getLocalDateKey();

  return {
    patientRecordId: "",
    patientName: "",
    doctorName: settings.displayName || "Staff",
    appointmentType: "Prenatal Check-up",
    date: today,
    startTime: "08:00",
    endTime: "09:00",
    category: "checkup",
    notes: "",
  };
}

function formatStatusValue(value) {
  if (value === "Completed") return "Completed";
  if (value === "Cancel" || value === "Cancelled" || value === "No show") return "Cancelled";
  return "Pending";
}

function getDisplayStatus(status) {
  const normalized = String(status || "scheduled").toLowerCase();
  if (normalized === "completed") return "Completed";
  if (["checked in", "checked_in"].includes(normalized)) return "Checked in";
  if (["no show", "no_show"].includes(normalized)) return "No show";
  if (["cancelled", "canceled", "cancel"].includes(normalized)) return "Cancelled";
  return "Pending";
}

function getDatabaseStatus(status) {
  if (status === "Checked in") return "checked_in";
  if (status === "Completed") return "completed";
  if (status === "No show") return "no_show";
  if (status === "Cancel" || status === "Cancelled") return "cancelled";
  return "scheduled";
}

function formatTableDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
  });
}

function formatTableTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatHourLabel(hour) {
  if (hour === 12) return "12 PM";
  if (hour > 12) return `${hour - 12} PM`;
  return `${String(hour).padStart(2, "0")} AM`;
}

function formatLongDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "2-digit",
    year: "numeric",
  });
}

function formatInputDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatInputTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatDisplayTime(value) {
  if (!value) return "";
  const [hourValue, minuteValue] = value.split(":");
  const date = new Date();
  date.setHours(Number(hourValue || 0), Number(minuteValue || 0), 0, 0);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function isCheckedInStatus(status) {
  return status === "Checked in";
}

function isCompletedStatus(status) {
  return status === "Completed";
}

function isCancelStatus(status) {
  return ["Cancel", "Cancelled"].includes(status);
}

function isClosedStatus(status) {
  return ["Cancel", "Cancelled", "No show", "Completed"].includes(status);
}

function isAppointmentToday(value) {
  if (!value) return false;
  const appointmentDate = new Date(value);
  if (Number.isNaN(appointmentDate.getTime())) return false;

  return isSameDay(appointmentDate, new Date());
}

function isActivePatientForAppointment(patient) {
  return String(patient?.status || "").trim().toLowerCase() === "active";
}

function getScheduleCategory(schedule) {
  const parsed = parseScheduleDescription(schedule.description);
  if (categoryList.some((category) => category.id === parsed.category)) {
    return parsed.category;
  }

  const keyword = `${schedule.title || ""} ${schedule.description || ""}`.toLowerCase();
  if (keyword.includes("consult")) return "consultation";
  if (keyword.includes("educ") || keyword.includes("class") || keyword.includes("talk")) return "education";
  if (keyword.includes("remind")) return "reminder";
  return "checkup";
}

function parseScheduleDescription(description) {
  if (!description) return {};

  try {
    const parsed = JSON.parse(description);
    return parsed && typeof parsed === "object" ? parsed : { notes: String(description) };
  } catch {
    return { notes: String(description) };
  }
}

function stringifyScheduleDescription(description, updates = {}) {
  return JSON.stringify({
    ...parseScheduleDescription(description),
    ...updates,
  });
}

function mapScheduleToAppointment(schedule) {
  const displayStatus = getDisplayStatus(schedule.status);
  const descriptionMeta = parseScheduleDescription(schedule.description);

  return {
    // Internal UUID used only for database updates and React keys.
    id: schedule.id,

    // Public-facing Maternal Appointment ID shown in the UI.
    appointmentId:
      schedule.maternal_appointment_id || "MA ID not assigned",

    name: schedule.patient_name || "Patient",
    patientId: schedule.patient_id || "",
    doctorName: schedule.doctor_name || "",
    title: schedule.title || "Follow-up Visit",
    description: schedule.description || "",
    notes: descriptionMeta.notes || "",
    location: descriptionMeta.location || "Maternal Care Clinic",
    cancellationReason: descriptionMeta.cancellationReason || "",
    category: getScheduleCategory(schedule),
    startTime: schedule.start_time,
    endTime: schedule.end_time,
    date: formatTableDate(schedule.start_time),
    time: formatTableTime(schedule.start_time),
    status: displayStatus,
    filterStatus: formatStatusValue(displayStatus),
  };
}

function mapScheduleToCalendarEvent(schedule) {
  const category = getScheduleCategory(schedule);
  const descriptionMeta = parseScheduleDescription(schedule.description);
  const displayStatus = getDisplayStatus(schedule.status);

  return {
    id: schedule.id,
    title: schedule.patient_name || schedule.title || "Appointment",
    patient: schedule.patient_name || "Patient",
    patientId: schedule.patient_id || "",
    label: schedule.title || "",
    timeLabel: `${formatTableTime(schedule.start_time)} - ${formatTableTime(schedule.end_time)}`,
    calendarId: category,
    category,
    doctorName: schedule.doctor_name || "",
    status: displayStatus,
    description: schedule.description || "",
    notes: descriptionMeta.notes || "",
    location: descriptionMeta.location || "Maternal Care Clinic",
    cancellationReason: descriptionMeta.cancellationReason || "",
    start: schedule.start_time,
    end: schedule.end_time,
  };
}

function hasAppointmentConflict(appointments, candidate) {
  const candidateStart = new Date(candidate.start).getTime();
  const candidateEnd = new Date(candidate.end).getTime();

  if (!Number.isFinite(candidateStart) || !Number.isFinite(candidateEnd) || candidateEnd <= candidateStart) {
    return false;
  }

  return appointments.some((appointment) => {
    if (appointment.id === candidate.id || isClosedStatus(appointment.status)) return false;

    const existingStart = new Date(appointment.startTime).getTime();
    const existingEnd = new Date(appointment.endTime).getTime();

    if (!Number.isFinite(existingStart) || !Number.isFinite(existingEnd)) return false;
    return candidateStart < existingEnd && candidateEnd > existingStart;
  });
}

function buildAppointmentReminderPayload(schedule, patientRecordId) {
  const scheduleStart = new Date(schedule.start_time);
  const remindAt = new Date(scheduleStart);
  remindAt.setHours(remindAt.getHours() - 24);

  if (Number.isNaN(remindAt.getTime()) || remindAt < new Date()) {
    remindAt.setTime(scheduleStart.getTime());
    remindAt.setHours(remindAt.getHours() - 1);
  }

  return {
    patient_id: patientRecordId,
    schedule_id: schedule.id,
    reminder_type: "appointment",
    title: `${schedule.title || "Appointment"} Reminder`,
    message: `Reminder: ${schedule.patient_name || "Patient"} has ${schedule.title || "an appointment"} scheduled on ${formatLongDate(schedule.start_time)} at ${formatTableTime(schedule.start_time)}.`,
    remind_at: remindAt.toISOString(),
    status: "pending",
    sent_at: null,
  };
}

function CustomCalendarHeader({
  selectedCategory,
  setSelectedCategory,
  selectedDate,
  onPreviousWeek,
  onNextWeek,
}) {
  return (
    <header className="staff-calendar-panel-header">
      <div>
        <h2>Calendar</h2>
        <div className="staff-calendar-controls">
          <button type="button" onClick={onPreviousWeek} aria-label="Previous week">
            <Icon icon="solar:alt-arrow-left-linear" />
          </button>
          <button type="button" onClick={onNextWeek} aria-label="Next week">
            <Icon icon="solar:alt-arrow-right-linear" />
          </button>
        </div>
      </div>

      <strong>{formatCalendarRange(selectedDate)}</strong>

      {selectedCategory !== "all" ? (
        <button
          type="button"
          className="staff-calendar-clear"
          onClick={() => setSelectedCategory("all")}
        >
          Show all
        </button>
      ) : null}
    </header>
  );
}

function StaffWeekCalendar({
  events,
  selectedDate,
  selectedCategory,
  onSelectDate,
  onSelectSlot,
  onSelectEvent,
}) {
  const weekDays = useMemo(() => {
    const start = getStartOfWeek(selectedDate);

    return Array.from({ length: 7 }, (_, index) => {
      const date = addDays(start, index);

      return {
        date,
        key: getLocalDateKey(date),
        dayName: date.toLocaleDateString("en-US", { weekday: "short" }),
        dayNumber: date.getDate(),
      };
    });
  }, [selectedDate]);

  const timeSlots = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
  const startHour = timeSlots[0];
  const hourHeight = 70;
  const visibleEvents =
    selectedCategory === "all"
      ? events
      : events.filter((event) => event.category === selectedCategory);

  return (
    <div
      className="staff-week-calendar"
      style={{ "--staff-week-hour-height": `${hourHeight}px` }}
    >
      <div className="staff-week-calendar-days">
        <span className="staff-week-calendar-time-head">Time</span>
        {weekDays.map((day) => (
          <button
            type="button"
            key={day.key}
            className={isSameDay(day.date, selectedDate) ? "is-selected" : ""}
            onClick={() => onSelectDate(day.date)}
          >
            <small>{day.dayName}</small>
            <strong>{day.dayNumber}</strong>
          </button>
        ))}
      </div>

      <div className="staff-week-calendar-body">
        <div className="staff-week-calendar-times">
          {timeSlots.map((hour) => (
            <span key={hour}>{formatHourLabel(hour)}</span>
          ))}
        </div>

        <div className="staff-week-calendar-grid">
          {weekDays.map((day) => (
            <div className="staff-week-calendar-day" key={day.key}>
              {timeSlots.map((hour) => (
                <button
                  type="button"
                  className="staff-week-calendar-line"
                  key={hour}
                  aria-label={`Add appointment on ${day.dayName} at ${formatHourLabel(hour)}`}
                  onClick={() => {
                    const start = new Date(day.date);
                    start.setHours(hour, 0, 0, 0);
                    const end = new Date(start);
                    end.setHours(end.getHours() + 1);
                    onSelectSlot(start, end);
                  }}
                />
              ))}

              {visibleEvents
                .filter((event) => {
                  const eventDate = new Date(event.start);
                  return !Number.isNaN(eventDate.getTime()) && isSameDay(eventDate, day.date);
                })
                .map((event) => {
                  const start = new Date(event.start);
                  const end = new Date(event.end);
                  const startMinutes = Math.max(
                    0,
                    (start.getHours() - startHour) * 60 + start.getMinutes()
                  );
                  const durationMinutes =
                    !Number.isNaN(end.getTime()) && end > start
                      ? Math.max(45, (end.getTime() - start.getTime()) / 60000)
                      : 60;
                  const top = (startMinutes / 60) * hourHeight;
                  const height = Math.min(110, (durationMinutes / 60) * hourHeight);

                  return (
                    <button
                      type="button"
                      className={`staff-week-event staff-week-event-${event.category}`}
                      key={event.id}
                      style={{
                        top: `${top}px`,
                        height: `${height}px`,
                      }}
                      onClick={(clickEvent) => {
                        clickEvent.stopPropagation();
                        onSelectEvent(event.id);
                      }}
                    >
                      <strong>{event.patient}</strong>
                      <span>{event.timeLabel}</span>
                      {event.label ? <small>{event.label}</small> : null}
                    </button>
                  );
                })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function createFollowUpForm(appointment, patient) {
  const settings = getStaffSettings();

  return {
    appointmentId: appointment?.appointmentId || "",
    patientId: patient?.patient_id || (patient?.id ? String(patient.id).slice(0, 8) : ""),
    patientRecordId: patient?.id || "",
    patientName: patient?.full_name || appointment?.name || "",
    age: patient?.age ? `${patient.age} years` : "",
    contactNumber: patient?.contact_number || "",
    address: patient?.address || "",
    visitDate: formatInputDate(appointment?.startTime) || formatInputDate(new Date()),
    visitTime: formatInputTime(appointment?.startTime) || "09:00",
    visitType: appointment?.title || "Follow-up Visit",
    attendingPhysician: appointment?.doctorName || settings.displayName || "Staff",
    gestationalAge: patient?.gestational_age || "",
    expectedDeliveryDate: formatInputDate(patient?.expected_delivery_date),
    pregnancyStatus: patient?.risk_level || "Low Risk",
    bloodPressure: "",
    temperature: "",
    weight: "",
    heartRate: "",
  };
}

function FollowUpField({
  label,
  value,
  onChange,
  placeholder = "",
  type = "text",
  icon,
}) {
  return (
    <label className="staff-followup-field">
      <span>{label}</span>
      <div className="staff-followup-input-wrap">
        <input
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
        {icon ? <Icon icon={icon} aria-hidden="true" /> : null}
      </div>
    </label>
  );
}

function FollowUpVisitForm({
  form,
  onBack,
  onChange,
  onSave,
  saving,
  statusMessage,
}) {
  const riskOptions = ["Low Risk", "Moderate Risk", "High Risk"];

  return (
    <section className="staff-followup-page">
      <header className="staff-followup-header">
        <button type="button" className="staff-followup-back" onClick={onBack}>
          <Icon icon="solar:arrow-left-linear" aria-hidden="true" />
          Back to Appointments
        </button>

        <div className="staff-followup-title">
          <h1>Follow-up Visit Form</h1>
          <p>Please provide complete information for accurate follow-up care</p>
        </div>

        <aside className="staff-followup-appointment-id">
          <span>Appointment ID</span>
          <strong>{form.appointmentId || "-"}</strong>
        </aside>
      </header>

      {statusMessage ? (
        <p className="staff-appointments-status-message staff-followup-message">
          {statusMessage}
        </p>
      ) : null}

      <div className="staff-followup-grid">
        <section className="staff-followup-card">
          <h2>Patient Information</h2>
          <FollowUpField
            label="Patient ID"
            value={form.patientId}
            onChange={(value) => onChange("patientId", value)}
            placeholder="00-00-01"
          />
          <FollowUpField
            label="Patient Name"
            value={form.patientName}
            onChange={(value) => onChange("patientName", value)}
            placeholder="Patient name"
          />
          <FollowUpField
            label="Age"
            value={form.age}
            onChange={(value) => onChange("age", value)}
            placeholder="28 years"
          />
          <FollowUpField
            label="Contact Number"
            value={form.contactNumber}
            onChange={(value) => onChange("contactNumber", value)}
            placeholder="09XXXXXXXXX"
          />
          <FollowUpField
            label="Address"
            value={form.address}
            onChange={(value) => onChange("address", value)}
            placeholder="Home address"
          />
        </section>

        <section className="staff-followup-card">
          <h2>Visit Information</h2>
          <FollowUpField
            label="Date of Visit"
            type="date"
            value={form.visitDate}
            onChange={(value) => onChange("visitDate", value)}
            icon="solar:calendar-linear"
          />
          <FollowUpField
            label="Time of Visit"
            type="time"
            value={form.visitTime}
            onChange={(value) => onChange("visitTime", value)}
          />
          <FollowUpField
            label="Visit Type"
            value={form.visitType}
            onChange={(value) => onChange("visitType", value)}
            placeholder="Follow-up Visit"
          />
          <FollowUpField
            label="Attending Physician"
            value={form.attendingPhysician}
            onChange={(value) => onChange("attendingPhysician", value)}
            placeholder="Dr. Kempee Vergara"
          />
        </section>

        <section className="staff-followup-card">
          <h2>Pregnancy Status</h2>
          <FollowUpField
            label="Gestational Age"
            value={form.gestationalAge}
            onChange={(value) => onChange("gestationalAge", value)}
            placeholder="28 Weeks 2 Days"
          />
          <FollowUpField
            label="Expected Delivery Date"
            type="date"
            value={form.expectedDeliveryDate}
            onChange={(value) => onChange("expectedDeliveryDate", value)}
            icon="solar:calendar-linear"
          />

          <div className="staff-followup-risk-group">
            <span>Pregnancy Status</span>
            <div>
              {riskOptions.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={form.pregnancyStatus === option ? "is-active" : ""}
                  onClick={() => onChange("pregnancyStatus", option)}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>

      <section className="staff-followup-card staff-followup-clinical-card">
        <h2>Clinical Findings</h2>
        <div className="staff-followup-clinical-grid">
          <FollowUpField
            label="Blood Pressure"
            value={form.bloodPressure}
            onChange={(value) => onChange("bloodPressure", value)}
            placeholder="e.g. 120/80 mmHg"
          />
          <FollowUpField
            label="Temperature"
            value={form.temperature}
            onChange={(value) => onChange("temperature", value)}
            placeholder="e.g. 36.7 C"
          />
          <FollowUpField
            label="Weight"
            value={form.weight}
            onChange={(value) => onChange("weight", value)}
            placeholder="e.g. 65 kg"
          />
          <FollowUpField
            label="Heart Rate"
            value={form.heartRate}
            onChange={(value) => onChange("heartRate", value)}
            placeholder="e.g. 140 bpm"
          />
        </div>
      </section>

      <footer className="staff-followup-actions">
        <button
          type="button"
          className="staff-followup-save"
          onClick={onSave}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save Record"}
        </button>
        <button type="button" className="staff-followup-cancel" onClick={onBack}>
          Cancel
        </button>
      </footer>
    </section>
  );
}

function AppointmentFormField({
  label,
  value,
  onChange,
  type = "text",
  children,
  required = false,
  placeholder = "",
  className = "",
}) {
  return (
    <label className={`staff-add-appointment-field ${className}`}>
      <span>{label}</span>

      {children ? (
        <div className="staff-add-appointment-control">
          <select
            value={value}
            onChange={(event) => onChange(event.target.value)}
            required={required}
          >
            {children}
          </select>

          <Icon icon="solar:alt-arrow-down-linear" aria-hidden="true" />
        </div>
      ) : (
        <input
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required={required}
          placeholder={placeholder}
        />
      )}
    </label>
  );
}

function AddAppointmentModal({
  form,
  mode = "add",
  onChange,
  onClose,
  onSave,
  saving,
  patientSuggestions,
  onSelectPatient,
  isLoadingPatients,
}) {
  const [isPatientResultsOpen, setIsPatientResultsOpen] = useState(false);

  const handlePatientInputChange = (value) => {
    onChange("patientName", value);
    setIsPatientResultsOpen(Boolean(value.trim()));
  };

  const handlePatientSelect = (patient) => {
    onSelectPatient(patient);
    setIsPatientResultsOpen(false);
  };

  const handlePatientBlur = () => {
    window.setTimeout(() => {
      setIsPatientResultsOpen(false);
    }, 150);
  };

  return createPortal(
    <div
      className="staff-add-appointment-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <section
        className="staff-add-appointment-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="staff-add-appointment-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="staff-add-appointment-close"
          aria-label="Close add appointment"
          onClick={onClose}
        >
          <Icon icon="solar:close-circle-bold" />
        </button>

        <header>
          <h2 id="staff-add-appointment-title">
            {mode === "edit" ? "Edit Appointment" : "Add New Appointment"}
          </h2>
        </header>

        <form onSubmit={onSave}>
          <label className="staff-add-appointment-field staff-add-appointment-patient-field">
            <span>Patient Name:</span>

            <div className="staff-add-appointment-patient-search">
              <input
                type="search"
                value={form.patientName}
                onChange={(event) =>
                  handlePatientInputChange(event.target.value)
                }
                onFocus={() =>
                  setIsPatientResultsOpen(Boolean(form.patientName.trim()))
                }
                onBlur={handlePatientBlur}
                placeholder={
                  isLoadingPatients
                    ? "Loading patients..."
                    : "Enter patient name"
                }
                autoComplete="off"
                required
              />

              {isPatientResultsOpen && patientSuggestions.length ? (
                <div
                  className="staff-add-appointment-patient-results"
                  role="listbox"
                >
                  {patientSuggestions.map((patient) => (
                    <button
                      key={patient.id}
                      type="button"
                      role="option"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        handlePatientSelect(patient);
                      }}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        handlePatientSelect(patient);
                      }}
                      onClick={() => handlePatientSelect(patient)}
                    >
                      <strong>{patient.full_name}</strong>
                      <small>
                        {patient.contact_number ||
                          patient.patient_id ||
                          "No contact number"}
                      </small>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </label>

          <AppointmentFormField
            label="Select Date:"
            type="date"
            value={form.date}
            onChange={(value) => onChange("date", value)}
            required
          />

          <AppointmentFormField
            label="Select Time:"
            type="time"
            value={form.startTime}
            onChange={(value) => onChange("startTime", value)}
            required
          />

          <AppointmentFormField
            label="Select Type:"
            value={form.appointmentType}
            onChange={(value) => onChange("appointmentType", value)}
            required
          >
            {appointmentTypeOptions.map((appointmentType) => (
              <option key={appointmentType} value={appointmentType}>
                {appointmentType}
              </option>
            ))}
          </AppointmentFormField>

          <label className="staff-add-appointment-field is-full">
            <span>Message:</span>
            <textarea
              value={form.notes}
              onChange={(event) => onChange("notes", event.target.value)}
              rows="2"
              placeholder="Enter appointment message"
            />
          </label>

          <footer>
            <button type="submit" disabled={saving}>
              {saving ? "Saving..." : mode === "edit" ? "Update" : "Save"}
            </button>

            <button type="button" onClick={onClose}>
              Cancel
            </button>
          </footer>
        </form>
      </section>
    </div>,
    document.body
  );
}

function AppointmentDetailsModal({
  appointment,
  onClose,
  onEdit,
  onCancel,
  onCheckIn,
  onComplete,
}) {
  if (!appointment) return null;

  const details = [
    ["Patient name", appointment.name],
    ["Appointment ID", appointment.appointmentId],
    ["Appointment type", appointment.title],
    ["Doctor", appointment.doctorName || "Not assigned"],
    ["Date and time", `${formatLongDate(appointment.startTime)} at ${appointment.time}`],
    ["Status", appointment.status],
    ["Description", appointment.notes || "No description provided."],
    ["Location", appointment.location || "Maternal Care Clinic"],
  ];

  return createPortal(
    <div className="staff-appointment-detail-backdrop" role="presentation" onClick={onClose}>
      <section
        className="staff-appointment-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="staff-appointment-detail-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="staff-appointment-detail-close"
          aria-label="Close appointment details"
          onClick={onClose}
        >
          <Icon icon="solar:close-circle-bold" />
        </button>

        <header>
          <span className={`staff-appointment-detail-icon ${getStatusClass(appointment.status)}`}>
            <Icon icon="solar:calendar-mark-bold" aria-hidden="true" />
          </span>
          <div>
            <h2 id="staff-appointment-detail-title">{appointment.name}</h2>
            <p>{appointment.title}</p>
          </div>
        </header>

        <dl className="staff-appointment-detail-list">
          {details.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value || "-"}</dd>
            </div>
          ))}
        </dl>

        {appointment.cancellationReason ? (
          <p className="staff-appointment-cancel-reason">
            Cancellation reason: {appointment.cancellationReason}
          </p>
        ) : null}

        <footer>
          <button type="button" className="is-outline" onClick={() => onEdit(appointment)}>
            <Icon icon="solar:pen-bold" aria-hidden="true" />
            Edit
          </button>

          <button
            type="button"
            className="is-outline"
            onClick={() => onCheckIn(appointment)}
            disabled={isClosedStatus(appointment.status)}
          >
            <Icon icon="solar:login-3-bold" aria-hidden="true" />
            Check in
          </button>

          <button
            type="button"
            className="is-primary"
            onClick={() => onComplete(appointment)}
            disabled={isClosedStatus(appointment.status) && !isCheckedInStatus(appointment.status)}
          >
            <Icon icon="solar:check-circle-bold" aria-hidden="true" />
            Complete
          </button>

          <button
            type="button"
            className="is-danger"
            onClick={() => onCancel(appointment)}
            disabled={isClosedStatus(appointment.status)}
          >
            <Icon icon="solar:close-circle-bold" aria-hidden="true" />
            Cancel
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}

function AppointmentSummary({ summary }) {
  const cards = [
    {
      label: "Total",
      value: summary.total,
      icon: "solar:calendar-bold",
      tone: "is-total",
    },
    {
      label: "Pending",
      value: summary.pending,
      icon: "solar:hourglass-line-duotone",
      tone: "is-pending",
    },
    {
      label: "Checked in",
      value: summary.checkedIn,
      icon: "solar:check-circle-bold",
      tone: "is-checked",
    },
    {
      label: "Cancelled",
      value: summary.cancelled,
      icon: "solar:close-circle-bold",
      tone: "is-cancelled",
    },
  ];

  return (
    <section className="staff-appointment-summary" aria-label="Appointment summary">
      {cards.map((card) => (
        <article className={`staff-appointment-summary-card ${card.tone}`} key={card.label}>
          <span className="staff-appointment-summary-icon">
            <Icon icon={card.icon} aria-hidden="true" />
          </span>
          <div>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
          </div>
        </article>
      ))}
    </section>
  );
}

function StaffAppointmentsContent({ headerAction }) {
  const [staffSettings, setStaffSettings] = useState(getStaffSettings);
  const [activeFilter, setActiveFilter] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [appointments, setAppointments] = useState([]);
  const [scheduleEvents, setScheduleEvents] = useState([]);
  const [patients, setPatients] = useState([]);
  const [isLoadingPatients, setIsLoadingPatients] = useState(false);
  const [selectedAppointment, setSelectedAppointment] = useState(null);
  const [detailAppointment, setDetailAppointment] = useState(null);
  const [followUpForm, setFollowUpForm] = useState(() => createFollowUpForm(null, null));
  const [isSavingFollowUp, setIsSavingFollowUp] = useState(false);
  const [isAddAppointmentOpen, setIsAddAppointmentOpen] = useState(false);
  const [isSavingAppointment, setIsSavingAppointment] = useState(false);
  const [editingAppointmentId, setEditingAppointmentId] = useState("");
  const [addAppointmentForm, setAddAppointmentForm] = useState(() =>
    createBlankAppointmentForm()
  );
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [calendarDate, setCalendarDate] = useState(() => new Date());
  const [miniMonthDate, setMiniMonthDate] = useState(() => new Date());
  const [openStatusMenu, setOpenStatusMenu] = useState(null);
  const [statusMenuPosition, setStatusMenuPosition] = useState(null);
  const [statusMessage, setStatusMessage] = useState("");
  const statusButtonRefs = useRef({});

  const loadAppointments = useCallback(async () => {
    const { data, error } = await supabase
      .from(scheduleTableName)
      .select(scheduleColumns)
      .order("start_time", { ascending: true });

    if (error) {
      console.error("Staff appointments load failed:", error);
      setStatusMessage(`Unable to load appointments: ${error.message}`);
      return;
    }

    const schedules = data || [];
    const mappedAppointments =
      schedules.map(mapScheduleToAppointment);
    const appointmentById = new Map(
      mappedAppointments.map((appointment) => [appointment.id, appointment])
    );

    setAppointments(mappedAppointments);
    setScheduleEvents(schedules.map(mapScheduleToCalendarEvent));
    setDetailAppointment((current) =>
      current?.id ? appointmentById.get(current.id) || null : current
    );
    setSelectedAppointment((current) =>
      current?.id ? appointmentById.get(current.id) || null : current
    );
    setOpenStatusMenu((current) => {
      if (current && !appointmentById.has(current)) {
        setStatusMenuPosition(null);
        return null;
      }

      return current;
    });
    setEditingAppointmentId((current) => {
      if (current && !appointmentById.has(current)) {
        setIsAddAppointmentOpen(false);
        return "";
      }

      return current;
    });

    if (schedules[0]?.start_time) {
      const firstScheduleDate = new Date(schedules[0].start_time);

      if (!Number.isNaN(firstScheduleDate.getTime())) {
        setCalendarDate(firstScheduleDate);
        setMiniMonthDate(
          new Date(firstScheduleDate.getFullYear(), firstScheduleDate.getMonth(), 1)
        );
      }
    }

    setStatusMessage("");

    if (import.meta.env.DEV) {
      console.table(
        mappedAppointments.map((appointment) => ({
          appointmentId: appointment.appointmentId,
          internalUuid: appointment.id,
          patient: appointment.name,
          date: appointment.date,
          time: appointment.time,
        }))
      );
    }
  }, []);

  const updateStatusMenuPosition = useCallback((appointmentId) => {
    const trigger = statusButtonRefs.current[appointmentId];

    if (!trigger || typeof window === "undefined") {
      setStatusMenuPosition(null);
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const menuWidth = 122;
    const estimatedMenuHeight = 132;
    const viewportGap = 10;

    let left = rect.right - menuWidth;
    left = Math.max(viewportGap, left);
    left = Math.min(left, window.innerWidth - menuWidth - viewportGap);

    let top = rect.bottom + 8;

    if (top + estimatedMenuHeight > window.innerHeight - viewportGap) {
      top = rect.top - estimatedMenuHeight - 8;
    }

    top = Math.max(viewportGap, top);

    setStatusMenuPosition({ top, left });
  }, []);

  useEffect(() => {
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
      .channel("staff-appointments")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: scheduleTableName,
        },
        loadAppointments
      )
      .subscribe();

    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      supabase.removeChannel(channel);
    };
  }, [loadAppointments]);

  useEffect(() => {
    let active = true;

    const loadPatients = async () => {
      setIsLoadingPatients(true);

      const { data, error } = await supabase
        .from("patients")
        .select(patientLookupColumns)
        .order("full_name", { ascending: true });

      if (!active) return;

      setIsLoadingPatients(false);

      if (error) {
        console.warn("Staff appointment patient suggestions failed:", error);
        return;
      }

      setPatients((data || []).filter(isActivePatientForAppointment));
    };

    loadPatients();

    const channel = supabase
      .channel("staff-appointment-active-patients")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "patients",
        },
        loadPatients
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    const syncStaffSettings = () => {
      const nextSettings = getStaffSettings();
      setStaffSettings(nextSettings);
      setAddAppointmentForm((current) => ({
        ...current,
        doctorName: nextSettings.displayName || current.doctorName,
      }));
    };

    window.addEventListener(staffSettingsUpdatedEvent, syncStaffSettings);
    window.addEventListener("storage", syncStaffSettings);

    return () => {
      window.removeEventListener(staffSettingsUpdatedEvent, syncStaffSettings);
      window.removeEventListener("storage", syncStaffSettings);
    };
  }, []);

  useEffect(() => {
    const closeStatusMenu = (event) => {
      if (
        event.target.closest?.(".staff-status-dropdown") ||
        event.target.closest?.(".staff-status-portal-menu")
      ) {
        return;
      }

      setOpenStatusMenu(null);
    };

    window.addEventListener("click", closeStatusMenu);
    return () => window.removeEventListener("click", closeStatusMenu);
  }, []);

  const filteredAppointments = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase();

    return appointments.filter((appointment) => {
      const matchesFilter =
        activeFilter === "All" ||
        appointment.filterStatus === activeFilter ||
        appointment.status === activeFilter;

      if (!matchesFilter) return false;
      if (!keyword) return true;

      return [
        appointment.appointmentId,
        appointment.name,
        appointment.date,
        appointment.time,
        appointment.status,
        appointment.title,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(keyword));
    });
  }, [activeFilter, appointments, searchQuery]);

  const searchSuggestions = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase();

    if (!keyword) return [];

    const seen = new Set();

    return appointments
      .filter((appointment) => {
        const matchesFilter =
          activeFilter === "All" ||
          appointment.filterStatus === activeFilter ||
          appointment.status === activeFilter;

        if (!matchesFilter) return false;

        return [appointment.name, appointment.appointmentId, appointment.title]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(keyword));
      })
      .filter((appointment) => {
        const key = `${appointment.name}-${appointment.appointmentId}`.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 6);
  }, [activeFilter, appointments, searchQuery]);

  const addAppointmentPatientSuggestions = useMemo(() => {
    const keyword = addAppointmentForm.patientName.trim().toLowerCase();

    if (!keyword) return [];

    return patients
      .filter((patient) => {
        return [
          patient.full_name,
          patient.patient_id,
          patient.contact_number,
        ]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(keyword));
      })
      .slice(0, 6);
  }, [addAppointmentForm.patientName, patients]);

  const appointmentSummary = useMemo(() => {
    return appointments.reduce(
      (summary, appointment) => {
        summary.total += 1;

        if (appointment.status === "Pending") {
          summary.pending += 1;
        }

        if (isCheckedInStatus(appointment.status)) {
          summary.checkedIn += 1;
        }

        if (isClosedStatus(appointment.status)) {
          summary.cancelled += 1;
        }

        if (isAppointmentToday(appointment.startTime)) {
          summary.today += 1;
        }

        return summary;
      },
      {
        total: 0,
        today: 0,
        pending: 0,
        checkedIn: 0,
        cancelled: 0,
      }
    );
  }, [appointments]);

  const activeStatusAppointment = useMemo(() => {
    if (!openStatusMenu) return null;

    return appointments.find((appointment) => appointment.id === openStatusMenu) || null;
  }, [appointments, openStatusMenu]);

  const fullCalendarEvents = useMemo(() => {
    const visibleEvents =
      selectedCategory === "all"
        ? scheduleEvents
        : scheduleEvents.filter((event) => event.category === selectedCategory);

    return visibleEvents.map((event) => ({
      id: event.id,
      title: event.patient,
      start: event.start,
      end: event.end,
      editable: !isClosedStatus(event.status),
      classNames: [
        "staff-fullcalendar-event",
        `staff-fullcalendar-event-${event.category}`,
        getStatusClass(event.status),
      ],
      extendedProps: event,
    }));
  }, [scheduleEvents, selectedCategory]);

  const mobileCalendarEvents = useMemo(() => {
    const weekStart = getStartOfWeek(calendarDate);
    const weekEnd = addDays(weekStart, 7);

    return fullCalendarEvents.filter((event) => {
      const eventDate = new Date(event.start);
      return eventDate >= weekStart && eventDate < weekEnd;
    });
  }, [calendarDate, fullCalendarEvents]);

  useLayoutEffect(() => {
    if (!openStatusMenu) {
      setStatusMenuPosition(null);
      return;
    }

    updateStatusMenuPosition(openStatusMenu);
  }, [filteredAppointments.length, openStatusMenu, updateStatusMenuPosition]);

  useEffect(() => {
    if (!openStatusMenu) return undefined;

    const keepStatusMenuAligned = () => updateStatusMenuPosition(openStatusMenu);

    window.addEventListener("resize", keepStatusMenuAligned);
    window.addEventListener("scroll", keepStatusMenuAligned, true);

    return () => {
      window.removeEventListener("resize", keepStatusMenuAligned);
      window.removeEventListener("scroll", keepStatusMenuAligned, true);
    };
  }, [openStatusMenu, updateStatusMenuPosition]);

  const saveAppointmentReminder = useCallback(
    async (schedule) => {
      if (!schedule?.id || !schedule.patient_name) return false;

      const localPatient = schedule.patient_id
        ? patients.find((patient) => patient.id === schedule.patient_id)
        : patients.find(
            (patient) =>
              String(patient.full_name || "").toLowerCase() ===
              String(schedule.patient_name || "").toLowerCase()
          );

      let patientRecordId = schedule.patient_id || localPatient?.id || "";

      if (!patientRecordId) {
        const { data, error } = await supabase
          .from("patients")
          .select("id")
          .ilike("full_name", schedule.patient_name)
          .limit(1)
          .maybeSingle();

        if (error) {
          console.warn("Appointment reminder patient lookup failed:", error);
          return false;
        }

        patientRecordId = data?.id || "";
      }

      if (!patientRecordId) return false;

      const payload = buildAppointmentReminderPayload(schedule, patientRecordId);

      const { data: existingReminder, error: lookupError } = await supabase
        .from("reminders")
        .select("id")
        .eq("schedule_id", schedule.id)
        .eq("reminder_type", "appointment")
        .maybeSingle();

      if (lookupError) {
        console.warn("Appointment reminder lookup failed:", lookupError);
        return false;
      }

      const reminderQuery = existingReminder?.id
        ? supabase.from("reminders").update(payload).eq("id", existingReminder.id)
        : supabase.from("reminders").insert([payload]);

      const { error } = await reminderQuery;

      if (error) {
        console.warn("Appointment reminder save failed:", error);
        return false;
      }

      return true;
    },
    [patients]
  );

  const disableAppointmentReminders = useCallback(async (appointmentId) => {
    const { error } = await supabase
      .from("reminders")
      .update({ status: "cancelled" })
      .eq("schedule_id", appointmentId)
      .eq("reminder_type", "appointment");

    if (error) {
      console.warn("Appointment reminder cancellation failed:", error);
    }
  }, []);

  const updateAppointmentStatus = useCallback(
    async (appointment, nextStatus, extraPayload = {}) => {
      const { error } = await supabase
        .from(scheduleTableName)
        .update({
          ...extraPayload,
          status: getDatabaseStatus(nextStatus),
        })
        .eq("id", appointment.id);

      if (error) {
        console.error("Staff appointment status update failed:", error);
        setStatusMessage(`Unable to update status: ${error.message}`);
        return false;
      }

      setAppointments((currentAppointments) =>
        currentAppointments.map((item) =>
          item.id === appointment.id
            ? {
                ...item,
                ...extraPayload,
                description: extraPayload.description || item.description,
                status: nextStatus,
                filterStatus: formatStatusValue(nextStatus),
              }
            : item
        )
      );

      await loadAppointments();
      return true;
    },
    [loadAppointments]
  );

  const cancelAppointment = useCallback(
    async (appointment) => {
      const reason = window.prompt("Enter the cancellation reason:");
      const trimmedReason = reason?.trim();

      if (!trimmedReason) {
        setOpenStatusMenu(null);
        return;
      }

      const description = stringifyScheduleDescription(appointment.description, {
        cancellationReason: trimmedReason,
        remindersDisabled: true,
      });

      const saved = await updateAppointmentStatus(appointment, "Cancelled", {
        description,
      });

      if (saved) {
        await disableAppointmentReminders(appointment.id);
        setDetailAppointment(null);
        setStatusMessage("Appointment cancelled and future reminders disabled.");
      }

      setOpenStatusMenu(null);
    },
    [disableAppointmentReminders, updateAppointmentStatus]
  );

  const completeAppointment = useCallback(
    async (appointment) => {
      const saved = await updateAppointmentStatus(appointment, "Completed");
      if (saved) {
        setDetailAppointment(null);
        setOpenStatusMenu(null);
        setStatusMessage("Appointment marked as completed.");
      }
    },
    [updateAppointmentStatus]
  );

  const handleStatusChange = async (appointmentId, newStatus) => {
    const currentAppointment = appointments.find(
      (appointment) => appointment.id === appointmentId
    );

    if (!currentAppointment) {
      setOpenStatusMenu(null);
      return;
    }

    if (isClosedStatus(currentAppointment.status)) {
      setOpenStatusMenu(null);
      setStatusMessage("Completed or cancelled appointments cannot be changed.");
      return;
    }

    if (newStatus === "Checked in") {
      openFollowUpForm(currentAppointment);
      return;
    }

    if (newStatus === "Cancelled" || newStatus === "Cancel") {
      await cancelAppointment(currentAppointment);
      return;
    }

    if (newStatus === "Completed") {
      await completeAppointment(currentAppointment);
      return;
    }

    setOpenStatusMenu(null);
  };

  const openFollowUpForm = async (appointment) => {
    setOpenStatusMenu(null);
    setStatusMessage("");
    setSelectedAppointment(appointment);
    setFollowUpForm(createFollowUpForm(appointment, null));

    if (!appointment.name || appointment.name === "Patient") return;

    const { data, error } = await supabase
      .from("patients")
      .select(patientLookupColumns)
      .ilike("full_name", appointment.name)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn("Patient lookup for follow-up form failed:", error);
      return;
    }

    if (data) {
      setFollowUpForm(createFollowUpForm(appointment, data));
    }
  };

  const updateFollowUpForm = (field, value) => {
    setFollowUpForm((current) => ({ ...current, [field]: value }));
  };

  const openAddAppointment = () => {
    setStatusMessage("");
    setEditingAppointmentId("");
    setAddAppointmentForm(createBlankAppointmentForm(staffSettings));
    setIsAddAppointmentOpen(true);
  };

  const openAddAppointmentAt = useCallback(
    (startDate, endDate) => {
      const start = startDate instanceof Date ? startDate : new Date(startDate);
      const end = endDate instanceof Date ? endDate : new Date(endDate || start);

      if (Number.isNaN(start.getTime())) return;

      if (Number.isNaN(end.getTime()) || end <= start) {
        end.setTime(start.getTime());
        end.setHours(end.getHours() + 1);
      }

      setStatusMessage("");
      setEditingAppointmentId("");
      setAddAppointmentForm({
        ...createBlankAppointmentForm(staffSettings),
        date: getLocalDateKey(start),
        startTime: formatInputTime(start),
        endTime: formatInputTime(end),
        category: selectedCategory === "all" ? "checkup" : selectedCategory,
        appointmentType:
          selectedCategory === "education"
            ? "Health Education"
            : selectedCategory === "reminder"
              ? "Appointment Reminder"
              : selectedCategory === "consultation"
                ? "Follow-up Consultation"
                : "Prenatal Check-up",
      });
      setIsAddAppointmentOpen(true);
    },
    [selectedCategory, staffSettings]
  );

  const openEditAppointment = useCallback(
    (appointment) => {
      setDetailAppointment(null);
      setStatusMessage("");
      setEditingAppointmentId(appointment.id);
      setAddAppointmentForm({
        patientRecordId: appointment.patientId || "",
        patientName: appointment.name || "",
        doctorName: appointment.doctorName || staffSettings.displayName || "Staff",
        appointmentType: appointment.title || "Prenatal Check-up",
        date: formatInputDate(appointment.startTime) || getLocalDateKey(),
        startTime: formatInputTime(appointment.startTime) || "08:00",
        endTime: formatInputTime(appointment.endTime) || "09:00",
        category: appointment.category || getCategoryFromAppointmentType(appointment.title || ""),
        notes: appointment.notes || "",
      });
      setIsAddAppointmentOpen(true);
    },
    [staffSettings.displayName]
  );

  const updateAddAppointmentForm = (field, value) => {
    setAddAppointmentForm((current) => {
      const next = { ...current, [field]: value };

      if (field === "patientName") {
        next.patientRecordId = "";
      }

      if (field === "startTime") {
        next.endTime = addOneHour(value);
      }

      if (field === "appointmentType") {
        next.category = getCategoryFromAppointmentType(value);
      }

      return next;
    });
  };

  const selectAddAppointmentPatient = (patient) => {
    setAddAppointmentForm((current) => ({
      ...current,
      patientRecordId: patient.id || "",
      patientName: patient.full_name || "",
    }));
    setStatusMessage("");
  };

  const resolveAddAppointmentPatientId = async () => {
    if (addAppointmentForm.patientRecordId) {
      return addAppointmentForm.patientRecordId;
    }

    const localPatient = patients.find(
      (patient) =>
        String(patient.full_name || "").trim().toLowerCase() ===
        addAppointmentForm.patientName.trim().toLowerCase()
    );

    if (localPatient?.id) {
      return localPatient.id;
    }

    const { data, error } = await supabase
      .from("patients")
      .select("id, full_name")
      .ilike("full_name", addAppointmentForm.patientName.trim())
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn("Staff appointment patient resolve failed:", error);
      return "";
    }

    return data?.id || "";
  };

  const saveAppointment = async (event) => {
    event.preventDefault();
    setStatusMessage("");

    if (!addAppointmentForm.patientName.trim()) {
      setStatusMessage("Patient name is required.");
      return;
    }

    setIsSavingAppointment(true);

    const patientRecordId = await resolveAddAppointmentPatientId();

    if (!patientRecordId) {
      setStatusMessage("Select a registered patient so the appointment can notify their account.");
      setIsSavingAppointment(false);
      return;
    }

    let startTime = toLocalDateTimeIso(
      addAppointmentForm.date,
      addAppointmentForm.startTime
    );
    let endTime = toLocalDateTimeIso(
      addAppointmentForm.date,
      addAppointmentForm.endTime
    );

    if (new Date(endTime) <= new Date(startTime)) {
      endTime = toLocalDateTimeIso(
        addAppointmentForm.date,
        addOneHour(addAppointmentForm.startTime)
      );
    }

    if (
      hasAppointmentConflict(appointments, {
        id: editingAppointmentId,
        start: startTime,
        end: endTime,
      })
    ) {
      setStatusMessage("This appointment conflicts with another active appointment.");
      setIsSavingAppointment(false);
      return;
    }

    const category = categoryList.find((item) => item.id === addAppointmentForm.category);
    const payload = {
      patient_id: patientRecordId,
      patient_name: addAppointmentForm.patientName.trim(),
      doctor_name: addAppointmentForm.doctorName.trim() || staffSettings.displayName,
      title: addAppointmentForm.appointmentType.trim() || category?.label || "Appointment",
      description: JSON.stringify({
        category: addAppointmentForm.category,
        notes: addAppointmentForm.notes.trim(),
      }),
      start_time: startTime,
      end_time: endTime,
      status: "scheduled",
    };

    const saveQuery = editingAppointmentId
      ? supabase
          .from(scheduleTableName)
          .update(payload)
          .eq("id", editingAppointmentId)
          .select(scheduleColumns)
          .single()
      : supabase
          .from(scheduleTableName)
          .insert([payload])
          .select(scheduleColumns)
          .single();

    const { data: savedSchedule, error } = await saveQuery;

    setIsSavingAppointment(false);

    if (error) {
      console.error("Staff appointment insert failed:", error);
      setStatusMessage(`Unable to save appointment: ${error.message}`);
      return;
    }

    const nextDate = new Date(startTime);
    setCalendarDate(nextDate);
    setMiniMonthDate(new Date(nextDate.getFullYear(), nextDate.getMonth(), 1));
    const reminderSaved = savedSchedule
      ? await saveAppointmentReminder(savedSchedule)
      : false;
    setIsAddAppointmentOpen(false);
    setEditingAppointmentId("");
    setAddAppointmentForm(createBlankAppointmentForm(staffSettings));
    await loadAppointments();
    setStatusMessage(
      reminderSaved
        ? "Appointment saved and sent to the patient account."
        : "Appointment saved, but the patient reminder could not be created. Check the reminders table permissions."
    );
  };

  const openAppointmentDetails = useCallback(
    (appointmentId) => {
      const appointment = appointments.find((item) => item.id === appointmentId);
      if (appointment) {
        setDetailAppointment(appointment);
      }
    },
    [appointments]
  );

  const saveFollowUpRecord = async () => {
    if (!selectedAppointment?.id) return;

    setStatusMessage("");

    if (!followUpForm.patientRecordId) {
      setStatusMessage(
        "Unable to check in: no matching patient record was found. Make sure the appointment patient name matches a registered patient."
      );
      return;
    }

    if (!followUpForm.visitDate || !followUpForm.visitTime) {
      setStatusMessage("Date of Visit and Time of Visit are required.");
      return;
    }

    const requiredClinicalFields = [
      ["Blood Pressure", followUpForm.bloodPressure],
      ["Temperature", followUpForm.temperature],
      ["Weight", followUpForm.weight],
      ["Heart Rate", followUpForm.heartRate],
    ];

    const missingClinicalFields = requiredClinicalFields
      .filter(([, value]) => !String(value || "").trim())
      .map(([label]) => label);

    if (missingClinicalFields.length) {
      setStatusMessage(
        `Complete the Clinical Findings before check-in: ${missingClinicalFields.join(
          ", "
        )}.`
      );
      return;
    }

    setIsSavingFollowUp(true);

    const recordPayload = {
      patient_id: followUpForm.patientRecordId,
      patient_name: followUpForm.patientName || selectedAppointment.name,
      type: followUpForm.visitType || "Follow-up Visit",
      title: "Follow-up Visit",
      notes: "Follow-up visit completed by staff.",
      uploaded_by: followUpForm.attendingPhysician || "Staff",
      form_data: {
        appointmentId: followUpForm.appointmentId || selectedAppointment.appointmentId,
        patientId: followUpForm.patientId || "",
        age: followUpForm.age || "",
        contactNumber: followUpForm.contactNumber || "",
        address: followUpForm.address || "",
        visitType: followUpForm.visitType || "Follow-up Visit",
        gestationalAge: followUpForm.gestationalAge || "-",
        expectedDeliveryDate: followUpForm.expectedDeliveryDate
          ? formatLongDate(`${followUpForm.expectedDeliveryDate}T00:00:00`)
          : "-",
        doctor: followUpForm.attendingPhysician || "Staff",
        visitDate: followUpForm.visitDate
          ? formatLongDate(`${followUpForm.visitDate}T00:00:00`)
          : "-",
        visitTime: formatDisplayTime(followUpForm.visitTime) || "-",
        pregnancyStatus: followUpForm.pregnancyStatus,
        findings: [
          {
            label: "Blood Pressure",
            value: followUpForm.bloodPressure,
          },
          {
            label: "Temperature",
            value: followUpForm.temperature,
          },
          {
            label: "Weight",
            value: followUpForm.weight,
          },
          {
            label: "Heart Rate",
            value: followUpForm.heartRate,
          },
        ],
      },
    };

    // Save the follow-up record first. The appointment remains Pending
    // when this insert fails.
    const { data: savedRecord, error: recordError } = await supabase
      .from("medical_records")
      .insert([recordPayload])
      .select("id")
      .single();

    if (recordError) {
      console.error("Follow-up medical record insert failed:", recordError);
      setStatusMessage(
        `Unable to check in: the follow-up record was not saved. ${recordError.message}`
      );
      setIsSavingFollowUp(false);
      return;
    }

    // Change the appointment to Checked in only after the form was saved.
    const { error: statusError } = await supabase
      .from(scheduleTableName)
      .update({ status: getDatabaseStatus("Checked in") })
      .eq("id", selectedAppointment.id);

    if (statusError) {
      console.error("Follow-up check-in update failed:", statusError);

      // Remove the medical record so the two database tables stay consistent.
      if (savedRecord?.id) {
        const { error: rollbackError } = await supabase
          .from("medical_records")
          .delete()
          .eq("id", savedRecord.id);

        if (rollbackError) {
          console.warn(
            "Unable to roll back the follow-up medical record:",
            rollbackError
          );
        }
      }

      setStatusMessage(
        `The follow-up form was not completed because the appointment could not be checked in. ${statusError.message}`
      );
      setIsSavingFollowUp(false);
      return;
    }

    setAppointments((currentAppointments) =>
      currentAppointments.map((appointment) =>
        appointment.id === selectedAppointment.id
          ? {
              ...appointment,
              status: "Checked in",
              filterStatus: "Pending",
            }
          : appointment
      )
    );

    setSelectedAppointment(null);
    setFollowUpForm(createFollowUpForm(null, null));
    setIsSavingFollowUp(false);
    setStatusMessage("");
    await loadAppointments();
  };

  const miniMonthDays = useMemo(() => {
    return buildMiniMonthDays(miniMonthDate, calendarDate).map((day) => ({
      ...day,
      hasEvent: scheduleEvents.some((event) => {
        const eventDate = new Date(event.start);
        return !Number.isNaN(eventDate.getTime()) && isSameDay(eventDate, day.date);
      }),
    }));
  }, [calendarDate, miniMonthDate, scheduleEvents]);

  const selectCalendarDate = (date) => {
    const nextDate = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(nextDate.getTime())) return;

    setCalendarDate(nextDate);
    setMiniMonthDate(new Date(nextDate.getFullYear(), nextDate.getMonth(), 1));
  };

  const moveCalendarWeek = (amount) => {
    setCalendarDate((current) => {
      const nextDate = addDays(current, amount);
      setMiniMonthDate(new Date(nextDate.getFullYear(), nextDate.getMonth(), 1));
      return nextDate;
    });
  };

  if (selectedAppointment) {
    return (
      <FollowUpVisitForm
        form={followUpForm}
        onBack={() => {
          setSelectedAppointment(null);
          setStatusMessage("");
        }}
        onChange={updateFollowUpForm}
        onSave={saveFollowUpRecord}
        saving={isSavingFollowUp}
        statusMessage={statusMessage}
      />
    );
  }

  return (
    <section className="staff-appointments-page">
      <header className="staff-appointments-header staff-section-header">
        <div>
          <h1>Appointments</h1>

          <nav className="staff-appointments-tabs" aria-label="Appointment filters">
            {filters.map((filter) => (
              <button
                type="button"
                key={filter}
                className={activeFilter === filter ? "is-active" : ""}
                onClick={() => setActiveFilter(filter)}
              >
                {filter}
              </button>
            ))}
          </nav>
        </div>

        {headerAction}
      </header>

      {statusMessage ? (
        <p className="staff-appointments-status-message">{statusMessage}</p>
      ) : null}

      <div className="staff-appointments-toolbar">
        <div className="staff-appointments-search-wrap">
          <label className="staff-appointments-search">
            <Icon icon="solar:magnifer-linear" aria-hidden="true" />
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onFocus={() => setIsSearchFocused(true)}
              onBlur={() => window.setTimeout(() => setIsSearchFocused(false), 120)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setIsSearchFocused(false);
                }
              }}
              placeholder="Search Appointment or ID"
              aria-label="Search appointment or ID"
              aria-autocomplete="list"
              aria-expanded={isSearchFocused && searchSuggestions.length > 0}
            />
          </label>

          {isSearchFocused && searchSuggestions.length ? (
            <div className="staff-appointments-suggestions" role="listbox">
              {searchSuggestions.map((suggestion) => (
                <button
                  key={`${suggestion.id}-${suggestion.name}`}
                  type="button"
                  role="option"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setSearchQuery(suggestion.name);
                    setIsSearchFocused(false);
                  }}
                >
                  <strong>{suggestion.name}</strong>
                  <span>{suggestion.appointmentId} - {suggestion.time}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <button
          type="button"
          className="staff-add-appointment-btn"
          onClick={openAddAppointment}
        >
          <Icon icon="solar:add-circle-bold" aria-hidden="true" />
          Add Appointment
        </button>
      </div>

      <AppointmentSummary summary={appointmentSummary} />

      <section className="staff-appointments-table-card">
        <div className="staff-appointments-table-scroll">
          <table className="staff-appointments-table">
            <thead>
              <tr>
                <th>Appointment ID</th>
                <th>Name</th>
                <th>Date</th>
                <th>Time</th>
                <th>Status</th>
              </tr>
            </thead>

            <tbody>
              {filteredAppointments.map((appointment) => (
                <tr key={appointment.id} onClick={() => openAppointmentDetails(appointment.id)}>
                  <td>{appointment.appointmentId}</td>
                  <td>{appointment.name}</td>
                  <td>{appointment.date}</td>
                  <td>{appointment.time}</td>
                  <td>
                    <div
                      className="staff-status-dropdown"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        ref={(node) => {
                          if (node) {
                            statusButtonRefs.current[appointment.id] = node;
                          } else {
                            delete statusButtonRefs.current[appointment.id];
                          }
                        }}
                        className={[
                          "staff-status-trigger",
                          getStatusClass(appointment.status),
                        ].join(" ")}
                        onClick={(event) => {
                          event.stopPropagation();

                          if (isClosedStatus(appointment.status)) {
                            setStatusMessage(
                              "Completed or cancelled appointments cannot be changed."
                            );
                            return;
                          }

                          setOpenStatusMenu((current) => {
                            const nextStatusMenu =
                              current === appointment.id ? null : appointment.id;

                            if (nextStatusMenu) {
                              requestAnimationFrame(() =>
                                updateStatusMenuPosition(nextStatusMenu)
                              );
                            }

                            return nextStatusMenu;
                          });
                        }}
                        aria-haspopup="listbox"
                        aria-expanded={openStatusMenu === appointment.id}
                      >
                        <span>{appointment.status}</span>
                        <Icon icon="solar:alt-arrow-down-linear" aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}

              {!filteredAppointments.length ? (
                <tr>
                  <td colSpan="5" className="staff-appointments-empty-cell">
                    No appointments found.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <div className="staff-appointments-calendar-layout">
        <section className="staff-calendar-panel">
          <CustomCalendarHeader
            selectedCategory={selectedCategory}
            setSelectedCategory={setSelectedCategory}
            selectedDate={calendarDate}
            onPreviousWeek={() => moveCalendarWeek(-7)}
            onNextWeek={() => moveCalendarWeek(7)}
          />

          <StaffWeekCalendar
            events={scheduleEvents}
            selectedDate={calendarDate}
            selectedCategory={selectedCategory}
            onSelectDate={selectCalendarDate}
            onSelectSlot={openAddAppointmentAt}
            onSelectEvent={openAppointmentDetails}
          />

          <div className="staff-mobile-calendar-list">
            {mobileCalendarEvents.map((event) => (
              <button
                key={event.id}
                type="button"
                className={`staff-mobile-calendar-item staff-fullcalendar-event-${event.extendedProps.category}`}
                onClick={() => openAppointmentDetails(event.id)}
              >
                <span>{formatLongDate(event.start)}</span>
                <strong>{event.extendedProps.patient}</strong>
                <small>{event.extendedProps.timeLabel} - {event.extendedProps.label}</small>
              </button>
            ))}

            {!mobileCalendarEvents.length ? (
              <p className="staff-mobile-calendar-empty">No appointments for this week.</p>
            ) : null}
          </div>
        </section>

        <aside className="staff-calendar-sidebar">
          <section className="staff-mini-calendar-card">
            <header>
              <h3>{formatMonthTitle(miniMonthDate)}</h3>
              <div>
                <button
                  type="button"
                  aria-label="Previous month"
                  onClick={() => setMiniMonthDate((current) => addMonths(current, -1))}
                >
                  <Icon icon="solar:alt-arrow-left-linear" />
                </button>
                <button
                  type="button"
                  aria-label="Next month"
                  onClick={() => setMiniMonthDate((current) => addMonths(current, 1))}
                >
                  <Icon icon="solar:alt-arrow-right-linear" />
                </button>
              </div>
            </header>

            <div className="staff-mini-calendar-weekdays">
              {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>

            <div className="staff-mini-calendar-days">
              {miniMonthDays.map((day, index) => (
                <button
                  key={`${day.value}-${index}`}
                  type="button"
                  className={[
                    day.disabled ? "is-disabled" : "",
                    day.hasEvent ? "is-soft" : "",
                    day.active ? "is-active" : "",
                  ].join(" ")}
                  onClick={() => {
                    selectCalendarDate(day.date);
                  }}
                >
                  {day.value}
                </button>
              ))}
            </div>
          </section>

          <section className="staff-categories-card">
            <h3>Categories</h3>

            <div className="staff-category-grid">
              {categoryList.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className={[
                    "staff-category-item",
                    category.colorClass,
                    selectedCategory === category.id ? "is-active" : "",
                  ].join(" ")}
                  onClick={() =>
                    setSelectedCategory((current) =>
                      current === category.id ? "all" : category.id
                    )
                  }
                >
                  <span>
                    <Icon icon={category.icon} />
                  </span>
                  <strong>{category.label}</strong>
                </button>
              ))}
            </div>
          </section>
        </aside>
      </div>

      {openStatusMenu && activeStatusAppointment && statusMenuPosition &&
      typeof document !== "undefined"
        ? createPortal(
            <div
              className="staff-status-portal-menu"
              role="listbox"
              style={{
                top: `${statusMenuPosition.top}px`,
                left: `${statusMenuPosition.left}px`,
              }}
              onClick={(event) => event.stopPropagation()}
            >
              {statusOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={activeStatusAppointment.status === option.value}
                  className={[
                    "staff-status-option",
                    option.className,
                    activeStatusAppointment.status === option.value ? "is-selected" : "",
                  ].join(" ")}
                  onClick={() =>
                    handleStatusChange(activeStatusAppointment.id, option.value)
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}

      {isAddAppointmentOpen ? (
        <AddAppointmentModal
          form={addAppointmentForm}
          mode={editingAppointmentId ? "edit" : "add"}
          onChange={updateAddAppointmentForm}
          onClose={() => {
            setIsAddAppointmentOpen(false);
            setEditingAppointmentId("");
          }}
          onSave={saveAppointment}
          saving={isSavingAppointment}
          patientSuggestions={addAppointmentPatientSuggestions}
          onSelectPatient={selectAddAppointmentPatient}
          isLoadingPatients={isLoadingPatients}
        />
      ) : null}

      {detailAppointment ? (
        <AppointmentDetailsModal
          appointment={detailAppointment}
          onClose={() => setDetailAppointment(null)}
          onEdit={openEditAppointment}
          onCancel={cancelAppointment}
          onCheckIn={(appointment) => {
            setDetailAppointment(null);
            openFollowUpForm(appointment);
          }}
          onComplete={completeAppointment}
        />
      ) : null}
    </section>
  );
}

export default StaffAppointmentsContent;
