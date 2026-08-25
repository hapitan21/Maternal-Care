import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import { parseAppointmentVisitRoute } from "../../lib/appointmentVisitRoute";
import StaffPreConsultationForm from "../appointments/StaffPreConsultationForm";
import SendPatientNotificationAction from "../../components/notifications/SendPatientNotificationAction";
import { sendAutomaticAppointmentNotification } from "../../lib/automaticAppointmentNotification";
import "../../styles/doctor-appointments.css";
import "../../styles/appointment-ui-system.css";
import {
  AppointmentControlGroup,
  AppointmentPageHeader,
  AppointmentPagination,
  AppointmentToolbar,
  AppointmentViewSwitch,
} from "../../components/appointments/AppointmentUi";
import {
  APPOINTMENT_CATEGORIES,
  APPOINTMENT_TYPES,
  buildThirtyMinuteAppointmentRange,
  getAppointmentTypeCategory,
  getAppointmentTypeForCategory,
} from "../../lib/appointmentTypes";
import {
  classifyAppointment,
  compareHistoryAppointments,
  compareUpcomingAppointments,
  formatAppointmentDate,
  formatAppointmentTime,
  getManilaDateKey,
  getManilaTimeKey,
} from "../../lib/appointmentDate";
import "../../styles/staff-appointments.css";

const scheduleTableName = "schedule";
const scheduleColumns =
  "id, maternal_appointment_id, patient_id, doctor_id, patient_name, doctor_name, title, description, start_time, end_time, status";
const patientLookupColumns =
  "id, full_name, patient_id, age, contact_number, address, status";

const filters = ["All", "Pending", "Checked in", "Completed", "Cancelled"];
const appointmentViews = ["Main", "History"];
const appointmentPageSizes = [10, 15];

const statusOptions = [
  { value: "Pending", label: "Pending", className: "is-pending" },
  { value: "Checked in", label: "Check in / Open Form", className: "is-checked" },
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


const categoryList = APPOINTMENT_CATEGORIES;
const appointmentTypeOptions = APPOINTMENT_TYPES;

function getCategoryFromAppointmentType(appointmentType) {
  return getAppointmentTypeCategory(appointmentType);
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

const inactiveDoctorAccountStatuses = new Set([
  "inactive",
  "deactivated",
  "disabled",
  "suspended",
  "archived",
]);

function getDoctorDisplayName(profile, personalInformation) {
  return (
    String(personalInformation?.full_name || "").trim() ||
    String(profile?.full_name || "").trim() ||
    "Doctor"
  );
}

function createBlankAppointmentForm(doctor = null) {
  const today = getLocalDateKey();

  return {
    patientRecordId: "",
    patientName: "",
    doctorId: doctor?.id || "",
    doctorName: doctor?.name || "",
    appointmentType: "",
    date: today,
    startTime: "08:00",
    category: "prenatal",
    notes: "",
  };
}

function formatStatusValue(value) {
  if (value === "Completed") return "Completed";
  if (value === "Checked in") return "Checked in";
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
  return formatAppointmentDate(value, {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
  });
}

function formatTableTime(value) {
  return formatAppointmentTime(value);
}

function formatHourLabel(hour) {
  if (hour === 12) return "12 PM";
  if (hour > 12) return `${hour - 12} PM`;
  return `${String(hour).padStart(2, "0")} AM`;
}

function formatLongDate(value) {
  return value ? formatAppointmentDate(value, { day: "2-digit" }) : "";
}

function formatInputDate(value) {
  return getManilaDateKey(value);
}

function formatInputTime(value) {
  return getManilaTimeKey(value);
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

function isClosedStatus(status) {
  return ["Cancel", "Cancelled", "No show", "Completed"].includes(status);
}

function isCancelledOrNoShowStatus(status) {
  return ["Cancel", "Cancelled", "No show"].includes(status);
}

function appointmentViewMatches(appointment, appointmentView) {
  const classification = classifyAppointment(appointment);

  if (appointmentView === "History") {
    return classification.isHistory;
  }

  return classification.isUpcoming;
}

function monthFilterMatches(appointment, selectedMonth) {
  if (!selectedMonth) return true;

  const scheduleDate = formatInputDate(appointment.startTime);
  if (!scheduleDate) return false;

  return scheduleDate.slice(0, 7) === selectedMonth;
}

function isAppointmentToday(value) {
  return Boolean(value && getManilaDateKey(value) === getManilaDateKey());
}

function isActivePatientForAppointment(patient) {
  return String(patient?.status || "").trim().toLowerCase() === "active";
}

function getScheduleCategory(schedule) {
  const parsed = parseScheduleDescription(schedule.description);
  const title = String(schedule.title || "").trim();
  const titleCategory = getCategoryFromAppointmentType(title);

  if (titleCategory !== "fallback") {
    return titleCategory;
  }

  if (title) {
    return "fallback";
  }

  if (categoryList.some((category) => category.id === parsed.category)) {
    return parsed.category;
  }

  return "fallback";
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
    doctorId: schedule.doctor_id || "",
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

function logAppointmentReminderError(context, error) {
  if (!import.meta.env.DEV || !error) return;

  console.error(`[Staff Appointment Reminder] ${context}:`, {
    code: error.code || null,
    message: error.message || "Unknown Supabase error",
    details: error.details || null,
    hint: error.hint || null,
  });
}

function getAppointmentReminderErrorMessage(error) {
  return [
    error?.message || "Unknown reminder error.",
    error?.code ? `Code: ${error.code}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function CustomCalendarHeader({
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
    </header>
  );
}

function StaffWeekCalendar({
  events,
  selectedDate,
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
  const visibleEvents = events;

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
                    end.setTime(start.getTime() + 30 * 60 * 1000);
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
    attendingPhysician: appointment?.doctorName || "Not assigned",
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
            placeholder="Attending physician"
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
  doctors,
  isLoadingDoctors,
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
            label="Doctor:"
            value={form.doctorId}
            onChange={(value) => onChange("doctorId", value)}
            required
          >
            <option value="" disabled>
              {isLoadingDoctors
                ? "Loading Doctors..."
                : doctors.length
                  ? "Select Doctor"
                  : "No active Doctor available"}
            </option>

            {doctors.map((doctor) => (
              <option key={doctor.id} value={doctor.id}>
                {doctor.name}
              </option>
            ))}
          </AppointmentFormField>

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
            <option value="" disabled>
              Select appointment type
            </option>
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
  onCancel,
  onCheckIn,
  onComplete,
}) {
  if (!appointment) return null;

  const isCheckedIn = isCheckedInStatus(appointment.status);
  const isClosed = isClosedStatus(appointment.status);

  const details = [
    ["Patient name", appointment.name],
    ["Appointment ID", appointment.appointmentId],
    ["Appointment type", appointment.title],
    ["Doctor", appointment.doctorName || "Not assigned"],
    ["Date and time", `${formatLongDate(appointment.startTime)} at ${appointment.time}`],
    ["Status", classifyAppointment(appointment).displayStatus],
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
          <SendPatientNotificationAction
            patientId={appointment.patientId}
            patientName={appointment.name}
            appointmentId={appointment.id}
            defaultType="appointment_reminder"
            outline
          />

          {isCheckedIn ? (
            <button
              type="button"
              className="is-outline staff-appointment-open-visit-btn"
              onClick={() => onComplete(appointment)}
              aria-label={`Open visit for ${appointment.name}`}
            >
              <Icon icon="solar:clipboard-list-bold" aria-hidden="true" />
              Open Visit
            </button>
          ) : (
            <button
              type="button"
              className="is-outline"
              onClick={() => onCheckIn(appointment)}
              disabled={isClosed}
            >
              <Icon icon="solar:login-3-bold" aria-hidden="true" />
              Check in
            </button>
          )}

          <button
            type="button"
            className="is-danger"
            onClick={() => onCancel(appointment)}
            disabled={isClosed}
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
  const location = useLocation();
  const navigate = useNavigate();
  const visitRoute = parseAppointmentVisitRoute(location.pathname, "staff");
  const dashboardAppointmentTarget = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return String(params.get("appointmentId") || "").trim();
  }, [location.search]);
  const [activeFilter, setActiveFilter] = useState("All");
  const [appointmentView, setAppointmentView] = useState("Main");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedMonth, setSelectedMonth] = useState("");
  const [pageSize, setPageSize] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [appointments, setAppointments] = useState([]);
  const [scheduleEvents, setScheduleEvents] = useState([]);
  const [patients, setPatients] = useState([]);
  const [isLoadingPatients, setIsLoadingPatients] = useState(false);
  const [doctors, setDoctors] = useState([]);
  const [isLoadingDoctors, setIsLoadingDoctors] = useState(false);
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
  const [calendarDate, setCalendarDate] = useState(() => new Date());
  const [miniMonthDate, setMiniMonthDate] = useState(() => new Date());
  const [openStatusMenu, setOpenStatusMenu] = useState(null);
  const [statusMenuPosition, setStatusMenuPosition] = useState(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [failedReminderAppointmentId, setFailedReminderAppointmentId] = useState("");
  const [isRetryingReminder, setIsRetryingReminder] = useState(false);
  const [visitRoutingAppointmentId, setVisitRoutingAppointmentId] = useState("");
  const statusButtonRefs = useRef({});
  const appointmentSaveLockRef = useRef(false);
  const appointmentStatusLockRef = useRef(new Set());
  const visitRoutingLockRef = useRef("");

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

    /*
     * Do not force the calendar to the first appointment returned by Supabase.
     *
     * The calendar state already initializes to the current date. Keeping that
     * state means a normal Staff Appointments load, refresh, or new login opens
     * on the current week/month instead of jumping back to the oldest schedule
     * row (which previously kept the UI on July 2026).
     *
     * Dashboard deep links still intentionally move the calendar to the exact
     * appointment date in the separate dashboardAppointmentTarget effect.
     */
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

  /*
   * Dashboard "View Appointment" deep link.
   *
   * The dashboard passes either the public MA number or the schedule UUID.
   * Once appointments are loaded, locate that exact row, align the Main /
   * History view, filter the table to it, and open the existing details modal.
   */
  useEffect(() => {
    if (!dashboardAppointmentTarget || appointments.length === 0) {
      return;
    }

    const target = appointments.find(
      (appointment) =>
        appointment.id === dashboardAppointmentTarget ||
        appointment.appointmentId === dashboardAppointmentTarget
    );

    const frame = window.requestAnimationFrame(() => {
      if (!target) {
        setStatusMessage(
          `Appointment ${dashboardAppointmentTarget} could not be found.`
        );
        return;
      }

      const classification = classifyAppointment(target);

      setActiveFilter("All");
      setAppointmentView(classification.isHistory ? "History" : "Main");
      setSearchQuery(target.appointmentId || dashboardAppointmentTarget);
      setCurrentPage(1);
      setDetailAppointment(target);

      const targetDate = new Date(target.startTime);
      if (!Number.isNaN(targetDate.getTime())) {
        setCalendarDate(targetDate);
        setMiniMonthDate(
          new Date(targetDate.getFullYear(), targetDate.getMonth(), 1)
        );
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [appointments, dashboardAppointmentTarget]);

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
    const initialLoadTimer = window.setTimeout(loadAppointments, 0);

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
      window.clearTimeout(initialLoadTimer);
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
        .rpc("get_staff_patient_directory")
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
    let active = true;

    const applyDoctors = (nextDoctors) => {
      if (!active) return;

      const uniqueDoctors = Array.from(
        new Map(
          (nextDoctors || [])
            .filter((doctor) => doctor?.id)
            .map((doctor) => [
              doctor.id,
              {
                id: doctor.id,
                name: String(doctor.name || "Doctor").trim() || "Doctor",
              },
            ])
        ).values()
      ).sort((first, second) =>
        first.name.localeCompare(second.name, undefined, {
          sensitivity: "base",
        })
      );

      setDoctors(uniqueDoctors);

      setAddAppointmentForm((current) => {
        if (!uniqueDoctors.length) {
          return {
            ...current,
            doctorId: "",
            doctorName: "",
          };
        }

        const currentDoctor =
          uniqueDoctors.find((doctor) => doctor.id === current.doctorId) ||
          uniqueDoctors.find(
            (doctor) =>
              doctor.name.toLowerCase() ===
              String(current.doctorName || "").trim().toLowerCase()
          );

        const defaultDoctor = currentDoctor || uniqueDoctors[0];

        return {
          ...current,
          doctorId: defaultDoctor.id,
          doctorName: defaultDoctor.name,
        };
      });
    };

    const loadDoctors = async () => {
      setIsLoadingDoctors(true);

      /*
       * IMPORTANT:
       * Staff Patient registration already uses this secure RPC to obtain
       * the active Doctor directory. Reuse it here instead of depending
       * on Staff being able to SELECT every Doctor row from public.profiles.
       */
      const slotDate = addAppointmentForm.date || getLocalDateKey();
      const rpcResult = await supabase.rpc(
        "get_walkin_registration_availability",
        {
          p_slot_date: slotDate,
        }
      );

      if (!active) return;

      if (!rpcResult.error && Array.isArray(rpcResult.data)) {
        applyDoctors(
          rpcResult.data.map((row) => ({
            id: row.doctor_id,
            name: row.doctor_name || "Doctor",
          }))
        );
        setIsLoadingDoctors(false);
        return;
      }

      /*
       * Compatibility fallback for environments where the walk-in RPC
       * has not yet been installed. Existing RLS still decides visibility.
       */
      const [profilesResult, personalResult] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, full_name, role, account_status")
          .ilike("role", "doctor")
          .order("full_name", { ascending: true }),
        supabase
          .from("doctor_personal_information")
          .select("auth_user_id, full_name"),
      ]);

      if (!active) return;

      setIsLoadingDoctors(false);

      if (profilesResult.error) {
        console.warn(
          "Staff appointment Doctor directory failed:",
          rpcResult.error || profilesResult.error
        );
        applyDoctors([]);
        setStatusMessage(
          "Unable to load active Doctors. Please refresh and try again."
        );
        return;
      }

      const personalByDoctor = new Map(
        (personalResult.error ? [] : personalResult.data || []).map((row) => [
          row.auth_user_id,
          row,
        ])
      );

      const activeDoctors = (profilesResult.data || [])
        .filter((profile) => {
          const status = String(profile.account_status || "active")
            .trim()
            .toLowerCase();

          return (
            profile.id &&
            String(profile.role || "").trim().toLowerCase() === "doctor" &&
            !inactiveDoctorAccountStatuses.has(status)
          );
        })
        .map((profile) => ({
          id: profile.id,
          name: getDoctorDisplayName(
            profile,
            personalByDoctor.get(profile.id)
          ),
        }));

      applyDoctors(activeDoctors);
    };

    loadDoctors();

    return () => {
      active = false;
    };
  }, [addAppointmentForm.date]);

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
      if (!appointmentViewMatches(appointment, appointmentView)) return false;
      if (!monthFilterMatches(appointment, selectedMonth)) return false;
      if (!keyword) return true;

      return [
        appointment.appointmentId,
        appointment.patientId,
        appointment.name,
        appointment.date,
        appointment.time,
        appointment.status,
        appointment.title,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(keyword));
    }).sort(
      appointmentView === "History"
        ? compareHistoryAppointments
        : compareUpcomingAppointments
    );
  }, [
    activeFilter,
    appointmentView,
    appointments,
    searchQuery,
    selectedMonth,
  ]);

  const totalPages = Math.max(1, Math.ceil(filteredAppointments.length / pageSize));
  const paginatedAppointments = useMemo(() => {
    const startIndex = (currentPage - 1) * pageSize;
    return filteredAppointments.slice(startIndex, startIndex + pageSize);
  }, [currentPage, filteredAppointments, pageSize]);

  useEffect(() => {
    const pageResetTimer = window.setTimeout(() => setCurrentPage(1), 0);
    return () => window.clearTimeout(pageResetTimer);
  }, [activeFilter, appointmentView, pageSize, searchQuery, selectedMonth]);

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
        if (!appointmentViewMatches(appointment, appointmentView)) return false;
        if (!monthFilterMatches(appointment, selectedMonth)) return false;

        return [
          appointment.name,
          appointment.patientId,
          appointment.appointmentId,
          appointment.title,
        ]
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
  }, [
    activeFilter,
    appointmentView,
    appointments,
    searchQuery,
    selectedMonth,
  ]);

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

        if (isCancelledOrNoShowStatus(appointment.status)) {
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
    return scheduleEvents.map((event) => ({
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
  }, [scheduleEvents]);

  const mobileCalendarEvents = useMemo(() => {
    const weekStart = getStartOfWeek(calendarDate);
    const weekEnd = addDays(weekStart, 7);

    return fullCalendarEvents.filter((event) => {
      const eventDate = new Date(event.start);
      return eventDate >= weekStart && eventDate < weekEnd;
    });
  }, [calendarDate, fullCalendarEvents]);

  useLayoutEffect(() => {
    if (!openStatusMenu) return;

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
      if (!schedule?.id) {
        return {
          ok: false,
          error: { message: "The saved appointment ID was not returned." },
        };
      }

      try {
        const { data, error } = await supabase.rpc(
          "create_appointment_patient_reminder",
          { p_appointment_id: schedule.id }
        );

        if (error) {
          logAppointmentReminderError("RPC failed", error);
          return { ok: false, error };
        }

        if (!data) {
          const responseError = {
            message: "The appointment reminder record was not returned.",
          };
          logAppointmentReminderError("RPC returned no reminder", responseError);
          return { ok: false, error: responseError };
        }

        return { ok: true, reminder: data };
      } catch (error) {
        logAppointmentReminderError("Unexpected RPC failure", error);
        return { ok: false, error };
      }
    },
    []
  );

  const retryAppointmentReminder = useCallback(async () => {
    if (!failedReminderAppointmentId || isRetryingReminder) return;

    setIsRetryingReminder(true);
    let result;

    try {
      result = await saveAppointmentReminder({
        id: failedReminderAppointmentId,
      });
    } finally {
      setIsRetryingReminder(false);
    }

    if (!result?.ok) {
      setStatusMessage(
        `Appointment saved, but the Patient reminder could not be created. ${getAppointmentReminderErrorMessage(result?.error)}`
      );
      return;
    }

    setFailedReminderAppointmentId("");
    setStatusMessage("Patient reminder created successfully.");
  }, [failedReminderAppointmentId, isRetryingReminder, saveAppointmentReminder]);

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
    async (appointment, nextStatus, extraPayload = {}, options = {}) => {
      const mutationKey = `${appointment.id}:${getDatabaseStatus(nextStatus)}`;
      if (appointmentStatusLockRef.current.has(mutationKey)) return false;

      appointmentStatusLockRef.current.add(mutationKey);

      try {
        const { data, error } = await supabase
          .from(scheduleTableName)
          .update({
            ...extraPayload,
            status: getDatabaseStatus(nextStatus),
          })
          .eq("id", appointment.id)
          .select(scheduleColumns)
          .single();

        if (error) {
          console.error("Staff appointment status update failed:", {
            code: error.code || null,
            message: error.message || "Unknown schedule update error",
          });
          setStatusMessage(`Unable to update status: ${error.message}`);
          return false;
        }

        const notificationResult = options.notificationType
          ? await sendAutomaticAppointmentNotification({
              patientId: data.patient_id,
              scheduleId: data.id,
              notificationType: options.notificationType,
            })
          : null;

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
        return { savedSchedule: data, notificationResult };
      } finally {
        appointmentStatusLockRef.current.delete(mutationKey);
      }
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

      const saved = await updateAppointmentStatus(
        appointment,
        "Cancelled",
        { description },
        { notificationType: "appointment_cancelled" }
      );

      if (saved) {
        await disableAppointmentReminders(appointment.id);
        setDetailAppointment(null);
        setStatusMessage(
          saved.notificationResult?.ok
            ? "Appointment cancelled and Patient notified."
            : "Appointment was saved, but the Patient notification could not be sent."
        );
      }

      setOpenStatusMenu(null);
    },
    [disableAppointmentReminders, updateAppointmentStatus]
  );

  const checkInAndOpenVisitForm = useCallback(
    async (appointment) => {
      if (!appointment?.id || visitRoutingLockRef.current) return;

      visitRoutingLockRef.current = appointment.id;
      setVisitRoutingAppointmentId(appointment.id);
      setOpenStatusMenu(null);
      setDetailAppointment(null);
      setStatusMessage("");

      try {
        const isAlreadyCheckedIn = isCheckedInStatus(appointment.status);
        const saved = isAlreadyCheckedIn
          ? true
          : await updateAppointmentStatus(appointment, "Checked in");

        if (!saved) return;

        const { data, error } = await supabase.rpc(
          "get_appointment_visit_form_type",
          { p_appointment_id: appointment.id }
        );

        if (error) {
          logAppointmentReminderError("visit-routing RPC failed", error);
          setStatusMessage(
            `Appointment checked in, but the visit form could not be opened. ${getAppointmentReminderErrorMessage(error)}`
          );
          return;
        }

        const routeResult = Array.isArray(data) ? data[0] : data;
        if (!routeResult?.visit_form_type) {
          setStatusMessage(
            "Appointment checked in, but the visit-routing RPC returned no form type. Retry Check in."
          );
          return;
        }

        const routeSegment = routeResult.visit_form_type === "initial"
          ? "initial-visit"
          : "follow-up";
        navigate(`/staff/appointments/${appointment.id}/${routeSegment}`);
      } finally {
        visitRoutingLockRef.current = "";
        setVisitRoutingAppointmentId("");
      }
    },
    [navigate, updateAppointmentStatus]
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
      await checkInAndOpenVisitForm(currentAppointment);
      return;
    }

    if (newStatus === "Cancelled" || newStatus === "Cancel") {
      await cancelAppointment(currentAppointment);
      return;
    }

    if (newStatus === "Completed") {
      await checkInAndOpenVisitForm(currentAppointment);
      return;
    }

    setOpenStatusMenu(null);
  };

  const updateFollowUpForm = (field, value) => {
    setFollowUpForm((current) => ({ ...current, [field]: value }));
  };

  const openAddAppointment = () => {
    setStatusMessage("");
    setEditingAppointmentId("");
    setAddAppointmentForm(createBlankAppointmentForm(doctors[0] || null));
    setIsAddAppointmentOpen(true);
  };

  const openAddAppointmentAt = useCallback(
    (startDate, endDate) => {
      const start = startDate instanceof Date ? startDate : new Date(startDate);
      const end = endDate instanceof Date ? endDate : new Date(endDate || start);

      if (Number.isNaN(start.getTime())) return;

      if (Number.isNaN(end.getTime()) || end <= start) {
        end.setTime(start.getTime());
        end.setTime(start.getTime() + 30 * 60 * 1000);
      }

      const category = "prenatal";

      setStatusMessage("");
      setEditingAppointmentId("");
      setAddAppointmentForm({
        ...createBlankAppointmentForm(doctors[0] || null),
        date: getLocalDateKey(start),
        startTime: formatInputTime(start),
        endTime: formatInputTime(end),
        category,
        appointmentType: getAppointmentTypeForCategory(category),
      });
      setIsAddAppointmentOpen(true);
    },
    [doctors]
  );

  const updateAddAppointmentForm = (field, value) => {
    setAddAppointmentForm((current) => {
      const next = { ...current, [field]: value };

      if (field === "patientName") {
        next.patientRecordId = "";
      }

      if (field === "appointmentType") {
        next.category = getCategoryFromAppointmentType(value);
      }

      if (field === "doctorId") {
        const selectedDoctor = doctors.find(
          (doctor) => doctor.id === value
        );

        next.doctorId = selectedDoctor?.id || "";
        next.doctorName = selectedDoctor?.name || "";
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
      .rpc("get_staff_patient_directory")
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
    if (appointmentSaveLockRef.current) return;

    appointmentSaveLockRef.current = true;

    try {
    setStatusMessage("");

    if (!addAppointmentForm.patientName.trim()) {
      setStatusMessage("Patient name is required.");
      return;
    }

    if (!addAppointmentForm.date || !addAppointmentForm.startTime) {
      setStatusMessage("Choose a valid appointment date and time.");
      return;
    }

    if (!addAppointmentForm.appointmentType.trim()) {
      setStatusMessage("Select an appointment type.");
      return;
    }

    const selectedDoctor = doctors.find(
      (doctor) => doctor.id === addAppointmentForm.doctorId
    );

    if (!selectedDoctor) {
      setStatusMessage(
        "Select an active Doctor before saving the appointment."
      );
      return;
    }

    setIsSavingAppointment(true);

    const patientRecordId = await resolveAddAppointmentPatientId();

    if (!patientRecordId) {
      setStatusMessage("Select a registered patient so the appointment can notify their account.");
      setIsSavingAppointment(false);
      return;
    }

    const appointmentRange = buildThirtyMinuteAppointmentRange(
      addAppointmentForm.date,
      addAppointmentForm.startTime
    );

    if (!appointmentRange) {
      setStatusMessage("Choose a valid appointment date and time.");
      setIsSavingAppointment(false);
      return;
    }

    const { startDate, endDate } = appointmentRange;

    if (startDate < new Date()) {
      setStatusMessage("Appointments cannot start in the past.");
      setIsSavingAppointment(false);
      return;
    }

    const startTime = startDate.toISOString();
    const endTime = endDate.toISOString();

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
      doctor_id: selectedDoctor.id,
      doctor_name: selectedDoctor.name,
      title: addAppointmentForm.appointmentType.trim() || category?.label || "Appointment",
      description: JSON.stringify({
        category: addAppointmentForm.category,
        notes: addAppointmentForm.notes.trim(),
      }),
      start_time: startTime,
      end_time: endTime,
      status: "scheduled",
    };
    const wasEditing = Boolean(editingAppointmentId);

    const saveQuery = wasEditing
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

    if (error) {
      setIsSavingAppointment(false);
      console.error("Staff appointment insert failed:", error);
      setStatusMessage(`Unable to save appointment: ${error.message}`);
      return;
    }

    const nextDate = new Date(startTime);
    setCalendarDate(nextDate);
    setMiniMonthDate(new Date(nextDate.getFullYear(), nextDate.getMonth(), 1));
    const notificationResult = savedSchedule
      ? await sendAutomaticAppointmentNotification({
          patientId: savedSchedule.patient_id,
          scheduleId: savedSchedule.id,
          notificationType: wasEditing
            ? "appointment_rescheduled"
            : "appointment_created",
        })
      : {
          ok: false,
          error: { message: "The saved appointment was not returned." },
        };
    const reminderResult = savedSchedule
      ? await saveAppointmentReminder(savedSchedule)
      : { ok: false, error: { message: "The saved appointment was not returned." } };
    setIsAddAppointmentOpen(false);
    setEditingAppointmentId("");
    setAddAppointmentForm(createBlankAppointmentForm(doctors[0] || null));
    await loadAppointments();
    if (!notificationResult.ok) {
      setFailedReminderAppointmentId(reminderResult.ok ? "" : savedSchedule?.id || "");
      setStatusMessage(
        "Appointment was saved, but the Patient notification could not be sent."
      );
    } else if (reminderResult.ok) {
      setFailedReminderAppointmentId("");
      setStatusMessage(
        wasEditing
          ? "Appointment rescheduled and Patient notified."
          : "Appointment created and Patient notified."
      );
    } else {
      setFailedReminderAppointmentId(savedSchedule?.id || "");
      setStatusMessage(
        `${
          wasEditing
            ? "Appointment rescheduled and Patient notified"
            : "Appointment created and Patient notified"
        }, but the Patient reminder could not be created. ${getAppointmentReminderErrorMessage(reminderResult.error)}`
      );
    }
    } finally {
      appointmentSaveLockRef.current = false;
      setIsSavingAppointment(false);
    }
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

  const closeAppointmentDetails = useCallback(() => {
    setDetailAppointment(null);

    if (!dashboardAppointmentTarget) {
      return;
    }

    const params = new URLSearchParams(location.search);
    params.delete("appointmentId");
    const nextSearch = params.toString();

    navigate(
      {
        pathname: location.pathname,
        search: nextSearch ? `?${nextSearch}` : "",
      },
      { replace: true }
    );
  }, [
    dashboardAppointmentTarget,
    location.pathname,
    location.search,
    navigate,
  ]);

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
        doctor: followUpForm.attendingPhysician || "Not assigned",
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

    const { error: recordError } = await supabase.rpc(
      "save_staff_visit_intake",
      {
        p_appointment_id: selectedAppointment.id,
        p_visit_form_type: "follow_up",
        p_intake_data: recordPayload.form_data,
      }
    );

    if (recordError) {
      console.error("Follow-up medical record insert failed:", recordError);
      setStatusMessage(
        `Unable to check in: the Staff intake was not saved. ${recordError.message}`
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

      setStatusMessage(
        `The Staff intake was saved, but the appointment could not be checked in. ${statusError.message}`
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
              filterStatus: "Checked in",
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

  if (visitRoute) {
    return (
      <StaffPreConsultationForm
        appointmentId={visitRoute.appointmentId}
        requestedType={visitRoute.requestedType}
      />
    );
  }

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
    <section className="staff-appointments-page appointment-workspace appointment-workspace--staff">
      <AppointmentPageHeader
        title="Appointments"
        subtitle="Manage scheduling, arrivals, and appointment status."
        tabs={filters}
        activeTab={activeFilter}
        onTabChange={setActiveFilter}
        action={headerAction}
        className="staff-appointments-header staff-section-header"
        tabsClassName="staff-appointments-tabs"
        tabsLabel="Appointment filters"
      />

      {statusMessage ? (
        <div className="staff-appointments-status-message" role="status">
          <span>{statusMessage}</span>
          {failedReminderAppointmentId ? (
            <button
              type="button"
              onClick={retryAppointmentReminder}
              disabled={isRetryingReminder}
            >
              {isRetryingReminder ? "Retrying..." : "Retry Reminder"}
            </button>
          ) : null}
        </div>
      ) : null}

      <AppointmentToolbar
        as="div"
        className="staff-appointments-toolbar staff-appointments-toolbar-labeled"
      >
        <AppointmentControlGroup
          label="View"
          area="view"
          className="staff-appointments-control-group staff-appointments-view-group"
        >
          <AppointmentViewSwitch
            options={appointmentViews}
            value={appointmentView}
            onChange={setAppointmentView}
            className="staff-appointments-view-switch"
          />
        </AppointmentControlGroup>

        <AppointmentControlGroup
          label="Search Appointments"
          area="search"
          className="staff-appointments-control-group staff-appointments-search-group"
        >
          <div className="staff-appointments-search-wrap">
            <label className="staff-appointments-search appointment-ui-search">
              <Icon icon="solar:magnifer-linear" aria-hidden="true" />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onFocus={() => setIsSearchFocused(true)}
                onBlur={() =>
                  window.setTimeout(() => setIsSearchFocused(false), 120)
                }
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setIsSearchFocused(false);
                  }
                }}
                placeholder="Search Appointment, Patient, or ID"
                aria-label="Search appointment, patient, or ID"
                aria-autocomplete="list"
                aria-expanded={
                  isSearchFocused && searchSuggestions.length > 0
                }
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
                    <span>
                      {suggestion.appointmentId} - {suggestion.time}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </AppointmentControlGroup>

        <AppointmentControlGroup
          as="label"
          label="Filter by Month"
          area="month"
          className="staff-appointments-month-filter staff-appointments-control-group"
        >
          <div className="staff-appointments-month-control appointment-ui-month">
            <Icon icon="solar:calendar-linear" aria-hidden="true" />

            <input
              type="month"
              value={selectedMonth}
              onChange={(event) => setSelectedMonth(event.target.value)}
              aria-label="Filter appointments by month"
            />

            {selectedMonth ? (
              <button
                type="button"
                className="staff-appointments-month-clear"
                onClick={() => setSelectedMonth("")}
                aria-label="Clear month filter"
                title="Clear month filter"
              >
                <Icon icon="solar:close-circle-bold" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </AppointmentControlGroup>

        <AppointmentControlGroup
          label="Quick Action"
          area="action"
          className="staff-appointments-control-group staff-appointments-action-group"
        >
          <button
            type="button"
            className="staff-add-appointment-btn appointment-ui-primary"
            onClick={openAddAppointment}
          >
            <Icon icon="solar:add-circle-bold" aria-hidden="true" />
            Add Appointment
          </button>
        </AppointmentControlGroup>
      </AppointmentToolbar>

      <AppointmentSummary summary={appointmentSummary} />

      <section className="staff-appointments-table-card appointment-ui-table-card">
        <div className="staff-appointments-table-scroll appointment-ui-table-scroll">
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
              {paginatedAppointments.map((appointment) => (
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
                          "appointment-ui-status",
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
                        <span>{classifyAppointment(appointment).displayStatus}</span>
                        <Icon icon="solar:alt-arrow-down-linear" aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}

              {!paginatedAppointments.length ? (
                <tr>
                  <td colSpan="5" className="staff-appointments-empty-cell">
                    No appointments found.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <AppointmentPagination
          className="staff-appointments-pagination"
          currentPage={currentPage}
          pageSize={pageSize}
          pageSizes={appointmentPageSizes}
          totalItems={filteredAppointments.length}
          totalPages={totalPages}
          onPageChange={setCurrentPage}
          onPageSizeChange={setPageSize}
        />
      </section>

      <div className="staff-appointments-calendar-layout">
        <section className="staff-calendar-panel">
          <CustomCalendarHeader
            selectedDate={calendarDate}
            onPreviousWeek={() => moveCalendarWeek(-7)}
            onNextWeek={() => moveCalendarWeek(7)}
          />

          <StaffWeekCalendar
            events={scheduleEvents}
            selectedDate={calendarDate}
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
                  disabled={visitRoutingAppointmentId === activeStatusAppointment.id}
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
          doctors={doctors}
          isLoadingDoctors={isLoadingDoctors}
        />
      ) : null}

      {detailAppointment ? (
        <AppointmentDetailsModal
          appointment={detailAppointment}
          onClose={closeAppointmentDetails}
          onCancel={cancelAppointment}
          onCheckIn={(appointment) => {
            checkInAndOpenVisitForm(appointment);
          }}
          onComplete={checkInAndOpenVisitForm}
        />
      ) : null}
    </section>
  );
}

export default StaffAppointmentsContent;
