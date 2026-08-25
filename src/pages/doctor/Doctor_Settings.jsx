import React from "react";
import { useNavigate } from "react-router-dom";

import { supabase } from "../../lib/supabaseClient";
import { loadAuthenticatedDoctor } from "../../hooks/useAuthenticatedDoctor";
import {
  availabilityDayNames,
  getAvailabilityDayIndex,
} from "../../lib/availabilitySchedule";
import "../../styles/doctor-settings.css";

const DOCTOR_PERSONAL_INFORMATION_TABLE =
  "doctor_personal_information";
const DOCTOR_PROFESSIONAL_INFORMATION_TABLE =
  "doctor_professional_information";

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
    const date = new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day))
    );

    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(date);
  }

  return String(value);
}

function parseDateForDatabase(value) {
  const normalizedValue = String(value || "").trim();

  if (!normalizedValue) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalizedValue)) {
    return normalizedValue;
  }

  const parsedDate = new Date(normalizedValue);

  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  const year = parsedDate.getFullYear();
  const month = String(parsedDate.getMonth() + 1).padStart(2, "0");
  const day = String(parsedDate.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
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

function parseYearsExperience(value) {
  const match = String(value || "").match(/\d+/);

  if (!match) {
    return null;
  }

  return Number(match[0]);
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
      personal.full_name ||
      profile.full_name ||
      doctorIdentity?.doctorDisplayName ||
      "",

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
      professional.contact_number ||
      profile.contact_number ||
      doctorIdentity?.doctorContactNumber ||
      "",

    accountStatus:
      profile.account_status ||
      defaultDoctorSettings.accountStatus,

    avatarUrl:
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
const AUTH_REQUEST_TIMEOUT_MS = 45000;
const EMAIL_CHANGE_SEND_FALLBACK_MS = 6000;
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

function isStrongPassword(value) {
  const password = String(value ?? "");

  return (
    password.length >= 8 &&
    /[A-Za-z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

function normalizeOtp(value) {
  return String(value ?? "").replace(/\D/g, "").slice(0, 6);
}

function withAuthTimeout(promise, label) {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(
        new Error(
          `${label} is taking longer than expected. Please try again.`
        )
      );
    }, AUTH_REQUEST_TIMEOUT_MS);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    window.clearTimeout(timeoutId);
  });
}

function sendEmailChangeWithFallback(newEmail) {
  let timeoutId;
  const updatePromise = supabase.auth.updateUser({ email: newEmail });
  const fallbackPromise = new Promise((resolve) => {
    timeoutId = window.setTimeout(() => {
      resolve({ data: null, error: null, didFallback: true });
    }, EMAIL_CHANGE_SEND_FALLBACK_MS);
  });

  return Promise.race([updatePromise, fallbackPromise]).finally(() => {
    window.clearTimeout(timeoutId);
    updatePromise.catch((error) => {
      console.warn("Late doctor email-change response failed:", error);
    });
  });
}

function getFriendlyAuthError(error) {
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

  return error?.message || "The request could not be completed.";
}


function nullableText(value) {
  const cleanedValue = String(value ?? "").trim();
  return cleanedValue || null;
}

async function getAuthenticatedDoctorUser() {
  const authenticatedDoctor = await loadAuthenticatedDoctor();
  return authenticatedDoctor.authUser;
}

async function saveDoctorInformationRecords(
  nextSettings,
  suppliedUser = null
) {
  const authenticatedDoctor = await loadAuthenticatedDoctor();
  const user = suppliedUser || authenticatedDoctor.authUser;

  if (user.id !== authenticatedDoctor.authUser.id) {
    throw new Error("The supplied account does not match the authenticated Doctor.");
  }

  const birthdateText = String(
    nextSettings.birthdate ?? ""
  ).trim();
  const parsedBirthdate = parseDateForDatabase(birthdateText);

  if (birthdateText && !parsedBirthdate) {
    throw new Error(
      "Enter a valid birthdate, such as January 1, 2003 or 2003-01-01."
    );
  }

  const parsedYears =
    parseYearsExperience(nextSettings.yearsExperience) ?? 0;

  if (parsedYears < 0 || parsedYears > 100) {
    throw new Error(
      "Years of experience must be between 0 and 100."
    );
  }

  const confirmedEmail =
    normalizeEmail(user.email) ||
    normalizeEmail(nextSettings.email) ||
    null;

  const personalPayload = {
    auth_user_id: user.id,
    full_name:
      nullableText(nextSettings.displayName) ||
      authenticatedDoctor.doctorDisplayName,
    birthdate: parsedBirthdate,
    civil_status: nullableText(nextSettings.civilStatus),
    gender: nullableText(nextSettings.gender),
    nationality: nullableText(nextSettings.nationality),
    years_of_experience: parsedYears,
  };

  const professionalPayload = {
    auth_user_id: user.id,
    doctor_code: nullableText(nextSettings.doctorId),
    board_certification: nullableText(
      nextSettings.boardCertification
    ),
    license_number: nullableText(nextSettings.licenseNumber),
    email_address: confirmedEmail,
    clinic_hospital_name: nullableText(nextSettings.clinicName),
    contact_number: nullableText(nextSettings.contactNumber),
    clinic_address: nullableText(nextSettings.clinicAddress),
  };

  const [personalResult, professionalResult] = await Promise.all([
    supabase
      .from(DOCTOR_PERSONAL_INFORMATION_TABLE)
      .upsert(personalPayload, {
        onConflict: "auth_user_id",
      })
      .select("id, auth_user_id")
      .single(),

    supabase
      .from(DOCTOR_PROFESSIONAL_INFORMATION_TABLE)
      .upsert(professionalPayload, {
        onConflict: "auth_user_id",
      })
      .select("id, auth_user_id")
      .single(),
  ]);

  if (personalResult.error) {
    throw new Error(
      `Unable to save personal information: ${personalResult.error.message}`
    );
  }

  if (professionalResult.error) {
    throw new Error(
      `Unable to save professional information: ${professionalResult.error.message}`
    );
  }

  // Keep the shared profile values synchronized for the dashboard header
  // and other Doctor pages. The two doctor information tables remain the
  // source used by this Settings page.
  const { error: sharedProfileError } = await supabase
    .from("profiles")
    .update({
      full_name: personalPayload.full_name,
      email: confirmedEmail,
      contact_number: professionalPayload.contact_number,
    })
    .eq("id", user.id);

  if (sharedProfileError) {
    console.warn(
      "Doctor information was saved, but the shared profile was not synchronized:",
      sharedProfileError
    );
  }

  return user;
}

function DoctorSettingsContent({ headerAction = null, doctorIdentity = null }) {
  const navigate = useNavigate();
  const [activePanel, setActivePanel] = React.useState("profile");
  const [editingProfileCards, setEditingProfileCards] = React.useState({
    personal: false,
    professional: false,
  });
  const [settings, setSettings] = React.useState(() =>
    createDoctorSettingsSnapshot(doctorIdentity, [])
  );
  const [message, setMessage] = React.useState("");
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
  const identityUnavailable = Boolean(
    doctorIdentity?.loading || doctorIdentity?.error
  );

  const notifyDoctorProfileUpdated = React.useCallback(() => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("doctor-settings-updated"));
    }
  }, []);

  React.useEffect(() => {
    if (
      doctorIdentity?.loading ||
      doctorIdentity?.error ||
      !doctorIdentity?.authUser?.id
    ) {
      return;
    }

    setSettings((current) => {
      const alreadyHasResolvedProfileData = Boolean(
        current.displayName ||
        current.email ||
        current.doctorId ||
        current.licenseNumber ||
        current.boardCertification ||
        current.clinicName ||
        current.contactNumber
      );

      if (alreadyHasResolvedProfileData) {
        return current;
      }

      return createDoctorSettingsSnapshot(
        doctorIdentity,
        current.availability
      );
    });
  }, [doctorIdentity]);

  React.useEffect(() => {
    let isCancelled = false;

    const loadSettings = async () => {
      setIsLoading(true);
      setMessage("");
      setAvailabilityError("");

      let authenticatedDoctor;

      try {
        authenticatedDoctor = await loadAuthenticatedDoctor();
      } catch (identityError) {
        if (!isCancelled) {
          setIsLoading(false);
          setMessage(identityError.message);
        }
        return;
      }

      if (isCancelled) {
        return;
      }

      /*
       * Show the already-resolved Doctor profile immediately.
       *
       * Previously the page waited for the availability query before
       * populating Settings, so every empty field rendered as "Not set"
       * for a moment. Applying the identity first keeps Profile and
       * Account information stable while availability loads.
       */
      setSettings((current) =>
        createDoctorSettingsSnapshot(
          authenticatedDoctor,
          current.availability
        )
      );

      const user = authenticatedDoctor.authUser;

      const availabilityResult = await supabase
        .from("user_availability")
        .select(
          "day_of_week, start_time, end_time, is_available"
        )
        .eq("profile_id", user.id)
        .order("day_of_week", { ascending: true });

      if (isCancelled) {
        return;
      }

      const loadedAvailability = mapAvailabilityRows(
        availabilityResult.data
      );

      setSettings(
        createDoctorSettingsSnapshot(
          authenticatedDoctor,
          loadedAvailability
        )
      );

      setIsLoading(false);
      setAvailabilityError(availabilityResult.error?.message || "");

      const secondaryErrors = [availabilityResult.error].filter(Boolean);

      if (secondaryErrors.length > 0) {
        setMessage(
          `Some Doctor settings could not be loaded: ${secondaryErrors
            .map((error) => error.message)
            .join(" ")}`
        );
      }
    };

    loadSettings();

    return () => {
      isCancelled = true;
    };
  }, []);

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

  const redirectToLoginAfterEmailChange = React.useCallback(() => {
    window.setTimeout(async () => {
      try {
        await withAuthTimeout(supabase.auth.signOut(), "Sign out");
      } catch (error) {
        console.error("Sign out after doctor email change failed:", error);
      } finally {
        navigate("/login?emailChanged=1", { replace: true });
      }
    }, 300);
  }, [navigate]);

  const redirectToLoginAfterPasswordChange = React.useCallback(() => {
    window.setTimeout(async () => {
      try {
        await withAuthTimeout(supabase.auth.signOut(), "Sign out");
      } catch (error) {
        console.error("Sign out after doctor password change failed:", error);
      } finally {
        navigate("/login?logout=1", { replace: true });
      }
    }, 1200);
  }, [navigate]);

  React.useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event !== "USER_UPDATED") {
        return;
      }

      const confirmedEmail = normalizeEmail(session?.user?.email);
      const pendingEmail = normalizeEmail(changeEmailState.pendingEmail);

      if (
        !confirmedEmail ||
        !changeEmailState.isOpen ||
        !pendingEmail ||
        confirmedEmail !== pendingEmail
      ) {
        return;
      }

      setChangeEmailState((current) => ({
        ...current,
        step: "complete",
        isLoading: false,
        error: "",
        success: "Email changed successfully.",
        currentEmailVerified: true,
        newEmailVerified: true,
      }));

      const nextSettings = {
        ...settings,
        email: confirmedEmail,
        emailVerification: "Verified",
      };

      window.setTimeout(async () => {
        const profileError = await syncProfileRecord(
          nextSettings,
          session?.user || null
        );

        if (profileError) {
          setMessage(
            `The login email changed, but profile sync failed: ${profileError.message}`
          );
          return;
        }

        setSettings(nextSettings);
        notifyDoctorProfileUpdated();
        setMessage("Email changed successfully. Please log in again.");
        redirectToLoginAfterEmailChange();
      }, 0);
    });

    return () => data.subscription.unsubscribe();
  }, [
    changeEmailState.isOpen,
    changeEmailState.pendingEmail,
    redirectToLoginAfterEmailChange,
    notifyDoctorProfileUpdated,
    settings,
  ]);

  const updateSetting = (field, value) => {
    setSettings((current) => ({
      ...current,
      [field]: value,
    }));
    setMessage("");
  };

  const syncProfileRecord = async (
    nextSettings,
    suppliedUser = null
  ) => {
    try {
      await saveDoctorInformationRecords(
        nextSettings,
        suppliedUser
      );
      return null;
    } catch (error) {
      return error;
    }
  };

  const saveProfileSettings = async (event) => {
    event.preventDefault();
    setIsSaving(true);
    setMessage("");

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      setIsSaving(false);
      setMessage(
        userError?.message ||
          "No authenticated account was found."
      );
      return;
    }

    if (normalizeEmail(settings.email) !== normalizeEmail(user.email)) {
      setIsSaving(false);
      setMessage("Use Account > Change Email to update your login email with OTP verification.");
      return;
    }

    const nextSettings = {
      ...settings,
      displayName:
        settings.displayName.trim() ||
        doctorIdentity?.doctorDisplayName ||
        "Doctor",
      email:
        normalizeEmail(user.email) ||
        defaultDoctorSettings.email,
      yearsExperience:
        formatYearsExperience(
          parseYearsExperience(settings.yearsExperience)
        ) || defaultDoctorSettings.yearsExperience,
    };

    const profileError = await syncProfileRecord(nextSettings);

    setIsSaving(false);

    if (profileError) {
      setMessage(`Unable to save profile: ${profileError.message}`);
      return;
    }

    setSettings(nextSettings);
    notifyDoctorProfileUpdated();
    setEditingProfileCards({
      personal: false,
      professional: false,
    });
    setMessage(
      "Personal and professional information saved to Supabase."
    );
  };

  const saveAccountSettings = async (event) => {
    event.preventDefault();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      setMessage(
        userError?.message ||
          "No authenticated account was found."
      );
      return;
    }

    if (normalizeEmail(settings.email) !== normalizeEmail(user.email)) {
      setMessage("Use Change Email to update your login email with OTP verification.");
      return;
    }

    const nextSettings = {
      ...settings,
      email:
        normalizeEmail(user.email) ||
        defaultDoctorSettings.email,
      contactNumber:
        settings.contactNumber.trim() ||
        defaultDoctorSettings.contactNumber,
    };

    setIsSaving(true);
    setMessage("");

    const profileError = await syncProfileRecord(nextSettings);

    setIsSaving(false);

    if (profileError) {
      setMessage(
        `Unable to save account information: ${profileError.message}`
      );
      return;
    }

    setSettings(nextSettings);
    notifyDoctorProfileUpdated();
    setMessage(
      "Account information and Doctor contact details saved to Supabase."
    );
  };

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

  const changeEmail = async () => {
    setMessage("");

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user) {
      setMessage(error?.message || "No authenticated account was found.");
      return;
    }

    setChangeEmailState({
      ...CHANGE_EMAIL_INITIAL_STATE,
      isOpen: true,
      currentEmail: normalizeEmail(user.email),
      newEmail: normalizeEmail(settings.email),
    });
  };

  const closeChangeEmailModal = () => {
    if (changeEmailState.isLoading) {
      return;
    }

    setChangeEmailState(CHANGE_EMAIL_INITIAL_STATE);
  };

  const requestEmailChangeOtp = async (event) => {
    event?.preventDefault();

    setChangeEmailState((current) => ({
      ...current,
      step: "details",
      isLoading: true,
      error: "",
      success: "",
      currentEmailOtp: "",
      newEmailOtp: "",
      currentEmailVerified: false,
      newEmailVerified: false,
    }));

    try {
      const {
        data: { user },
        error,
      } = await withAuthTimeout(supabase.auth.getUser(), "Account lookup");

      if (error || !user) {
        throw error || new Error("No authenticated account was found.");
      }

      const currentEmail = normalizeEmail(user.email);
      const newEmail = normalizeEmail(changeEmailState.newEmail);

      if (!currentEmail) {
        throw new Error("The current doctor account does not have a login email.");
      }

      if (!changeEmailState.currentPassword) {
        throw new Error("Enter your current password.");
      }

      if (!isValidEmail(newEmail)) {
        throw new Error("Enter a valid new email address.");
      }

      if (newEmail === currentEmail) {
        throw new Error("The new email is the same as your current login email.");
      }

      const { error: verifyPasswordError } = await withAuthTimeout(
        supabase.auth.signInWithPassword({
          email: currentEmail,
          password: changeEmailState.currentPassword,
        }),
        "Password verification"
      );

      if (verifyPasswordError) {
        throw verifyPasswordError;
      }

      const { error: updateEmailError, didFallback } =
        await sendEmailChangeWithFallback(newEmail);

      if (updateEmailError) {
        throw updateEmailError;
      }

      setChangeEmailState((current) => ({
        ...current,
        step: "currentOtp",
        currentEmail,
        pendingEmail: newEmail,
        currentPassword: "",
        isLoading: false,
        error: "",
        success: didFallback
          ? "OTP request sent. Check the 6-digit code sent to your current email first."
          : "OTP sent. Check the 6-digit code sent to your current email first.",
        currentOtpCooldown: OTP_COOLDOWN_SECONDS,
        newOtpCooldown: OTP_COOLDOWN_SECONDS,
      }));
    } catch (error) {
      console.error("Doctor email change request failed:", error);

      setChangeEmailState((current) => ({
        ...current,
        step: "details",
        isLoading: false,
        error: getFriendlyAuthError(error),
      }));
    }
  };

  const verifyEmailChangeOtp = async (target) => {
    const isCurrentEmailStep = target === "current";
    const pendingEmail = normalizeEmail(changeEmailState.pendingEmail);
    const token = normalizeOtp(
      isCurrentEmailStep
        ? changeEmailState.currentEmailOtp
        : changeEmailState.newEmailOtp
    );

    if (!token) {
      setChangeEmailState((current) => ({
        ...current,
        error: "Enter the OTP code first.",
        success: "",
      }));
      return;
    }

    if (isCurrentEmailStep) {
      setChangeEmailState((current) => ({
        ...current,
        step: "newOtp",
        isLoading: false,
        currentEmailVerified: true,
        currentEmailOtp: "",
        error: "",
        success: "Current email code accepted. Now enter the 6-digit code sent to the new email.",
      }));
      return;
    }

    setChangeEmailState((current) => ({
      ...current,
      isLoading: true,
      error: "",
      success: "",
    }));

    try {
      if (!pendingEmail) {
        throw new Error("The new email was not found. Please start the email change again.");
      }

      const { data: verifyData, error: verifyError } = await withAuthTimeout(
        supabase.auth.verifyOtp({
          email: pendingEmail,
          token,
          type: "email_change",
        }),
        "New email OTP verification"
      );

      if (verifyError) {
        throw verifyError;
      }

      const confirmedEmail = pendingEmail;
      const nextSettings = {
        ...settings,
        email: confirmedEmail,
        emailVerification: "Verified",
      };
      const confirmedUser =
        verifyData?.user ||
        verifyData?.session?.user ||
        (await getAuthenticatedDoctorUser());

      const profileError = await syncProfileRecord(
        nextSettings,
        confirmedUser
      );

      if (profileError) {
        throw profileError;
      }

      setSettings(nextSettings);
      notifyDoctorProfileUpdated();
      setMessage("Email changed successfully. Please log in again.");
      setChangeEmailState((current) => ({
        ...current,
        step: "complete",
        isLoading: false,
        error: "",
        success: "Email changed successfully.",
        newEmailVerified: true,
        newEmailOtp: "",
      }));
      redirectToLoginAfterEmailChange();
    } catch (error) {
      console.error("Doctor email change OTP verification failed:", error);

      setChangeEmailState((current) => ({
        ...current,
        isLoading: false,
        error: getFriendlyAuthError(error),
      }));
    }
  };

  const resendEmailChangeOtp = async (target) => {
    const isCurrentEmailStep = target === "current";
    const cooldownField = isCurrentEmailStep
      ? "currentOtpCooldown"
      : "newOtpCooldown";
    const email = isCurrentEmailStep
      ? normalizeEmail(changeEmailState.currentEmail)
      : normalizeEmail(changeEmailState.pendingEmail);

    if (changeEmailState[cooldownField] > 0) {
      return;
    }

    setChangeEmailState((current) => ({
      ...current,
      isLoading: true,
      error: "",
      success: "",
    }));

    try {
      const { error } = await withAuthTimeout(
        supabase.auth.resend({
          type: "email_change",
          email,
        }),
        "Resending OTP"
      );

      if (error) {
        throw error;
      }

      setChangeEmailState((current) => ({
        ...current,
        isLoading: false,
        error: "",
        success: `OTP resent to ${isCurrentEmailStep ? "current email" : "new email"}.`,
        [cooldownField]: OTP_COOLDOWN_SECONDS,
      }));
    } catch (error) {
      console.error("Doctor email change OTP resend failed:", error);

      setChangeEmailState((current) => ({
        ...current,
        isLoading: false,
        error: getFriendlyAuthError(error),
      }));
    }
  };

  const handlePasswordSubmit = async (event) => {
    event.preventDefault();

    if (
      !passwordForm.currentPassword ||
      !passwordForm.newPassword ||
      !passwordForm.confirmPassword
    ) {
      setMessage("Complete all password fields.");
      return;
    }

    if (!isStrongPassword(passwordForm.newPassword)) {
      setMessage("Password must be at least 8 characters and include letters, numbers, and symbols.");
      return;
    }

    if (
      passwordForm.newPassword !==
      passwordForm.confirmPassword
    ) {
      setMessage(
        "New password and confirmation do not match."
      );
      return;
    }

    setIsSaving(true);
    setMessage("");

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      setIsSaving(false);
      setMessage(
        userError?.message ||
          "No authenticated account was found."
      );
      return;
    }

    if (user.email) {
      const { error: signInError } =
        await withAuthTimeout(
          supabase.auth.signInWithPassword({
            email: user.email,
            password: passwordForm.currentPassword,
          }),
          "Password verification"
        );

      if (signInError) {
        setIsSaving(false);
        setMessage("Current password is incorrect.");
        return;
      }
    }

    const passwordRedirectTo =
      typeof window === "undefined"
        ? undefined
        : new URL("/doctor/settings", window.location.origin).toString();

    const { error } = await withAuthTimeout(
      supabase.auth.resetPasswordForEmail(user.email, {
        redirectTo: passwordRedirectTo,
      }),
      "Password OTP request"
    );

    setIsSaving(false);

    if (error) {
      setMessage(getFriendlyAuthError(error));
      return;
    }

    setChangePasswordOtp({
      ...CHANGE_PASSWORD_INITIAL_STATE,
      isOpen: true,
      currentEmail: normalizeEmail(user.email),
      pendingNewPassword: passwordForm.newPassword,
      success:
        "OTP sent to your current email. Enter the 6-digit code to finish changing your password.",
      otpCooldown: OTP_COOLDOWN_SECONDS,
    });
  };

  const closeChangePasswordOtpModal = () => {
    if (changePasswordOtp.isLoading) {
      return;
    }

    setChangePasswordOtp(CHANGE_PASSWORD_INITIAL_STATE);
  };

  const resendPasswordChangeOtp = async () => {
    if (changePasswordOtp.otpCooldown > 0) {
      return;
    }

    setChangePasswordOtp((current) => ({
      ...current,
      isLoading: true,
      loadingLabel: "Sending OTP...",
      error: "",
      success: "",
    }));

    try {
      const email = normalizeEmail(changePasswordOtp.currentEmail);

      if (!email) {
        throw new Error("The current account does not have an email address.");
      }

      const passwordRedirectTo =
        typeof window === "undefined"
          ? undefined
          : new URL("/doctor/settings", window.location.origin).toString();

      const { error } = await withAuthTimeout(
        supabase.auth.resetPasswordForEmail(email, {
          redirectTo: passwordRedirectTo,
        }),
        "Password OTP resend"
      );

      if (error) {
        throw error;
      }

      setChangePasswordOtp((current) => ({
        ...current,
        isLoading: false,
        loadingLabel: "",
        error: "",
        success: "OTP resent to your current email.",
        otpCooldown: OTP_COOLDOWN_SECONDS,
      }));
    } catch (error) {
      console.error("Doctor password OTP resend failed:", error);

      setChangePasswordOtp((current) => ({
        ...current,
        isLoading: false,
        loadingLabel: "",
        error: getFriendlyAuthError(error),
      }));
    }
  };

  const verifyPasswordOtpAndUpdate = async () => {
    const token = normalizeOtp(changePasswordOtp.otp);
    const email = normalizeEmail(changePasswordOtp.currentEmail);

    if (!token) {
      setChangePasswordOtp((current) => ({
        ...current,
        error: "Enter the OTP code first.",
        success: "",
      }));
      return;
    }

    setChangePasswordOtp((current) => ({
      ...current,
      isLoading: true,
      loadingLabel: "Verifying OTP...",
      error: "",
      success: "Verifying OTP...",
    }));

    try {
      if (!email) {
        throw new Error("The current account does not have an email address.");
      }

      if (!isStrongPassword(changePasswordOtp.pendingNewPassword)) {
        throw new Error("Password must be at least 8 characters and include letters, numbers, and symbols.");
      }

      const { error: verifyOtpError } = await withAuthTimeout(
        supabase.auth.verifyOtp({
          email,
          token,
          type: "recovery",
        }),
        "Password OTP verification"
      );

      if (verifyOtpError) {
        throw verifyOtpError;
      }

      setChangePasswordOtp((current) => ({
        ...current,
        loadingLabel: "Updating password...",
        success: "OTP verified. Updating your password...",
      }));

      const { error: updatePasswordError } = await withAuthTimeout(
        supabase.auth.updateUser({
          password: changePasswordOtp.pendingNewPassword,
        }),
        "Password update"
      );

      if (updatePasswordError) {
        throw updatePasswordError;
      }

      setPasswordForm({
        currentPassword: "",
        newPassword: "",
        confirmPassword: "",
      });

      setChangePasswordOtp((current) => ({
        ...current,
        step: "complete",
        otp: "",
        pendingNewPassword: "",
        isLoading: true,
        loadingLabel: "Signing out...",
        error: "",
        success: "Password updated successfully. Signing you out now.",
      }));

      setMessage("Password updated successfully. Please log in again.");
      redirectToLoginAfterPasswordChange();
    } catch (error) {
      console.error("Doctor password OTP verification failed:", error);

      setChangePasswordOtp((current) => ({
        ...current,
        isLoading: false,
        loadingLabel: "",
        error: getFriendlyAuthError(error),
      }));
    }
  };

  const createScheduleDraft = (day = "Monday") => ({
    day,
    time: "",
    status: "Available",
  });

  const openScheduleEditor = (availabilityItem = null) => {
    setScheduleDraft(
      availabilityItem
        ? { ...availabilityItem }
        : createScheduleDraft()
    );
    setMessage("");
  };

  const saveScheduleDraft = async (event) => {
    event.preventDefault();

    if (!scheduleDraft?.day || !scheduleDraft?.status) {
      setMessage("Complete the schedule details.");
      return;
    }

    const isAvailable =
      scheduleDraft.status === "Available";
    const parsedTimeRange = isAvailable
      ? parseScheduleTimeRange(scheduleDraft.time)
      : null;

    if (isAvailable && !parsedTimeRange) {
      setMessage(
        'Enter a valid time range such as "8:00 AM - 12:00 PM".'
      );
      return;
    }

    const dayOfWeek = getAvailabilityDayIndex(scheduleDraft.day);

    if (dayOfWeek < 0) {
      setMessage("Select a valid day.");
      return;
    }

    setIsSaving(true);
    setMessage("");

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      setIsSaving(false);
      setMessage(
        userError?.message ||
          "No authenticated account was found."
      );
      return;
    }

    const availabilityPayload = {
      profile_id: user.id,
      day_of_week: dayOfWeek,
      start_time: isAvailable
        ? parsedTimeRange.startTime
        : null,
      end_time: isAvailable
        ? parsedTimeRange.endTime
        : null,
      is_available: isAvailable,
    };

    const { error } = await supabase
      .from("user_availability")
      .upsert(availabilityPayload, {
        onConflict: "profile_id,day_of_week",
      });

    setIsSaving(false);

    if (error) {
      setMessage(
        `Unable to save availability: ${error.message}`
      );
      return;
    }

    const savedScheduleItem = isAvailable
      ? {
          ...scheduleDraft,
          time: `${formatDatabaseTime(
            parsedTimeRange.startTime
          )} - ${formatDatabaseTime(
            parsedTimeRange.endTime
          )}`,
          status: "Available",
        }
      : {
          ...scheduleDraft,
          time: "No appointments scheduled",
          status: "Closed",
        };

    const existingSchedule = availability.some(
      (availabilityItem) =>
        availabilityItem.day === savedScheduleItem.day
    );
    const nextAvailability = (
      existingSchedule
        ? availability.map((availabilityItem) =>
            availabilityItem.day === savedScheduleItem.day
              ? savedScheduleItem
              : availabilityItem
          )
        : [...availability, savedScheduleItem]
    ).sort(
      (left, right) =>
        availabilityDayOptions.indexOf(left.day) -
        availabilityDayOptions.indexOf(right.day)
    );

    const nextSettings = {
      ...settings,
      availability: nextAvailability,
    };

    setSettings(nextSettings);
    setScheduleDraft(null);
    setMessage("Schedule availability saved to Supabase.");
  };

  const activeSectionLabel = settingsSections.find((section) => section.id === activePanel)?.label || "Profile";
  const breadcrumbLabel = activePanel === "profile" ? activeSectionLabel : "Account";
  const availability = Array.isArray(settings.availability)
    ? settings.availability
    : [];
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

  const toggleProfileCardEdit = async (card) => {
    if (!editingProfileCards[card]) {
      setEditingProfileCards((current) => ({
        ...current,
        [card]: true,
      }));
      setMessage("");
      return;
    }

    setIsSaving(true);
    setMessage("");

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      setIsSaving(false);
      setMessage(
        userError?.message ||
          "No authenticated account was found."
      );
      return;
    }

    if (normalizeEmail(settings.email) !== normalizeEmail(user.email)) {
      setIsSaving(false);
      setMessage("Use Account > Change Email to update your login email with OTP verification.");
      return;
    }

    const nextSettings = {
      ...settings,
      displayName:
        settings.displayName.trim() ||
        doctorIdentity?.doctorDisplayName ||
        "Doctor",
      email:
        normalizeEmail(user.email) ||
        defaultDoctorSettings.email,
      yearsExperience:
        formatYearsExperience(
          parseYearsExperience(settings.yearsExperience)
        ) || defaultDoctorSettings.yearsExperience,
    };

    const profileError = await syncProfileRecord(nextSettings, user);

    setIsSaving(false);

    if (profileError) {
      setMessage(`Unable to save profile: ${profileError.message}`);
      return;
    }

    setSettings(nextSettings);
    notifyDoctorProfileUpdated();
    setEditingProfileCards((current) => ({
      ...current,
      [card]: false,
    }));
    setMessage(
      `${card === "personal" ? "Personal" : "Professional"} information saved to Supabase.`
    );
  };

  const renderProfileSettingsField = (field, isEditing) => (
    <label className="doctor-settings-info-item" key={field.field}>
      <strong>{field.label}</strong>
      {isEditing ? (
        field.options ? (
          <select value={field.value} onChange={(event) => updateSetting(field.field, event.target.value)}>
            {field.options.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        ) : (
          <input
            type={field.type || "text"}
            value={field.value}
            onChange={(event) => updateSetting(field.field, event.target.value)}
          />
        )
      ) : (
        <span>{field.value || (isLoading ? "Loading..." : "Not set")}</span>
      )}
    </label>
  );

  return (
    <section className="doctor-settings-page" data-panel={activePanel}>
      <header className="doctor-dashboard-header">
        <div>
          <h1>Settings</h1>
          <p className="doctor-settings-breadcrumb">Settings <span>{">"}</span> <b>{breadcrumbLabel}</b></p>
        </div>
        {headerAction ?? <SettingsHeaderAction settings={settings} />}
      </header>

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
            <form className="doctor-settings-profile-form" onSubmit={saveProfileSettings}>
              <header className="doctor-settings-section-header">
                <span><DoctorIcon name="profile" /></span>
                <div>
                  <h2>Profile Settings</h2>
                  <p>Manage your personal and professional information.</p>
                </div>
              </header>

              <div className="doctor-settings-info-stack">
                <section className="doctor-settings-info-card doctor-settings-info-card--personal">
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
                </section>

                <section className="doctor-settings-info-card doctor-settings-info-card--professional">
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
                </section>
              </div>

              <div className="doctor-settings-footer">
                {message ? <p>{message}</p> : <span />}
                <button type="submit" disabled={isSaving || isLoading || identityUnavailable}>{isSaving ? "Saving..." : "Save Changes"}</button>
              </div>
            </form>
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
                    <input type="email" value={settings.email} onChange={(event) => updateSetting("email", event.target.value)} />
                  </label>
                  <label>
                    <span>Contact Number</span>
                    <input value={settings.contactNumber} onChange={(event) => updateSetting("contactNumber", event.target.value)} />
                  </label>
                </div>
                <div className="doctor-settings-inline-actions">
                  <button type="submit" disabled={isSaving || isLoading || identityUnavailable}>{isSaving ? "Saving..." : "Save Changes"}</button>
                  <button type="button" onClick={changeEmail} disabled={isSaving || isLoading || identityUnavailable}>Change Email</button>
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
            <form className="doctor-settings-security-form" onSubmit={handlePasswordSubmit}>
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
                    <label className="doctor-settings-password-field" key={field}>
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
                        onChange={(event) =>
                          setPasswordForm((current) => ({ ...current, [field]: event.target.value }))
                        }
                        disabled={isSaving || changePasswordOtp.isOpen}
                      />
                      <button
                        type="button"
                        aria-label="Toggle password visibility"
                        onClick={() =>
                          setPasswordVisible((current) => ({ ...current, [field]: !current[field] }))
                        }
                      >
                        <DoctorIcon name={passwordVisible[field] ? "eye" : "eyeOff"} />
                      </button>
                    </label>
                  ))}
                  <p className="doctor-settings-password-note">
                    <DoctorIcon name="info" />
                    <span>Password must be at least 8 characters with a combination of letters, numbers and symbols.</span>
                  </p>
                  <button className="doctor-settings-save-password" type="submit" disabled={isSaving || isLoading || identityUnavailable || changePasswordOtp.isOpen}>
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
                  onClick={() => openScheduleEditor(availability[0] || null)}
                  disabled={isLoading || Boolean(availabilityError) || isSaving}
                >
                  <DoctorIcon name="calendarEdit" />
                  <span>{availability.length > 0 ? "Edit Schedule" : "Configure Schedule"}</span>
                </button>
              </header>

              <div className="doctor-settings-schedule-table">
                <h3>WEEKLY SCHEDULE</h3>
                <div className="doctor-settings-schedule-head">
                  <span>Day</span>
                  <span>Time</span>
                  <span>Status</span>
                </div>
                {isLoading ? (
                  <div className="doctor-settings-schedule-empty">
                    <DoctorIcon name="clock" />
                    <div>
                      <strong>Loading availability...</strong>
                      <p>Retrieving the saved schedule from Supabase.</p>
                    </div>
                  </div>
                ) : availabilityError ? (
                  <div className="doctor-settings-schedule-empty">
                    <DoctorIcon name="info" />
                    <div>
                      <strong>Availability could not be loaded</strong>
                      <p>Refresh the page to try loading the saved schedule again.</p>
                    </div>
                  </div>
                ) : availability.length > 0 ? (
                  availability.map((item) => (
                    <button
                      type="button"
                      className={item.status === "Closed" ? "is-closed" : ""}
                      key={item.day}
                      onClick={() => openScheduleEditor(item)}
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
          >
            <header className="doctor-otp-modal-header">
              <div>
                <span className="doctor-otp-modal-icon">
                  <DoctorIcon name="mail" />
                </span>
                <div>
                  <h2 id="doctor-change-email-title">Change Email</h2>
                  <p>Securely verify your password and both email OTP codes.</p>
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
              <p className="doctor-otp-modal-message is-error">
                {changeEmailState.error}
              </p>
            ) : null}

            {changeEmailState.success ? (
              <p className="doctor-otp-modal-message is-success">
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
              <p className="doctor-otp-modal-message is-error">{changePasswordOtp.error}</p>
            ) : null}

            {changePasswordOtp.success ? (
              <p className="doctor-otp-modal-message is-success">{changePasswordOtp.success}</p>
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
        <div className="doctor-settings-edit-overlay" role="dialog" aria-modal="true" aria-labelledby="doctor-schedule-edit-title">
          <form className="doctor-settings-edit-modal" onSubmit={saveScheduleDraft}>
            <button type="button" aria-label="Close schedule editor" onClick={() => setScheduleDraft(null)}>X</button>
            <h2 id="doctor-schedule-edit-title">Edit Schedule</h2>

            <label>
              Select Day:
              <select
                value={scheduleDraft.day}
                onChange={(event) => {
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
                value={scheduleDraft.time}
                onChange={(event) => setScheduleDraft((current) => ({ ...current, time: event.target.value }))}
              />
            </label>

            <label>
              Status
              <select
                value={scheduleDraft.status}
                onChange={(event) => setScheduleDraft((current) => ({ ...current, status: event.target.value }))}
              >
                <option>Available</option>
                <option>Closed</option>
              </select>
            </label>

            <div>
              <button type="submit">Save</button>
              <button type="button" onClick={() => setScheduleDraft(null)}>Cancel</button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}

export default DoctorSettingsContent;
