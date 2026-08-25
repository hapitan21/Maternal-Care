import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { QRCodeCanvas } from "qrcode.react";
import { useLocation, useNavigate } from "react-router-dom";
import { buildPatientAccessUrl } from "../../lib/patientAccessUrl";
import {
  getPatientAccountStatusLabel,
  isPatientRecordArchived,
  normalizePatientAccountStatus,
  patientAccountStatuses,
} from "../../lib/patientAccountStatus";
import {
  formatAppointmentDate,
  formatAppointmentTime,
  getManilaDateKey,
  getManilaTimeKey,
  toManilaISOString,
} from "../../lib/appointmentDate";
import { getAvailabilityDayOfWeek } from "../../lib/availabilitySchedule";
import { supabase } from "../../lib/supabaseClient";
import { sendAutomaticAppointmentNotification } from "../../lib/automaticAppointmentNotification";
import SendPatientNotificationAction from "../../components/notifications/SendPatientNotificationAction";
import "../../styles/doctor-patients.css";
import "../../styles/patient-record-ui-system.css";
import {
  PatientDirectoryHeader,
  PatientDirectorySearch,
  PatientDirectoryToolbar,
  PatientTableShell,
} from "../../components/patients/PatientDirectoryUi";
import "../../styles/staff-patients.css";

const patientLoginSelectColumns =
  "id, patient_record_id, full_name, patient_id, control_number, email, status, created_at";
const patientStatusFilters = [
  "All",
  "Active",
  "Pending Activation",
  "Not Linked",
  "Inactive",
  "Archived",
];

const staffPatientNotificationTypes = [
  "general",
  "appointment_created",
  "appointment_reminder",
  "appointment_rescheduled",
  "appointment_cancelled",
];
const staffRegistrationSessionKey = "maternal_staff_patient_registration";
const staffWalkInSlotSessionKey = "maternal_staff_walkin_registration_slot";
const steps = [
  { id: 1, label: "Basic Information" },
  { id: 2, label: "Reproductive and Obstetric" },
  { id: 3, label: "Medical & Family History" },
];

const blankForm = {
  name: "",
  age: "",
  birthdate: "",
  address: "",
  contactNumber: "",
  occupation: "",
  workAddress: "",
  company: "",
  workContactNumber: "",
  email: "",
  husbandPartner: "",
  partnerContactNumber: "",

  ageMenarche: "",
  menstrualPattern: "Regular",
  cycleLength: "",
  durationMenstruation: "",
  sexuallyActive: "Yes",
  contraceptiveMethod: "",
  gravida: "",
  para: "",
  lmp: "",
  edd: "",
  pregnancyRecords: [],

  bloodType: "",
  allergies: [],
  allergyOne: "",
  allergyTwo: "",
  allergyThree: "",
  medicalConditions: [],
  medicalOther: "",
  familyHistory: [],
  familyOther: "",
  maternalFamilyHistory: [],
  maternalFamilyOther: "",
  paternalFamilyHistory: [],
  paternalFamilyOther: "",
};

const contraceptiveMethodOptions = [
  "None",
  "Oral Contraceptive Pill",
  "Injectable Contraceptive",
  "Contraceptive Implant",
  "Hormonal IUD",
  "Copper IUD",
  "Male Condom",
  "Female Condom",
  "Diaphragm",
  "Cervical Cap",
  "Contraceptive Patch",
  "Vaginal Ring",
  "Emergency Contraceptive Pill",
  "Natural Family Planning",
  "Withdrawal Method",
  "Lactational Amenorrhea Method (LAM)",
  "Tubal Ligation",
  "Partner Vasectomy",
];

const bloodTypeOptions = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

const allergyTypeOptions = [
  { value: "medication", label: "Medication Allergy", icon: "solar:pill-linear" },
  { value: "food", label: "Food Allergy", icon: "solar:chef-hat-linear" },
  { value: "environmental", label: "Environmental Allergy", icon: "solar:earth-linear" },
  { value: "insect", label: "Insect Allergy", icon: "solar:bug-linear" },
  { value: "latex", label: "Latex Allergy", icon: "solar:hand-heart-linear" },
  { value: "chemical", label: "Chemical Allergy", icon: "solar:test-tube-linear" },
];

const pregnancyRecordTemplate = {
  id: "",
  birthdate: "",
  termPreterm: "",
  deliveryType: "",
  deliveryPlace: "",
  complications: "",
  nbsResult: "",
};

const allergyRecordTemplate = {
  id: "",
  type: "",
  allergen: "",
  reaction: "",
};

const defaultWalkInTimes = [
  "08:00",
  "09:00",
  "10:30",
  "11:30",
  "13:00",
  "14:30",
  "15:30",
];

const inactiveAccountStatuses = new Set([
  "inactive",
  "deactivated",
  "disabled",
  "archived",
  "deleted",
]);

const occupyingAppointmentStatuses = new Set([
  "scheduled",
  "pending",
  "accepted",
  "checked_in",
  "checked in",
  "completed",
  "complete",
  "done",
  "rescheduled",
]);

function isMissingWalkInRpcError(error) {
  if (!error) return false;
  const message = `${error.message || ""} ${error.details || ""}`.toLowerCase();
  return (
    error.code === "42883" ||
    error.code === "PGRST202" ||
    message.includes("could not find the function") ||
    message.includes("schema cache")
  );
}

function logWalkInAvailabilityError(error) {
  console.error("Load walk-in availability failed:", {
    code: error?.code || "",
    message: error?.message || "",
    details: error?.details || "",
    hint: error?.hint || "",
  });
}

function normalizeWalkInSlots(slots) {
  if (Array.isArray(slots)) return slots;
  if (typeof slots !== "string") return [];

  try {
    const parsedSlots = JSON.parse(slots);
    return Array.isArray(parsedSlots) ? parsedSlots : [];
  } catch {
    return [];
  }
}

function normalizeSlotStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (["cancel", "cancelled", "canceled", "no_show", "no show"].includes(normalized)) {
    return "open";
  }
  return occupyingAppointmentStatuses.has(normalized) ? "occupied" : "open";
}

function timeToMinutes(value) {
  const [hour, minute] = String(value || "")
    .slice(0, 5)
    .split(":")
    .map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

function isTimeWithinRange(timeValue, startValue, endValue) {
  const time = timeToMinutes(timeValue);
  const start = timeToMinutes(startValue);
  const end = timeToMinutes(endValue);
  if (time === null || start === null || end === null) return false;
  return time >= start && time < end;
}

function getManilaDateTime(dateValue, timeValue) {
  const iso = toManilaISOString(dateValue, timeValue);
  return iso ? new Date(iso) : null;
}

function hasSlotPassed(dateValue, timeValue) {
  if (dateValue !== getManilaDateKey()) return false;
  const slotDate = getManilaDateTime(dateValue, timeValue);
  return slotDate ? slotDate.getTime() <= Date.now() : false;
}

function formatSlotTime(dateValue, timeValue) {
  return formatAppointmentTime(toManilaISOString(dateValue, timeValue));
}

function formatSelectedWalkInDate(dateValue) {
  if (!dateValue) return "";
  const label = formatAppointmentDate(`${dateValue}T00:00:00+08:00`);
  return dateValue === getManilaDateKey() ? `Today, ${label}` : label;
}

function normalizeWalkInTime(value) {
  return String(value || "").slice(0, 5);
}

function getWalkInReservationTimeLeft(expiresAt, now = Date.now()) {
  const expiresAtMs = Date.parse(expiresAt || "");
  if (!Number.isFinite(expiresAtMs)) return "";

  const secondsLeft = Math.max(0, Math.ceil((expiresAtMs - now) / 1000));
  if (secondsLeft <= 0) return "Reservation expired";

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  return minutes > 0
    ? `Expires in ${minutes}m ${String(seconds).padStart(2, "0")}s`
    : `Expires in ${seconds}s`;
}

function mapDoctorDisplayName(profile, personal) {
  return (
    cleanText(personal?.full_name) ||
    cleanText(profile?.full_name) ||
    cleanText(profile?.email) ||
    "Doctor"
  );
}

function getDoctorSpecialization(professional) {
  return (
    cleanText(professional?.board_certification) ||
    cleanText(professional?.clinic_hospital_name) ||
    "Obstetrician - Gynecologist"
  );
}

function buildFallbackSlots({ dateValue, availability, appointments }) {
  if (!availability?.is_available || !availability.start_time || !availability.end_time) {
    return [];
  }

  const candidates = defaultWalkInTimes.filter((time) =>
    isTimeWithinRange(time, availability.start_time, availability.end_time)
  );
  const occupiedByTime = new Map();

  appointments.forEach((appointment) => {
    const time = getManilaDateKey(appointment.start_time) === dateValue
      ? getManilaTimeKey(appointment.start_time)
      : "";
    if (time && normalizeSlotStatus(appointment.status) === "occupied") {
      occupiedByTime.set(time, appointment);
    }
  });

  const dailyCapacity = candidates.length;
  const scheduledCount = appointments.filter(
    (appointment) => normalizeSlotStatus(appointment.status) === "occupied"
  ).length;
  const capacityReached = dailyCapacity > 0 && scheduledCount >= dailyCapacity;

  return candidates.map((time) => {
    const occupied = occupiedByTime.get(time);
    const passed = hasSlotPassed(dateValue, time);
    const status = occupied || capacityReached ? "full" : passed ? "unavailable" : "available";

    return {
      id: `${availability.profile_id || "doctor"}-${dateValue}-${time}`,
      doctorId: availability.profile_id,
      date: dateValue,
      time,
      label: formatSlotTime(dateValue, time),
      status,
      description: status === "available" ? "Walk-in Slot" : status === "full" ? "Scheduled Appointment" : "Unavailable",
      appointmentId: occupied?.id || "",
    };
  });
}

function getCredentialPatientId(patient) {
  return patient?.patientId || patient?.patient_id || patient?.id || "";
}

function getCredentialControlNumber(patient) {
  return patient?.controlNumber || patient?.control_number || "";
}

function toCredentialEntry(patient) {
  return {
    patientId: getCredentialPatientId(patient),
    controlNumber: getCredentialControlNumber(patient),
  };
}

function addCredentialsToPool(pool, credentials) {
  const alreadyTracked = pool.some((item) => {
    return (
      getCredentialPatientId(item) === credentials.patientId ||
      getCredentialControlNumber(item) === credentials.controlNumber
    );
  });

  return alreadyTracked ? pool : [...pool, credentials];
}

function generatePatientId(existingPatients = []) {
  const year = new Date().getFullYear();
  const matchingIds = existingPatients
    .map(getCredentialPatientId)
    .filter((id) => typeof id === "string" && id.startsWith(`LP-${year}-`))
    .map((id) => Number(id.split("-").at(-1)))
    .filter((number) => Number.isFinite(number));
  const nextNumber = matchingIds.length
    ? Math.max(...matchingIds) + 1
    : existingPatients.length + 1;

  return `LP-${year}-${String(nextNumber).padStart(5, "0")}`;
}

function generateControlNumber(existingPatients = []) {
  const existingControlNumbers = new Set(
    existingPatients.map(getCredentialControlNumber).filter(Boolean)
  );
  const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const segment = (length) =>
      Array.from({ length }, () =>
        characters[Math.floor(Math.random() * characters.length)]
      ).join("");
    const controlNumber = `LPMRH-${segment(4)}-${segment(4)}`;

    if (!existingControlNumbers.has(controlNumber)) {
      return controlNumber;
    }
  }

  return `LPMRH-${Date.now().toString(36).toUpperCase()}`;
}

function createAccessCredentials(existingPatients = []) {
  return {
    patientId: generatePatientId(existingPatients),
    controlNumber: generateControlNumber(existingPatients),
  };
}

function isMissingPatientLoginTableError(error) {
  if (!error) return false;

  const message = `${error.message || ""} ${error.details || ""}`.toLowerCase();

  return (
    error.code === "42P01" ||
    error.code === "42703" ||
    error.code === "PGRST200" ||
    error.code === "PGRST204" ||
    error.code === "PGRST205" ||
    message.includes("patient_login") ||
    message.includes("could not find the table") ||
    message.includes("could not find the column") ||
    message.includes("schema cache")
  );
}

function isPatientLoginPatientIdConflict(error) {
  if (!error) return false;

  const message = `${error.message || ""} ${error.details || ""}`.toLowerCase();

  return (
    error.code === "23505" &&
    (message.includes("patient_login_patient_id_unique") ||
      message.includes("patient_id_unique") ||
      message.includes("patient_id"))
  );
}

function isPatientLoginPolicyError(error) {
  if (!error) return false;

  const message = `${error.message || ""} ${error.details || ""}`.toLowerCase();

  return (
    error.code === "42501" ||
    (message.includes("row-level security") &&
      message.includes("patient_login"))
  );
}

function isDuplicatePatientCredentialError(error) {
  if (!error) return false;

  const message = `${error.message || ""} ${error.details || ""}`.toLowerCase();

  return (
    error.code === "23505" &&
    (message.includes("patients_patient_id_unique") ||
      message.includes("patients_control_number_unique") ||
      message.includes("patient_id") ||
      message.includes("control_number"))
  );
}

function isSchemaCacheColumnError(error) {
  if (!error) return false;

  const message = `${error.message || ""} ${error.details || ""}`.toLowerCase();

  return (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    message.includes("could not find the") ||
    message.includes("schema cache") ||
    message.includes("column")
  );
}

function getPatientStatusGroup(patient) {
  if (patient?.status === patientAccountStatuses.archived) return "Archived";
  if (patient?.status === patientAccountStatuses.inactive) return "Inactive";
  if (patient?.status === patientAccountStatuses.active) return "Active";
  if (patient?.status === patientAccountStatuses.pending) return "Pending Activation";
  return "Not Linked";
}

function formatPatientStatus(patient) {
  return getPatientAccountStatusLabel(patient?.status);
}

function getPatientStatusClass(patient) {
  return `is-${patient?.status || patientAccountStatuses.unlinked}`;
}

function canSendPatientNotification(patient) {
  return (
    patient?.status === patientAccountStatuses.active &&
    Boolean(patient?.userId) &&
    !patient?.archivedAt
  );
}

async function copyTextToClipboard(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function createStableClientId(prefix = "row") {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 9)}`;
}

function getAllergyTypeLabel(value) {
  return (
    allergyTypeOptions.find((option) => option.value === value)?.label ||
    String(value || "").trim()
  );
}

function createBlankAllergyRecord() {
  return { ...allergyRecordTemplate, id: createStableClientId("allergy") };
}

function createBlankPregnancyRecord() {
  return { ...pregnancyRecordTemplate, id: createStableClientId("pregnancy") };
}

function calculateAgeFromBirthdate(value) {
  if (!value) return "";
  const birthDate = new Date(`${value}T00:00:00`);
  if (Number.isNaN(birthDate.getTime())) return "";

  const today = new Date(`${getManilaDateKey()}T00:00:00`);
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDelta = today.getMonth() - birthDate.getMonth();
  if (
    monthDelta < 0 ||
    (monthDelta === 0 && today.getDate() < birthDate.getDate())
  ) {
    age -= 1;
  }

  return age >= 0 ? String(age) : "";
}

function addDaysToDateInput(value, days) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function isFutureDateInput(value) {
  if (!value) return false;
  const date = new Date(`${value}T00:00:00`);
  const today = new Date(`${getManilaDateKey()}T00:00:00`);
  return !Number.isNaN(date.getTime()) && date > today;
}

function getAgeValueForBirthdate(age, birthdate) {
  if (birthdate) {
    if (isFutureDateInput(birthdate)) return "";
    const calculatedAge = calculateAgeFromBirthdate(birthdate);
    if (calculatedAge) return calculatedAge;
  }

  return String(age || "").replace(/[^\d]/g, "");
}

function omitPayloadFields(payload, fields) {
  return Object.fromEntries(
    Object.entries(payload).filter(([field]) => !fields.includes(field))
  );
}

function getInitials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "PT";
  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function computeAgeLabel(age, birthdate) {
  if (isFutureDateInput(birthdate)) return "Invalid birthdate";
  const cleanAge = getAgeValueForBirthdate(age, birthdate);
  return cleanAge ? `${cleanAge} years old` : "Age not set";
}

function formatBirthdate(value) {
  if (!value) return "Not set";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "2-digit",
    year: "numeric",
  });
}

function parseAgeValue(value) {
  const cleanAge = String(value || "").replace(/[^\d]/g, "");
  return cleanAge ? Number(cleanAge) : null;
}

function parsePatientAgeValue(form) {
  return parseAgeValue(getAgeValueForBirthdate(form.age, form.birthdate));
}

function parseOptionalNumber(value) {
  const match = String(value ?? "")
    .replace(/,/g, "")
    .match(/-?\d+(?:\.\d+)?/);

  if (!match) return null;

  const numberValue = Number(match[0]);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function isNumberInRange(value, min, max) {
  return value === null || (value >= min && value <= max);
}

function cleanText(value) {
  const cleaned = String(value ?? "").trim();
  return cleaned || null;
}

function normalizeStructuredAllergies(form) {
  if (Array.isArray(form.allergies) && form.allergies.length) {
    return form.allergies
      .map((item) => ({
        id: item.id || createStableClientId("allergy"),
        type: String(item.type || "").trim(),
        allergen: String(item.allergen || "").trim(),
        reaction: String(item.reaction || "").trim(),
      }))
      .filter((item) => item.type || item.allergen || item.reaction);
  }

  return [form.allergyOne, form.allergyTwo, form.allergyThree]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .map((item) => ({
      id: createStableClientId("allergy"),
      type: "",
      allergen: item,
      reaction: "",
    }));
}

function formatAllergyEntry(entry) {
  const typeLabel = getAllergyTypeLabel(entry.type);
  return [typeLabel, entry.allergen, entry.reaction]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join(": ");
}

function getAllergyList(form) {
  return normalizeStructuredAllergies(form)
    .map(formatAllergyEntry)
    .filter(Boolean);
}

function createRegistrationDataPayload(form, selectedWalkInSlot) {
  const allergies = normalizeStructuredAllergies(form);
  const legacyAllergyLabels = allergies.map(formatAllergyEntry);

  return {
    ...form,
    allergies,
    allergyOne: legacyAllergyLabels[0] || "",
    allergyTwo: legacyAllergyLabels[1] || "",
    allergyThree: legacyAllergyLabels[2] || "",
    familyHistory: getFamilyHistoryList(form),
    familyOther: getFamilyOtherText(form),
    walkInReservation: selectedWalkInSlot
      ? {
          reservationId: selectedWalkInSlot.reservationId || "",
          doctorId: selectedWalkInSlot.doctorId || "",
          doctorName: selectedWalkInSlot.doctorName || "",
          specialization: selectedWalkInSlot.specialization || "",
          slotDate: selectedWalkInSlot.date || "",
          slotTime: selectedWalkInSlot.time || "",
        }
      : null,
  };
}

function getMedicalConditionList(form) {
  return Array.isArray(form.medicalConditions)
    ? form.medicalConditions.filter(Boolean)
    : [];
}

function getFamilySideHistory(form, side) {
  const field = side === "Mother" ? "maternalFamilyHistory" : "paternalFamilyHistory";
  if (Array.isArray(form[field])) return form[field].filter(Boolean);

  const prefix = `${side}: `;
  const legacyHistory = Array.isArray(form.familyHistory)
    ? form.familyHistory.filter(Boolean)
    : [];
  const taggedHistory = legacyHistory
    .filter((item) => String(item).startsWith(prefix))
    .map((item) => String(item).slice(prefix.length));

  if (taggedHistory.length) return taggedHistory;
  return side === "Mother"
    ? legacyHistory.filter((item) => !String(item).includes(":"))
    : [];
}

function getFamilyHistoryList(form) {
  const maternalHistory = getFamilySideHistory(form, "Mother");
  const paternalHistory = getFamilySideHistory(form, "Father");

  if (
    maternalHistory.length ||
    paternalHistory.length ||
    form.maternalFamilyOther ||
    form.paternalFamilyOther
  ) {
    return [
      ...maternalHistory.map((condition) => `Mother: ${condition}`),
      ...paternalHistory.map((condition) => `Father: ${condition}`),
    ];
  }

  return Array.isArray(form.familyHistory) ? form.familyHistory.filter(Boolean) : [];
}

function getFamilyOtherText(form) {
  const otherHistory = [];

  if (String(form.maternalFamilyOther || "").trim()) {
    otherHistory.push(`Mother: ${String(form.maternalFamilyOther).trim()}`);
  }
  if (String(form.paternalFamilyOther || "").trim()) {
    otherHistory.push(`Father: ${String(form.paternalFamilyOther).trim()}`);
  }

  return otherHistory.join("; ") || String(form.familyOther || "").trim();
}

function getPregnancyRecordList(form) {
  return Array.isArray(form.pregnancyRecords)
    ? form.pregnancyRecords.filter((record) =>
        Object.entries(record || {}).some(
          ([key, value]) => key !== "id" && String(value || "").trim()
        )
      )
    : [];
}

function mapSupabasePatient(row) {
  const visibleId = row.patient_id || String(row.id || "").slice(0, 8);
  const linkedStatus = row.user_id
    ? normalizePatientAccountStatus(row.account_status)
    : patientAccountStatuses.unlinked;
  const isArchived = isPatientRecordArchived(row);

  return {
    recordId: row.id,
    id: visibleId,
    patientId: visibleId,
    controlNumber: row.control_number || "",
    initials: getInitials(row.full_name || "Patient"),
    name: row.full_name || "Unnamed Patient",
    gender: "Female",
    age: computeAgeLabel(row.age, row.date_of_birth),
    birthdate: formatBirthdate(row.date_of_birth),
    tone: "pink",
    status: isArchived ? patientAccountStatuses.archived : linkedStatus,
    recordStatus: row.status || "",
    accountStatus: linkedStatus,
    userId: row.user_id || "",
    archivedAt: row.archived_at || null,
    archivedBy: row.archived_by || null,
  };
}

function createPatientPersonalInfoPayload(form, savedPatient, credentials) {
  return {
    patient_record_id: savedPatient.id,
    patient_code: credentials.patientId,
    full_name: form.name || "New Patient",
    gender: "Female",
    email: cleanText(form.email),
    birthdate: form.birthdate || null,
    age: parsePatientAgeValue(form),
    address: cleanText(form.address),
    contact_number: cleanText(form.contactNumber),
    occupation: cleanText(form.occupation),
    work_address: cleanText(form.workAddress),
    company: cleanText(form.company),
    work_contact_number: cleanText(form.workContactNumber),
    blood_type: cleanText(form.bloodType),
    civil_status: null,
    updated_at: new Date().toISOString(),
  };
}

function createCorePatientPersonalInfoPayload(form, savedPatient, credentials) {
  return omitPayloadFields(
    createPatientPersonalInfoPayload(form, savedPatient, credentials),
    ["occupation", "work_address", "company", "work_contact_number"]
  );
}

function createEmergencyContactPayload(form, personalInfoId) {
  if (!form.husbandPartner.trim() && !form.partnerContactNumber.trim()) {
    return null;
  }

  return {
    patient_id: personalInfoId,
    contact_person: cleanText(form.husbandPartner) || "Emergency Contact",
    relationship: "Husband/Partner",
    contact_number: cleanText(form.partnerContactNumber),
    updated_at: new Date().toISOString(),
  };
}

function createObstetricHistoryPayload(form, savedPatient) {
  const ageAtMenarche = parseOptionalNumber(form.ageMenarche);

  return {
    patient_id: savedPatient.id,
    age_at_menarche: isNumberInRange(ageAtMenarche, 8, 25)
      ? ageAtMenarche
      : null,
    menstrual_pattern: cleanText(form.menstrualPattern),
    cycle_length_days: parseOptionalNumber(form.cycleLength),
    menstruation_duration_days: parseOptionalNumber(form.durationMenstruation),
    sexually_active:
      form.sexuallyActive === "Yes"
        ? true
        : form.sexuallyActive === "No"
          ? false
          : null,
    contraceptive_method: cleanText(form.contraceptiveMethod),
    gravida: parseOptionalNumber(form.gravida) ?? 0,
    para: parseOptionalNumber(form.para) ?? 0,
    last_menstrual_period: form.lmp || null,
    expected_delivery_date: form.edd || null,
    updated_at: new Date().toISOString(),
  };
}

function createMedicalHistoryPayload(form, savedPatient) {
  return {
    patient_id: savedPatient.id,
    allergies: getAllergyList(form),
    medical_conditions: getMedicalConditionList(form),
    other_medical_condition: cleanText(form.medicalOther),
    family_history: getFamilyHistoryList(form),
    other_family_history: cleanText(getFamilyOtherText(form)),
    updated_at: new Date().toISOString(),
  };
}

function createReservedPatientLoginPayload(credentials) {
  return {
    row_type: "credential",
    sort_order: 1,
    screen_key: "control_number",
    screen_title: "Enter Control Number",
    button_label: "Submit",
    patient_id: credentials.patientId,
    control_number: credentials.controlNumber,
    status: "Pending Registration",
  };
}

function createPatientLoginPayload(form, savedPatient, credentials) {
  return {
    row_type: "credential",
    sort_order: 1,
    screen_key: "control_number",
    screen_title: "Enter Control Number",
    button_label: "Submit",
    patient_record_id: savedPatient.id,
    full_name: form.name || "New Patient",
    patient_id: credentials.patientId,
    control_number: credentials.controlNumber,
    email: form.email || null,
    date_of_birth: form.birthdate || null,
    age: parsePatientAgeValue(form),
    address: form.address || null,
    contact_number: form.contactNumber || null,
    status: "Pending Activation",
  };
}

function InputField({
  label,
  required = false,
  type = "text",
  value,
  onChange,
  placeholder = "",
  icon,
  className = "",
}) {
  return (
    <label className={`staff-register-field ${className}`}>
      {label ? (
        <span>
          {label}
          {required ? <b>*</b> : null}
        </span>
      ) : null}

      <div className="staff-register-input-wrap">
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

function SelectField({ label, value, onChange, children, className = "" }) {
  return (
    <label className={`staff-register-field ${className}`}>
      {label ? <span>{label}</span> : null}

      <div className="staff-register-input-wrap">
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {children}
        </select>
        <Icon icon="solar:alt-arrow-down-linear" aria-hidden="true" />
      </div>
    </label>
  );
}

function AllergyTypeSelect({ value, onChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const selected = allergyTypeOptions.find((option) => option.value === value);

  return (
    <div className="staff-allergy-type-select">
      <button
        type="button"
        className="staff-allergy-type-trigger"
        onClick={() => setIsOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        {selected ? (
          <>
            <Icon icon={selected.icon} aria-hidden="true" />
            <span>{selected.label}</span>
          </>
        ) : (
          <span>Select Allergy Type</span>
        )}
        <Icon icon="solar:alt-arrow-down-linear" aria-hidden="true" />
      </button>

      {isOpen ? (
        <div className="staff-allergy-type-menu" role="listbox">
          {allergyTypeOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={value === option.value}
              className={value === option.value ? "is-selected" : ""}
              onClick={() => {
                onChange(option.value);
                setIsOpen(false);
              }}
            >
              <Icon icon={option.icon} aria-hidden="true" />
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ContraceptiveMethodSelect({ value, onChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handlePointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div className="staff-register-field">
      <span>Contraceptive Method Used</span>

      <div
        ref={rootRef}
        className={`staff-contraceptive-select ${isOpen ? "is-open" : ""}`}
      >
        <button
          type="button"
          className="staff-contraceptive-trigger"
          onClick={() => setIsOpen((current) => !current)}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
        >
          <span>{value || "Select method"}</span>
          <Icon icon="solar:alt-arrow-down-linear" aria-hidden="true" />
        </button>

        {isOpen ? (
          <div
            className="staff-contraceptive-menu"
            role="listbox"
            aria-label="Contraceptive Method Used"
          >
            <button
              type="button"
              role="option"
              aria-selected={!value}
              className={!value ? "is-selected" : ""}
              onClick={() => {
                onChange("");
                setIsOpen(false);
              }}
            >
              Select method
            </button>

            {contraceptiveMethodOptions.map((option) => (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={value === option}
                className={value === option ? "is-selected" : ""}
                onClick={() => {
                  onChange(option);
                  setIsOpen(false);
                }}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RadioGroup({ label, value, onChange, options }) {
  return (
    <div className="staff-register-radio-group">
      <span>{label}</span>
      <div>
        {options.map((option) => (
          <label key={option}>
            <input
              type="radio"
              checked={value === option}
              onChange={() => onChange(option)}
            />
            <i />
            {option}
          </label>
        ))}
      </div>
    </div>
  );
}

function CheckboxItem({ label, checked, onChange }) {
  return (
    <label className="staff-register-check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <i />
      <span>{label}</span>
    </label>
  );
}

function PatientRegisterSuccessCard({ isGenerated }) {
  return (
    <section className="staff-register-success-card">
      <span>
        <Icon icon="solar:check-circle-bold" aria-hidden="true" />
      </span>
      <h3>{isGenerated ? "Patient access generated" : "Patient will be registered"}</h3>
      <p>
        {isGenerated
          ? "Confirm the Patient received the QR code before finishing registration."
          : "Complete the three registration sections before generating Patient access."}
      </p>
    </section>
  );
}

function CredentialsPanel({ credentials }) {
  const accessUrl = credentials ? buildPatientAccessUrl(credentials) : "";

  if (!credentials?.patientId || !credentials?.controlNumber) {
    return (
      <section className="staff-register-credential-card is-placeholder">
        <span className="staff-access-placeholder-icon">
          <Icon icon="solar:qr-code-linear" aria-hidden="true" />
        </span>
        <h3>Patient Access</h3>
        <p>
          Complete all required Patient information to generate the Patient ID,
          one-time control number, and QR code.
        </p>
      </section>
    );
  }

  return (
    <section className="staff-register-credential-card">
      <header>
        <Icon icon="solar:lock-keyhole-linear" aria-hidden="true" />
        <h3>Patient Access</h3>
      </header>

      <p>Provide the following to the patient to access the mobile application.</p>

      <div className="staff-credential-field">
        <small>Patient ID</small>
        <strong>{credentials.patientId}</strong>
      </div>

      <div className="staff-credential-field">
        <small>Control Number (One-Time)</small>
        <strong className="is-green">{credentials.controlNumber}</strong>
      </div>

      <div className="staff-qr-block">
        <small>QR Code</small>
        {accessUrl ? (
          <div>
            <QRCodeCanvas
              value={accessUrl}
              size={188}
              level="H"
              includeMargin
            />
          </div>
        ) : (
          <p className="staff-qr-error" role="alert">
            Unable to generate the patient access QR code.
          </p>
        )}
      </div>

      <em>
        Ask the Patient to scan this QR code and confirm the Patient Access page opens.
      </em>
      {accessUrl && (
        <div className="staff-patient-access-link">
          <small>Patient access link:</small>
          <a href={accessUrl}>{accessUrl}</a>
        </div>
      )}

      <div className="staff-important-box">
        <strong>Important!</strong>
        <p>The control number is one-time use only for activation.</p>
        <p>Keep this information secure and only share with the patient.</p>
      </div>
    </section>
  );
}

function Stepper({ currentStep, onStepSelect }) {
  const progress = `${((currentStep - 1) / (steps.length - 1)) * 100}%`;

  return (
    <div className="staff-register-stepper" style={{ "--step-progress": progress }}>
      <div className="staff-register-step-line" />

      {steps.map((item) => {
        const isReached = item.id <= currentStep;

        return (
          <button
            key={item.id}
            type="button"
            className={[
              "staff-register-step",
              item.id === currentStep ? "is-active" : "",
              item.id < currentStep ? "is-complete" : "",
              isReached ? "is-reached" : "",
            ].join(" ")}
            onClick={() => {
              if (isReached) onStepSelect(item.id);
            }}
            aria-current={item.id === currentStep ? "step" : undefined}
          >
            <span>{item.id}</span>
            <small>{item.label}</small>
          </button>
        );
      })}
    </div>
  );
}

function StaffPatientsContent({ headerAction }) {
  const location = useLocation();
  const navigate = useNavigate();
  const dashboardPatientTarget = useMemo(() => {
    const match = location.pathname.match(/^\/staff\/patients\/([^/]+)\/?$/);

    if (!match) {
      return "";
    }

    const value = decodeURIComponent(match[1] || "").trim();
    return value && value !== "new" ? value : "";
  }, [location.pathname]);
  const registrationTopRef = useRef(null);
  const walkInDateInputRef = useRef(null);
  const [screen, setScreen] = useState(() => {
    if (location.pathname.includes("/staff/patients/new/register")) return "register";
    if (location.pathname.includes("/staff/patients/new")) return "select-slot";
    return "list";
  });
  const [patients, setPatients] = useState([]);
  const [query, setQuery] = useState("");
  const [activeModal, setActiveModal] = useState(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [isLoadingPatients, setIsLoadingPatients] = useState(true);
  const [isSavingPatient, setIsSavingPatient] = useState(false);
  const [patientStatusFilter, setPatientStatusFilter] = useState("All");
  const [patientActionMenu, setPatientActionMenu] = useState(null);
  const [sortConfig, setSortConfig] = useState({
    key: "name",
    direction: "asc",
  });
  const [step, setStep] = useState(1);
  const [form, setForm] = useState(blankForm);
  const [accessCredentials, setAccessCredentials] = useState({
    patientId: "",
    controlNumber: "",
  });
  const [credentialPool, setCredentialPool] = useState([]);
  const [registrationView, setRegistrationView] = useState("form");
  const [registrationToken, setRegistrationToken] = useState("");
  const [registrationRecord, setRegistrationRecord] = useState(null);
  const [qrReceiptConfirmed, setQrReceiptConfirmed] = useState(false);
  const [isFinishingRegistration, setIsFinishingRegistration] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const [selectedDate, setSelectedDate] = useState(getManilaDateKey());
  const [doctors, setDoctors] = useState([]);
  const [selectedDoctorId, setSelectedDoctorId] = useState("");
  const [selectedSlotId, setSelectedSlotId] = useState("");
  const [selectedWalkInSlot, setSelectedWalkInSlot] = useState(null);
  const [isLoadingWalkInSlots, setIsLoadingWalkInSlots] = useState(false);
  const [walkInError, setWalkInError] = useState("");
  const [walkInNotice, setWalkInNotice] = useState("");
  const [isReservingSlot, setIsReservingSlot] = useState(false);
  const [isReleasingSlot, setIsReleasingSlot] = useState(false);
  const [walkInRefreshKey, setWalkInRefreshKey] = useState(0);
  const [reservationClock, setReservationClock] = useState(() => Date.now());
  const finishRegistrationLockRef = useRef(false);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (location.pathname.includes("/staff/patients/new/register")) {
      setScreen("register");
      return;
    }
    if (location.pathname.includes("/staff/patients/new")) {
      setScreen("select-slot");
      return;
    }
    setScreen("list");
  }, [location.pathname]);

  useEffect(() => {
    if (!patientActionMenu) return undefined;

    const closeActionMenu = () => setPatientActionMenu(null);

    const handlePointerDown = (event) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          ".staff-patient-action-menu, .staff-patient-action-menu-trigger"
        )
      ) {
        return;
      }

      closeActionMenu();
    };

    const handleKeyDown = (event) => {
      if (event.key === "Escape") closeActionMenu();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", closeActionMenu);
    window.addEventListener("scroll", closeActionMenu, true);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", closeActionMenu);
      window.removeEventListener("scroll", closeActionMenu, true);
    };
  }, [patientActionMenu]);

  useEffect(() => {
    let active = true;

    const restoreActiveWalkInReservation = async () => {
      let saved = null;
      try {
        saved = JSON.parse(
          window.sessionStorage.getItem(staffWalkInSlotSessionKey) || "null"
        );
      } catch {
        window.sessionStorage.removeItem(staffWalkInSlotSessionKey);
      }

      const { data: authData } = await supabase.auth.getUser();
      const currentUserId = authData?.user?.id || "";
      if (!active || !currentUserId) return;

      let query = supabase
        .from("staff_walkin_registration_reservations")
        .select("id, doctor_id, slot_date, slot_time, status, expires_at, created_at")
        .eq("reserved_by", currentUserId)
        .eq("status", "reserved")
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(1);

      if (saved?.reservationId) {
        query = supabase
          .from("staff_walkin_registration_reservations")
          .select("id, doctor_id, slot_date, slot_time, status, expires_at, created_at")
          .eq("id", saved.reservationId)
          .eq("reserved_by", currentUserId)
          .eq("status", "reserved")
          .gt("expires_at", new Date().toISOString())
          .limit(1);
      }

      const { data, error } = await query;
      if (!active) return;

      const reservation = data?.[0] || null;
      if (
        error &&
        saved?.reservationId &&
        saved?.doctorId &&
        saved?.date &&
        saved?.time
      ) {
        setSelectedWalkInSlot(saved);
        setSelectedDoctorId(saved.doctorId);
        setSelectedDate(saved.date);
        setSelectedSlotId(
          saved.slotId ||
            `${saved.doctorId}-${saved.date}-${normalizeWalkInTime(saved.time)}`
        );
        return;
      }

      if (!reservation) {
        if (!error) {
          window.sessionStorage.removeItem(staffWalkInSlotSessionKey);
          setSelectedWalkInSlot(null);
          setSelectedSlotId("");
        }
        return;
      }

      const time = normalizeWalkInTime(reservation.slot_time);
      const restored = {
        ...saved,
        reservationId: reservation.id,
        doctorId: reservation.doctor_id,
        doctorName: saved?.doctorName || "",
        specialization: saved?.specialization || "",
        date: reservation.slot_date,
        time,
        expiresAt: reservation.expires_at,
        slotId: `${reservation.doctor_id}-${reservation.slot_date}-${time}`,
      };

      setSelectedWalkInSlot(restored);
      setSelectedDoctorId(restored.doctorId);
      setSelectedDate(restored.date);
      setSelectedSlotId(restored.slotId);
      window.sessionStorage.setItem(
        staffWalkInSlotSessionKey,
        JSON.stringify(restored)
      );
    };

    restoreActiveWalkInReservation();
    return () => {
      active = false;
    };
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    let active = true;

    const loadPatients = async () => {
      setIsLoadingPatients(true);

      const [patientsResult, patientLoginResult] = await Promise.all([
        supabase
          .rpc("get_staff_patient_directory")
          .order("created_at", { ascending: false }),
        supabase
          .from("patient_login")
          .select(patientLoginSelectColumns),
      ]);

      if (!active) return;

      setIsLoadingPatients(false);

      if (patientsResult.error) {
        console.error("Load staff patients failed:", patientsResult.error);
        setStatusMessage(`Unable to load patients: ${patientsResult.error.message}`);
        return;
      }

      if (
        patientLoginResult.error &&
        !isMissingPatientLoginTableError(patientLoginResult.error)
      ) {
        console.warn("Load patient login credentials failed:", patientLoginResult.error);
      }

      const supabasePatients = patientsResult.data || [];
      const mappedPatients = supabasePatients.map(mapSupabasePatient);
      const patientLoginCredentials = patientLoginResult.error
        ? []
        : (patientLoginResult.data || []).map(toCredentialEntry);
      const nextCredentialPool = [
        ...supabasePatients.map(toCredentialEntry),
        ...patientLoginCredentials,
      ];

      setPatients(mappedPatients);
      setCredentialPool(nextCredentialPool);
    };

    loadPatients();

    return () => {
      active = false;
    };
  }, []);

  /*
   * Dashboard "View Patient" deep link.
   *
   * Staff is intentionally not given Doctor medical-record access here.
   * The route simply locates the exact Patient in the Staff directory.
   */
  useEffect(() => {
    if (
      !dashboardPatientTarget ||
      isLoadingPatients ||
      patients.length === 0
    ) {
      return;
    }

    const target = patients.find(
      (patient) =>
        patient.recordId === dashboardPatientTarget ||
        patient.id === dashboardPatientTarget ||
        patient.patientId === dashboardPatientTarget
    );

    const frame = window.requestAnimationFrame(() => {
      if (!target) {
        setStatusMessage("The selected Patient could not be found.");
        return;
      }

      setScreen("list");
      setPatientStatusFilter("All");
      setQuery(target.id || target.name);
      setStatusMessage("");

      const row = document.getElementById(
        `staff-patient-row-${target.recordId}`
      );

      row?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    dashboardPatientTarget,
    isLoadingPatients,
    patients,
  ]);

  useEffect(() => {
    if (screen !== "select-slot") return undefined;

    let active = true;

    const loadWalkInAvailability = async () => {
      setIsLoadingWalkInSlots(true);
      setWalkInError("");

      const rpcResult = await supabase.rpc("get_walkin_registration_availability", {
        p_slot_date: selectedDate,
      });

      if (!active) return;

      if (!rpcResult.error && Array.isArray(rpcResult.data)) {
        const rows = rpcResult.data;
        const mappedDoctors = rows.map((row) => ({
          id: row.doctor_id,
          name: row.doctor_name || "Doctor",
          specialization: row.specialization || "Obstetrician - Gynecologist",
          avatarUrl: row.avatar_url || "",
          scheduledCount: Number(row.scheduled_count || 0),
          dailyCapacity: Number(row.daily_capacity || 0),
          remainingSlots: Number(row.remaining_slots || 0),
          slots: normalizeWalkInSlots(row.slots),
        }));
        setDoctors(mappedDoctors);
        setSelectedDoctorId((current) => {
          if (current && mappedDoctors.some((doctor) => doctor.id === current)) return current;
          return mappedDoctors[0]?.id || "";
        });
        setIsLoadingWalkInSlots(false);
        return;
      }

      if (rpcResult.error && !isMissingWalkInRpcError(rpcResult.error)) {
        logWalkInAvailabilityError(rpcResult.error);
        setWalkInError("Unable to load walk-in availability. Please try again.");
        setIsLoadingWalkInSlots(false);
        return;
      }

      try {
        const dateStart = toManilaISOString(selectedDate, "00:00");
        const dateEndDate = new Date(dateStart);
        dateEndDate.setDate(dateEndDate.getDate() + 1);
        const dayOfWeek = getAvailabilityDayOfWeek(selectedDate);

        const [profilesResult, personalResult, professionalResult, availabilityResult, scheduleResult] =
          await Promise.all([
            supabase
              .from("profiles")
              .select("id, full_name, email, role, account_status")
              .ilike("role", "doctor"),
            supabase
              .from("doctor_personal_information")
              .select("auth_user_id, full_name"),
            supabase
              .from("doctor_professional_information")
              .select("auth_user_id, board_certification, clinic_hospital_name"),
            supabase
              .from("user_availability")
              .select("profile_id, day_of_week, start_time, end_time, is_available")
              .eq("day_of_week", dayOfWeek),
            supabase
              .from("schedule")
              .select("id, doctor_id, doctor_name, title, start_time, end_time, status")
              .gte("start_time", dateStart)
              .lt("start_time", dateEndDate.toISOString()),
          ]);

        if (!active) return;

        if (profilesResult.error) throw profilesResult.error;
        if (availabilityResult.error) throw availabilityResult.error;
        if (scheduleResult.error) throw scheduleResult.error;

        const personalByDoctor = new Map(
          (personalResult.error ? [] : personalResult.data || []).map((row) => [
            row.auth_user_id,
            row,
          ])
        );
        const professionalByDoctor = new Map(
          (professionalResult.error ? [] : professionalResult.data || []).map((row) => [
            row.auth_user_id,
            row,
          ])
        );
        const availabilityByDoctor = new Map(
          (availabilityResult.data || []).map((row) => [row.profile_id, row])
        );

        const mappedDoctors = (profilesResult.data || [])
          .filter((profile) => {
            const status = String(profile.account_status || "active").trim().toLowerCase();
            return profile.id && !inactiveAccountStatuses.has(status);
          })
          .map((profile) => {
            const personal = personalByDoctor.get(profile.id);
            const professional = professionalByDoctor.get(profile.id);
            const availability = availabilityByDoctor.get(profile.id);
            const appointments = (scheduleResult.data || []).filter(
              (appointment) => appointment.doctor_id === profile.id
            );
            const slots = buildFallbackSlots({
              dateValue: selectedDate,
              availability,
              appointments,
            });
            const scheduledCount = appointments.filter(
              (appointment) => normalizeSlotStatus(appointment.status) === "occupied"
            ).length;

            return {
              id: profile.id,
              name: mapDoctorDisplayName(profile, personal),
              specialization: getDoctorSpecialization(professional),
              avatarUrl: profile.avatar_url || "",
              scheduledCount,
              dailyCapacity: slots.length,
              remainingSlots: slots.filter((slot) => slot.status === "available").length,
              slots,
            };
          })
          .filter((doctor) => doctor.dailyCapacity > 0 || doctor.scheduledCount > 0);

        setDoctors(mappedDoctors);
        setSelectedDoctorId((current) => {
          if (current && mappedDoctors.some((doctor) => doctor.id === current)) return current;
          return mappedDoctors[0]?.id || "";
        });
        setIsLoadingWalkInSlots(false);
      } catch (error) {
        if (!active) return;
        logWalkInAvailabilityError(error);
        setWalkInError("Unable to load walk-in availability. Please try again.");
        setIsLoadingWalkInSlots(false);
      }
    };

    loadWalkInAvailability();

    return () => {
      active = false;
    };
  }, [screen, selectedDate, walkInRefreshKey]);

  useEffect(() => {
    if (screen !== "select-slot" || !selectedWalkInSlot?.expiresAt) {
      return undefined;
    }

    const expiresAtMs = Date.parse(selectedWalkInSlot.expiresAt);
    if (!Number.isFinite(expiresAtMs)) return undefined;

    const timer = window.setInterval(() => {
      const now = Date.now();
      setReservationClock(now);

      if (now >= expiresAtMs) {
        window.clearInterval(timer);
        window.sessionStorage.removeItem(staffWalkInSlotSessionKey);
        setSelectedWalkInSlot(null);
        setSelectedSlotId("");
        setWalkInNotice("Your previous reservation expired and the slot is available again.");
        setWalkInRefreshKey((current) => current + 1);
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [screen, selectedWalkInSlot?.expiresAt]);

  useEffect(() => {
    let active = true;

    const restoreProvisionalRegistration = async () => {
      let savedSession = null;
      try {
        savedSession = JSON.parse(
          window.sessionStorage.getItem(staffRegistrationSessionKey) || "null"
        );
      } catch {
        window.sessionStorage.removeItem(staffRegistrationSessionKey);
      }

      if (!savedSession?.patientRecordId || !savedSession?.registrationToken) return;

      const { data, error } = await supabase.rpc("get_patient_registration_draft", {
        p_patient_record_id: savedSession.patientRecordId,
        p_registration_token: savedSession.registrationToken,
      });

      if (!active) return;
      if (error) {
        console.warn("Unable to restore provisional Patient registration:", error);
        return;
      }

      const restored = Array.isArray(data) ? data[0] : data;
      if (!restored?.id || !restored?.registration_data) return;
      const restoredForm = restored.registration_data;
      const restoredWalkIn = restoredForm.walkInReservation
        ? {
            reservationId: restoredForm.walkInReservation.reservationId || "",
            doctorId: restoredForm.walkInReservation.doctorId || "",
            doctorName: restoredForm.walkInReservation.doctorName || "",
            specialization: restoredForm.walkInReservation.specialization || "",
            date: restoredForm.walkInReservation.slotDate || "",
            time: restoredForm.walkInReservation.slotTime || "",
            slotId:
              restoredForm.walkInReservation.slotId ||
              `${restoredForm.walkInReservation.doctorId}-${restoredForm.walkInReservation.slotDate}-${restoredForm.walkInReservation.slotTime}`,
          }
        : null;

      setForm({
        ...blankForm,
        ...restoredForm,
        medicalConditions: restoredForm.medicalConditions || [],
        familyHistory: restoredForm.familyHistory || [],
        maternalFamilyHistory: getFamilySideHistory(restoredForm, "Mother"),
        paternalFamilyHistory: getFamilySideHistory(restoredForm, "Father"),
        allergies: normalizeStructuredAllergies(restoredForm),
        pregnancyRecords: (restoredForm.pregnancyRecords || []).map((record) => ({
          ...record,
          id: record.id || createStableClientId("pregnancy"),
        })),
      });
      if (restoredWalkIn?.reservationId) {
        setSelectedWalkInSlot(restoredWalkIn);
        setSelectedDoctorId(restoredWalkIn.doctorId);
        setSelectedDate(restoredWalkIn.date);
        setSelectedSlotId(restoredWalkIn.slotId);
      }
      setRegistrationToken(savedSession.registrationToken);
      setRegistrationRecord(restored);
      setAccessCredentials({
        patientId: restored.patient_id,
        controlNumber: restored.control_number,
      });
      setQrReceiptConfirmed(false);
      setRegistrationView("confirmation");
      setStep(3);
      setScreen("register");
    };

    restoreProvisionalRegistration();
    return () => {
      active = false;
    };
  }, []);

  const filteredPatients = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const statusFilteredPatients =
      patientStatusFilter === "All"
        ? patients
        : patients.filter(
            (patient) => getPatientStatusGroup(patient) === patientStatusFilter
          );

    const searchedPatients = !keyword
      ? statusFilteredPatients
      : statusFilteredPatients.filter((patient) => {
          return (
            patient.name.toLowerCase().includes(keyword) ||
            patient.id.toLowerCase().includes(keyword) ||
            patient.birthdate.toLowerCase().includes(keyword) ||
            formatPatientStatus(patient).toLowerCase().includes(keyword)
          );
        });

    return [...searchedPatients].sort((a, b) => {
      const firstValue = String(a[sortConfig.key]).toLowerCase();
      const secondValue = String(b[sortConfig.key]).toLowerCase();

      if (firstValue < secondValue) return sortConfig.direction === "asc" ? -1 : 1;
      if (firstValue > secondValue) return sortConfig.direction === "asc" ? 1 : -1;
      return 0;
    });
  }, [patientStatusFilter, query, patients, sortConfig]);

  const activeActionPatient = patientActionMenu
    ? patients.find((patient) => patient.recordId === patientActionMenu.patientId) || null
    : null;

  const selectedDoctor = useMemo(() => {
    return doctors.find((doctor) => doctor.id === selectedDoctorId) || doctors[0] || null;
  }, [doctors, selectedDoctorId]);

  const visibleWalkInSlots = useMemo(() => {
    return selectedDoctor?.slots || [];
  }, [selectedDoctor]);

  const selectedSlot = useMemo(() => {
    return visibleWalkInSlots.find((slot) => slot.id === selectedSlotId) || null;
  }, [selectedSlotId, visibleWalkInSlots]);

  const reservationExpiresAtMs = Date.parse(selectedWalkInSlot?.expiresAt || "");
  const reservationHasExpired =
    Number.isFinite(reservationExpiresAtMs) &&
    reservationExpiresAtMs <= reservationClock;
  const activeWalkInReservation =
    selectedWalkInSlot?.reservationId && !reservationHasExpired
      ? selectedWalkInSlot
      : null;
  const reservedDoctor = activeWalkInReservation
    ? doctors.find((doctor) => doctor.id === activeWalkInReservation.doctorId) || null
    : null;
  const reservationTimeLeft = activeWalkInReservation?.expiresAt
    ? getWalkInReservationTimeLeft(
        activeWalkInReservation.expiresAt,
        reservationClock
      )
    : "Reservation active";

  const walkInEmptyMessage = useMemo(() => {
    if (walkInError) return "Unable to load walk-in availability. Please try again.";
    if (!doctors.length) return "No active Doctor is available.";
    if (!selectedDoctor) return "No active Doctor is available.";
    if (Number(selectedDoctor.dailyCapacity || 0) <= 0) {
      return "The Doctor has no availability configured for the selected date.";
    }
    if (
      visibleWalkInSlots.length > 0 &&
      !visibleWalkInSlots.some((slot) => slot.status === "available")
    ) {
      return "All walk-in slots are full for the selected date.";
    }
    return "No walk-in slots are available for the selected date.";
  }, [doctors.length, selectedDoctor, visibleWalkInSlots, walkInError]);

  const updateForm = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const updateBirthdate = (value) => {
    setForm((current) => ({
      ...current,
      birthdate: value,
      age: calculateAgeFromBirthdate(value),
    }));
  };

  const updateLmp = (value) => {
    setForm((current) => ({
      ...current,
      lmp: value,
      edd: current.edd || addDaysToDateInput(value, 280),
    }));
  };

  const addPregnancyRecord = () => {
    setForm((current) => ({
      ...current,
      pregnancyRecords: [
        ...(Array.isArray(current.pregnancyRecords)
          ? current.pregnancyRecords
          : []),
        createBlankPregnancyRecord(),
      ],
    }));
  };

  const updatePregnancyRecord = (index, field, value) => {
    setForm((current) => ({
      ...current,
      pregnancyRecords: (Array.isArray(current.pregnancyRecords)
        ? current.pregnancyRecords
        : []
      ).map((record, recordIndex) =>
        recordIndex === index ? { ...record, [field]: value } : record
      ),
    }));
  };

  const removePregnancyRecord = (recordId) => {
    setForm((current) => ({
      ...current,
      pregnancyRecords: (Array.isArray(current.pregnancyRecords)
        ? current.pregnancyRecords
        : []
      ).filter((record) => record.id !== recordId),
    }));
  };

  const addAllergyRecord = (seedRecord = null) => {
    setForm((current) => ({
      ...current,
      allergies: [
        ...(() => {
          const records = Array.isArray(current.allergies) ? current.allergies : [];
          if (records.length) return records;
          return seedRecord?.id
            ? [{ ...allergyRecordTemplate, ...seedRecord }]
            : [createBlankAllergyRecord()];
        })(),
        createBlankAllergyRecord(),
      ],
    }));
  };

  const updateAllergyRecord = (recordId, field, value) => {
    setForm((current) => ({
      ...current,
      allergies: (() => {
        const records = Array.isArray(current.allergies) ? current.allergies : [];
        if (!records.some((record) => record.id === recordId)) {
          return [{ ...allergyRecordTemplate, id: recordId, [field]: value }];
        }
        return records.map((record) =>
          record.id === recordId ? { ...record, [field]: value } : record
        );
      })(),
    }));
  };

  const removeAllergyRecord = (recordId) => {
    setForm((current) => ({
      ...current,
      allergies: (Array.isArray(current.allergies)
        ? current.allergies
        : []
      ).filter((record) => record.id !== recordId),
    }));
  };

  const toggleArrayValue = (field, value, checked) => {
    setForm((current) => ({
      ...current,
      [field]: checked
        ? [...current[field], value]
        : current[field].filter((item) => item !== value),
    }));
  };

  const requestSort = (key) => {
    setSortConfig((current) => ({
      key,
      direction:
        current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  };

  const togglePatientActionMenu = (event, patient) => {
    if (!patient?.recordId) return;

    if (patientActionMenu?.patientId === patient.recordId) {
      setPatientActionMenu(null);
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const menuWidth = 176;
    const menuHeight = canSendPatientNotification(patient) ? 92 : 50;
    const viewportPadding = 12;
    const maxLeft = Math.max(
      viewportPadding,
      window.innerWidth - menuWidth - viewportPadding
    );
    const left = Math.min(
      Math.max(rect.right - menuWidth, viewportPadding),
      maxLeft
    );
    const spaceBelow = window.innerHeight - rect.bottom;
    const top =
      spaceBelow >= menuHeight + 10
        ? rect.bottom + 8
        : Math.max(viewportPadding, rect.top - menuHeight - 8);

    setPatientActionMenu({
      patientId: patient.recordId,
      top,
      left,
    });
  };

  const triggerPatientNotification = (patient) => {
    if (!patient?.recordId || !canSendPatientNotification(patient)) return;

    const trigger = document
      .getElementById(`staff-patient-notify-${patient.recordId}`)
      ?.querySelector(".send-patient-notification-trigger, button");

    setPatientActionMenu(null);

    if (!trigger) {
      setStatusMessage("The Patient notification action is temporarily unavailable.");
      return;
    }

    window.requestAnimationFrame(() => trigger.click());
  };

  const archivePatient = async (patient) => {
    if (!patient?.recordId) return;

    const confirmed = window.confirm(
      `Archive ${patient.name}? This hides the patient from the active list but keeps all linked clinical records.`
    );

    if (!confirmed) return;

    setStatusMessage("");

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user?.id) {
      setStatusMessage("Unable to identify the logged-in account. Please sign in again.");
      return;
    }

    const { data, error } = await supabase.rpc("set_staff_patient_archive_state", {
      p_patient_id: patient.recordId,
      p_archived: true,
    });

    if (error) {
      console.error("Archive patient failed:", error);
      setStatusMessage(`Unable to archive patient: ${error.message}`);
      return;
    }

    const result = Array.isArray(data) ? data[0] : data;
    setPatients((current) =>
      current.map((item) =>
        item.recordId === patient.recordId
          ? {
              ...item,
              status: "archived",
              archivedAt: result?.archived_at || new Date().toISOString(),
              archivedBy: result?.archived_by || user.id,
            }
          : item
      )
    );
    setStatusMessage(`${patient.name} was archived. Linked clinical records were preserved.`);
  };

  const restorePatient = async (patient) => {
    if (!patient?.recordId) return;

    const confirmed = window.confirm(`Restore ${patient.name} to the active patient list?`);

    if (!confirmed) return;

    setStatusMessage("");

    const { data, error } = await supabase.rpc("set_staff_patient_archive_state", {
      p_patient_id: patient.recordId,
      p_archived: false,
    });

    if (error) {
      console.error("Restore patient failed:", error);
      setStatusMessage(`Unable to restore patient: ${error.message}`);
      return;
    }

    const result = Array.isArray(data) ? data[0] : data;
    setPatients((current) =>
      current.map((item) =>
        item.recordId === patient.recordId
          ? {
              ...item,
              status: item.accountStatus,
              recordStatus: result?.record_status || item.recordStatus,
              archivedAt: result?.archived_at ?? null,
              archivedBy: result?.archived_by ?? null,
            }
          : item
      )
    );
    setStatusMessage(`${patient.name} was restored with the previous account status preserved.`);
  };

  const savePatientLoginCredential = async (payload) => {
    const saveViaRpc = async () => {
      const rpcResult = await supabase.rpc("upsert_patient_login_credential", {
        credential_patient_record_id: payload.patient_record_id || null,
        credential_full_name: payload.full_name || null,
        credential_patient_id: payload.patient_id,
        credential_control_number: payload.control_number,
        credential_email: payload.email || null,
        credential_date_of_birth: payload.date_of_birth || null,
        credential_age: payload.age ?? null,
        credential_address: payload.address || null,
        credential_contact_number: payload.contact_number || null,
        credential_status: payload.status || "Pending Activation",
      });

      return {
        ...rpcResult,
        data: Array.isArray(rpcResult.data)
          ? rpcResult.data[0] || null
          : rpcResult.data,
      };
    };

    const result = await supabase
      .from("patient_login")
      .upsert([payload], {
        onConflict: "control_number",
      })
      .select(patientLoginSelectColumns)
      .single();

    if (!result.error) {
      return result;
    }

    if (isPatientLoginPolicyError(result.error)) {
      return saveViaRpc();
    }

    if (!isPatientLoginPatientIdConflict(result.error)) {
      return result;
    }

    const updateResult = await supabase
      .from("patient_login")
      .update(payload)
      .eq("patient_id", payload.patient_id)
      .select(patientLoginSelectColumns)
      .single();

    if (
      updateResult.error &&
      isPatientLoginPolicyError(updateResult.error)
    ) {
      return saveViaRpc();
    }

    return updateResult;
  };

  const reservePatientLoginCredentials = async (credentials) => {
    const payload = createReservedPatientLoginPayload(credentials);
    const { data, error } = await savePatientLoginCredential(payload);

    if (error) {
      console.warn("Patient login credential reservation failed:", error);

      if (!isPatientLoginPolicyError(error)) {
        setStatusMessage(
          `QR credential is not yet saved in patient_login: ${error.message}`
        );
      }

      return credentials;
    }

    const savedCredentials = toCredentialEntry(data || credentials);
    setCredentialPool((current) => addCredentialsToPool(current, savedCredentials));
    return savedCredentials;
  };

  const fetchLatestCredentialPool = async () => {
    const [patientsResult, patientLoginResult] = await Promise.all([
      supabase
        .rpc("get_staff_patient_directory")
        .select("id, patient_id, control_number"),
      supabase
        .from("patient_login")
        .select(patientLoginSelectColumns),
    ]);

    if (patientsResult.error) {
      throw patientsResult.error;
    }

    if (
      patientLoginResult.error &&
      !isMissingPatientLoginTableError(patientLoginResult.error)
    ) {
      throw patientLoginResult.error;
    }

    return [
      ...(patientsResult.data || []).map(toCredentialEntry),
      ...(patientLoginResult.error
        ? []
        : (patientLoginResult.data || []).map(toCredentialEntry)),
    ];
  };

  const createFreshReservedCredentials = async () => {
    const latestPool = await fetchLatestCredentialPool();
    const generatedCredentials = createAccessCredentials(latestPool);
    const savedCredentials = await reservePatientLoginCredentials(
      generatedCredentials
    );
    const nextPool = addCredentialsToPool(latestPool, savedCredentials);

    setCredentialPool(nextPool);
    setAccessCredentials(savedCredentials);

    return savedCredentials;
  };

  const cleanupPartialRegistration = async ({
    patientRecordId,
    personalInfoId,
  }) => {
    const cleanupErrors = [];

    const runDelete = async (table, column, value) => {
      if (!value) return;

      const { error } = await supabase
        .from(table)
        .delete()
        .eq(column, value);

      if (error) {
        cleanupErrors.push(`${table}: ${error.message}`);
        console.warn(`Cleanup failed for ${table}:`, error);
      }
    };

    if (personalInfoId) {
      await runDelete(
        "patient_emergency_contact",
        "patient_id",
        personalInfoId
      );
    }

    if (patientRecordId) {
      await runDelete(
        "patient_medical_history",
        "patient_id",
        patientRecordId
      );
      await runDelete(
        "patient_obstetric_history",
        "patient_id",
        patientRecordId
      );
    }

    if (personalInfoId) {
      await runDelete(
        "patient_personal_information",
        "id",
        personalInfoId
      );
    } else if (patientRecordId) {
      await runDelete(
        "patient_personal_information",
        "patient_record_id",
        patientRecordId
      );
    }

    if (patientRecordId) {
      await runDelete("patients", "id", patientRecordId);
    }

    return cleanupErrors;
  };

  const insertPatientRecord = async (credentials) => {
    void credentials;
    return {
      data: null,
      error: new Error(
        "Legacy direct Patient registration is disabled. Use save_patient_registration."
      ),
    };
  };

  const insertPersonalInfoRecord = async (savedPatient, credentials) => {
    const fullPayload = createPatientPersonalInfoPayload(
      form,
      savedPatient,
      credentials
    );
    const fullResult = await supabase
      .from("patient_personal_information")
      .insert([fullPayload])
      .select("id")
      .single();

    if (!fullResult.error || !isSchemaCacheColumnError(fullResult.error)) {
      return fullResult;
    }

    console.warn(
      "Patient personal information table is missing optional columns. Retrying with core payload.",
      fullResult.error
    );

    return supabase
      .from("patient_personal_information")
      .insert([
        createCorePatientPersonalInfoPayload(
          form,
          savedPatient,
          credentials
        ),
      ])
      .select("id")
      .single();
  };

  const saveOptionalPatientRecord = async (table, payload) => {
    const { error } = await supabase
      .from(table)
      .insert([payload])
      .select("id")
      .single();

    if (error) {
      console.warn(`Optional ${table} save failed:`, error);
      return `${table}: ${error.message}`;
    }

    return "";
  };

  const persistWalkInSlot = (slot) => {
    setSelectedWalkInSlot(slot);
    window.sessionStorage.setItem(staffWalkInSlotSessionKey, JSON.stringify(slot));
  };

  const releaseSelectedReservation = async () => {
    const reservationId = selectedWalkInSlot?.reservationId;
    if (!reservationId) return true;

    const { error } = await supabase.rpc("release_walkin_registration_slot", {
      p_reservation_id: reservationId,
    });

    if (error && !isMissingWalkInRpcError(error)) {
      console.warn("Unable to release walk-in reservation:", error);
      setWalkInError(`Unable to release this reservation: ${error.message}`);
      return false;
    }

    return true;
  };

  const releaseActiveWalkInReservation = async () => {
    if (!activeWalkInReservation || isReleasingSlot) return;

    const releasedTime = formatSlotTime(
      activeWalkInReservation.date,
      activeWalkInReservation.time
    );
    setIsReleasingSlot(true);
    setWalkInError("");
    setWalkInNotice("");

    try {
      const released = await releaseSelectedReservation();
      if (!released) return;

      window.sessionStorage.removeItem(staffWalkInSlotSessionKey);
      setSelectedWalkInSlot(null);
      setSelectedSlotId("");
      setWalkInNotice(
        `${releasedTime || "The walk-in slot"} was released. You can now select another schedule.`
      );
      setWalkInRefreshKey((current) => current + 1);
    } finally {
      setIsReleasingSlot(false);
    }
  };

  const resumeActiveWalkInRegistration = () => {
    if (!activeWalkInReservation) {
      setWalkInError("This reservation is no longer active. Please select another time.");
      setWalkInRefreshKey((current) => current + 1);
      return;
    }

    const hydratedReservation = {
      ...activeWalkInReservation,
      doctorName:
        reservedDoctor?.name || activeWalkInReservation.doctorName || "Doctor",
      specialization:
        reservedDoctor?.specialization ||
        activeWalkInReservation.specialization ||
        "Obstetrician - Gynecologist",
    };

    persistWalkInSlot(hydratedReservation);
    setWalkInError("");
    setWalkInNotice("");
    setScreen("register");
    navigate("/staff/patients/new/register");
  };

  const reserveSelectedWalkInSlot = async () => {
    if (activeWalkInReservation) {
      setWalkInError(
        "Resume or release your active reservation before selecting another schedule."
      );
      return;
    }

    if (!selectedDoctor?.id || !selectedSlot || selectedSlot.status !== "available") {
      setWalkInError("Select an available walk-in slot before continuing.");
      return;
    }

    setIsReservingSlot(true);
    setWalkInError("");

    try {
      const { data, error } = await supabase.rpc("reserve_walkin_registration_slot", {
        p_doctor_id: selectedDoctor.id,
        p_slot_date: selectedDate,
        p_slot_time: selectedSlot.time,
      });

      if (error) throw error;
      const reservation = Array.isArray(data) ? data[0] : data;
      const reservationId =
        reservation?.reservation_id ||
        reservation?.id ||
        reservation?.reservation_token ||
        "";
      const expiresAt = reservation?.expires_at || reservation?.expiresAt || "";

      if (!reservationId) {
        throw new Error("The slot reservation did not return a reservation ID.");
      }

      persistWalkInSlot({
        reservationId,
        doctorId: selectedDoctor.id,
        doctorName: selectedDoctor.name,
        specialization: selectedDoctor.specialization,
        date: selectedDate,
        time: selectedSlot.time,
        slotId: selectedSlot.id,
        expiresAt,
      });
      navigate("/staff/patients/new/register");
    } catch (error) {
      console.error("Reserve walk-in slot failed:", error);
      setWalkInError(
        isMissingWalkInRpcError(error)
          ? "Walk-in reservation is not available yet. Apply the reviewed supabase_staff_walkin_registration.sql file, then retry."
          : `Unable to reserve this slot: ${error.message}`
      );
    } finally {
      setIsReservingSlot(false);
    }
  };

  const openRegister = () => {
    if (activeWalkInReservation) {
      setStatusMessage("");
      setWalkInError("");
      setWalkInNotice("");
      setScreen("select-slot");
      navigate("/staff/patients/new/select-slot");
      return;
    }

    window.sessionStorage.removeItem(staffRegistrationSessionKey);
    setStep(1);
    setForm(blankForm);
    setStatusMessage("");
    setAccessCredentials({ patientId: "", controlNumber: "" });
    setRegistrationView("form");
    setRegistrationToken("");
    setRegistrationRecord(null);
    setQrReceiptConfirmed(false);
    setCopyMessage("");
    setScreen("select-slot");
    navigate("/staff/patients/new/select-slot");
  };

  const backToPatients = async () => {
    if (screen === "register" || screen === "select-slot") {
      const released = await releaseSelectedReservation();
      if (!released) return;
    }
    window.sessionStorage.removeItem(staffWalkInSlotSessionKey);
    setSelectedWalkInSlot(null);
    setSelectedSlotId("");
    setScreen("list");
    setStep(1);
    setRegistrationView("form");
    navigate("/staff/patients");
  };

  // Kept unreachable while older deployments transition to the transactional RPC.
  // eslint-disable-next-line no-unused-vars
  const savePatient = async () => {
    setStatusMessage("");

    if (!form.name.trim()) {
      setStatusMessage("Patient name is required.");
      return;
    }

    if (!form.age.trim() || !form.birthdate || !form.address.trim()) {
      setStatusMessage(
        "Please complete the required age, birthdate, and home address fields."
      );
      return;
    }

    if (isFutureDateInput(form.birthdate)) {
      setStatusMessage("Birthdate cannot be in the future.");
      return;
    }

    if (!form.contactNumber.trim()) {
      setStatusMessage("Patient contact number is required.");
      return;
    }

    if (!form.gravida.trim() || !form.para.trim()) {
      setStatusMessage("Gravida and Para are required.");
      setStep(2);
      return;
    }

    const ageAtMenarche = parseOptionalNumber(form.ageMenarche);

    if (!isNumberInRange(ageAtMenarche, 8, 25)) {
      setStep(2);
      setStatusMessage(
        "Age at Menarche must be between 8 and 25 years old. Leave it blank if unknown."
      );
      return;
    }

    const cycleLength = parseOptionalNumber(form.cycleLength);

    if (
      cycleLength !== null &&
      (cycleLength < 15 || cycleLength > 60)
    ) {
      setStep(2);
      setStatusMessage(
        "Cycle Length must be between 15 and 60 days. Example: 28."
      );
      return;
    }

    const menstruationDuration = parseOptionalNumber(
      form.durationMenstruation
    );

    if (
      menstruationDuration !== null &&
      (menstruationDuration < 1 || menstruationDuration > 15)
    ) {
      setStep(2);
      setStatusMessage(
        "Duration of Menstruation must be between 1 and 15 days. Example: 5."
      );
      return;
    }

    setIsSavingPatient(true);

    let savedPatient = null;
    let savedPersonalInfoId = null;
    let workingCredentials = accessCredentials;
    const optionalWarnings = [];

    try {
      // The displayed ID may become stale if another registration or a
      // previous partial save already used it. Retry with freshly generated
      // credentials whenever Supabase reports a duplicate ID/control number.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const patientResult = await insertPatientRecord(workingCredentials);

        if (!patientResult.error) {
          savedPatient = patientResult.data;
          break;
        }

        if (
          !isDuplicatePatientCredentialError(patientResult.error) ||
          attempt === 4
        ) {
          throw patientResult.error;
        }

        console.warn(
          `Duplicate patient credential detected on attempt ${attempt + 1}. Generating a fresh ID.`,
          patientResult.error
        );

        workingCredentials = await createFreshReservedCredentials();
      }

      if (!savedPatient) {
        throw new Error(
          "Unable to generate a unique patient ID after several attempts."
        );
      }

      setAccessCredentials(workingCredentials);

      const {
        data: savedPersonalInfo,
        error: personalInfoError,
      } = await insertPersonalInfoRecord(savedPatient, workingCredentials);

      if (personalInfoError) {
        console.warn("Patient personal information save failed:", personalInfoError);
        optionalWarnings.push(
          `patient_personal_information: ${personalInfoError.message}`
        );
      } else {
        savedPersonalInfoId = savedPersonalInfo.id;
      }

      const emergencyPayload = savedPersonalInfoId
        ? createEmergencyContactPayload(form, savedPersonalInfoId)
        : null;

      if (emergencyPayload) {
        const { error: emergencyError } = await supabase
          .from("patient_emergency_contact")
          .insert([emergencyPayload]);

        if (emergencyError) {
          console.warn("Emergency contact save failed:", emergencyError);
          optionalWarnings.push(
            `patient_emergency_contact: ${emergencyError.message}`
          );
        }
      }

      const relatedPatientRecords = [
        {
          table: "patient_obstetric_history",
          payload: createObstetricHistoryPayload(form, savedPatient),
        },
        {
          table: "patient_medical_history",
          payload: createMedicalHistoryPayload(form, savedPatient),
        },
      ];

      for (const record of relatedPatientRecords) {
        const warning = await saveOptionalPatientRecord(
          record.table,
          record.payload
        );

        if (warning) {
          optionalWarnings.push(warning);
        }
      }

      const { data: patientLoginData, error: patientLoginError } =
        await savePatientLoginCredential(
          createPatientLoginPayload(
            form,
            savedPatient,
            workingCredentials
          )
        );

      if (patientLoginError) {
        console.warn("Patient login credential save failed:", patientLoginError);

        if (!isPatientLoginPolicyError(patientLoginError)) {
          optionalWarnings.push(`patient_login: ${patientLoginError.message}`);
        }
      }

      const savedLoginCredentials = toCredentialEntry(
        patientLoginData || workingCredentials
      );
      const newPatient = mapSupabasePatient(savedPatient);
      const shouldDisplayNewPatient =
        getPatientStatusGroup(newPatient) !== "Archived";
      const nextCredentialPool = addCredentialsToPool(
        addCredentialsToPool(credentialPool, savedLoginCredentials),
        newPatient
      );

      setPatients((current) =>
        shouldDisplayNewPatient ? [newPatient, ...current] : current
      );
      setCredentialPool(nextCredentialPool);
      setForm(blankForm);
      setAccessCredentials(createAccessCredentials(nextCredentialPool));
      setStep(1);
      setScreen("list");
      setActiveModal("saved");
      if (optionalWarnings.length) {
        setStatusMessage(
          `Patient saved in Supabase. Some optional details were not saved: ${optionalWarnings.join(
            " | "
          )}`
        );
      }
    } catch (error) {
      console.error("Register patient failed:", error);

      const cleanupErrors = savedPatient?.id
        ? await cleanupPartialRegistration({
            patientRecordId: savedPatient.id,
            personalInfoId: savedPersonalInfoId,
          })
        : [];

      if (cleanupErrors.length) {
        setStatusMessage(
          `Unable to complete registration: ${error.message}. Some partial data could not be removed: ${cleanupErrors.join(
            " | "
          )}`
        );
      } else {
        setStatusMessage(`Unable to complete registration: ${error.message}`);
      }
    } finally {
      setIsSavingPatient(false);
    }
  };

  const scrollRegistrationToTop = () => {
    window.requestAnimationFrame(() => {
      registrationTopRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  };

  const validateRegistrationStep = (stepNumber, showMessage = true) => {
    let message = "";

    if (stepNumber === 1) {
      if (!form.name.trim()) message = "Patient name is required.";
      else if (!form.age.trim() || !form.birthdate || !form.address.trim()) {
        message = "Please complete the required age, birthdate, and home address fields.";
      } else if (isFutureDateInput(form.birthdate)) {
        message = "Birthdate cannot be in the future.";
      } else if (!form.contactNumber.trim()) {
        message = "Patient contact number is required.";
      }
    }

    if (stepNumber === 2) {
      if (!form.gravida.trim() || !form.para.trim()) {
        message = "Gravida and Para are required.";
      } else {
        const ageAtMenarche = parseOptionalNumber(form.ageMenarche);
        const cycleLength = parseOptionalNumber(form.cycleLength);
        const menstruationDuration = parseOptionalNumber(form.durationMenstruation);
        const gravida = parseOptionalNumber(form.gravida);
        const para = parseOptionalNumber(form.para);

        if (!isNumberInRange(ageAtMenarche, 8, 25)) {
          message = "Age at Menarche must be between 8 and 25 years old. Leave it blank if unknown.";
        } else if (gravida !== null && gravida < 0) {
          message = "Gravida cannot be negative.";
        } else if (para !== null && para < 0) {
          message = "Para cannot be negative.";
        } else if (gravida !== null && para !== null && para > gravida) {
          message = "Para should not exceed Gravida.";
        } else if (cycleLength !== null && (cycleLength < 15 || cycleLength > 60)) {
          message = "Cycle Length must be between 15 and 60 days. Example: 28.";
        } else if (
          menstruationDuration !== null &&
          (menstruationDuration < 1 || menstruationDuration > 15)
        ) {
          message = "Duration of Menstruation must be between 1 and 15 days. Example: 5.";
        } else if (isFutureDateInput(form.lmp)) {
          message = "Last Menstrual Period cannot be in the future.";
        }
      }
    }

    if (stepNumber === 3) {
      const incompleteAllergy = normalizeStructuredAllergies(form).find(
        (entry) =>
          (entry.type || entry.allergen || entry.reaction) &&
          (!entry.type || !entry.allergen || !entry.reaction)
      );

      if (incompleteAllergy) {
        message = "Complete Allergy Type, Allergen, and Reaction for each allergy entry.";
      } else if (
        form.medicalConditions.includes("Others") &&
        !form.medicalOther.trim()
      ) {
        message = "Specify the other medical condition before saving.";
      } else if (
        form.maternalFamilyHistory.includes("Others") &&
        !form.maternalFamilyOther.trim()
      ) {
        message = "Specify the other family history on the Mother’s side before saving.";
      } else if (
        form.paternalFamilyHistory.includes("Others") &&
        !form.paternalFamilyOther.trim()
      ) {
        message = "Specify the other family history on the Father’s side before saving.";
      }
    }

    if (message && showMessage) {
      setStep(stepNumber);
      setRegistrationView("form");
      setStatusMessage(message);
      scrollRegistrationToTop();
    }

    return !message;
  };

  const moveToRegistrationStep = (nextStep) => {
    if (nextStep > step && !validateRegistrationStep(step)) return;
    setStatusMessage("");
    setStep(nextStep);
    setRegistrationView("form");
    scrollRegistrationToTop();
  };

  const reviewRegistration = () => {
    for (let stepNumber = 1; stepNumber <= steps.length; stepNumber += 1) {
      if (!validateRegistrationStep(stepNumber)) return;
    }

    setStep(3);
    setStatusMessage("");
    setRegistrationView("review");
    scrollRegistrationToTop();
  };

  const backToEditRegistration = () => {
    if (
      registrationRecord &&
      registrationRecord.registration_status !==
        "awaiting_patient_access_confirmation"
    ) {
      setStatusMessage("This Patient registration has already been completed.");
      return;
    }

    setStatusMessage("");
    setRegistrationView("form");
    setStep(3);
    scrollRegistrationToTop();
  };

  const createRegistrationToken = () => {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    const randomHex = () => Math.floor(Math.random() * 16).toString(16);
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (token) => {
      const value = token === "x" ? Number.parseInt(randomHex(), 16) : 8 + Math.floor(Math.random() * 4);
      return value.toString(16);
    });
  };

  const generatePatientAccess = async () => {
    if (isSavingPatient) return;
    if (!selectedWalkInSlot?.reservationId) {
      setStatusMessage("The selected walk-in slot is no longer available. Please select another time.");
      setScreen("select-slot");
      navigate("/staff/patients/new/select-slot");
      return;
    }
    if (
      registrationRecord &&
      registrationRecord.registration_status !==
        "awaiting_patient_access_confirmation"
    ) {
      setStatusMessage("This Patient registration has already been completed.");
      return;
    }
    for (let stepNumber = 1; stepNumber <= steps.length; stepNumber += 1) {
      if (!validateRegistrationStep(stepNumber)) return;
    }

    const stableToken = registrationToken || createRegistrationToken();
    if (!registrationToken) setRegistrationToken(stableToken);
    setIsSavingPatient(true);
    setStatusMessage("");

    try {
      const { data, error } = await supabase.rpc("save_patient_registration", {
        p_registration_token: stableToken,
        p_patient_record_id: registrationRecord?.id || null,
        p_registration_data: createRegistrationDataPayload(form, selectedWalkInSlot),
      });

      if (error) throw error;
      const savedRecord = Array.isArray(data) ? data[0] : data;
      if (!savedRecord?.id || !savedRecord?.patient_id || !savedRecord?.control_number) {
        throw new Error("The registration save did not return Patient access details.");
      }

      setRegistrationRecord(savedRecord);
      setAccessCredentials({
        patientId: savedRecord.patient_id,
        controlNumber: savedRecord.control_number,
      });
      setQrReceiptConfirmed(false);
      setRegistrationView("confirmation");
      window.sessionStorage.setItem(
        staffRegistrationSessionKey,
        JSON.stringify({
          patientRecordId: savedRecord.id,
          registrationToken: stableToken,
        })
      );
      scrollRegistrationToTop();
    } catch (error) {
      console.error("Generate Patient access failed:", error);
      const isMissingRpc =
        error.code === "42883" ||
        error.code === "PGRST202" ||
        String(error.message || "").toLowerCase().includes("could not find the function");
      setStatusMessage(
        isMissingRpc
          ? "Patient registration workflow is not available yet. Apply the reviewed supabase_patient_registration_workflow.sql file, then retry."
          : `Unable to generate Patient access: ${error.message}`
      );
    } finally {
      setIsSavingPatient(false);
    }
  };

  const copyRegistrationValue = async (label, value) => {
    if (!value) return;
    try {
      await copyTextToClipboard(value);
      setCopyMessage(`${label} copied.`);
    } catch {
      setCopyMessage(`Unable to copy ${label.toLowerCase()}.`);
    }
  };

  const finishRegistration = async () => {
    if (
      finishRegistrationLockRef.current ||
      isFinishingRegistration ||
      !qrReceiptConfirmed ||
      !registrationRecord?.id ||
      !registrationToken
    ) {
      return;
    }

    finishRegistrationLockRef.current = true;
    setIsFinishingRegistration(true);
    setStatusMessage("");

    try {
      const finishRpcName = selectedWalkInSlot?.reservationId
        ? "finish_walkin_patient_registration"
        : "finish_patient_registration";
      const finishPayload = selectedWalkInSlot?.reservationId
        ? {
            p_patient_record_id: registrationRecord.id,
            p_registration_token: registrationToken,
            p_reservation_id: selectedWalkInSlot.reservationId,
            p_access_handoff_confirmed: true,
          }
        : {
            p_patient_record_id: registrationRecord.id,
            p_registration_token: registrationToken,
            p_access_handoff_confirmed: true,
          };
      const { data, error } = await supabase.rpc(finishRpcName, finishPayload);
      if (error) throw error;

      const completedRecord = Array.isArray(data) ? data[0] : data;
      if (completedRecord?.id) {
        const mappedPatient = mapSupabasePatient(completedRecord);
        setPatients((current) => {
          const withoutCurrent = current.filter(
            (patient) => patient.recordId !== mappedPatient.recordId
          );
          return [mappedPatient, ...withoutCurrent];
        });
      }

      let appointmentNotificationResult = null;
      if (selectedWalkInSlot?.reservationId) {
        const { data: completedReservation, error: reservationError } =
          await supabase
            .from("staff_walkin_registration_reservations")
            .select("schedule_id, patient_record_id")
            .eq("id", selectedWalkInSlot.reservationId)
            .maybeSingle();

        if (reservationError || !completedReservation?.schedule_id) {
          if (import.meta.env.DEV) {
            console.warn("[Walk-in Appointment Notification] schedule lookup failed:", {
              code: reservationError?.code || null,
              message:
                reservationError?.message ||
                "The completed walk-in reservation returned no schedule ID.",
            });
          }
          appointmentNotificationResult = {
            ok: false,
            error:
              reservationError ||
              new Error("The completed reservation returned no schedule ID."),
          };
        } else {
          appointmentNotificationResult =
            await sendAutomaticAppointmentNotification({
              patientId:
                completedReservation.patient_record_id || completedRecord?.id,
              scheduleId: completedReservation.schedule_id,
              notificationType: "appointment_created",
            });
        }
      }

      setForm(blankForm);
      window.sessionStorage.removeItem(staffRegistrationSessionKey);
      window.sessionStorage.removeItem(staffWalkInSlotSessionKey);
      setAccessCredentials({ patientId: "", controlNumber: "" });
      setRegistrationRecord(null);
      setRegistrationToken("");
      setSelectedWalkInSlot(null);
      setSelectedSlotId("");
      setQrReceiptConfirmed(false);
      setRegistrationView("form");
      setStep(1);
      setScreen("list");
      navigate("/staff/patients");
      setStatusMessage(
        appointmentNotificationResult
          ? appointmentNotificationResult.ok
            ? "Patient registration completed. Appointment created and Patient notified."
            : "Patient registration completed and the appointment was saved, but the Patient notification could not be sent."
          : "Patient registration completed successfully. The Patient can now create or log in to their Patient account using the QR code and one-time control number."
      );
      setActiveModal("saved");
    } catch (error) {
      console.error("Finish Patient registration failed:", error);
      setStatusMessage(
        isMissingWalkInRpcError(error)
          ? "Walk-in finalization is not available yet. Apply the reviewed supabase_staff_walkin_registration.sql file, then retry."
          : `Unable to finish Patient registration: ${error.message}`
      );
    } finally {
      finishRegistrationLockRef.current = false;
      setIsFinishingRegistration(false);
    }
  };

  const closeModal = () => {
    setActiveModal(null);
  };

  const renderStepContent = () => {
    if (step === 1) {
      return (
        <section className="staff-register-card">
          <header>
            <span>
              <Icon icon="solar:document-medicine-linear" aria-hidden="true" />
            </span>
            <h3>1. Basic Information</h3>
          </header>

          <div className="staff-register-grid">
            <InputField
              label="Patient's Name"
              required
              value={form.name}
              onChange={(value) => updateForm("name", value)}
              placeholder="Enter Full Name"
              className="is-wide"
            />
            <InputField
              label="Age"
              required
              value={form.age}
              onChange={(value) => updateForm("age", value)}
            />
            <InputField
              label="Birthdate"
              required
              type="date"
              value={form.birthdate}
              onChange={updateBirthdate}
              icon="solar:calendar-linear"
            />
            <InputField
              label="Home Address"
              required
              value={form.address}
              onChange={(value) => updateForm("address", value)}
              placeholder="House no., Street, Barangay, City/Municipality"
              className="is-full"
            />
            <InputField
              label="Contact Number"
              required
              value={form.contactNumber}
              onChange={(value) => updateForm("contactNumber", value)}
              placeholder="09XXXXXXXXX"
              className="is-half"
            />
            <InputField
              label="Occupation"
              value={form.occupation}
              onChange={(value) => updateForm("occupation", value)}
              className="is-half"
            />
            <InputField
              label="Work Address"
              value={form.workAddress}
              onChange={(value) => updateForm("workAddress", value)}
              className="is-half"
            />
            <InputField
              label="Company"
              value={form.company}
              onChange={(value) => updateForm("company", value)}
              className="is-half"
            />
            <InputField
              label="Work Contact Number"
              value={form.workContactNumber}
              onChange={(value) => updateForm("workContactNumber", value)}
              className="is-half"
            />
            <InputField
              label="Email Address"
              value={form.email}
              onChange={(value) => updateForm("email", value)}
              className="is-half"
            />
            <InputField
              label="Husband/Partner"
              value={form.husbandPartner}
              onChange={(value) => updateForm("husbandPartner", value)}
              className="is-half"
            />
            <InputField
              label="Contact Number"
              value={form.partnerContactNumber}
              onChange={(value) => updateForm("partnerContactNumber", value)}
              className="is-half"
            />
          </div>

          <footer className="staff-register-footer is-end">
            <button type="button" className="staff-next-btn" onClick={() => moveToRegistrationStep(2)}>
              Next
              <Icon icon="solar:arrow-right-linear" aria-hidden="true" />
            </button>
          </footer>
        </section>
      );
    }

    if (step === 2) {
      return (
        <section className="staff-register-card">
          <header>
            <span>
              <Icon icon="solar:document-medicine-linear" aria-hidden="true" />
            </span>
            <h3>2. Reproductive & Obstetric History</h3>
          </header>

          <div className="staff-register-grid is-three">
            <InputField
              label="Age at Menarche"
              value={form.ageMenarche}
              onChange={(value) => updateForm("ageMenarche", value)}
              placeholder="Enter age"
            />
            <RadioGroup
              label="Menstrual Pattern"
              value={form.menstrualPattern}
              onChange={(value) => updateForm("menstrualPattern", value)}
              options={["Regular", "Irregular"]}
            />
            <InputField
              label="Cycle Length"
              value={form.cycleLength}
              onChange={(value) => updateForm("cycleLength", value)}
              placeholder="Enter days"
            />
            <InputField
              label="Duration of Menstruation"
              value={form.durationMenstruation}
              onChange={(value) => updateForm("durationMenstruation", value)}
              placeholder="Enter days"
            />
            <RadioGroup
              label="Sexually Active"
              value={form.sexuallyActive}
              onChange={(value) => updateForm("sexuallyActive", value)}
              options={["Yes", "No"]}
            />
            <ContraceptiveMethodSelect
              value={form.contraceptiveMethod}
              onChange={(value) => updateForm("contraceptiveMethod", value)}
            />
            <div className="staff-step2-two-column is-full">
              <InputField
                label="Gravida (G)"
                required
                value={form.gravida}
                onChange={(value) => updateForm("gravida", value)}
                placeholder="Enter number"
              />
              <InputField
                label="Para (P)"
                required
                value={form.para}
                onChange={(value) => updateForm("para", value)}
                placeholder="Enter number"
              />
              <InputField
              label="Last Menstrual Period (LMP)"
              type="date"
              value={form.lmp}
                onChange={updateLmp}
              />
              <InputField
                label="Estimated Due Date (EDD)"
                type="date"
                value={form.edd}
                onChange={(value) => updateForm("edd", value)}
              />
            </div>
          </div>

          <div className="staff-pregnancy-table-heading">
            <div>
              <strong>Previous Pregnancy Records</strong>
              <span>Add a row only when the Patient has a previous pregnancy history.</span>
            </div>
            <div className="staff-pregnancy-table-actions">
            <button type="button" onClick={addPregnancyRecord}>
              <Icon icon="solar:add-circle-linear" aria-hidden="true" />
              Add Pregnancy
            </button>
            </div>
          </div>

          <div className="staff-pregnancy-table-wrap">
            <table className="staff-pregnancy-table">
              <thead>
                <tr>
                  <th>Birthdate</th>
                  <th>Term / Preterm</th>
                  <th>Type of Delivery</th>
                  <th>Place of Delivery</th>
                  <th>Complications</th>
                  <th>NBS Result</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {form.pregnancyRecords.length ? (
                  form.pregnancyRecords.map((record, index) => (
                    <tr key={record.id || `pregnancy-record-${index}`}>
                      <td>
                        <input
                          type="date"
                          value={record.birthdate}
                          onChange={(event) =>
                            updatePregnancyRecord(index, "birthdate", event.target.value)
                          }
                          aria-label="Pregnancy birthdate"
                        />
                      </td>
                      <td>
                        <select
                          value={record.termPreterm}
                          onChange={(event) =>
                            updatePregnancyRecord(index, "termPreterm", event.target.value)
                          }
                          aria-label="Term or preterm"
                        >
                          <option value="">Select</option>
                          <option value="Term">Term</option>
                          <option value="Preterm">Preterm</option>
                          <option value="Post-term">Post-term</option>
                        </select>
                      </td>
                      <td>
                        <select
                          value={record.deliveryType}
                          onChange={(event) =>
                            updatePregnancyRecord(index, "deliveryType", event.target.value)
                          }
                          aria-label="Type of delivery"
                        >
                          <option value="">Select</option>
                          <option value="Normal Spontaneous Vaginal Delivery">
                            Normal Spontaneous Vaginal Delivery
                          </option>
                          <option value="Cesarean Section">Cesarean Section</option>
                          <option value="Assisted Vaginal Delivery">
                            Assisted Vaginal Delivery
                          </option>
                        </select>
                      </td>
                      <td>
                        <input
                          type="text"
                          value={record.deliveryPlace}
                          onChange={(event) =>
                            updatePregnancyRecord(index, "deliveryPlace", event.target.value)
                          }
                          placeholder="Enter place"
                          aria-label="Place of delivery"
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={record.complications}
                          onChange={(event) =>
                            updatePregnancyRecord(index, "complications", event.target.value)
                          }
                          placeholder="None"
                          aria-label="Complications"
                        />
                      </td>
                      <td>
                        <select
                          value={record.nbsResult}
                          onChange={(event) =>
                            updatePregnancyRecord(index, "nbsResult", event.target.value)
                          }
                          aria-label="NBS result"
                        >
                          <option value="">Select</option>
                          <option value="Normal">Normal</option>
                          <option value="Abnormal">Abnormal</option>
                          <option value="Pending">Pending</option>
                          <option value="Not Done">Not Done</option>
                        </select>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="staff-pregnancy-remove-btn"
                          onClick={() => removePregnancyRecord(record.id)}
                          aria-label="Remove pregnancy record"
                        >
                          <Icon icon="solar:trash-bin-trash-linear" aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan="7">No pregnancy record added yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <footer className="staff-register-footer">
            <button type="button" className="staff-prev-btn" onClick={() => moveToRegistrationStep(1)}>
              <Icon icon="solar:arrow-left-linear" aria-hidden="true" />
              Previous
            </button>
            <button type="button" className="staff-next-btn" onClick={() => moveToRegistrationStep(3)}>
              Next
              <Icon icon="solar:arrow-right-linear" aria-hidden="true" />
            </button>
          </footer>
        </section>
      );
    }

    if (step === 3) {
      return (
        <section className="staff-register-card staff-register-medical-history-card">
          <header>
            <span>
              <Icon icon="solar:document-medicine-linear" aria-hidden="true" />
            </span>
            <h3>3. Medical & Family History</h3>
          </header>

          <div className="staff-register-grid">
            <SelectField
              label="Blood Type"
              value={form.bloodType}
              onChange={(value) => updateForm("bloodType", value)}
              className="is-half"
            >
              <option value="">Select blood type</option>
              {bloodTypeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </SelectField>

            <div className="staff-allergy-group is-full">
              <label>Allergies</label>
              <div className="staff-allergy-entry-list">
                {(Array.isArray(form.allergies) && form.allergies.length
                  ? form.allergies
                  : [createBlankAllergyRecord()]
                ).map((record, allergyIndex) => (
                  <div
                    className={`staff-allergy-entry-row ${
                      allergyIndex > 0 ? "has-remove" : ""
                    }`}
                    key={record.id}
                  >
                    <AllergyTypeSelect
                      value={record.type}
                      onChange={(value) => updateAllergyRecord(record.id, "type", value)}
                    />
                    <InputField
                      label=""
                      value={record.allergen}
                      onChange={(value) => updateAllergyRecord(record.id, "allergen", value)}
                      placeholder="Enter Allergen"
                    />
                    <InputField
                      label=""
                      value={record.reaction}
                      onChange={(value) => updateAllergyRecord(record.id, "reaction", value)}
                      placeholder="Enter Reaction"
                    />
                    {allergyIndex > 0 ? (
                      <button
                        type="button"
                        className="staff-allergy-icon-btn"
                        onClick={() => removeAllergyRecord(record.id)}
                        aria-label="Remove allergy row"
                      >
                        <Icon icon="solar:trash-bin-trash-linear" aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>

              <button
                type="button"
                className="staff-add-allergy-btn is-icon-only"
                onClick={() => addAllergyRecord()}
                aria-label="Add another allergy row"
                title="Add another allergy"
              >
                <Icon icon="solar:add-linear" aria-hidden="true" />
              </button>
            </div>

            <section className="staff-check-section is-full">
              <h4>History of Medical Conditions <span>(Check all that apply)</span></h4>

              <div className="staff-check-columns is-medical">
                <div className="staff-check-column">
                  {["Hypertension", "Diabetes Mellitus", "Asthma"].map((option) => (
                    <CheckboxItem
                      key={option}
                      label={option}
                      checked={form.medicalConditions.includes(option)}
                      onChange={(checked) =>
                        toggleArrayValue("medicalConditions", option, checked)
                      }
                    />
                  ))}
                </div>

                <div className="staff-check-column">
                  {["Thyroid Disorder", "Kidney Disease", "Others"].map((option) => (
                    <CheckboxItem
                      key={option}
                      label={option}
                      checked={form.medicalConditions.includes(option)}
                      onChange={(checked) =>
                        toggleArrayValue("medicalConditions", option, checked)
                      }
                    />
                  ))}

                  <InputField
                    label=""
                    value={form.medicalOther}
                    onChange={(value) => updateForm("medicalOther", value)}
                    placeholder="Specify"
                    className="staff-specify-field"
                  />
                </div>
              </div>
            </section>

            <section className="staff-check-section is-full staff-family-history-side">
              <h4>Family History (Mother&apos;s Side)</h4>

              <div className="staff-check-columns is-family is-family-side">
                <div className="staff-check-column">
                  {["Hypertension", "Diabetes Mellitus", "Asthma"].map((option) => (
                    <CheckboxItem
                      key={option}
                      label={option}
                      checked={form.maternalFamilyHistory.includes(option)}
                      onChange={(checked) =>
                        toggleArrayValue("maternalFamilyHistory", option, checked)
                      }
                    />
                  ))}
                </div>

                <div className="staff-check-column">
                  {["Tuberculosis", "Cancer", "Goiter"].map((option) => (
                    <CheckboxItem
                      key={option}
                      label={option}
                      checked={form.maternalFamilyHistory.includes(option)}
                      onChange={(checked) =>
                        toggleArrayValue("maternalFamilyHistory", option, checked)
                      }
                    />
                  ))}
                </div>

                <div className="staff-check-column">
                  {["Heart Disease", "Twin Pregnancy", "Others"].map((option) => (
                    <CheckboxItem
                      key={option}
                      label={option}
                      checked={form.maternalFamilyHistory.includes(option)}
                      onChange={(checked) =>
                        toggleArrayValue("maternalFamilyHistory", option, checked)
                      }
                    />
                  ))}

                  <InputField
                    label=""
                    value={form.maternalFamilyOther}
                    onChange={(value) => updateForm("maternalFamilyOther", value)}
                    placeholder="Specify"
                    className="staff-specify-field"
                  />
                </div>
              </div>
            </section>

            <section className="staff-check-section is-full staff-family-history-side">
              <h4>Family History (Father&apos;s Side)</h4>

              <div className="staff-check-columns is-family is-family-side">
                <div className="staff-check-column">
                  {["Hypertension", "Diabetes Mellitus", "Asthma"].map((option) => (
                    <CheckboxItem
                      key={option}
                      label={option}
                      checked={form.paternalFamilyHistory.includes(option)}
                      onChange={(checked) =>
                        toggleArrayValue("paternalFamilyHistory", option, checked)
                      }
                    />
                  ))}
                </div>

                <div className="staff-check-column">
                  {["Tuberculosis", "Cancer", "Goiter"].map((option) => (
                    <CheckboxItem
                      key={option}
                      label={option}
                      checked={form.paternalFamilyHistory.includes(option)}
                      onChange={(checked) =>
                        toggleArrayValue("paternalFamilyHistory", option, checked)
                      }
                    />
                  ))}
                </div>

                <div className="staff-check-column">
                  {["Heart Disease", "Twin Pregnancy", "Others"].map((option) => (
                    <CheckboxItem
                      key={option}
                      label={option}
                      checked={form.paternalFamilyHistory.includes(option)}
                      onChange={(checked) =>
                        toggleArrayValue("paternalFamilyHistory", option, checked)
                      }
                    />
                  ))}

                  <InputField
                    label=""
                    value={form.paternalFamilyOther}
                    onChange={(value) => updateForm("paternalFamilyOther", value)}
                    placeholder="Specify"
                    className="staff-specify-field"
                  />
                </div>
              </div>
            </section>
          </div>

          <footer className="staff-register-footer">
            <button type="button" className="staff-prev-btn" onClick={() => moveToRegistrationStep(2)}>
              <Icon icon="solar:arrow-left-linear" aria-hidden="true" />
              Previous
            </button>
            <button type="button" className="staff-next-btn" onClick={reviewRegistration}>
              Next
              <Icon icon="solar:arrow-right-linear" aria-hidden="true" />
            </button>
          </footer>
        </section>
      );
    }

    return null;
  };

  const renderReviewContent = () => (
    <section className="staff-register-card staff-registration-review">
      <header>
        <span><Icon icon="solar:clipboard-check-linear" aria-hidden="true" /></span>
        <div>
          <h3>Review Patient Information</h3>
          <p>Confirm the selected walk-in slot and three registration sections before generating Patient access.</p>
        </div>
      </header>

      <div className="staff-registration-review-grid">
        <section>
          <h4>Walk-in Slot</h4>
          <dl>
            <div><dt>Doctor</dt><dd>{selectedWalkInSlot?.doctorName || selectedDoctor?.name || "Not selected"}</dd></div>
            <div><dt>Specialization</dt><dd>{selectedWalkInSlot?.specialization || selectedDoctor?.specialization || "Not provided"}</dd></div>
            <div><dt>Date</dt><dd>{formatSelectedWalkInDate(selectedWalkInSlot?.date)}</dd></div>
            <div><dt>Time</dt><dd>{selectedWalkInSlot?.time ? formatSlotTime(selectedWalkInSlot.date, selectedWalkInSlot.time) : "Not selected"}</dd></div>
          </dl>
          <button type="button" onClick={() => navigate("/staff/patients/new/select-slot")}>Edit Walk-in Slot</button>
        </section>
        <section>
          <h4>Basic Information</h4>
          <dl>
            <div><dt>Patient</dt><dd>{form.name}</dd></div>
            <div><dt>Birthdate</dt><dd>{form.birthdate}</dd></div>
            <div><dt>Age</dt><dd>{form.age}</dd></div>
            <div><dt>Contact</dt><dd>{form.contactNumber}</dd></div>
            <div><dt>Address</dt><dd>{form.address}</dd></div>
          </dl>
          <button type="button" onClick={() => moveToRegistrationStep(1)}>Edit Basic Information</button>
        </section>
        <section>
          <h4>Reproductive &amp; Obstetric</h4>
          <dl>
            <div><dt>Gravida / Para</dt><dd>{form.gravida} / {form.para}</dd></div>
            <div><dt>Menstrual pattern</dt><dd>{form.menstrualPattern}</dd></div>
            <div><dt>LMP</dt><dd>{form.lmp || "Not provided"}</dd></div>
            <div><dt>EDD</dt><dd>{form.edd || "Not provided"}</dd></div>
            <div><dt>Pregnancies</dt><dd>{getPregnancyRecordList(form).length || "None added"}</dd></div>
          </dl>
          <button type="button" onClick={() => moveToRegistrationStep(2)}>Edit Obstetric History</button>
        </section>
        <section>
          <h4>Medical &amp; Family History</h4>
          <dl>
            <div><dt>Blood type</dt><dd>{form.bloodType || "Not provided"}</dd></div>
            <div><dt>Allergies</dt><dd>{getAllergyList(form).join(", ") || "None reported"}</dd></div>
            <div><dt>Medical conditions</dt><dd>{getMedicalConditionList(form).join(", ") || "None reported"}</dd></div>
            <div><dt>Family history</dt><dd>{getFamilyHistoryList(form).join(", ") || "None reported"}</dd></div>
          </dl>
          <button type="button" onClick={() => moveToRegistrationStep(3)}>Edit Medical History</button>
        </section>
      </div>

      <footer className="staff-register-footer has-divider">
        <button type="button" className="staff-prev-btn" onClick={() => moveToRegistrationStep(3)}>
          <Icon icon="solar:arrow-left-linear" aria-hidden="true" />
          Back to Edit
        </button>
        <button type="button" className="staff-next-btn" onClick={generatePatientAccess} disabled={isSavingPatient}>
          {isSavingPatient ? "Generating Patient Access..." : "Generate Patient Access"}
        </button>
      </footer>
    </section>
  );

  const renderConfirmationContent = () => {
    const accessUrl = buildPatientAccessUrl(accessCredentials);

    return (
      <section className="staff-register-card staff-access-confirmation">
        <header>
          <span><Icon icon="solar:qr-code-linear" aria-hidden="true" /></span>
          <div>
            <h3>Patient Access Confirmation</h3>
            <p>Provide these access details directly to {form.name}.</p>
          </div>
        </header>

        <div className="staff-access-confirmation-layout">
          <div className="staff-access-confirmation-qr">
            <QRCodeCanvas value={accessUrl} size={224} level="H" includeMargin />
            <strong>{form.name}</strong>
            <span>{accessCredentials.patientId}</span>
          </div>
          <div className="staff-access-confirmation-details">
            <section>
              <span>Patient ID</span>
              <strong>{accessCredentials.patientId}</strong>
              <button type="button" onClick={() => copyRegistrationValue("Patient ID", accessCredentials.patientId)}>
                <Icon icon="solar:copy-linear" aria-hidden="true" /> Copy Patient ID
              </button>
            </section>
            <section>
              <span>One-time control number</span>
              <strong>{accessCredentials.controlNumber}</strong>
              <button type="button" onClick={() => copyRegistrationValue("Control number", accessCredentials.controlNumber)}>
                <Icon icon="solar:copy-linear" aria-hidden="true" /> Copy Control Number
              </button>
            </section>
            <section className="is-link">
              <span>Patient Access Link</span>
              <a href={accessUrl} target="_blank" rel="noreferrer">{accessUrl}</a>
              <button type="button" onClick={() => copyRegistrationValue("Access link", accessUrl)}>
                <Icon icon="solar:copy-linear" aria-hidden="true" /> Copy Access Link
              </button>
            </section>
            <button type="button" className="staff-print-access-btn" onClick={() => window.print()}>
              <Icon icon="solar:printer-linear" aria-hidden="true" /> Print Access Slip
            </button>
            {copyMessage ? <p className="staff-access-copy-message" role="status">{copyMessage}</p> : null}
          </div>
        </div>

        <div className="staff-access-instruction">
          <Icon icon="solar:smartphone-2-linear" aria-hidden="true" />
          <p>Ask the Patient to scan the QR code using their phone. Confirm that the Patient Access page opens before finishing the registration.</p>
        </div>

        <label className="staff-access-receipt-check">
          <input type="checkbox" checked={qrReceiptConfirmed} onChange={(event) => setQrReceiptConfirmed(event.target.checked)} />
          <span>I confirm that the Patient received or scanned the QR code and received the one-time control number.</span>
        </label>

        <footer className="staff-register-footer has-divider">
          <button type="button" className="staff-prev-btn" onClick={backToEditRegistration} disabled={isFinishingRegistration || registrationRecord?.registration_status !== "awaiting_patient_access_confirmation"}>
            <Icon icon="solar:arrow-left-linear" aria-hidden="true" /> Back to Edit
          </button>
          <button type="button" className="staff-next-btn" onClick={finishRegistration} disabled={!qrReceiptConfirmed || isFinishingRegistration}>
            {isFinishingRegistration ? "Finishing Registration..." : "Finish Registration"}
          </button>
        </footer>
      </section>
    );
  };

  const openWalkInDatePicker = () => {
    const dateInput = walkInDateInputRef.current;
    if (!dateInput) return;

    try {
      if (typeof dateInput.showPicker === "function") {
        dateInput.showPicker();
        return;
      }
    } catch {
      // Fall through to the normal focus/click fallback.
    }

    dateInput.focus();
    dateInput.click();
  };

  const renderWalkInSelection = () => {
    const availableSlotSelected =
      !activeWalkInReservation && selectedSlot?.status === "available";
    const reservedDoctorName =
      reservedDoctor?.name || activeWalkInReservation?.doctorName || "Doctor";
    const reservedSlotLabel = activeWalkInReservation
      ? formatSlotTime(
          activeWalkInReservation.date,
          activeWalkInReservation.time
        )
      : "";

    const isSlotReservedByCurrentStaff = (slot) => {
      if (!activeWalkInReservation) return false;

      return (
        activeWalkInReservation.doctorId === selectedDoctor?.id &&
        activeWalkInReservation.date === selectedDate &&
        normalizeWalkInTime(activeWalkInReservation.time) ===
          normalizeWalkInTime(slot.time)
      );
    };

    return (
      <section className="staff-register-page staff-walkin-page">
        <div className="staff-register-shell staff-walkin-shell">
          <button type="button" className="staff-back-btn" onClick={backToPatients}>
            <Icon icon="solar:arrow-left-linear" aria-hidden="true" />
            Back to Patients
          </button>

          <div className="staff-walkin-top">
            <h2>Add New Patient</h2>
            <p>Select an available walk-in time before registering the Patient.</p>
          </div>

          {isLoadingWalkInSlots ? (
            <p className="staff-patients-status-message" role="status">
              Loading available walk-in slots...
            </p>
          ) : null}
          {walkInError ? (
            <p className="staff-patients-status-message" role="alert">
              {walkInError}
            </p>
          ) : null}
          {walkInNotice ? (
            <p className="staff-patients-status-message is-success" role="status">
              {walkInNotice}
            </p>
          ) : null}

          <section className="staff-walkin-doctor-card" aria-label="Doctor walk-in summary">
            <div className="staff-walkin-doctor-profile">
              <span className="staff-walkin-avatar">
                {selectedDoctor?.avatarUrl ? (
                  <img src={selectedDoctor.avatarUrl} alt="" />
                ) : (
                  getInitials(selectedDoctor?.name || "Doctor")
                )}
              </span>
              <div>
                {doctors.length > 1 ? (
                  <label className="staff-walkin-doctor-select">
                    <span>Doctor</span>
                    <select
                      value={selectedDoctorId}
                      disabled={Boolean(activeWalkInReservation)}
                      onChange={(event) => {
                        setSelectedDoctorId(event.target.value);
                        setSelectedSlotId("");
                      }}
                    >
                      {doctors.map((doctor) => (
                        <option key={doctor.id} value={doctor.id}>
                          {doctor.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <h3>{selectedDoctor?.name || "No active Doctor is available."}</h3>
                )}
                <p>{selectedDoctor?.specialization || "No specialization available"}</p>
              </div>
            </div>

            <div className="staff-walkin-stat">
              <Icon icon="solar:user-linear" aria-hidden="true" />
              <strong>
                {selectedDoctor ? `${selectedDoctor.scheduledCount} / ${selectedDoctor.dailyCapacity}` : "0 / 0"}
              </strong>
              <span>Scheduled Patients Today</span>
            </div>

            <div className="staff-walkin-stat">
              <Icon icon="solar:user-plus-linear" aria-hidden="true" />
              <strong>{selectedDoctor?.remainingSlots ?? 0}</strong>
              <span>Walk-in Slots Remaining</span>
            </div>
          </section>

          <section className="staff-walkin-slots-section">
            <div className="staff-walkin-slots-heading">
              <h3>Available Walk-in Time Slots</h3>
              <div className="staff-walkin-legend" aria-label="Slot legend">
                <span><i className="is-available" /> Available</span>
                <span><i className="is-selected" /> Selected</span>
                <span><i className="is-mine" /> Reserved by you</span>
                <span><i className="is-full" /> Full / Unavailable</span>
              </div>
            </div>

            <div className="staff-walkin-date-row">
              <label className="staff-walkin-date-display">
                <Icon icon="solar:calendar-linear" aria-hidden="true" />
                <span>{formatSelectedWalkInDate(selectedDate)}</span>
                <input
                  ref={walkInDateInputRef}
                  type="date"
                  value={selectedDate}
                  min={getManilaDateKey()}
                  disabled={Boolean(activeWalkInReservation)}
                  onChange={(event) => {
                    setSelectedDate(event.target.value);
                    setSelectedSlotId("");
                  }}
                  aria-label="Change walk-in date"
                />
              </label>

              <button
                type="button"
                className="staff-walkin-change-date-btn"
                disabled={Boolean(activeWalkInReservation)}
                onClick={openWalkInDatePicker}
              >
                Change Date
              </button>
            </div>

            <div className="staff-walkin-table-wrap">
              <table className="staff-walkin-table">
                <thead>
                  <tr>
                    <th aria-label="Select slot" />
                    <th>Time</th>
                    <th>Status</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleWalkInSlots.length ? (
                    visibleWalkInSlots.map((slot) => {
                      const isReservedByCurrentStaff =
                        isSlotReservedByCurrentStaff(slot);
                      const isSelected =
                        isReservedByCurrentStaff || selectedSlotId === slot.id;
                      const status = isReservedByCurrentStaff
                        ? "mine"
                        : isSelected
                          ? "selected"
                          : slot.status;
                      const disabled = activeWalkInReservation
                        ? !isReservedByCurrentStaff
                        : slot.status !== "available";

                      return (
                        <tr
                          key={slot.id}
                          className={
                            isReservedByCurrentStaff
                              ? "is-reserved-by-you"
                              : isSelected
                                ? "is-selected"
                                : ""
                          }
                          onClick={() => {
                            if (!disabled) setSelectedSlotId(slot.id);
                          }}
                        >
                          <td>
                            <label className="staff-walkin-radio">
                              <input
                                type="radio"
                                name="walkin-slot"
                                checked={isSelected}
                                disabled={disabled}
                                onChange={() => setSelectedSlotId(slot.id)}
                                aria-label={
                                  isReservedByCurrentStaff
                                    ? `${slot.label} is reserved by you`
                                    : `Select ${slot.label} walk-in slot`
                                }
                              />
                              <span />
                            </label>
                          </td>
                          <td><strong>{slot.label}</strong></td>
                          <td>
                            <span className={`staff-walkin-status is-${status}`}>
                              {status === "mine"
                                ? "RESERVED BY YOU"
                                : status === "selected"
                                  ? "SELECTED"
                                  : status.toUpperCase()}
                            </span>
                          </td>
                          <td>
                            {isReservedByCurrentStaff
                              ? `${reservationTimeLeft} · Continue the unfinished registration`
                              : slot.description}
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan="4" className="staff-walkin-empty">
                        {walkInEmptyMessage}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <div
            className={`staff-walkin-info-banner${
              activeWalkInReservation ? " is-active-reservation" : ""
            }`}
          >
            <Icon
              icon={
                activeWalkInReservation
                  ? "solar:clock-circle-linear"
                  : "solar:info-circle-linear"
              }
              aria-hidden="true"
            />
            {activeWalkInReservation ? (
              <span>
                <strong>Active reservation:</strong> {reservedDoctorName},{" "}
                {formatSelectedWalkInDate(activeWalkInReservation.date)} at{" "}
                {reservedSlotLabel}. {reservationTimeLeft}. Resume it or release it
                before choosing another schedule.
              </span>
            ) : (
              <span>Walk-in slots are limited based on the doctor's daily patient capacity.</span>
            )}
          </div>

          <footer className="staff-walkin-actions">
            {activeWalkInReservation ? (
              <>
                <button
                  type="button"
                  className="staff-prev-btn staff-release-slot-btn"
                  disabled={isReleasingSlot}
                  onClick={releaseActiveWalkInReservation}
                >
                  <Icon icon="solar:trash-bin-trash-linear" aria-hidden="true" />
                  {isReleasingSlot ? "Releasing Slot..." : "Release Slot"}
                </button>
                <button
                  type="button"
                  className="staff-next-btn"
                  disabled={isReleasingSlot}
                  onClick={resumeActiveWalkInRegistration}
                >
                  Resume Registration
                  <Icon icon="solar:arrow-right-linear" aria-hidden="true" />
                </button>
              </>
            ) : (
              <>
                <button type="button" className="staff-prev-btn" onClick={backToPatients}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="staff-next-btn"
                  disabled={!availableSlotSelected || isReservingSlot}
                  onClick={reserveSelectedWalkInSlot}
                >
                  {isReservingSlot ? "Reserving Slot..." : "Proceed to Registration"}
                  <Icon icon="solar:arrow-right-linear" aria-hidden="true" />
                </button>
              </>
            )}
          </footer>
        </div>
      </section>
    );
  };

  if (screen === "select-slot") {
    return renderWalkInSelection();
  }

  if (screen === "register") {
    return (
      <section className="staff-register-page" ref={registrationTopRef}>
        <div className="staff-register-shell">
          <div className="staff-register-workspace">
            <div className="staff-register-main-column">
              <button type="button" className="staff-back-btn" onClick={backToPatients}>
                <Icon icon="solar:arrow-left-linear" aria-hidden="true" />
                Back to Patients
              </button>

              <div className="staff-register-top">
                <div>
                  <h2>Register New Patient</h2>
                  <p>Fill out the Patient information to create a new record.</p>
                </div>
              </div>

              <Stepper currentStep={step} onStepSelect={moveToRegistrationStep} />
              {statusMessage ? (
                <p className="staff-patients-status-message">{statusMessage}</p>
              ) : null}

              <main className="staff-register-main">
                {registrationView === "review"
                  ? renderReviewContent()
                  : registrationView === "confirmation"
                    ? renderConfirmationContent()
                    : renderStepContent()}
              </main>
            </div>

            <aside className="staff-register-side">
              {registrationView === "confirmation" ? (
                <PatientRegisterSuccessCard isGenerated />
              ) : (
                <CredentialsPanel credentials={null} />
              )}
            </aside>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="staff-patients-page patient-directory patient-directory--staff">
      <PatientDirectoryHeader
        subtitle="Manage and view patient information across your practice."
        action={headerAction}
        className="staff-patients-header staff-section-header"
      />

      <PatientDirectoryToolbar className="staff-patients-actions">
        <PatientDirectorySearch
          value={query}
          onChange={(value) => {
            setQuery(value);
            setPatientActionMenu(null);
          }}
          className="staff-patients-search"
        />

        <div className="staff-patients-toolbar-right">
          <label className="staff-patients-status-select">
            <Icon
              className="staff-patients-status-select-icon"
              icon="solar:filter-linear"
              aria-hidden="true"
            />

            <select
              value={patientStatusFilter}
              onChange={(event) => {
                setPatientStatusFilter(event.target.value);
                setPatientActionMenu(null);
              }}
              aria-label="Filter patients by account status"
            >
              {patientStatusFilters.map((filter) => (
                <option value={filter} key={filter}>
                  {filter === "All" ? "All Status" : filter}
                </option>
              ))}
            </select>

            <Icon
              className="staff-patients-status-select-arrow"
              icon="solar:alt-arrow-down-linear"
              aria-hidden="true"
            />
          </label>

          <button
            type="button"
            className="staff-register-patient-btn"
            onClick={openRegister}
          >
            <Icon icon="solar:add-circle-linear" aria-hidden="true" />
            <span>Register Patient</span>
          </button>
        </div>
      </PatientDirectoryToolbar>

      {isLoadingPatients || statusMessage ? (
        <p className="staff-patients-status-message">
          {isLoadingPatients ? "Loading patients from Supabase..." : statusMessage}
        </p>
      ) : null}

      <PatientTableShell
        className="staff-patients-card"
        scrollClassName="staff-patients-table-scroll"
        aria-label="Patients table"
      >
          <table className="staff-patients-table">
            <thead>
              <tr>
                <th>
                  <button type="button" onClick={() => requestSort("name")}>
                    Name
                    <Icon icon="solar:sort-vertical-linear" aria-hidden="true" />
                  </button>
                </th>
                <th>
                  <button type="button" onClick={() => requestSort("id")}>
                    Patient ID
                    <Icon icon="solar:sort-vertical-linear" aria-hidden="true" />
                  </button>
                </th>
                <th>
                  <button type="button" onClick={() => requestSort("birthdate")}>
                    Date of Birth
                    <Icon icon="solar:sort-vertical-linear" aria-hidden="true" />
                  </button>
                </th>
                <th>Status</th>
                <th>Medical Records</th>
                <th>Actions</th>
              </tr>
            </thead>

            <tbody>
              {filteredPatients.map((patient) => (
                <tr
                  key={patient.id}
                  id={`staff-patient-row-${patient.recordId}`}
                  className={
                    dashboardPatientTarget &&
                    patient.recordId === dashboardPatientTarget
                      ? "is-dashboard-target"
                      : undefined
                  }
                >
                  <td>
                    <div className="staff-patient-info-cell">
                      <span className={`staff-patient-avatar avatar-${patient.tone}`}>
                        {patient.initials}
                      </span>

                      <span className="staff-patient-name-wrap">
                        <strong>{patient.name}</strong>
                        <small>
                          {patient.gender} • {patient.age}
                        </small>
                      </span>
                    </div>
                  </td>

                  <td>
                    <span className="staff-patient-id">{patient.id}</span>
                  </td>

                  <td>
                    <span className="staff-patient-date">{patient.birthdate}</span>
                  </td>

                  <td>
                    <span className={`staff-patient-status ${getPatientStatusClass(patient)}`}>
                      {formatPatientStatus(patient)}
                    </span>
                  </td>

                  <td>
                    <span
                      className="staff-patient-medical-access"
                      aria-label="Medical records access: Doctor only"
                    >
                      <Icon icon="solar:lock-keyhole-minimalistic-linear" aria-hidden="true" />
                      Doctor Only
                    </span>
                  </td>

                  <td>
                    <div className="staff-patient-action-group">
                      {canSendPatientNotification(patient) ? (
                        <div
                          id={`staff-patient-notify-${patient.recordId}`}
                          className="staff-patient-notification-proxy-host"
                        >
                          <SendPatientNotificationAction
                            patientId={patient.recordId}
                            patientName={patient.name}
                            defaultType="general"
                            allowedTypes={staffPatientNotificationTypes}
                            triggerLabel="Notify"
                            className="staff-patient-notification-proxy"
                            outline
                          />
                        </div>
                      ) : null}

                      <button
                        type="button"
                        className={`staff-patient-action-menu-trigger ${
                          patientActionMenu?.patientId === patient.recordId
                            ? "is-open"
                            : ""
                        }`}
                        aria-label={`Actions for ${patient.name}`}
                        aria-haspopup="menu"
                        aria-controls={
                          patientActionMenu?.patientId === patient.recordId
                            ? "staff-patient-action-menu"
                            : undefined
                        }
                        aria-expanded={
                          patientActionMenu?.patientId === patient.recordId
                        }
                        onClick={(event) => togglePatientActionMenu(event, patient)}
                      >
                        <span aria-hidden="true">•••</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}

              {!isLoadingPatients && !filteredPatients.length ? (
                <tr>
                  <td colSpan="6" className="staff-patients-empty-cell">
                    <Icon icon="solar:magnifer-linear" aria-hidden="true" />
                    <strong>No patients found</strong>
                    <span>Try a different status, name, ID, or birthdate.</span>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
      </PatientTableShell>

      {patientActionMenu && activeActionPatient ? (
        <div
          id="staff-patient-action-menu"
          className="staff-patient-action-menu"
          role="menu"
          aria-label={`Actions for ${activeActionPatient.name}`}
          style={{
            top: patientActionMenu.top,
            left: patientActionMenu.left,
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {canSendPatientNotification(activeActionPatient) ? (
            <button
              type="button"
              className="staff-patient-action-menu-item"
              role="menuitem"
              onClick={() => triggerPatientNotification(activeActionPatient)}
            >
              <Icon icon="solar:bell-linear" aria-hidden="true" />
              <span>Notify</span>
            </button>
          ) : null}

          <button
            type="button"
            className="staff-patient-action-menu-item"
            role="menuitem"
            onClick={() => {
              setPatientActionMenu(null);
              if (getPatientStatusGroup(activeActionPatient) === "Archived") {
                restorePatient(activeActionPatient);
              } else {
                archivePatient(activeActionPatient);
              }
            }}
          >
            <Icon
              icon={
                getPatientStatusGroup(activeActionPatient) === "Archived"
                  ? "solar:restart-linear"
                  : "solar:archive-linear"
              }
              aria-hidden="true"
            />
            <span>
              {getPatientStatusGroup(activeActionPatient) === "Archived"
                ? "Restore"
                : "Archive"}
            </span>
          </button>
        </div>
      ) : null}

      {activeModal ? (
        <div className="staff-patients-modal-backdrop" role="presentation" onClick={closeModal}>
          <section
            className="staff-patients-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="staff-patients-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            {activeModal === "saved" ? (
              <>
                <div className="staff-patients-modal-icon is-success">
                  <Icon icon="solar:check-circle-bold" aria-hidden="true" />
                </div>
                <h3 id="staff-patients-modal-title">Registration Completed</h3>
                <p>
                  Patient registration completed successfully. The Patient can now
                  create or log in to their Patient account using the QR code and
                  one-time control number.
                </p>
                <button type="button" onClick={closeModal}>OK</button>
              </>
            ) : (
              <>
                <div className="staff-patients-modal-icon is-warning">
                  <Icon icon="solar:danger-triangle-bold" aria-hidden="true" />
                </div>
                <h3 id="staff-patients-modal-title">Access Restricted</h3>
                <p>You do not have permission to view the medical record of this patient.</p>
                <p>Please contact an authorized medical staff for assistance.</p>
                <button type="button" onClick={closeModal}>OK</button>
              </>
            )}
          </section>
        </div>
      ) : null}
    </section>
  );
}

export default StaffPatientsContent;
