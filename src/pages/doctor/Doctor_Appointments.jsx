import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { Icon } from "@iconify/react";
import { supabase } from "../../lib/supabaseClient";
import { parseAppointmentVisitRoute } from "../../lib/appointmentVisitRoute";
import AppointmentVisitForm from "../appointments/AppointmentVisitForm";
import SendPatientNotificationAction from "../../components/notifications/SendPatientNotificationAction";
import { loadAuthenticatedDoctor } from "../../hooks/useAuthenticatedDoctor";
import "../../styles/appointment-ui-system.css";
import {
  appointmentStatuses,
  classifyAppointment,
  compareHistoryAppointments,
  compareUpcomingAppointments,
  formatAppointmentDate,
  formatAppointmentTime,
  getAppointmentStatusClass,
  getAppointmentStatusLabel,
  getManilaDateKey,
  getManilaTimeKey,
  isCheckedInAppointmentStatus,
  isClosedAppointmentStatus,
  isPendingAppointmentStatus,
  normalizeAppointmentStatus,
} from "../../lib/appointmentDate";
import {
  APPOINTMENT_CATEGORIES,
  APPOINTMENT_TYPES,
  buildThirtyMinuteAppointmentRange,
  getAppointmentTypeCategory,
} from "../../lib/appointmentTypes";
import { sendAutomaticAppointmentNotification } from "../../lib/automaticAppointmentNotification";
import {
  AppointmentControlGroup,
  AppointmentPageHeader,
  AppointmentPagination,
  AppointmentToolbar,
  AppointmentViewSwitch,
} from "../../components/appointments/AppointmentUi";
import AppointmentTimePicker from "../../components/appointments/AppointmentTimePicker";
import "../../styles/doctor-appointments.css";

const scheduleTableName = "schedule";
const patientColumns =
  "id, full_name, patient_id, user_id, age, contact_number, email, address, expected_delivery_date, gestational_age, risk_level";
const scheduleColumns =
  "id, maternal_appointment_id, patient_id, doctor_id, patient_name, doctor_name, title, description, start_time, end_time, status, created_at";
const appointmentTabs = [
  "All",
  "Requests",
  "Pending",
  "Checked-in",
  "Completed",
  "Cancelled",
  "Missed",
];
const appointmentViews = ["Main", "History"];
const appointmentPageSizes = [10, 15];

const statusOptions = [
  { label: "Pending", value: "scheduled" },
  { label: "Check in", value: "checked_in" },
  { label: "Cancel", value: "cancelled" },
];

const initialAppointmentForm = {
  patient_name: "",
  title: "",
  description: "",
  appointment_date: "",
  appointment_time: "",
};

const initialRescheduleForm = {
  date: "",
  time: "",
  message: "",
};

const initialRescheduleTimeDraft = {
  hour: "08",
  minute: "00",
  period: "AM",
};

function getRescheduleTimeDraft(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return initialRescheduleTimeDraft;

  const hour24 = Number(match[1]);
  const minute = match[2];
  if (!Number.isInteger(hour24) || hour24 < 0 || hour24 > 23) {
    return initialRescheduleTimeDraft;
  }

  return {
    hour: String(hour24 % 12 || 12).padStart(2, "0"),
    minute,
    period: hour24 >= 12 ? "PM" : "AM",
  };
}

function getRescheduleTimeValue(draft) {
  const hour12 = Number(draft?.hour);
  const minute = String(draft?.minute || "00").padStart(2, "0");
  const period = draft?.period === "PM" ? "PM" : "AM";

  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12 || !/^\d{2}$/.test(minute)) {
    return "";
  }

  let hour24 = hour12 % 12;
  if (period === "PM") hour24 += 12;

  return `${String(hour24).padStart(2, "0")}:${minute}`;
}

function formatRescheduleTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return "--:-- --";

  const hour24 = Number(match[1]);
  const minute = match[2];
  if (!Number.isInteger(hour24) || hour24 < 0 || hour24 > 23) return "--:-- --";

  const period = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return `${String(hour12).padStart(2, "0")}:${minute} ${period}`;
}


function getAppointmentDoctorFromIdentity(doctorIdentity) {
  const doctorId = doctorIdentity?.authUser?.id || doctorIdentity?.profile?.id || "";
  const doctorName = String(doctorIdentity?.doctorDisplayName || "").trim();

  if (!doctorId || !doctorName) return null;

  return {
    id: doctorId,
    profileId: doctorIdentity?.profile?.id || "",
    name: doctorName,
    role: doctorIdentity?.profile?.role || doctorIdentity?.role || "doctor",
  };
}

function InlineIcon({ name }) {
  const paths = {
    plus: (
      <>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="6.4" />
        <path d="m16 16 4 4" />
      </>
    ),
    calendar: (
      <>
        <rect x="4" y="5" width="16" height="15" rx="3" />
        <path d="M8 3v4M16 3v4M4 10h16" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v5l3 2" />
      </>
    ),
    chevronDown: <path d="m7 10 5 5 5-5" />,
    chevronLeft: <path d="m15 18-6-6 6-6" />,
    chevronRight: <path d="m9 18 6-6-6-6" />,
    close: (
      <>
        <path d="m7 7 10 10" />
        <path d="m17 7-10 10" />
      </>
    ),
    heart: (
      <path
        fill="currentColor"
        stroke="none"
        d="M12 20.4s-7.3-4.5-8.9-9.1C1.9 7.7 4.4 4.8 7.5 4.8c1.8 0 3.3.9 4.5 2.4 1.2-1.5 2.7-2.4 4.5-2.4 3.1 0 5.6 2.9 4.4 6.5C19.3 15.9 12 20.4 12 20.4Z"
      />
    ),
    phone: <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.4 2.1L8.1 9.6a16 16 0 0 0 6.3 6.3l1.2-1.2a2 2 0 0 1 2.1-.4c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2Z" />,
    consultation: (
      <>
        <path
          fill="currentColor"
          stroke="none"
          d="M8.8 4.4h5.5l3.1 3.3v11.1c0 .9-.7 1.7-1.7 1.7H8.8c-.9 0-1.7-.7-1.7-1.7V6.1c0-.9.7-1.7 1.7-1.7Z"
        />
        <path
          fill="rgba(255,255,255,.55)"
          stroke="none"
          d="M14.1 4.8v3.1c0 .5.4.9.9.9h2.8"
        />
      </>
    ),
    education: (
      <>
        <path
          fill="currentColor"
          stroke="none"
          d="M3.6 11.2 12 7.2l8.4 4-8.4 4-5.1-2.4v2.4l5.1 2.4 6.2-3v2.1L12 19.8 5.8 16.9v-4.6l-2.2-1.1Z"
        />
        <path stroke="currentColor" strokeWidth="2" d="M19.5 12.1v3.8" />
      </>
    ),
    reminder: (
      <>
        <path
          fill="currentColor"
          stroke="none"
          d="M18.8 16.5H5.2c.9-.9 1.4-2.2 1.4-4.2V10a5.4 5.4 0 0 1 10.8 0v2.3c0 2 .5 3.3 1.4 4.2Z"
        />
        <path
          fill="currentColor"
          stroke="none"
          d="M14.2 18.1a2.3 2.3 0 0 1-4.4 0h4.4Z"
        />
      </>
    ),
  };

  return (
    <svg className="doctor-appt-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateInputValue(value) {
  return getManilaDateKey(value);
}

function toTimeInputValue(value) {
  return getManilaTimeKey(value);
}

function formatTableDate(value) {
  return formatAppointmentDate(value, {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
  });
}

function formatTime(value) {
  return formatAppointmentTime(value);
}

function formatLongDate(value) {
  return value ? formatAppointmentDate(value, { day: "2-digit" }) : "";
}

function getLocalDateKey(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;

  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
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

function getVisibleAppointmentId(schedule) {
  return schedule?.maternal_appointment_id || "NA";
}

function statusMatches(schedule, activeTab) {
  const normalized = normalizeAppointmentStatus(schedule.status);

  if (activeTab === "Requests") return isPatientBookingRequest(schedule);
  if (isPatientBookingRequest(schedule)) return false;
  if (activeTab === "All") return true;
  if (activeTab === "Pending") return normalized === appointmentStatuses.scheduled;
  if (activeTab === "Checked-in") return normalized === appointmentStatuses.checkedIn;
  if (activeTab === "Completed") return normalized === appointmentStatuses.completed;
  if (activeTab === "Cancelled") return normalized === appointmentStatuses.cancelled;
  if (activeTab === "Missed") return normalized === appointmentStatuses.missed;

  return true;
}

function appointmentViewMatches(schedule, appointmentView) {
  const classification = classifyAppointment(schedule);

  if (appointmentView === "History") {
    return classification.isHistory;
  }

  return classification.isUpcoming;
}

function monthFilterMatches(schedule, monthFilter) {
  if (!monthFilter) return true;

  const scheduleDate = toDateInputValue(schedule.start_time);
  if (!scheduleDate) return false;

  return scheduleDate.slice(0, 7) === monthFilter;
}


function hasDuplicateAppointment(schedules, candidate) {
  const candidateStart = toDate(candidate.start_time);
  const candidateEnd = toDate(candidate.end_time);

  if (!candidate.patient_id || !candidateStart || !candidateEnd || candidateEnd <= candidateStart) return false;

  return schedules.some((schedule) => {
    if (candidate.id && String(schedule.id || "") === String(candidate.id)) return false;
    if (isClosedAppointmentStatus(schedule.status)) return false;
    if (String(schedule.patient_id || "") !== String(candidate.patient_id)) return false;

    const existingStart = toDate(schedule.start_time);
    const existingEnd = toDate(schedule.end_time);

    if (!existingStart || !existingEnd || existingEnd <= existingStart) return false;

    return candidateStart < existingEnd && candidateEnd > existingStart;
  });
}

function searchMatches(schedule, searchTerm) {
  const keyword = searchTerm.trim().toLowerCase();

  if (!keyword) return true;

  return [
    schedule.id,
    schedule.maternal_appointment_id,
    schedule.patient_id,
    schedule.patient_name,
    schedule.title,
    schedule.doctor_name,
    schedule.status,
  ].some((value) => String(value || "").toLowerCase().includes(keyword));
}

function parseScheduleDetails(description) {
  if (!description) return {};

  try {
    const parsed = JSON.parse(description);
    return parsed && typeof parsed === "object"
      ? parsed
      : { notes: String(description) };
  } catch {
    return { notes: String(description) };
  }
}

function isPatientBookingRequest(schedule) {
  const details = parseScheduleDetails(schedule?.description);
  const requestStatus = String(details.requestStatus || "").trim().toLowerCase();

  return (
    (details.source === "patient-booking-request" || details.requestedByPatient === true) &&
    !["accepted", "declined", "rejected"].includes(requestStatus) &&
    normalizeAppointmentStatus(schedule?.status) === appointmentStatuses.scheduled
  );
}

function getRequestId(schedule, index = 0) {
  if (schedule?.maternal_appointment_id) {
    return String(schedule.maternal_appointment_id).replace(/^MA/i, "REQ");
  }

  const requestDate = toDate(schedule?.created_at) || toDate(schedule?.start_time) || new Date();
  const year = String(requestDate.getFullYear()).slice(-2);
  const source = String(schedule?.id || index + 1).replace(/[^a-z0-9]/gi, "");
  const suffix = source.slice(-4).toUpperCase().padStart(4, "0");
  return `REQ-${year}-${suffix}`;
}

function formatRequestDate(value) {
  const date = toDate(value);
  if (!date) return "Not recorded";

  return date.toLocaleDateString("en-US", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getScheduleDescriptionText(schedule) {
  const details = parseScheduleDetails(schedule?.description);

  const notes = String(
    details.notes ||
      details.message ||
      details.description ||
      ""
  ).trim();

  if (notes) return notes;

  const cancellationReason = String(
    details.cancellationReason ||
      details.cancel_reason ||
      details.reason ||
      ""
  ).trim();

  if (cancellationReason) {
    return `Cancellation reason: ${cancellationReason}`;
  }

  return "NA";
}

function getScheduleLocation(schedule) {
  const details = parseScheduleDetails(schedule?.description);
  return details.location || "Maternal Care Clinic";
}

function logDoctorAppointmentDetailDebug(label, details = {}) {
  if (import.meta.env.DEV) {
    console.info(`[Doctor Calendar Appointment Details] ${label}:`, details);
  }
}

function getWeekStart(dateValue) {
  const date = toDate(`${dateValue}T00:00:00`) || new Date();
  const start = new Date(date);
  start.setDate(date.getDate() - date.getDay());
  start.setHours(0, 0, 0, 0);
  return start;
}

function getWeekDays(dateValue) {
  const start = getWeekStart(dateValue);

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);

    return {
      date,
      key: toDateInputValue(date),
      dayName: date.toLocaleDateString("en-US", { weekday: "short" }),
      dayNumber: date.getDate(),
    };
  });
}

function getWeekRangeLabel(dateValue) {
  const days = getWeekDays(dateValue);
  const first = days[0].date;
  const last = days[days.length - 1].date;

  const firstMonth = first.toLocaleDateString("en-US", { month: "long" });
  const lastMonth = last.toLocaleDateString("en-US", { month: "long" });

  if (firstMonth === lastMonth) {
    return `${firstMonth} ${first.getDate()} - ${last.getDate()}, ${last.getFullYear()}`;
  }

  return `${firstMonth} ${first.getDate()} - ${lastMonth} ${last.getDate()}, ${last.getFullYear()}`;
}

function getScheduleCategory(schedule) {
  return getAppointmentTypeCategory(schedule.title || "");
}

function getReadableScheduleError(error) {
  if (!error) return "Unknown error.";

  if (error.code === "42501" || /row-level security|permission denied/i.test(error.message)) {
    return "Supabase rejected the request because of table permissions or RLS.";
  }

  if (error.code === "42P01" || /could not find the table|schema cache/i.test(error.message)) {
    return "Supabase cannot find the schedule table.";
  }

  return [
    error.message,
    error.details,
    error.hint,
    error.code ? `Code: ${error.code}` : "",
  ]
    .filter(Boolean)
    .join(" ") || "Failed to save schedule.";
}

function getReadableSupabaseError(error) {
  return [
    error?.message,
    error?.details,
    error?.hint,
    error?.code ? `Code: ${error.code}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}


function ProfileDropdownIcon({ name }) {
  const paths = {
    profile: (
      <>
        <circle cx="12" cy="8" r="3.2" />
        <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
      </>
    ),
    settings: (
      <>
        <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 0 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1A2 2 0 0 1 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.6V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.6h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 0 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1h.1a2 2 0 0 1 0 4H21a1.7 1.7 0 0 0-1.6.9Z" />
      </>
    ),
    logout: (
      <>
        <path d="M10 17 15 12 10 7" />
        <path d="M15 12H3" />
        <path d="M12 3h6a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-6" />
      </>
    ),
  };

  return (
    <svg className="doctor-profile-dropdown-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {paths[name]}
    </svg>
  );
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

function DefaultProfileCard({ doctorIdentity }) {
  const [isOpen, setIsOpen] = useState(false);
  const profileRef = useRef(null);
  const displayName = doctorIdentity?.doctorDisplayName ||
    (doctorIdentity?.loading
      ? "Loading Doctor profile..."
      : doctorIdentity?.error
        ? "Unable to load Doctor profile"
        : "Doctor");
  const initials = getDoctorInitials(displayName);

  useEffect(() => {
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
    <div className={`doctor-appointments-profile-wrap ${isOpen ? "is-open" : ""}`} ref={profileRef}>
      <button
        className="doctor-appointments-profile"
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className="doctor-appointments-profile-avatar">{initials}</span>

        <span className="doctor-appointments-profile-copy">
          <strong>{displayName}</strong>
          <small>Doctor</small>
        </span>

        <span className="doctor-appointments-profile-arrow" aria-hidden="true">
          <InlineIcon name="chevronDown" />
        </span>
      </button>

      {isOpen ? (
        <div className="doctor-top-profile-dropdown" role="menu">
          <div className="doctor-top-profile-dropdown__header">
            <span className="doctor-top-profile-dropdown__avatar">{initials}</span>
            <span>
              <strong>{displayName}</strong>
              <small>Doctor Account</small>
            </span>
          </div>

          <div className="doctor-top-profile-dropdown__divider" />

          <button type="button" role="menuitem" onClick={() => goToDoctorSection("profile")}>
            <ProfileDropdownIcon name="profile" />
            View Profile
          </button>
          <button type="button" role="menuitem" onClick={() => goToDoctorSection("settings")}>
            <ProfileDropdownIcon name="settings" />
            Settings
          </button>
          <button className="is-danger" type="button" role="menuitem" onClick={() => goToDoctorSection("logout")}>
            <ProfileDropdownIcon name="logout" />
            Logout
          </button>
        </div>
      ) : null}
    </div>
  );
}


function StatusDropdown({
  schedule,
  updatingStatusId,
  onStatusSelect,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState(null);
  const cellRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const statusLabel = getAppointmentStatusLabel(schedule.status);
  const isCheckedIn = isCheckedInAppointmentStatus(schedule.status);
  const isClosed = isClosedAppointmentStatus(schedule.status);

  const availableOptions = isCheckedIn
    ? [{ label: "Completed", value: appointmentStatuses.checkedIn }]
    : statusOptions.filter((option) => option.value !== appointmentStatuses.scheduled);

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menuRef.current?.getBoundingClientRect();
    const menuWidth = menuRect?.width || 154;
    const menuHeight = menuRect?.height || 56;
    const viewportPadding = 12;
    const menuGap = 6;
    const maximumLeft = Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding);
    const centeredLeft = triggerRect.left + (triggerRect.width - menuWidth) / 2;
    const left = Math.min(Math.max(centeredLeft, viewportPadding), maximumLeft);
    const spaceBelow = window.innerHeight - triggerRect.bottom - viewportPadding;
    const top = spaceBelow >= menuHeight + menuGap
      ? triggerRect.bottom + menuGap
      : Math.max(viewportPadding, triggerRect.top - menuHeight - menuGap);

    setMenuPosition({
      left: Math.round(left),
      top: Math.round(top),
    });
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;

    const cell = cellRef.current;
    updateMenuPosition();

    const closeOnOutsidePointer = (event) => {
      if (!cell?.contains(event.target) && !menuRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    };

    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);

    return () => {
      document.removeEventListener("mousedown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [isOpen, updateMenuPosition]);

  const chooseOption = (option) => {
    setIsOpen(false);
    onStatusSelect(schedule, option.value);
  };

  return (
    <span
      ref={cellRef}
      className="doctor-appointment-status-cell"
      style={{
        position: "relative",
        width: "fit-content",
        minWidth: "fit-content",
        justifySelf: "start",
        overflow: "visible",
        zIndex: isOpen ? 1000 : undefined,
      }}
    >
      <button
        ref={triggerRef}
        className={`doctor-appointment-status appointment-ui-status doctor-appointment-status--${getAppointmentStatusClass(schedule.status)}`}
        type="button"
        disabled={updatingStatusId === schedule.id || isClosed}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={(event) => {
          event.stopPropagation();
          if (isOpen) {
            setIsOpen(false);
            return;
          }

          updateMenuPosition();
          setIsOpen(true);
        }}
        style={{
          position: "relative",
          paddingRight: "30px",
        }}
      >
        <span>
          {updatingStatusId === schedule.id ? "Updating..." : statusLabel}
        </span>

        {!isClosed ? (
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              right: "10px",
              top: "50%",
              transform: `translateY(-50%) rotate(${isOpen ? "180deg" : "0deg"})`,
              display: "inline-flex",
              transition: "transform 160ms ease",
              pointerEvents: "none",
            }}
          >
            <Icon
              icon="solar:alt-arrow-down-linear"
              width="14"
              height="14"
              aria-hidden="true"
            />
          </span>
        ) : null}
      </button>

      {isOpen && !isClosed && menuPosition && typeof document !== "undefined"
        ? createPortal(
          <div
            ref={menuRef}
            className="doctor-appointment-status-portal-menu"
            role="menu"
            aria-label={`Actions for ${statusLabel} appointment`}
            style={{ left: `${menuPosition.left}px`, top: `${menuPosition.top}px` }}
            onClick={(event) => event.stopPropagation()}
          >
          {availableOptions.map((option) => {
            const isCompleteOption =
              isCheckedIn &&
              option.value === appointmentStatuses.checkedIn;
            const isCancelOption = option.value === appointmentStatuses.cancelled;

            return (
              <button
                key={option.value}
                type="button"
                role="menuitem"
                onClick={() => chooseOption(option)}
                style={{
                  width: "100%",
                  minHeight: "34px",
                  border: 0,
                  borderRadius: "9px",
                  padding: "0 12px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  fontFamily: "Poppins, sans-serif",
                  fontSize: "12px",
                  fontWeight: 700,
                  background: isCompleteOption
                    ? "#e9f8f0"
                    : isCancelOption
                      ? "#fff0f2"
                      : "#eaf2ff",
                  color: isCompleteOption
                    ? "#16875f"
                    : isCancelOption
                      ? "#e34a61"
                      : "#2563eb",
                }}
              >
                {option.label}
              </button>
            );
          })}
          </div>,
          document.body
        )
        : null}
    </span>
  );
}

function DoctorAppointmentDetailsModal({
  schedule,
  actionError,
  isUpdating,
  onClose,
  onEdit,
  onAcceptRequest,
  onCheckIn,
  onComplete,
  onCancel,
}) {
  if (!schedule) return null;

  const statusLabel = getAppointmentStatusLabel(schedule.status);
  const isRequest = isPatientBookingRequest(schedule);
  const canEdit = !isRequest && isPendingAppointmentStatus(schedule.status);
  const canCheckIn = !isRequest && isPendingAppointmentStatus(schedule.status);
  const canComplete = isCheckedInAppointmentStatus(schedule.status);
  const canCancel =
    !isClosedAppointmentStatus(schedule.status) &&
    !isCheckedInAppointmentStatus(schedule.status);
  const detailDate = formatLongDate(schedule.start_time);
  const detailTime = formatTime(schedule.start_time);
  const details = [
    ["Patient Name", schedule.patient_name || "NA"],
    [isRequest ? "Request ID" : "Appointment ID", isRequest ? getRequestId(schedule) : getVisibleAppointmentId(schedule)],
    ["Appointment Type", schedule.title || "NA"],
    ["Doctor", schedule.doctor_name || "NA"],
    ["Date and Time", detailDate && detailTime !== "-" ? `${detailDate} at ${detailTime}` : "NA"],
    ["Status", statusLabel],
    ...(isRequest ? [["Date Requested", formatRequestDate(schedule.created_at)]] : []),
    ["Description", getScheduleDescriptionText(schedule)],
    ["Location", getScheduleLocation(schedule)],
  ];

  return createPortal(
    <div
      className="doctor-appointment-detail-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <section
        className="doctor-appointment-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="doctor-appointment-detail-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="doctor-appointment-detail-close"
          aria-label="Close appointment details"
          onClick={onClose}
        >
          <InlineIcon name="close" />
        </button>

        <header>
          <span className={`doctor-appointment-detail-icon is-${getAppointmentStatusClass(schedule.status)}`}>
            <InlineIcon name="calendar" />
          </span>
          <div>
            <h2 id="doctor-appointment-detail-title">
              {schedule.patient_name || "NA"}
            </h2>
            <p>{schedule.title || "NA"}</p>
          </div>
        </header>

        {actionError ? (
          <p className="doctor-appointment-detail-error">{actionError}</p>
        ) : null}

        <dl className="doctor-appointment-detail-list">
          {details.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value || "NA"}</dd>
            </div>
          ))}
        </dl>

        {(isRequest || canEdit || canCheckIn || canComplete || canCancel) ? (
          <footer>
            {isRequest ? (
              <button
                type="button"
                className="is-primary"
                onClick={() => onAcceptRequest(schedule)}
                disabled={isUpdating}
              >
                {isUpdating ? "Accepting..." : "Accept Request"}
              </button>
            ) : null}

            {canEdit ? (
              <button
                type="button"
                className="is-outline"
                onClick={() => onEdit(schedule)}
                disabled={isUpdating}
              >
                Edit
              </button>
            ) : null}

            {canCheckIn ? (
              <button
                type="button"
                className="is-outline"
                onClick={() => onCheckIn(schedule)}
                disabled={isUpdating}
              >
                {isUpdating ? "Checking in..." : "Check in"}
              </button>
            ) : null}

            {canComplete ? (
              <button
                type="button"
                className="is-primary"
                onClick={() => onComplete(schedule)}
                disabled={isUpdating}
              >
                Complete
              </button>
            ) : null}

            {canCancel ? (
              <button
                type="button"
                className="is-danger"
                onClick={() => onCancel(schedule)}
                disabled={isUpdating}
              >
                {isUpdating ? "Cancelling..." : isRequest ? "Decline Request" : "Cancel"}
              </button>
            ) : null}
          </footer>
        ) : null}
      </section>
    </div>,
    document.body
  );
}

function FigmaWeekCalendar({
  schedules,
  selectedDate,
  onSelectDate,
  onPreviousWeek,
  onNextWeek,
  onSelectSchedule,
}) {
  const weekDays = getWeekDays(selectedDate);
  const timeSlots = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
  const startHour = 6;
  const hourHeight = 70;

  const schedulesByDay = useMemo(() => {
    return weekDays.reduce((acc, day) => {
      acc[day.key] = schedules.filter((schedule) => toDateInputValue(schedule.start_time) === day.key);
      return acc;
    }, {});
  }, [schedules, weekDays]);

  return (
    <section className="doctor-calendar-panel">
      <header className="doctor-calendar-header">
        <div className="doctor-calendar-title-group">
          <h2>Calendar</h2>
          <button type="button" onClick={onPreviousWeek} aria-label="Previous week">
            ‹
          </button>
          <button type="button" onClick={onNextWeek} aria-label="Next week">
            ›
          </button>
        </div>

        <strong>{getWeekRangeLabel(selectedDate)}</strong>
      </header>

      <div className="doctor-week-calendar">
        <div className="doctor-week-calendar-days">
          <span className="doctor-week-calendar-time-head">Time</span>

          {weekDays.map((day) => (
            <button
              className={day.key === selectedDate ? "is-selected" : ""}
              type="button"
              key={day.key}
              onClick={() => onSelectDate(day.key)}
            >
              <small>{day.dayName}</small>
              <strong>{day.dayNumber}</strong>
            </button>
          ))}
        </div>

        <div className="doctor-week-calendar-body" style={{ "--hour-height": `${hourHeight}px` }}>
          <div className="doctor-week-calendar-times">
            {timeSlots.map((hour) => (
              <span key={hour}>
                {hour === 12 ? "12 PM" : hour > 12 ? `${hour - 12} PM` : `${hour.toString().padStart(2, "0")} AM`}
              </span>
            ))}
          </div>

          <div className="doctor-week-calendar-grid">
            {weekDays.map((day) => (
              <div className="doctor-week-calendar-day" key={day.key}>
                {timeSlots.map((hour) => (
                  <span className="doctor-week-calendar-line" key={hour} />
                ))}

                {(schedulesByDay[day.key] || []).map((schedule) => {
                  const start = toDate(schedule.start_time);
                  const startMinutes = Math.max(
                    0,
                    ((start?.getHours() || startHour) - startHour) * 60 + (start?.getMinutes() || 0)
                  );
                  const top = (startMinutes / 60) * hourHeight;
                  const height = 66;
                  const category = getScheduleCategory(schedule);

                  return (
                    <button
                      type="button"
                      className={`doctor-week-event is-${category}`}
                      key={schedule.id}
                      style={{
                        top: `${top}px`,
                        height: `${height}px`,
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelectSchedule(schedule);
                      }}
                    >
                      <strong>{schedule.patient_name}</strong>
                      <span>{formatTime(schedule.start_time)} - {formatTime(schedule.end_time)}</span>
                      <small>{schedule.title}</small>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}


function DoctorAppointmentSummary({ summary }) {
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
    <section className="doctor-appointment-summary" aria-label="Appointment summary">
      {cards.map((card) => (
        <article
          className={`doctor-appointment-summary-card ${card.tone}`}
          key={card.label}
        >
          <span className="doctor-appointment-summary-icon">
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

function DoctorAppointmentRequests({
  requests,
  totalRequests,
  currentPage,
  totalPages,
  searchTerm,
  sortOrder,
  patients,
  miniMonthDate,
  miniMonthDays,
  todaySchedules,
  onSearchChange,
  onSortChange,
  onPageChange,
  onMonthChange,
  onSelectDate,
  onViewRequest,
  onViewSchedule,
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
            <InlineIcon name="search" />
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
            <InlineIcon name="chevronDown" />
          </label>
        </div>

        <div className="doctor-request-table-wrap">
          <div className="doctor-request-table">
            <div className="doctor-request-table-head">
              <span>Request ID</span>
              <span>Patient</span>
              <span>Appointment Type</span>
              <span>Prefer Date &amp; Time</span>
              <span>Date Requested</span>
              <span>Action</span>
            </div>

            <div className="doctor-request-table-body">
              {requests.length ? requests.map((schedule, index) => {
                const patient = patientById.get(String(schedule.patient_id)) || null;
                const requestId = getRequestId(schedule, index);
                const gestation = patient?.gestational_age
                  ? `${patient.gestational_age} weeks pregnant`
                  : patient?.risk_level || "Patient request";

                return (
                  <article className="doctor-request-row" key={schedule.id}>
                    <strong className="doctor-request-id">{requestId}</strong>
                    <div className="doctor-request-patient">
                      <span>{String(schedule.patient_name || "P").charAt(0).toUpperCase()}</span>
                      <div>
                        <strong>{schedule.patient_name || "Patient"}</strong>
                        <small>{patient?.patient_id || "Patient ID pending"}</small>
                        <small>{gestation}</small>
                      </div>
                    </div>
                    <div className="doctor-request-type">
                      <Icon icon={
                        getScheduleCategory(schedule) === "laboratory"
                          ? "solar:test-tube-linear"
                          : getScheduleCategory(schedule) === "ultrasound"
                            ? "solar:monitor-camera-linear"
                            : getScheduleCategory(schedule) === "prenatal"
                              ? "solar:medical-kit-linear"
                              : "solar:heart-pulse-linear"
                      } />
                      <span>{schedule.title || "Appointment"}</span>
                    </div>
                    <div className="doctor-request-preferred">
                      <span><Icon icon="solar:calendar-linear" /> {formatRequestDate(schedule.start_time)}</span>
                      <span><Icon icon="solar:clock-circle-linear" /> {formatTime(schedule.start_time)}</span>
                    </div>
                    <div className="doctor-request-created">
                      <span>{formatRequestDate(schedule.created_at)}</span>
                      <small>{schedule.created_at ? formatTime(schedule.created_at) : "Not recorded"}</small>
                    </div>
                    <button type="button" className="doctor-request-view" onClick={() => onViewRequest(schedule)}>
                      View
                    </button>
                  </article>
                );
              }) : (
                <div className="doctor-request-empty">
                  <Icon icon="solar:inbox-linear" />
                  <strong>No appointment requests found</strong>
                  <span>New requests from patients will appear here.</span>
                </div>
              )}
            </div>

            <footer className="doctor-request-pagination">
              <span>
                {totalRequests
                  ? `Showing ${(currentPage - 1) * 5 + 1}-${Math.min(currentPage * 5, totalRequests)} of ${totalRequests} requests`
                  : "Showing 0 requests"}
              </span>
              <div>
                <button type="button" disabled={currentPage <= 1} onClick={() => onPageChange(currentPage - 1)} aria-label="Previous request page">
                  <InlineIcon name="chevronLeft" />
                </button>
                <strong>{currentPage}</strong>
                <button type="button" disabled={currentPage >= totalPages} onClick={() => onPageChange(currentPage + 1)} aria-label="Next request page">
                  <InlineIcon name="chevronRight" />
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
              <InlineIcon name="chevronLeft" />
            </button>
            <strong>{formatMonthTitle(miniMonthDate)}</strong>
            <button type="button" aria-label="Next month" onClick={() => onMonthChange(1)}>
              <InlineIcon name="chevronRight" />
            </button>
          </div>
          <div className="doctor-request-calendar-weekdays">
            {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((day) => <span key={day}>{day}</span>)}
          </div>
          <div className="doctor-request-calendar-days">
            {miniMonthDays.map((day, index) => (
              <button
                key={`${day.value}-${index}`}
                type="button"
                className={`${day.disabled ? "is-muted" : ""} ${day.hasEvent ? "has-event" : ""} ${day.active ? "is-active" : ""}`}
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
            <span>{new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</span>
          </header>
          <div>
            {todaySchedules.length ? todaySchedules.slice(0, 5).map((schedule) => (
              <button type="button" key={schedule.id} onClick={() => onViewSchedule(schedule)}>
                <time>{formatTime(schedule.start_time)}</time>
                <span className={`is-${getScheduleCategory(schedule)}`}>
                  <strong>{schedule.patient_name || "Patient"}</strong>
                  <small>{schedule.title || "Appointment"}</small>
                </span>
              </button>
            )) : (
              <p>No appointments scheduled for today.</p>
            )}
          </div>
        </section>
      </aside>
    </section>
  );
}

function DoctorAppointmentRequestDetails({
  schedule,
  patient,
  isUpdating,
  actionError,
  onBack,
  onApprove,
  onDecline,
}) {
  const details = parseScheduleDetails(schedule?.description);
  const gestationValue = String(patient?.gestational_age || "").trim();
  const gestationLabel = gestationValue
    ? `${gestationValue}${/week/i.test(gestationValue) ? "" : " weeks"} pregnant`
    : patient?.risk_level || "Pregnancy information unavailable";
  const requestNotes = String(
    details.notes || details.message || details.reason || "No additional notes were provided."
  ).trim();
  const requestedAt = schedule?.created_at
    ? `${formatRequestDate(schedule.created_at)} at ${formatTime(schedule.created_at)}`
    : "Not recorded";

  return (
    <section className="doctor-request-details-page">
      <nav className="doctor-request-breadcrumbs" aria-label="Breadcrumb">
        <button type="button" onClick={onBack}>Appointments</button>
        <InlineIcon name="chevronRight" />
        <button type="button" onClick={onBack}>Patient Requests</button>
        <InlineIcon name="chevronRight" />
        <strong>Appointment Details</strong>
      </nav>

      <header className="doctor-request-details-heading">
        <div>
          <h1>Appointment Details</h1>
          <p>Review the patient's appointment request and take action.</p>
        </div>
        <span className="doctor-request-pending-badge">
          <Icon icon="solar:clock-circle-linear" /> Pending
        </span>
      </header>

      <section className="doctor-request-patient-card">
        <div className="doctor-request-detail-avatar">
          {String(schedule?.patient_name || "P").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}
        </div>
        <div className="doctor-request-patient-identity">
          <h2>{schedule?.patient_name || patient?.full_name || "Patient"}</h2>
          <p>Patient ID: {patient?.patient_id || "Not assigned"}</p>
          <span>{gestationLabel}</span>
        </div>
        <div className="doctor-request-patient-contact">
          <span><Icon icon="solar:user-rounded-linear" /> Age: {patient?.age || "Not provided"}</span>
          <span><Icon icon="solar:phone-linear" /> {patient?.contact_number || "Not provided"}</span>
          <span><Icon icon="solar:letter-linear" /> {patient?.email || "Not provided"}</span>
        </div>
      </section>

      <section className="doctor-request-information-card">
        <header>
          <Icon icon="solar:calendar-linear" />
          <h2>Appointment Information</h2>
        </header>
        <dl>
          <div>
            <dt>Appointment Type</dt>
            <dd><Icon icon="solar:heart-pulse-linear" /> {schedule?.title || "Appointment"}</dd>
          </div>
          <div>
            <dt>Preferred Date</dt>
            <dd><Icon icon="solar:calendar-linear" /> {formatRequestDate(schedule?.start_time)}</dd>
          </div>
          <div>
            <dt>Preferred Time</dt>
            <dd><Icon icon="solar:clock-circle-linear" /> {formatTime(schedule?.start_time)}</dd>
          </div>
          <div>
            <dt>Date Requested</dt>
            <dd><Icon icon="solar:calendar-linear" /> {requestedAt}</dd>
          </div>
          <div className="is-notes">
            <dt>Reason / Notes</dt>
            <dd><Icon icon="solar:document-text-linear" /> <span>{requestNotes}</span></dd>
          </div>
        </dl>
      </section>

      <section className="doctor-request-status-card">
        <header>
          <Icon icon="solar:danger-triangle-linear" />
          <h2>Request Status</h2>
        </header>
        <div className="doctor-request-current-status">
          <strong>Current Status</strong>
          <span className="doctor-request-pending-badge"><Icon icon="solar:clock-circle-linear" /> Pending</span>
          <small><Icon icon="solar:info-circle-linear" /> Waiting for your approval.</small>
        </div>

        {actionError ? <p className="doctor-request-detail-error" role="alert">{actionError}</p> : null}

        <footer>
          <div>
            <button type="button" className="doctor-request-back-button" onClick={onBack}>
              <InlineIcon name="chevronLeft" /> Back
            </button>
            <SendPatientNotificationAction
              patientId={schedule?.patient_id || ""}
              patientName={schedule?.patient_name || "Patient"}
              appointmentId={schedule?.id || null}
              defaultType="general"
              defaultTitle="Appointment request update"
              defaultMessage="We are reviewing your appointment request."
              lockedTargetPath="/patient/appointments"
              contextLabel={`Appointment request ${getRequestId(schedule)}`}
              triggerLabel="Message Patient"
              className="doctor-request-message-button"
              outline
            />
          </div>
          <div>
            <button type="button" className="doctor-request-decline-button" onClick={() => onDecline(schedule)} disabled={isUpdating}>
              {isUpdating ? "Updating..." : "Decline"}
            </button>
            <button type="button" className="doctor-request-approve-button" onClick={() => onApprove(schedule)} disabled={isUpdating}>
              <Icon icon="solar:check-read-linear" />
              {isUpdating ? "Approving..." : "Approve & Schedule"}
            </button>
          </div>
        </footer>
      </section>
    </section>
  );
}

export function DoctorAppointmentsContent({
  embedded = false,
  headerAction = null,
  doctorIdentity = null,
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const visitRoute = parseAppointmentVisitRoute(location.pathname, "doctor");
  const isVisitFormRoute = Boolean(visitRoute);
  const authenticatedDoctorId = doctorIdentity?.authUser?.id || "";
  const dashboardAppointmentTarget = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return String(params.get("appointmentId") || "").trim();
  }, [location.search]);
  const dashboardCompletedHistoryTarget = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return (
      String(params.get("status") || "").trim().toLowerCase() === "completed" &&
      String(params.get("view") || "").trim().toLowerCase() === "history"
    );
  }, [location.search]);
  const [form, setForm] = useState(initialAppointmentForm);
  const [patients, setPatients] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [activeTab, setActiveTab] = useState(() =>
    dashboardCompletedHistoryTarget ? "Completed" : "All"
  );
  const [appointmentView, setAppointmentView] = useState(() =>
    dashboardCompletedHistoryTarget ? "History" : "Main"
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [monthFilter, setMonthFilter] = useState("");
  const [requestSort, setRequestSort] = useState("newest");
  const [pageSize, setPageSize] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedDate, setSelectedDate] = useState(() => getManilaDateKey());
  const [miniMonthDate, setMiniMonthDate] = useState(() => {
    const today = toCalendarDate(getManilaDateKey()) || new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });
  const [isAdding, setIsAdding] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingPatients, setIsLoadingPatients] = useState(false);
  const [updatingStatusId, setUpdatingStatusId] = useState("");
  const [cancelConfirmationSchedule, setCancelConfirmationSchedule] = useState(null);
  const [rescheduleSchedule, setRescheduleSchedule] = useState(null);
  const [rescheduleForm, setRescheduleForm] = useState(initialRescheduleForm);
  const [isRescheduleTimePickerOpen, setIsRescheduleTimePickerOpen] = useState(false);
  const [rescheduleTimeDraft, setRescheduleTimeDraft] = useState(initialRescheduleTimeDraft);
  const [refreshedAppointmentDoctor, setRefreshedAppointmentDoctor] = useState(null);
  const [isResolvingAppointmentDoctor, setIsResolvingAppointmentDoctor] = useState(false);
  const [appointmentDoctorError, setAppointmentDoctorError] = useState(null);
  const [selectedCalendarSchedule, setSelectedCalendarSchedule] = useState(null);
  const [selectedRequestSchedule, setSelectedRequestSchedule] = useState(null);
  const [detailActionError, setDetailActionError] = useState("");
  const tableScrollRef = useRef(null);
  const appointmentSaveLockRef = useRef(false);
  const appointmentStatusLockRef = useRef(new Set());
  const rescheduleSaveLockRef = useRef(false);
  const visitRoutingLockRef = useRef("");
  const appointmentsRequestRef = useRef(null);
  const appointmentsMountedRef = useRef(true);
  const patientsRequestRef = useRef(null);
  const completedHistoryTargetAppliedRef = useRef(
    dashboardCompletedHistoryTarget
  );

  useEffect(() => {
    if (isVisitFormRoute || dashboardAppointmentTarget) {
      return undefined;
    }

    const frameId = window.requestAnimationFrame(() => {
      if (dashboardCompletedHistoryTarget) {
        setActiveTab("Completed");
        setAppointmentView("History");
        completedHistoryTargetAppliedRef.current = true;
        return;
      }

      if (completedHistoryTargetAppliedRef.current) {
        setActiveTab("All");
        setAppointmentView("Main");
        completedHistoryTargetAppliedRef.current = false;
      }
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [
    dashboardAppointmentTarget,
    dashboardCompletedHistoryTarget,
    isVisitFormRoute,
  ]);

  const selectCalendarDate = useCallback((value) => {
    const nextDate = value instanceof Date ? new Date(value) : toCalendarDate(value);
    if (!nextDate || Number.isNaN(nextDate.getTime())) return;

    setSelectedDate(getLocalDateKey(nextDate));
    setMiniMonthDate(new Date(nextDate.getFullYear(), nextDate.getMonth(), 1));
  }, []);

  const hookAppointmentDoctor = useMemo(
    () => getAppointmentDoctorFromIdentity(doctorIdentity),
    [doctorIdentity]
  );
  const appointmentDoctor = hookAppointmentDoctor || refreshedAppointmentDoctor;
  const isAppointmentDoctorLoading =
    Boolean(doctorIdentity?.loading) || isResolvingAppointmentDoctor;
  const visibleAppointmentDoctorError =
    appointmentDoctor ? null : appointmentDoctorError || doctorIdentity?.error || null;

  const matchingPatients = form.patient_name.trim()
    ? patients
        .filter((patient) => {
          const keyword = form.patient_name.trim().toLowerCase();
          return (
            patient.full_name?.toLowerCase().includes(keyword) ||
            patient.contact_number?.toLowerCase().includes(keyword)
          );
        })
        .slice(0, 6)
    : [];

  const hasExactPatientMatch =
    patients.length === 0 ||
    patients.some(
      (patient) => patient.full_name?.toLowerCase() === form.patient_name.trim().toLowerCase()
    );
  const isAddAppointmentReady =
    Boolean(form.patient_name.trim()) &&
    Boolean(form.appointment_date) &&
    Boolean(form.appointment_time) &&
    Boolean(form.title.trim()) &&
    hasExactPatientMatch &&
    Boolean(appointmentDoctor?.id) &&
    !isAppointmentDoctorLoading &&
    !visibleAppointmentDoctorError;

  const appointmentSummary = useMemo(() => {
    return schedules.reduce(
      (summary, schedule) => {
        const status = normalizeAppointmentStatus(schedule.status);

        summary.total += 1;

        if (status === appointmentStatuses.scheduled) {
          summary.pending += 1;
        }

        if (status === appointmentStatuses.checkedIn) {
          summary.checkedIn += 1;
        }

        if (
          status === appointmentStatuses.cancelled ||
          status === appointmentStatuses.missed
        ) {
          summary.cancelled += 1;
        }

        return summary;
      },
      {
        total: 0,
        pending: 0,
        checkedIn: 0,
        cancelled: 0,
      }
    );
  }, [schedules]);

  const miniMonthDays = useMemo(() => {
    const activeDate = toCalendarDate(selectedDate) || new Date();

    return buildMiniMonthDays(miniMonthDate, activeDate).map((day) => ({
      ...day,
      hasEvent: schedules.some(
        (schedule) =>
          getManilaDateKey(schedule.start_time) === getLocalDateKey(day.date)
      ),
    }));
  }, [miniMonthDate, schedules, selectedDate]);

  const visibleSchedules = useMemo(
    () =>
      schedules
        .filter((schedule) =>
          appointmentViewMatches(schedule, appointmentView)
        )
        .filter((schedule) => statusMatches(schedule, activeTab))
        .filter((schedule) => searchMatches(schedule, searchTerm))
        .filter((schedule) => monthFilterMatches(schedule, monthFilter))
        .sort(
          appointmentView === "History"
            ? compareHistoryAppointments
            : compareUpcomingAppointments
        ),
    [
      activeTab,
      appointmentView,
      monthFilter,
      schedules,
      searchTerm,
    ]
  );

  const requestSchedules = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    const matching = schedules
      .filter(isPatientBookingRequest)
      .filter(
        (schedule) =>
          !schedule.doctor_id ||
          !authenticatedDoctorId ||
          String(schedule.doctor_id) === String(authenticatedDoctorId)
      )
      .filter((schedule, index) => {
        if (!keyword) return true;

        return [
          getRequestId(schedule, index),
          schedule.patient_name,
          schedule.title,
          schedule.patient_id,
        ].some((value) => String(value || "").toLowerCase().includes(keyword));
      });

    return matching.sort((first, second) => {
      if (requestSort === "appointment") {
        return (toDate(first.start_time)?.getTime() || 0) - (toDate(second.start_time)?.getTime() || 0);
      }

      const firstTime = toDate(first.created_at)?.getTime() || toDate(first.start_time)?.getTime() || 0;
      const secondTime = toDate(second.created_at)?.getTime() || toDate(second.start_time)?.getTime() || 0;
      return requestSort === "oldest" ? firstTime - secondTime : secondTime - firstTime;
    });
  }, [authenticatedDoctorId, requestSort, schedules, searchTerm]);

  const requestTotalPages = Math.max(1, Math.ceil(requestSchedules.length / 5));
  const requestDisplayedPage = Math.min(currentPage, requestTotalPages);
  const paginatedRequests = useMemo(() => {
    const startIndex = (requestDisplayedPage - 1) * 5;
    return requestSchedules.slice(startIndex, startIndex + 5);
  }, [requestDisplayedPage, requestSchedules]);
  const todaySchedules = useMemo(() => {
    const todayKey = getManilaDateKey();
    return schedules
      .filter((schedule) => getManilaDateKey(schedule.start_time) === todayKey)
      .filter((schedule) => !isClosedAppointmentStatus(schedule.status))
      .sort(compareUpcomingAppointments);
  }, [schedules]);

  const totalPages = Math.max(1, Math.ceil(visibleSchedules.length / pageSize));
  const displayedPage = Math.min(currentPage, totalPages);
  const paginatedSchedules = useMemo(() => {
    const startIndex = (displayedPage - 1) * pageSize;
    return visibleSchedules.slice(startIndex, startIndex + pageSize);
  }, [displayedPage, pageSize, visibleSchedules]);

  const handleTabChange = (nextTab) => {
    setActiveTab(nextTab);
    setCurrentPage(1);
    setSearchTerm("");
    setMonthFilter("");
  };

  const loadAppointments = useCallback(() => {
    if (appointmentsRequestRef.current) {
      return appointmentsRequestRef.current;
    }

    const request = (async () => {
      const { data, error } = await supabase
        .from(scheduleTableName)
        .select(scheduleColumns)
        .order("start_time", { ascending: true });

      if (error) {
        console.error("[Doctor Appointment Flow] appointment fetch error:", error);
        if (appointmentsMountedRef.current) {
          setSchedules([]);
          setStatusMessage(
            `Unable to load appointments from Supabase: ${getReadableScheduleError(error)}`
          );
        }
        return { ok: false, count: 0, error };
      }

      const nextSchedules = data ?? [];
      if (appointmentsMountedRef.current) {
        setSchedules(nextSchedules);
        setSelectedCalendarSchedule((current) =>
          current?.id
            ? nextSchedules.find((schedule) => schedule.id === current.id) || current
            : current
        );
        setSelectedRequestSchedule((current) =>
          current?.id
            ? nextSchedules.find((schedule) => schedule.id === current.id) || current
            : current
        );

        // Keep the user's current calendar position. The initial selectedDate
        // already uses today's Manila date, and explicit actions (deep links,
        // creating/rescheduling appointments, mini-calendar/week navigation)
        // move the calendar intentionally.
      }
      return { ok: true, count: nextSchedules.length };
    })();

    appointmentsRequestRef.current = request;
    const clearPendingAppointmentRequest = () => {
      if (appointmentsRequestRef.current === request) {
        appointmentsRequestRef.current = null;
      }
    };
    request.then(clearPendingAppointmentRequest, clearPendingAppointmentRequest);
    return request;
  }, [selectCalendarDate]);

  useEffect(() => {
    if (isVisitFormRoute || doctorIdentity?.loading || !authenticatedDoctorId) {
      return undefined;
    }

    appointmentsMountedRef.current = true;
    const loadTimer = window.setTimeout(() => {
      loadAppointments();
    }, 0);

    const channel = supabase
      .channel("doctor-appointments")
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

    return () => {
      appointmentsMountedRef.current = false;
      window.clearTimeout(loadTimer);
      supabase.removeChannel(channel);
    };
  }, [authenticatedDoctorId, doctorIdentity?.loading, isVisitFormRoute, loadAppointments]);

  /*
   * Dashboard "View Appointment" deep link.
   *
   * The Doctor Dashboard sends the public MA number (or, as a fallback,
   * the internal schedule UUID) in ?appointmentId=. Once schedules load,
   * resolve that exact row, align Main/History, move the calendar to the
   * appointment date, filter the table, and open the existing details modal.
   */
  useEffect(() => {
    if (
      isVisitFormRoute ||
      !dashboardAppointmentTarget ||
      schedules.length === 0
    ) {
      return undefined;
    }

    const target = schedules.find(
      (schedule) =>
        String(schedule.id || "") === dashboardAppointmentTarget ||
        String(schedule.maternal_appointment_id || "") ===
          dashboardAppointmentTarget
    );

    const frameId = window.requestAnimationFrame(() => {
      if (!target) {
        setStatusMessage(
          `Appointment ${dashboardAppointmentTarget} could not be found.`
        );
        return;
      }

      const classification = classifyAppointment(target);
      const visibleAppointmentId =
        target.maternal_appointment_id || dashboardAppointmentTarget;

      setActiveTab("All");
      setAppointmentView(classification.isHistory ? "History" : "Main");
      setSearchTerm(visibleAppointmentId);
      setMonthFilter("");
      setCurrentPage(1);
      selectCalendarDate(toDateInputValue(target.start_time));
      setDetailActionError("");
      setSelectedCalendarSchedule(target);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [
    dashboardAppointmentTarget,
    isVisitFormRoute,
    schedules,
    selectCalendarDate,
  ]);

  useEffect(() => {
    if (isVisitFormRoute || doctorIdentity?.loading || !authenticatedDoctorId) {
      return undefined;
    }

    let active = true;
    const loadPatients = async () => {
      setIsLoadingPatients(true);

      if (!patientsRequestRef.current) {
        const request = Promise.resolve(
          supabase
            .rpc("get_doctor_patient_directory")
            .select(patientColumns)
            .order("full_name", { ascending: true })
        );
        patientsRequestRef.current = request;
        const clearPendingPatientRequest = () => {
          if (patientsRequestRef.current === request) {
            patientsRequestRef.current = null;
          }
        };
        request.then(clearPendingPatientRequest, clearPendingPatientRequest);
      }

      const { data, error } = await patientsRequestRef.current;

      if (!active) return;
      setIsLoadingPatients(false);

      if (error) {
        console.error(error);
        return;
      }

      setPatients(data ?? []);
    };

    loadPatients();
    return () => {
      active = false;
    };
  }, [authenticatedDoctorId, doctorIdentity?.loading, isVisitFormRoute]);

  useEffect(() => {
    if (tableScrollRef.current) {
      tableScrollRef.current.scrollTop = 0;
    }
  }, [
    activeTab,
    appointmentView,
    monthFilter,
    displayedPage,
    pageSize,
    searchTerm,
  ]);


  useEffect(() => {
    if (!selectedCalendarSchedule) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setSelectedCalendarSchedule(null);
        setDetailActionError("");
      }
    };

    window.addEventListener("keydown", handleEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleEscape);
    };
  }, [selectedCalendarSchedule]);

  const openCalendarAppointmentDetails = useCallback((schedule) => {
    setSelectedCalendarSchedule(schedule);
    setDetailActionError("");
    logDoctorAppointmentDetailDebug("opened", {
      scheduleId: schedule?.id || null,
      displayedAppointmentId: getVisibleAppointmentId(schedule),
      status: schedule?.status || null,
    });
  }, []);

  const closeCalendarAppointmentDetails = useCallback(() => {
    setSelectedCalendarSchedule(null);
    setDetailActionError("");

    // Remove the Dashboard target after closing so realtime refreshes
    // do not immediately reopen the same appointment.
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

  const updateFormValue = (field, value) => {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const resolveAppointmentDoctor = useCallback(async () => {
    if (hookAppointmentDoctor) {
      setAppointmentDoctorError(null);
      return hookAppointmentDoctor;
    }

    if (doctorIdentity?.loading) return null;

    setIsResolvingAppointmentDoctor(true);
    setAppointmentDoctorError(null);

    try {
      const refreshedIdentity =
        typeof doctorIdentity?.refresh === "function"
          ? await doctorIdentity.refresh()
          : await loadAuthenticatedDoctor();
      const resolvedDoctor = getAppointmentDoctorFromIdentity(refreshedIdentity);

      if (!resolvedDoctor) {
        throw new Error("Unable to load Doctor profile");
      }

      setRefreshedAppointmentDoctor(resolvedDoctor);

      return resolvedDoctor;
    } catch (error) {
      setRefreshedAppointmentDoctor(null);
      setAppointmentDoctorError(error);

      if (import.meta.env.DEV) {
        console.warn("[Doctor Appointment Flow] appointment Doctor identity error", {
          loading: false,
          error,
        });
      }

      return null;
    } finally {
      setIsResolvingAppointmentDoctor(false);
    }
  }, [doctorIdentity, hookAppointmentDoctor]);

  const openAddAppointment = useCallback(() => {
    if (isAdding) return;

    window.dispatchEvent(new CustomEvent("doctor:close-profile-menu"));
    setIsAdding(true);
    setStatusMessage("");
    setAppointmentDoctorError(null);

    if (hookAppointmentDoctor) {
      return;
    }

    resolveAppointmentDoctor();
  }, [hookAppointmentDoctor, isAdding, resolveAppointmentDoctor]);


  const selectPatient = (patient) => {
    updateFormValue("patient_name", patient.full_name || "");
    setStatusMessage("");
  };


  const moveWeek = (direction) => {
    const date = toCalendarDate(selectedDate) || new Date();
    selectCalendarDate(addDays(date, direction * 7));
  };

  const createAppointment = async (event) => {
    event.preventDefault();
    if (appointmentSaveLockRef.current) return;

    appointmentSaveLockRef.current = true;

    try {
    setStatusMessage("");

    const appointmentRange = buildThirtyMinuteAppointmentRange(
      form.appointment_date,
      form.appointment_time
    );

    if (!appointmentRange) {
      setStatusMessage("Choose a valid appointment date and time.");
      return;
    }

    const { startDate, endDate } = appointmentRange;

    if (startDate < new Date()) {
      setStatusMessage("New appointments cannot start in the past.");
      return;
    }

    if (!form.title.trim()) {
      setStatusMessage("Select an appointment type.");
      return;
    }

    if (!hasExactPatientMatch) {
      setStatusMessage("Select a patient from the search results before creating a schedule.");
      return;
    }

    const selectedPatient = patients.find(
      (patient) =>
        String(patient.full_name || "").trim().toLowerCase() ===
        form.patient_name.trim().toLowerCase()
    );

    if (!selectedPatient?.id) {
      setStatusMessage(
        "The selected patient could not be matched to a registered patient."
      );
      return;
    }

    const selectedDoctor = appointmentDoctor || (await resolveAppointmentDoctor());

    if (!selectedDoctor?.id || !selectedDoctor?.name) {
      setStatusMessage("Unable to load Doctor profile. Please try again.");
      return;
    }

    const payload = {
      patient_id: selectedPatient.id,
      doctor_id: selectedDoctor.id,
      patient_name: form.patient_name.trim(),
      doctor_name: selectedDoctor.name,
      title: form.title.trim(),
      description: form.description.trim() || null,
      start_time: startDate.toISOString(),
      end_time: endDate.toISOString(),
      status: "scheduled",
    };

    if (hasDuplicateAppointment(schedules, payload)) {
      setStatusMessage(
        "This patient already has an active appointment at the selected date and time."
      );
      return;
    }

    setIsSaving(true);

    const { data, error } = await supabase
      .from(scheduleTableName)
      .insert([payload])
      .select(scheduleColumns)
      .maybeSingle();

    if (error) {
      console.error("[Doctor Appointment Flow] appointment insert error:", {
        error,
        patientDatabaseId: selectedPatient.id,
        authenticatedDoctorId: selectedDoctor.id,
        profileId: selectedDoctor.profileId || null,
        startTime: payload.start_time,
      });
      setStatusMessage(
        `Appointment was not saved: ${getReadableScheduleError(error)}`
      );
      return;
    }

    const notificationResult = await sendAutomaticAppointmentNotification({
      patientId: data?.patient_id,
      scheduleId: data?.id,
      notificationType: "appointment_created",
    });

    if (data?.id) {
      const { error: reminderError } = await supabase
        .rpc("create_appointment_patient_reminder", {
          p_appointment_id: data.id,
        });

      if (reminderError) {
        console.warn("Doctor appointment reminder RPC failed:", {
          code: reminderError.code || null,
          message: reminderError.message || "Unknown Supabase error",
          details: reminderError.details || null,
          hint: reminderError.hint || null,
        });
      }
    }

    setSchedules((current) => (data ? [data, ...current] : current));
    setForm(initialAppointmentForm);
    setIsAdding(false);
    setActiveTab("All");
    selectCalendarDate(toDateInputValue(payload.start_time));
    setStatusMessage(
      notificationResult.ok
        ? "Appointment created and Patient notified."
        : "Appointment was saved, but the Patient notification could not be sent."
    );
    } finally {
      appointmentSaveLockRef.current = false;
      setIsSaving(false);
    }
  };

  const updateScheduleStatus = async (schedule, nextStatus, options = {}) => {
    setDetailActionError("");
    logDoctorAppointmentDetailDebug("status action requested", {
      scheduleId: schedule?.id || null,
      displayedAppointmentId: getVisibleAppointmentId(schedule),
      currentStatus: schedule?.status || null,
      selectedAction: options.actionLabel || nextStatus,
    });

    const mutationKey = `${schedule.id}:${nextStatus}`;
    if (appointmentStatusLockRef.current.has(mutationKey)) return false;

    appointmentStatusLockRef.current.add(mutationKey);
    setUpdatingStatusId(schedule.id);

    try {
      const { data, error } = await supabase
        .from(scheduleTableName)
        .update({ status: nextStatus })
        .eq("id", schedule.id)
        .select(scheduleColumns)
        .maybeSingle();

      if (error) {
        const message = getReadableScheduleError(error);
        logDoctorAppointmentDetailDebug("status update failed", {
          scheduleId: schedule.id,
          displayedAppointmentId: getVisibleAppointmentId(schedule),
          currentStatus: schedule.status,
          selectedAction: options.actionLabel || nextStatus,
          error,
        });
        setStatusMessage(message);
        setDetailActionError(message);
        if (!options.silentAlert) {
          alert(`Failed to update appointment status: ${message}`);
        }
        return false;
      }

      const updatedSchedule = data || { ...schedule, status: nextStatus };
      const notificationResult = options.notificationType
        ? await sendAutomaticAppointmentNotification({
            patientId: updatedSchedule.patient_id,
            scheduleId: updatedSchedule.id,
            notificationType: options.notificationType,
          })
        : null;

      setSchedules((current) =>
        current.map((item) => (item.id === schedule.id ? updatedSchedule : item))
      );
      setSelectedCalendarSchedule((current) =>
        current?.id === schedule.id ? updatedSchedule : current
      );

      const refreshResult = await loadAppointments();
      logDoctorAppointmentDetailDebug("status update succeeded", {
        scheduleId: schedule.id,
        displayedAppointmentId: getVisibleAppointmentId(updatedSchedule),
        currentStatus: updatedSchedule.status,
        selectedAction: options.actionLabel || nextStatus,
        refreshResult,
      });
      return { updatedSchedule, notificationResult };
    } finally {
      appointmentStatusLockRef.current.delete(mutationKey);
      setUpdatingStatusId("");
    }
  };

  const handleStatusSelect = (schedule, nextStatus) => {
    if (isClosedAppointmentStatus(schedule.status)) {
      setStatusMessage("Completed, cancelled, or missed appointments cannot be changed.");
      return;
    }

    if (
      isCheckedInAppointmentStatus(schedule.status) &&
      nextStatus !== appointmentStatuses.checkedIn
    ) {
      setStatusMessage("Open the checked-in appointment to complete its clinical visit.");
      return;
    }

    if (nextStatus === "scheduled") {
      return;
    }

    if (nextStatus === "checked_in") {
      if (isCheckedInAppointmentStatus(schedule.status)) {
        openVisitForm(schedule);
      } else {
        checkInAppointment(schedule);
      }
      return;
    }

    if (nextStatus === "cancelled") {
      setCancelConfirmationSchedule(schedule);
      return;
    }

    updateScheduleStatus(schedule, nextStatus);
  };

  const acceptPatientRequest = async (schedule) => {
    if (!schedule?.id || updatingStatusId === schedule.id) return;

    const details = parseScheduleDetails(schedule.description);
    setUpdatingStatusId(schedule.id);
    setDetailActionError("");

    const { data, error } = await supabase
      .from(scheduleTableName)
      .update({
        description: JSON.stringify({
          ...details,
          requestStatus: "accepted",
          reviewedAt: new Date().toISOString(),
          reviewedBy: authenticatedDoctorId || null,
        }),
      })
      .eq("id", schedule.id)
      .select(scheduleColumns)
      .single();

    setUpdatingStatusId("");

    if (error) {
      console.error("Patient appointment request acceptance failed:", error);
      setDetailActionError(`Unable to accept this request: ${getReadableScheduleError(error)}`);
      return;
    }

    setSchedules((current) =>
      current.map((item) => (item.id === schedule.id ? data : item))
    );
    setSelectedCalendarSchedule(null);
    setSelectedRequestSchedule(null);
    setStatusMessage("Appointment request accepted and moved to Pending appointments.");
    await loadAppointments();
  };

  const declinePatientRequest = async (schedule) => {
    if (!schedule?.id || updatingStatusId === schedule.id) return;

    const saved = await updateScheduleStatus(schedule, appointmentStatuses.cancelled, {
      actionLabel: "decline request",
      silentAlert: true,
      notificationType: "appointment_cancelled",
    });

    if (!saved) return;

    setSelectedRequestSchedule(null);
    setSelectedCalendarSchedule(null);
    setStatusMessage(
      saved.notificationResult?.ok
        ? "Appointment request declined and Patient notified."
        : "Appointment request declined. The Patient notification could not be sent."
    );
  };


  const startEditAppointment = (schedule) => {
    if (!schedule?.id || isClosedAppointmentStatus(schedule.status)) return;

    logDoctorAppointmentDetailDebug("edit requested", {
      scheduleId: schedule.id,
      displayedAppointmentId: getVisibleAppointmentId(schedule),
      currentStatus: schedule.status,
      selectedAction: "edit",
    });
    const currentTime = toTimeInputValue(schedule.start_time);

    setSelectedCalendarSchedule(null);
    setDetailActionError("");
    setRescheduleSchedule(schedule);
    setRescheduleForm({
      date: toDateInputValue(schedule.start_time),
      time: currentTime,
      message: schedule.description || "",
    });
    setRescheduleTimeDraft(getRescheduleTimeDraft(currentTime));
    setIsRescheduleTimePickerOpen(false);
  };

  const checkInAppointment = async (schedule) => {
    if (!schedule?.id || updatingStatusId === schedule.id) return;

    if (!isPendingAppointmentStatus(schedule.status)) {
      setDetailActionError("Only pending or scheduled appointments can be checked in.");
      return;
    }

    const saved = await updateScheduleStatus(schedule, "checked_in", {
      actionLabel: "check in",
      silentAlert: true,
    });

    if (saved) {
      setSelectedCalendarSchedule(null);
      setStatusMessage(
        "Appointment checked in successfully. Staff can now complete the pre-consultation before the Doctor completes the visit."
      );
    }
  };

  const openVisitForm = async (schedule) => {
    if (!schedule?.id || updatingStatusId === schedule.id || visitRoutingLockRef.current) return;

    if (!isCheckedInAppointmentStatus(schedule.status)) {
      setDetailActionError("Check in the appointment before opening the visit form.");
      return;
    }

    visitRoutingLockRef.current = schedule.id;

    try {
      const { data, error } = await supabase.rpc(
        "get_appointment_visit_form_type",
        { p_appointment_id: schedule.id }
      );

      if (error) {
        console.error("Doctor appointment visit-routing RPC failed:", {
          code: error.code || null,
          message: error.message || "Unknown Supabase error",
          details: error.details || null,
          hint: error.hint || null,
        });
        setStatusMessage(
          `The visit form could not be opened. ${getReadableSupabaseError(error)}`
        );
        return;
      }

      const routeResult = Array.isArray(data) ? data[0] : data;
      if (!routeResult?.visit_form_type) {
        setStatusMessage(
          "The visit-routing RPC returned no form type. Please retry."
        );
        return;
      }

      const routeSegment = routeResult.visit_form_type === "initial"
        ? "initial-visit"
        : "follow-up";

      setSelectedCalendarSchedule(null);
      navigate(`/doctor/appointments/${schedule.id}/${routeSegment}`);
    } finally {
      visitRoutingLockRef.current = "";
    }
  };

  const cancelDetailAppointment = async (schedule) => {
    if (!schedule?.id || updatingStatusId === schedule.id) return;

    if (isClosedAppointmentStatus(schedule.status)) {
      setDetailActionError("Completed or cancelled appointments cannot be cancelled.");
      return;
    }

    const confirmed = window.confirm("Are you sure you want to cancel this appointment?");
    if (!confirmed) return;

    const saved = await updateScheduleStatus(schedule, "cancelled", {
      actionLabel: "cancel",
      silentAlert: true,
      notificationType: "appointment_cancelled",
    });

    if (saved) {
      setSelectedCalendarSchedule(null);
      setStatusMessage(
        saved === true
          ? "Appointment cancelled."
          : saved.notificationResult?.ok
          ? "Appointment cancelled and Patient notified."
          : "Appointment was saved, but the Patient notification could not be sent."
      );
    }
  };

  const confirmCancelAppointment = async () => {
    if (!cancelConfirmationSchedule) return;

    const saved = await updateScheduleStatus(cancelConfirmationSchedule, "cancelled", {
      actionLabel: "cancel",
      notificationType: "appointment_cancelled",
    });

    if (saved) {
      setCancelConfirmationSchedule(null);
      setStatusMessage(
        saved === true
          ? "Appointment cancelled."
          : saved.notificationResult?.ok
          ? "Appointment cancelled and Patient notified."
          : "Appointment was saved, but the Patient notification could not be sent."
      );
    }
  };

  const startRescheduleAppointment = () => {
    if (!cancelConfirmationSchedule) return;

    const currentTime = toTimeInputValue(cancelConfirmationSchedule.start_time);

    setRescheduleSchedule(cancelConfirmationSchedule);
    setRescheduleForm({
      date: toDateInputValue(cancelConfirmationSchedule.start_time),
      time: currentTime,
      message: cancelConfirmationSchedule.description || "",
    });
    setRescheduleTimeDraft(getRescheduleTimeDraft(currentTime));
    setIsRescheduleTimePickerOpen(false);
    setCancelConfirmationSchedule(null);
  };

  const openRescheduleTimePicker = () => {
    setRescheduleTimeDraft(getRescheduleTimeDraft(rescheduleForm.time));
    setIsRescheduleTimePickerOpen(true);
  };

  const applyRescheduleTime = () => {
    const nextTime = getRescheduleTimeValue(rescheduleTimeDraft);
    if (!nextTime) return;

    setRescheduleForm((current) => ({ ...current, time: nextTime }));
    setIsRescheduleTimePickerOpen(false);
  };

  const closeRescheduleModal = () => {
    setRescheduleSchedule(null);
    setRescheduleForm(initialRescheduleForm);
    setRescheduleTimeDraft(initialRescheduleTimeDraft);
    setIsRescheduleTimePickerOpen(false);
  };

  const saveRescheduleAppointment = async (event) => {
    event.preventDefault();

    if (!rescheduleSchedule || rescheduleSaveLockRef.current) return;

    rescheduleSaveLockRef.current = true;

    try {

    const appointmentRange = buildThirtyMinuteAppointmentRange(
      rescheduleForm.date,
      rescheduleForm.time
    );

    if (!appointmentRange) {
      setStatusMessage("Choose a valid reschedule date and time.");
      return;
    }

    const { startDate, endDate } = appointmentRange;

    if (startDate < new Date()) {
      setStatusMessage("Rescheduled appointments cannot start in the past.");
      return;
    }

    const payload = {
      start_time: startDate.toISOString(),
      end_time: endDate.toISOString(),
      description: rescheduleForm.message.trim() || null,
      status: "scheduled",
    };

    if (
      hasDuplicateAppointment(schedules, {
        ...payload,
        id: rescheduleSchedule.id,
        patient_id: rescheduleSchedule.patient_id,
      })
    ) {
      setStatusMessage("This appointment conflicts with another active appointment.");
      return;
    }

    setUpdatingStatusId(rescheduleSchedule.id);

    const { data, error } = await supabase
      .from(scheduleTableName)
      .update(payload)
      .eq("id", rescheduleSchedule.id)
      .select(scheduleColumns)
      .maybeSingle();

    if (error) {
      const message = getReadableScheduleError(error);
      setStatusMessage(message);
      alert(`Failed to reschedule appointment: ${message}`);
      return;
    }

    const updatedSchedule = data || { ...rescheduleSchedule, ...payload };
    const notificationResult = await sendAutomaticAppointmentNotification({
      patientId: updatedSchedule.patient_id,
      scheduleId: updatedSchedule.id,
      notificationType: "appointment_rescheduled",
    });
    setSchedules((current) =>
      current.map((item) => (item.id === rescheduleSchedule.id ? updatedSchedule : item))
    );
    setSelectedCalendarSchedule((current) =>
      current?.id === rescheduleSchedule.id ? updatedSchedule : current
    );
    selectCalendarDate(toDateInputValue(startDate));
    const refreshResult = await loadAppointments();
    logDoctorAppointmentDetailDebug("edit saved", {
      scheduleId: rescheduleSchedule.id,
      displayedAppointmentId: getVisibleAppointmentId(updatedSchedule),
      currentStatus: updatedSchedule.status,
      selectedAction: "edit",
      refreshResult,
    });
    closeRescheduleModal();
    setStatusMessage(
      notificationResult.ok
        ? "Appointment rescheduled and Patient notified."
        : "Appointment was saved, but the Patient notification could not be sent."
    );
    } finally {
      rescheduleSaveLockRef.current = false;
      setUpdatingStatusId("");
    }
  };

  if (visitRoute) {
    return (
      <AppointmentVisitForm
        appointmentId={visitRoute.appointmentId}
        requestedType={visitRoute.requestedType}
        workspace="doctor"
      />
    );
  }

  if (selectedRequestSchedule) {
    const requestPatient = patients.find(
      (patient) => String(patient.id) === String(selectedRequestSchedule.patient_id)
    ) || null;

    return (
      <main
        className={`doctor-appointments-page doctor-request-details-shell appointment-workspace appointment-workspace--doctor${embedded ? " doctor-appointments-page--embedded" : ""}`}
      >
        <DoctorAppointmentRequestDetails
          schedule={selectedRequestSchedule}
          patient={requestPatient}
          isUpdating={updatingStatusId === selectedRequestSchedule.id}
          actionError={detailActionError}
          onBack={() => {
            setDetailActionError("");
            setSelectedRequestSchedule(null);
            setActiveTab("Requests");
          }}
          onApprove={acceptPatientRequest}
          onDecline={declinePatientRequest}
        />
      </main>
    );
  }

  return (
    <main
      className={`doctor-appointments-page appointment-workspace appointment-workspace--doctor${embedded ? " doctor-appointments-page--embedded" : ""}`}
      style={{ "--doctor-request-count": `"${requestSchedules.length}"` }}
    >
      <AppointmentPageHeader
        title="Appointments"
        subtitle="Manage scheduling, arrivals, and appointment status."
        tabs={appointmentTabs}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        action={headerAction || <DefaultProfileCard doctorIdentity={doctorIdentity} />}
        className="doctor-appointments-header"
        titleBlockClassName="doctor-appointments-title-block"
        tabsClassName="doctor-appointments-tabs"
      />

      {statusMessage ? (
        <p className="doctor-appointments-status-message" role="status">
          {statusMessage}
        </p>
      ) : null}

      {activeTab === "Requests" ? (
        <DoctorAppointmentRequests
          requests={paginatedRequests}
          totalRequests={requestSchedules.length}
          currentPage={requestDisplayedPage}
          totalPages={requestTotalPages}
          searchTerm={searchTerm}
          sortOrder={requestSort}
          patients={patients}
          miniMonthDate={miniMonthDate}
          miniMonthDays={miniMonthDays}
          todaySchedules={todaySchedules}
          onSearchChange={(value) => {
            setSearchTerm(value);
            setCurrentPage(1);
          }}
          onSortChange={(value) => {
            setRequestSort(value);
            setCurrentPage(1);
          }}
          onPageChange={setCurrentPage}
          onMonthChange={(amount) => setMiniMonthDate((current) => addMonths(current, amount))}
          onSelectDate={selectCalendarDate}
          onViewRequest={(schedule) => {
            setDetailActionError("");
            setSelectedRequestSchedule(schedule);
          }}
          onViewSchedule={openCalendarAppointmentDetails}
        />
      ) : (
        <>
      <AppointmentToolbar className="doctor-appointments-action-row doctor-appointments-toolbar doctor-appointments-toolbar-labeled">
        <AppointmentControlGroup
          label="View"
          area="view"
          className="doctor-appointments-control-group doctor-appointments-view-group"
        >
          <AppointmentViewSwitch
            options={appointmentViews}
            value={appointmentView}
            onChange={setAppointmentView}
            className="doctor-appointments-view-switch"
          />
        </AppointmentControlGroup>

        <AppointmentControlGroup
          label="Search Appointments"
          area="search"
          className="doctor-appointments-control-group doctor-appointments-search-group"
        >
          <form
            className="doctor-appointments-search"
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <label className="appointment-ui-search">
              <InlineIcon name="search" />
              <input
                type="search"
                placeholder="Search Appointment, Patient, or ID"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
              />
            </label>
          </form>
        </AppointmentControlGroup>

        <AppointmentControlGroup
          as="label"
          label="Filter by Month"
          area="month"
          className="doctor-appointments-month-filter doctor-appointments-control-group"
        >
          <div className="doctor-appointments-month-input appointment-ui-month">
            <Icon icon="solar:calendar-linear" />
            <input
              type="month"
              value={monthFilter}
              onChange={(event) => setMonthFilter(event.target.value)}
              aria-label="Filter appointments by month"
            />
            {monthFilter ? (
              <button
                type="button"
                className="doctor-appointments-month-clear"
                aria-label="Clear month filter"
                title="Clear month filter"
                onClick={() => setMonthFilter("")}
              >
                <Icon icon="material-symbols:close-rounded" />
              </button>
            ) : null}
          </div>
        </AppointmentControlGroup>

        <AppointmentControlGroup
          label="Quick Action"
          area="action"
          className="doctor-appointments-control-group doctor-appointments-action-group"
        >
          <button
            className="doctor-appointments-add appointment-ui-primary"
            type="button"
            onClick={openAddAppointment}
          >
            <InlineIcon name="plus" />
            <span>Add Appointment</span>
          </button>
        </AppointmentControlGroup>
      </AppointmentToolbar>

      <DoctorAppointmentSummary summary={appointmentSummary} />

      <section
        className="doctor-appointments-table-card appointment-ui-table-card"
        aria-label="Appointments"
      >
        <div className="doctor-appointments-table-x-scroll">
          <div className="doctor-appointments-table-inner">
            <div className="doctor-appointments-table__head">
              <span>Appointment ID</span>
              <span>Name</span>
              <span>Date</span>
              <span>Time</span>
              <span>Status</span>
            </div>

            <div
              className="doctor-appointments-table-scroll appointment-ui-table-scroll"
              ref={tableScrollRef}
            >
              {paginatedSchedules.length > 0 ? (
                paginatedSchedules.map((schedule) => (
                  <div className="doctor-appointments-row" key={schedule.id}>
                    <span>
                      {schedule.maternal_appointment_id || "MA ID not assigned"}
                    </span>
                    <span>{schedule.patient_name || "-"}</span>
                    <span>{formatTableDate(schedule.start_time)}</span>
                    <span>{formatTime(schedule.start_time)}</span>
                    <StatusDropdown
                      schedule={schedule}
                      updatingStatusId={updatingStatusId}
                      onStatusSelect={handleStatusSelect}
                    />
                  </div>
                ))
              ) : (
                <div className="doctor-appointments-empty">No appointments found.</div>
              )}
            </div>
          </div>
        </div>

        <AppointmentPagination
          className="doctor-appointments-pagination"
          currentPage={displayedPage}
          pageSize={pageSize}
          pageSizes={appointmentPageSizes}
          totalItems={visibleSchedules.length}
          totalPages={totalPages}
          onPageChange={setCurrentPage}
          onPageSizeChange={setPageSize}
        />
      </section>


      <section className="doctor-calendar-layout">
        <FigmaWeekCalendar
          schedules={schedules}
          selectedDate={selectedDate}
          onSelectDate={selectCalendarDate}
          onPreviousWeek={() => moveWeek(-1)}
          onNextWeek={() => moveWeek(1)}
          onSelectSchedule={openCalendarAppointmentDetails}
        />

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

          <section className="doctor-categories-card" aria-label="Appointment categories">
            <h3>Categories</h3>

            <div className="doctor-category-grid">
              {APPOINTMENT_CATEGORIES.map((category) => (
                <div
                  className={`doctor-category-item ${category.colorClass}`}
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
      </section>
        </>
      )}

      {isAdding
        ? createPortal(
            <div className="appointment-modal-overlay" role="dialog" aria-modal="true">
              <section className="appointment-form-card appointment-add-card">
                <button
                  className="appointment-modal-close"
                  type="button"
                  aria-label="Close add appointment form"
                  onClick={() => {
                    setIsAdding(false);
                    setStatusMessage("");
                  }}
                >
                  <InlineIcon name="close" />
                </button>

                <div className="appointment-form-heading">
                  <h2>Add New Appointment</h2>
                </div>

                <form className="appointment-form-grid" onSubmit={createAppointment}>
                  <label className="appointment-form-field appointment-form-field--wide">
                    <span>
                      Patient Name:
                    </span>

                    <div className="appointment-patient-search">
                      <input
                        type="search"
                        placeholder={isLoadingPatients ? "Loading patients..." : "Enter patient name"}
                        value={form.patient_name}
                        onChange={(event) => updateFormValue("patient_name", event.target.value)}
                        required
                      />

                      {matchingPatients.length > 0 && !hasExactPatientMatch ? (
                        <div className="appointment-patient-results">
                          {matchingPatients.map((patient) => (
                            <button key={patient.id} type="button" onClick={() => selectPatient(patient)}>
                              <strong>{patient.full_name}</strong>
                              <small>{patient.contact_number || "No contact number"}</small>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </label>

                  <label className="appointment-form-field appointment-form-field--wide">
                    <span>Doctor:</span>
                    <input
                      type="text"
                      value={
                        isAppointmentDoctorLoading
                          ? "Loading Doctor profile..."
                          : visibleAppointmentDoctorError
                            ? "Unable to load Doctor profile"
                            : appointmentDoctor?.name || "Loading Doctor profile..."
                      }
                      readOnly
                    />
                  </label>

                  <label className="appointment-form-field">
                    <span>
                      Select Date:
                    </span>
                    <input
                      type="date"
                      value={form.appointment_date}
                      onChange={(event) => updateFormValue("appointment_date", event.target.value)}
                      required
                    />
                  </label>

                  <div className="appointment-form-field">
                    <span id="doctor-add-appointment-time-label">
                      Select Time:
                    </span>
                    <AppointmentTimePicker
                      id="doctor-add-appointment-time"
                      labelId="doctor-add-appointment-time-label"
                      value={form.appointment_time}
                      onChange={(value) => updateFormValue("appointment_time", value)}
                      required
                    />
                  </div>

                  <label className="appointment-form-field appointment-form-field--wide">
                    <span>
                      Select Type:
                    </span>
                    <select
                      value={form.title}
                      onChange={(event) => updateFormValue("title", event.target.value)}
                      required
                    >
                      <option value="" disabled>
                        Select appointment type
                      </option>
                      {APPOINTMENT_TYPES.map((appointmentType) => (
                        <option key={appointmentType} value={appointmentType}>
                          {appointmentType}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="appointment-form-field appointment-form-field--wide">
                    <span>
                      Message:
                    </span>
                    <textarea
                      rows="3"
                      placeholder="Add additional details..."
                      value={form.description}
                      onChange={(event) => updateFormValue("description", event.target.value)}
                    />
                  </label>

                  {visibleAppointmentDoctorError ? (
                    <p className="appointment-form-message">
                      {visibleAppointmentDoctorError.message ||
                        "Unable to load Doctor profile. Please try again."}
                    </p>
                  ) : null}

                  {statusMessage ? <p className="appointment-form-message">{statusMessage}</p> : null}

                  <div className="appointment-form-actions">
                    <button
                      className="appointment-add-save"
                      type="submit"
                      disabled={
                        isSaving ||
                        !isAddAppointmentReady
                      }
                    >
                      {isSaving ? "Saving..." : "Save"}
                    </button>
                    <button
                      className="appointment-form-cancel appointment-add-cancel"
                      type="button"
                      onClick={() => {
                        setIsAdding(false);
                        setStatusMessage("");
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </section>
            </div>,
            document.body
          )
        : null}

      {selectedCalendarSchedule ? (
        <DoctorAppointmentDetailsModal
          schedule={selectedCalendarSchedule}
          actionError={detailActionError}
          isUpdating={updatingStatusId === selectedCalendarSchedule.id}
          onClose={closeCalendarAppointmentDetails}
          onEdit={startEditAppointment}
          onAcceptRequest={acceptPatientRequest}
          onCheckIn={checkInAppointment}
          onComplete={openVisitForm}
          onCancel={cancelDetailAppointment}
        />
      ) : null}

      
      {cancelConfirmationSchedule
        ? createPortal(
            <div className="doctor-appointment-confirm-overlay" role="dialog" aria-modal="true">
              <section className="doctor-appointment-confirm-card">
                <h2>Cancel Appointment</h2>
                <p>Are you sure you want to cancel this appointment?</p>

                <div className="doctor-appointment-confirm-actions">
                  <button type="button" onClick={confirmCancelAppointment}>
                    Yes, Cancel it
                  </button>
                  <button type="button" onClick={startRescheduleAppointment}>
                    Reschedule it
                  </button>
                </div>
              </section>
            </div>,
            document.body
          )
        : null}
      {rescheduleSchedule
        ? createPortal(
            <div className="doctor-appointment-confirm-overlay" role="dialog" aria-modal="true">
              <section className="doctor-appointment-reschedule-card">
                <h2>Reschedule Appointment</h2>

                <form onSubmit={saveRescheduleAppointment}>
                  <label>
                    Select Date:
                    <input
                      type="date"
                      value={rescheduleForm.date}
                      onChange={(event) =>
                        setRescheduleForm((current) => ({ ...current, date: event.target.value }))
                      }
                      required
                    />
                  </label>

                  <div className="doctor-reschedule-time-field">
                    <span className="doctor-reschedule-time-label">Select Time:</span>

                    <button
                      type="button"
                      className="doctor-reschedule-time-trigger"
                      aria-expanded={isRescheduleTimePickerOpen}
                      aria-controls="doctor-reschedule-time-picker"
                      onClick={() =>
                        isRescheduleTimePickerOpen
                          ? setIsRescheduleTimePickerOpen(false)
                          : openRescheduleTimePicker()
                      }
                    >
                      <span
                        className={`doctor-reschedule-time-value ${
                          rescheduleForm.time ? "" : "is-placeholder"
                        }`}
                      >
                        {formatRescheduleTime(rescheduleForm.time)}
                      </span>

                      <span className="doctor-reschedule-time-action">
                        <InlineIcon name="clock" />
                        Choose Time
                      </span>
                    </button>

                    {isRescheduleTimePickerOpen ? (
                      <div
                        id="doctor-reschedule-time-picker"
                        className="doctor-reschedule-time-picker"
                        role="group"
                        aria-label="Choose appointment time"
                      >
                        <div className="doctor-reschedule-time-picker-grid">
                          <label>
                            <span>Hour</span>
                            <select
                              value={rescheduleTimeDraft.hour}
                              onChange={(event) =>
                                setRescheduleTimeDraft((current) => ({
                                  ...current,
                                  hour: event.target.value,
                                }))
                              }
                            >
                              {Array.from({ length: 12 }, (_, index) => {
                                const value = String(index + 1).padStart(2, "0");
                                return <option key={value} value={value}>{value}</option>;
                              })}
                            </select>
                          </label>

                          <label>
                            <span>Minute</span>
                            <select
                              value={rescheduleTimeDraft.minute}
                              onChange={(event) =>
                                setRescheduleTimeDraft((current) => ({
                                  ...current,
                                  minute: event.target.value,
                                }))
                              }
                            >
                              {Array.from({ length: 60 }, (_, index) => {
                                const value = String(index).padStart(2, "0");
                                return <option key={value} value={value}>{value}</option>;
                              })}
                            </select>
                          </label>

                          <label>
                            <span>Period</span>
                            <select
                              value={rescheduleTimeDraft.period}
                              onChange={(event) =>
                                setRescheduleTimeDraft((current) => ({
                                  ...current,
                                  period: event.target.value,
                                }))
                              }
                            >
                              <option value="AM">AM</option>
                              <option value="PM">PM</option>
                            </select>
                          </label>
                        </div>

                        <div className="doctor-reschedule-time-picker-actions">
                          <button
                            type="button"
                            className="doctor-reschedule-time-set"
                            onClick={applyRescheduleTime}
                          >
                            Set Time
                          </button>
                          <button
                            type="button"
                            className="doctor-reschedule-time-close"
                            onClick={() => setIsRescheduleTimePickerOpen(false)}
                          >
                            Close
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <label>
                    Message:
                    <input
                      type="text"
                      value={rescheduleForm.message}
                      onChange={(event) =>
                        setRescheduleForm((current) => ({ ...current, message: event.target.value }))
                      }
                    />
                  </label>

                  <div className="doctor-appointment-reschedule-actions">
                    <button
                      className="doctor-appointment-reschedule-save"
                      type="submit"
                      disabled={updatingStatusId === rescheduleSchedule.id}
                    >
                      {updatingStatusId === rescheduleSchedule.id ? "Saving..." : "Save"}
                    </button>
                    <button
                      className="doctor-appointment-reschedule-cancel"
                      type="button"
                      onClick={closeRescheduleModal}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </section>
            </div>,
            document.body
          )
        : null}
    </main>
  );
}
