import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, FileText, Pencil, Plus, Trash2, X } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import {
  formatAppointmentDate,
  formatAppointmentTime,
  getManilaDateKey,
  getManilaTimeKey,
} from "../../lib/appointmentDate";
import {
  buildCanonicalClinicalVisitFormData,
  isCompletedClinicalVisitRecord,
  normalizeClinicalVisitFormData,
  normalizeRiskLevel,
} from "../../lib/clinicalVisitData";
import { calculateCurrentPregnancyWeekFromEdd } from "../../lib/pregnancyTracking";
import "../../styles/appointment-visit-form.css";

const scheduleColumns =
  "id, maternal_appointment_id, patient_id, doctor_id, patient_name, doctor_name, title, start_time, end_time, status";
const patientColumns =
  "id, patient_id, full_name, age, contact_number, address, gestational_age, expected_delivery_date, risk_level";
const recordColumns =
  "id, patient_id, schedule_id, doctor_id, patient_name, type, title, notes, form_data, uploaded_at, uploaded_by";
const MEDICAL_RECORDS_BUCKET = "medical-records";
const MAX_REPORT_FILE_SIZE = 10 * 1024 * 1024;
const DATABASE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPORT_ATTACHMENT_CATEGORIES = new Set(["laboratory", "ultrasound"]);

const emptyForm = {
  gestationalAge: "",
  expectedDeliveryDate: "",
  pregnancyType: "",
  riskLevel: "",
  chiefComplaint: "",
  bloodPressure: "",
  temperature: "",
  respiratoryRate: "",
  weight: "",
  height: "",
  oxygenSaturation: "",
  fundalHeight: "",
  fetalHeartRate: "",
  estimatedFetalWeight: "",
  fetalMovement: "",
  babyPosition: "",
  additionalFindings: "",
  lifestyleAssessment: "",
  smokingStatus: "",
  drugUse: "",
  physicalActivity: "",
  alcoholIntake: "",
  diet: "",
  vaccinationStatus: "",
  vaccinations: [],
  laboratoryReview: "",
  laboratoryTestType: "",
  laboratoryResultSummary: "",
  laboratoryInterpretation: "",
  laboratoryReportAttached: "",
  laboratoryAttachment: null,
  ultrasoundReview: "",
  ultrasoundVisitDate: "",
  ultrasoundFindings: "",
  ultrasoundReportAttached: "",
  ultrasoundAttachment: null,
  assessment: "",
  diagnosis: "",
  actionsTaken: "",
  actionsOtherDetails: "",
  actionSelections: [],
  pregnancyJourneyUpdate: "",
  journeyMilestones: [],
  prescription: "",
  medications: [],
  prescriptionInstructions: "",
  treatmentPlan: "",
};

const actionOptions = [
  "Prenatal Counseling",
  "Medication Prescribed",
  "Laboratory Result Reviewed",
  "Laboratory Test Request",
  "Ultrasound Requested",
  "Vaccination Administered",
  "Referral Made",
  "Other",
];

const journeyOptions = [
  "Pregnancy Confirmed",
  "Baby's Heartbeat Detected",
  "First Trimester Completed",
  "First Baby Movement Felt",
  "Anatomy Development Completed",
  "Entered Third Trimester",
  "Full-Term Pregnancy",
  "Delivery Completed",
];

function getErrorMessage(error, fallback) {
  return [error?.message || fallback, error?.code ? `Code: ${error.code}.` : ""]
    .filter(Boolean)
    .join(" ");
}

function logVisitError(context, error) {
  if (!import.meta.env.DEV || !error) return;
  console.error(`[Appointment Visit Form] ${context}:`, {
    code: error.code || null,
    message: error.message || "Unknown Supabase error",
    details: error.details || null,
    hint: error.hint || null,
  });
}

function validateReportFile(file, label) {
  if (!file) return "";
  if (file.type !== "application/pdf" || !/\.pdf$/i.test(file.name || "")) {
    return `${label} must be a PDF file.`;
  }
  if (file.size > MAX_REPORT_FILE_SIZE) {
    return `${label} must be 10 MB or smaller.`;
  }
  return "";
}

function hasStoredAttachment(attachment) {
  return Boolean(
    attachment &&
      typeof attachment === "object" &&
      (String(attachment.path || "").trim() || String(attachment.dataUrl || "").trim())
  );
}

function sanitizeStorageFilename(filename) {
  const cleanName = String(filename || "report.pdf")
    .split(/[\\/]/)
    .pop()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  const stem = cleanName.replace(/\.pdf$/i, "").slice(0, 100) || "report";
  const uniqueSuffix = globalThis.crypto?.randomUUID?.().slice(0, 8) || Date.now().toString(36);
  return `${stem}-${uniqueSuffix}.pdf`;
}

async function uploadReportAttachment({ file, patientId, scheduleId, category }) {
  const label = category === "laboratory" ? "Laboratory report" : "Ultrasound report";
  const fileError = validateReportFile(file, label);
  if (fileError) throw new Error(fileError);
  const patientDatabaseId = String(patientId || "").trim();
  const scheduleDatabaseId = String(scheduleId || "").trim();

  if (
    !DATABASE_UUID_PATTERN.test(patientDatabaseId) ||
    !DATABASE_UUID_PATTERN.test(scheduleDatabaseId)
  ) {
    throw new Error(`${label} could not be uploaded because the visit identifiers are missing.`);
  }
  if (!REPORT_ATTACHMENT_CATEGORIES.has(category)) {
    throw new Error("The report attachment category is not supported.");
  }

  const storagePath = `${patientDatabaseId}/${scheduleDatabaseId}/${category}/${sanitizeStorageFilename(file.name)}`;
  const { error: uploadError } = await supabase.storage
    .from(MEDICAL_RECORDS_BUCKET)
    .upload(storagePath, file, {
      cacheControl: "3600",
      contentType: "application/pdf",
      upsert: false,
    });

  if (uploadError) {
    console.error("[Appointment Visit Form] report upload failed:", {
      category,
      bucket: MEDICAL_RECORDS_BUCKET,
      objectPath: storagePath,
      code: uploadError.code || null,
      message: uploadError.message || "Unknown Supabase Storage error",
    });
    throw new Error(
      getErrorMessage(uploadError, `${label} could not be uploaded. Please try again.`)
    );
  }

  return {
    name: file.name,
    type: "application/pdf",
    size: file.size,
    path: storagePath,
  };
}

function isMissingStaffIntakeSupport(error) {
  if (!error) return false;
  const message = `${error.message || ""} ${error.details || ""} ${error.hint || ""}`.toLowerCase();
  return (
    error.code === "42883" ||
    error.code === "42P01" ||
    error.code === "PGRST202" ||
    error.code === "PGRST204" ||
    message.includes("get_staff_visit_intake") ||
    message.includes("staff_visit_intake") ||
    message.includes("schema cache")
  );
}

function getVisibleBaselineValue(value) {
  const normalized = String(value || "").trim();
  return /^sample\s+only$/i.test(normalized) ? "" : normalized;
}

function buildStaffVaccinationSummary(intakeData) {
  const notes = [
    intakeData.hpvVaccinated ? `HPV Vaccination: ${intakeData.hpvVaccinated}` : "",
    intakeData.lastPapSmear ? `Last Pap Smear: ${intakeData.lastPapSmear}` : "",
    intakeData.otherDetails ? `Others: ${intakeData.otherDetails}` : "",
  ].filter(Boolean);
  return notes.join("\n");
}

function buildStaffIntakeDefaults(intake) {
  const intakeData = intake?.intake_data && typeof intake.intake_data === "object"
    ? intake.intake_data
    : null;

  if (!intakeData) return {};

  const defaults = {
    staffPrefillSource: "staff_visit_intake",
    staffIntakeId: intake.id || "",
    staffIntakeVisitType: intake.visit_type || "",
    staffIntakeStaffId: intake.staff_id || "",
    staffIntakeCompletedAt: intake.staff_completed_at || "",
    staffIntakeSnapshot: intakeData,
  };

  [
    "gestationalAge",
    "expectedDeliveryDate",
    "bloodPressure",
    "temperature",
    "respiratoryRate",
    "weight",
    "height",
    "oxygenSaturation",
    "fetalHeartRate",
  ].forEach((field) => {
    if (String(intakeData[field] || "").trim()) defaults[field] = intakeData[field];
  });

  const intakeRiskLevel = normalizeRiskLevel(
    intakeData.riskLevel || intakeData.risk_level || intakeData.pregnancyStatus
  );
  if (intakeRiskLevel) defaults.riskLevel = intakeRiskLevel;

  if (String(intakeData.remarks || "").trim()) {
    defaults.additionalFindings = intakeData.remarks;
  }

  const vaccinationSummary = buildStaffVaccinationSummary(intakeData);
  if (vaccinationSummary) defaults.vaccinationStatus = vaccinationSummary;

  return defaults;
}

function parseGestationalAgeToDays(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const match = normalized.match(
    /^(\d{1,2})(?:\s*(?:weeks?|wks?|wk|w))?(?:\s*(?:and\s*)?(\d{1,2})\s*(?:days?|d))?$/
  );

  if (!match) return null;

  const weeks = Number(match[1]);
  const days = Number(match[2] || 0);

  if (
    !Number.isInteger(weeks) ||
    weeks < 0 ||
    weeks > 45 ||
    !Number.isInteger(days) ||
    days < 0 ||
    days > 6
  ) {
    return null;
  }

  return (weeks * 7) + days;
}

function parseDateKeyToUtc(value) {
  const normalized = String(value || "").trim();
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;

  const time = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3])
  );

  return Number.isFinite(time) ? time : null;
}

function progressGestationalAge(value, anchorVisitDate, currentVisitDate) {
  const original = String(value || "").trim();
  const baselineDays = parseGestationalAgeToDays(original);
  const anchorTime = parseDateKeyToUtc(anchorVisitDate);
  const currentTime = parseDateKeyToUtc(currentVisitDate);

  if (
    baselineDays == null ||
    anchorTime == null ||
    currentTime == null ||
    currentTime <= anchorTime
  ) {
    return original;
  }

  const elapsedDays = Math.floor(
    (currentTime - anchorTime) / (24 * 60 * 60 * 1000)
  );

  const totalDays = baselineDays + elapsedDays;
  const weeks = Math.floor(totalDays / 7);
  const days = totalDays % 7;

  return days
    ? `${weeks} weeks ${days} days`
    : `${weeks} weeks`;
}

function buildPreviousVisitDefaults(record) {
  const data = normalizeClinicalVisitFormData(record);

  /*
   * Follow-up autofill intentionally carries forward only information that can
   * reasonably persist between visits. Current-visit complaints, vital signs,
   * assessment, diagnosis, treatment, prescriptions, laboratory findings, and
   * ultrasound findings remain blank unless the current Staff intake supplies
   * today's measurements.
   */
  const defaults = {
    previousVisitRecordId: record?.id || "",
    previousVisitScheduleId: record?.schedule_id || "",
    previousVisitType: record?.type || "",
  };

  [
    "gestationalAge",
    "expectedDeliveryDate",
    "pregnancyType",
    "riskLevel",
    "lifestyleAssessment",
    "smokingStatus",
    "drugUse",
    "physicalActivity",
    "alcoholIntake",
    "diet",
    "vaccinationStatus",
    "pregnancyJourneyUpdate",
  ].forEach((field) => {
    if (String(data[field] ?? "").trim()) {
      defaults[field] = data[field];
    }
  });

  if (Array.isArray(data.vaccinations)) {
    defaults.vaccinations = data.vaccinations;
  }
  if (Array.isArray(data.journeyMilestones)) {
    defaults.journeyMilestones = data.journeyMilestones;
  }

  return defaults;
}

function normalizeFormData(record, defaults = {}) {
  const data = normalizeClinicalVisitFormData(record);
  const normalizedDefaults = normalizeClinicalVisitFormData(defaults);

  return {
    ...emptyForm,
    ...defaults,
    ...data,
    riskLevel: data.riskLevel || normalizedDefaults.riskLevel || "",
    babyPosition: data.babyPosition || normalizedDefaults.babyPosition || "",
    fetalHeartRate: data.fetalHeartRate || normalizedDefaults.fetalHeartRate || "",
    laboratoryResultSummary: data.laboratoryResultSummary ?? data.laboratoryReview ?? "",
    ultrasoundFindings: data.ultrasoundFindings ?? data.ultrasoundReview ?? "",
    prescriptionInstructions: data.prescriptionInstructions ?? data.prescription ?? "",
    vaccinations: Array.isArray(data.vaccinations)
      ? data.vaccinations
      : Array.isArray(defaults.vaccinations)
        ? defaults.vaccinations
        : [],
    medications: Array.isArray(data.medications) ? data.medications : [],
    actionSelections: Array.isArray(data.actionSelections) ? data.actionSelections : [],
    journeyMilestones: Array.isArray(data.journeyMilestones)
      ? data.journeyMilestones
      : Array.isArray(defaults.journeyMilestones)
        ? defaults.journeyMilestones
        : [],
  };
}

function FormCard({ title, action, className = "", children }) {
  return (
    <section className={`appointment-visit-card ${className}`.trim()}>
      <header className="appointment-visit-card-header">
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

function ReadOnlyField({ id, label, value }) {
  return (
    <div className="appointment-visit-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        value={value ?? ""}
        readOnly
        aria-readonly="true"
      />
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  type = "text",
  placeholder = "",
  readOnly = false,
  required = false,
  error = "",
}) {
  return (
    <div className="appointment-visit-field">
      <label htmlFor={id}>{label}{required ? <span aria-hidden="true"> *</span> : null}</label>
      <input
        id={id}
        type={type}
        value={value ?? ""}
        placeholder={placeholder}
        readOnly={readOnly}
        disabled={readOnly}
        required={required}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange?.(event.target.value)}
      />
      {error ? <span id={`${id}-error`} className="appointment-visit-field-error">{error}</span> : null}
    </div>
  );
}

function SelectField({ id, label, value, onChange, options, readOnly = false }) {
  return (
    <div className="appointment-visit-field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value ?? ""}
        disabled={readOnly}
        onChange={(event) => onChange?.(event.target.value)}
      >
        <option value="">Select</option>
        {options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </div>
  );
}

function TextAreaField({
  id,
  label,
  value,
  onChange,
  readOnly = false,
  required = false,
  maxLength,
  placeholder = "",
  size = "medium",
  error = "",
}) {
  return (
    <div className={`appointment-visit-field appointment-visit-textarea is-${size}`}>
      <label htmlFor={id}>{label}{required ? <span aria-hidden="true"> *</span> : null}</label>
      <div className="appointment-visit-textarea-control">
        <textarea
          id={id}
          value={value ?? ""}
          placeholder={placeholder}
          readOnly={readOnly}
          disabled={readOnly}
          required={required}
          maxLength={maxLength}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => onChange?.(event.target.value)}
        />
        {maxLength ? (
          <span className="appointment-visit-counter" aria-live="polite">
            {String(value ?? "").length}/{maxLength}
          </span>
        ) : null}
      </div>
      {error ? <span id={`${id}-error`} className="appointment-visit-field-error">{error}</span> : null}
    </div>
  );
}

function ChoiceGroup({ label, value, options, onChange, readOnly = false }) {
  return (
    <fieldset className="appointment-visit-choice-group">
      <legend>{label}</legend>
      <div>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={value === option}
            disabled={readOnly}
            onClick={() => onChange?.(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function CheckboxGrid({ id, options, selected, onChange, readOnly = false }) {
  const values = Array.isArray(selected) ? selected : [];
  return (
    <div className="appointment-visit-checkbox-grid">
      {options.map((option, index) => (
        <label key={option} htmlFor={`${id}-${index}`}>
          <input
            id={`${id}-${index}`}
            type="checkbox"
            checked={values.includes(option)}
            disabled={readOnly}
            onChange={() => {
              const next = values.includes(option)
                ? values.filter((value) => value !== option)
                : [...values, option];
              onChange?.(next);
            }}
          />
          <span>{option}</span>
        </label>
      ))}
    </div>
  );
}

function AttachmentField({
  id,
  label,
  file,
  existingFile,
  error = "",
  onChange,
  onClear,
  readOnly = false,
}) {
  const displayedFile = file || existingFile;

  return (
    <div className="appointment-visit-attachment">
      <label htmlFor={id}>{label}</label>
      {!readOnly && !file ? (
        <label className="appointment-visit-upload-control" htmlFor={id}>
          <input
            id={id}
            type="file"
            accept="application/pdf,.pdf"
            aria-describedby={error ? `${id}-error` : undefined}
            aria-invalid={Boolean(error)}
            onChange={(event) => {
              const nextFile = event.target.files?.[0] || null;
              onChange?.(nextFile);
              event.target.value = "";
            }}
          />
          <span>{existingFile ? "Replace report" : "Upload report"}</span>
          <small>{existingFile ? "Existing PDF will be kept unless replaced" : "PDF only, up to 10 MB"}</small>
        </label>
      ) : null}
      {displayedFile ? (
        <div className="appointment-visit-file">
          <FileText size={15} aria-hidden="true" />
          <span>{displayedFile.name}</span>
          {!readOnly && file ? (
            <button type="button" aria-label={`Remove ${file.name}`} title="Remove selected file" onClick={onClear}>
              <X size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? <span id={`${id}-error`} className="appointment-visit-field-error">{error}</span> : null}
    </div>
  );
}

const validationFieldIds = {
  chiefComplaint: "chief-complaint",
  expectedDeliveryDate: "expected-delivery-date",
  bloodPressure: "blood-pressure",
  temperature: "temperature",
  respiratoryRate: "respiratory-rate",
  weight: "weight",
  height: "height",
  oxygenSaturation: "oxygen-saturation",
  fundalHeight: "fundal-height",
  fetalHeartRate: "fetal-heart-rate",
  estimatedFetalWeight: "estimated-fetal-weight",
  assessment: "assessment",
  diagnosis: "diagnosis",
  treatmentPlan: "treatment-plan",
  laboratoryAttachment: "laboratory-report",
  ultrasoundAttachment: "ultrasound-report",
};

function getTrimmedValue(value) {
  return String(value ?? "").trim();
}

function getNumericClinicalValue(value) {
  const rawValue = getTrimmedValue(value).replace(",", ".");
  const match = rawValue.match(
    /^(-?\d+(?:\.\d+)?)(?:\s*(?:kg|g|cm|bpm|c|\u00b0c|%|breaths\/min))?$/i
  );
  return match ? Number(match[1]) : Number.NaN;
}

function addNumberValidation(errors, field, value, label, options = {}) {
  const rawValue = getTrimmedValue(value);
  if (!rawValue) return;

  const numericValue = getNumericClinicalValue(rawValue);
  if (!Number.isFinite(numericValue)) {
    errors[field] = `${label} must be a number.`;
    return;
  }

  if (options.positive && numericValue <= 0) {
    errors[field] = `${label} must be greater than 0.`;
    return;
  }

  if (options.min != null && numericValue < options.min) {
    errors[field] = `${label} must be at least ${options.min}.`;
    return;
  }

  if (options.max != null && numericValue > options.max) {
    errors[field] = `${label} must be ${options.max} or lower.`;
  }
}

function validateVisitForm(form, { laboratoryFile = null, ultrasoundFile = null } = {}) {
  const errors = {};
  const requiredFields = [
    ["chiefComplaint", "Chief Complaints", form.chiefComplaint],
    ["assessment", "Assessment", form.assessment],
    ["diagnosis", "Diagnosis", form.diagnosis],
    ["treatmentPlan", "Plan / Treatment", form.treatmentPlan],
  ];

  requiredFields.forEach(([field, label, value]) => {
    if (!getTrimmedValue(value)) {
      errors[field] = `${label} is required.`;
    }
  });

  const bloodPressure = getTrimmedValue(form.bloodPressure);
  if (bloodPressure && !/^\d{2,3}\s*\/\s*\d{2,3}(?:\s*mmhg)?$/i.test(bloodPressure)) {
    errors.bloodPressure = "Blood Pressure must use a systolic/diastolic format.";
  }

  if (getTrimmedValue(form.expectedDeliveryDate)) {
    const dateValue = new Date(`${form.expectedDeliveryDate}T00:00:00`);
    if (Number.isNaN(dateValue.getTime())) {
      errors.expectedDeliveryDate = "Expected Delivery Date must be a valid date.";
    }
  }

  addNumberValidation(errors, "temperature", form.temperature, "Temperature", { min: 30, max: 45 });
  addNumberValidation(errors, "respiratoryRate", form.respiratoryRate, "Respiratory Rate", { positive: true });
  addNumberValidation(errors, "weight", form.weight, "Weight", { positive: true });
  addNumberValidation(errors, "height", form.height, "Height", { positive: true });
  addNumberValidation(errors, "oxygenSaturation", form.oxygenSaturation, "Oxygen Saturation", { min: 0, max: 100 });
  addNumberValidation(errors, "fundalHeight", form.fundalHeight, "Fundal Height", { min: 0 });
  addNumberValidation(errors, "fetalHeartRate", form.fetalHeartRate, "Fetal Heart Rate", { positive: true });
  addNumberValidation(errors, "estimatedFetalWeight", form.estimatedFetalWeight, "Estimated Fetal Weight", { min: 0 });

  const laboratoryFileError = validateReportFile(laboratoryFile, "Laboratory report");
  if (laboratoryFileError) errors.laboratoryAttachment = laboratoryFileError;
  if (
    form.laboratoryReportAttached === "Yes" &&
    !laboratoryFile &&
    !hasStoredAttachment(form.laboratoryAttachment)
  ) {
    errors.laboratoryAttachment = "Select a Laboratory report PDF before saving.";
  }

  const ultrasoundFileError = validateReportFile(ultrasoundFile, "Ultrasound report");
  if (ultrasoundFileError) errors.ultrasoundAttachment = ultrasoundFileError;
  if (
    form.ultrasoundReportAttached === "Yes" &&
    !ultrasoundFile &&
    !hasStoredAttachment(form.ultrasoundAttachment)
  ) {
    errors.ultrasoundAttachment = "Select an Ultrasound report PDF before saving.";
  }

  return errors;
}

function focusFirstValidationError(errors) {
  const firstField = Object.keys(errors)[0];
  const targetId = validationFieldIds[firstField];
  if (!targetId) return;

  window.setTimeout(() => {
    const target = document.getElementById(targetId);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    target?.focus({ preventScroll: true });
  }, 0);
}

function formatClinicalDate(value) {
  if (!value) return "Not recorded";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default function AppointmentVisitForm({ appointmentId, requestedType, workspace }) {
  const navigate = useNavigate();
  const location = useLocation();
  const requestIdRef = useRef(0);
  const saveLockRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [appointment, setAppointment] = useState(null);
  const [patient, setPatient] = useState(null);
  const [routing, setRouting] = useState(null);
  const [existingRecord, setExistingRecord] = useState(null);
  const [previousBaseline, setPreviousBaseline] = useState(null);
  const [currentPregnancy, setCurrentPregnancy] = useState({
    obstetricHistoryId: "",
    expectedDeliveryDate: "",
  });
  const [eddConfirmation, setEddConfirmation] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [validationErrors, setValidationErrors] = useState({});
  const [vaccinationEditor, setVaccinationEditor] = useState(null);
  const [medicationEditor, setMedicationEditor] = useState(null);
  const [laboratoryFile, setLaboratoryFile] = useState(null);
  const [ultrasoundFile, setUltrasoundFile] = useState(null);
  const [prescriptionFile, setPrescriptionFile] = useState(null);

  const medicalRecordReturnContext = useMemo(() => {
    if (workspace !== "doctor") return null;

    const params = new URLSearchParams(location.search || "");
    if (params.get("source") !== "medical-record") return null;

    const patientId = String(params.get("patientId") || "").trim();
    const recordId = String(params.get("recordId") || "").trim();

    return patientId && recordId ? { patientId, recordId } : null;
  }, [location.search, workspace]);

  const getVisitReturnPath = useCallback(
    (savedRecordId = "") => {
      if (!medicalRecordReturnContext) {
        return `/${workspace}/appointments`;
      }

      const params = new URLSearchParams({
        view: "patients",
        tab: "medical-record",
        patientId: medicalRecordReturnContext.patientId,
        recordId: savedRecordId || medicalRecordReturnContext.recordId,
      });

      return `/doctor?${params.toString()}`;
    },
    [medicalRecordReturnContext, workspace]
  );

  const returnFromVisit = useCallback(
    (savedRecordId = "", options = {}) => {
      navigate(getVisitReturnPath(savedRecordId), options);
    },
    [getVisitReturnPath, navigate]
  );

  const loadVisit = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError("");
    setMessage("");
    setValidationErrors({});
    setVaccinationEditor(null);
    setMedicationEditor(null);
    setLaboratoryFile(null);
    setUltrasoundFile(null);
    setPrescriptionFile(null);
    setEddConfirmation(null);

    const { data: routingData, error: routingError } = await supabase.rpc(
      "get_appointment_visit_form_type",
      { p_appointment_id: appointmentId }
    );

    if (requestIdRef.current !== requestId) return;
    if (routingError) {
      logVisitError("routing RPC failed", routingError);
      setError(getErrorMessage(routingError, "Unable to determine the visit form."));
      setLoading(false);
      return;
    }

    const routeResult = Array.isArray(routingData) ? routingData[0] : routingData;
    if (!routeResult?.visit_form_type) {
      setError("The visit-routing RPC did not return a form type.");
      setLoading(false);
      return;
    }

    if (routeResult.visit_form_type !== requestedType) {
      const routeSegment = routeResult.visit_form_type === "initial"
        ? "initial-visit"
        : "follow-up";
      navigate(
        {
          pathname: `/${workspace}/appointments/${appointmentId}/${routeSegment}`,
          search: location.search || "",
        },
        { replace: true }
      );
      return;
    }

    const { data: schedule, error: scheduleError } = await supabase
      .from("schedule")
      .select(scheduleColumns)
      .eq("id", appointmentId)
      .maybeSingle();

    if (requestIdRef.current !== requestId) return;
    if (scheduleError || !schedule?.patient_id) {
      logVisitError("appointment load failed", scheduleError);
      setError(getErrorMessage(scheduleError, "The appointment could not be loaded."));
      setLoading(false);
      return;
    }

    const [
      patientResult,
      recordResult,
      baselineResult,
      staffIntakeResult,
      obstetricResult,
    ] = await Promise.all([
      supabase
        .rpc("get_doctor_patient_directory")
        .select(patientColumns)
        .eq("id", schedule.patient_id)
        .maybeSingle(),
      supabase
        .from("medical_records")
        .select(recordColumns)
        .eq("schedule_id", appointmentId)
        .maybeSingle(),
      supabase
        .from("medical_records")
        .select(recordColumns)
        .eq("patient_id", schedule.patient_id)
        .order("uploaded_at", { ascending: false })
        .limit(30),
      supabase.rpc("get_staff_visit_intake", { p_appointment_id: appointmentId }),
      supabase
        .from("patient_obstetric_history")
        .select("id, patient_id, expected_delivery_date")
        .eq("patient_id", schedule.patient_id)
        .limit(1)
        .maybeSingle(),
    ]);

    if (requestIdRef.current !== requestId) return;
    const staffIntakeError =
      staffIntakeResult.error && !isMissingStaffIntakeSupport(staffIntakeResult.error)
        ? staffIntakeResult.error
        : null;
    const loadError =
      patientResult.error ||
      recordResult.error ||
      baselineResult.error ||
      obstetricResult.error ||
      staffIntakeError;
    if (loadError) {
      logVisitError("visit information load failed", loadError);
      setError(getErrorMessage(loadError, "Unable to load visit information."));
      setLoading(false);
      return;
    }

    const patientRow = patientResult.data;
    const record = recordResult.data;
    const staffIntake = Array.isArray(staffIntakeResult.data)
      ? staffIntakeResult.data[0]
      : staffIntakeResult.data;
    const obstetricHistory = obstetricResult.data || null;
    const completedPriorRecords = (baselineResult.data || []).filter((candidate) => {
      if (!isCompletedClinicalVisitRecord(candidate)) return false;
      return candidate?.schedule_id !== appointmentId;
    });
    const baseline = completedPriorRecords[0] || null;

    // Gestational age uses the earliest completed Doctor visit with a usable
    // gestational-age/date pair as its anchor. This prevents older Follow-Up
    // records that copied a stale age (for example, 14 weeks every visit) from
    // permanently freezing the progression.
    const gestationalAgeAnchor = [...completedPriorRecords].reverse().find((candidate) => {
      const data = candidate?.form_data && typeof candidate.form_data === "object"
        ? candidate.form_data
        : {};
      const visitDate =
        data.appointmentDate ||
        data.visitDate ||
        (candidate?.uploaded_at ? getManilaDateKey(candidate.uploaded_at) : "");

      return String(data.gestationalAge || "").trim() && visitDate;
    }) || baseline;

    const previousVisitDefaults =
      requestedType === "follow_up"
        ? buildPreviousVisitDefaults(baseline)
        : {};

    const anchorData =
      gestationalAgeAnchor?.form_data &&
      typeof gestationalAgeAnchor.form_data === "object"
        ? gestationalAgeAnchor.form_data
        : {};

    const currentVisitDate = getManilaDateKey(schedule.start_time);
    const anchorVisitDate =
      anchorData.appointmentDate ||
      anchorData.visitDate ||
      (gestationalAgeAnchor?.uploaded_at
        ? getManilaDateKey(gestationalAgeAnchor.uploaded_at)
        : "");

    const progressedGestationalAge =
      requestedType === "follow_up"
        ? progressGestationalAge(
            anchorData.gestationalAge || previousVisitDefaults.gestationalAge,
            anchorVisitDate,
            currentVisitDate
          )
        : "";

    const staffIntakeDefaults = buildStaffIntakeDefaults(staffIntake);
    const currentExpectedDeliveryDate = obstetricHistory?.expected_delivery_date
      ? getManilaDateKey(obstetricHistory.expected_delivery_date)
      : patientRow?.expected_delivery_date
        ? getManilaDateKey(patientRow.expected_delivery_date)
        : "";

    const defaults = {
      ...previousVisitDefaults,

      // Today's completed Staff pre-consultation is the current-visit source
      // of truth. Use it before patient/baseline values when a Doctor record
      // for this appointment does not exist yet.
      ...staffIntakeDefaults,

      gestationalAge:
        requestedType === "follow_up"
          ? (
              staffIntakeDefaults.gestationalAge ||
              progressedGestationalAge ||
              previousVisitDefaults.gestationalAge ||
              patientRow?.gestational_age ||
              ""
            )
          : (
              staffIntakeDefaults.gestationalAge ||
              patientRow?.gestational_age ||
              ""
            ),
      expectedDeliveryDate:
        staffIntakeDefaults.expectedDeliveryDate ||
        currentExpectedDeliveryDate ||
        previousVisitDefaults.expectedDeliveryDate ||
        "",
      riskLevel:
        staffIntakeDefaults.riskLevel ||
        patientRow?.risk_level ||
        previousVisitDefaults.riskLevel ||
        "",
    };

    const nextForm = normalizeFormData(record, defaults);

    // For a new Doctor visit record, explicitly preserve today's Staff intake
    // after normalization. Existing Doctor records still win when Edit Record
    // is opened because this override is skipped once record.id exists.
    if (!record?.id) {
      [
        "gestationalAge",
        "expectedDeliveryDate",
        "riskLevel",
        "bloodPressure",
        "temperature",
        "weight",
        "fetalHeartRate",
      ].forEach((field) => {
        if (String(staffIntakeDefaults[field] || "").trim()) {
          nextForm[field] = staffIntakeDefaults[field];
        }
      });
    }

    setRouting(routeResult);
    setAppointment(schedule);
    setPatient(patientRow || null);
    setExistingRecord(record || null);
    setPreviousBaseline(baseline || null);
    setCurrentPregnancy({
      obstetricHistoryId: obstetricHistory?.id || "",
      expectedDeliveryDate: currentExpectedDeliveryDate,
    });
    setForm(nextForm);
    setLoading(false);
  }, [appointmentId, location.search, navigate, requestedType, workspace]);

  useEffect(() => {
    const timer = window.setTimeout(loadVisit, 0);
    return () => {
      requestIdRef.current += 1;
      window.clearTimeout(timer);
    };
  }, [loadVisit]);

  useEffect(() => {
    if (!eddConfirmation) return undefined;

    const closeOnEscape = (event) => {
      if (event.key === "Escape" && !saving) setEddConfirmation(null);
    };

    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [eddConfirmation, saving]);

  const isCompleted = useMemo(
    () => String(routing?.appointment_status || "").trim().toLowerCase() === "completed",
    [routing?.appointment_status]
  );
  const isCheckedIn = useMemo(
    () => ["checked_in", "checked-in", "checked in"].includes(
      String(routing?.appointment_status || "").trim().toLowerCase()
    ),
    [routing?.appointment_status]
  );
  const isBlockedAppointmentStatus = useMemo(
    () => [
      "cancelled",
      "canceled",
      "cancel",
      "deleted",
      "missed",
      "no_show",
      "no show",
    ].includes(String(routing?.appointment_status || "").trim().toLowerCase()),
    [routing?.appointment_status]
  );
  const hasExistingRecord = existingRecord?.id != null && existingRecord.id !== "";
  const isEditableExistingRecord =
    workspace === "doctor" &&
    hasExistingRecord &&
    existingRecord?.schedule_id === appointmentId &&
    !isBlockedAppointmentStatus;
  const isReadOnly = hasExistingRecord
    ? !isEditableExistingRecord
    : isCompleted;
  const canSave = isEditableExistingRecord || (isCheckedIn && !isReadOnly);
  const isFollowUp = requestedType === "follow_up";
  const formTitle = isFollowUp ? "Follow-Up Visit Form" : "Initial Visit Form";

  const updateForm = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
    setValidationErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setError("");
    setMessage("");
  };

  const selectReportFile = (category, file) => {
    const label = category === "laboratory" ? "Laboratory report" : "Ultrasound report";
    const field = category === "laboratory" ? "laboratoryAttachment" : "ultrasoundAttachment";
    const setFile = category === "laboratory" ? setLaboratoryFile : setUltrasoundFile;
    const fileError = validateReportFile(file, label);

    if (fileError) {
      setFile(null);
      setValidationErrors((current) => ({ ...current, [field]: fileError }));
      setError(fileError);
      setMessage("");
      return;
    }

    setFile(file);
    setValidationErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setError("");
    setMessage("");
  };

  const updateReportAttached = (category, value) => {
    const reportField = category === "laboratory"
      ? "laboratoryReportAttached"
      : "ultrasoundReportAttached";
    const attachmentField = category === "laboratory"
      ? "laboratoryAttachment"
      : "ultrasoundAttachment";

    updateForm(reportField, value);
    if (value === "No") {
      if (category === "laboratory") setLaboratoryFile(null);
      else setUltrasoundFile(null);
      setValidationErrors((current) => {
        if (!current[attachmentField]) return current;
        const next = { ...current };
        delete next[attachmentField];
        return next;
      });
    }
  };

  const beginVaccination = (index = null) => {
    const row = index === null ? null : form.vaccinations[index];
    setVaccinationEditor({
      index,
      vaccineName: row?.vaccineName || "",
      lotNumber: row?.lotNumber || "",
      dateGiven: row?.dateGiven || "",
    });
  };

  const saveVaccination = () => {
    if (!vaccinationEditor?.vaccineName.trim()) return;
    const nextRow = {
      vaccineName: vaccinationEditor.vaccineName.trim(),
      lotNumber: vaccinationEditor.lotNumber.trim(),
      dateGiven: vaccinationEditor.dateGiven,
    };
    const rows = [...form.vaccinations];
    if (vaccinationEditor.index === null) rows.push(nextRow);
    else rows[vaccinationEditor.index] = nextRow;
    updateForm("vaccinations", rows);
    setVaccinationEditor(null);
  };

  const removeVaccination = (index) => {
    updateForm("vaccinations", form.vaccinations.filter((_, rowIndex) => rowIndex !== index));
    setVaccinationEditor(null);
  };

  const beginMedication = (index = null) => {
    const row = index === null ? null : form.medications[index];
    setMedicationEditor({
      index,
      medication: row?.medication || "",
      dosage: row?.dosage || "",
      frequency: row?.frequency || "",
      duration: row?.duration || "",
    });
  };

  const saveMedication = () => {
    if (!medicationEditor?.medication.trim()) return;
    const nextRow = {
      medication: medicationEditor.medication.trim(),
      dosage: medicationEditor.dosage.trim(),
      frequency: medicationEditor.frequency.trim(),
      duration: medicationEditor.duration.trim(),
    };
    const rows = [...form.medications];
    if (medicationEditor.index === null) rows.push(nextRow);
    else rows[medicationEditor.index] = nextRow;
    updateForm("medications", rows);
    setMedicationEditor(null);
  };

  const removeMedication = (index) => {
    updateForm("medications", form.medications.filter((_, rowIndex) => rowIndex !== index));
    setMedicationEditor(null);
  };

  const saveRecord = async ({ updateCurrentEdd = false } = {}) => {
    if (saveLockRef.current || saving || !canSave) return;

    const nextValidationErrors = validateVisitForm(form, {
      laboratoryFile,
      ultrasoundFile,
    });
    if (Object.keys(nextValidationErrors).length) {
      setValidationErrors(nextValidationErrors);
      focusFirstValidationError(nextValidationErrors);
      setError("Complete or correct the highlighted fields before saving.");
      return;
    }

    const nextExpectedDeliveryDate = String(form.expectedDeliveryDate || "").trim();
    const nextCurrentPregnancyWeek = updateCurrentEdd
      ? calculateCurrentPregnancyWeekFromEdd(nextExpectedDeliveryDate)
      : null;
    if (updateCurrentEdd && nextCurrentPregnancyWeek === null) {
      const validationMessage =
        "The selected Expected Delivery Date is inconsistent with the current pregnancy dating.";
      const nextErrors = {
        ...nextValidationErrors,
        expectedDeliveryDate: validationMessage,
      };
      setValidationErrors(nextErrors);
      focusFirstValidationError(nextErrors);
      setError(validationMessage);
      setMessage("");
      return;
    }

    if (
      nextExpectedDeliveryDate &&
      nextExpectedDeliveryDate !== currentPregnancy.expectedDeliveryDate &&
      !updateCurrentEdd
    ) {
      setEddConfirmation({
        current: currentPregnancy.expectedDeliveryDate,
        next: nextExpectedDeliveryDate,
      });
      return;
    }

    saveLockRef.current = true;
    setSaving(true);
    setError("");
    setMessage("");

    try {
      const appointmentDate = getManilaDateKey(appointment?.start_time);
      const appointmentTime = getManilaTimeKey(appointment?.start_time);
      const visitRecordTitle = requestedType === "initial" ? "Initial Visit" : "Follow-Up Visit";
      const patientId = appointment?.patient_id || existingRecord?.patient_id || null;
      const scheduleId = appointment?.id || existingRecord?.schedule_id || null;
      const canonicalFormData = buildCanonicalClinicalVisitFormData(form);
      let laboratoryAttachment = form.laboratoryReportAttached === "Yes"
        ? canonicalFormData.laboratoryAttachment
        : null;
      let ultrasoundAttachment = form.ultrasoundReportAttached === "Yes"
        ? canonicalFormData.ultrasoundAttachment
        : null;

      if (form.laboratoryReportAttached === "Yes" && laboratoryFile) {
        laboratoryAttachment = await uploadReportAttachment({
          file: laboratoryFile,
          patientId,
          scheduleId,
          category: "laboratory",
        });
      }

      if (form.ultrasoundReportAttached === "Yes" && ultrasoundFile) {
        ultrasoundAttachment = await uploadReportAttachment({
          file: ultrasoundFile,
          patientId,
          scheduleId,
          category: "ultrasound",
        });
      }

      canonicalFormData.laboratoryAttachment = laboratoryAttachment;
      canonicalFormData.laboratoryReview = {
        ...canonicalFormData.laboratoryReview,
        reportAttached: form.laboratoryReportAttached,
        attachment: laboratoryAttachment,
      };
      canonicalFormData.ultrasoundAttachment = ultrasoundAttachment;
      canonicalFormData.ultrasoundReview = {
        ...canonicalFormData.ultrasoundReview,
        reportAttached: form.ultrasoundReportAttached,
        attachment: ultrasoundAttachment,
      };

      const formDataForSave = {
        ...canonicalFormData,
        appointmentDate,
        appointmentTime,
        appointmentId,
        patientId,
        doctorId: appointment?.doctor_id || existingRecord?.doctor_id || null,
        visitFormType: requestedType,
        recordStatus: "completed",
        isDraft: false,
        completedAt: existingRecord?.form_data?.completedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const syncCurrentPregnancy = async () => {
        if (!formDataForSave.riskLevel && !updateCurrentEdd) return true;

        const { error: syncError } = await supabase.rpc(
          "sync_doctor_visit_pregnancy_state",
          {
            p_appointment_id: appointmentId,
            p_risk_level: formDataForSave.riskLevel || null,
            p_expected_delivery_date: updateCurrentEdd
              ? formDataForSave.expectedDeliveryDate || null
              : null,
            p_update_expected_delivery_date: updateCurrentEdd,
            p_obstetric_history_id: currentPregnancy.obstetricHistoryId || null,
            p_current_gestational_week: updateCurrentEdd
              ? nextCurrentPregnancyWeek
              : null,
          }
        );

        if (syncError) {
          logVisitError("current pregnancy synchronization failed", syncError);
          setError(
            getErrorMessage(
              syncError,
              "The visit was saved, but the current pregnancy summary could not be synchronized. Retry Save Record."
            )
          );
          return false;
        }

        return true;
      };

      if (isEditableExistingRecord) {
        const existingType = String(
          existingRecord?.form_data?.visitFormType ||
            existingRecord?.type ||
            existingRecord?.title ||
            ""
        ).toLowerCase();
        const normalizedExistingType = existingType.includes("initial")
          ? "initial"
          : "follow_up";

        if (normalizedExistingType !== requestedType) {
          setError("This saved record belongs to a different visit form type.");
          return;
        }

        const { data, error: updateError } = await supabase
          .from("medical_records")
          .update({
            type: existingRecord?.type || visitRecordTitle,
            title: existingRecord?.title || visitRecordTitle,
            notes:
              form.chiefComplaint?.trim() ||
              form.diagnosis?.trim() ||
              "Maternal care visit completed.",
            form_data: formDataForSave,
          })
          .eq("id", existingRecord.id)
          .eq("schedule_id", appointmentId)
          .select(recordColumns)
          .maybeSingle();

        if (updateError) {
          logVisitError("existing visit record update failed", updateError);
          setError(getErrorMessage(updateError, "Unable to update the visit record."));
          return;
        }

        if (!data?.id) {
          setError("The existing visit record could not be found for update.");
          return;
        }

        setExistingRecord(data);
        if (!(await syncCurrentPregnancy())) return;
        setMessage(
          requestedType === "initial"
            ? "Initial Visit record updated successfully."
            : "Follow-Up Visit record updated successfully."
        );

        // Doctor workflow:
        // - A visit completed from Appointments returns to Appointments.
        // - A record edited from the patient's Medical Record returns to that
        //   same patient and the same saved medical record.
        if (workspace === "doctor") {
          returnFromVisit(data.id, { replace: true });
          return;
        }

        return;
      }

      const { data, error: saveError } = await supabase.rpc(
        "save_appointment_visit_record",
        {
          p_appointment_id: appointmentId,
          p_visit_form_type: requestedType,
          p_form_data: formDataForSave,
        }
      );

      if (saveError) {
        logVisitError("save RPC failed", saveError);
        setError(getErrorMessage(saveError, "Unable to save the visit record."));
        return;
      }

      if (!data?.id) {
        setError("The saved visit record was not returned. Retry will not create a duplicate.");
        return;
      }

      setExistingRecord(data);
      setRouting((current) => ({ ...current, appointment_status: "completed" }));
      if (!(await syncCurrentPregnancy())) return;
      setMessage(
        requestedType === "initial"
          ? "Initial Visit record saved successfully."
          : "Follow-Up Visit record saved successfully."
      );

      // Redirect only after Supabase has successfully saved the Doctor's
      // Initial or Follow-Up Visit and completed the appointment.
      // Preserve the Medical Record origin when this form was opened by Edit Record.
      if (workspace === "doctor") {
        returnFromVisit(data.id, { replace: true });
      }
    } catch (saveError) {
      logVisitError("unexpected save failure", saveError);
      setError(getErrorMessage(saveError, "Unable to save the visit record."));
    } finally {
      saveLockRef.current = false;
      setSaving(false);
    }
  };

  if (loading) {
    return <main className="appointment-visit-state">Loading visit information...</main>;
  }

  if (error && !appointment) {
    return (
      <main className="appointment-visit-state" role="alert">
        <p>{error}</p>
        <button type="button" onClick={loadVisit}>Retry</button>
        <button type="button" onClick={() => returnFromVisit(existingRecord?.id || "")}>
          {medicalRecordReturnContext ? "Back to Medical Record" : "Back to Appointments"}
        </button>
      </main>
    );
  }

  const baselineData = previousBaseline?.form_data || {};
  const baselineItems = [
    ["Diagnosis", getVisibleBaselineValue(baselineData.diagnosis)],
    ["Assessment", getVisibleBaselineValue(baselineData.assessment)],
    ["Plan", getVisibleBaselineValue(baselineData.treatmentPlan)],
  ].filter(([, value]) => value);
  const standardBabyPositions = ["Cephalic", "Breech", "Transverse", "Other"];
  const babyPositionOptions = form.babyPosition && !standardBabyPositions.includes(form.babyPosition)
    ? [form.babyPosition, ...standardBabyPositions]
    : standardBabyPositions;

  return (
    <main className="appointment-visit-page">
      <header className="appointment-visit-header">
        <button className="appointment-visit-back" type="button" onClick={() => returnFromVisit(existingRecord?.id || "")}>
          <ArrowLeft size={15} aria-hidden="true" />
          {medicalRecordReturnContext ? "Back to Medical Record" : "Back to Appointments"}
        </button>
        <div className="appointment-visit-heading">
          <h1>{formTitle.toUpperCase()}</h1>
          <p>
            {isReadOnly
              ? "Completed visit record."
              : !isFollowUp
                ? "Record initial consultation or initial visit."
                : "Record comprehensive follow-up information for any type of visit."}
          </p>
        </div>
        <div className="appointment-visit-id-badge">
          <span>Appointment ID</span>
          <strong>{appointment?.maternal_appointment_id || appointment?.id}</strong>
        </div>
      </header>

      {error ? <p className="appointment-visit-message is-error" role="alert">{error}</p> : null}
      {message ? <p className="appointment-visit-message is-success" role="status">{message}</p> : null}
      {!canSave && !isReadOnly && !isCheckedIn ? (
        <p className="appointment-visit-message is-error" role="alert">
          Check in this appointment before completing a visit form.
        </p>
      ) : null}

      {isFollowUp && baselineItems.length ? (
        <details className="appointment-visit-baseline-disclosure">
          <summary>View Previous Visit Baseline</summary>
          <div>
            {baselineItems.map(([label, value]) => (
              <p key={label}><strong>{label}:</strong> {value}</p>
            ))}
          </div>
        </details>
      ) : null}

      <form className={`appointment-visit-form${isFollowUp ? " appointment-visit-form--follow-up" : ""}`} onSubmit={(event) => { event.preventDefault(); saveRecord(); }}>
        <div className="appointment-visit-top-grid">
          <FormCard title="Patient Information" className="appointment-visit-summary-card">
            <div className="appointment-visit-field-grid is-two-columns">
              <ReadOnlyField id="visit-patient-id" label="Patient ID" value={patient?.patient_id || "Not provided"} />
              <ReadOnlyField id="visit-patient-name" label="Patient Name" value={patient?.full_name || appointment?.patient_name} />
              <ReadOnlyField id="visit-patient-age" label="Age" value={patient?.age} />
              <ReadOnlyField id="visit-patient-contact" label="Contact Number" value={patient?.contact_number} />
              <div className="appointment-visit-field-span">
                <ReadOnlyField id="visit-patient-address" label="Address" value={patient?.address} />
              </div>
            </div>
          </FormCard>

          <FormCard title="Visit Information" className="appointment-visit-summary-card">
            <div className="appointment-visit-field-grid is-two-columns">
              <ReadOnlyField id="visit-date" label="Date of Visit" value={formatAppointmentDate(appointment?.start_time)} />
              <ReadOnlyField id="visit-time" label="Time" value={formatAppointmentTime(appointment?.start_time)} />
              <ReadOnlyField id="visit-type" label="Visit Type" value={isFollowUp ? "Follow-Up Visit" : "Initial Visit"} />
              <ReadOnlyField id="visit-doctor" label="Attending Physician" value={appointment?.doctor_name || "Not assigned"} />
            </div>
          </FormCard>

          <FormCard title="Current Pregnancy" className="appointment-visit-summary-card">
            <div className="appointment-visit-field-grid">
              <TextField id="gestational-age" label="Gestational Age" value={form.gestationalAge} placeholder="e.g. 28 weeks" readOnly={isReadOnly} onChange={(value) => updateForm("gestationalAge", value)} />
              <TextField id="expected-delivery-date" label="Expected Delivery Date" value={form.expectedDeliveryDate} type="date" readOnly={isReadOnly} error={validationErrors.expectedDeliveryDate} onChange={(value) => updateForm("expectedDeliveryDate", value)} />
              <TextField id="pregnancy-type" label="Pregnancy Type" value={form.pregnancyType} placeholder="e.g. Singleton" readOnly={isReadOnly} onChange={(value) => updateForm("pregnancyType", value)} />
              <ChoiceGroup id="pregnancy-risk" label="Risk Level" value={form.riskLevel} options={["Low Risk", "Moderate Risk", "High Risk"]} readOnly={isReadOnly} onChange={(value) => updateForm("riskLevel", value)} />
            </div>
          </FormCard>
        </div>

        <FormCard title="Chief Complaints">
          <TextAreaField id="chief-complaint" label="Chief Complaint details" required maxLength={500} size="compact" value={form.chiefComplaint} placeholder="Enter chief complaint details..." readOnly={isReadOnly} error={validationErrors.chiefComplaint} onChange={(value) => updateForm("chiefComplaint", value)} />
        </FormCard>

        <FormCard title="Clinical Findings">
          <div className="appointment-visit-field-grid is-three-columns">
            <TextField id="blood-pressure" label="Blood Pressure" value={form.bloodPressure} placeholder="--/-- mmHg" readOnly={isReadOnly} error={validationErrors.bloodPressure} onChange={(value) => updateForm("bloodPressure", value)} />
            <TextField id="temperature" label="Temperature" value={form.temperature} placeholder="--.- C" readOnly={isReadOnly} error={validationErrors.temperature} onChange={(value) => updateForm("temperature", value)} />
            {isFollowUp ? <TextField id="fundal-height" label="Fundal Height" value={form.fundalHeight} placeholder="-- cm" readOnly={isReadOnly} error={validationErrors.fundalHeight} onChange={(value) => updateForm("fundalHeight", value)} /> : <TextField id="respiratory-rate" label="Respiratory Rate" value={form.respiratoryRate} placeholder="breaths/min" readOnly={isReadOnly} error={validationErrors.respiratoryRate} onChange={(value) => updateForm("respiratoryRate", value)} />}
            <TextField id="weight" label="Weight" value={form.weight} placeholder="-- kg" readOnly={isReadOnly} error={validationErrors.weight} onChange={(value) => updateForm("weight", value)} />
            {!isFollowUp ? <TextField id="height" label="Height" value={form.height} placeholder="-- cm" readOnly={isReadOnly} error={validationErrors.height} onChange={(value) => updateForm("height", value)} /> : null}
            {!isFollowUp ? <TextField id="oxygen-saturation" label="Oxygen Saturation" value={form.oxygenSaturation} placeholder="%" readOnly={isReadOnly} error={validationErrors.oxygenSaturation} onChange={(value) => updateForm("oxygenSaturation", value)} /> : null}
            {!isFollowUp ? <TextField id="fundal-height" label="Fundal Height" value={form.fundalHeight} placeholder="-- cm" readOnly={isReadOnly} error={validationErrors.fundalHeight} onChange={(value) => updateForm("fundalHeight", value)} /> : null}
            <TextField id="fetal-heart-rate" label="Fetal Heart Rate" value={form.fetalHeartRate} placeholder="--- bpm" readOnly={isReadOnly} error={validationErrors.fetalHeartRate} onChange={(value) => updateForm("fetalHeartRate", value)} />
            {isFollowUp ? <SelectField id="baby-position" label="Baby Position" value={form.babyPosition} options={babyPositionOptions} readOnly={isReadOnly} onChange={(value) => updateForm("babyPosition", value)} /> : null}
            <TextField id="estimated-fetal-weight" label="Estimated Fetal Weight" value={form.estimatedFetalWeight} placeholder="-- kg" readOnly={isReadOnly} error={validationErrors.estimatedFetalWeight} onChange={(value) => updateForm("estimatedFetalWeight", value)} />
          </div>
          <div className="appointment-visit-clinical-row">
            <ChoiceGroup id="fetal-movement" label="Fetal Movement" value={form.fetalMovement} options={["Present", "Absent", "Not Applicable"]} readOnly={isReadOnly} onChange={(value) => updateForm("fetalMovement", value)} />
            {!isFollowUp ? <TextField id="baby-position" label="Baby Position" value={form.babyPosition} placeholder="e.g. Cephalic" readOnly={isReadOnly} onChange={(value) => updateForm("babyPosition", value)} /> : null}
          </div>
          {isFollowUp ? (
            <details className="appointment-visit-optional-disclosure">
              <summary>Additional Clinical Measurements</summary>
              <div className="appointment-visit-field-grid is-three-columns">
                <TextField id="respiratory-rate" label="Respiratory Rate" value={form.respiratoryRate} placeholder="breaths/min" readOnly={isReadOnly} error={validationErrors.respiratoryRate} onChange={(value) => updateForm("respiratoryRate", value)} />
                <TextField id="height" label="Height" value={form.height} placeholder="-- cm" readOnly={isReadOnly} error={validationErrors.height} onChange={(value) => updateForm("height", value)} />
                <TextField id="oxygen-saturation" label="Oxygen Saturation" value={form.oxygenSaturation} placeholder="%" readOnly={isReadOnly} error={validationErrors.oxygenSaturation} onChange={(value) => updateForm("oxygenSaturation", value)} />
              </div>
            </details>
          ) : null}
          <TextAreaField id="additional-findings" label="Additional Findings" maxLength={500} size="compact" value={form.additionalFindings} placeholder="Enter additional findings..." readOnly={isReadOnly} onChange={(value) => updateForm("additionalFindings", value)} />
        </FormCard>

        {isFollowUp ? (
          <details className="appointment-visit-optional-disclosure appointment-visit-lifestyle-disclosure">
            <summary>Additional Lifestyle Assessment</summary>
            <div className="appointment-visit-field-grid is-three-columns">
              <SelectField id="smoking-status" label="Smoking Status" value={form.smokingStatus} options={["Never", "Former", "Current"]} readOnly={isReadOnly} onChange={(value) => updateForm("smokingStatus", value)} />
              <SelectField id="drug-use" label="Drug Use" value={form.drugUse} options={["No", "Yes"]} readOnly={isReadOnly} onChange={(value) => updateForm("drugUse", value)} />
              <SelectField id="physical-activity" label="Physical Activity" value={form.physicalActivity} options={["Low", "Moderate", "High"]} readOnly={isReadOnly} onChange={(value) => updateForm("physicalActivity", value)} />
              <SelectField id="alcohol-intake" label="Alcohol Intake" value={form.alcoholIntake} options={["Never", "Occasionally", "Regularly"]} readOnly={isReadOnly} onChange={(value) => updateForm("alcoholIntake", value)} />
              <SelectField id="diet" label="Diet" value={form.diet} options={["Balanced", "Needs Improvement", "Special Diet"]} readOnly={isReadOnly} onChange={(value) => updateForm("diet", value)} />
            </div>
            {form.lifestyleAssessment ? <p className="appointment-visit-legacy-note"><strong>Previous notes:</strong> {form.lifestyleAssessment}</p> : null}
          </details>
        ) : (
          <FormCard title="Lifestyle Assessment">
            <div className="appointment-visit-field-grid is-three-columns">
              <SelectField id="smoking-status" label="Smoking Status" value={form.smokingStatus} options={["Never", "Former", "Current"]} readOnly={isReadOnly} onChange={(value) => updateForm("smokingStatus", value)} />
              <SelectField id="drug-use" label="Drug Use" value={form.drugUse} options={["No", "Yes"]} readOnly={isReadOnly} onChange={(value) => updateForm("drugUse", value)} />
              <SelectField id="physical-activity" label="Physical Activity" value={form.physicalActivity} options={["Low", "Moderate", "High"]} readOnly={isReadOnly} onChange={(value) => updateForm("physicalActivity", value)} />
              <SelectField id="alcohol-intake" label="Alcohol Intake" value={form.alcoholIntake} options={["Never", "Occasionally", "Regularly"]} readOnly={isReadOnly} onChange={(value) => updateForm("alcoholIntake", value)} />
              <SelectField id="diet" label="Diet" value={form.diet} options={["Balanced", "Needs Improvement", "Special Diet"]} readOnly={isReadOnly} onChange={(value) => updateForm("diet", value)} />
            </div>
            {form.lifestyleAssessment ? <p className="appointment-visit-legacy-note"><strong>Previous notes:</strong> {form.lifestyleAssessment}</p> : null}
          </FormCard>
        )}

        <FormCard
          title="Vaccination Status"
          action={!isReadOnly ? (
            <button className="appointment-visit-add-button" type="button" disabled={Boolean(vaccinationEditor)} onClick={() => beginVaccination()}>
              <Plus size={15} aria-hidden="true" /> Add Vaccination
            </button>
          ) : null}
        >
          {vaccinationEditor ? (
            <div className="appointment-visit-inline-editor is-vaccination-editor">
              <TextField id="vaccine-name" label="Vaccine Name" value={vaccinationEditor.vaccineName} onChange={(value) => setVaccinationEditor((current) => ({ ...current, vaccineName: value }))} />
              <TextField id="vaccine-lot" label="Lot Number" value={vaccinationEditor.lotNumber} onChange={(value) => setVaccinationEditor((current) => ({ ...current, lotNumber: value }))} />
              <TextField id="vaccine-date" label="Date Given" type="date" value={vaccinationEditor.dateGiven} onChange={(value) => setVaccinationEditor((current) => ({ ...current, dateGiven: value }))} />
              <div className="appointment-visit-editor-actions">
                <button type="button" onClick={saveVaccination} disabled={!vaccinationEditor.vaccineName.trim()}>Save Row</button>
                <button type="button" onClick={() => setVaccinationEditor(null)}>Cancel</button>
              </div>
            </div>
          ) : null}
          <div className="appointment-visit-table-wrap">
            <table className="appointment-visit-table">
              <thead><tr><th>Vaccine Name</th><th>Lot Number</th><th>Date Given</th><th>Action</th></tr></thead>
              <tbody>
                {form.vaccinations.length ? form.vaccinations.map((row, index) => (
                  <tr key={`${row.vaccineName}-${row.dateGiven}-${index}`}>
                    <td>{row.vaccineName}</td><td>{row.lotNumber || "Not recorded"}</td><td>{row.dateGiven || "Not recorded"}</td>
                    <td className="appointment-visit-table-actions">
                      {!isReadOnly ? <button type="button" aria-label={`Edit ${row.vaccineName}`} title="Edit vaccination" onClick={() => beginVaccination(index)}><Pencil size={14} aria-hidden="true" /></button> : null}
                      {!isReadOnly ? <button type="button" aria-label={`Delete ${row.vaccineName}`} title="Delete vaccination" onClick={() => removeVaccination(index)}><Trash2 size={14} aria-hidden="true" /></button> : null}
                    </td>
                  </tr>
                )) : <tr><td colSpan="4" className="appointment-visit-empty-row">No vaccinations recorded.</td></tr>}
              </tbody>
            </table>
          </div>
          {form.vaccinationStatus ? <p className="appointment-visit-legacy-note"><strong>Previous notes:</strong> {form.vaccinationStatus}</p> : null}
        </FormCard>

        <div className="appointment-visit-paired-grid appointment-visit-review-grid">
          <FormCard title="Laboratory Review (if applicable)" className="appointment-visit-review-card">
            <SelectField id="laboratory-test-type" label="Test Type" value={form.laboratoryTestType} options={["Complete Blood Count (CBC)", "Urinalysis", "Blood Glucose", "Blood Type and Rh", "Other"]} readOnly={isReadOnly} onChange={(value) => updateForm("laboratoryTestType", value)} />
            <TextAreaField id="laboratory-result" label="Result Summary" maxLength={500} size="compact" value={form.laboratoryResultSummary} placeholder="Enter result summary..." readOnly={isReadOnly} onChange={(value) => updateForm("laboratoryResultSummary", value)} />
            <TextAreaField id="laboratory-interpretation" label="Interpretation" maxLength={500} size="compact" value={form.laboratoryInterpretation} placeholder="Enter interpretation..." readOnly={isReadOnly} onChange={(value) => updateForm("laboratoryInterpretation", value)} />
            <ChoiceGroup id="laboratory-attached" label="Laboratory Report Attached" value={form.laboratoryReportAttached} options={["Yes", "No"]} readOnly={isReadOnly} onChange={(value) => updateReportAttached("laboratory", value)} />
            {form.laboratoryReportAttached === "Yes" ? <AttachmentField id="laboratory-report" label="Laboratory report file" file={laboratoryFile} existingFile={form.laboratoryAttachment} error={validationErrors.laboratoryAttachment} readOnly={isReadOnly} onChange={(file) => selectReportFile("laboratory", file)} onClear={() => selectReportFile("laboratory", null)} /> : null}
          </FormCard>

          <FormCard title="Ultrasound Review (if applicable)" className="appointment-visit-review-card">
            <TextField id="ultrasound-date" label="Date of Visit" type="date" value={form.ultrasoundVisitDate} readOnly={isReadOnly} onChange={(value) => updateForm("ultrasoundVisitDate", value)} />
            <TextAreaField id="ultrasound-findings" label="Findings" maxLength={500} size="medium" value={form.ultrasoundFindings} placeholder="Enter findings..." readOnly={isReadOnly} onChange={(value) => updateForm("ultrasoundFindings", value)} />
            <ChoiceGroup id="ultrasound-attached" label="Ultrasound Report Attached" value={form.ultrasoundReportAttached} options={["Yes", "No"]} readOnly={isReadOnly} onChange={(value) => updateReportAttached("ultrasound", value)} />
            {form.ultrasoundReportAttached === "Yes" ? <AttachmentField id="ultrasound-report" label="Ultrasound report file" file={ultrasoundFile} existingFile={form.ultrasoundAttachment} error={validationErrors.ultrasoundAttachment} readOnly={isReadOnly} onChange={(file) => selectReportFile("ultrasound", file)} onClear={() => selectReportFile("ultrasound", null)} /> : null}
          </FormCard>
        </div>

        <FormCard title="Assessment">
          <TextAreaField id="assessment" label="Assessment details" required maxLength={500} size="medium" value={form.assessment} placeholder="Enter assessment..." readOnly={isReadOnly} error={validationErrors.assessment} onChange={(value) => updateForm("assessment", value)} />
        </FormCard>

        <FormCard title="Diagnosis">
          <TextAreaField id="diagnosis" label="Diagnosis details" required maxLength={500} size="compact" value={form.diagnosis} placeholder="Enter diagnosis..." readOnly={isReadOnly} error={validationErrors.diagnosis} onChange={(value) => updateForm("diagnosis", value)} />
        </FormCard>

        <div className="appointment-visit-paired-grid">
          <FormCard title="Actions Taken">
            <CheckboxGrid id="actions-taken" options={actionOptions} selected={form.actionSelections} readOnly={isReadOnly} onChange={(value) => updateForm("actionSelections", value)} />
            {Array.isArray(form.actionSelections) && form.actionSelections.includes("Other") ? (
              <TextField id="actions-other-details" label="Other action details" value={form.actionsOtherDetails} placeholder="Enter other action details" readOnly={isReadOnly} onChange={(value) => updateForm("actionsOtherDetails", value)} />
            ) : null}
            {form.actionsTaken ? <p className="appointment-visit-legacy-note"><strong>Previous notes:</strong> {form.actionsTaken}</p> : null}
          </FormCard>
          <FormCard title="Pregnancy Journey Update">
            <CheckboxGrid id="journey-milestones" options={journeyOptions} selected={form.journeyMilestones} readOnly={isReadOnly} onChange={(value) => updateForm("journeyMilestones", value)} />
            {form.pregnancyJourneyUpdate ? <p className="appointment-visit-legacy-note"><strong>Previous notes:</strong> {form.pregnancyJourneyUpdate}</p> : null}
          </FormCard>
        </div>

        <FormCard
          title="Prescription"
          action={!isReadOnly ? (
            <button className="appointment-visit-add-button" type="button" disabled={Boolean(medicationEditor)} onClick={() => beginMedication()}>
              <Plus size={15} aria-hidden="true" /> Add Medication
            </button>
          ) : null}
        >
          <p className="appointment-visit-prescriber">Attending Physician: <strong>{appointment?.doctor_name || "Not assigned"}</strong></p>
          {medicationEditor ? (
            <div className="appointment-visit-inline-editor is-medication-editor">
              <TextField id="medication-name" label="Medication" value={medicationEditor.medication} onChange={(value) => setMedicationEditor((current) => ({ ...current, medication: value }))} />
              <TextField id="medication-dosage" label="Dosage" value={medicationEditor.dosage} onChange={(value) => setMedicationEditor((current) => ({ ...current, dosage: value }))} />
              <TextField id="medication-frequency" label="Frequency" value={medicationEditor.frequency} onChange={(value) => setMedicationEditor((current) => ({ ...current, frequency: value }))} />
              <TextField id="medication-duration" label="Duration" value={medicationEditor.duration} onChange={(value) => setMedicationEditor((current) => ({ ...current, duration: value }))} />
              <div className="appointment-visit-editor-actions">
                <button type="button" onClick={saveMedication} disabled={!medicationEditor.medication.trim()}>Save Row</button>
                <button type="button" onClick={() => setMedicationEditor(null)}>Cancel</button>
              </div>
            </div>
          ) : null}
          <div className="appointment-visit-table-wrap">
            <table className="appointment-visit-table">
              <thead><tr><th>Medication</th><th>Dosage</th><th>Frequency</th><th>Duration</th><th>Action</th></tr></thead>
              <tbody>
                {form.medications.length ? form.medications.map((row, index) => (
                  <tr key={`${row.medication}-${index}`}>
                    <td>{row.medication}</td><td>{row.dosage || "Not recorded"}</td><td>{row.frequency || "Not recorded"}</td><td>{row.duration || "Not recorded"}</td>
                    <td className="appointment-visit-table-actions">
                      {!isReadOnly ? <button type="button" aria-label={`Edit ${row.medication}`} title="Edit medication" onClick={() => beginMedication(index)}><Pencil size={14} aria-hidden="true" /></button> : null}
                      {!isReadOnly ? <button type="button" aria-label={`Delete ${row.medication}`} title="Delete medication" onClick={() => removeMedication(index)}><Trash2 size={14} aria-hidden="true" /></button> : null}
                    </td>
                  </tr>
                )) : <tr><td colSpan="5" className="appointment-visit-empty-row">No medications added.</td></tr>}
              </tbody>
            </table>
          </div>
          <TextAreaField id="prescription-instructions" label="Instructions" maxLength={500} size="compact" value={form.prescriptionInstructions} placeholder="Enter medication instructions..." readOnly={isReadOnly} onChange={(value) => updateForm("prescriptionInstructions", value)} />
          <AttachmentField id="prescription-file" label="Prescription attachment" file={prescriptionFile} readOnly={isReadOnly} onChange={setPrescriptionFile} onClear={() => setPrescriptionFile(null)} />
        </FormCard>

        <FormCard title="Plan / Treatment">
          <TextAreaField id="treatment-plan" label="Plan and treatment details" required maxLength={600} size="large" value={form.treatmentPlan} placeholder="Enter plan and treatment..." readOnly={isReadOnly} error={validationErrors.treatmentPlan} onChange={(value) => updateForm("treatmentPlan", value)} />
        </FormCard>

        <footer className="appointment-visit-actions">
          {canSave ? (
            <button type="submit" className="is-primary" disabled={saving}>
              {saving ? "Saving Record..." : "Save Record"}
            </button>
          ) : null}
          <button type="button" className="is-secondary" onClick={() => returnFromVisit(existingRecord?.id || "")}>
            {isReadOnly
              ? medicalRecordReturnContext
                ? "Back to Medical Record"
                : "Back to Appointments"
              : "Cancel"}
          </button>
        </footer>
      </form>

      {eddConfirmation ? (
        <div className="appointment-visit-confirmation-backdrop" role="presentation">
          <section
            className="appointment-visit-confirmation"
            role="dialog"
            aria-modal="true"
            aria-labelledby="appointment-visit-edd-title"
            aria-describedby="appointment-visit-edd-description"
          >
            <span className="appointment-visit-confirmation-icon" aria-hidden="true">!</span>
            <h2 id="appointment-visit-edd-title">Update Current Pregnancy EDD?</h2>
            <p id="appointment-visit-edd-description">
              The Expected Delivery Date was changed from{" "}
              <strong>{formatClinicalDate(eddConfirmation.current)}</strong> to{" "}
              <strong>{formatClinicalDate(eddConfirmation.next)}</strong>. Update the patient&apos;s
              current pregnancy record?
            </p>
            <div>
              <button
                type="button"
                className="is-secondary"
                disabled={saving}
                autoFocus
                onClick={() => setEddConfirmation(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="is-primary"
                disabled={saving}
                onClick={() => {
                  setEddConfirmation(null);
                  saveRecord({ updateCurrentEdd: true });
                }}
              >
                {saving ? "Updating..." : "Update EDD"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
