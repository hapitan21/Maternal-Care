import {
  isCompletedClinicalVisitRecord,
  normalizeClinicalVisitFormData,
} from "./clinicalVisitData";
import { resolvePregnancyTracking } from "./pregnancyTracking";
import { supabase } from "./supabaseClient";

const missingValue = "Not provided";

function cleanValue(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return ["", "n/a", "na", "null", "undefined"].includes(text.toLowerCase())
    ? ""
    : text;
}

function getClinicalGestationalAge(record) {
  const formData = normalizeClinicalVisitFormData(record);
  return cleanValue(formData.gestationalAge);
}

function getRecordTimestamp(record) {
  const formData = normalizeClinicalVisitFormData(record);
  const visitInformation = formData.visitInformation || formData.visit_information || {};
  const candidates = [
    formData.visitDate,
    formData.visit_date,
    visitInformation.visitDate,
    visitInformation.visit_date,
    formData.appointmentDate,
    formData.appointment_date,
    record?.uploaded_at,
    record?.created_at,
  ];

  for (const value of candidates) {
    const timestamp = value ? Date.parse(value) : Number.NaN;
    if (!Number.isNaN(timestamp)) return timestamp;
  }

  return 0;
}

function getLatestClinicalGestationalAge(records) {
  const latest = [...records]
    .filter(isCompletedClinicalVisitRecord)
    .sort((first, second) => getRecordTimestamp(second) - getRecordTimestamp(first))[0];

  return latest ? getClinicalGestationalAge(latest) : "";
}

export async function loadPatientProfileSummary() {
  const { data, error } = await supabase.rpc("get_my_patient_profile_summary");
  if (error) throw error;

  const summary = Array.isArray(data) ? data[0] : data;
  if (!summary?.patient?.id) {
    throw new Error("The authenticated Patient profile could not be loaded.");
  }

  const { data: records, error: recordsError } = await supabase
    .from("medical_records")
    .select("id, patient_id, form_data, uploaded_at, created_at")
    .eq("patient_id", summary.patient.id)
    .order("uploaded_at", { ascending: false });

  if (recordsError) throw recordsError;

  const clinicalGestationalAge = getLatestClinicalGestationalAge(records || []);
  const tracking = resolvePregnancyTracking({
    patient: summary.patient,
    obstetric: summary.obstetric || {},
    clinicalGestationalAge,
  });

  return { ...summary, clinicalGestationalAge, tracking };
}

export function mapPatientProfileSummary(summary, account = {}) {
  const patient = summary?.patient || {};
  const personal = summary?.legacy_personal || {};
  const obstetric = summary?.obstetric || {};
  const emergency = summary?.emergency_contact || {};
  const tracking = summary?.tracking || resolvePregnancyTracking({ patient, obstetric });
  const sexAtBirth = cleanValue(patient.sex_at_birth) || cleanValue(personal.gender);
  const civilStatus = cleanValue(patient.civil_status) || cleanValue(personal.civil_status);
  const nationality = cleanValue(patient.nationality) || cleanValue(personal.nationality);
  const gravida = obstetric.gravida ?? null;
  const para = obstetric.para ?? null;

  return {
    recordId: patient.id || "",
    userId: patient.user_id || account.userId || "",
    personalInfoId: personal.id || null,
    emergencyContactId: emergency.id || null,
    displayName: cleanValue(patient.full_name) || cleanValue(account.fullName) || "Patient",
    patientId: cleanValue(patient.patient_id) || missingValue,
    avatar: account.avatarDisplayUrl || "",
    age: getAgeLabel(patient.date_of_birth, patient.age),
    sexAtBirth: sexAtBirth || missingValue,
    gender: sexAtBirth || missingValue,
    civilStatus: civilStatus || missingValue,
    nationality: nationality || missingValue,
    bloodType: cleanValue(patient.blood_type) || missingValue,
    email: cleanValue(account.email) || missingValue,
    phone: cleanValue(patient.contact_number) || missingValue,
    address: cleanValue(patient.address) || missingValue,
    birthdate: patient.date_of_birth || "",
    emergencyName: cleanValue(emergency.contact_person) || missingValue,
    emergencyRelation: cleanValue(emergency.relationship) || missingValue,
    emergencyPhone: cleanValue(emergency.contact_number) || missingValue,
    trimester: tracking.trimester?.label || missingValue,
    pregnancyWeek: tracking.week ?? "",
    gravida: gravida ?? missingValue,
    para: para ?? missingValue,
    dueDate: tracking.expectedDeliveryDate || "",
    pregnancyStatus: cleanValue(patient.status) || missingValue,
    physician: cleanValue(summary?.attending_physician) || "Not assigned",
    clinic: "La Paz Maternity and Reproductive Health Center",
    accountStatus: cleanValue(patient.account_status) || missingValue,
    emailVerified: account.emailVerified ?? null,
    lastLoginAt: account.lastLoginAt || "",
    pregnancyTracking: tracking,
    legacyPersonalRecordCount: Number(summary?.personal_record_count) || 0,
  };
}

export function formatPatientDate(value) {
  if (!value) return missingValue;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ? new Date(`${value}T00:00:00`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function formatPregnancyWeek(value) {
  const week = Number.parseInt(value, 10);
  return Number.isFinite(week) && week >= 0 && week <= 42
    ? `Week ${week}`
    : missingValue;
}

export async function updatePatientProfile(profile) {
  const { data, error } = await supabase.rpc("update_my_patient_profile", {
    p_profile: profile,
  });
  if (error) throw error;
  return data;
}

export async function updatePatientEmergencyContact(contact) {
  const { data, error } = await supabase.rpc("save_my_patient_emergency_contact", {
    p_contact: contact,
  });
  if (error) throw error;
  return data;
}

function getAgeLabel(dateOfBirth, storedAge) {
  if (!dateOfBirth) {
    return storedAge === null || storedAge === undefined
      ? missingValue
      : `${storedAge} years old`;
  }

  const date = new Date(`${dateOfBirth}T00:00:00`);
  if (Number.isNaN(date.getTime()) || date > new Date()) return missingValue;

  const today = new Date();
  let age = today.getFullYear() - date.getFullYear();
  const monthDelta = today.getMonth() - date.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < date.getDate())) age -= 1;
  return `${age} years old`;
}
