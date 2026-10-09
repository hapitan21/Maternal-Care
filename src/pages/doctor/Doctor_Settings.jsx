import React from "react";
import { rememberDoctorSettingsDialogTrigger, useDoctorSettingsDialog } from "../../hooks/useDoctorSettingsDialog";
import { DoctorSignOutContext } from "../../context/roleInactivityContext";
import { createAuthenticatedMutation, requireFullOtp } from "../../lib/authenticatedMutation";
import { getLogicalSessionIdentity } from "../../lib/roleInactivity";
import { doctorSettingsFields, parseDoctorCalendarDate, saveDoctorSettingsSection, validateDoctorSettingsDraft } from "../../lib/doctorSettingsData";

import PasswordSecurityFeedback from "../../components/common/PasswordSecurityFeedback";
import { supabase } from "../../lib/supabaseClient";
import { loadAuthenticatedDoctor } from "../../hooks/useAuthenticatedDoctor";
import {
  getPasswordValidationMessage,
  PASSWORD_MIN_LENGTH,
  passwordsMatch,
  validatePassword,
} from "../../lib/passwordSecurity";
import {
  availabilityDayNames,
  getAvailabilityDayIndex,
} from "../../lib/availabilitySchedule";
import "../../styles/doctor-settings.css";

const defaultDoctorSettings = {
  displayName: "",
  email: "",
  role: "doctor",
  gender: "",
  birthdate: "",
  nationality: "",
  civilStatus: "",
  yearsExperience: "",
  doctorId: "",
  licenseNumber: "",
  boardCertification: "",
  clinicName: "",
  clinicAddress: "",
  contactNumber: "",
  accountStatus: "Active",
  emailVerification: "Verified",
  lastLogin: "Not available",
  avatarUrl: "",
  availability: [],
};

const availabilityDayOptions = [
  ...availabilityDayNames.slice(1),
  availabilityDayNames[0],
];

function formatRoleLabel(role) {
  const normalizedRole = String(role || "doctor").trim().toLowerCase();

  if (normalizedRole === "admin") {
    return "Admin";
  }

  if (normalizedRole === "staff") {
    return "Staff";
  }

  if (normalizedRole === "patient") {
    return "Patient";
  }

  return "Doctor";
}

function formatDateForDisplay(value) {
  if (!value) {
    return "";
  }

  const isoMatch = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
    try { parseDoctorCalendarDate(value); } catch { return String(value); }

    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(date);
  }

  return String(value);
}

function formatYearsExperience(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) {
    return String(value);
  }

  return `${numberValue} ${numberValue === 1 ? "Year" : "Years"}`;
}

function formatDatabaseTime(value) {
  if (!value) {
    return "";
  }

  const [hourText = "0", minuteText = "0"] = String(value).split(":");
  let hour = Number(hourText);
  const minute = Number(minuteText);
  const period = hour >= 12 ? "PM" : "AM";

  hour %= 12;

  if (hour === 0) {
    hour = 12;
  }

  return `${hour}:${String(minute).padStart(2, "0")} ${period}`;
}

function parseDisplayTime(value) {
  const normalizedValue = String(value || "").trim();
  const match = normalizedValue.match(
    /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i
  );

  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const period = match[3].toUpperCase();

  if (
    hour < 1 ||
    hour > 12 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  if (period === "AM" && hour === 12) {
    hour = 0;
  } else if (period === "PM" && hour !== 12) {
    hour += 12;
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(
    2,
    "0"
  )}:00`;
}

function parseScheduleTimeRange(value) {
  const parts = String(value || "")
    .split(/\s+-\s+/)
    .map((part) => part.trim());

  if (parts.length !== 2) {
    return null;
  }

  const startTime = parseDisplayTime(parts[0]);
  const endTime = parseDisplayTime(parts[1]);

  if (!startTime || !endTime || endTime <= startTime) {
    return null;
  }

  return {
    startTime,
    endTime,
  };
}

function mapAvailabilityRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const day = availabilityDayNames[Number(row.day_of_week)];

      if (!day) {
        return null;
      }

      if (!row.is_available) {
        return {
          day,
          time: "No appointments scheduled",
          status: "Closed",
        };
      }

      const startTime = formatDatabaseTime(row.start_time);
      const endTime = formatDatabaseTime(row.end_time);

      return {
        day,
        time:
          startTime && endTime
            ? `${startTime} - ${endTime}`
            : "Time not configured",
        status: "Available",
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) =>
        availabilityDayOptions.indexOf(left.day) -
        availabilityDayOptions.indexOf(right.day)
    );
}

function formatLastLogin(value) {
  if (!value) {
    return "Not available";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Not available";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}


function createDoctorSettingsSnapshot(
  doctorIdentity,
  availability = []
) {
  const authUser = doctorIdentity?.authUser || {};
  const profile = doctorIdentity?.profile || {};
  const personal = doctorIdentity?.personalInformation || {};
  const professional = doctorIdentity?.professionalInformation || {};

  return {
    ...defaultDoctorSettings,

    displayName:
      Object.hasOwn(personal, "full_name") ? personal.full_name ?? ""
        : profile.full_name ?? doctorIdentity?.doctorDisplayName ?? "",

    email:
      authUser.email ||
      professional.email_address ||
      profile.email ||
      "",

    role: profile.role || doctorIdentity?.role || "doctor",

    gender: personal.gender || "",

    birthdate:
      formatDateForDisplay(personal.birthdate) || "",

    nationality: personal.nationality || "",

    civilStatus: personal.civil_status || "",

    yearsExperience:
      formatYearsExperience(personal.years_of_experience) || "",

    doctorId: professional.doctor_code || "",

    licenseNumber: professional.license_number || "",

    boardCertification: professional.board_certification || "",

    clinicName: professional.clinic_hospital_name || "",

    clinicAddress: professional.clinic_address || "",

    contactNumber:
      Object.hasOwn(professional, "contact_number") ? professional.contact_number ?? ""
        : profile.contact_number ?? doctorIdentity?.doctorContactNumber ?? "",

    accountStatus:
      profile.account_status ||
      defaultDoctorSettings.accountStatus,

    avatarUrl:
      doctorIdentity?.avatarUrl ||
      profile.avatar_url ||
      "",

    emailVerification:
      authUser.email_confirmed_at
        ? "Verified"
        : authUser.id
          ? "Pending"
          : defaultDoctorSettings.emailVerification,

    lastLogin:
      authUser.id
        ? formatLastLogin(authUser.last_sign_in_at)
        : defaultDoctorSettings.lastLogin,

    availability: Array.isArray(availability)
      ? availability
      : [],
  };
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
    calendarEdit: (
      <>
        <rect x="4.5" y="6.5" width="15" height="13.5" rx="2" />
        <path d="M8 4v4M16 4v4M4.5 10.5h15" />
        <path d="m13.5 17.4 3.8-3.8 1.2 1.2-3.8 3.8-1.6.4.4-1.6Z" />
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
    account: (
      <>
        <circle cx="9" cy="8.5" r="3" />
        <path d="M4 19a5 5 0 0 1 10 0" />
        <path d="M16.5 11.5v5M14 14h5" />
      </>
    ),
    pencil: (
      <>
        <path d="M4.5 19.5 8 18.8 18.6 8.2a2.1 2.1 0 0 0-3-3L5 15.8l-.5 3.7Z" />
        <path d="m14.2 6.6 3.2 3.2" />
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
    key: (
      <>
        <circle cx="8.5" cy="12" r="3.5" />
        <path d="M12 12h8M17 12v-2M20 12v3" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 11.5v4.5M12 8h.01" />
      </>
    ),
    checkCircle: (
      <>
        <circle cx="12" cy="12" r="8" fill="currentColor" stroke="none" />
        <path d="m8.8 12.2 2.1 2.1 4.4-4.6" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
    noEntry: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="m7.8 7.8 8.4 8.4" />
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
    <svg
      className="doctor-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {icons[name]}
    </svg>
  );
}


function SettingsHeaderAction({ settings }) {
  const initials = (settings.displayName || "KV")
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <button
      className="doctor-settings-top-profile"
      type="button"
      aria-label="Open profile menu"
    >
      {settings.avatarUrl ? (
        <img src={settings.avatarUrl} alt={settings.displayName} />
      ) : (
        <span className="doctor-settings-top-profile-avatar">{initials}</span>
      )}
      <span className="doctor-settings-top-profile-copy">
        <strong>{settings.displayName}</strong>
        <small>{formatRoleLabel(settings.role)}</small>
      </span>
      <DoctorIcon name="chevronDown" />
    </button>
  );
}

const settingsSections = [
  { id: "profile", label: "Profile", icon: "profile" },
  { id: "account", label: "Account", icon: "account" },
  { id: "security", label: "Password & Security", icon: "lock" },
  { id: "availability", label: "Schedule Availability", icon: "calendar" },
];

const OTP_COOLDOWN_SECONDS = 60;
const SETTINGS_TOAST_DURATION_MS = 4000;
const CHANGE_EMAIL_INITIAL_STATE = {
  isOpen: false,
  step: "details",
  currentPassword: "",
  currentEmail: "",
  newEmail: "",
  currentEmailOtp: "",
  newEmailOtp: "",
  pendingEmail: "",
  isLoading: false,
  error: "",
  success: "",
  currentEmailVerified: false,
  newEmailVerified: false,
  currentOtpCooldown: 0,
  newOtpCooldown: 0,
};
const CHANGE_PASSWORD_INITIAL_STATE = {
  isOpen: false,
  step: "otp",
  currentEmail: "",
  otp: "",
  pendingNewPassword: "",
  isLoading: false,
  loadingLabel: "",
  error: "",
  success: "",
  otpCooldown: 0,
};

function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? "").trim());
}

function normalizeOtp(value) {
  return String(value ?? "").replace(/\D/g, "").slice(0, 6);
}

function getFriendlyAuthError(error) {
  if (["invalid_otp", "auth_request_timeout", "request_pending", "mutation_cancelled"].includes(error?.code)) return error.message;
  const message = String(error?.message || "").toLowerCase();
  const status = error?.status;

  if (message.includes("invalid login credentials")) {
    return "The current password is incorrect.";
  }

  if (
    message.includes("already registered") ||
    message.includes("already been registered") ||
    message.includes("user already registered") ||
    message.includes("email address already")
  ) {
    return "That email is already used by another account.";
  }

  if (
    message.includes("invalid") &&
    (message.includes("email") || message.includes("otp") || message.includes("token"))
  ) {
    return "The OTP is invalid or expired. Click Send OTP again and use the newest code.";
  }

  if (message.includes("expired") || message.includes("token has expired")) {
    return "The OTP has expired. Click Send OTP again and use the newest code.";
  }

  if (
    status === 429 ||
    message.includes("rate limit") ||
    message.includes("too many") ||
    message.includes("over_request_rate_limit")
  ) {
    return "Too many attempts. Please wait before trying again.";
  }

  return "The request could not be completed. Please try again.";
}

function DoctorSettingsContent({ headerAction = null, doctorIdentity = null }) {
  const requestDoctorSignOut = React.useContext(DoctorSignOutContext);
  const [activePanel, setActivePanel] = React.useState("profile");
  const [editingProfileCards, setEditingProfileCards] = React.useState({
    personal: false,
    professional: false,
  });
  const [settings, setSettings] = React.useState(() =>
    createDoctorSettingsSnapshot(doctorIdentity, [])
  );
  const canonicalRef = React.useRef(settings);
  const [drafts, setDrafts] = React.useState({ personal: {}, professional: {}, account: {} });
  const draftsRef = React.useRef({ personal: {}, professional: {}, account: {} });
  const partialSectionsRef = React.useRef(new Set());
  const availabilityWriteRevisionRef = React.useRef(0);
  const settingsLoadRef = React.useRef(null);
  const [availabilityOwner, setAvailabilityOwner] = React.useState(null);
  const [availabilitySession, setAvailabilitySession] = React.useState("");
  const [fieldErrors, setFieldErrors] = React.useState({ personal: {}, professional: {}, account: {} });
  const [loadError, setLoadError] = React.useState("");
  const [loadRevision, setLoadRevision] = React.useState(0);
  const [message, setMessage] = React.useState("");
  const [toast, setToast] = React.useState(null);
  const [passwordFieldError, setPasswordFieldError] = React.useState("");
  const [scheduleFieldError, setScheduleFieldError] = React.useState("");
  const [passwordForm, setPasswordForm] = React.useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [passwordVisible, setPasswordVisible] = React.useState({
    currentPassword: false,
    newPassword: false,
    confirmPassword: false,
  });
  const [confirmPasswordInteracted, setConfirmPasswordInteracted] =
    React.useState(false);
  const [scheduleDraft, setScheduleDraft] = React.useState(null);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const [availabilityError, setAvailabilityError] = React.useState("");
  const [changeEmailState, setChangeEmailState] = React.useState(
    CHANGE_EMAIL_INITIAL_STATE
  );
  const [changePasswordOtp, setChangePasswordOtp] = React.useState(
    CHANGE_PASSWORD_INITIAL_STATE
  );
  const emailDialogTriggerRef = React.useRef(null);
  const passwordDialogTriggerRef = React.useRef(null);
  const scheduleDialogTriggerRef = React.useRef(null);
  const toastTimerRef = React.useRef(null);
  const toastVersionRef = React.useRef(0);
  const mountedRef = React.useRef(false);
  const abortRef = React.useRef(null);
  const mutationOwnerRef = React.useRef(null);
  const operationRef = React.useRef(null);
  const scopesRef = React.useRef(new Set());
  const emailFlowRef = React.useRef(null);
  const passwordFlowRef = React.useRef(null);
  const deferredTimersRef = React.useRef(new Set());
  const [authRevision, setAuthRevision] = React.useState(0);

  const runSecurityAction = async (action, onError, owner = mutationOwnerRef.current) => {
    if (operationRef.current || !owner || !mountedRef.current) return;
    const operation = {};
    operationRef.current = operation;
    setIsSaving(true);
    let scope;
    const isCurrent = () => mountedRef.current && mutationOwnerRef.current === owner;
    try {
      scope = await createAuthenticatedMutation(supabase, {
        signal: abortRef.current?.signal,
        expectedUserId: owner.userId, expectedIdentity: owner.identity, isCurrent,
      });
      scopesRef.current.add(scope);
      await action(scope);
    } catch (error) {
      operation.timedOut = error.code === "auth_request_timeout";
      if (isCurrent()) onError(error);
    } finally {
      if (isCurrent()) setIsSaving(false);
      const release = () => {
        scope?.dispose();
        scopesRef.current.delete(scope);
        if (operationRef.current === operation) operationRef.current = null;
      };
      if (scope && operation.timedOut && isCurrent()) void scope.whenIdle().then(release);
      else release();
    }
  };

  React.useEffect(() => {
    mountedRef.current = true;
    const abortController = new AbortController();
    abortRef.current = abortController;
    const scopes = scopesRef.current;
    const deferredTimers = deferredTimersRef.current;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      const owner = mutationOwnerRef.current;
      const identity = getLogicalSessionIdentity(session);
      const loadingIdentity = settingsLoadRef.current?.identity;
      if ((owner && identity !== owner.identity) || (loadingIdentity && identity !== loadingIdentity)) {
        settingsLoadRef.current = null;
        setAvailabilityOwner(null);
        setAvailabilitySession("");
        mutationOwnerRef.current = null;
        operationRef.current = null;
        canonicalRef.current = defaultDoctorSettings;
        draftsRef.current = { personal: {}, professional: {}, account: {} };
        partialSectionsRef.current.clear();
        setDrafts(draftsRef.current);
        setFieldErrors({ personal: {}, professional: {}, account: {} });
        setScheduleDraft(null);
        setScheduleFieldError("");
        setAvailabilityError("");
        setMessage("");
        setLoadError("");
        emailFlowRef.current = null;
        passwordFlowRef.current = null;
        for (const scope of scopesRef.current) scope.dispose();
        setSettings(defaultDoctorSettings);
        setEditingProfileCards({ personal: false, professional: false });
        setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
        setChangeEmailState(CHANGE_EMAIL_INITIAL_STATE);
        setChangePasswordOtp(CHANGE_PASSWORD_INITIAL_STATE);
        setIsSaving(false);
        setIsLoading(true);
        setAuthRevision(current => current + 1);
      } else if (event === "SIGNED_IN" && owner && !settingsLoadRef.current) {
        // Supabase recovers the same session on tab visibility. Revalidate once;
        // duplicate notifications while queued/in flight share that request.
        settingsLoadRef.current = { queued: true };
        setLoadRevision(current => current + 1);
      }
    });
    return () => {
      mountedRef.current = false;
      operationRef.current = null;
      abortController.abort();
      subscription.unsubscribe();
      for (const scope of scopes) scope.dispose();
      for (const timer of deferredTimers) window.clearTimeout(timer);
      deferredTimers.clear();
    };
  }, []);
  const identityUnavailable = Boolean(
    doctorIdentity?.loading || doctorIdentity?.error
  );
  const passwordResult = validatePassword(passwordForm.newPassword);
  const passwordMatch = passwordsMatch(
    passwordForm.newPassword,
    passwordForm.confirmPassword
  );
  const passwordFormValid =
    Boolean(passwordForm.currentPassword) &&
    passwordResult.valid &&
    passwordMatch;

  const dismissToast = React.useCallback(() => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }

    setToast(null);
  }, []);

  const showToast = React.useCallback((type, toastMessage) => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }

    toastVersionRef.current += 1;
    setToast({
      type,
      message: toastMessage,
      version: toastVersionRef.current,
    });

    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, SETTINGS_TOAST_DURATION_MS);
  }, []);

  React.useEffect(
    () => () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    },
    []
  );

  const notifyDoctorProfileUpdated = React.useCallback(() => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("doctor-settings-updated"));
    }
  }, []);

  const applyCanonicalIdentity = (identity, nextAvailability = canonicalRef.current.availability) => {
    const next = createDoctorSettingsSnapshot(identity, nextAvailability);
    canonicalRef.current = next;
    setSettings(next);
  };

  const applySavedIdentity = (identity, section) => {
    const snapshot = createDoctorSettingsSnapshot(identity, canonicalRef.current.availability);
    const patch = Object.fromEntries(Object.keys(doctorSettingsFields[section]).map(field => [field, snapshot[field]]));
    if ("email" in patch) patch.emailVerification = snapshot.emailVerification;
    const next = { ...canonicalRef.current, ...patch };
    canonicalRef.current = next;
    setSettings(next);
  };

  const getDraftValue = (section, field) =>
    Object.hasOwn(drafts[section], field) ? drafts[section][field] : settings[field];

  const clearSavedDraft = (section, submitted) => {
    const next = { ...draftsRef.current, [section]: { ...draftsRef.current[section] } };
    for (const [field, value] of Object.entries(submitted)) {
      if (Object.is(next[section][field], value)) delete next[section][field];
    }
    draftsRef.current = next;
    setDrafts(next);
    partialSectionsRef.current.delete(section);
    setFieldErrors(current => ({ ...current, [section]: {} }));
    if (section !== "account" && !Object.keys(next[section]).length) {
      setEditingProfileCards(current => ({ ...current, [section]: false }));
    }
  };

  React.useEffect(() => {
    let isCancelled = false;
    let loadScope;
    const request = {};
    settingsLoadRef.current = request;
    const controller = new AbortController();
    const loadSettings = async () => {
      setIsLoading(true);
      setLoadError("");
      try {
        loadScope = await createAuthenticatedMutation(supabase, {
          signal: controller.signal,
          expectedUserId: doctorIdentity?.authUser?.id || "",
          isCurrent: () => !isCancelled && mountedRef.current && settingsLoadRef.current === request,
        });
        loadScope.assertCurrent();
        request.identity = loadScope.identity;
        setAvailabilitySession(loadScope.identity);
        const user = await loadScope.getUser();
        const authenticatedDoctor = await loadAuthenticatedDoctor(user);
        await loadScope.check();
        if (isCancelled) return;
        // Preserve the owner object during a refresh of the same logical session.
        // Pending valid saves keep their original fence; dirty values are separate.
        if (mutationOwnerRef.current?.identity !== loadScope.identity) {
          mutationOwnerRef.current = { userId: user.id, identity: loadScope.identity };
        }
        applyCanonicalIdentity(authenticatedDoctor);
        const availabilityWriteRevision = availabilityWriteRevisionRef.current;
        const result = await loadScope.client.from("user_availability")
          .select("day_of_week, start_time, end_time, is_available")
          .eq("profile_id", user.id).order("day_of_week", { ascending: true });
        await loadScope.check();
        if (isCancelled) return;
        if (result.error) throw result.error;
        if (!Array.isArray(result.data)) throw new Error("Availability could not be read.");
        // A late availability read must not restore an earlier profile snapshot.
        const next = { ...canonicalRef.current, availability: availabilityWriteRevision === availabilityWriteRevisionRef.current
          ? mapAvailabilityRows(result.data) : canonicalRef.current.availability };
        canonicalRef.current = next;
        setSettings(next);
        setAvailabilityOwner({ userId: user.id, identity: loadScope.identity });
        setAvailabilityError("");
      } catch (error) {
        if (!isCancelled && mountedRef.current && settingsLoadRef.current === request) {
          if (error?.code === "mutation_cancelled") {
            // A session check may discover replacement even without an Auth event.
            setAvailabilityOwner(null);
            canonicalRef.current = { ...canonicalRef.current, availability: [] };
            setSettings(canonicalRef.current);
          }
          setLoadError("Doctor settings could not be refreshed. Your existing values are preserved. Please retry.");
          setAvailabilityError("Availability could not be refreshed. Please retry.");
        }
      } finally {
        loadScope?.dispose();
        if (!isCancelled && mountedRef.current && settingsLoadRef.current === request) {
          settingsLoadRef.current = null;
          setIsLoading(false);
        }
      }
    };
    void loadSettings();
    return () => {
      isCancelled = true;
      controller.abort();
      loadScope?.dispose();
      if (settingsLoadRef.current === request) settingsLoadRef.current = null;
    };
  }, [doctorIdentity?.authUser?.id, doctorIdentity?.profile, doctorIdentity?.personalInformation,
    doctorIdentity?.professionalInformation, authRevision, loadRevision]);

  React.useEffect(() => {
    if (!changeEmailState.isOpen) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setChangeEmailState((current) => ({
        ...current,
        currentOtpCooldown: Math.max(0, current.currentOtpCooldown - 1),
        newOtpCooldown: Math.max(0, current.newOtpCooldown - 1),
      }));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [changeEmailState.isOpen]);

  React.useEffect(() => {
    if (!changePasswordOtp.isOpen) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setChangePasswordOtp((current) => ({
        ...current,
        otpCooldown: Math.max(0, current.otpCooldown - 1),
      }));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [changePasswordOtp.isOpen]);

  const finishCredentialChange = async (scope) => {
    await scope.check();
    if (!requestDoctorSignOut) throw new Error("Secure sign-out is unavailable. Please use the Doctor account Log out action.");
    // The provider owns navigation, session confirmation, blocking and retry.
    // No delayed redirect may survive unmount or account replacement.
    scope.assertCurrent();
    const request = requestDoctorSignOut();
    if (!request) throw new Error("Secure sign-out could not start. Please use the Doctor account Log out action.");
    await request;
  };

  const updateSetting = (field, value, suppliedSection = null) => {
    if (operationRef.current && !operationRef.current.timedOut) return;
    const section = suppliedSection || (activePanel === "account" ? "account"
      : Object.hasOwn(doctorSettingsFields.personal, field) ? "personal" : "professional");
    if (!Object.hasOwn(doctorSettingsFields[section], field)) return;
    const next = { ...draftsRef.current, [section]: { ...draftsRef.current[section] } };
    if (Object.is(value, canonicalRef.current[field]) && !partialSectionsRef.current.has(section)) delete next[section][field];
    else next[section][field] = value;
    draftsRef.current = next;
    setDrafts(next);
    setFieldErrors(current => ({ ...current, [section]: { ...current[section], [field]: "" } }));
    setMessage("");
  };

  const syncProfileRecord = (nextSettings, scope) =>
    saveDoctorSettingsSection(scope, loadAuthenticatedDoctor, "email", { email: nextSettings.email });

  const persistSettings = (sections) => {
    const submitted = Object.fromEntries(sections.map(section => [section, { ...draftsRef.current[section] }]));
    sections = sections.filter(section => Object.keys(submitted[section]).length);
    if (!sections.length) { setMessage("No changes to save."); return; }
    const completed = [];
    return runSecurityAction(async scope => {
      setMessage("");
      for (const section of sections) validateDoctorSettingsDraft(section, submitted[section], canonicalRef.current.email);
      for (const section of sections) {
        const result = await saveDoctorSettingsSection(scope, loadAuthenticatedDoctor, section, submitted[section]);
        await scope.check();
        applySavedIdentity(result.identity, section);
        clearSavedDraft(section, submitted[section]);
        completed.push(section);
      }
      notifyDoctorProfileUpdated();
      showToast("success", "Changes saved successfully.");
    }, error => {
      if (error.fieldErrors) setFieldErrors(current => ({ ...current, [error.section]: error.fieldErrors }));
      if (error.canonicalIdentity) {
        applySavedIdentity(error.canonicalIdentity, error.section);
        partialSectionsRef.current.add(error.section);
      }
      const feedback = completed.length
        ? "Some selected cards were saved. The remaining changes could not be confirmed. Retry to finish saving."
        : error.code?.startsWith("doctor_settings_") ? error.message : "Changes could not be confirmed. Please retry.";
      setMessage(feedback);
      showToast("error", feedback);
    });
  };

  // Only an explicit footer click saves both Profile drafts. Each card owns
  // its form submission (including Enter); Done never submits another card.
  // Account drafts are independent even for shared fields.
  const saveProfileSettings = event => { event.preventDefault(); return persistSettings(["personal", "professional"]); };
  const saveAccountSettings = event => { event.preventDefault(); return persistSettings(["account"]); };

  const setChangeEmailField = (field, value) => {
    setChangeEmailState((current) => ({
      ...current,
      [field]: value,
      error: "",
      success: "",
    }));
  };

  const setChangePasswordOtpField = (field, value) => {
    setChangePasswordOtp((current) => ({
      ...current,
      [field]: value,
      error: "",
      success: "",
    }));
  };

  const changeEmail = () => runSecurityAction(async scope => {
    const user = await scope.getUser();
    emailFlowRef.current = null;
    setChangeEmailState({ ...CHANGE_EMAIL_INITIAL_STATE, isOpen: true,
      currentEmail: normalizeEmail(user.email), newEmail: normalizeEmail(settings.email) });
  }, error => showToast("error", getFriendlyAuthError(error)));

  const closeChangeEmailModal = () => {
    if (changeEmailState.isLoading || (operationRef.current && !operationRef.current.timedOut)) return;
    emailFlowRef.current = null;
    setChangeEmailState(CHANGE_EMAIL_INITIAL_STATE);
  };

  const completeEmailChange = async (scope, pendingEmail) => {
    const user = await scope.getUser();
    if (normalizeEmail(user.email) !== pendingEmail) return false;
    const nextSettings = { ...canonicalRef.current, email: normalizeEmail(user.email), emailVerification: user.email_confirmed_at ? "Verified" : "Pending" };
    // Never copy unverified addresses into profile tables or announce success.
    try {
      await syncProfileRecord(nextSettings, scope);
    } catch (error) {
      scope.assertCurrent();
      if (error.code === "mutation_cancelled") throw error;
      setMessage("The login email changed, but the Doctor profile could not be synchronized.");
    }
    await scope.check();
    emailFlowRef.current = null;
    canonicalRef.current = nextSettings;
    setSettings(nextSettings);
    notifyDoctorProfileUpdated();
    setChangeEmailState(current => ({ ...current, step: "complete", isLoading: true,
      currentPassword: "", currentEmailOtp: "", newEmailOtp: "", error: "",
      success: "Email changed successfully. Signing you out now.", newEmailVerified: true }));
    await finishCredentialChange(scope);
    return true;
  };

  const emailError = error => setChangeEmailState(current => ({
    ...current, currentPassword: "", isLoading: false, error: getFriendlyAuthError(error), success: "",
  }));

  const requestEmailChangeOtp = event => {
    event?.preventDefault();
    return runSecurityAction(async scope => {
      setChangeEmailState(current => ({ ...current, isLoading: true, error: "", success: "" }));
      const user = await scope.getUser();
      const currentEmail = normalizeEmail(user.email);
      const newEmail = normalizeEmail(changeEmailState.newEmail);
      if (!changeEmailState.currentPassword) throw new Error("Enter your current password.");
      if (!isValidEmail(newEmail) || newEmail === currentEmail) throw new Error("Enter a different valid email address.");
      await scope.authRequest("signInWithPassword", [{ email: currentEmail, password: changeEmailState.currentPassword }], "Password verification");
      emailFlowRef.current = { owner: mutationOwnerRef.current, pendingEmail: newEmail };
      await scope.authRequest("updateUser", [{ email: newEmail }], "Email change request");
      if (await completeEmailChange(scope, newEmail)) return;
      setChangeEmailState(current => ({ ...current, step: "currentOtp", currentEmail,
        pendingEmail: newEmail, currentPassword: "", currentEmailOtp: "", newEmailOtp: "",
        currentEmailVerified: false, newEmailVerified: false, isLoading: false, error: "",
        success: "Email change requested. Check your email for the confirmation codes or links.",
        currentOtpCooldown: OTP_COOLDOWN_SECONDS, newOtpCooldown: OTP_COOLDOWN_SECONDS }));
    }, emailError);
  };

  const verifyEmailChangeOtp = target => {
    if (!["current", "new"].includes(target) || !emailFlowRef.current) return;
    const flow = emailFlowRef.current;
    return runSecurityAction(async scope => {
      const isCurrentEmailStep = target === "current";
      const token = requireFullOtp(isCurrentEmailStep ? changeEmailState.currentEmailOtp : changeEmailState.newEmailOtp);
      const email = normalizeEmail(isCurrentEmailStep ? changeEmailState.currentEmail : flow.pendingEmail);
      setChangeEmailState(current => ({ ...current, isLoading: true, error: "", success: "" }));
      if (await completeEmailChange(scope, flow.pendingEmail)) return;
      // Auth supports email_change for both addresses; there is no client-only
      // acceptance or invented email_change_current challenge type.
      await scope.authRequest("verifyOtp", [{ email, token, type: "email_change" }], "Email OTP verification");
      if (await completeEmailChange(scope, flow.pendingEmail)) return;
      setChangeEmailState(current => ({ ...current, step: isCurrentEmailStep ? "newOtp" : "currentOtp",
        currentEmailVerified: isCurrentEmailStep || current.currentEmailVerified,
        currentEmailOtp: isCurrentEmailStep ? "" : current.currentEmailOtp,
        newEmailOtp: isCurrentEmailStep ? current.newEmailOtp : "", isLoading: false, error: "",
        success: "Code verified by Auth. Confirm the other email to finish the change." }));
    }, emailError, flow.owner);
  };

  const resendEmailChangeOtp = target => {
    const flow = emailFlowRef.current;
    const cooldownField = target === "current" ? "currentOtpCooldown" : "newOtpCooldown";
    if (!flow || changeEmailState[cooldownField] > 0) return;
    return runSecurityAction(async scope => {
      setChangeEmailState(current => ({ ...current, isLoading: true, error: "", success: "" }));
      // Supabase resend identifies the pending new address and may resend both
      // challenges. Do not claim a particular old challenge remains verified.
      await scope.authRequest("resend", [{ type: "email_change", email: flow.pendingEmail }], "Resending email confirmation");
      setChangeEmailState(current => ({ ...current, step: "currentOtp", currentEmailVerified: false,
        currentEmailOtp: "", newEmailOtp: "", isLoading: false,
        success: "Email confirmation requested again. Use the newest codes or links.",
        currentOtpCooldown: OTP_COOLDOWN_SECONDS, newOtpCooldown: OTP_COOLDOWN_SECONDS }));
    }, emailError, flow.owner);
  };

  React.useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      const flow = emailFlowRef.current;
      if (!["USER_UPDATED", "TOKEN_REFRESHED"].includes(event) || !flow ||
          session?.user?.id !== flow.owner.userId || normalizeEmail(session.user.email) !== flow.pendingEmail) return;
      const timer = window.setTimeout(() => {
        deferredTimersRef.current.delete(timer);
        if (emailFlowRef.current !== flow) return;
        void runSecurityAction(scope => completeEmailChange(scope, flow.pendingEmail), emailError, flow.owner);
      }, 0);
      deferredTimersRef.current.add(timer);
    });
    return () => subscription.unsubscribe();
  });

  const passwordError = error => {
    setChangePasswordOtp(current => ({ ...current, isLoading: false, loadingLabel: "", success: "", error: getFriendlyAuthError(error) }));
    showToast("error", getFriendlyAuthError(error));
  };

  const handlePasswordSubmit = event => {
    event.preventDefault();
    setPasswordFieldError("");
    if (!passwordFormValid) {
      setMessage(!passwordResult.valid ? getPasswordValidationMessage(passwordForm.newPassword) : "Complete the password fields with matching passwords.");
      return;
    }
    return runSecurityAction(async scope => {
      setIsSaving(true);
      setMessage("");
      const user = await scope.getUser();
      if (!user.email) throw new Error("The account has no login email.");
      await scope.authRequest("signInWithPassword", [{ email: user.email, password: passwordForm.currentPassword }], "Password verification");
      await scope.authRequest("resetPasswordForEmail", [user.email, { redirectTo: new URL("/doctor/settings", window.location.origin).toString() }], "Password OTP request");
      passwordFlowRef.current = { owner: mutationOwnerRef.current };
      setPasswordForm(current => ({ ...current, currentPassword: "" }));
      setChangePasswordOtp({ ...CHANGE_PASSWORD_INITIAL_STATE, isOpen: true,
        currentEmail: normalizeEmail(user.email), pendingNewPassword: passwordForm.newPassword,
        success: "OTP sent to your current email. Enter the 6-digit code to finish changing your password.", otpCooldown: OTP_COOLDOWN_SECONDS });
    }, passwordError);
  };

  const closeChangePasswordOtpModal = () => {
    if (changePasswordOtp.isLoading || (operationRef.current && !operationRef.current.timedOut)) return;
    passwordFlowRef.current = null;
    setChangePasswordOtp(CHANGE_PASSWORD_INITIAL_STATE);
  };

  const resendPasswordChangeOtp = () => {
    const flow = passwordFlowRef.current;
    if (!flow || changePasswordOtp.otpCooldown > 0) return;
    return runSecurityAction(async scope => {
      setChangePasswordOtp(current => ({ ...current, isLoading: true, loadingLabel: "Sending OTP...", error: "", success: "" }));
      await scope.authRequest("resetPasswordForEmail", [changePasswordOtp.currentEmail, { redirectTo: new URL("/doctor/settings", window.location.origin).toString() }], "Password OTP resend");
      setChangePasswordOtp(current => ({ ...current, isLoading: false, loadingLabel: "", error: "", success: "OTP resent to your current email.", otpCooldown: OTP_COOLDOWN_SECONDS }));
    }, passwordError, flow.owner);
  };

  const verifyPasswordOtpAndUpdate = () => {
    const flow = passwordFlowRef.current;
    if (!flow) return;
    return runSecurityAction(async scope => {
      const token = requireFullOtp(changePasswordOtp.otp);
      if (!validatePassword(changePasswordOtp.pendingNewPassword).valid) throw new Error(getPasswordValidationMessage(changePasswordOtp.pendingNewPassword));
      setChangePasswordOtp(current => ({ ...current, isLoading: true, loadingLabel: "Verifying OTP...", error: "", success: "" }));
      await scope.authRequest("verifyOtp", [{ email: changePasswordOtp.currentEmail, token, type: "recovery" }], "Password OTP verification");
      await scope.authRequest("updateUser", [{ password: changePasswordOtp.pendingNewPassword }], "Password update");
      setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      setConfirmPasswordInteracted(false);
      passwordFlowRef.current = null;
      setChangePasswordOtp(current => ({ ...current, step: "complete", otp: "", pendingNewPassword: "", isLoading: true,
        loadingLabel: "Signing out...", error: "", success: "Password updated successfully. Signing you out now." }));
      await finishCredentialChange(scope);
    }, passwordError, flow.owner);
  };

  const createScheduleDraft = (day = "Monday") => ({
    day,
    time: "",
    status: "Available",
  });

  const openScheduleEditor = (availabilityItem = null) => {
    if (operationRef.current || isLoading || identityUnavailable) return;
    setScheduleDraft(
      availabilityItem
        ? { ...availabilityItem }
        : createScheduleDraft()
    );
    setMessage("");
    setScheduleFieldError("");
  };

  const saveScheduleDraft = event => {
    event.preventDefault();
    if (operationRef.current) return;
    const submitted = scheduleDraft ? { ...scheduleDraft } : null;
    return runSecurityAction(async scope => {
      setScheduleFieldError("");
      if (!submitted?.day || !["Available", "Closed"].includes(submitted.status)) {
        setScheduleFieldError("Complete the schedule details."); return;
      }
      const isAvailable = submitted.status === "Available";
      const range = isAvailable ? parseScheduleTimeRange(submitted.time) : null;
      if (isAvailable && !range) {
        setScheduleFieldError('Enter a valid time range such as "8:00 AM - 12:00 PM".'); return;
      }
      const dayOfWeek = getAvailabilityDayIndex(submitted.day);
      if (dayOfWeek < 0) { setScheduleFieldError("Select a valid day."); return; }
      const user = await scope.getUser();
      await loadAuthenticatedDoctor(user);
      await scope.check();
      const result = await scope.client.from("user_availability").upsert({
        profile_id: user.id, day_of_week: dayOfWeek,
        start_time: isAvailable ? range.startTime : null,
        end_time: isAvailable ? range.endTime : null, is_available: isAvailable,
      }, { onConflict: "profile_id,day_of_week" })
        .select("profile_id, day_of_week, start_time, end_time, is_available").single();
      await scope.check();
      if (result.error) throw result.error;
      if (result.data?.profile_id !== user.id || Number(result.data.day_of_week) !== dayOfWeek ||
          typeof result.data.is_available !== "boolean") {
        throw new Error("The saved availability could not be read back.");
      }
      const saved = mapAvailabilityRows([result.data])[0];
      if (!saved) throw new Error("The saved availability could not be read back.");
      const next = { ...canonicalRef.current, availability: [
        ...canonicalRef.current.availability.filter(item => item.day !== saved.day), saved,
      ].sort((a,b) => availabilityDayOptions.indexOf(a.day) - availabilityDayOptions.indexOf(b.day)) };
      availabilityWriteRevisionRef.current += 1;
      canonicalRef.current = next;
      setSettings(next);
      setScheduleDraft(null);
      showToast("success", "Schedule availability updated successfully.");
    }, () => {
      setScheduleFieldError("The schedule save could not be confirmed. Your draft is preserved. Please retry.");
      showToast("error", "Schedule availability could not be confirmed. Please retry.");
    });
  };

  const closeScheduleEditor = () => {
    if (!isSaving && !operationRef.current) setScheduleDraft(null);
  };
  const emailDialogRef = useDoctorSettingsDialog(changeEmailState.isOpen, closeChangeEmailModal, emailDialogTriggerRef);
  const passwordDialogRef = useDoctorSettingsDialog(changePasswordOtp.isOpen, closeChangePasswordOtpModal, passwordDialogTriggerRef);
  const scheduleDialogRef = useDoctorSettingsDialog(Boolean(scheduleDraft), closeScheduleEditor, scheduleDialogTriggerRef);

  const activeSectionLabel = settingsSections.find((section) => section.id === activePanel)?.label || "Profile";
  const breadcrumbLabel = activeSectionLabel;
  const availability = Array.isArray(settings.availability)
    ? settings.availability
    : [];
  // Empty availability is also verified data. Retention is component-local and
  // belongs to the initiating Doctor and logical session, never just an ID.
  const hasVerifiedAvailability = Boolean(availabilityOwner &&
    availabilityOwner.userId === doctorIdentity?.authUser?.id &&
    availabilityOwner.identity === availabilitySession);
  const personalProfileFields = [
    { label: "Full Name", field: "displayName", value: settings.displayName },
    { label: "Birthdate", field: "birthdate", value: settings.birthdate },
    {
      label: "Civil Status",
      field: "civilStatus",
      value: settings.civilStatus,
      options: ["Single", "Married", "Widowed", "Separated"],
    },
    {
      label: "Gender",
      field: "gender",
      value: settings.gender,
      options: ["Female", "Male", "Prefer not to say"],
    },
    { label: "Nationality", field: "nationality", value: settings.nationality },
    { label: "Years of Experience", field: "yearsExperience", value: settings.yearsExperience },
  ];
  const professionalProfileFields = [
    { label: "Doctor ID", field: "doctorId", value: settings.doctorId },
    { label: "Board Certification", field: "boardCertification", value: settings.boardCertification },
    { label: "License Number", field: "licenseNumber", value: settings.licenseNumber },
    { label: "Email Address", field: "email", value: settings.email, type: "email" },
    { label: "Clinic/Hospital Name", field: "clinicName", value: settings.clinicName },
    { label: "Contact Number", field: "contactNumber", value: settings.contactNumber },
    { label: "Clinic Address", field: "clinicAddress", value: settings.clinicAddress },
  ];

  const toggleProfileCardEdit = card => {
    if (operationRef.current) return;
    if (!editingProfileCards[card]) {
      setEditingProfileCards(current => ({ ...current, [card]: true }));
      setMessage("");
      return;
    }
    if (!Object.keys(draftsRef.current[card]).length) {
      setEditingProfileCards(current => ({ ...current, [card]: false }));
      return;
    }
    return persistSettings([card]);
  };

  const submitProfileCard = (event, card) => {
    event.preventDefault();
    if (editingProfileCards[card]) return toggleProfileCardEdit(card);
  };

  const renderProfileSettingsField = (field, isEditing) => {
    const section = Object.hasOwn(doctorSettingsFields.personal, field.field) ? "personal" : "professional";
    const value = getDraftValue(section, field.field);
    const error = fieldErrors[section][field.field];
    const errorId = "doctor-settings-" + field.field + "-error";
    return (
      <label className="doctor-settings-info-item" key={field.field}>
        <strong>{field.label}</strong>
        {isEditing ? field.options ? (
          <select value={value} disabled={isSaving || isLoading || identityUnavailable}
            aria-invalid={error ? "true" : undefined} aria-describedby={error ? errorId : undefined}
            onChange={event => updateSetting(field.field, event.target.value, section)}>
            <option value="">Not set</option>
            {value && !field.options.includes(value) ? <option value={value}>{value}</option> : null}
            {field.options.map(option => <option key={option}>{option}</option>)}
          </select>
        ) : (
          <input type={field.type || "text"} value={value} disabled={isSaving || isLoading || identityUnavailable}
            aria-invalid={error ? "true" : undefined} aria-describedby={error ? errorId : undefined}
            onChange={event => updateSetting(field.field, event.target.value, section)} />
        ) : <span>{value || (isLoading ? "Loading..." : "Not set")}</span>}
        {error ? <span id={errorId} className="doctor-settings-field-error" role="alert">{error}</span> : null}
      </label>
    );
  };

  return (
    <section className="doctor-settings-page" data-panel={activePanel}>
      <header className="doctor-dashboard-header">
        <div>
          <h1>Settings</h1>
          <p className="doctor-settings-breadcrumb">Settings <span>{">"}</span> <b>{breadcrumbLabel}</b></p>
        </div>
        {headerAction ?? <SettingsHeaderAction settings={settings} />}
      </header>

      {loadError ? (
        <div className="doctor-settings-inline-actions" role="alert">
          <p>{loadError}</p>
          <button type="button" disabled={isLoading || isSaving}
            onClick={() => setLoadRevision(current => current + 1)}>Retry loading settings</button>
        </div>
      ) : null}

      {toast ? (
        <aside
          key={toast.version}
          className={`doctor-settings-toast is-${toast.type}`}
          role={toast.type === "error" ? "alert" : "status"}
          aria-live={toast.type === "error" ? "assertive" : "polite"}
          aria-atomic="true"
        >
          <span className="doctor-settings-toast__icon">
            <DoctorIcon name={toast.type === "error" ? "info" : "checkCircle"} />
          </span>
          <p>{toast.message}</p>
          <button
            type="button"
            onClick={dismissToast}
            aria-label="Close notification"
          >
            <DoctorIcon name="cancelCircle" />
          </button>
        </aside>
      ) : null}

      <div className="doctor-settings-shell" data-panel={activePanel}>
        <aside className="doctor-settings-sidebar" aria-label="Settings sections">
          {settingsSections.map((section) => (
            <button
              type="button"
              className={activePanel === section.id ? "is-active" : ""}
              key={section.id}
              onClick={() => {
                setActivePanel(section.id);
                setMessage("");
              }}
            >
              <DoctorIcon name={section.icon} />
              <span>{section.label}</span>
            </button>
          ))}
        </aside>

        <section className="doctor-settings-content">
          {activePanel === "profile" ? (
            <div className="doctor-settings-profile-form">
              <header className="doctor-settings-section-header">
                <span><DoctorIcon name="profile" /></span>
                <div>
                  <h2>Profile Settings</h2>
                  <p>Manage your personal and professional information.</p>
                </div>
              </header>

              <div className="doctor-settings-info-stack">
                <form className="doctor-settings-info-card doctor-settings-info-card--personal"
                  onSubmit={event => submitProfileCard(event, "personal")}>
                  <header>
                    <h3>Personal Information</h3>
                    <button
                      type="button"
                      onClick={() => toggleProfileCardEdit("personal")}
                      disabled={isSaving || isLoading || identityUnavailable}
                    >
                      <DoctorIcon name="pencil" />
                      <span>
                        {isSaving && editingProfileCards.personal
                          ? "Saving..."
                          : editingProfileCards.personal
                            ? "Done"
                            : "Edit"}
                      </span>
                    </button>
                  </header>
                  <div className={`doctor-settings-info-grid${editingProfileCards.personal ? " is-editing" : ""}`}>
                    {personalProfileFields.map((field) => renderProfileSettingsField(field, editingProfileCards.personal))}
                  </div>
                </form>

                <form className="doctor-settings-info-card doctor-settings-info-card--professional"
                  onSubmit={event => submitProfileCard(event, "professional")}>
                  <header>
                    <h3>Professional Information</h3>
                    <button
                      type="button"
                      onClick={() => toggleProfileCardEdit("professional")}
                      disabled={isSaving || isLoading || identityUnavailable}
                    >
                      <DoctorIcon name="pencil" />
                      <span>
                        {isSaving && editingProfileCards.professional
                          ? "Saving..."
                          : editingProfileCards.professional
                            ? "Done"
                            : "Edit"}
                      </span>
                    </button>
                  </header>
                  <div className={`doctor-settings-info-grid${editingProfileCards.professional ? " is-editing" : ""}`}>
                    {professionalProfileFields.map((field) => renderProfileSettingsField(field, editingProfileCards.professional))}
                  </div>
                </form>
              </div>

              <div className="doctor-settings-footer">
                {message ? <p>{message}</p> : <span />}
                <button type="button" onClick={saveProfileSettings} disabled={isSaving || isLoading || identityUnavailable}>{isSaving ? "Saving..." : "Save Profile Changes"}</button>
              </div>
            </div>
          ) : null}

          {activePanel === "account" ? (
            <form className="doctor-settings-account-form" onSubmit={saveAccountSettings}>
              <header className="doctor-settings-section-header">
                <span><DoctorIcon name="account" /></span>
                <div>
                  <h2>Account Settings</h2>
                  <p>Manage your account details and information.</p>
                </div>
              </header>

              <section className="doctor-settings-account-block doctor-settings-account-card">
                <h3>Account Information</h3>
                <div className="doctor-settings-form-grid">
                  <label>
                    <span>Email Address</span>
                    <input type="email" value={getDraftValue("account", "email")} disabled={isSaving || isLoading || identityUnavailable}
                      aria-invalid={fieldErrors.account.email ? "true" : undefined}
                      onChange={event => updateSetting("email", event.target.value, "account")} />
                    {fieldErrors.account.email ? <span className="doctor-settings-field-error" role="alert">{fieldErrors.account.email}</span> : null}
                  </label>
                  <label>
                    <span>Contact Number</span>
                    <input value={getDraftValue("account", "contactNumber")} disabled={isSaving || isLoading || identityUnavailable}
                      onChange={event => updateSetting("contactNumber", event.target.value, "account")} />
                  </label>
                </div>
                <div className="doctor-settings-inline-actions">
                  <button type="submit" disabled={isSaving || isLoading || identityUnavailable}>{isSaving ? "Saving..." : "Save Changes"}</button>
                  <button type="button" onClick={event => { rememberDoctorSettingsDialogTrigger(emailDialogTriggerRef, event); return changeEmail(); }} disabled={isSaving || isLoading || identityUnavailable}>Change Email</button>
                </div>
              </section>

              <section className="doctor-settings-account-status">
                <header>
                  <span className="doctor-settings-status-logo"><DoctorIcon name="shield" /></span>
                  <h2>Account Status</h2>
                </header>

                <div className="doctor-settings-status-list">
                  <article>
                    <span className="doctor-settings-status-icon"><DoctorIcon name="mail" /></span>
                    <div>
                      <strong>Email Verification</strong>
                      <p>Your email address is verified.</p>
                    </div>
                    <mark>{settings.emailVerification}</mark>
                  </article>
                  <article>
                    <span className="doctor-settings-status-icon"><DoctorIcon name="profile" /></span>
                    <div>
                      <strong>Account Status</strong>
                      <p>Your account is active and in good standing.</p>
                    </div>
                    <mark>{settings.accountStatus}</mark>
                  </article>
                  <article>
                    <span className="doctor-settings-status-icon"><DoctorIcon name="clock" /></span>
                    <div>
                      <strong>Last Login</strong>
                      <p>{settings.lastLogin}</p>
                    </div>
                    <mark className="is-blue">Today</mark>
                  </article>
                </div>
              </section>

              {message ? <p className="doctor-settings-page-message">{message}</p> : null}
            </form>
          ) : null}

          {activePanel === "security" ? (
            <form className="doctor-settings-security-form" onSubmit={event => { rememberDoctorSettingsDialogTrigger(passwordDialogTriggerRef, event); return handlePasswordSubmit(event); }}>
              <header className="doctor-settings-section-header">
                <span><DoctorIcon name="lock" /></span>
                <div>
                  <h2>Password &amp; Security</h2>
                  <p>Update your password and manage your account securely.</p>
                </div>
              </header>

              <div className="doctor-settings-security-grid doctor-settings-security-grid--password-only">
                <section className="doctor-settings-security-card doctor-settings-password-card">
                  <h3><DoctorIcon name="key" /> <span>Change Password</span></h3>
                  {["currentPassword", "newPassword", "confirmPassword"].map((field) => (
                    <React.Fragment key={field}>
                      <label className="doctor-settings-password-field">
                        {field === "currentPassword" ? "Current Password" : field === "newPassword" ? "New Password" : "Confirm New Password"}
                        <input
                          type={passwordVisible[field] ? "text" : "password"}
                          placeholder={
                            field === "currentPassword"
                              ? "Enter your current password"
                              : field === "newPassword"
                                ? "Enter new password"
                                : "Confirm new password"
                          }
                          value={passwordForm[field]}
                          onChange={(event) => {
                            if (field === "confirmPassword") {
                              setConfirmPasswordInteracted(true);
                            }
                            setPasswordFieldError("");
                            setMessage("");
                            setPasswordForm((current) => ({ ...current, [field]: event.target.value }));
                          }}
                          onBlur={() => {
                            if (field === "confirmPassword") {
                              setConfirmPasswordInteracted(true);
                            }
                          }}
                          autoComplete={field === "currentPassword" ? "current-password" : "new-password"}
                          minLength={
                            field === "currentPassword"
                              ? undefined
                              : PASSWORD_MIN_LENGTH
                          }
                          aria-describedby={
                            field === "currentPassword" && passwordFieldError
                              ? "doctor-current-password-error"
                              : undefined
                          }
                          aria-invalid={
                            field === "currentPassword" && passwordFieldError
                              ? "true"
                              : undefined
                          }
                          required
                          disabled={isSaving || changePasswordOtp.isOpen}
                        />
                        <button
                          type="button"
                          aria-label={`${passwordVisible[field] ? "Hide" : "Show"} ${
                            field === "currentPassword"
                              ? "current password"
                              : field === "newPassword"
                                ? "new password"
                                : "password confirmation"
                          }`}
                          aria-pressed={passwordVisible[field]}
                          onClick={() =>
                            setPasswordVisible((current) => ({ ...current, [field]: !current[field] }))
                          }
                        >
                          <DoctorIcon name={passwordVisible[field] ? "eye" : "eyeOff"} />
                        </button>
                      </label>
                      {field === "currentPassword" && passwordFieldError ? (
                        <p
                          id="doctor-current-password-error"
                          className="doctor-settings-field-error"
                          role="alert"
                        >
                          {passwordFieldError}
                        </p>
                      ) : null}
                    </React.Fragment>
                  ))}
                  <PasswordSecurityFeedback
                    password={passwordForm.newPassword}
                    confirmPassword={passwordForm.confirmPassword}
                    confirmInteracted={confirmPasswordInteracted}
                  />
                  <button className="doctor-settings-save-password" type="submit" disabled={!passwordFormValid || isSaving || isLoading || identityUnavailable || changePasswordOtp.isOpen}>
                    {isSaving ? "Verifying..." : "Save Changes"}
                  </button>
                </section>
              </div>

              {message ? <p className="doctor-settings-page-message">{message}</p> : null}
            </form>
          ) : null}

          {activePanel === "availability" ? (
            <section className="doctor-settings-availability-panel">
              <header className="doctor-settings-section-header doctor-settings-section-header--with-action">
                <span><DoctorIcon name="calendar" /></span>
                <div>
                  <h2>Schedule Availability</h2>
                  <p>Update your schedule availability</p>
                </div>
                <button
                  type="button"
                  onClick={event => { rememberDoctorSettingsDialogTrigger(scheduleDialogTriggerRef, event); openScheduleEditor(availability[0] || null); }}
                  disabled={isLoading || Boolean(availabilityError) || isSaving}
                >
                  <DoctorIcon name="calendarEdit" />
                  <span>{availability.length > 0 ? "Edit Schedule" : "Configure Schedule"}</span>
                </button>
              </header>

              <div className="doctor-settings-schedule-table" aria-busy={isLoading}>
                <h3>WEEKLY SCHEDULE</h3>
                <div className="doctor-settings-schedule-head">
                  <span>Day</span>
                  <span>Time</span>
                  <span>Status</span>
                </div>
                {availabilityError && hasVerifiedAvailability ? (
                  <p className="doctor-settings-page-message" role="alert">
                    The last verified schedule is shown and may be out of date. Use Retry loading settings above.
                  </p>
                ) : null}
                {!hasVerifiedAvailability && (isLoading || !availabilityError) ? (
                  <div className="doctor-settings-schedule-empty" role="status">
                    <DoctorIcon name="clock" />
                    <div>
                      <strong>Loading availability...</strong>
                      <p>Retrieving the saved schedule from Supabase.</p>
                    </div>
                  </div>
                ) : !hasVerifiedAvailability && availabilityError ? (
                  <div className="doctor-settings-schedule-empty" role="alert">
                    <DoctorIcon name="info" />
                    <div>
                      <strong>Availability could not be loaded</strong>
                      <p>Use Retry loading settings above to try loading the saved schedule again.</p>
                    </div>
                  </div>
                ) : availability.length > 0 ? (
                  availability.map((item) => (
                    <button
                      type="button"
                      className={item.status === "Closed" ? "is-closed" : ""}
                      key={item.day}
                      aria-label={`Edit schedule. Day: ${item.day}. Time: ${item.status === "Closed" ? "No appointments scheduled" : item.time}. Status: ${item.status}.`}
                      onClick={event => { rememberDoctorSettingsDialogTrigger(scheduleDialogTriggerRef, event); openScheduleEditor(item); }}
                    >
                      <span className="doctor-settings-schedule-day">
                        <i />
                        {item.day}
                      </span>
                      <span className="doctor-settings-schedule-time">
                        <DoctorIcon name={item.status === "Closed" ? "noEntry" : "clock"} />
                        {item.status === "Closed" ? "No appointments scheduled" : item.time}
                      </span>
                      <mark className={item.status === "Closed" ? "is-closed" : ""}>
                        {item.status === "Closed" ? null : <DoctorIcon name="checkCircle" />}
                        <span>{item.status.toUpperCase()}</span>
                      </mark>
                    </button>
                  ))
                ) : (
                  <div className="doctor-settings-schedule-empty">
                    <DoctorIcon name="calendar" />
                    <div>
                      <strong>No availability configured</strong>
                      <p>Configure a day and time to make your database-backed schedule available.</p>
                    </div>
                  </div>
                )}
              </div>

              {message ? <p className="doctor-settings-page-message">{message}</p> : null}
            </section>
          ) : null}
        </section>
      </div>

      {changeEmailState.isOpen ? (
        <div
          className="doctor-otp-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeChangeEmailModal();
            }
          }}
        >
          <section
            className="doctor-otp-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="doctor-change-email-title"
            ref={emailDialogRef}
            tabIndex={-1}
          >
            <header className="doctor-otp-modal-header">
              <div>
                <span className="doctor-otp-modal-icon">
                  <DoctorIcon name="mail" />
                </span>
                <div>
                  <h2 id="doctor-change-email-title">Change Email</h2>
                  <p>Verify your password and follow the email confirmations required by Auth.</p>
                </div>
              </div>
              <button
                type="button"
                className="doctor-otp-modal-close"
                onClick={closeChangeEmailModal}
                disabled={changeEmailState.isLoading}
                aria-label="Close change email modal"
              >
                x
              </button>
            </header>

            <div className="doctor-otp-steps" aria-hidden="true">
              {[
                ["details", "Password"],
                ["currentOtp", "Current OTP"],
                ["newOtp", "New OTP"],
              ].map(([stepName, label], index) => (
                <span
                  key={stepName}
                  className={
                    changeEmailState.step === stepName ||
                    (changeEmailState.step === "complete" && index < 3) ||
                    (stepName === "currentOtp" &&
                      changeEmailState.currentEmailVerified) ||
                    (stepName === "newOtp" &&
                      changeEmailState.newEmailVerified)
                      ? "is-active"
                      : ""
                  }
                >
                  {index + 1}
                  <small>{label}</small>
                </span>
              ))}
            </div>

            {changeEmailState.error ? (
              <p className="doctor-otp-modal-message is-error" role="alert" aria-atomic="true">
                {changeEmailState.error}
              </p>
            ) : null}

            {changeEmailState.success ? (
              <p className="doctor-otp-modal-message is-success" role="status" aria-atomic="true">
                {changeEmailState.success}
              </p>
            ) : null}

            {changeEmailState.step === "details" ? (
              <form className="doctor-otp-modal-body" onSubmit={requestEmailChangeOtp}>
                <label>
                  <span>Current Email</span>
                  <input type="email" value={changeEmailState.currentEmail} readOnly aria-readonly="true" />
                </label>
                <label>
                  <span>Current Password</span>
                  <input
                    type="password"
                    autoComplete="current-password"
                    data-dialog-initial-focus
                    value={changeEmailState.currentPassword}
                    onChange={(event) => setChangeEmailField("currentPassword", event.target.value)}
                    disabled={changeEmailState.isLoading}
                    placeholder="Enter current password"
                  />
                </label>
                <label>
                  <span>New Email</span>
                  <input
                    type="email"
                    autoComplete="email"
                    value={changeEmailState.newEmail}
                    onChange={(event) => setChangeEmailField("newEmail", event.target.value)}
                    disabled={changeEmailState.isLoading}
                    placeholder="Enter new email address"
                  />
                </label>
                <div className="doctor-otp-modal-actions">
                  <button type="button" className="is-secondary" onClick={closeChangeEmailModal} disabled={changeEmailState.isLoading}>
                    Cancel
                  </button>
                  <button type="submit" disabled={changeEmailState.isLoading}>
                    {changeEmailState.isLoading ? "Sending..." : "Send OTP"}
                  </button>
                </div>
              </form>
            ) : null}

            {changeEmailState.step === "currentOtp" ? (
              <div className="doctor-otp-modal-body">
                <p className="doctor-otp-modal-help">
                  Enter the 6-digit OTP sent to <strong>{changeEmailState.currentEmail}</strong>.
                </p>
                <label>
                  <span>Current Email OTP</span>
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    data-dialog-initial-focus
                    value={changeEmailState.currentEmailOtp}
                    onChange={(event) => setChangeEmailField("currentEmailOtp", normalizeOtp(event.target.value))}
                    disabled={changeEmailState.isLoading}
                    maxLength={6}
                    placeholder="Enter OTP"
                  />
                </label>
                <div className="doctor-otp-modal-actions">
                  <button
                    type="button"
                    className="is-secondary"
                    onClick={() => resendEmailChangeOtp("current")}
                    disabled={changeEmailState.isLoading || changeEmailState.currentOtpCooldown > 0}
                  >
                    {changeEmailState.currentOtpCooldown > 0
                      ? `Resend in ${changeEmailState.currentOtpCooldown}s`
                      : "Resend OTP"}
                  </button>
                  <button type="button" className="is-secondary"
                    onClick={() => setChangeEmailState(current => ({ ...current, step: "newOtp", error: "", success: "" }))}
                    disabled={changeEmailState.isLoading}>
                    Use new email code
                  </button>
                  <button type="button" onClick={() => verifyEmailChangeOtp("current")} disabled={changeEmailState.isLoading}>
                    {changeEmailState.isLoading ? "Verifying..." : "Verify Current Email"}
                  </button>
                </div>
              </div>
            ) : null}

            {changeEmailState.step === "newOtp" ? (
              <div className="doctor-otp-modal-body">
                <p className="doctor-otp-modal-help">
                  Enter the 6-digit OTP sent to <strong>{changeEmailState.pendingEmail}</strong>.
                </p>
                <label>
                  <span>New Email OTP</span>
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    data-dialog-initial-focus
                    value={changeEmailState.newEmailOtp}
                    onChange={(event) => setChangeEmailField("newEmailOtp", normalizeOtp(event.target.value))}
                    disabled={changeEmailState.isLoading}
                    maxLength={6}
                    placeholder="Enter OTP"
                  />
                </label>
                <div className="doctor-otp-modal-actions">
                  <button
                    type="button"
                    className="is-secondary"
                    onClick={() => resendEmailChangeOtp("new")}
                    disabled={changeEmailState.isLoading || changeEmailState.newOtpCooldown > 0}
                  >
                    {changeEmailState.newOtpCooldown > 0
                      ? `Resend in ${changeEmailState.newOtpCooldown}s`
                      : "Resend OTP"}
                  </button>
                  <button type="button" onClick={() => verifyEmailChangeOtp("new")} disabled={changeEmailState.isLoading}>
                    {changeEmailState.isLoading ? "Verifying..." : "Verify New Email"}
                  </button>
                </div>
              </div>
            ) : null}

            {changeEmailState.step === "complete" ? (
              <div className="doctor-otp-modal-body">
                <div className="doctor-otp-complete">
                  <DoctorIcon name="shield" />
                  <h3>Email changed successfully</h3>
                  <p>Your doctor login email is now <strong>{settings.email}</strong>.</p>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {changePasswordOtp.isOpen ? (
        <div
          className="doctor-otp-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeChangePasswordOtpModal();
            }
          }}
        >
          <section
            className="doctor-otp-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="doctor-change-password-title"
            ref={passwordDialogRef}
            tabIndex={-1}
          >
            <header className="doctor-otp-modal-header">
              <div>
                <span className="doctor-otp-modal-icon">
                  <DoctorIcon name="key" />
                </span>
                <div>
                  <h2 id="doctor-change-password-title">Verify Password Change</h2>
                  <p>Enter the OTP sent to your current email to update your password.</p>
                </div>
              </div>
              <button
                type="button"
                className="doctor-otp-modal-close"
                onClick={closeChangePasswordOtpModal}
                disabled={changePasswordOtp.isLoading}
                aria-label="Close password OTP modal"
              >
                x
              </button>
            </header>

            <div className="doctor-otp-steps doctor-password-steps" aria-hidden="true">
              {[
                ["otp", "Verify OTP"],
                ["complete", "Complete"],
              ].map(([stepName, label], index) => (
                <span
                  key={stepName}
                  className={
                    changePasswordOtp.step === stepName ||
                    changePasswordOtp.step === "complete"
                      ? "is-active"
                      : ""
                  }
                >
                  {index + 1}
                  <small>{label}</small>
                </span>
              ))}
            </div>

            {changePasswordOtp.error ? (
              <p className="doctor-otp-modal-message is-error" role="alert" aria-atomic="true">{changePasswordOtp.error}</p>
            ) : null}

            {changePasswordOtp.success ? (
              <p className="doctor-otp-modal-message is-success" role="status" aria-atomic="true">{changePasswordOtp.success}</p>
            ) : null}

            {changePasswordOtp.step === "otp" ? (
              <div className="doctor-otp-modal-body">
                <p className="doctor-otp-modal-help">
                  Enter the 6-digit OTP sent to <strong>{changePasswordOtp.currentEmail}</strong>.
                </p>
                <label>
                  <span>Password Change OTP</span>
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    data-dialog-initial-focus
                    value={changePasswordOtp.otp}
                    onChange={(event) => setChangePasswordOtpField("otp", normalizeOtp(event.target.value))}
                    disabled={changePasswordOtp.isLoading}
                    maxLength={6}
                    placeholder="Enter OTP"
                  />
                </label>
                <div className="doctor-otp-modal-actions">
                  <button
                    type="button"
                    className="is-secondary"
                    onClick={resendPasswordChangeOtp}
                    disabled={changePasswordOtp.isLoading || changePasswordOtp.otpCooldown > 0}
                  >
                    {changePasswordOtp.otpCooldown > 0
                      ? `Resend in ${changePasswordOtp.otpCooldown}s`
                      : "Resend OTP"}
                  </button>
                  <button type="button" onClick={verifyPasswordOtpAndUpdate} disabled={changePasswordOtp.isLoading}>
                    {changePasswordOtp.isLoading
                      ? changePasswordOtp.loadingLabel || "Working..."
                      : "Verify & Update"}
                  </button>
                </div>
              </div>
            ) : null}

            {changePasswordOtp.step === "complete" ? (
              <div className="doctor-otp-modal-body">
                <div className="doctor-otp-complete">
                  <DoctorIcon name="shield" />
                  <h3>Password updated successfully</h3>
                  <p>Your password was changed. You will be redirected to Login.</p>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {scheduleDraft ? (
        <div className="doctor-settings-edit-overlay">
          <form className="doctor-settings-edit-modal" onSubmit={saveScheduleDraft}
            ref={scheduleDialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="doctor-schedule-edit-title">
            <button type="button" aria-label="Close schedule editor" disabled={isSaving} onClick={closeScheduleEditor}>X</button>
            <h2 id="doctor-schedule-edit-title">Edit Schedule</h2>

            <label>
              Select Day:
              <select
                disabled={isSaving}
                data-dialog-initial-focus
                value={scheduleDraft.day}
                onChange={(event) => {
                  setScheduleFieldError("");
                  const selected = availability.find((item) => item.day === event.target.value);
                  setScheduleDraft(
                    selected
                      ? { ...selected }
                      : createScheduleDraft(event.target.value)
                  );
                }}
              >
                {availabilityDayOptions.map((day) => (
                  <option key={day}>{day}</option>
                ))}
              </select>
            </label>

            <label>
              Select Time:
              <input
                type="text"
                placeholder="8:00 AM - 12:00 PM"
                disabled={isSaving}
                value={scheduleDraft.time}
                onChange={(event) => {
                  setScheduleFieldError("");
                  setScheduleDraft((current) => ({ ...current, time: event.target.value }));
                }}
                aria-describedby={scheduleFieldError ? "doctor-schedule-error" : undefined}
                aria-invalid={scheduleFieldError ? "true" : undefined}
              />
            </label>

            <label>
              Status
              <select
                disabled={isSaving}
                value={scheduleDraft.status}
                onChange={(event) => {
                  setScheduleFieldError("");
                  setScheduleDraft((current) => ({ ...current, status: event.target.value }));
                }}
              >
                <option>Available</option>
                <option>Closed</option>
              </select>
            </label>

            {scheduleFieldError ? (
              <p
                id="doctor-schedule-error"
                className="doctor-settings-field-error"
                role="alert"
              >
                {scheduleFieldError}
              </p>
            ) : null}

            <div>
              <button type="submit" disabled={isSaving}>{isSaving ? "Saving..." : "Save"}</button>
              <button type="button" disabled={isSaving} onClick={closeScheduleEditor}>Cancel</button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}

export default DoctorSettingsContent;
