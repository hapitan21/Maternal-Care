import React from "react";
import { Icon } from "@iconify/react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import { loadAuthenticatedDoctor } from "../../hooks/useAuthenticatedDoctor";
import { usePatientAppointments } from "../../hooks/usePatientAppointments";
import { usePatientMedicalOverview } from "../../hooks/usePatientMedicalOverview";
import SendPatientNotificationAction from "../../components/notifications/SendPatientNotificationAction";
import MedicationAdherenceTrendCharts from "../../components/doctor/MedicationAdherenceTrendCharts";
import MedicationAdherencePrintableReport from "../../components/reports/MedicationAdherencePrintableReport";
import "../../styles/patient-record-ui-system.css";
import "../../styles/clinical-workflow-ui-system.css";
import {
  MEDICATION_ADHERENCE_NOTIFICATION_DRAFT,
  calculateMedicationAdherenceAlert,
  getMedicationAdherenceAlertDateRange,
  isEligibleMedicationAdherenceAlertPatient,
  normalizeMedicationAdherenceStatus,
} from "../../lib/medicationAdherence";
import {
  buildMedicationAdherenceTrendData,
  getPreviousMedicationAdherenceRange,
} from "../../lib/medicationAdherenceTrends";
import { buildPatientAdherenceCsvRows } from "../../lib/medicationReportExport";
import {
  downloadCsv,
  formatDateRangeFilenameSegment,
  printReport,
  sanitizeFilename,
} from "../../lib/reportExport";
import {
  classifyAppointment,
  compareHistoryAppointments,
  compareUpcomingAppointments,
  formatAppointmentDate,
  formatAppointmentTime,
  getAppointmentStart,
  getManilaDateKey,
  toManilaISOString,
} from "../../lib/appointmentDate";
import { resolveCurrentPregnancyWeek } from "../../lib/pregnancyTracking";
import {
  isCompletedClinicalVisitRecord,
  isMeaningfulClinicalValue,
  normalizeClinicalVisitFormData,
} from "../../lib/clinicalVisitData";
import "../../styles/medical_records.css";

const patientSelectColumns =
  "id, patient_id, full_name, user_id, date_of_birth, age, email, address, contact_number, expected_delivery_date, gestational_age, trimester, risk_level, allergies, chronic_illness, current_medications, blood_type, medical_notes, status, account_status, archived_at, created_at";
const medicalRecordColumns =
  "id, patient_id, schedule_id, doctor_id, patient_name, type, title, notes, file_name, file_type, file_data_url, form_data, uploaded_at, uploaded_by, created_at";
const medicalRecordTabs = new Set([
  "Overview",
  "Prenatal History",
  "Medical Record",
  "Diagnostic Results",
  "Prescriptions",
  "Pregnancy Tracking",
]);
const patientScheduleTabs = new Set(["Overview", "Appointments"]);
const appointmentMetadataTabs = new Set([...patientScheduleTabs, "Medical Record"]);
const MEDICAL_RECORDS_BUCKET = "medical-records";
const MEDICAL_ATTACHMENT_URL_EXPIRY_SECONDS = 10 * 60;

const EMPTY_PATIENT_VALUE = "Not provided";

function formatPatientId(patient) {
  return cleanRecordValue(patient?.patient_id || patient?.patient_code) || EMPTY_PATIENT_VALUE;
}

function formatPatientDate(value, fallback = "-") {
  if (!value) return fallback;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "2-digit",
    year: "numeric",
  });
}

function formatCompactPatientDate(value, fallback = EMPTY_PATIENT_VALUE) {
  if (!value) return fallback;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return cleanRecordValue(value) || fallback;

  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function getPatientInitials(name) {
  const initials = String(name || "Patient")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

  return initials || "PT";
}

function normalizeRecordList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item === null || item === undefined) return "";
        if (typeof item === "object") {
          return cleanRecordValue(
            item.label || item.name || item.value || item.result || item.text
          );
        }
        return cleanRecordValue(item);
      })
      .filter(Boolean);
  }
  if (!value) return [];
  if (typeof value === "object") return [];
  return String(value).split(/\r?\n|;/).map((item) => item.trim()).filter(Boolean);
}

function cleanRecordValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return "";
  const clean = String(value).trim();
  return clean && clean !== "-" ? clean : "";
}

function getUuidLikeValue(...values) {
  return values
    .map((value) => cleanRecordValue(value))
    .find((value) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ) || "";
}

function displayRecordValue(value) {
  return cleanRecordValue(value) || "Not recorded";
}

function displayPatientValue(value) {
  return cleanRecordValue(value) || EMPTY_PATIENT_VALUE;
}

function getRecordArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseNumericValue(value) {
  const clean = cleanRecordValue(value);
  if (!clean) return null;
  const match = clean.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function parseDateValue(value) {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

function calculateGestationalAgeAtVisit(visitValue, obstetric = {}, patient = {}) {
  const visitDate = parseDateValue(visitValue);
  if (!visitDate) return "";

  const lmpDate = parseDateValue(obstetric.last_menstrual_period);
  if (lmpDate && visitDate >= lmpDate) {
    const elapsedDays = Math.floor((visitDate.getTime() - lmpDate.getTime()) / 86400000);
    const weeks = Math.floor(elapsedDays / 7);
    const days = elapsedDays % 7;
    return `${weeks} weeks${days ? ` ${days} days` : ""}`;
  }

  const eddDate = parseDateValue(obstetric.expected_delivery_date || patient.expected_delivery_date);
  if (eddDate) {
    const daysUntilDelivery = Math.floor((eddDate.getTime() - visitDate.getTime()) / 86400000);
    const elapsedDays = (40 * 7) - daysUntilDelivery;
    if (elapsedDays >= 0 && elapsedDays <= 42 * 7) {
      const weeks = Math.floor(elapsedDays / 7);
      const days = elapsedDays % 7;
      return `${weeks} weeks${days ? ` ${days} days` : ""}`;
    }
  }

  return "";
}

function getLatestRecordValue(records, fields) {
  for (const record of records) {
    for (const field of fields) {
      const fromRecord = cleanRecordValue(record?.[field]);
      if (isMeaningfulClinicalValue(fromRecord)) return fromRecord;
    }

    for (const [label, value] of record?.findings || []) {
      if (fields.some((field) => normalizeLabelText(field) === normalizeLabelText(label))) {
        const clean = cleanRecordValue(value);
        if (isMeaningfulClinicalValue(clean)) return clean;
      }
    }
  }

  return "";
}

function normalizeLabelText(value) {
  return String(value || "").trim().toLowerCase().replace(/[_\s/-]+/g, "");
}

function getPregnancyWeek(patient, obstetric, records = []) {
  return resolveCurrentPregnancyWeek({
    expectedDeliveryDate:
      obstetric?.expected_delivery_date || patient?.expected_delivery_date,
    lastMenstrualPeriod: obstetric?.last_menstrual_period,
    clinicalGestationalAge: getLatestRecordValue(records, [
      "gestationalAge",
      "Gestational Age",
    ]),
    storedGestationalAge: patient?.gestational_age,
  });
}

function formatPregnancyWeek(patient, obstetric, records = []) {
  const week = getPregnancyWeek(patient, obstetric, records);
  return week === null ? EMPTY_PATIENT_VALUE : `${week} Weeks`;
}

function getTrimesterLabel(week) {
  if (week === null) return "Pregnancy progress is not recorded";
  if (week <= 12) return "The Patient is in her 1st Trimester";
  if (week <= 27) return "The Patient is in her 2nd Trimester";
  return "The Patient is in her 3rd Trimester";
}

function formatRiskBadge(value) {
  const clean = cleanRecordValue(value);
  return clean ? clean : EMPTY_PATIENT_VALUE;
}

function getRiskTone(value) {
  const clean = cleanRecordValue(value).toLowerCase();
  if (!clean) return "neutral";
  if (clean.includes("low")) return "low";
  if (clean.includes("high") || clean.includes("risk")) return "high";
  return "neutral";
}

function normalizeRecordRows(rows, keys) {
  return Array.isArray(rows)
    ? rows.filter((row) => keys.some((key) => cleanRecordValue(row?.[key])))
    : [];
}

function formatAttachmentSize(size) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizeRecordAttachment(attachment) {
  const path = attachment?.path || attachment?.storagePath || "";
  const dataUrl = attachment?.dataUrl || attachment?.url || attachment?.publicUrl || "";
  if ((!attachment?.name && !attachment?.fileName) || (!path && !dataUrl)) return null;
  return {
    name: attachment.name || attachment.fileName,
    type: attachment.type || attachment.fileType || "File",
    size: Number.isFinite(Number(attachment.size)) ? Number(attachment.size) : 0,
    sizeLabel: attachment.sizeLabel || formatAttachmentSize(attachment.size),
    path,
    dataUrl,
  };
}

function getAttachmentDescription(attachment) {
  const type = String(attachment?.type || "").toLowerCase();
  return type === "application/pdf" || /\.pdf$/i.test(attachment?.name || "")
    ? "PDF report"
    : attachment?.type || "Medical attachment";
}

async function createMedicalAttachmentUrl(attachment, { download = false } = {}) {
  if (attachment?.path) {
    const options = download ? { download: attachment.name || true } : undefined;
    const { data, error } = await supabase.storage
      .from(MEDICAL_RECORDS_BUCKET)
      .createSignedUrl(attachment.path, MEDICAL_ATTACHMENT_URL_EXPIRY_SECONDS, options);

    if (error || !data?.signedUrl) {
      throw error || new Error("A temporary attachment link could not be created.");
    }
    return data.signedUrl;
  }

  if (attachment?.dataUrl) return attachment.dataUrl;
  throw new Error("This attachment does not have a usable storage path.");
}

function MedicalAttachmentControl({ attachment, compact = false }) {
  const file = normalizeRecordAttachment(attachment);
  const [action, setAction] = React.useState("");
  const [error, setError] = React.useState("");

  if (!file) return null;

  const viewAttachment = async () => {
    if (action) return;
    const viewWindow = window.open("about:blank", "_blank");
    if (viewWindow) viewWindow.opener = null;
    setAction("view");
    setError("");

    try {
      const url = await createMedicalAttachmentUrl(file);
      if (viewWindow) viewWindow.location.replace(url);
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch (viewError) {
      viewWindow?.close();
      setError(viewError?.message || "Unable to open the report.");
    } finally {
      setAction("");
    }
  };

  const downloadAttachment = async () => {
    if (action) return;
    setAction("download");
    setError("");

    try {
      const url = await createMedicalAttachmentUrl(file, { download: true });
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name;
      link.rel = "noopener noreferrer";
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (downloadError) {
      setError(downloadError?.message || "Unable to download the report.");
    } finally {
      setAction("");
    }
  };

  return (
    <div className={`mr-report-attachment${compact ? " is-compact" : ""}`}>
      <div className="mr-report-attachment-file">
        <Icon icon="akar-icons:file" />
        <span>
          <strong>{file.name}</strong>
          <small>{[getAttachmentDescription(file), file.sizeLabel].filter(Boolean).join(" - ")}</small>
        </span>
      </div>
      <div className="mr-report-attachment-actions">
        <button type="button" disabled={Boolean(action)} onClick={viewAttachment}>
          <Icon icon="solar:eye-linear" />
          {action === "view" ? "Opening..." : "View"}
        </button>
        <button type="button" disabled={Boolean(action)} onClick={downloadAttachment}>
          <Icon icon="material-symbols:download-rounded" />
          {action === "download" ? "Downloading..." : "Download"}
        </button>
      </div>
      {error ? <small className="mr-report-attachment-error" role="alert">{error}</small> : null}
    </div>
  );
}

function getRecordFormData(row) {
  return normalizeClinicalVisitFormData(row);
}

function getFirstRecordValue(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return value;
    if (value && typeof value === "object") return value;
    const clean = cleanRecordValue(value);
    if (clean) return clean;
  }

  return "";
}

function getClinicalValue(clinicalFindings, camelKey, snakeKey, formData) {
  return getFirstRecordValue(
    clinicalFindings?.[camelKey],
    clinicalFindings?.[snakeKey],
    formData?.[camelKey],
    formData?.[snakeKey]
  );
}

function getRecordTimestamp(row, formData) {
  const visitDate = getFirstRecordValue(
    formData.visitDate,
    formData.visit_date,
    formData.visitInformation?.visitDate,
    formData.visit_information?.visit_date,
    formData.appointmentDate,
    formData.appointment_date
  );
  const uploadedAt = getFirstRecordValue(
    row.uploaded_at,
    formData.uploadedAt,
    formData.uploaded_at,
    formData.createdAt,
    formData.created_at
  );

  for (const value of [visitDate, uploadedAt]) {
    const parsed = value ? new Date(value) : null;
    if (parsed && !Number.isNaN(parsed.getTime())) return parsed;
  }

  return null;
}

function formatMedicalRecordTimestamp(value) {
  const formattedDate = formatAppointmentDate(value);
  const formattedTime = formatAppointmentTime(value);
  return formattedDate === "-" || formattedTime === "-"
    ? "Not recorded"
    : `${formattedDate} at ${formattedTime}`;
}

function formatAppointmentWeekday(value) {
  return formatAppointmentDate(value, {
    weekday: "long",
    month: undefined,
    day: undefined,
    year: undefined,
  });
}

function mapSupabaseMedicalRecord(
  row,
  patient,
  doctorProfilesById = new Map(),
  schedulesById = new Map()
) {
  const formData = getRecordFormData(row);
  const uploadedAt = row.uploaded_at ? new Date(row.uploaded_at) : null;
  const validUploadedAt = uploadedAt && !Number.isNaN(uploadedAt.getTime()) ? uploadedAt : null;
  const validVisitDate = getRecordTimestamp(row, formData) || validUploadedAt;
  const linkedDoctorId = row.doctor_id || formData.doctorId || formData.doctor_id || formData.visitInformation?.doctorId || "";
  const linkedDoctorName = linkedDoctorId
    ? doctorProfilesById.get(linkedDoctorId)
    : "";
  const clinicalFindings =
    getFirstRecordValue(formData.clinicalFindings, formData.clinical_findings) || {};
  const pregnancyDetails =
    getFirstRecordValue(formData.pregnancyStatus, formData.pregnancy_status) || {};
  const visitInformation =
    getFirstRecordValue(formData.visitInformation, formData.visit_information) || {};
  const linkedSchedule = row.schedule_id ? schedulesById.get(row.schedule_id) : null;
  const linkedAppointmentStart = getAppointmentStart(linkedSchedule);
  const existingMaternalAppointmentId = getFirstRecordValue(
    formData.maternalAppointmentId,
    formData.maternal_appointment_id,
    formData.displayAppointmentId,
    formData.display_appointment_id,
    visitInformation.maternalAppointmentId,
    visitInformation.maternal_appointment_id,
    visitInformation.displayAppointmentId,
    visitInformation.display_appointment_id
  );
  const findings = Array.isArray(formData.findings)
    ? formData.findings.map((item) =>
        Array.isArray(item)
          ? item
          : [item?.label || item?.name || "Finding", item?.value ?? item?.result ?? "Not recorded", item?.unit || ""]
      )
    : [
        ["Blood Pressure", getClinicalValue(clinicalFindings, "bloodPressure", "blood_pressure", formData) || "Not recorded", "mmHg"],
        ["Weight", getClinicalValue(clinicalFindings, "weight", "weight", formData) || "Not recorded", "kg"],
        ["Temperature", getClinicalValue(clinicalFindings, "temperature", "temperature", formData) || "Not recorded", "C"],
        ["Heart Rate", getClinicalValue(clinicalFindings, "heartRate", "heart_rate", formData) || "Not recorded", "bpm"],
        ["Respiratory Rate", getClinicalValue(clinicalFindings, "respiratoryRate", "respiratory_rate", formData), "breaths/min"],
        ["Height", getClinicalValue(clinicalFindings, "height", "height", formData), "cm"],
        ["BMI", getClinicalValue(clinicalFindings, "bmi", "bmi", formData), "kg/m2"],
        ["Fetal Heart Rate", getClinicalValue(clinicalFindings, "fetalHeartRate", "fetal_heart_rate", formData), "bpm"],
        ["Fundal Height", getClinicalValue(clinicalFindings, "fundalHeight", "fundal_height", formData), "cm"],
        ["Estimated Fetal Weight", getClinicalValue(clinicalFindings, "estimatedFetalWeight", "estimated_fetal_weight", formData), "g"],
        ["Baby Position", getFirstRecordValue(formData.babyPosition, clinicalFindings.babyPosition, clinicalFindings.baby_position, clinicalFindings.fetalPosition, clinicalFindings.fetal_position), ""],
        ["Fetal Movement", getClinicalValue(clinicalFindings, "fetalMovement", "fetal_movement", formData), ""],
        ["Additional Findings", getFirstRecordValue(clinicalFindings.additionalFindings, clinicalFindings.additional_findings, formData.additionalFindings, formData.additional_findings), ""],
      ].filter(([label, value]) =>
        cleanRecordValue(value) || ["Blood Pressure", "Weight", "Temperature", "Heart Rate"].includes(label)
      );
  const assessment = normalizeRecordList([
    ...normalizeRecordList(getFirstRecordValue(formData.assessment, formData.clinical_assessment)),
    ...normalizeRecordList(getFirstRecordValue(formData.symptoms, formData.patientConcerns, formData.patient_concerns)),
    ...normalizeRecordList(formData.dangerSigns),
    ...normalizeRecordList(formData.additionalNotes),
  ]);
  const treatment = normalizeRecordList([
    ...normalizeRecordList(formData.treatment),
    ...normalizeRecordList(getFirstRecordValue(formData.treatmentPlan, formData.planTreatment, formData.plan_treatment, formData.plan)),
    ...normalizeRecordList(formData.followUpInstructions),
  ]);
  const visitType = getFirstRecordValue(
    formData.visitType,
    formData.visit_type,
    visitInformation.visitType,
    visitInformation.visit_type,
    row.type,
    "Medical Record"
  );
  const visitGestationalAge = getFirstRecordValue(
    formData.gestationalAge,
    formData.gestational_age,
    pregnancyDetails.gestationalAge,
    pregnancyDetails.gestational_age,
    visitInformation.gestationalAge,
    visitInformation.gestational_age
  );

  return {
    id: row.id,
    patientId: row.patient_id,
    scheduleId:
      row.schedule_id ||
      getUuidLikeValue(
        formData.scheduleId,
        formData.schedule_id,
        formData.appointmentId,
        formData.appointment_id,
        visitInformation.scheduleId,
        visitInformation.schedule_id,
        visitInformation.appointmentId,
        visitInformation.appointment_id
      ),
    date: validVisitDate
      ? validVisitDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
      : "Not recorded",
    day: validVisitDate
      ? validVisitDate.toLocaleDateString("en-US", { weekday: "long" })
      : "Not recorded",
    time: formData.visitTime || formData.visit_time || visitInformation.visitTime || visitInformation.visit_time || (validVisitDate
      ? validVisitDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      : "Not recorded"),
    detailAppointmentDate: linkedAppointmentStart
      ? formatAppointmentDate(linkedAppointmentStart)
      : "Not recorded",
    detailAppointmentDay: linkedAppointmentStart
      ? formatAppointmentWeekday(linkedAppointmentStart)
      : "Not recorded",
    detailAppointmentTime: linkedAppointmentStart
      ? formatAppointmentTime(linkedAppointmentStart)
      : "Not recorded",
    visitType,
    gestationalAge: visitGestationalAge || patient?.gestational_age || "Not recorded",
    riskLevel: formData.riskLevel || "Not recorded",
    visitGestationalAge,
    visitDateValue: validVisitDate ? validVisitDate.toISOString() : "",
    doctor: linkedDoctorName || formData.doctor || formData.attendingPhysician || formData.attending_physician || row.uploaded_by || "Doctor not recorded",
    appointmentReference:
      linkedSchedule?.maternal_appointment_id ||
      existingMaternalAppointmentId ||
      row.schedule_id ||
      "No appointment reference",
    createdDate: validUploadedAt
      ? formatMedicalRecordTimestamp(validUploadedAt)
      : "Not recorded",
    updatedDate: formatMedicalRecordTimestamp(
      getFirstRecordValue(formData.updatedAt, formData.updated_at)
    ),
    recordStatus: formData.recordStatus || formData.status || "Not recorded",
    complaint: getFirstRecordValue(formData.chiefComplaint, formData.chief_complaint, formData.complaint, row.notes, row.title) || "Not recorded",
    symptoms: getFirstRecordValue(formData.symptoms, formData.patientConcerns, formData.patient_concerns) || "Not recorded",
    assessment: assessment.length ? assessment : ["Not recorded"],
    findings,
    obstetric: Array.isArray(formData.obstetric) && formData.obstetric.length
      ? formData.obstetric.map((item) =>
          Array.isArray(item)
            ? item
            : [item?.label || item?.name || "Information", item?.value || "Not recorded"]
        )
      : [
          ["Gestational Age", pregnancyDetails.gestationalAge || pregnancyDetails.gestational_age || formData.gestationalAge || "Not recorded"],
          ["Risk Level", formData.riskLevel || pregnancyDetails.riskLevel || pregnancyDetails.risk_level || "Not recorded"],
          ["Expected Delivery Date", pregnancyDetails.expectedDeliveryDate || pregnancyDetails.expected_delivery_date || formData.expectedDeliveryDate || "Not recorded"],
          ["Follow-up Date", formData.followUpDate || "Not recorded"],
        ],
    diagnosis: getFirstRecordValue(formData.diagnosis, row.title, row.type) || "Medical Record",
    treatment: treatment.length ? treatment : ["Not recorded"],
    actionsTaken: normalizeRecordList(formData.actionsTaken),
    otherActionDescription: formData.otherActionDescription || "",
    pregnancyMilestones: normalizeRecordList(formData.pregnancyMilestones),
    vaccinations: normalizeRecordRows(formData.vaccinations, ["vaccineName", "lotNumber", "dateGiven"]),
    laboratoryReview: formData.laboratoryReview || formData.laboratory_review || {
      testType: formData.laboratoryTestType || formData.laboratory_test_type || "",
      resultSummary: formData.laboratoryResultSummary || formData.laboratory_result_summary || "",
      interpretation: formData.laboratoryInterpretation || formData.laboratory_interpretation || "",
      reportAttached: formData.laboratoryReportAttached || formData.laboratory_report_attached || "",
      attachment: formData.laboratoryAttachment || formData.laboratory_attachment || null,
    },
    ultrasoundReview: formData.ultrasoundReview || formData.ultrasound_review || {
      visitDate: formData.ultrasoundVisitDate || formData.ultrasound_visit_date || "",
      findings: formData.ultrasoundFindings || formData.ultrasound_findings || "",
      reportAttached: formData.ultrasoundReportAttached || formData.ultrasound_report_attached || "",
      attachment: formData.ultrasoundAttachment || formData.ultrasound_attachment || null,
    },
    prescription: formData.prescription || {
      reference: formData.prescriptionReference || formData.prescription_reference || "",
      medications: Array.isArray(formData.medications) ? formData.medications : [],
      instructions: formData.prescriptionInstructions || formData.prescription_instructions || formData.prescription || "",
      attachment: formData.prescriptionAttachment || formData.prescription_attachment || null,
    },
    prescriptions: (formData.prescription?.medications?.length || formData.medications?.length)
      ? (formData.prescription?.medications || formData.medications).map((item) =>
          [item.medication, item.dosage, item.frequency, item.duration].filter(Boolean).join(" - ")
        )
      : normalizeRecordList(formData.prescriptions),
    diagnosticResults: normalizeRecordList(formData.diagnosticResults),
    attachment: row.file_name && row.file_data_url ? row.file_name : "",
    fileDataUrl: row.file_data_url || "",
    attachments: [
      normalizeRecordAttachment(formData.laboratoryReview?.attachment),
      normalizeRecordAttachment(formData.ultrasoundReview?.attachment),
      normalizeRecordAttachment(formData.prescription?.attachment),
      row.file_name && row.file_data_url
        ? {
            name: row.file_name,
            type: row.file_type || "Medical attachment",
            dataUrl: row.file_data_url || "",
          }
        : null,
    ].filter(Boolean),
    sortTime: validVisitDate?.getTime() || validUploadedAt?.getTime() || 0,
  };
}

function getMedicalRecordDoctorId(row) {
  const formData = row?.form_data && typeof row.form_data === "object"
    ? row.form_data
    : {};
  const visitInformation = formData.visitInformation || formData.visit_information || {};

  return (
    row?.doctor_id ||
    formData.doctorId ||
    formData.doctor_id ||
    visitInformation.doctorId ||
    visitInformation.doctor_id ||
    ""
  );
}

const tabs = [
  "Overview",
  "Prenatal History",
  "Appointments",
  "Medical Record",
  "Diagnostic Results",
  "Prescriptions",
  "Pregnancy Tracking",
];

const medicalRecordTabParamByLabel = {
  Overview: "overview",
  "Prenatal History": "prenatal-history",
  Appointments: "appointments",
  "Medical Record": "medical-record",
  "Diagnostic Results": "diagnostic-results",
  Prescriptions: "prescriptions",
  "Medication Adherence": "medication-adherence",
  "Pregnancy Tracking": "pregnancy-tracking",
};

const medicationAdherenceDateFilters = [
  "Today",
  "Last 7 Days",
  "Last 30 Days",
  "Custom Range",
];
const medicationAdherenceStatusFilters = [
  "All",
  "Taken",
  "Skipped",
  "Missed",
  "Due",
];
function addManilaDays(dateValue, amount) {
  const date = new Date(`${dateValue}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return "";
  date.setTime(date.getTime() + amount * 24 * 60 * 60 * 1000);
  return getManilaDateKey(date);
}

function getManilaDayDifference(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00+08:00`);
  const end = new Date(`${endDate}T00:00:00+08:00`);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return Number.NaN;
  }

  return Math.round((end.getTime() - start.getTime()) / 86400000);
}

function getMedicationAdherenceDateRange(filter, customRange) {
  const today = getManilaDateKey();
  let startDate = addManilaDays(today, -6);
  let endDate = today;

  if (filter === "Today") {
    startDate = today;
    endDate = today;
  } else if (filter === "Last 30 Days") {
    startDate = addManilaDays(today, -29);
    endDate = today;
  } else if (filter === "Custom Range") {
    startDate = customRange.startDate || "";
    endDate = customRange.endDate || "";
  }

  if (!startDate || !endDate) {
    return {
      startDate,
      endDate,
      startIso: "",
      endIso: "",
      error: "Select a start date and end date.",
    };
  }

  if (startDate > endDate) {
    return {
      startDate,
      endDate,
      startIso: "",
      endIso: "",
      error: "Start date must be before or equal to end date.",
    };
  }

  if (getManilaDayDifference(startDate, endDate) > 366) {
    return {
      startDate,
      endDate,
      startIso: "",
      endIso: "",
      error: "Choose a date range of 366 days or less.",
    };
  }

  const endExclusiveDate = addManilaDays(endDate, 1);

  return {
    startDate,
    endDate,
    startIso: toManilaISOString(startDate, "00:00"),
    endIso: toManilaISOString(endExclusiveDate, "00:00"),
    error: "",
  };
}

function getMedicationAdherenceStatusMeta(status) {
  const normalized = normalizeMedicationAdherenceStatus(status);

  if (normalized === "processing") {
    return { label: "PROCESSING", className: "processing" };
  }

  if (normalized === "notified") {
    return { label: "DUE", className: "due" };
  }

  if (normalized === "taken") {
    return { label: "TAKEN", className: "taken" };
  }

  if (normalized === "skipped") {
    return { label: "SKIPPED", className: "skipped" };
  }

  if (normalized === "missed") {
    return { label: "MISSED", className: "missed" };
  }

  if (normalized === "failed") {
    return { label: "UNAVAILABLE", className: "unavailable" };
  }

  return { label: "UNKNOWN", className: "unknown" };
}

function formatMedicationAdherenceTimestamp(value) {
  if (!value) return "-";
  return `${formatAppointmentDate(value)} ${formatAppointmentTime(value)}`;
}

function getMedicationAdherenceResponseLabel(row) {
  const status = normalizeMedicationAdherenceStatus(row.status);

  if (status === "taken" || status === "skipped") {
    return formatMedicationAdherenceTimestamp(row.action_at);
  }

  if (status === "missed") {
    return formatMedicationAdherenceTimestamp(row.missed_at);
  }

  if (status === "notified") {
    return "Awaiting response";
  }

  if (status === "processing") {
    return "Processing";
  }

  if (status === "failed") {
    return "Reminder unavailable";
  }

  return "-";
}

function getAppointmentVisitRouteSegment(record) {
  const typeText = String(
    record?.visitType || record?.type || record?.title || ""
  ).toLowerCase();

  return typeText.includes("follow") ? "follow-up" : "initial-visit";
}

const pregnancyTrackingMilestones = [
  {
    week: 8,
    title: "Pregnancy Confirmed",
    description: "First prenatal assessment completed",
    image: "/images/leaf.png",
  },
  {
    week: 10,
    title: "Heartbeat Detected",
    description: "Strong fetal heartbeat observed.",
    image: "/images/heart.png",
  },
  {
    week: 12,
    title: "First Trimester Completed",
    description: "Reduced risk of early pregnancy complications.",
    image: "/images/flower.png",
  },
  {
    week: 18,
    title: "First Baby Movements Felt",
    description: "Mother reports feeling baby move.",
    image: "/images/feet.png",
  },
  {
    week: 20,
    title: "Anatomy Development Completed",
    description: "Major organs and structures formed.",
    image: "/images/brain.png",
  },
  {
    week: 28,
    title: "Entered Third Trimester",
    description: "Baby continues rapid growth and weight gain.",
    image: "/images/kilo.png",
  },
  {
    week: 34,
    title: "Lung Development",
    description: "Baby's lungs are maturing and strengthening.",
    image: "/images/lung.png",
  },
  {
    week: 37,
    title: "Full-Term Pregnancy",
    description: "Baby is considered full-term and ready anytime.",
    image: "/images/head.png",
  },
  {
    week: 40,
    title: "Expected Delivery",
    description: "Little one is expected to arrive soon!",
    image: "/images/gift.png",
  },
];

function InfoRow({ icon, label, value }) {
  return (
    <div className="mr-info-row">
      <Icon icon={icon} className="mr-info-icon" />
      <span className="mr-info-label">{label}</span>
      <span className="mr-info-value">{value}</span>
    </div>
  );
}

function SectionHeader({ icon, title, subtitle, action, onAction }) {
  return (
    <div className="mr-section-header">
      <div className="mr-section-title-wrap">
        <div className="mr-icon-badge">
          <Icon icon={icon} />
        </div>

        <div className="mr-section-title-text">
          <h3>{title}</h3>
          {subtitle && <span>{subtitle}</span>}
        </div>
      </div>

      {action && (
        <button className="mr-link-btn" type="button" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

function MedicalRecordTable({ columns, rows, narrow = false, wide = false, emptyText = "No records found." }) {
  if (!rows.length) {
    return <p className="mr-table-empty">{emptyText}</p>;
  }

  const tableClassName = [
    "mr-prenatal-table",
    narrow ? "mr-prenatal-table--narrow" : "",
    wide ? "mr-prenatal-table--wide" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="mr-prenatal-table-wrap">
      <table className={tableClassName}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>

        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${row[0]}-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${cellIndex}-${String(cell)}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PrenatalSection({ number, title, children, variant = "" }) {
  const className = [
    "mr-card",
    "mr-prenatal-card",
    variant === "full" ? "mr-prenatal-section--full" : "",
  ].filter(Boolean).join(" ");

  return (
    <article className={className}>
      <h3 className="mr-prenatal-title">
        {number}. {title}
      </h3>

      <hr className="mr-prenatal-rule" />

      {children}
    </article>
  );
}

export function OverviewPanel({ overview, onOpenRecord, onOpenAppointment }) {
  const {
    latestVitalSigns,
    nextAppointment,
    lastVisit,
    latestNotes,
    pregnancyProgress,
    loading,
    error,
    refresh,
  } = overview;
  const progressLabel =
    pregnancyProgress?.weeks === null || pregnancyProgress?.weeks === undefined
      ? "Not recorded"
      : `${pregnancyProgress.weeks} of 40 weeks`;
  const vitalRows = latestVitalSigns?.rows?.slice(0, 4) || [];

  return (
    <div className="mr-panel-grid mr-overview-dashboard-grid">
      {error ? (
        <div className="mr-overview-alert" role="alert">
          <span>Unable to load overview data: {error.message}</span>
          <button type="button" onClick={refresh}>Retry</button>
        </div>
      ) : null}

      <div className="mr-overview-main-column">
        <article className="mr-card mr-progress-card">
          <div className="mr-progress-header">
            <h3>Pregnancy Progress</h3>
            <strong>{loading ? "Loading..." : progressLabel}</strong>
          </div>

          <div className="mr-progress-bar" aria-label={progressLabel}>
            <span style={{ width: `${pregnancyProgress?.progressPercent || 0}%` }} />
          </div>

          <div className="mr-progress-labels" aria-hidden="true">
            <span>Conception</span>
            <span>Trimester 2</span>
            <span>Trimester 3</span>
            <span>Full Term</span>
          </div>

          <div className="mr-stat-grid">
            {(pregnancyProgress?.stats || []).map((stat) => (
              <div
                key={stat.title}
                className={`mr-stat-card ${stat.className}`}
              >
                <div className={`mr-stat-icon ${stat.iconClass || ""}`}>
                  <Icon icon={stat.icon} />
                </div>

                <div>
                  <p>{stat.title}</p>
                  <strong>{stat.value}</strong>
                  <span>{stat.date || "Not recorded"}</span>
                </div>
              </div>
            ))}
          </div>
        </article>

        <div className="mr-overview-lower-grid">
          <article className="mr-card mr-vitals-card">
            <SectionHeader
              icon="mdi:clipboard-vitals-outline"
              title="Vital Signs"
              subtitle="(Latest)"
            />

            {loading ? (
              <div className="mr-card-body mr-overview-loading">Loading vital signs...</div>
            ) : latestVitalSigns ? (
              <div className="mr-card-body">
                {vitalRows.map(([label, value]) => (
                  <div className="mr-record-row" key={label}>
                    <strong>{label}</strong>
                    <span>{value}</span>
                  </div>
                ))}

                <div className="mr-record-stack">
                  <strong>Measured:</strong>
                  <span>{latestVitalSigns.measuredAt}</span>
                </div>
              </div>
            ) : (
              <div className="mr-card-body mr-overview-empty">No vital signs recorded</div>
            )}

            <button
              className="mr-outline-btn"
              type="button"
              disabled={!latestVitalSigns?.recordId}
              onClick={() => onOpenRecord(latestVitalSigns?.recordId)}
            >
              View All Vital Signs
            </button>
          </article>

          <article className="mr-card mr-schedule-card">
            <SectionHeader
              icon="solar:calendar-mark-bold"
              title="Next Schedule"
              action={nextAppointment ? "View Appointment" : "View All"}
              onAction={() => onOpenAppointment(nextAppointment?.id)}
            />

            <div className="mr-schedule-content">
              <Icon icon="ph:dot-fill" className="mr-dot-icon" />

              <div>
                <strong>
                  {nextAppointment
                    ? nextAppointment.title
                    : loading
                      ? "Checking schedule"
                      : "No upcoming appointment scheduled"}
                </strong>
                {nextAppointment ? (
                  <>
                    <span>{nextAppointment.date} ({nextAppointment.time})</span>
                    <span>Doctor: {nextAppointment.doctor}</span>
                    <span>Status: {nextAppointment.status}</span>
                    {nextAppointment.displayId ? (
                      <span>Appointment ID: {nextAppointment.displayId}</span>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
          </article>
        </div>
      </div>

      <div className="mr-overview-side-column">
        <article className="mr-card mr-last-visit-card">
          <SectionHeader icon="solar:stethoscope-broken" title="Last Visit" />

          {loading ? (
            <div className="mr-card-body mr-overview-loading">Loading last visit...</div>
          ) : lastVisit ? (
            <div className="mr-card-body">
              <div className="mr-record-row">
                <strong>Date:</strong>
                <span>{lastVisit.date}</span>
              </div>

              <div className="mr-record-row">
                <strong>Time:</strong>
                <span>{lastVisit.time}</span>
              </div>

              <div className="mr-record-row">
                <strong>Doctor:</strong>
                <span>{lastVisit.doctor}</span>
              </div>

              <div className="mr-record-row">
                <strong>Visit Type:</strong>
                <span>{lastVisit.visitType}</span>
              </div>

              <div className="mr-record-stack">
                <strong>Assessment:</strong>
                <span>{lastVisit.assessment}</span>
              </div>
            </div>
          ) : (
            <div className="mr-card-body mr-overview-empty">No completed visit recorded</div>
          )}

          <button
            className="mr-outline-btn"
            type="button"
            disabled={!lastVisit?.recordId}
            onClick={() => onOpenRecord(lastVisit?.recordId)}
          >
            View Full Record
          </button>
        </article>

        <div className="mr-overview-notes-slot">
          <article className="mr-card mr-notes-card">
            <SectionHeader icon="solar:clipboard-list-bold" title="Notes" />

            {loading ? (
              <div className="mr-notes-text mr-overview-loading">Loading clinical notes...</div>
            ) : latestNotes ? (
              <>
                <div className="mr-notes-text">
                  {latestNotes.sections.map(([label, value]) => (
                    <p key={label}>
                      <strong>{label}:</strong>
                      <span>{value}</span>
                    </p>
                  ))}
                </div>

                <button
                  className="mr-notes-open-btn"
                  type="button"
                  onClick={() => onOpenRecord(latestNotes.recordId)}
                >
                  Open full record
                </button>

                <span className="mr-last-updated">
                  Last updated: {latestNotes.updatedAt}
                </span>
              </>
            ) : (
              <div className="mr-notes-text mr-overview-empty">No clinical notes recorded</div>
            )}
          </article>
        </div>
      </div>
    </div>
  );
}

function buildRiskBadge(value) {
  const clean = cleanRecordValue(value);
  return clean ? (
    <span className={`mr-risk-badge mr-risk-badge--${getRiskTone(clean)}`}>{clean}</span>
  ) : (
    <span className="mr-risk-badge mr-risk-badge--neutral">{EMPTY_PATIENT_VALUE}</span>
  );
}

function normalizeStructuredRows(value, fields, fallbackType = "Record") {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        return fields.map((field) => displayPatientValue(entry[field]));
      }

      const clean = cleanRecordValue(entry);
      return clean ? [fallbackType, clean, EMPTY_PATIENT_VALUE] : null;
    })
    .filter(Boolean);
}

function formatObstetricValue(value) {
  const number = parseNumericValue(value);
  if (number === null) return EMPTY_PATIENT_VALUE;
  return String(number);
}

function formatBooleanPatientValue(value) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return displayPatientValue(value);
}

const REGISTRATION_MEDICAL_CONDITIONS = [
  "Hypertension",
  "Diabetes Mellitus",
  "Asthma",
  "Kidney Disease",
  "Thyroid Disorder",
  "Others",
];

function normalizePregnancyHistoryRows(obstetric, pregnancyNumber) {
  const records = Array.isArray(obstetric.pregnancy_records)
    ? obstetric.pregnancy_records
    : [];
  const rows = records
    .filter((record) =>
      record && Object.entries(record).some(([key, value]) => key !== "id" && cleanRecordValue(value))
    )
    .map((record, index) => [
      String(index + 1),
      cleanRecordValue(record.birthdate)
        ? new Date(record.birthdate).getFullYear().toString()
        : EMPTY_PATIENT_VALUE,
      displayPatientValue(record.termPreterm || record.term_preterm || record.outcome),
      displayPatientValue(record.deliveryType || record.delivery_type),
      displayPatientValue(record.birthWeight || record.birth_weight),
      displayPatientValue(record.complications),
    ]);

  if (pregnancyNumber) {
    rows.push([
      String(pregnancyNumber),
      "Current",
      "Ongoing",
      EMPTY_PATIENT_VALUE,
      EMPTY_PATIENT_VALUE,
      EMPTY_PATIENT_VALUE,
    ]);
  }

  return rows;
}

function buildConditionItems(medicalHistory, patient) {
  const selected = new Set(
    normalizeRecordList(medicalHistory.medical_conditions || patient?.chronic_illness)
      .map((label) => normalizeLabelText(label))
  );
  const additionalLabels = normalizeRecordList([
    medicalHistory.other_medical_condition,
    medicalHistory.otherMedicalCondition,
  ]);
  const labels = Array.from(new Set([
    ...REGISTRATION_MEDICAL_CONDITIONS,
    ...additionalLabels,
  ].filter(Boolean)));

  if (!labels.length || (!selected.size && !additionalLabels.length && !medicalHistory?.id)) {
    return [];
  }

  return labels.map((label) => ({
    label: label === "Diabetes Mellitus" ? "Diabetes" : label,
    checked:
      selected.has(normalizeLabelText(label)) ||
      additionalLabels.some((item) => normalizeLabelText(item) === normalizeLabelText(label)),
  }));
}

function normalizeFamilyHistoryRows(value, otherValue) {
  const rows = [];
  const source = Array.isArray(value) ? value : [];

  source.forEach((entry) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const condition = cleanRecordValue(entry.condition || entry.label || entry.name || entry.value);
      if (!condition) return;
      rows.push([
        condition,
        formatBooleanPatientValue(entry.mother),
        formatBooleanPatientValue(entry.father),
      ]);
      return;
    }

    const condition = cleanRecordValue(entry);
    if (condition) rows.push([condition, EMPTY_PATIENT_VALUE, EMPTY_PATIENT_VALUE]);
  });

  normalizeRecordList(otherValue).forEach((condition) => {
    rows.push([condition, EMPTY_PATIENT_VALUE, EMPTY_PATIENT_VALUE]);
  });

  return rows;
}

function formatRecordMeasurement(records, fields, unit) {
  const value = getLatestRecordValue(records, fields);
  const clean = cleanRecordValue(value);
  if (!clean) return EMPTY_PATIENT_VALUE;
  return clean.toLowerCase().includes(unit.toLowerCase()) ? clean : `${clean} ${unit}`;
}

function dedupeRows(rows, keyBuilder) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = keyBuilder(row);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildPrenatalVisitRows(records, patient, obstetric) {
  return dedupeRows(records, (record) => record.scheduleId || record.id)
    .sort((a, b) => (b.sortTime || 0) - (a.sortTime || 0))
    .map((record) => {
      const visitGestationalAge =
        cleanRecordValue(record.visitGestationalAge) ||
        calculateGestationalAgeAtVisit(record.visitDateValue || record.sortTime, obstetric, patient) ||
        EMPTY_PATIENT_VALUE;

      return [
        formatCompactPatientDate(record.visitDateValue || record.sortTime, record.date),
        visitGestationalAge,
        formatRecordMeasurement([record], ["Weight"], "kg"),
        formatRecordMeasurement([record], ["Blood Pressure"], "mmHg"),
        formatRecordMeasurement([record], ["Fetal Heart Rate"], "bpm"),
        cleanRecordValue(record.diagnosis) ||
          cleanRecordValue(record.assessment?.[0]) ||
          cleanRecordValue(record.complaint) ||
          record.visitType,
      ];
    });
}

function buildPrenatalData(patient, patientRelated, records) {
  const obstetric = patientRelated?.obstetric || {};
  const medicalHistory = patientRelated?.medicalHistory || {};
  const initialAssessment = patientRelated?.initialAssessment || {};
  const pregnancyNumber = parseNumericValue(obstetric.gravida);
  const currentPregnancyLabel = pregnancyNumber
    ? `Pregnancy ${pregnancyNumber}`
    : EMPTY_PATIENT_VALUE;
  const conditions = buildConditionItems(medicalHistory, patient);
  const familyHistoryRows = normalizeFamilyHistoryRows(
    medicalHistory.family_history,
    medicalHistory.other_family_history || medicalHistory.otherFamilyHistory
  );
  const allergyRows = normalizeStructuredRows(
    medicalHistory.allergy_records?.length ? medicalHistory.allergy_records : medicalHistory.allergies,
    ["type", "allergen", "reaction"],
    "Allergy"
  );
  const immunizationRows = dedupeRows(
    records.flatMap((record) =>
      getRecordArray(record.vaccinations).map((row) => ({
        vaccine: displayPatientValue(row.vaccineName || row.vaccine_name),
        dateGiven: row.dateGiven || row.date_given || "",
      }))
    ),
    (row) => `${normalizeLabelText(row.vaccine)}-${cleanRecordValue(row.dateGiven)}`
  )
    .sort((a, b) => (parseDateValue(b.dateGiven)?.getTime() || 0) - (parseDateValue(a.dateGiven)?.getTime() || 0))
    .map((row) => [row.vaccine, formatCompactPatientDate(row.dateGiven)]);
  const lifestyleRows = [
    ["Smoker", initialAssessment.smoking_status],
    ["Alcohol Use", initialAssessment.alcohol_intake],
    ["Drug Use", initialAssessment.drug_use],
    ["Occupation", patientRelated?.personal?.occupation],
    ["Physical Activity", initialAssessment.physical_activity],
    ["Diet", initialAssessment.diet],
  ];
  const hasLifestyleData = lifestyleRows.some(([, value]) => cleanRecordValue(value));

  return {
    obstetricStats: [
      ["Gravida", formatObstetricValue(obstetric.gravida)],
      ["Para", formatObstetricValue(obstetric.para)],
      ["Abortion/Miscarriage", formatObstetricValue(obstetric.abortion_miscarriage)],
      ["Living Children", formatObstetricValue(obstetric.living_children)],
      ["Multiple Pregnancy", formatBooleanPatientValue(obstetric.multiple_pregnancy)],
    ],
    pregnancyHistoryRows: normalizePregnancyHistoryRows(obstetric, pregnancyNumber),
    currentPregnancyDetails: [
      [
        ["Last Menstrual Period", formatPatientDate(obstetric.last_menstrual_period, EMPTY_PATIENT_VALUE)],
        ["Expected Delivery Date", formatPatientDate(obstetric.expected_delivery_date || patient?.expected_delivery_date, EMPTY_PATIENT_VALUE)],
        ["Gestational Age", formatPregnancyWeek(patient, obstetric, records)],
      ],
      [
        ["Pregnancy Number", currentPregnancyLabel],
        ["Risk Level", buildRiskBadge(patient?.risk_level || getLatestRecordValue(records, ["riskLevel", "Risk Level"]))],
      ],
    ],
    conditions,
    familyHistoryRows,
    allergyRows,
    lifestyleRows: hasLifestyleData ? lifestyleRows : [],
    immunizationRows,
    prenatalVisitRows: buildPrenatalVisitRows(records, patient, obstetric),
  };
}

function PrenatalHistoryPanel({ patient, patientRelated, records }) {
  const prenatalData = React.useMemo(
    () => buildPrenatalData(patient, patientRelated, records),
    [patient, patientRelated, records]
  );

  return (
    <div
      className="mr-prenatal-layout"
      tabIndex={0}
      aria-label="Prenatal history sections"
    >
      <PrenatalSection number="1" title="Obstetric History" variant="full">
        <div className="mr-obstetric-stats">
          {prenatalData.obstetricStats.map(([label, value]) => (
            <div className="mr-obstetric-stat" key={label}>
              <strong>{label}</strong>
              <span>{value}</span>
            </div>
          ))}
        </div>

        <h4 className="mr-prenatal-subtitle">Pregnancy History</h4>

        <MedicalRecordTable
          columns={[
            "Pregnancy Number",
            "Year",
            "Outcome",
            "Delivery Type",
            "Birth weight",
            "Complications",
          ]}
          rows={prenatalData.pregnancyHistoryRows}
          emptyText="No pregnancy history records found."
          wide
        />
      </PrenatalSection>

      <PrenatalSection number="2" title="Current Pregnancy Information" variant="full">
        <div className="mr-prenatal-info-grid">
          {prenatalData.currentPregnancyDetails.map((column, index) => (
            <div className="mr-prenatal-info-column" key={index}>
              {column.map(([label, value]) => (
                <div className="mr-prenatal-info-row" key={label}>
                  <strong>{label}</strong>
                  <span>{value}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </PrenatalSection>

      <div className="mr-prenatal-two-column-grid">
        <PrenatalSection number="3" title="Maternal Medical Conditions">
          {prenatalData.conditions.length ? (
            <div className="mr-condition-grid">
              {prenatalData.conditions.map(({ label, checked }) => (
                <div className="mr-condition-item" key={label}>
                  <span className={`mr-condition-box is-readonly${checked ? " is-checked" : ""}`}>
                    {checked ? <Icon icon="mdi:check" /> : null}
                  </span>
                  <span>{label}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="mr-table-empty">No maternal medical conditions recorded.</p>
          )}
        </PrenatalSection>

        <PrenatalSection number="4" title="Family Medical History">
          <MedicalRecordTable
            columns={["Condition", "Mother", "Father"]}
            rows={prenatalData.familyHistoryRows}
            emptyText="No family medical history recorded."
            narrow
          />
        </PrenatalSection>
      </div>

      <div className="mr-prenatal-two-column-grid">
        <PrenatalSection number="5" title="Allergies">
          <MedicalRecordTable
            columns={["Type", "Allergen", "Reaction"]}
            rows={prenatalData.allergyRows}
            emptyText="No allergy records found."
            narrow
          />
        </PrenatalSection>

        <PrenatalSection number="6" title="Lifestyle Assessment">
          {prenatalData.lifestyleRows.length ? (
            <div className="mr-lifestyle-grid">
              {prenatalData.lifestyleRows.map(([label, value]) => (
                <div className="mr-prenatal-info-row" key={label}>
                  <strong>{label}</strong>
                  <span>{displayPatientValue(value)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="mr-table-empty">No lifestyle assessment recorded.</p>
          )}
        </PrenatalSection>
      </div>

      <PrenatalSection number="7" title="Immunization During Pregnancy" variant="full">
        <MedicalRecordTable
          columns={["Vaccine", "Date Given"]}
          rows={prenatalData.immunizationRows}
          emptyText="No immunization records found."
          narrow
        />
      </PrenatalSection>

      <PrenatalSection number="8" title="Prenatal Visit History" variant="full">
        <MedicalRecordTable
          columns={[
            "Date",
            "Gestational Age",
            "Weight",
            "Blood Pressure",
            "Fetal Heart Rate",
            "Notes",
          ]}
          rows={prenatalData.prenatalVisitRows}
          emptyText="No completed Doctor visit records found."
          wide
        />
      </PrenatalSection>
    </div>
  );
}

function AppointmentsPanel({ patient, appointmentState, focusedAppointmentId }) {
  const historyRef = React.useRef(null);
  React.useEffect(() => {
    if (!focusedAppointmentId) return;

    window.requestAnimationFrame(() => {
      const target = document.querySelector(`[data-appointment-id="${focusedAppointmentId}"]`);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [focusedAppointmentId]);

  const classifiedAppointments = React.useMemo(
    () =>
      appointmentState.appointments.map((appointment) => ({
        ...appointment,
        classification: classifyAppointment(appointment),
      })),
    [appointmentState.appointments]
  );
  const upcomingAppointments = React.useMemo(
    () =>
      classifiedAppointments
        .filter((appointment) => appointment.classification.isUpcoming)
        .sort(compareUpcomingAppointments),
    [classifiedAppointments]
  );
  const historyAppointments = React.useMemo(
    () => [...classifiedAppointments].sort(compareHistoryAppointments),
    [classifiedAppointments]
  );
  const nextAppointment = upcomingAppointments[0] || null;
  const completedCount = classifiedAppointments.filter(
    (appointment) => appointment.classification.category === "completed"
  ).length;
  const missedCancelledCount = classifiedAppointments.filter((appointment) =>
    ["cancelled", "missed", "overdue"].includes(appointment.classification.category)
  ).length;
  const attendanceTotal = completedCount + missedCancelledCount;
  const attendanceRate = attendanceTotal
    ? Math.round((completedCount / attendanceTotal) * 100)
    : 0;
  const percentOfTotal = (count) =>
    classifiedAppointments.length
      ? `${Math.round((count / classifiedAppointments.length) * 100)}%`
      : "0%";
  const appointmentSummary = [
    { label: "Total Visits", value: String(classifiedAppointments.length), note: "All time", icon: "mingcute:calendar-line", iconClass: "is-calendar", tone: "purple" },
    { label: "Completed", value: String(completedCount), note: percentOfTotal(completedCount), icon: "simple-line-icons:check", iconClass: "is-check", tone: "pink" },
    { label: "Upcoming", value: String(upcomingAppointments.length), note: percentOfTotal(upcomingAppointments.length), icon: "tabler:clock", iconClass: "is-clock", tone: "yellow" },
    { label: "Missed / Cancelled", value: String(missedCancelledCount), note: percentOfTotal(missedCancelledCount), icon: "charm:circle-cross", iconClass: "is-close", tone: "green" },
    { label: "Attendance Rate", value: `${attendanceRate}%`, note: `${attendanceRate}% attended`, icon: "streamline-ultimate:presentation-board-graph", iconClass: "is-attendance", tone: "blue" },
  ];

  return (
    <div className="mr-appointments-panel">
      <section className="mr-appointment-summary" aria-label="Appointment summary">
        {appointmentSummary.map((item) => (
          <article
            className={`mr-appointment-summary-card ${item.tone}`}
            key={item.label}
            aria-label={`${item.label}: ${item.value} ${item.note}`}
          >
            <span className={`mr-appointment-summary-icon ${item.iconClass || ""}`}>
              <Icon icon={item.icon} />
            </span>

            <div className="mr-appointment-summary-content">
              <p>{item.label}</p>
              <strong>{item.value}</strong>
              <small>{item.note}</small>
            </div>
          </article>
        ))}
      </section>

      <div className="mr-appointment-feature-grid">
        <section className="mr-card mr-upcoming-appointments-card">
          <header className="mr-appointment-section-header">
            <h3>Upcoming Appointments</h3>
            <button type="button" onClick={() => historyRef.current?.scrollIntoView({ behavior: "smooth" })}>
              View All
            </button>
          </header>

          {nextAppointment ? (
            <article
              className={`mr-next-appointment${nextAppointment.id === focusedAppointmentId ? " is-focused" : ""}`}
              data-appointment-id={nextAppointment.id}
            >
              <span><Icon icon="solar:calendar-bold" /></span>
              <div>
                <strong>{nextAppointment.title || "Appointment"}</strong>
                <p>{formatAppointmentDate(nextAppointment.start_time, { weekday: "long" })}</p>
                <small>{nextAppointment.resolved_doctor_name || "Doctor not recorded"}</small>
              </div>
              <time><Icon icon="solar:clock-circle-linear" />{formatAppointmentTime(nextAppointment.start_time)}</time>
            </article>
          ) : (
            <p>
              {appointmentState.loading
                ? "Loading appointments..."
                : appointmentState.error
                  ? "Unable to load appointments"
                  : "No upcoming appointment scheduled"}
            </p>
          )}
        </section>

        <section className="mr-card mr-appointment-timeline-card">
          <header className="mr-appointment-section-header">
            <h3>Prenatal Appointment Timeline</h3>
          </header>

          <div className="mr-appointment-timeline" tabIndex={0}>
            {historyAppointments.map((item) => (
              <article
                className={`${item.classification.category === "completed" ? "is-completed" : "is-upcoming"}${item.id === focusedAppointmentId ? " is-focused" : ""}`}
                data-appointment-id={item.id}
                key={item.id}
              >
                <span className="mr-appointment-timeline-marker">
                  {item.classification.category === "completed" ? <Icon icon="mdi:check" /> : null}
                </span>
                <div>
                  <strong>{patient?.gestational_age || "Appointment"}</strong>
                  <p>{item.title || "Appointment"}</p>
                  <small>{formatAppointmentDate(item.start_time)}</small>
                </div>
                <mark>{item.classification.displayStatus}</mark>
              </article>
            ))}

            {!historyAppointments.length && !appointmentState.loading ? <p>No appointment history found.</p> : null}
          </div>
        </section>
      </div>

      <section className="mr-card mr-appointment-history-card" ref={historyRef}>
        <h3>Appointment History</h3>
        <div className="mr-appointment-history-wrap">
          <table className="mr-appointment-history-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Time</th>
                <th>Gestational Age</th>
                <th>Doctor</th>
                <th>Purpose</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {historyAppointments.map((appointment) => (
                <tr
                  className={appointment.id === focusedAppointmentId ? "is-focused" : ""}
                  data-appointment-id={appointment.id}
                  key={appointment.id}
                >
                  <td>{formatAppointmentDate(appointment.start_time, { month: "2-digit", day: "2-digit", year: "2-digit" })}</td>
                  <td>{formatAppointmentTime(appointment.start_time)}</td>
                  <td>{patient?.gestational_age || "-"}</td>
                  <td>{appointment.resolved_doctor_name || "Doctor not recorded"}</td>
                  <td>{appointment.title || "Appointment"}</td>
                  <td><mark>{appointment.classification.displayStatus}</mark></td>
                </tr>
              ))}

              {!historyAppointments.length && !appointmentState.loading ? (
                <tr><td colSpan="6">No appointments found.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function getReviewStatus(review) {
  const explicitStatus = cleanRecordValue(review?.status || review?.resultStatus || review?.result_status);
  if (explicitStatus) return explicitStatus;
  if (cleanRecordValue(review?.resultSummary || review?.interpretation || review?.findings)) return "Completed";
  return "Pending";
}

function getStatusTone(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (["normal", "completed", "complete", "verified"].includes(normalized)) return "normal";
  if (["abnormal", "high risk", "critical"].includes(normalized)) return "abnormal";
  return "pending";
}

function buildDiagnosticRows(records) {
  return records.flatMap((record) => {
    const rows = [];
    const lab = record.laboratoryReview;
    const labAttachment = normalizeRecordAttachment(lab?.attachment);
    const labName = cleanRecordValue(lab?.testType || lab?.test_type);

    if (labName || cleanRecordValue(lab?.resultSummary || lab?.interpretation) || labAttachment) {
      const status = getReviewStatus(lab);
      rows.push({
        id: `${record.id}-laboratory`,
        dateCollected: record.date,
        gestationalAge: record.gestationalAge,
        test: labName || "Laboratory review",
        status,
        statusTone: getStatusTone(status),
        orderedBy: record.doctor,
        file: labAttachment,
      });
    }

    const ultrasound = record.ultrasoundReview;
    const ultrasoundAttachment = normalizeRecordAttachment(ultrasound?.attachment);

    if (cleanRecordValue(ultrasound?.findings) || cleanRecordValue(ultrasound?.visitDate) || ultrasoundAttachment) {
      const status = getReviewStatus(ultrasound);
      rows.push({
        id: `${record.id}-ultrasound`,
        dateCollected: formatPatientDate(ultrasound?.visitDate, record.date),
        gestationalAge: record.gestationalAge,
        test: "Ultrasound review",
        status,
        statusTone: getStatusTone(status),
        orderedBy: record.doctor,
        file: ultrasoundAttachment,
      });
    }

    getRecordArray(record.diagnosticResults).forEach((result, index) => {
      rows.push({
        id: `${record.id}-diagnostic-${index}`,
        dateCollected: record.date,
        gestationalAge: record.gestationalAge,
        test: result,
        status: "Recorded",
        statusTone: "normal",
        orderedBy: record.doctor,
        file: null,
      });
    });

    return rows;
  });
}

function DiagnosticResultsPanel({ records }) {
  const [query, setQuery] = React.useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const diagnosticRows = React.useMemo(() => buildDiagnosticRows(records), [records]);
  const filteredResults = diagnosticRows.filter((result) =>
    [
      result.dateCollected,
      result.gestationalAge,
      result.test,
      result.status,
      result.orderedBy,
      result.file?.name,
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery)
  );

  return (
    <div className="mr-laboratory-panel">
      <label className="mr-laboratory-search">
        <Icon icon="solar:magnifer-linear" />
        <input
          type="search"
          placeholder="Search Diagnostic Results..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <div className="mr-laboratory-table-wrap">
        <div className="mr-laboratory-table" role="table" aria-label="Diagnostic results">
          <div className="mr-laboratory-head" role="row">
            <span role="columnheader">Date Collected</span>
            <span role="columnheader">Test</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Ordered By</span>
            <span role="columnheader">Actions</span>
          </div>

          {filteredResults.length > 0 ? filteredResults.map((result) => (
            <div className="mr-laboratory-row" role="row" key={result.id}>
              <span className="mr-laboratory-date" role="cell">
                <strong>{result.dateCollected}</strong>
                <small>({result.gestationalAge})</small>
              </span>
              <span role="cell">{result.test}</span>
              <span role="cell">
                <mark className={`is-${result.statusTone}`}>{result.status}</mark>
              </span>
              <span role="cell">{result.orderedBy}</span>
              <span role="cell">
                {result.file ? (
                  <MedicalAttachmentControl attachment={result.file} compact />
                ) : (
                  <span className="mr-unavailable-action">No file</span>
                )}
              </span>
            </div>
          )) : (
            <div className="mr-laboratory-empty">
              <Icon icon="solar:test-tube-linear" />
              <p>{normalizedQuery ? "No diagnostic results match your search." : "No diagnostic results found."}</p>
            </div>
          )}
        </div>
      </div>

      <p className="mr-laboratory-count">
        Showing {filteredResults.length} of {diagnosticRows.length} Diagnostic results
      </p>
    </div>
  );
}

function buildPrescriptionRows(records) {
  return records
    .map((record) => {
      const prescription = record.prescription || {};
      const medications = getRecordArray(prescription.medications)
        .filter((medication) => cleanRecordValue(medication?.medication));
      const instructions = cleanRecordValue(prescription.instructions);
      const attachment = normalizeRecordAttachment(prescription.attachment);

      if (!medications.length && !instructions && !attachment) return null;

      return {
        id: cleanRecordValue(prescription.reference) || cleanRecordValue(record.appointmentReference) || record.id,
        doctor: record.doctor,
        date: record.date,
        medications,
        instructions,
        file: attachment,
      };
    })
    .filter(Boolean);
}

function PrescriptionsPanel({ records }) {
  const [query, setQuery] = React.useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const prescriptionRows = React.useMemo(() => buildPrescriptionRows(records), [records]);
  const filteredPrescriptions = prescriptionRows.filter((prescription) =>
    [
      prescription.id,
      prescription.doctor,
      prescription.date,
      prescription.instructions,
      prescription.file?.name,
      ...prescription.medications.flatMap((medication) => Object.values(medication)),
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery)
  );

  return (
    <div className="mr-prescriptions-panel">
      <label className="mr-prescriptions-search">
        <Icon icon="solar:magnifer-linear" />
        <input
          type="search"
          placeholder="Search Prescriptions...."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <div className="mr-prescription-list">
        {filteredPrescriptions.length > 0 ? filteredPrescriptions.map((prescription) => (
          <article className="mr-prescription-card" key={prescription.id}>
            <header className="mr-prescription-header">
              <span className="mr-prescription-icon">
                <Icon icon="material-symbols:prescriptions-outline" />
              </span>
              <div className="mr-prescription-title">
                <h3>Prescription #{prescription.id}</h3>
                <p>{prescription.doctor}</p>
              </div>
              <time>
                <Icon icon="mingcute:calendar-line" />
                {prescription.date}
              </time>
            </header>

            <div className="mr-prescription-table-wrap">
              <div className="mr-prescription-table" role="table" aria-label={`Prescription ${prescription.id}`}>
                <div className="mr-prescription-head" role="row">
                  <span role="columnheader">Medication</span>
                  <span role="columnheader">Dosage</span>
                  <span role="columnheader">Frequency</span>
                  <span role="columnheader">Duration</span>
                </div>

                {prescription.medications.map((medication) => (
                  <div className="mr-prescription-row" role="row" key={medication.medication}>
                    <span role="cell">{medication.medication}</span>
                    <span role="cell">{medication.dosage}</span>
                    <span role="cell">{medication.frequency}</span>
                    <span role="cell">{medication.duration}</span>
                  </div>
                ))}
              </div>
            </div>

            <section className="mr-prescription-instructions">
              <h4>Instructions:</h4>
              <p>{prescription.instructions}</p>
            </section>

            <footer className="mr-prescription-footer">
              {prescription.file?.dataUrl ? (
                <>
                  <div className="mr-prescription-file">
                    <Icon icon="akar-icons:file" />
                    <span>
                      <strong>{prescription.file.name}</strong>
                      <small>{[prescription.file.type, prescription.file.sizeLabel].filter(Boolean).join(" - ")}</small>
                    </span>
                  </div>
                  <a href={prescription.file.dataUrl} download={prescription.file.name}>
                    <Icon icon="material-symbols:download-rounded" />
                    Download
                  </a>
                </>
              ) : (
                <span className="mr-unavailable-action">No prescription file attached</span>
              )}
            </footer>
          </article>
        )) : (
          <div className="mr-prescription-empty">
            <Icon icon="material-symbols:prescriptions-outline" />
            <p>{normalizedQuery ? "No prescriptions match your search." : "No prescriptions recorded."}</p>
          </div>
        )}
      </div>

      <p className="mr-prescription-count">
        Showing {filteredPrescriptions.length} of {prescriptionRows.length} Prescriptions
      </p>
    </div>
  );
}

function MedicationAdherencePanel({ patient, doctorName }) {
  const [dateFilter, setDateFilter] = React.useState("Last 7 Days");
  const [statusFilter, setStatusFilter] = React.useState("All");
  const [customDraftRange, setCustomDraftRange] = React.useState({
    startDate: "",
    endDate: "",
  });
  const [appliedCustomRange, setAppliedCustomRange] = React.useState({
    startDate: "",
    endDate: "",
  });
  const [rangeMessage, setRangeMessage] = React.useState("");
  const [medicationReminders, setMedicationReminders] = React.useState([]);
  const [occurrences, setOccurrences] = React.useState([]);
  const [trendOccurrences, setTrendOccurrences] = React.useState([]);
  const [alertOccurrences, setAlertOccurrences] = React.useState([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState(false);
  const [trendLoadError, setTrendLoadError] = React.useState(false);
  const [alertLoadError, setAlertLoadError] = React.useState(false);
  const [reportAction, setReportAction] = React.useState("");
  const [reportFeedback, setReportFeedback] = React.useState({
    message: "",
    type: "",
  });
  const [reportGeneratedAt, setReportGeneratedAt] = React.useState(() =>
    new Date().toISOString()
  );
  const patientId = patient?.id || "";

  const dateRange = React.useMemo(
    () => getMedicationAdherenceDateRange(dateFilter, appliedCustomRange),
    [appliedCustomRange, dateFilter]
  );
  const trendRange = React.useMemo(
    () =>
      getPreviousMedicationAdherenceRange(
        dateRange.startDate,
        dateRange.endDate
      ),
    [dateRange.endDate, dateRange.startDate]
  );

  const loadAdherenceRecords = React.useCallback(async () => {
    if (
      !patientId ||
      dateRange.error ||
      !dateRange.startIso ||
      !dateRange.endIso ||
      !trendRange.previousStart
    ) {
      setMedicationReminders([]);
      setOccurrences([]);
      setTrendOccurrences([]);
      setAlertOccurrences([]);
      setLoadError(false);
      setTrendLoadError(false);
      setAlertLoadError(false);
      return;
    }

    setIsLoading(true);
    setLoadError(false);
    setTrendLoadError(false);
    setAlertLoadError(false);
    const alertDateRange = getMedicationAdherenceAlertDateRange();
    const nowIso = new Date().toISOString();

    const [reminderResult, occurrenceResult, alertOccurrenceResult] = await Promise.all([
      supabase
        .from("medication_reminders")
        .select(
          `
            id,
            medication_name,
            dosage
          `
        )
        .eq("patient_id", patientId)
        .order("start_date", { ascending: false }),
      supabase
        .from("medication_reminder_occurrences")
        .select(
          `
            id,
            medication_reminder_id,
            patient_id,
            scheduled_for,
            status,
            action_at,
            missed_at
          `
        )
        .eq("patient_id", patientId)
        .gte(
          "scheduled_for",
          toManilaISOString(trendRange.previousStart, "00:00")
        )
        .lt("scheduled_for", dateRange.endIso)
        .order("scheduled_for", { ascending: false }),
      supabase
        .from("medication_reminder_occurrences")
        .select(
          `
            id,
            medication_reminder_id,
            patient_id,
            scheduled_for,
            status,
            notified_at,
            action_at,
            missed_at
          `
        )
        .eq("patient_id", patientId)
        .gte("scheduled_for", alertDateRange.startIso)
        .lt("scheduled_for", alertDateRange.endIso)
        .lte("scheduled_for", nowIso)
        .in("status", ["taken", "skipped", "missed"])
        .order("scheduled_for", { ascending: true }),
    ]);

    setIsLoading(false);

    if (reminderResult.error || occurrenceResult.error) {
      console.error("Medication adherence load failed:", {
        reminders: reminderResult.error,
        occurrences: occurrenceResult.error,
      });
      setLoadError(true);
    }

    setMedicationReminders(reminderResult.error ? [] : reminderResult.data || []);

    if (occurrenceResult.error) {
      setOccurrences([]);
      setTrendOccurrences([]);
      setTrendLoadError(true);
    } else {
      const loadedOccurrences = occurrenceResult.data || [];
      setTrendOccurrences(loadedOccurrences);
      setOccurrences(
        loadedOccurrences.filter((occurrence) => {
          const dateKey = getManilaDateKey(occurrence.scheduled_for);
          return (
            dateKey >= dateRange.startDate &&
            dateKey <= dateRange.endDate
          );
        })
      );
    }

    if (alertOccurrenceResult.error) {
      console.error("Medication adherence alert load failed:", {
        occurrences: alertOccurrenceResult.error,
      });
      setAlertOccurrences([]);
      setAlertLoadError(true);
    } else {
      setAlertOccurrences(alertOccurrenceResult.data || []);
    }

  }, [
    dateRange.endDate,
    dateRange.endIso,
    dateRange.error,
    dateRange.startDate,
    dateRange.startIso,
    patientId,
    trendRange.previousStart,
  ]);

  React.useEffect(() => {
    const initialLoadTimer = window.setTimeout(loadAdherenceRecords, 0);
    return () => window.clearTimeout(initialLoadTimer);
  }, [loadAdherenceRecords]);

  React.useEffect(() => {
    if (!patientId || dateRange.error) {
      return undefined;
    }

    const handleWindowFocus = () => {
      loadAdherenceRecords();
    };
    const refreshTimer = window.setInterval(loadAdherenceRecords, 30000);

    window.addEventListener("focus", handleWindowFocus);

    return () => {
      window.removeEventListener("focus", handleWindowFocus);
      window.clearInterval(refreshTimer);
    };
  }, [dateRange.error, loadAdherenceRecords, patientId]);

  const reminderById = React.useMemo(() => {
    return new Map(medicationReminders.map((reminder) => [reminder.id, reminder]));
  }, [medicationReminders]);

  const adherenceRows = React.useMemo(() => {
    return occurrences.map((occurrence) => {
      const reminder = reminderById.get(occurrence.medication_reminder_id) || {};
      const occurrenceStatus = normalizeMedicationAdherenceStatus(occurrence.status);
      const statusMeta = getMedicationAdherenceStatusMeta(occurrenceStatus);

      return {
        ...occurrence,
        status: occurrenceStatus,
        medicationName: reminder.medication_name || "Medication",
        dosage: reminder.dosage || "-",
        statusLabel: statusMeta.label,
        statusClassName: statusMeta.className,
        responseTime: getMedicationAdherenceResponseLabel(occurrence),
      };
    });
  }, [occurrences, reminderById]);

  const trendData = React.useMemo(
    () =>
      buildMedicationAdherenceTrendData({
        occurrences: trendOccurrences,
        currentStart: dateRange.startDate,
        currentEnd: dateRange.endDate,
        previousStart: trendRange.previousStart,
        previousEnd: trendRange.previousEnd,
      }),
    [
      dateRange.endDate,
      dateRange.startDate,
      trendOccurrences,
      trendRange.previousEnd,
      trendRange.previousStart,
    ]
  );

  const summary = React.useMemo(() => {
    const calculation = calculateMedicationAdherenceAlert(adherenceRows);

    return {
      taken: calculation.takenCount,
      skipped: calculation.skippedCount,
      missed: calculation.missedCount,
      totalOutcomes: calculation.totalCompletedOutcomes,
      adherenceRate: calculation.adherenceRate ?? 0,
    };
  }, [adherenceRows]);

  const liveAdherence = React.useMemo(() => {
    if (!isEligibleMedicationAdherenceAlertPatient(patient)) {
      return null;
    }

    return calculateMedicationAdherenceAlert(alertOccurrences);
  }, [alertOccurrences, patient]);
  const adherenceAlert = liveAdherence?.shouldAlert ? liveAdherence : null;

  const filteredRows = React.useMemo(() => {
    if (statusFilter === "All") {
      return adherenceRows;
    }

    const status = statusFilter === "Due" ? "notified" : statusFilter.toLowerCase();
    return adherenceRows.filter((row) => row.status === status);
  }, [adherenceRows, statusFilter]);

  const canPrepareReport =
    Boolean(patient?.id) &&
    !isLoading &&
    !loadError &&
    !trendLoadError &&
    !dateRange.error;

  const exportMedicationAdherenceCsv = () => {
    if (!canPrepareReport || reportAction) return;

    setReportAction("csv");
    setReportFeedback({ message: "", type: "" });
    const generatedAt = new Date().toISOString();
    setReportGeneratedAt(generatedAt);

    try {
      const patientFilenamePart = patient?.patient_id
        ? sanitizeFilename(patient.patient_id)
        : "patient-report";
      const dateSegment = formatDateRangeFilenameSegment(
        dateRange.startDate,
        dateRange.endDate
      );
      downloadCsv({
        filename: `medication-adherence-${patientFilenamePart}-${dateSegment}`,
        rows: buildPatientAdherenceCsvRows({
          patient,
          doctorName,
          dateRange,
          dateFilter,
          statusFilter,
          trendData,
          historyRows: filteredRows,
          generatedAt,
        }),
      });
      setReportFeedback({
        message: "Report exported successfully.",
        type: "success",
      });
    } catch (error) {
      console.error("Medication adherence CSV export failed:", {
        name: error?.name || "unknown",
      });
      setReportFeedback({
        message: "The report could not be exported. Please try again.",
        type: "error",
      });
    } finally {
      setReportAction("");
    }
  };

  const printMedicationAdherenceReport = async () => {
    if (!canPrepareReport || reportAction) return;

    setReportAction("print");
    setReportFeedback({
      message: "Preparing medication adherence report for printing.",
      type: "status",
    });
    const generatedAt = new Date().toISOString();
    setReportGeneratedAt(generatedAt);

    try {
      await printReport({
        bodyClass: "print-patient-medication-report",
        documentTitle: `Medication Adherence Report - ${
          patient?.patient_id || "Patient"
        }`,
        rootSelector: ".report-print-root.report-print-patient",
        pageSize: "A4 portrait",
        pageMargin: "12mm",
      });
      setReportFeedback({
        message: "Print report prepared successfully.",
        type: "success",
      });
    } catch (error) {
      console.error("Medication adherence print preparation failed:", {
        name: error?.name || "unknown",
      });
      setReportFeedback({
        message: "The report could not be prepared for printing. Please try again.",
        type: "error",
      });
    } finally {
      setReportAction("");
    }
  };

  const applyCustomRange = () => {
    const nextRange = {
      startDate: customDraftRange.startDate,
      endDate: customDraftRange.endDate,
    };
    const validation = getMedicationAdherenceDateRange("Custom Range", nextRange);

    if (validation.error) {
      setRangeMessage(validation.error);
      return;
    }

    setRangeMessage("");
    setAppliedCustomRange(nextRange);
    setDateFilter("Custom Range");
  };

  const resetCustomRange = () => {
    setCustomDraftRange({ startDate: "", endDate: "" });
    setAppliedCustomRange({ startDate: "", endDate: "" });
    setRangeMessage("");
    setDateFilter("Last 7 Days");
  };

  const emptyMessage = !patient?.id
    ? "Select a Patient to review medication adherence."
    : medicationReminders.length === 0
      ? "No medication reminders are available for this Patient."
      : adherenceRows.length === 0
        ? "No medication adherence records were found for this date range."
        : "No records match the selected filters.";

  const summaryCards = [
    {
      label: "Total Scheduled Doses",
      value: String(summary.totalOutcomes),
      note: "Taken, skipped, or missed",
      icon: "solar:calendar-mark-bold",
      iconClass: "is-calendar",
      tone: "purple",
    },
    {
      label: "Taken",
      value: String(summary.taken),
      note: `${summary.adherenceRate}% adherence`,
      icon: "simple-line-icons:check",
      iconClass: "is-check",
      tone: "green",
    },
    {
      label: "Skipped",
      value: String(summary.skipped),
      note: "Patient skipped",
      icon: "tabler:minus",
      iconClass: "is-clock",
      tone: "yellow",
    },
    {
      label: "Missed",
      value: String(summary.missed),
      note: "No response",
      icon: "charm:circle-cross",
      iconClass: "is-close",
      tone: "pink",
    },
    {
      label: "Adherence Rate",
      value: `${summary.adherenceRate}%`,
      note: "Taken / completed outcomes",
      icon: "streamline-ultimate:presentation-board-graph",
      iconClass: "is-attendance",
      tone: "blue",
    },
  ];

  return (
    <div className="mr-adherence-panel">
      <header className="mr-adherence-header">
        <div>
          <h2>Medication Adherence</h2>
          <p>Review the Patient's scheduled medication doses and recorded responses.</p>
        </div>
        <div className="mr-adherence-header-actions">
          <button
            type="button"
            aria-label="Export Medication Adherence CSV"
            disabled={!canPrepareReport || Boolean(reportAction)}
            onClick={exportMedicationAdherenceCsv}
          >
            <Icon icon="solar:download-minimalistic-linear" aria-hidden="true" />
            {reportAction === "csv" ? "Exporting..." : "Export CSV"}
          </button>
          <button
            type="button"
            aria-label="Print Medication Adherence Report"
            disabled={!canPrepareReport || Boolean(reportAction)}
            onClick={printMedicationAdherenceReport}
          >
            <Icon icon="solar:printer-linear" aria-hidden="true" />
            {reportAction === "print" ? "Preparing..." : "Print Report"}
          </button>
          <button type="button" onClick={loadAdherenceRecords} disabled={isLoading || Boolean(dateRange.error)}>
            <Icon icon="solar:refresh-linear" />
            Refresh
          </button>
        </div>
      </header>

      <div
        className={`mr-adherence-report-feedback ${
          reportFeedback.type ? `is-${reportFeedback.type}` : ""
        }`}
        role={reportFeedback.type === "error" ? "alert" : "status"}
        aria-live="polite"
      >
        {reportFeedback.message}
      </div>

      {alertLoadError ? (
        <div className="mr-adherence-alert-load-error" role="alert">
          <span>Medication adherence alert could not be loaded.</span>
          <button type="button" onClick={loadAdherenceRecords}>
            Retry
          </button>
        </div>
      ) : adherenceAlert ? (
        <section
          className={`mr-adherence-alert is-${adherenceAlert.severity}`}
          aria-label={`${adherenceAlert.severityLabel} medication adherence alert`}
        >
          <span className="mr-adherence-alert-icon" aria-hidden="true">
            <Icon
              icon={
                adherenceAlert.severity === "critical"
                  ? "solar:danger-triangle-bold"
                  : "solar:shield-warning-bold"
              }
            />
          </span>
          <div className="mr-adherence-alert-content">
            <span className="mr-adherence-alert-label">
              {adherenceAlert.severity === "critical"
                ? "Critical Medication Adherence Alert"
                : `${adherenceAlert.severityLabel} Medication Adherence Alert`}
            </span>
            <small>Based on the last 7 days</small>
            <p>
              {adherenceAlert.severity === "critical"
                ? `The Patient has at least ${adherenceAlert.maximumMissedStreak} consecutive missed medication doses.`
                : `The Patient has a ${adherenceAlert.adherenceRate}% medication adherence rate during the last 7 days.`}
            </p>
            {adherenceAlert.severity === "critical" ? (
              <strong>Adherence rate: {adherenceAlert.adherenceRate}%</strong>
            ) : null}
            <div className="mr-adherence-alert-counts">
              <span>{adherenceAlert.takenCount} Taken</span>
              <span>{adherenceAlert.skippedCount} Skipped</span>
              <span>{adherenceAlert.missedCount} Missed</span>
            </div>
          </div>
          <div className="mr-adherence-alert-actions">
            <SendPatientNotificationAction
              patientId={patient.id}
              patientName={patient.full_name}
              defaultType={MEDICATION_ADHERENCE_NOTIFICATION_DRAFT.type}
              defaultTitle={MEDICATION_ADHERENCE_NOTIFICATION_DRAFT.title}
              defaultMessage={MEDICATION_ADHERENCE_NOTIFICATION_DRAFT.message}
              defaultPriority={MEDICATION_ADHERENCE_NOTIFICATION_DRAFT.priority}
              className="mr-adherence-alert-notification"
            />
            <button
              type="button"
              className="mr-adherence-alert-refresh"
              onClick={loadAdherenceRecords}
              disabled={isLoading}
            >
              <Icon icon="solar:refresh-linear" aria-hidden="true" />
              Refresh
            </button>
          </div>
        </section>
      ) : null}

      <section className="mr-appointment-summary mr-adherence-summary" aria-label="Medication adherence summary">
        {summaryCards.map((item) => (
          <article
            className={`mr-appointment-summary-card ${item.tone}`}
            key={item.label}
            aria-label={`${item.label}: ${item.value}`}
          >
            <span className={`mr-appointment-summary-icon ${item.iconClass}`}>
              <Icon icon={item.icon} />
            </span>
            <div className="mr-appointment-summary-content">
              <p>{item.label}</p>
              <strong>{item.value}</strong>
              <small>{item.note}</small>
            </div>
          </article>
        ))}
      </section>

      <section className="mr-adherence-filters" aria-label="Medication adherence filters">
        <div className="mr-adherence-filter-group" aria-label="Date range">
          {medicationAdherenceDateFilters.map((filter) => (
            <button
              key={filter}
              type="button"
              className={dateFilter === filter ? "is-active" : ""}
              aria-current={dateFilter === filter ? "true" : undefined}
              onClick={() => {
                setRangeMessage("");
                setDateFilter(filter);
              }}
            >
              {filter}
            </button>
          ))}
        </div>

        <div className="mr-adherence-filter-group" aria-label="Status">
          {medicationAdherenceStatusFilters.map((filter) => (
            <button
              key={filter}
              type="button"
              className={statusFilter === filter ? "is-active" : ""}
              aria-current={statusFilter === filter ? "true" : undefined}
              onClick={() => setStatusFilter(filter)}
            >
              {filter}
            </button>
          ))}
        </div>

        {dateFilter === "Custom Range" ? (
          <div className="mr-adherence-custom-range">
            <label>
              <span>Start date</span>
              <input
                type="date"
                value={customDraftRange.startDate}
                onChange={(event) =>
                  setCustomDraftRange((current) => ({
                    ...current,
                    startDate: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>End date</span>
              <input
                type="date"
                value={customDraftRange.endDate}
                onChange={(event) =>
                  setCustomDraftRange((current) => ({
                    ...current,
                    endDate: event.target.value,
                  }))
                }
              />
            </label>
            <button type="button" onClick={applyCustomRange}>Apply</button>
            <button type="button" onClick={resetCustomRange}>Reset</button>
          </div>
        ) : null}
      </section>

      {rangeMessage || dateRange.error ? (
        <p className="mr-adherence-message">{rangeMessage || dateRange.error}</p>
      ) : null}

      <MedicationAdherenceTrendCharts
        trendData={trendData}
        status={trendLoadError ? "error" : isLoading ? "loading" : "ready"}
        onRetry={loadAdherenceRecords}
      />

      {loadError ? (
        <div className="mr-adherence-empty is-error">
          <p>Medication adherence records could not be loaded. Please try again.</p>
          <button type="button" onClick={loadAdherenceRecords}>Retry</button>
        </div>
      ) : (
        <section className="mr-card mr-adherence-history-card">
          <header className="mr-appointment-section-header">
            <h3>Adherence History</h3>
            <p>
              {dateRange.startDate && dateRange.endDate
                ? `${formatAppointmentDate(toManilaISOString(dateRange.startDate, "00:00"))} - ${formatAppointmentDate(toManilaISOString(dateRange.endDate, "00:00"))}`
                : "Selected date range"}
            </p>
          </header>

          {isLoading ? (
            <div className="mr-adherence-empty">Loading medication adherence records...</div>
          ) : filteredRows.length > 0 ? (
            <div className="mr-adherence-table-wrap">
              <table className="mr-adherence-table">
                <thead>
                  <tr>
                    <th>Scheduled Date</th>
                    <th>Scheduled Time</th>
                    <th>Medication</th>
                    <th>Dosage</th>
                    <th>Status</th>
                    <th>Response Time</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row) => (
                    <tr key={row.id}>
                      <td>{formatAppointmentDate(row.scheduled_for)}</td>
                      <td>{formatAppointmentTime(row.scheduled_for)}</td>
                      <td>{row.medicationName}</td>
                      <td>{row.dosage}</td>
                      <td>
                        <mark className={`mr-adherence-status is-${row.statusClassName}`}>
                          {row.statusLabel}
                        </mark>
                      </td>
                      <td>{row.responseTime}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="mr-adherence-empty">{emptyMessage}</div>
          )}
        </section>
      )}

      {reportAction === "print" ? (
        <MedicationAdherencePrintableReport
          patient={patient}
          doctorName={doctorName}
          dateRange={dateRange}
          statusFilter={statusFilter}
          generatedAt={reportGeneratedAt}
          trendData={trendData}
          historyRows={filteredRows}
        />
      ) : null}
    </div>
  );
}

function formatWithUnitFromRecord(records, labels, unit = "") {
  const value = getLatestRecordValue(records, labels);
  if (!value) return EMPTY_PATIENT_VALUE;
  if (!unit) return value;
  return value.toLowerCase().includes(unit.toLowerCase()) ? value : `${value} ${unit}`;
}

function buildTrackingDetails(patient, patientRelated, records, pregnancyWeek) {
  const obstetric = patientRelated?.obstetric || {};
  const week = pregnancyWeek;
  const progressPercent = week === null ? 0 : Math.round(Math.min(100, (week / 40) * 100));
  const currentWeight = parseNumericValue(getLatestRecordValue(records, ["Weight"]));
  const prePregnancyWeight = parseNumericValue(patientRelated?.initialAssessment?.weight_kg);
  const weightGain =
    currentWeight !== null && prePregnancyWeight !== null
      ? `${currentWeight - prePregnancyWeight >= 0 ? "+" : ""}${currentWeight - prePregnancyWeight} kg`
      : EMPTY_PATIENT_VALUE;

  return {
    week,
    progressPercent,
    trimesterLabel: getTrimesterLabel(week),
    weeksRemaining: week === null ? EMPTY_PATIENT_VALUE : `${Math.max(0, 40 - week)} weeks to go`,
    expectedDeliveryDate: formatPatientDate(obstetric.expected_delivery_date || patient?.expected_delivery_date, EMPTY_PATIENT_VALUE),
    riskLevel: formatRiskBadge(
      patient?.risk_level || getLatestRecordValue(records, ["riskLevel", "Risk Level"])
    ),
    babyDevelopment: [
      ["Estimated Weight", formatWithUnitFromRecord(records, ["Estimated Fetal Weight"], "g")],
      ["Estimated Length", formatWithUnitFromRecord(records, ["Estimated Fetal Length"], "cm")],
      ["Position", displayPatientValue(getLatestRecordValue(records, ["Baby Position", "Fetal Position"]))],
      ["Fetal Heart Rate", formatWithUnitFromRecord(records, ["Fetal Heart Rate"], "bpm")],
      ["Movement", displayPatientValue(getLatestRecordValue(records, ["Fetal Movement", "Movement"]))],
    ],
    maternalProgress: [
      ["Pre-pregnancy Weight", prePregnancyWeight === null ? EMPTY_PATIENT_VALUE : `${prePregnancyWeight} kg`],
      ["Current Weight", currentWeight === null ? EMPTY_PATIENT_VALUE : `${currentWeight} kg`],
      ["Total Weight Gain", weightGain],
      ["BMI", formatWithUnitFromRecord(records, ["BMI"], "kg/m2")],
      ["Blood Pressure (Latest)", formatWithUnitFromRecord(records, ["Blood Pressure"], "mmHg")],
    ],
  };
}

function PregnancyTrackingPanel({ patient, patientRelated, records, pregnancyWeek }) {
  const tracking = React.useMemo(
    () => buildTrackingDetails(patient, patientRelated, records, pregnancyWeek),
    [patient, patientRelated, pregnancyWeek, records]
  );
  const ringPercent = tracking.progressPercent;
  const expectedDeliveryDate = formatPatientDate(
    patient?.expected_delivery_date,
    EMPTY_PATIENT_VALUE
  );
  const weekLabel = tracking.week === null ? "-" : tracking.week;

  return (
    <div className="mr-pregnancy-tracking-panel">
      <section className="mr-card mr-tracking-progress-card">
        <div className="mr-tracking-progress-visual">
          <div
            className="mr-tracking-progress-ring"
            role="img"
            aria-label={`Pregnancy progress: ${tracking.week === null ? "not recorded" : `week ${tracking.week} of 40, ${ringPercent} percent complete`}`}
            style={{ "--mr-progress-percent": `${ringPercent}%` }}
          >
            <div className="mr-tracking-progress-ring__content">
              <span>WEEK</span>
              <strong>{weekLabel}</strong>
              <span>OF 40</span>
            </div>
          </div>
        </div>

        <div className="mr-tracking-progress-content">
          <h3>Current Pregnancy Progress</h3>
          <div className="mr-tracking-trimester">
            <span className="mr-tracking-trimester-icon">
              <Icon icon="healthicons:pregnant" />
            </span>
            <div>
              <strong>{tracking.trimesterLabel}</strong>
              <p>{tracking.weeksRemaining}</p>
            </div>
          </div>

          <div className="mr-tracking-progress-bar" aria-hidden="true">
            <span style={{ width: `${ringPercent}%` }}>{ringPercent}%</span>
          </div>

          <div className="mr-tracking-progress-meta">
            <div>
              <span className="mr-tracking-meta-icon">
                <Icon icon="mingcute:calendar-line" />
              </span>
              <span>
                <small>Expected Delivery Date</small>
                <strong>{tracking.expectedDeliveryDate || expectedDeliveryDate}</strong>
              </span>
            </div>
            <div>
              <span className="mr-tracking-meta-icon">
                <Icon icon="material-symbols:shield-outline-rounded" />
              </span>
              <span>
                <small>Risk Level</small>
                <mark>{tracking.riskLevel}</mark>
              </span>
            </div>
          </div>
        </div>

        <img
          className="mr-tracking-progress-image"
          src="/images/preggy.png"
          alt=""
          aria-hidden="true"
        />
      </section>

      <div className="mr-tracking-detail-grid">
        <section className="mr-card mr-tracking-detail-card">
          <header>
            <div>
              <span className="mr-tracking-detail-icon">
                <Icon icon="glyphs:baby-outline" />
              </span>
              <h3>Baby Development</h3>
            </div>
            <Icon className="mr-tracking-card-illustration" icon="icon-park-outline:baby-feet" />
          </header>

          <div className="mr-tracking-baby-body">
            <dl>
              {tracking.babyDevelopment.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <img
              className="mr-tracking-baby-image"
              src="/images/babys.png"
              alt=""
              aria-hidden="true"
            />
          </div>

          <footer>
            <span><Icon icon="line-md:heart" /></span>
            <strong>{tracking.week === null ? "Baby development data will appear after a completed clinical visit." : "Baby development is based on the latest completed clinical visit."}</strong>
          </footer>
        </section>

        <section className="mr-card mr-tracking-detail-card">
          <header>
            <div>
              <span className="mr-tracking-detail-icon">
                <Icon icon="healthicons:pregnant" />
              </span>
              <h3>Maternal Progress</h3>
            </div>
            <Icon className="mr-tracking-card-illustration" icon="solar:health-bold-duotone" />
          </header>

          <dl>
            {tracking.maternalProgress.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>

          <footer>
            <span><Icon icon="line-md:heart" /></span>
            <strong>Maternal progress is calculated from recorded clinical measurements.</strong>
          </footer>
        </section>
      </div>

      <section className="mr-card mr-pregnancy-journey-card">
        <header>
          <div>
            <span className="mr-tracking-detail-icon">
            <Icon icon="solar:calendar-mark-bold-duotone" />
            </span>
            <h3>Pregnancy Journey</h3>
          </div>
          <span>{tracking.week === null ? "Week not recorded" : `Week ${tracking.week} of 40`}</span>
        </header>

        <div className="mr-pregnancy-journey">
          {pregnancyTrackingMilestones.map((milestone) => {
            const milestoneStatus =
              tracking.week === null
                ? "upcoming"
                : tracking.week > milestone.week
                  ? "completed"
                  : tracking.week === milestone.week
                    ? "current"
                    : "upcoming";

            const hasReachedMilestone =
              milestoneStatus === "completed" || milestoneStatus === "current";

            return (
              <article
                className={[
                  "mr-pregnancy-milestone",
                  `is-${milestoneStatus}`,
                  hasReachedMilestone ? "has-reached" : "",
                ].filter(Boolean).join(" ")}
                key={milestone.week}
                aria-current={milestoneStatus === "current" ? "step" : undefined}
                aria-label={`Week ${milestone.week}: ${milestone.title}. ${
                  milestoneStatus === "completed"
                    ? "Completed"
                    : milestoneStatus === "current"
                      ? "Current milestone"
                      : "Upcoming"
                }`}
              >
                <span className="mr-pregnancy-milestone-image">
                  <img src={milestone.image} alt="" aria-hidden="true" />
                </span>

                <span
                  className="mr-pregnancy-milestone-status"
                  aria-hidden="true"
                >
                  {hasReachedMilestone ? (
                    <Icon icon="material-symbols:check-rounded" />
                  ) : (
                    milestone.week
                  )}
                </span>

                <div>
                  <small>Week {milestone.week}</small>
                  <strong>{milestone.title}</strong>
                  <p>{milestone.description}</p>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function MedicalRecordChecklist({ items }) {
  return (
    <ul className="mr-medical-checklist">
      {items.map((item, index) => (
        <li className={index > 2 && items.length > 5 ? "is-subitem" : ""} key={item}>
          <Icon icon={index > 2 && items.length > 5 ? "mdi:circle-small" : "material-symbols:check-rounded"} />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function MedicalRecordDataTable({ columns, rows, emptyText = "Not recorded" }) {
  if (!rows?.length) return <p>{emptyText}</p>;

  return (
    <div className="mr-medical-data-table-wrap">
      <table className="mr-medical-data-table">
        <thead>
          <tr>{columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.id || row[columns[0].key] || "row"}-${index}`}>
              {columns.map((column) => (
                <td key={column.key}>{displayRecordValue(row[column.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MedicalReviewBlock({ title, review, fields }) {
  if (!review) return null;

  const attachment = normalizeRecordAttachment(review.attachment);
  const hasContent = fields.some(([key]) => cleanRecordValue(review[key])) || attachment;
  if (!hasContent) return null;

  return (
    <section>
      <h4>{title}</h4>
      <dl className="mr-medical-review-list">
        {fields.map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{displayRecordValue(review[key])}</dd>
          </div>
        ))}
      </dl>
      {attachment ? <MedicalAttachmentControl attachment={attachment} /> : null}
    </section>
  );
}

function hasMedicalReviewContent(review, fields) {
  if (!review) return false;
  return fields.some(([key]) => cleanRecordValue(review[key])) || Boolean(review.attachment);
}

function MedicalRecordEntry({
  record,
  isPrimary = false,
  isFocused = false,
  isHighlighted = false,
  onSelect = null,
}) {
  return (
    <article
      className={`mr-medical-entry ${isPrimary ? "mr-medical-entry--primary" : "mr-medical-entry--secondary"}${isFocused ? " is-focused" : ""}${isHighlighted ? " is-recently-focused" : ""}`}
      data-record-id={record.id}
      onClick={() => onSelect?.(record.id)}
    >
      <aside className="mr-medical-entry-meta">
        <header>
          <span className="mr-medical-meta-icon">
            <Icon icon="mingcute:calendar-line" />
          </span>
          <div>
            <h3>{record.detailAppointmentDate}</h3>
            <p>{record.detailAppointmentDay}<span aria-hidden="true"> - </span>{record.detailAppointmentTime}</p>
          </div>
        </header>

        <dl>
          <div>
            <Icon className="mr-medical-detail-icon" icon="streamline-ultimate:doctor-home-visit-1" />
            <dt>Visit Type</dt>
            <dd>{record.visitType}</dd>
          </div>
          <div>
            <Icon className="mr-medical-detail-icon" icon="tabler:clock" />
            <dt>Gestational Age</dt>
            <dd>{record.gestationalAge}</dd>
          </div>
          <div>
            <Icon className="mr-medical-detail-icon" icon="healthicons:doctor-outline-24px" />
            <dt>Doctor</dt>
            <dd>{record.doctor}</dd>
          </div>
          <div>
            <Icon className="mr-medical-detail-icon" icon="solar:calendar-mark-linear" />
            <dt>Appointment</dt>
            <dd>{record.appointmentReference}</dd>
          </div>
          <div>
            <Icon className="mr-medical-detail-icon" icon="solar:document-add-linear" />
            <dt>Created</dt>
            <dd>{record.createdDate}</dd>
          </div>
          <div>
            <Icon className="mr-medical-detail-icon" icon="solar:refresh-circle-linear" />
            <dt>Last Updated</dt>
            <dd>{record.updatedDate}</dd>
          </div>
          <div>
            <Icon className="mr-medical-detail-icon" icon="solar:shield-check-linear" />
            <dt>Record Status</dt>
            <dd>{record.recordStatus}</dd>
          </div>
        </dl>
      </aside>

      <div className="mr-medical-entry-content">
        <div className="mr-medical-two-column mr-medical-section">
          <section>
            <h4>Chief Complaint</h4>
            <p>{record.complaint}</p>
            <h4>Symptoms / Concerns</h4>
            <p>{record.symptoms}</p>
          </section>
          <section>
            <h4>Assessment</h4>
            {record.assessment.length > 0 ? (
              <MedicalRecordChecklist items={record.assessment} />
            ) : (
              <p>No assessment details recorded.</p>
            )}
          </section>
        </div>

        {record.findings.length > 0 ? (
          <section className="mr-medical-section">
            <h4>Clinical Findings</h4>
            <div className="mr-medical-findings">
              {record.findings.map(([label, value, unit]) => (
                <div key={label}>
                  <small>{label}</small>
                  <strong>{value}</strong>
                  {unit ? <span>{unit}</span> : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {record.obstetric ? (
          <section className="mr-medical-section">
            <h4>Obstetric Information</h4>
            <dl className="mr-medical-obstetric">
              {record.obstetric.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        <div className="mr-medical-two-column mr-medical-section mr-medical-plan-row">
          <section>
            <h4>Diagnosis</h4>
            <p>{record.diagnosis}</p>
          </section>
          <section>
            <h4>Plan / Treatment</h4>
            {record.treatment.length > 0 ? (
              <MedicalRecordChecklist items={record.treatment} />
            ) : (
              <p>No treatment plan recorded.</p>
            )}
          </section>
        </div>

        {record.actionsTaken.length || record.pregnancyMilestones.length ? (
          <div className="mr-medical-two-column mr-medical-section">
            <section>
              <h4>Actions Taken</h4>
              {record.actionsTaken.length ? (
                <MedicalRecordChecklist
                  items={[
                    ...record.actionsTaken,
                    ...(record.otherActionDescription ? [`Other: ${record.otherActionDescription}`] : []),
                  ]}
                />
              ) : (
                <p>Not recorded</p>
              )}
            </section>
            <section>
              <h4>Pregnancy Journey Update</h4>
              {record.pregnancyMilestones.length ? (
                <MedicalRecordChecklist items={record.pregnancyMilestones} />
              ) : (
                <p>Not recorded</p>
              )}
            </section>
          </div>
        ) : null}

        {record.vaccinations.length ? (
          <section className="mr-medical-section">
            <h4>Vaccinations</h4>
            <MedicalRecordDataTable
              columns={[
                { key: "vaccineName", label: "Vaccine" },
                { key: "lotNumber", label: "Lot Number" },
                { key: "dateGiven", label: "Date Given" },
              ]}
              rows={record.vaccinations}
            />
          </section>
        ) : null}

        {hasMedicalReviewContent(record.laboratoryReview, [
          ["testType"],
          ["resultSummary"],
          ["interpretation"],
          ["reportAttached"],
        ]) ||
        hasMedicalReviewContent(record.ultrasoundReview, [
          ["visitDate"],
          ["findings"],
          ["reportAttached"],
        ]) ? (
          <div className="mr-medical-two-column mr-medical-section">
            <MedicalReviewBlock
              title="Laboratory Review"
              review={record.laboratoryReview}
              fields={[
                ["testType", "Test Type"],
                ["resultSummary", "Result Summary"],
                ["interpretation", "Interpretation"],
                ["reportAttached", "Report Attached"],
              ]}
            />
            <MedicalReviewBlock
              title="Ultrasound Review"
              review={record.ultrasoundReview}
              fields={[
                ["visitDate", "Date of Visit"],
                ["findings", "Findings"],
                ["reportAttached", "Report Attached"],
              ]}
            />
          </div>
        ) : null}

        {record.prescription?.medications?.length || record.prescription?.instructions ? (
          <section className="mr-medical-section">
            <h4>Prescription {record.prescription.reference || ""}</h4>
            {record.prescription.medications?.length ? (
              <MedicalRecordDataTable
                columns={[
                  { key: "medication", label: "Medication" },
                  { key: "dosage", label: "Dosage" },
                  { key: "frequency", label: "Frequency" },
                  { key: "duration", label: "Duration" },
                ]}
                rows={record.prescription.medications}
              />
            ) : null}
            {record.prescription.instructions ? <p>{record.prescription.instructions}</p> : null}
            {record.prescription.attachment ? (
              <a className="mr-medical-file-card" href={record.prescription.attachment.dataUrl || undefined} download={record.prescription.attachment.name}>
                <Icon icon="akar-icons:file" />
                <span>
                  <strong>{record.prescription.attachment.name}</strong>
                  <small>{[record.prescription.attachment.type, record.prescription.attachment.sizeLabel].filter(Boolean).join(" - ")}</small>
                </span>
              </a>
            ) : null}
          </section>
        ) : null}

        {record.prescriptions.length || record.diagnosticResults.length ? (
          <div className="mr-medical-two-column mr-medical-section">
            <section>
              <h4>Prescriptions</h4>
              {record.prescriptions.length ? (
                <MedicalRecordChecklist items={record.prescriptions} />
              ) : (
                <p>Not recorded</p>
              )}
            </section>
            <section>
              <h4>Diagnostic Results</h4>
              {record.diagnosticResults.length ? (
                <MedicalRecordChecklist items={record.diagnosticResults} />
              ) : (
                <p>Not recorded</p>
              )}
            </section>
          </div>
        ) : null}

        {record.attachment ? (
          <section className="mr-medical-attachments">
            <h4>Attachments (1)</h4>
            <a href={record.fileDataUrl || undefined} download={record.attachment}>
              <Icon icon="akar-icons:file" />
              <span>
                <strong>{record.attachment}</strong>
                <small>Medical attachment</small>
              </span>
              <Icon icon="material-symbols:download-rounded" />
            </a>
          </section>
        ) : null}
      </div>
    </article>
  );
}

function MedicalRecordsPanel({
  records,
  isLoading,
  message,
  focusedRecordId,
  onRetry,
  onSelectRecord,
}) {
  const [query, setQuery] = React.useState("");
  const [highlightedRecordId, setHighlightedRecordId] = React.useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredRecords = records.filter((record) =>
    [record.date, record.visitType, record.doctor, record.complaint, record.diagnosis]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery)
  );
  const selectedRecord =
    filteredRecords.find((record) => record.id === focusedRecordId) ||
    filteredRecords[0] ||
    null;

  React.useEffect(() => {
    if (!focusedRecordId) return;

    const highlightTimer = window.setTimeout(() => {
      setHighlightedRecordId(focusedRecordId);
    }, 0);
    const frame = window.requestAnimationFrame(() => {
      setQuery("");
      const target = document.querySelector(`[data-record-id="${focusedRecordId}"]`);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    const timer = window.setTimeout(() => {
      setHighlightedRecordId((current) =>
        current === focusedRecordId ? "" : current
      );
    }, 2400);

    return () => {
      window.clearTimeout(highlightTimer);
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [focusedRecordId]);

  return (
    <div className="mr-medical-records-panel">
      <label className="mr-medical-search">
        <Icon icon="solar:magnifer-linear" />
        <input
          type="search"
          placeholder="Search medical records..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      {message ? (
        <div className="mr-medical-load-message">
          <p>{message}</p>
          {typeof onRetry === "function" ? (
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="mr-medical-record-list">
        {isLoading ? (
          <div className="mr-medical-no-results">
            <Icon icon="eos-icons:loading" />
            <p>Loading medical records...</p>
          </div>
        ) : selectedRecord ? (
          <>
            {filteredRecords.length > 1 ? (
              <div className="mr-medical-record-selector" aria-label="Medical record visits">
                {filteredRecords.map((record) => (
                  <button
                    key={record.id}
                    type="button"
                    className={record.id === selectedRecord.id ? "active" : ""}
                    onClick={() => onSelectRecord?.(record.id)}
                  >
                    <strong>{record.date}</strong>
                    <span>{record.visitType}</span>
                  </button>
                ))}
              </div>
            ) : null}

            <MedicalRecordEntry
              record={selectedRecord}
              isPrimary
              isFocused={selectedRecord.id === focusedRecordId}
              isHighlighted={selectedRecord.id === highlightedRecordId}
              onSelect={onSelectRecord}
              key={selectedRecord.id}
            />
          </>
        ) : (
          <div className="mr-medical-no-results">
            <Icon icon="solar:document-text-linear" />
            <p>{normalizedQuery ? "No medical records match your search." : "No medical records found"}</p>
          </div>
        )}
      </div>

      <p className="mr-medical-record-count">
        Showing {filteredRecords.length} of {records.length} medical records
      </p>
    </div>
  );
}

export default function Doctor_Medical_Records({
  initialPatient = null,
  initialActiveTab = "Overview",
  focusedRecordId: initialFocusedRecordId = "",
  headerActions = null,
  onBackToPatients = null,
  onHeaderActionChange = null,
  onRecordSelect = null,
  doctorName = "Doctor",
}) {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = React.useState(initialActiveTab);
  const [shouldLoadAppointments, setShouldLoadAppointments] = React.useState(() =>
    appointmentMetadataTabs.has(initialActiveTab)
  );
  const [patient, setPatient] = React.useState(null);
  const [patientAvatarUrl, setPatientAvatarUrl] = React.useState("");
  const [patientLoadError, setPatientLoadError] = React.useState("");
  const [patientRelated, setPatientRelated] = React.useState({
    personal: null,
    obstetric: null,
    medicalHistory: null,
    initialAssessment: null,
  });
  const [medicalRecordRows, setMedicalRecordRows] = React.useState([]);
  const [medicalRecordsError, setMedicalRecordsError] = React.useState(null);
  const [loadedMedicalRecordsPatientId, setLoadedMedicalRecordsPatientId] = React.useState("");
  const [loadedPrenatalDetailsPatientId, setLoadedPrenatalDetailsPatientId] = React.useState("");
  const [isLoadingPrenatalDetails, setIsLoadingPrenatalDetails] = React.useState(false);
  const [prenatalDetailsError, setPrenatalDetailsError] = React.useState("");
  const [doctorProfilesById, setDoctorProfilesById] = React.useState(() => new Map());
  const [isLoadingPatient, setIsLoadingPatient] = React.useState(Boolean(initialPatient?.id));
  const [isLoadingRecords, setIsLoadingRecords] = React.useState(false);
  const [recordMessage, setRecordMessage] = React.useState("");
  const [isRecordFormOpen, setIsRecordFormOpen] = React.useState(false);
  const [isSavingRecord, setIsSavingRecord] = React.useState(false);
  const [recordForm, setRecordForm] = React.useState({
    title: "",
    type: "Electronic Medical Record",
    notes: "",
    assessment: "",
    diagnosis: "",
    treatment: "",
  });
  const [focusedRecordId, setFocusedRecordId] = React.useState(initialFocusedRecordId);
  const [stableEditRecordId, setStableEditRecordId] = React.useState(initialFocusedRecordId);
  const [isOpeningEditRecord, setIsOpeningEditRecord] = React.useState(false);
  const [focusedAppointmentId, setFocusedAppointmentId] = React.useState("");
  const pageRef = React.useRef(null);
  const onRecordSelectRef = React.useRef(onRecordSelect);
  const medicalRecordRequestRef = React.useRef(0);
  const patientRequestRef = React.useRef(0);
  const patientAvatarRequestRef = React.useRef(0);
  const prenatalRequestRef = React.useRef(0);
  const doctorProfileRequestRef = React.useRef(0);
  const doctorProfileCacheRef = React.useRef(new Map());
  const appointmentState = usePatientAppointments(patient?.id, {
    enabled: shouldLoadAppointments,
  });
  const initialPatientId = initialPatient?.id || "";
  const selectedInitialPatientRef = React.useRef(initialPatient);
  const doctorIds = React.useMemo(
    () =>
      Array.from(
        new Set(
          [
            ...medicalRecordRows.map(getMedicalRecordDoctorId),
            ...appointmentState.appointments.map((appointment) => appointment.doctor_id),
          ].filter(Boolean)
        )
      ).sort(),
    [appointmentState.appointments, medicalRecordRows]
  );
  React.useEffect(() => {
    const requestId = doctorProfileRequestRef.current + 1;
    doctorProfileRequestRef.current = requestId;

    if (!patient?.id || !doctorIds.length) {
      return undefined;
    }

    const unresolvedDoctorIds = doctorIds.filter(
      (doctorId) => !doctorProfileCacheRef.current.has(doctorId)
    );
    if (!unresolvedDoctorIds.length) {
      return undefined;
    }

    const loadDoctorNames = async () => {
      const nextProfiles = new Map(doctorProfileCacheRef.current);
      const { data: profiles, error: profileError } = await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", unresolvedDoctorIds);

      if (doctorProfileRequestRef.current !== requestId) return;

      if (profileError) {
        console.warn("Unable to resolve Patient Record Doctor profiles:", profileError);
      } else {
        (profiles || []).forEach((profile) => {
          const name = cleanRecordValue(profile.full_name);
          if (name) nextProfiles.set(profile.id, name);
        });
      }

      const personalLookupIds = unresolvedDoctorIds.filter(
        (doctorId) => !nextProfiles.has(doctorId)
      );
      if (personalLookupIds.length) {
        const { data: personalRows, error: personalError } = await supabase
          .from("doctor_personal_information")
          .select("auth_user_id, full_name")
          .in("auth_user_id", personalLookupIds);

        if (doctorProfileRequestRef.current !== requestId) return;

        if (personalError) {
          console.warn("Unable to resolve fallback Doctor names:", personalError);
        } else {
          (personalRows || []).forEach((profile) => {
            const name = cleanRecordValue(profile.full_name);
            if (name) nextProfiles.set(profile.auth_user_id, name);
          });
        }
      }

      if (doctorProfileRequestRef.current === requestId) {
        unresolvedDoctorIds.forEach((doctorId) => {
          if (!nextProfiles.has(doctorId)) nextProfiles.set(doctorId, "");
        });
        doctorProfileCacheRef.current = nextProfiles;
        setDoctorProfilesById(nextProfiles);
      }
    };

    loadDoctorNames();

    return () => {
      doctorProfileRequestRef.current += 1;
    };
  }, [doctorIds, patient?.id]);

  const completedMedicalRecordRows = React.useMemo(
    () => medicalRecordRows.filter(isCompletedClinicalVisitRecord),
    [medicalRecordRows]
  );
  const schedulesById = React.useMemo(
    () => new Map(appointmentState.appointments.map((appointment) => [appointment.id, appointment])),
    [appointmentState.appointments]
  );
  const medicalRecords = React.useMemo(
    () =>
      completedMedicalRecordRows
        .map((row) => mapSupabaseMedicalRecord(row, patient, doctorProfilesById, schedulesById))
        .sort((first, second) => second.sortTime - first.sortTime),
    [completedMedicalRecordRows, doctorProfilesById, patient, schedulesById]
  );
  const currentPregnancyWeek = React.useMemo(
    () => getPregnancyWeek(patient, patientRelated.obstetric || {}, medicalRecords),
    [medicalRecords, patient, patientRelated.obstetric]
  );
  const resolvedAppointments = React.useMemo(
    () =>
      appointmentState.appointments.map((appointment) => ({
        ...appointment,
        resolved_doctor_name:
          cleanRecordValue(appointment.doctor_name) ||
          doctorProfilesById.get(appointment.doctor_id) ||
          "",
      })),
    [appointmentState.appointments, doctorProfilesById]
  );
  const resolvedAppointmentState = React.useMemo(
    () => ({ ...appointmentState, appointments: resolvedAppointments }),
    [appointmentState, resolvedAppointments]
  );
  const recordsRequired = medicalRecordTabs.has(activeTab);
  const visibleRecordsLoading = Boolean(patient?.id && recordsRequired) &&
    loadedMedicalRecordsPatientId !== patient.id;
  const visiblePrenatalDetailsLoading = Boolean(patient?.id && activeTab === "Prenatal History") &&
    (isLoadingPrenatalDetails || loadedPrenatalDetailsPatientId !== patient.id);
  const overviewState = usePatientMedicalOverview({
    patientId: patient?.id,
    records: completedMedicalRecordRows,
    schedules: resolvedAppointments,
    doctorProfilesById,
    pregnancyWeek: currentPregnancyWeek,
    recordsLoading: visibleRecordsLoading,
    schedulesLoading: appointmentState.loading,
    recordsError: medicalRecordsError,
    schedulesError: appointmentState.error,
  });

  React.useEffect(() => {
    selectedInitialPatientRef.current = initialPatient;
  }, [initialPatient, initialPatientId]);

  React.useEffect(() => {
    onRecordSelectRef.current = onRecordSelect;
  }, [onRecordSelect]);

  const loadMedicalRecords = React.useCallback(async (selectedPatient) => {
    const requestId = medicalRecordRequestRef.current + 1;
    medicalRecordRequestRef.current = requestId;

    if (!selectedPatient?.id) {
      setMedicalRecordRows([]);
      setMedicalRecordsError(null);
      setLoadedMedicalRecordsPatientId("");
      setIsLoadingRecords(false);
      return [];
    }

    setIsLoadingRecords(true);
    setRecordMessage("");
    setMedicalRecordsError(null);

    const { data, error } = await supabase
      .from("medical_records")
      .select(medicalRecordColumns)
      .eq("patient_id", selectedPatient.id)
      .order("uploaded_at", { ascending: false });

    if (medicalRecordRequestRef.current !== requestId) {
      return;
    }

    if (error) {
      setMedicalRecordsError(error);
      setLoadedMedicalRecordsPatientId(selectedPatient.id);
      setRecordMessage(`Unable to load medical records: ${error.message}`);
      setIsLoadingRecords(false);
      return [];
    }

    const nextRows = data ?? [];
    const completedRows = nextRows.filter(isCompletedClinicalVisitRecord);
    setMedicalRecordRows(nextRows);
    setLoadedMedicalRecordsPatientId(selectedPatient.id);
    const requestedRecordExists =
      initialFocusedRecordId &&
      completedRows.some((record) => record.id === initialFocusedRecordId && record.schedule_id);
    const currentRecordExists =
      focusedRecordId &&
      completedRows.some((record) => record.id === focusedRecordId && record.schedule_id);
    const nextFocusedRecordId = requestedRecordExists
      ? initialFocusedRecordId
      : currentRecordExists
        ? focusedRecordId
        : completedRows.find((record) => record.schedule_id)?.id || "";
    setFocusedRecordId(nextFocusedRecordId);
    setStableEditRecordId((current) => {
      const currentStillExists =
        current && completedRows.some((record) => record.id === current && record.schedule_id);
      if (requestedRecordExists) return initialFocusedRecordId;
      if (currentStillExists) return current;
      return nextFocusedRecordId || completedRows.find((record) => record.schedule_id)?.id || "";
    });
    if ((!initialFocusedRecordId || !requestedRecordExists) && nextFocusedRecordId) {
      onRecordSelectRef.current?.(nextFocusedRecordId);
    }
    setIsLoadingRecords(false);
    return nextRows;
  }, [focusedRecordId, initialFocusedRecordId]);

  const loadPatientAvatar = React.useCallback(async (selectedPatient) => {
    const requestId = patientAvatarRequestRef.current + 1;
    patientAvatarRequestRef.current = requestId;

    if (!selectedPatient?.id) {
      setPatientAvatarUrl("");
      return;
    }

    const { data, error } = await supabase.rpc("get_patient_avatar_url", {
      p_patient_id: selectedPatient.id,
    });

    if (patientAvatarRequestRef.current !== requestId) return;

    if (error) {
      console.warn("Unable to load Patient profile picture:", error);
      setPatientAvatarUrl("");
      return;
    }

    setPatientAvatarUrl(cleanRecordValue(data));
  }, []);

  React.useEffect(() => {
    const loadPatient = async () => {
      const requestId = patientRequestRef.current + 1;
      patientRequestRef.current = requestId;
      const selectedInitialPatient = selectedInitialPatientRef.current;

      if (!selectedInitialPatient?.id) {
        setPatient(null);
        setPatientAvatarUrl("");
        setPatientLoadError("No patient record was selected.");
        setMedicalRecordRows([]);
        setLoadedMedicalRecordsPatientId("");
        setIsLoadingPatient(false);
        return;
      }

      setIsLoadingPatient(true);
      setPatient(null);
      setPatientAvatarUrl("");
      setPatientLoadError("");
      setMedicalRecordRows([]);
      setMedicalRecordsError(null);
      setLoadedMedicalRecordsPatientId("");
      setLoadedPrenatalDetailsPatientId("");
      setPrenatalDetailsError("");
      doctorProfileCacheRef.current = new Map();
      setDoctorProfilesById(new Map());
      setPatientRelated({
        personal: null,
        obstetric: null,
        medicalHistory: null,
        initialAssessment: null,
      });
      setRecordMessage("");
      setFocusedRecordId(initialFocusedRecordId || "");
      setStableEditRecordId(initialFocusedRecordId || "");
      setIsOpeningEditRecord(false);
      setFocusedAppointmentId("");
      const { data, error } = await supabase
        .rpc("get_doctor_patient_directory")
        .select(patientSelectColumns)
        .eq("id", selectedInitialPatient.id)
        .maybeSingle();

      if (patientRequestRef.current !== requestId) {
        return;
      }

      if (error || !data) {
        setPatient(null);
        setPatientAvatarUrl("");
        setIsLoadingPatient(false);
        setPatientLoadError(
          error
            ? "Unable to verify access to this patient record. Please return to Patients and try again."
            : "This patient record was not found or is not available to your Doctor account."
        );
        return;
      }

      const selectedPatient = data;
      setPatient(selectedPatient);
      setIsLoadingPatient(false);
      void loadPatientAvatar(selectedPatient);

      const [personalResult, obstetricResult] =
        await Promise.all([
          supabase
            .from("patient_personal_information")
            .select("*")
            .eq("patient_record_id", selectedPatient.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabase
            .from("patient_obstetric_history")
            .select("*")
            .eq("patient_id", selectedPatient.id)
            .limit(1)
            .maybeSingle(),
        ]);

      if (patientRequestRef.current !== requestId) {
        return;
      }

      [personalResult, obstetricResult]
        .filter((result) => result.error)
        .forEach((result) => {
          console.warn("Unable to load optional Patient detail row:", result.error);
        });

      setPatientRelated((current) => ({
        ...current,
        personal: personalResult.error ? null : personalResult.data || null,
        obstetric: obstetricResult.error ? null : obstetricResult.data || null,
      }));
    };

    loadPatient();

    return () => {
      patientRequestRef.current += 1;
    };
  }, [initialFocusedRecordId, initialPatientId, loadPatientAvatar]);

  React.useEffect(() => {
    if (!patient?.id) return undefined;

    const refreshAvatar = () => {
      if (document.visibilityState === "visible") {
        void loadPatientAvatar(patient);
      }
    };

    window.addEventListener("focus", refreshAvatar);
    document.addEventListener("visibilitychange", refreshAvatar);

    return () => {
      window.removeEventListener("focus", refreshAvatar);
      document.removeEventListener("visibilitychange", refreshAvatar);
    };
  }, [loadPatientAvatar, patient]);

  React.useEffect(() => {
    if (
      !patient?.id ||
      isLoadingRecords ||
      loadedMedicalRecordsPatientId === patient.id
    ) {
      return undefined;
    }

    const timer = window.setTimeout(() => loadMedicalRecords(patient), 0);
    return () => window.clearTimeout(timer);
  }, [
    isLoadingRecords,
    loadMedicalRecords,
    loadedMedicalRecordsPatientId,
    patient,
  ]);

  React.useEffect(() => {
    if (!patient?.id || loadedMedicalRecordsPatientId !== patient.id) {
      return undefined;
    }

    const channel = supabase
      .channel(`doctor-patient-medical-records-${patient.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "medical_records",
          filter: `patient_id=eq.${patient.id}`,
        },
        () => loadMedicalRecords(patient)
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadMedicalRecords, loadedMedicalRecordsPatientId, patient]);

  const loadPrenatalDetails = React.useCallback(async (selectedPatient) => {
    const requestId = prenatalRequestRef.current + 1;
    prenatalRequestRef.current = requestId;

    if (!selectedPatient?.id) return;

    setIsLoadingPrenatalDetails(true);
    setPrenatalDetailsError("");
    const [medicalHistoryResult, initialAssessmentResult] = await Promise.all([
      supabase
        .from("patient_medical_history")
        .select("*")
        .eq("patient_id", selectedPatient.id)
        .limit(1)
        .maybeSingle(),
      supabase
        .from("patient_initial_assessment")
        .select("*")
        .eq("patient_id", selectedPatient.id)
        .limit(1)
        .maybeSingle(),
    ]);

    if (prenatalRequestRef.current !== requestId) return;

    [medicalHistoryResult, initialAssessmentResult]
      .filter((result) => result.error)
      .forEach((result) => {
        console.warn("Unable to load optional prenatal detail row:", result.error);
      });

    setPatientRelated((current) => ({
      ...current,
      medicalHistory: medicalHistoryResult.error ? null : medicalHistoryResult.data || null,
      initialAssessment: initialAssessmentResult.error ? null : initialAssessmentResult.data || null,
    }));
    setPrenatalDetailsError(
      medicalHistoryResult.error || initialAssessmentResult.error
        ? "Some prenatal history details could not be loaded."
        : ""
    );
    setLoadedPrenatalDetailsPatientId(selectedPatient.id);
    setIsLoadingPrenatalDetails(false);
  }, []);

  React.useEffect(() => {
    if (
      activeTab !== "Prenatal History" ||
      !patient?.id ||
      isLoadingPrenatalDetails ||
      loadedPrenatalDetailsPatientId === patient.id
    ) {
      return undefined;
    }

    const timer = window.setTimeout(() => loadPrenatalDetails(patient), 0);
    return () => window.clearTimeout(timer);
  }, [
    activeTab,
    isLoadingPrenatalDetails,
    loadPrenatalDetails,
    loadedPrenatalDetailsPatientId,
    patient,
  ]);

  const openMedicalRecord = React.useCallback((recordId) => {
    if (!recordId) return;
    setFocusedRecordId(recordId);
    setStableEditRecordId(recordId);
    onRecordSelectRef.current?.(recordId);
    setShouldLoadAppointments(true);
    setActiveTab("Medical Record");
  }, []);

  const openAppointment = React.useCallback((appointmentId) => {
    if (appointmentId) {
      setFocusedAppointmentId(appointmentId);
    }
    setShouldLoadAppointments(true);
    setActiveTab("Appointments");
  }, []);

  const handleTabChange = React.useCallback((tab) => {
    if (appointmentMetadataTabs.has(tab)) {
      setShouldLoadAppointments(true);
    }
    setActiveTab(tab);

    const tabParam = medicalRecordTabParamByLabel[tab];
    if (!tabParam || typeof window === "undefined") {
      return;
    }

    const params = new URLSearchParams(window.location.search || "");
    if (!params.get("patientId")) {
      return;
    }

    params.set("tab", tabParam);
    navigate(
      {
        pathname: "/doctor",
        search: `?${params.toString()}`,
      },
      { replace: true }
    );
  }, [navigate]);

  const handleRecordFormChange = (event) => {
    const { name, value } = event.target;
    setRecordForm((current) => ({ ...current, [name]: value }));
  };

  const saveMedicalRecord = async (event) => {
    event.preventDefault();

    if (!patient?.id || !recordForm.title.trim()) {
      setRecordMessage("Select a patient and enter a record title.");
      return;
    }

    setIsSavingRecord(true);
    setRecordMessage("");

    let authenticatedDoctor;

    try {
      authenticatedDoctor = await loadAuthenticatedDoctor();
    } catch (identityError) {
      setIsSavingRecord(false);
      setRecordMessage(
        identityError?.message || "Unable to identify the record author."
      );
      return;
    }

    const uploadedBy = authenticatedDoctor.doctorDisplayName;

    const payload = {
      patient_id: patient.id,
      schedule_id: null,
      doctor_id: authenticatedDoctor.authUser.id,
      patient_name: patient.full_name,
      type: recordForm.type,
      title: recordForm.title.trim(),
      notes: recordForm.notes.trim() || null,
      uploaded_by: uploadedBy,
      form_data: {
        visitType: recordForm.type,
        gestationalAge: patient.gestational_age || "-",
        doctor: uploadedBy,
        doctorId: authenticatedDoctor.authUser.id,
        complaint: recordForm.notes.trim(),
        assessment: normalizeRecordList(recordForm.assessment),
        diagnosis: recordForm.diagnosis.trim(),
        treatment: normalizeRecordList(recordForm.treatment),
      },
    };

    const { error } = await supabase.from("medical_records").insert(payload);
    setIsSavingRecord(false);

    if (error) {
      setRecordMessage(`Unable to save to Supabase: ${error.message}`);
      return;
    }

    setRecordForm({
      title: "",
      type: "Electronic Medical Record",
      notes: "",
      assessment: "",
      diagnosis: "",
      treatment: "",
    });
    setIsRecordFormOpen(false);
    setActiveTab("Medical Record");
    await loadMedicalRecords(patient);
    setRecordMessage("Medical record saved to Supabase.");
  };

  const personal = patientRelated.personal || {};
  const obstetric = patientRelated.obstetric || {};
  const currentPregnancyEdd = obstetric.expected_delivery_date || patient?.expected_delivery_date;
  const headerPregnancyWeekLabel = currentPregnancyWeek === null
    ? currentPregnancyEdd
      ? "Dating needs review"
      : EMPTY_PATIENT_VALUE
    : `${currentPregnancyWeek} Weeks`;
  const gravida = parseNumericValue(obstetric.gravida);
  const para = parseNumericValue(obstetric.para);
  const resolvedRiskLevel =
    cleanRecordValue(patient?.risk_level) ||
    getLatestRecordValue(medicalRecords, ["riskLevel", "Risk Level"]);
  const pregnancyNumber =
    gravida !== null || para !== null
      ? `G${gravida ?? 0}P${para ?? 0}`
      : EMPTY_PATIENT_VALUE;
  const patientDetailsLeft = [
    { icon: "mingcute:calendar-line", label: "Birthdate", value: formatPatientDate(personal.birthdate || patient?.date_of_birth, EMPTY_PATIENT_VALUE) },
    { icon: "mi:call", label: "Contact Number", value: displayPatientValue(personal.contact_number || patient?.contact_number) },
    { icon: "ic:outline-email", label: "Email", value: displayPatientValue(personal.email || patient?.email) },
  ];

  const patientDetailsRight = [
    { icon: "material-symbols:home-outline-rounded", label: "Address", value: displayPatientValue(personal.address || patient?.address) },
    { icon: "mdi:blood-outline", label: "Blood Type", value: displayPatientValue(personal.blood_type || patient?.blood_type) },
    { icon: "ci:heart-01", label: "Civil Status", value: displayPatientValue(personal.civil_status) },
  ];

  const handleBackToPatients = () => {
    pageRef.current?.scrollTo({ top: 0, behavior: "smooth" });

    window.setTimeout(() => {
      if (typeof onBackToPatients === "function") {
        onBackToPatients();
        return;
      }

      window.history.back();
    }, 120);
  };
  const isEditablePatientRecord = (record) =>
    Boolean(record?.scheduleId && record.patientId === patient?.id);
  const routeRecordForAction = initialFocusedRecordId
    ? medicalRecords.find(
        (record) => record.id === initialFocusedRecordId && isEditablePatientRecord(record)
      ) || null
    : null;
  const selectedRecordForAction = focusedRecordId
    ? medicalRecords.find(
        (record) => record.id === focusedRecordId && isEditablePatientRecord(record)
      ) || null
    : null;
  const stableRecordForAction = stableEditRecordId
    ? medicalRecords.find(
        (record) => record.id === stableEditRecordId && isEditablePatientRecord(record)
      ) || null
    : null;
  const currentRecordForAction =
    routeRecordForAction ||
    selectedRecordForAction ||
    stableRecordForAction ||
    medicalRecords.find(isEditablePatientRecord) ||
    null;
  const editableRecordForAction = currentRecordForAction?.scheduleId ? currentRecordForAction : null;
  const isResolvingEditRecord =
    isLoadingPatient ||
    isLoadingRecords ||
    loadedMedicalRecordsPatientId !== patient?.id ||
    !editableRecordForAction?.scheduleId;
  const handleEditLinkedRecord = React.useCallback(() => {
    if (
      isResolvingEditRecord ||
      isOpeningEditRecord ||
      !editableRecordForAction?.scheduleId ||
      editableRecordForAction.patientId !== patient?.id
    ) {
      return;
    }

    setIsOpeningEditRecord(true);
    const routeSegment = getAppointmentVisitRouteSegment(editableRecordForAction);
    const params = new URLSearchParams({
      source: "medical-record",
      patientId: patient.id,
      recordId: editableRecordForAction.id,
    });

    navigate(
      `/doctor/appointments/${editableRecordForAction.scheduleId}/${routeSegment}?${params.toString()}`
    );
  }, [editableRecordForAction, isOpeningEditRecord, isResolvingEditRecord, navigate, patient?.id]);

  React.useEffect(() => {
    if (typeof onHeaderActionChange !== "function") {
      return undefined;
    }

    onHeaderActionChange({
      label: "Edit Record",
      disabled: isResolvingEditRecord || isOpeningEditRecord,
      onClick: handleEditLinkedRecord,
    });
    return undefined;
  }, [handleEditLinkedRecord, isOpeningEditRecord, isResolvingEditRecord, onHeaderActionChange]);

  return (
    <main className="medical-records-page medical-record-workspace" ref={pageRef}>
      <div className="medical-records-content medical-record-ui-content">
        <header className="doctor-patient-header-rail medical-record-ui-header">
          <div className="doctor-patient-title medical-record-ui-title-block">
            <div className="mr-top-row">
              <button
                className="mr-back-btn"
                type="button"
                onClick={handleBackToPatients}
              >
                <Icon icon="ion:arrow-back-outline" />
                Back to patients
              </button>
            </div>

            <div className="mr-page-header">
              <h1>Medical Record</h1>
              <p>View and manage patient medical information</p>
            </div>
          </div>

          {headerActions ? (
            <div className="doctor-patient-header-action-slot medical-record-ui-actions">
              {headerActions}
              <SendPatientNotificationAction
                patientId={patient?.id || ""}
                patientName={patient?.full_name || "Patient"}
                medicalRecordId={currentRecordForAction?.id || null}
                defaultType="medical_record_available"
                className="mr-header-notification-action"
                outline
              />
            </div>
          ) : null}
        </header>

        <div className="doctor-patient-content-rail">
          {patientLoadError ? (
            <section className="mr-record-panel">
              <div className="mr-empty-tab" role="alert">
                {patientLoadError}
              </div>
            </section>
          ) : (
            <>
          <section className="mr-patient-card medical-record-ui-patient-card">
          <div className="mr-patient-main medical-record-ui-summary">
            <div className="mr-avatar">
              {patientAvatarUrl ? (
                <img
                  src={patientAvatarUrl}
                  alt={`${patient?.full_name || "Patient"} profile`}
                  referrerPolicy="no-referrer"
                  onError={() => setPatientAvatarUrl("")}
                  style={{
                    width: "100%",
                    height: "100%",
                    display: "block",
                    objectFit: "cover",
                    borderRadius: "inherit",
                  }}
                />
              ) : (
                getPatientInitials(patient?.full_name)
              )}
            </div>

            <div className="mr-patient-info">
              <div className="mr-name-row">
                <h2>{isLoadingPatient ? "Loading patient..." : patient?.full_name || "Patient Record"}</h2>
                <span className="mr-status">{displayPatientValue(patient?.status)}</span>
              </div>

              <p className="mr-patient-id">Patient ID: {formatPatientId(patient)}</p>

              <div className="mr-details-grid">
                <div className="mr-details-column">
                  {patientDetailsLeft.map((item) => (
                    <InfoRow key={item.label} {...item} />
                  ))}
                </div>

                <div className="mr-divider" />

                <div className="mr-details-column">
                  {patientDetailsRight.map((item) => (
                    <InfoRow key={item.label} {...item} />
                  ))}
                </div>
              </div>
            </div>
          </div>

          <aside className="mr-pregnancy-box medical-record-ui-pregnancy">
            <h3>Current Pregnancy</h3>

            <div className="mr-pregnancy-list">
              <div>
                <strong>Pregnancy number</strong>
                <span>{pregnancyNumber}</span>
              </div>

              <div>
                <strong>Gestational Age</strong>
                <span>{headerPregnancyWeekLabel}</span>
              </div>

              <div>
                <strong>Expected Delivery Date</strong>
                <span>{formatPatientDate(obstetric.expected_delivery_date || patient?.expected_delivery_date, EMPTY_PATIENT_VALUE)}</span>
              </div>

              <div>
                <strong>Risk Level</strong>
                <span className={`mr-risk mr-risk--${getRiskTone(resolvedRiskLevel)}`}>
                  {formatRiskBadge(resolvedRiskLevel)}
                </span>
              </div>
            </div>
          </aside>
          </section>

          <section className={`mr-record-panel medical-record-ui-panel${activeTab === "Medical Record" ? " mr-record-panel--medical" : ""}`}>
          <nav className="mr-tabs medical-record-ui-tabs" aria-label="Patient medical record sections">
            {tabs.map((tab) => (
              <button
                key={tab}
                type="button"
                className={`mr-tab ${activeTab === tab ? "active" : ""}`}
                aria-current={activeTab === tab ? "page" : undefined}
                onClick={() => handleTabChange(tab)}
              >
                {tab}
              </button>
            ))}
          </nav>

          {activeTab === "Overview" && (
            <OverviewPanel
              overview={overviewState}
              onOpenRecord={openMedicalRecord}
              onOpenAppointment={openAppointment}
            />
          )}

          {activeTab === "Prenatal History" && (
            visibleRecordsLoading || visiblePrenatalDetailsLoading ? (
              <div className="mr-empty-tab">Loading prenatal history...</div>
            ) : (
              <>
                {prenatalDetailsError ? (
                  <p className="mr-record-form-message">{prenatalDetailsError}</p>
                ) : null}
                <PrenatalHistoryPanel
                  patient={patient}
                  patientRelated={patientRelated}
                  records={medicalRecords}
                />
              </>
            )
          )}

          {activeTab === "Appointments" && (
            <AppointmentsPanel
              patient={patient}
              appointmentState={resolvedAppointmentState}
              focusedAppointmentId={focusedAppointmentId}
            />
          )}

          {activeTab === "Diagnostic Results" && (
            visibleRecordsLoading ? (
              <div className="mr-empty-tab">Loading diagnostic results...</div>
            ) : medicalRecordsError ? (
              <div className="mr-empty-tab">{recordMessage}</div>
            ) : (
              <DiagnosticResultsPanel records={medicalRecords} />
            )
          )}

          {activeTab === "Prescriptions" && (
            visibleRecordsLoading ? (
              <div className="mr-empty-tab">Loading prescriptions...</div>
            ) : medicalRecordsError ? (
              <div className="mr-empty-tab">{recordMessage}</div>
            ) : (
              <PrescriptionsPanel records={medicalRecords} />
            )
          )}

          {activeTab === "Medication Adherence" && (
            <MedicationAdherencePanel patient={patient} doctorName={doctorName} />
          )}

          {activeTab === "Pregnancy Tracking" && (
            visibleRecordsLoading ? (
              <div className="mr-empty-tab">Loading pregnancy tracking...</div>
            ) : (
              <PregnancyTrackingPanel
                patient={patient}
                patientRelated={patientRelated}
                records={medicalRecords}
                pregnancyWeek={currentPregnancyWeek}
              />
            )
          )}

          {activeTab === "Medical Record" && (
            <MedicalRecordsPanel
              records={medicalRecords}
              isLoading={visibleRecordsLoading}
              message={recordMessage}
              focusedRecordId={focusedRecordId}
              onRetry={() => loadMedicalRecords(patient)}
              onSelectRecord={(recordId) => {
                setFocusedRecordId(recordId);
                setStableEditRecordId(recordId);
                onRecordSelectRef.current?.(recordId);
              }}
            />
          )}

          {activeTab !== "Overview" && activeTab !== "Prenatal History" && activeTab !== "Appointments" && activeTab !== "Diagnostic Results" && activeTab !== "Prescriptions" && activeTab !== "Medication Adherence" && activeTab !== "Pregnancy Tracking" && activeTab !== "Medical Record" && (
            <div className="mr-empty-tab">
              No records available for {activeTab}.
            </div>
          )}
          </section>
            </>
          )}
        </div>
      </div>

      {isRecordFormOpen ? (
        <div className="mr-record-modal" role="dialog" aria-modal="true" aria-labelledby="mr-record-form-title">
          <form className="mr-record-form" onSubmit={saveMedicalRecord}>
            <header>
              <div>
                <h2 id="mr-record-form-title">Add Medical Record</h2>
                <p>Save a medical entry for {patient?.full_name || "this patient"} in Supabase.</p>
              </div>
              <button type="button" aria-label="Close" onClick={() => setIsRecordFormOpen(false)}>
                <Icon icon="material-symbols:close-rounded" />
              </button>
            </header>

            <div className="mr-record-form-grid">
              <label>
                Record Title
                <input
                  name="title"
                  type="text"
                  required
                  value={recordForm.title}
                  onChange={handleRecordFormChange}
                  placeholder="e.g. Prenatal consultation"
                />
              </label>

              <label>
                Record Type
                <select name="type" value={recordForm.type} onChange={handleRecordFormChange}>
                  <option>Electronic Medical Record</option>
                  <option>Prenatal Check-up</option>
                  <option>Laboratory Result</option>
                  <option>Ultrasound Findings</option>
                  <option>Prescription</option>
                </select>
              </label>

              <label className="mr-record-form-wide">
                Chief Complaint / Notes
                <textarea name="notes" value={recordForm.notes} onChange={handleRecordFormChange} />
              </label>

              <label>
                Assessment
                <textarea
                  name="assessment"
                  value={recordForm.assessment}
                  onChange={handleRecordFormChange}
                  placeholder="One item per line"
                />
              </label>

              <label>
                Plan / Treatment
                <textarea
                  name="treatment"
                  value={recordForm.treatment}
                  onChange={handleRecordFormChange}
                  placeholder="One item per line"
                />
              </label>

              <label className="mr-record-form-wide">
                Diagnosis
                <input name="diagnosis" type="text" value={recordForm.diagnosis} onChange={handleRecordFormChange} />
              </label>
            </div>

            {recordMessage ? <p className="mr-record-form-message">{recordMessage}</p> : null}

            <div className="mr-record-form-actions">
              <button type="submit" disabled={isSavingRecord}>
                {isSavingRecord ? "Saving..." : "Save to Supabase"}
              </button>
              <button type="button" onClick={() => setIsRecordFormOpen(false)}>Cancel</button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}
