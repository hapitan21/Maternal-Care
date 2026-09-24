import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import { parseAppointmentVisitRoute } from "../../lib/appointmentVisitRoute";
import StaffPreConsultationForm from "../appointments/StaffPreConsultationForm";
import SendPatientNotificationAction from "../../components/notifications/SendPatientNotificationAction";
import AppointmentNoShowDialog from "../../components/appointments/AppointmentNoShowDialog";
import AppointmentStatusPopover from "../../components/appointments/AppointmentStatusPopover";
import { sendAutomaticAppointmentNotification } from "../../lib/automaticAppointmentNotification";
import {
  appointmentSmsEvents,
  requestAppointmentSms,
} from "../../lib/appointmentSms";
import { getAppointmentStatusPopoverPosition } from "../../lib/appointmentStatusPopover";
import "../../styles/doctor-appointments.css";
import "../../styles/appointment-ui-system.css";
import {
  AppointmentControlGroup,
  AppointmentPageHeader,
  AppointmentPagination,
  AppointmentToolbar,
} from "../../components/appointments/AppointmentUi";
import AppointmentTimePicker from "../../components/appointments/AppointmentTimePicker";
import {
  APPOINTMENT_CATEGORIES,
  APPOINTMENT_TYPES,
  buildThirtyMinuteAppointmentRange,
  getAppointmentTypeCategory,
  getAppointmentTypeForCategory,
} from "../../lib/appointmentTypes";
import {
  classifyAppointment,
  appointmentStatuses,
  appointmentStoredStatuses,
  compareAppointmentsByStatusPriority,
  getAppointmentStatusTab,
  formatAppointmentDate,
  formatAppointmentTime,
  getManilaDateKey,
  getManilaTimeKey,
  isAppointmentNoShowEligible,
  normalizeAppointmentStatus,
} from "../../lib/appointmentDate";
import "../../styles/staff-appointments.css";

const scheduleTableName = "schedule";
const appointmentRequestTableName = "create_patient_appointment_request";
const scheduleColumns =
  "id, maternal_appointment_id, patient_id, doctor_id, patient_name, doctor_name, title, description, start_time, end_time, status";
const patientLookupColumns =
  "id, full_name, patient_id, age, contact_number, email, address, status";
const appointmentRequestColumns =
  "id, patient_id, patient_name, doctor_id, doctor_name, title, category, description, start_time, end_time, status, schedule_id, created_at, updated_at";

const filters = ["All", "Requests", "Pending", "Checked-in", "Completed", "Cancelled", "Missed"];
const appointmentPageSizes = [10, 15];

const pendingStatusActions = [
  {
    value: "Checked in",
    label: "Check in",
    tone: "check-in",
    icon: "solar:login-2-linear",
  },
  {
    value: "Cancelled",
    label: "Cancelled",
    tone: "cancelled",
    icon: "solar:close-circle-linear",
  },
  {
    value: "No show",
    label: "No Show",
    tone: "no-show",
    icon: "solar:clock-circle-linear",
  },
];

const checkedInActions = [
  {
    value: "open_form",
    label: "Open Visit Form",
    tone: "open-form",
    icon: "solar:document-medicine-linear",
    trailingIcon: "solar:arrow-right-linear",
  },
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

const initialStaffRescheduleForm = {
  date: "",
  time: "",
  message: "",
};

function formatStatusValue(value) {
  if (value === "Completed") return "Completed";
  if (value === "Checked in") return "Checked in";
  if (value === "No show") return "Missed";
  if (value === "Cancel" || value === "Cancelled") return "Cancelled";
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
  if (status === "No show") return appointmentStoredStatuses.noShow;
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

function formatRequestDate(value) {
  if (!value) return "Not recorded";
  return formatAppointmentDate(value, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getRequestId(request, index = 0) {
  const createdAt = request?.created_at || request?.start_time;
  const date = createdAt ? new Date(createdAt) : new Date();
  const year = Number.isNaN(date.getTime())
    ? String(new Date().getFullYear()).slice(-2)
    : String(date.getFullYear()).slice(-2);
  const source = String(request?.id || index + 1).replace(/[^a-z0-9]/gi, "");
  const suffix = source.slice(-4).toUpperCase().padStart(4, "0");
  return `REQ-${year}-${suffix}`;
}

function getRequestCategory(request) {
  const explicit = String(request?.category || "").trim();
  if (categoryList.some((category) => category.id === explicit)) {
    return explicit;
  }
  return getCategoryFromAppointmentType(request?.title || "");
}

function getRequestCategoryIcon(request) {
  const category = getRequestCategory(request);
  if (category === "laboratory") return "solar:test-tube-linear";
  if (category === "ultrasound") return "solar:monitor-camera-linear";
  if (category === "prenatal") return "solar:medical-kit-linear";
  return "solar:heart-pulse-linear";
}

function isCheckedInStatus(status) {
  return status === "Checked in";
}

function isClosedStatus(status) {
  return ["Cancel", "Cancelled", "No show", "Completed"].includes(status);
}

function isCancelledStatus(status) {
  return ["Cancel", "Cancelled"].includes(status);
}

function appointmentStatusMatches(appointment, activeFilter) {
  if (activeFilter === "All") return true;

  const status = normalizeAppointmentStatus(
    appointment?.databaseStatus ?? appointment?.status
  );
  if (activeFilter === "Pending") return status === appointmentStatuses.scheduled;
  if (activeFilter === "Checked-in") return status === appointmentStatuses.checkedIn;
  if (activeFilter === "Completed") return status === appointmentStatuses.completed;
  if (activeFilter === "Cancelled") return status === appointmentStatuses.cancelled;
  if (activeFilter === "Missed") return status === appointmentStatuses.missed;
  return false;
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

function getScheduleHumanMessage(description) {
  const details = parseScheduleDescription(description);

  return String(
    details.notes ||
      details.message ||
      details.description ||
      ""
  ).trim();
}

function buildStaffScheduleDescription(
  description,
  { message, cancellationReason, remindersDisabled } = {}
) {
  const details = { ...parseScheduleDescription(description) };

  if (message !== undefined) {
    delete details.notes;
    delete details.message;
    delete details.description;

    const nextMessage = String(message || "").trim();
    if (nextMessage) details.notes = nextMessage;
  }

  if (cancellationReason !== undefined) {
    delete details.cancellationReason;
    delete details.cancel_reason;
    delete details.reason;

    const nextReason = String(cancellationReason || "").trim();
    if (nextReason) details.cancellationReason = nextReason;
  }

  if (remindersDisabled !== undefined) {
    if (remindersDisabled) {
      details.remindersDisabled = true;
    } else {
      delete details.remindersDisabled;
    }
  }

  return JSON.stringify(details);
}

function getAutomaticNotificationStatusMessage(
  notificationResult,
  { sentMessage, skippedMessage, failedMessage }
) {
  if (notificationResult?.ok) return sentMessage;

  if (
    notificationResult?.skipped &&
    notificationResult?.reason === "patient_not_linked"
  ) {
    return skippedMessage;
  }

  return failedMessage;
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
    databaseStatus: schedule.status,
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

          <div className="staff-add-appointment-field">
            <span id="staff-add-appointment-time-label">Select Time:</span>
            <AppointmentTimePicker
              id="staff-add-appointment-time"
              labelId="staff-add-appointment-time-label"
              value={form.startTime}
              onChange={(value) => onChange("startTime", value)}
              required
            />
          </div>

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
  const isPending = appointment.status === "Pending";

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
            disabled={!isPending}
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

function StaffCancelAppointmentDialog({
  appointment,
  reason,
  error,
  busy,
  onReasonChange,
  onClose,
  onConfirm,
  onReschedule,
}) {
  if (!appointment) return null;

  return createPortal(
    <div
      className="staff-cancel-appointment-overlay"
      role="presentation"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <section
        className="staff-cancel-appointment-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="staff-cancel-appointment-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          className="staff-cancel-appointment-close"
          type="button"
          aria-label="Close cancel appointment dialog"
          onClick={onClose}
          disabled={busy}
        >
          <Icon icon="solar:close-circle-linear" />
        </button>

        <div className="staff-cancel-appointment-heading">
          <span className="staff-cancel-appointment-icon" aria-hidden="true">
            <Icon icon="solar:close-circle-bold" />
          </span>
          <div>
            <h2 id="staff-cancel-appointment-title">Cancel Appointment</h2>
            <p>Are you sure you want to cancel this appointment?</p>
          </div>
        </div>

        <div
          className="staff-cancel-appointment-summary"
          aria-label="Appointment summary"
        >
          <strong>{appointment.appointmentId || "Appointment"}</strong>
          <span>{appointment.name || "Patient"}</span>
          <small>
            {formatLongDate(appointment.startTime)} • {appointment.time}
          </small>
        </div>

        <label className="staff-cancel-reason-field">
          <span>Cancellation Reason *</span>
          <textarea
            rows="4"
            value={reason}
            placeholder="Enter reason for cancellation..."
            onChange={(event) => onReasonChange(event.target.value)}
            disabled={busy}
            autoFocus
          />
        </label>

        {error ? (
          <p className="staff-appointment-modal-error" role="alert">
            {error}
          </p>
        ) : null}

        <button
          className="staff-cancel-reschedule-link"
          type="button"
          onClick={onReschedule}
          disabled={busy}
        >
          Reschedule instead
          <Icon icon="solar:arrow-right-linear" />
        </button>

        <div className="staff-cancel-appointment-actions">
          <button
            className="staff-cancel-keep-button"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Keep Appointment
          </button>

          <button
            className="staff-cancel-confirm-button"
            type="button"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Cancelling..." : "Cancel Appointment"}
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}

function StaffRescheduleAppointmentDialog({
  appointment,
  form,
  error,
  busy,
  onChange,
  onClose,
  onSave,
}) {
  if (!appointment) return null;

  return createPortal(
    <div
      className="staff-reschedule-appointment-overlay"
      role="presentation"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <section
        className="staff-reschedule-appointment-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="staff-reschedule-appointment-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          className="staff-reschedule-appointment-close"
          type="button"
          aria-label="Close reschedule appointment dialog"
          onClick={onClose}
          disabled={busy}
        >
          <Icon icon="solar:close-circle-linear" />
        </button>

        <div className="staff-reschedule-appointment-heading">
          <span className="staff-reschedule-appointment-icon" aria-hidden="true">
            <Icon icon="solar:calendar-mark-bold" />
          </span>
          <div>
            <h2 id="staff-reschedule-appointment-title">
              Reschedule Appointment
            </h2>
            <p>Choose a new date and time for this appointment.</p>
          </div>
        </div>

        <div className="staff-reschedule-current-schedule">
          <span>Current Schedule</span>
          <strong>
            {formatLongDate(appointment.startTime)} • {appointment.time}
          </strong>
        </div>

        <form onSubmit={onSave}>
          <label className="staff-reschedule-field">
            <span>Select Date:</span>
            <input
              type="date"
              value={form.date}
              onChange={(event) => onChange("date", event.target.value)}
              required
              disabled={busy}
            />
          </label>

          <div className="staff-reschedule-field">
            <span id="staff-reschedule-time-label">Select Time:</span>
            <AppointmentTimePicker
              id="staff-reschedule-time"
              labelId="staff-reschedule-time-label"
              value={form.time}
              onChange={(value) => onChange("time", value)}
              required
            />
          </div>

          <label className="staff-reschedule-field is-full">
            <span>Reason / Message</span>
            <textarea
              rows="3"
              placeholder="Optional reason for rescheduling..."
              value={form.message}
              onChange={(event) => onChange("message", event.target.value)}
              disabled={busy}
            />
          </label>

          {error ? (
            <p className="staff-appointment-modal-error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="staff-reschedule-appointment-actions">
            <button
              className="staff-reschedule-save-button"
              type="submit"
              disabled={busy}
            >
              {busy ? "Saving..." : "Save New Schedule"}
            </button>

            <button
              className="staff-reschedule-back-button"
              type="button"
              onClick={onClose}
              disabled={busy}
            >
              Back
            </button>
          </div>
        </form>
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

function StaffAppointmentRequests({
  requests,
  totalRequests,
  currentPage,
  totalPages,
  searchTerm,
  sortOrder,
  patients,
  miniMonthDate,
  miniMonthDays,
  todayAppointments,
  onSearchChange,
  onSortChange,
  onPageChange,
  onMonthChange,
  onSelectDate,
  onViewRequest,
  onViewAppointment,
}) {
  const patientById = useMemo(
    () => new Map(patients.map((patient) => [String(patient.id), patient])),
    [patients]
  );

  return (
    <section className="doctor-request-workspace" aria-label="Patient appointment requests">
      <div className="doctor-request-main">
        <div className="doctor-request-tools">
          <label className="doctor-request-search">
            <Icon icon="solar:magnifer-linear" aria-hidden="true" />
            <input
              type="search"
              value={searchTerm}
              placeholder="Search patient name or request ID..."
              onChange={(event) => onSearchChange(event.target.value)}
            />
          </label>

          <label className="doctor-request-sort">
            <select value={sortOrder} onChange={(event) => onSortChange(event.target.value)}>
              <option value="newest">Newest First</option>
              <option value="oldest">Oldest First</option>
              <option value="appointment">Appointment Date</option>
            </select>
            <Icon icon="solar:alt-arrow-down-linear" aria-hidden="true" />
          </label>
        </div>

        <div className="doctor-request-table-wrap">
          <div className="doctor-request-table">
            <div className="doctor-request-table-head">
              <span>Request ID</span>
              <span>Patient</span>
              <span>Appointment Type</span>
              <span>Preferred Date &amp; Time</span>
              <span>Date Requested</span>
              <span>Action</span>
            </div>

            <div className="doctor-request-table-body">
              {requests.length ? (
                requests.map((request, index) => {
                  const patient = patientById.get(String(request.patient_id)) || null;
                  return (
                    <article className="doctor-request-row" key={request.id}>
                      <strong className="doctor-request-id">{getRequestId(request, index)}</strong>

                      <div className="doctor-request-patient">
                        <span>{String(request.patient_name || "P").charAt(0).toUpperCase()}</span>
                        <div>
                          <strong>{request.patient_name || patient?.full_name || "Patient"}</strong>
                          <small>{patient?.patient_id || "Patient ID pending"}</small>
                          <small>{patient?.address || "Patient request"}</small>
                        </div>
                      </div>

                      <div className="doctor-request-type">
                        <Icon icon={getRequestCategoryIcon(request)} aria-hidden="true" />
                        <span>{request.title || "Appointment"}</span>
                      </div>

                      <div className="doctor-request-preferred">
                        <span>
                          <Icon icon="solar:calendar-linear" aria-hidden="true" />{" "}
                          {formatRequestDate(request.start_time)}
                        </span>
                        <span>
                          <Icon icon="solar:clock-circle-linear" aria-hidden="true" />{" "}
                          {formatAppointmentTime(request.start_time)}
                        </span>
                      </div>

                      <div className="doctor-request-created">
                        <span>{formatRequestDate(request.created_at)}</span>
                        <small>
                          {request.created_at
                            ? formatAppointmentTime(request.created_at)
                            : "Not recorded"}
                        </small>
                      </div>

                      <button
                        type="button"
                        className="doctor-request-view"
                        onClick={() => onViewRequest(request)}
                      >
                        View
                      </button>
                    </article>
                  );
                })
              ) : (
                <div className="doctor-request-empty">
                  <Icon icon="solar:inbox-linear" aria-hidden="true" />
                  <strong>No appointment requests found</strong>
                  <span>New requests from patients will appear here.</span>
                </div>
              )}
            </div>

            <footer className="doctor-request-pagination">
              <span>
                {totalRequests
                  ? `Showing ${(currentPage - 1) * 5 + 1}-${Math.min(
                      currentPage * 5,
                      totalRequests
                    )} of ${totalRequests} requests`
                  : "Showing 0 requests"}
              </span>
              <div>
                <button
                  type="button"
                  disabled={currentPage <= 1}
                  onClick={() => onPageChange(currentPage - 1)}
                  aria-label="Previous request page"
                >
                  <Icon icon="solar:alt-arrow-left-linear" aria-hidden="true" />
                </button>
                <strong>{currentPage}</strong>
                <button
                  type="button"
                  disabled={currentPage >= totalPages}
                  onClick={() => onPageChange(currentPage + 1)}
                  aria-label="Next request page"
                >
                  <Icon icon="solar:alt-arrow-right-linear" aria-hidden="true" />
                </button>
              </div>
            </footer>
          </div>
        </div>
      </div>

      <aside className="doctor-request-sidebar">
        <section className="doctor-request-calendar">
          <header>
            <h2>Calendar</h2>
            <span>Today</span>
          </header>

          <div className="doctor-request-calendar-month">
            <button type="button" aria-label="Previous month" onClick={() => onMonthChange(-1)}>
              <Icon icon="solar:alt-arrow-left-linear" aria-hidden="true" />
            </button>
            <strong>{formatMonthTitle(miniMonthDate)}</strong>
            <button type="button" aria-label="Next month" onClick={() => onMonthChange(1)}>
              <Icon icon="solar:alt-arrow-right-linear" aria-hidden="true" />
            </button>
          </div>

          <div className="doctor-request-calendar-weekdays">
            {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>

          <div className="doctor-request-calendar-days">
            {miniMonthDays.map((day, index) => (
              <button
                key={`${day.value}-${index}`}
                type="button"
                className={`${day.disabled ? "is-muted" : ""} ${
                  day.hasEvent ? "has-event" : ""
                } ${day.active ? "is-active" : ""}`}
                onClick={() => onSelectDate(day.date)}
              >
                {day.value}
              </button>
            ))}
          </div>
        </section>

        <section className="doctor-request-today">
          <header>
            <h2>Today's Schedule</h2>
            <span>
              {new Date().toLocaleDateString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          </header>

          <div>
            {todayAppointments.length ? (
              todayAppointments.slice(0, 5).map((appointment) => (
                <button
                  type="button"
                  key={appointment.id}
                  onClick={() => onViewAppointment(appointment.id)}
                >
                  <time>{formatAppointmentTime(appointment.startTime)}</time>
                  <span className={`is-${appointment.category || "fallback"}`}>
                    <strong>{appointment.name || "Patient"}</strong>
                    <small>{appointment.title || "Appointment"}</small>
                  </span>
                </button>
              ))
            ) : (
              <p>No appointments scheduled for today.</p>
            )}
          </div>
        </section>
      </aside>
    </section>
  );
}

function StaffAppointmentRequestDetails({
  request,
  patient,
  doctors,
  selectedDoctorId,
  onDoctorChange,
  isUpdating,
  actionError,
  onBack,
  onApprove,
  onDecline,
}) {
  const requestNotes = String(request?.description || "No additional notes were provided.").trim();
  const requestedAt = request?.created_at
    ? `${formatRequestDate(request.created_at)} at ${formatAppointmentTime(request.created_at)}`
    : "Not recorded";

  return (
    <section className="doctor-request-details-page">
      <nav className="doctor-request-breadcrumbs" aria-label="Breadcrumb">
        <button type="button" onClick={onBack}>Appointments</button>
        <Icon icon="solar:alt-arrow-right-linear" aria-hidden="true" />
        <button type="button" onClick={onBack}>Patient Requests</button>
        <Icon icon="solar:alt-arrow-right-linear" aria-hidden="true" />
        <strong>Appointment Details</strong>
      </nav>

      <header className="doctor-request-details-heading">
        <div>
          <h1>Appointment Details</h1>
          <p>Review the patient's appointment request and assign the final Doctor.</p>
        </div>
        <span className="doctor-request-pending-badge">
          <Icon icon="solar:clock-circle-linear" aria-hidden="true" /> Pending
        </span>
      </header>

      <section className="doctor-request-patient-card">
        <div className="doctor-request-detail-avatar">
          {String(request?.patient_name || "P")
            .split(/\s+/)
            .map((part) => part[0])
            .join("")
            .slice(0, 2)
            .toUpperCase()}
        </div>

        <div className="doctor-request-patient-identity">
          <h2>{request?.patient_name || patient?.full_name || "Patient"}</h2>
          <p>Patient ID: {patient?.patient_id || "Not assigned"}</p>
          <span>{patient?.address || "Patient appointment request"}</span>
        </div>

        <div className="doctor-request-patient-contact">
          <span>
            <Icon icon="solar:user-rounded-linear" aria-hidden="true" /> Age:{" "}
            {patient?.age || "Not provided"}
          </span>
          <span>
            <Icon icon="solar:phone-linear" aria-hidden="true" />{" "}
            {patient?.contact_number || "Not provided"}
          </span>
          <span>
            <Icon icon="solar:letter-linear" aria-hidden="true" />{" "}
            {patient?.email || "Not provided"}
          </span>
        </div>
      </section>

      <section className="doctor-request-information-card">
        <header>
          <Icon icon="solar:calendar-linear" aria-hidden="true" />
          <h2>Appointment Information</h2>
        </header>

        <dl>
          <div>
            <dt>Appointment Type</dt>
            <dd>
              <Icon icon={getRequestCategoryIcon(request)} aria-hidden="true" />{" "}
              {request?.title || "Appointment"}
            </dd>
          </div>

          <div>
            <dt>Preferred Date</dt>
            <dd>
              <Icon icon="solar:calendar-linear" aria-hidden="true" />{" "}
              {formatRequestDate(request?.start_time)}
            </dd>
          </div>

          <div>
            <dt>Preferred Time</dt>
            <dd>
              <Icon icon="solar:clock-circle-linear" aria-hidden="true" />{" "}
              {formatAppointmentTime(request?.start_time)}
            </dd>
          </div>

          <div>
            <dt>Date Requested</dt>
            <dd>
              <Icon icon="solar:calendar-linear" aria-hidden="true" /> {requestedAt}
            </dd>
          </div>

          <div className="is-notes">
            <dt>Assign Doctor</dt>
            <dd>
              <select
                className="staff-request-doctor-select"
                value={selectedDoctorId}
                onChange={(event) => onDoctorChange(event.target.value)}
                disabled={isUpdating}
                aria-label="Assign Doctor"
              >
                <option value="">Select Doctor</option>
                {doctors.map((doctor) => (
                  <option key={doctor.id} value={doctor.id}>
                    {doctor.name}
                  </option>
                ))}
              </select>
            </dd>
          </div>

          <div className="is-notes">
            <dt>Reason / Notes</dt>
            <dd>
              <Icon icon="solar:document-text-linear" aria-hidden="true" />
              <span>{requestNotes}</span>
            </dd>
          </div>
        </dl>
      </section>

      <section className="doctor-request-status-card">
        <header>
          <Icon icon="solar:danger-triangle-linear" aria-hidden="true" />
          <h2>Request Status</h2>
        </header>

        <div className="doctor-request-current-status">
          <strong>Current Status</strong>
          <span className="doctor-request-pending-badge">
            <Icon icon="solar:clock-circle-linear" aria-hidden="true" /> Pending
          </span>
          <small>
            <Icon icon="solar:info-circle-linear" aria-hidden="true" /> Waiting for Staff review.
          </small>
        </div>

        {actionError ? (
          <p className="doctor-request-detail-error" role="alert">
            {actionError}
          </p>
        ) : null}

        <footer>
          <div>
            <button type="button" className="doctor-request-back-button" onClick={onBack}>
              <Icon icon="solar:alt-arrow-left-linear" aria-hidden="true" /> Back
            </button>

            <SendPatientNotificationAction
              patientId={request?.patient_id || ""}
              patientName={request?.patient_name || "Patient"}
              defaultType="general"
              defaultTitle="Appointment request update"
              defaultMessage="We are reviewing your appointment request."
              lockedTargetPath="/patient/appointments"
              contextLabel={`Appointment request ${getRequestId(request)}`}
              triggerLabel="Message Patient"
              className="doctor-request-message-button"
              outline
            />
          </div>

          <div>
            <button
              type="button"
              className="doctor-request-decline-button"
              onClick={() => onDecline(request)}
              disabled={isUpdating}
            >
              {isUpdating ? "Updating..." : "Decline"}
            </button>

            <button
              type="button"
              className="doctor-request-approve-button"
              onClick={() => onApprove(request)}
              disabled={isUpdating || !selectedDoctorId}
            >
              <Icon icon="solar:check-read-linear" aria-hidden="true" />
              {isUpdating ? "Approving..." : "Approve & Schedule"}
            </button>
          </div>
        </footer>
      </section>
    </section>
  );
}

function StaffAppointmentsContent({ headerAction }) {
  const location = useLocation();
  const navigate = useNavigate();
  const visitRoute = parseAppointmentVisitRoute(location.pathname, "staff");
  const isVisitFormRoute = Boolean(visitRoute);
  const dashboardAppointmentTarget = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return String(params.get("appointmentId") || "").trim();
  }, [location.search]);
  const dashboardTodayTarget = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return String(params.get("scope") || "").trim().toLowerCase() === "today";
  }, [location.search]);
  const dashboardStatusTarget = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return getAppointmentStatusTab(params.get("status"));
  }, [location.search]);
  const [activeFilter, setActiveFilter] = useState(() =>
    dashboardStatusTarget || "All"
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedMonth, setSelectedMonth] = useState("");
  const [pageSize, setPageSize] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [appointments, setAppointments] = useState([]);
  const [scheduleEvents, setScheduleEvents] = useState([]);
  const [bookingRequests, setBookingRequests] = useState([]);
  const [requestSort, setRequestSort] = useState("newest");
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [requestDoctorId, setRequestDoctorId] = useState("");
  const [requestActionError, setRequestActionError] = useState("");
  const [isReviewingRequest, setIsReviewingRequest] = useState(false);
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
  const [successMessage, setSuccessMessage] = useState("");
  const [statusMessageVersion, setStatusMessageVersion] = useState(0);
  const [noShowConfirmationAppointment, setNoShowConfirmationAppointment] = useState(null);
  const [isMarkingNoShow, setIsMarkingNoShow] = useState(false);
  const [cancelConfirmationAppointment, setCancelConfirmationAppointment] = useState(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelReasonError, setCancelReasonError] = useState("");
  const [isCancellingAppointment, setIsCancellingAppointment] = useState(false);
  const [rescheduleAppointment, setRescheduleAppointment] = useState(null);
  const [rescheduleForm, setRescheduleForm] = useState(initialStaffRescheduleForm);
  const [rescheduleError, setRescheduleError] = useState("");
  const [isReschedulingAppointment, setIsReschedulingAppointment] = useState(false);
  const [visitRoutingAppointmentId, setVisitRoutingAppointmentId] = useState("");
  const statusButtonRefs = useRef({});
  const statusMenuRef = useRef(null);
  const appointmentSaveLockRef = useRef(false);
  const appointmentStatusLockRef = useRef(new Set());
  const rescheduleSaveLockRef = useRef(false);
  const visitRoutingLockRef = useRef("");
  const bookingRequestsRequestRef = useRef(null);
  const successTimerRef = useRef(null);
  const dashboardStatusTargetAppliedRef = useRef(Boolean(dashboardStatusTarget));

  const clearSuccessTimer = useCallback(() => {
    if (successTimerRef.current !== null) {
      window.clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
    }
  }, []);

  const showSuccessMessage = useCallback(
    (message) => {
      clearSuccessTimer();
      setSuccessMessage(message);
      setStatusMessage(message);
      setStatusMessageVersion((current) => current + 1);
      successTimerRef.current = window.setTimeout(() => {
        successTimerRef.current = null;
        setStatusMessage((current) => (current === message ? "" : current));
        setSuccessMessage((current) => (current === message ? "" : current));
      }, 4000);
    },
    [clearSuccessTimer]
  );

  useEffect(
    () => () => {
      clearSuccessTimer();
    },
    [clearSuccessTimer]
  );

  useEffect(() => {
    if (
      typeof document === "undefined" ||
      (!detailAppointment &&
        !cancelConfirmationAppointment &&
        !rescheduleAppointment)
    ) {
      return undefined;
    }

    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;

    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, [
    detailAppointment,
    cancelConfirmationAppointment,
    rescheduleAppointment,
  ]);

  useEffect(() => {
    if (isVisitFormRoute || dashboardAppointmentTarget) {
      return undefined;
    }

    const frameId = window.requestAnimationFrame(() => {
      if (dashboardTodayTarget) {
        setActiveFilter("All");
        setSearchQuery("");
        setSelectedMonth("");
        setCurrentPage(1);
        dashboardStatusTargetAppliedRef.current = false;
        return;
      }

      if (dashboardStatusTarget) {
        setActiveFilter(dashboardStatusTarget);
        dashboardStatusTargetAppliedRef.current = true;
        return;
      }

      if (dashboardStatusTargetAppliedRef.current) {
        setActiveFilter("All");
        dashboardStatusTargetAppliedRef.current = false;
      }
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [
    dashboardAppointmentTarget,
    dashboardStatusTarget,
    dashboardTodayTarget,
    isVisitFormRoute,
  ]);

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

  const loadBookingRequests = useCallback(() => {
    if (bookingRequestsRequestRef.current) {
      return bookingRequestsRequestRef.current;
    }

    const request = (async () => {
      const { data, error } = await supabase
        .from(appointmentRequestTableName)
        .select(appointmentRequestColumns)
        .eq("status", "pending")
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Staff booking request fetch failed:", error);
        setStatusMessage(
          `Unable to load Patient booking requests: ${error.message || "Unknown error"}`
        );
        return { ok: false, count: 0, error };
      }

      const nextRequests = data || [];
      setBookingRequests(nextRequests);
      setSelectedRequest((current) =>
        current?.id
          ? nextRequests.find((item) => String(item.id) === String(current.id)) || null
          : current
      );

      return { ok: true, count: nextRequests.length };
    })();

    bookingRequestsRequestRef.current = request;
    const clearPendingRequest = () => {
      if (bookingRequestsRequestRef.current === request) {
        bookingRequestsRequestRef.current = null;
      }
    };
    request.then(clearPendingRequest, clearPendingRequest);
    return request;
  }, []);

  useEffect(() => {
    const loadTimer = window.setTimeout(loadBookingRequests, 0);

    const channel = supabase
      .channel("staff-appointment-requests")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: appointmentRequestTableName,
        },
        loadBookingRequests
      )
      .subscribe();

    const refreshInterval = window.setInterval(loadBookingRequests, 15000);
    const refreshOnFocus = () => loadBookingRequests();
    window.addEventListener("focus", refreshOnFocus);

    return () => {
      window.clearTimeout(loadTimer);
      window.clearInterval(refreshInterval);
      window.removeEventListener("focus", refreshOnFocus);
      supabase.removeChannel(channel);
    };
  }, [loadBookingRequests]);


  /*
   * Dashboard "View Appointment" deep link.
   *
   * The dashboard passes either the public MA number or the schedule UUID.
   * Once appointments are loaded, locate that exact row, filter the table to
   * it, and open the existing details modal.
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

      setActiveFilter("All");
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
    const renderedMenuRect = statusMenuRef.current?.getBoundingClientRect();
    setStatusMenuPosition(
      getAppointmentStatusPopoverPosition({
        triggerRect: rect,
        menuRect: renderedMenuRect,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      })
    );
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
        event.target.closest?.(".appointment-status-popover")
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
      if (!appointmentStatusMatches(appointment, activeFilter)) return false;

      if (dashboardTodayTarget) {
        const classification = classifyAppointment(appointment);
        if (!classification.isToday || !classification.isActionable) return false;
      }

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
    }).sort(compareAppointmentsByStatusPriority);
  }, [
    activeFilter,
    appointments,
    dashboardTodayTarget,
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
  }, [activeFilter, pageSize, searchQuery, selectedMonth]);

  const requestSchedules = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase();

    const matching = bookingRequests
      .filter(
        (request) =>
          String(request.status || "").trim().toLowerCase() === "pending"
      )
      .filter((request, index) => {
        if (!keyword) return true;

        return [
          getRequestId(request, index),
          request.patient_name,
          request.title,
          request.patient_id,
          request.doctor_name,
        ].some((value) => String(value || "").toLowerCase().includes(keyword));
      });

    return matching.sort((first, second) => {
      if (requestSort === "appointment") {
        return (
          new Date(first.start_time || 0).getTime() -
          new Date(second.start_time || 0).getTime()
        );
      }

      const firstTime = new Date(first.created_at || first.start_time || 0).getTime();
      const secondTime = new Date(second.created_at || second.start_time || 0).getTime();
      return requestSort === "oldest"
        ? firstTime - secondTime
        : secondTime - firstTime;
    });
  }, [bookingRequests, requestSort, searchQuery]);

  const requestTotalPages = Math.max(1, Math.ceil(requestSchedules.length / 5));
  const requestDisplayedPage = Math.min(currentPage, requestTotalPages);
  const paginatedRequests = useMemo(() => {
    const startIndex = (requestDisplayedPage - 1) * 5;
    return requestSchedules.slice(startIndex, startIndex + 5);
  }, [requestDisplayedPage, requestSchedules]);

  const todayRequestAppointments = useMemo(
    () =>
      appointments
        .filter(
          (appointment) =>
            isAppointmentToday(appointment.startTime) &&
            !isClosedStatus(appointment.status)
        )
        .sort(
          (first, second) =>
            new Date(first.startTime || 0).getTime() -
            new Date(second.startTime || 0).getTime()
        ),
    [appointments]
  );

  const searchSuggestions = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase();

    if (!keyword) return [];

    const seen = new Set();

    return appointments
      .filter((appointment) => {
        if (!appointmentStatusMatches(appointment, activeFilter)) return false;
        if (dashboardTodayTarget) {
          const classification = classifyAppointment(appointment);
          if (!classification.isToday || !classification.isActionable) return false;
        }
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
    appointments,
    dashboardTodayTarget,
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

        if (isCancelledStatus(appointment.status)) {
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

  const activeStatusActions = useMemo(() => {
    if (!activeStatusAppointment) return [];

    if (activeStatusAppointment.status === "Pending") {
      return pendingStatusActions.filter(
        (action) =>
          action.value !== "No show" ||
          isAppointmentNoShowEligible(activeStatusAppointment)
      );
    }

    if (isCheckedInStatus(activeStatusAppointment.status)) {
      return checkedInActions;
    }

    return [];
  }, [activeStatusAppointment]);

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

  const openPatientRequest = useCallback(
    (request) => {
      if (!request?.id) return;

      const requestedDoctorAvailable =
        request.doctor_id &&
        doctors.some((doctor) => String(doctor.id) === String(request.doctor_id));

      setRequestActionError("");
      setSelectedRequest(request);
      setRequestDoctorId(
        requestedDoctorAvailable
          ? String(request.doctor_id)
          : String(doctors[0]?.id || "")
      );
    },
    [doctors]
  );

  useEffect(() => {
    if (!selectedRequest || requestDoctorId || !doctors.length) return;

    const requestedDoctorAvailable =
      selectedRequest.doctor_id &&
      doctors.some(
        (doctor) => String(doctor.id) === String(selectedRequest.doctor_id)
      );

    setRequestDoctorId(
      requestedDoctorAvailable
        ? String(selectedRequest.doctor_id)
        : String(doctors[0]?.id || "")
    );
  }, [doctors, requestDoctorId, selectedRequest]);

  const acceptPatientRequest = useCallback(
    async (request) => {
      if (!request?.id || isReviewingRequest) return;

      if (!requestDoctorId) {
        setRequestActionError("Select an active Doctor before approving this request.");
        return;
      }

      setIsReviewingRequest(true);
      setRequestActionError("");

      try {
        const { data, error } = await supabase.rpc(
          "accept_patient_appointment_request",
          {
            p_request_id: request.id,
            p_doctor_id: requestDoctorId,
          }
        );

        if (error) {
          console.error("Staff appointment request acceptance failed:", error);
          setRequestActionError(
            `Unable to approve this request: ${error.message || "Unknown error"}`
          );
          return;
        }

        if (data?.schedule_id) {
          try {
            await requestAppointmentSms({
              scheduleId: data.schedule_id,
              event: appointmentSmsEvents.confirmed,
            });
          } catch (smsError) {
            console.warn(
              "Appointment confirmation SMS orchestration did not complete:",
              smsError
            );
          }
        }

        setBookingRequests((current) =>
          current.filter((item) => String(item.id) !== String(request.id))
        );
        setSelectedRequest(null);
        setRequestDoctorId("");
        setRequestActionError("");
        showSuccessMessage(
          data?.schedule_id
            ? "Appointment request approved and moved to Pending appointments."
            : "Appointment request approved."
        );

        await Promise.all([loadAppointments(), loadBookingRequests()]);
      } finally {
        setIsReviewingRequest(false);
      }
    },
    [
      isReviewingRequest,
      loadAppointments,
      loadBookingRequests,
      requestDoctorId,
      showSuccessMessage,
    ]
  );

  const declinePatientRequest = useCallback(
    async (request) => {
      if (!request?.id || isReviewingRequest) return;

      setIsReviewingRequest(true);
      setRequestActionError("");

      try {
        const { error } = await supabase.rpc(
          "decline_patient_appointment_request",
          {
            p_request_id: request.id,
          }
        );

        if (error) {
          console.error("Staff appointment request decline failed:", error);
          setRequestActionError(
            `Unable to decline this request: ${error.message || "Unknown error"}`
          );
          return;
        }

        setBookingRequests((current) =>
          current.filter((item) => String(item.id) !== String(request.id))
        );
        setSelectedRequest(null);
        setRequestDoctorId("");
        setRequestActionError("");
        showSuccessMessage("Appointment request declined. No appointment was created.");
        await loadBookingRequests();
      } finally {
        setIsReviewingRequest(false);
      }
    },
    [isReviewingRequest, loadBookingRequests, showSuccessMessage]
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
                  databaseStatus: getDatabaseStatus(nextStatus),
                  status: nextStatus,
                  filterStatus: formatStatusValue(nextStatus),
                }
              : item
          )
        );

        await loadAppointments();
        return { savedSchedule: data, notificationResult };
      } catch (error) {
        console.error("Staff appointment status update failed unexpectedly:", error);
        setStatusMessage(
          `Unable to update status: ${error?.message || "Please try again."}`
        );
        return false;
      } finally {
        appointmentStatusLockRef.current.delete(mutationKey);
      }
    },
    [loadAppointments]
  );

  const cancelAppointment = useCallback((appointment) => {
    if (!appointment?.id) return;

    if (appointment.status !== "Pending") {
      setOpenStatusMenu(null);
      setStatusMessage("Only pending appointments can be cancelled.");
      return;
    }

    setOpenStatusMenu(null);
    setDetailAppointment(null);
    setStatusMessage("");
    setCancelReason("");
    setCancelReasonError("");
    setCancelConfirmationAppointment(appointment);
  }, []);

  const closeCancelAppointment = useCallback(() => {
    if (isCancellingAppointment) return;

    setCancelConfirmationAppointment(null);
    setCancelReason("");
    setCancelReasonError("");
  }, [isCancellingAppointment]);

  const confirmCancelAppointment = useCallback(async () => {
    const appointment = cancelConfirmationAppointment;
    if (!appointment || isCancellingAppointment) return;

    if (appointment.status !== "Pending") {
      setCancelConfirmationAppointment(null);
      setCancelReason("");
      setCancelReasonError("");
      setStatusMessage("Only pending appointments can be cancelled.");
      return;
    }

    const trimmedReason = cancelReason.trim();

    if (!trimmedReason) {
      setCancelReasonError("Please provide a cancellation reason.");
      return;
    }

    setCancelReasonError("");
    setIsCancellingAppointment(true);

    try {
      const description = buildStaffScheduleDescription(
        appointment.description,
        {
          cancellationReason: trimmedReason,
          remindersDisabled: true,
        }
      );

      const saved = await updateAppointmentStatus(
        appointment,
        "Cancelled",
        { description },
        { notificationType: "appointment_cancelled" }
      );

      if (!saved) {
        setCancelReasonError(
          "Unable to cancel the appointment. Please try again."
        );
        return;
      }

      await disableAppointmentReminders(appointment.id);

      setCancelConfirmationAppointment(null);
      setCancelReason("");
      setCancelReasonError("");
      setDetailAppointment(null);
      setCurrentPage(1);
      const cancellationMessage = getAutomaticNotificationStatusMessage(
        saved.notificationResult,
        {
          sentMessage: "Appointment cancelled and Patient notified.",
          skippedMessage:
            "Appointment cancelled successfully. The Patient has not activated their app account yet, so no in-app notification was sent.",
          failedMessage:
            "Appointment cancelled successfully, but the Patient notification could not be sent.",
        }
      );
      if (saved.notificationResult?.ok || saved.notificationResult?.skipped) {
        showSuccessMessage(cancellationMessage);
      } else {
        setStatusMessage(cancellationMessage);
      }
    } finally {
      setIsCancellingAppointment(false);
    }
  }, [
    cancelConfirmationAppointment,
    cancelReason,
    disableAppointmentReminders,
    isCancellingAppointment,
    showSuccessMessage,
    updateAppointmentStatus,
  ]);

  const startRescheduleAppointment = useCallback(() => {
    const appointment = cancelConfirmationAppointment;
    if (!appointment || isCancellingAppointment) return;

    setRescheduleAppointment(appointment);
    setRescheduleForm({
      date: formatInputDate(appointment.startTime),
      time: formatInputTime(appointment.startTime),
      message: getScheduleHumanMessage(appointment.description),
    });
    setRescheduleError("");
    setCancelConfirmationAppointment(null);
    setCancelReason("");
    setCancelReasonError("");
  }, [cancelConfirmationAppointment, isCancellingAppointment]);

  const closeRescheduleAppointment = useCallback(() => {
    if (isReschedulingAppointment) return;

    setRescheduleAppointment(null);
    setRescheduleForm(initialStaffRescheduleForm);
    setRescheduleError("");
  }, [isReschedulingAppointment]);

  const updateRescheduleForm = useCallback((field, value) => {
    setRescheduleForm((current) => ({
      ...current,
      [field]: value,
    }));
    setRescheduleError("");
  }, []);

  const saveRescheduleAppointment = useCallback(
    async (event) => {
      event.preventDefault();

      const appointment = rescheduleAppointment;
      if (
        !appointment ||
        isReschedulingAppointment ||
        rescheduleSaveLockRef.current
      ) {
        return;
      }

      if (appointment.status !== "Pending") {
        setRescheduleAppointment(null);
        setRescheduleForm(initialStaffRescheduleForm);
        setRescheduleError("");
        setStatusMessage("Only pending appointments can be rescheduled.");
        return;
      }

      const appointmentRange = buildThirtyMinuteAppointmentRange(
        rescheduleForm.date,
        rescheduleForm.time
      );

      if (!appointmentRange) {
        setRescheduleError("Choose a valid reschedule date and time.");
        return;
      }

      const { startDate, endDate } = appointmentRange;

      if (startDate < new Date()) {
        setRescheduleError(
          "Rescheduled appointments cannot start in the past."
        );
        return;
      }

      const startTime = startDate.toISOString();
      const endTime = endDate.toISOString();

      if (
        hasAppointmentConflict(appointments, {
          id: appointment.id,
          start: startTime,
          end: endTime,
        })
      ) {
        setRescheduleError(
          "This appointment conflicts with another active appointment."
        );
        return;
      }

      const description = buildStaffScheduleDescription(
        appointment.description,
        {
          message: rescheduleForm.message,
          cancellationReason: "",
          remindersDisabled: false,
        }
      );

      rescheduleSaveLockRef.current = true;
      setIsReschedulingAppointment(true);
      setRescheduleError("");

      try {
        const { data: rescheduleResult, error } = await supabase.rpc(
          "reschedule_appointment",
          {
            p_schedule_id: appointment.id,
            p_new_start_time: startTime,
            p_new_end_time: endTime,
            p_description: description,
          }
        );

        if (error) {
          console.error("Staff appointment reschedule failed:", error);
          setRescheduleError(
            `Unable to reschedule appointment: ${error.message}`
          );
          return;
        }

        const savedSchedule = rescheduleResult?.schedule;
        if (!savedSchedule?.id) {
          setRescheduleError("The saved appointment was not returned.");
          return;
        }

        const notificationResult =
          await sendAutomaticAppointmentNotification({
            patientId: savedSchedule.patient_id,
            scheduleId: savedSchedule.id,
            notificationType: "appointment_rescheduled",
            appointmentEventId: rescheduleResult.appointment_event_id,
          });

        const notificationMessage = rescheduleResult.rescheduled
          ? getAutomaticNotificationStatusMessage(notificationResult, {
              sentMessage: "Appointment rescheduled and Patient notified.",
              skippedMessage:
                "Appointment rescheduled successfully. The Patient has not activated their app account yet, so no in-app notification was sent.",
              failedMessage:
                "Appointment rescheduled successfully, but the Patient notification could not be sent.",
            })
          : "Appointment details saved. The appointment time did not change.";

        const nextDate = new Date(startTime);
        setCalendarDate(nextDate);
        setMiniMonthDate(
          new Date(nextDate.getFullYear(), nextDate.getMonth(), 1)
        );
        await loadAppointments();

        setRescheduleAppointment(null);
        setRescheduleForm(initialStaffRescheduleForm);
        setRescheduleError("");
        if (
          (!rescheduleResult.rescheduled ||
            notificationResult?.ok ||
            notificationResult?.skipped)
        ) {
          showSuccessMessage(notificationMessage);
        } else {
          setStatusMessage(notificationMessage);
        }
      } finally {
        rescheduleSaveLockRef.current = false;
        setIsReschedulingAppointment(false);
      }
    },
    [
      appointments,
      isReschedulingAppointment,
      loadAppointments,
      rescheduleAppointment,
      rescheduleForm.date,
      rescheduleForm.message,
      rescheduleForm.time,
      showSuccessMessage,
    ]
  );

  const openVisitForm = useCallback(
    async (appointment) => {
      if (!appointment?.id || visitRoutingLockRef.current) return;

      visitRoutingLockRef.current = appointment.id;
      setVisitRoutingAppointmentId(appointment.id);
      setOpenStatusMenu(null);
      setDetailAppointment(null);
      setStatusMessage("");

      try {
        const { data, error } = await supabase.rpc(
          "get_appointment_visit_form_type",
          { p_appointment_id: appointment.id }
        );

        if (error) {
          logAppointmentReminderError("visit-routing RPC failed", error);
          setStatusMessage(
            `The visit form could not be opened. ${getAppointmentReminderErrorMessage(error)}`
          );
          return;
        }

        const routeResult = Array.isArray(data) ? data[0] : data;
        if (!routeResult?.visit_form_type) {
          setStatusMessage(
            "The visit-routing RPC returned no form type. Retry Open Visit Form."
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
    [navigate]
  );

  const checkInAndOpenVisitForm = useCallback(
    async (appointment) => {
      if (!appointment?.id) return;

      if (isCheckedInStatus(appointment.status)) {
        await openVisitForm(appointment);
        return;
      }

      const saved = await updateAppointmentStatus(appointment, "Checked in");
      if (saved) {
        await openVisitForm({ ...appointment, status: "Checked in" });
      }
    },
    [openVisitForm, updateAppointmentStatus]
  );

  const confirmNoShow = async () => {
    const appointment = noShowConfirmationAppointment;
    if (!appointment || isMarkingNoShow) return;

    if (appointment.status !== "Pending") {
      setNoShowConfirmationAppointment(null);
      setStatusMessage("Only pending appointments can be marked as No Show.");
      return;
    }

    if (!isAppointmentNoShowEligible(appointment)) {
      setNoShowConfirmationAppointment(null);
      setStatusMessage(
        "This appointment cannot be marked as No Show before its scheduled time."
      );
      return;
    }

    setIsMarkingNoShow(true);

    try {
      const saved = await updateAppointmentStatus(appointment, "No show");

      if (saved) {
        setNoShowConfirmationAppointment(null);
        setCurrentPage(1);
        setStatusMessage("Appointment marked as No Show.");
      }
    } finally {
      setIsMarkingNoShow(false);
    }
  };

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
      setStatusMessage("Completed, cancelled, or No Show appointments cannot be changed.");
      return;
    }

    if (currentAppointment.status !== "Pending") {
      setOpenStatusMenu(null);
      setStatusMessage(
        "Checked-in appointments can only open their visit form from this menu."
      );
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

    if (newStatus === "No show") {
      setOpenStatusMenu(null);

      if (currentAppointment.status !== "Pending") {
        setStatusMessage("Only pending appointments can be marked as No Show.");
        return;
      }

      if (!isAppointmentNoShowEligible(currentAppointment)) {
        setStatusMessage(
          "This appointment cannot be marked as No Show before its scheduled time."
        );
        return;
      }

      setStatusMessage("");
      setNoShowConfirmationAppointment(currentAppointment);
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
    const wasEditing = Boolean(editingAppointmentId);
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

    const saveQuery = wasEditing
      ? supabase
          .rpc("reschedule_appointment", {
            p_schedule_id: editingAppointmentId,
            p_new_start_time: payload.start_time,
            p_new_end_time: payload.end_time,
            p_description: payload.description,
            p_apply_full_update: true,
            p_patient_id: payload.patient_id,
            p_patient_name: payload.patient_name,
            p_doctor_id: payload.doctor_id,
            p_doctor_name: payload.doctor_name,
            p_title: payload.title,
          })
      : supabase
          .from(scheduleTableName)
          .insert([payload])
          .select(scheduleColumns)
          .single();

    const { data: savedResult, error } = await saveQuery;
    const savedSchedule = wasEditing ? savedResult?.schedule : savedResult;
    const appointmentEventId = wasEditing
      ? savedResult?.appointment_event_id || null
      : null;

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
          appointmentEventId,
        })
      : {
          ok: false,
          error: { message: "The saved appointment was not returned." },
        };
    setIsAddAppointmentOpen(false);
    setEditingAppointmentId("");
    setAddAppointmentForm(createBlankAppointmentForm(doctors[0] || null));
    await loadAppointments();

    const notificationMessage = wasEditing && !savedResult?.rescheduled
      ? "Appointment details saved. The appointment time did not change."
      : getAutomaticNotificationStatusMessage(notificationResult, {
          sentMessage: wasEditing
            ? "Appointment rescheduled and Patient notified."
            : "Appointment created and Patient notified.",
          skippedMessage: wasEditing
            ? "Appointment rescheduled successfully. The Patient has not activated their app account yet, so no in-app notification was sent."
            : "Appointment created successfully. The Patient has not activated their app account yet, so no in-app notification was sent.",
          failedMessage: wasEditing
            ? "Appointment rescheduled successfully, but the Patient notification could not be sent."
            : "Appointment was saved, but the Patient notification could not be sent.",
        });

    if (
      (!wasEditing ||
        !savedResult?.rescheduled ||
        notificationResult?.ok ||
        notificationResult?.skipped)
    ) {
      showSuccessMessage(notificationMessage);
    } else {
      setStatusMessage(notificationMessage);
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
              databaseStatus: getDatabaseStatus("Checked in"),
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

  if (selectedRequest) {
    const requestPatient =
      patients.find(
        (patient) => String(patient.id) === String(selectedRequest.patient_id)
      ) || null;

    return (
      <section className="staff-appointments-page doctor-request-details-shell appointment-workspace appointment-workspace--staff">
        <StaffAppointmentRequestDetails
          request={selectedRequest}
          patient={requestPatient}
          doctors={doctors}
          selectedDoctorId={requestDoctorId}
          onDoctorChange={(doctorId) => {
            setRequestDoctorId(doctorId);
            if (requestActionError) setRequestActionError("");
          }}
          isUpdating={isReviewingRequest}
          actionError={requestActionError}
          onBack={() => {
            setRequestActionError("");
            setSelectedRequest(null);
            setActiveFilter("Requests");
          }}
          onApprove={acceptPatientRequest}
          onDecline={declinePatientRequest}
        />
      </section>
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

  const clearDashboardTodayTarget = () => {
    if (!dashboardTodayTarget) return;

    const params = new URLSearchParams(location.search);
    params.delete("scope");
    const nextSearch = params.toString();

    navigate(
      {
        pathname: location.pathname,
        search: nextSearch ? `?${nextSearch}` : "",
      },
      { replace: true }
    );
  };

  return (
    <section className="staff-appointments-page appointment-workspace appointment-workspace--staff">
      <AppointmentPageHeader
        title="Appointments"
        subtitle="Manage scheduling, arrivals, and appointment status."
        tabs={filters}
        activeTab={activeFilter}
        onTabChange={(nextTab) => {
          clearDashboardTodayTarget();
          setActiveFilter(nextTab);
          setCurrentPage(1);
          setSearchQuery("");
          setSelectedMonth("");
        }}
        action={headerAction}
        className="staff-appointments-header staff-section-header"
        tabsClassName="staff-appointments-tabs"
        tabsLabel="Appointment filters"
      />

      {statusMessage ? (
        <div
          key={statusMessageVersion}
          className={`staff-appointments-status-message${
            successMessage === statusMessage ? " is-auto-hide" : ""
          }`}
          role="status"
        >
          <span>{statusMessage}</span>
        </div>
      ) : null}

      {activeFilter === "Requests" ? (
        <StaffAppointmentRequests
          requests={paginatedRequests}
          totalRequests={requestSchedules.length}
          currentPage={requestDisplayedPage}
          totalPages={requestTotalPages}
          searchTerm={searchQuery}
          sortOrder={requestSort}
          patients={patients}
          miniMonthDate={miniMonthDate}
          miniMonthDays={miniMonthDays}
          todayAppointments={todayRequestAppointments}
          onSearchChange={(value) => {
            setSearchQuery(value);
            setCurrentPage(1);
          }}
          onSortChange={(value) => {
            setRequestSort(value);
            setCurrentPage(1);
          }}
          onPageChange={setCurrentPage}
          onMonthChange={(amount) =>
            setMiniMonthDate((current) => addMonths(current, amount))
          }
          onSelectDate={selectCalendarDate}
          onViewRequest={openPatientRequest}
          onViewAppointment={openAppointmentDetails}
        />
      ) : (
        <>
      <AppointmentToolbar
        as="div"
        className="staff-appointments-toolbar staff-appointments-toolbar-labeled"
      >
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
        <div className="staff-appointments-table-xscroll">
          <div className="staff-appointments-table-inner">
            <div className="staff-appointments-table-head-shell">
              <table className="staff-appointments-table staff-appointments-table--header">
                <thead>
                  <tr>
                    <th>Appointment ID</th>
                    <th>Name</th>
                    <th>Date</th>
                    <th>Time</th>
                    <th>Status</th>
                  </tr>
                </thead>
              </table>
            </div>

            <div className="staff-appointments-table-scroll appointment-ui-table-scroll">
              <table className="staff-appointments-table staff-appointments-table--body">
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
                        disabled={isClosedStatus(appointment.status)}
                        onClick={(event) => {
                          event.stopPropagation();

                          if (isClosedStatus(appointment.status)) {
                            setStatusMessage(
                              "Completed, cancelled, or No Show appointments cannot be changed."
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
                        aria-haspopup="menu"
                        aria-expanded={openStatusMenu === appointment.id}
                      >
                        <span>{classifyAppointment(appointment).displayStatus}</span>
                        <Icon
                          icon={
                            isClosedStatus(appointment.status)
                              ? "solar:check-circle-bold"
                              : "solar:alt-arrow-down-linear"
                          }
                          aria-hidden="true"
                        />
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
          </div>
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

          <section className="staff-categories-card" aria-label="Appointment categories">
            <h3>Categories</h3>

            <div className="staff-category-grid">
              {categoryList.map((category) => (
                <div
                  className={`staff-category-item ${category.colorClass}`}
                  key={category.id}
                >
                  <span aria-hidden="true">
                    <Icon icon={category.icon} />
                  </span>
                  <strong>{category.label}</strong>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>

        </>
      )}

      {openStatusMenu && activeStatusAppointment && statusMenuPosition &&
      typeof document !== "undefined"
        ? createPortal(
            <AppointmentStatusPopover
              ariaLabel={`Actions for ${activeStatusAppointment.status} appointment`}
              actions={activeStatusActions}
              busy={
                visitRoutingAppointmentId === activeStatusAppointment.id ||
                isMarkingNoShow
              }
              currentLabel={activeStatusAppointment.status}
              currentTone={getStatusClass(activeStatusAppointment.status).replace("is-", "")}
              menuRef={statusMenuRef}
              position={statusMenuPosition}
              onAction={(action) => {
                if (action.value === "open_form") {
                  setOpenStatusMenu(null);
                  openVisitForm(activeStatusAppointment);
                  return;
                }

                handleStatusChange(activeStatusAppointment.id, action.value);
              }}
            />,
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

      <StaffCancelAppointmentDialog
        appointment={cancelConfirmationAppointment}
        reason={cancelReason}
        error={cancelReasonError}
        busy={isCancellingAppointment}
        onReasonChange={(value) => {
          setCancelReason(value);
          if (cancelReasonError) setCancelReasonError("");
        }}
        onClose={closeCancelAppointment}
        onConfirm={confirmCancelAppointment}
        onReschedule={startRescheduleAppointment}
      />

      <StaffRescheduleAppointmentDialog
        appointment={rescheduleAppointment}
        form={rescheduleForm}
        error={rescheduleError}
        busy={isReschedulingAppointment}
        onChange={updateRescheduleForm}
        onClose={closeRescheduleAppointment}
        onSave={saveRescheduleAppointment}
      />

      <AppointmentNoShowDialog
        open={Boolean(noShowConfirmationAppointment)}
        busy={isMarkingNoShow}
        onCancel={() => setNoShowConfirmationAppointment(null)}
        onConfirm={confirmNoShow}
      />
    </section>
  );
}

export default StaffAppointmentsContent;
