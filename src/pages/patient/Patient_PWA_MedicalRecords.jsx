import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { supabase } from "../../lib/supabaseClient";
import {
  calculateClinicalBmi,
  getClinicalVisitHeight,
  getClinicalVisitWeight,
  getLatestInitialVisitHeight,
  isCompletedClinicalVisitRecord,
  isFollowUpClinicalVisit,
  isMeaningfulClinicalValue,
  normalizeClinicalVisitFormData,
} from "../../lib/clinicalVisitData";
import { PatientPageHeader } from "../../components/patient/PatientPwaUi";
import {
  getPatientPwaSessionCache,
  setPatientPwaSessionCache,
} from "../../lib/patientPwaSessionCache";
import "../../styles/patient-PWA-medicalrecords.css";

const medicalRecordColumns =
  "id, patient_id, schedule_id, doctor_id, patient_name, type, title, notes, file_name, file_type, file_data_url, form_data, uploaded_at, uploaded_by, created_at";

const scheduleColumns =
  "id, maternal_appointment_id, patient_id, doctor_id, doctor_name, title, start_time, end_time, status";

const MANILA_TIME_ZONE = "Asia/Manila";
const MEDICAL_RECORD_CACHE_VERSION = 2;

const findingUnits = {
  "blood pressure": "mmHg",
  weight: "kg",
  temperature: "C",
  temp: "C",
  "heart rate": "bpm",
  height: "cm",
  bmi: "kg/m2",
  "fundal height": "cm",
  "fetal heart rate": "bpm",
  "respiratory rate": "breaths/min",
  "oxygen saturation": "%",
};

function getFormData(row) {
  return normalizeClinicalVisitFormData(row);
}

function cleanRecordValue(value) {
  return isMeaningfulClinicalValue(value) ? String(value).trim() : "";
}

function toList(value) {
  if (Array.isArray(value)) return value.flatMap(toList);
  return cleanRecordValue(value)
    .split(/\r?\n|;/)
    .map(cleanRecordValue)
    .filter(Boolean);
}

function firstRecordValue(...values) {
  return values.map(cleanRecordValue).find(Boolean) || "";
}

function firstRecordList(...values) {
  return values.map(toList).find((items) => items.length) || [];
}

function formatGestationalAge(value, fallback = "Not recorded") {
  const text = cleanRecordValue(value);
  if (!text) return fallback;
  return /^\d+(?:\.\d+)?$/.test(text) ? `${text} Weeks` : text;
}

function toValidDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatLongDate(value, fallback = "-") {
  if (!value) return fallback;
  const date = toValidDate(value);

  if (!date) {
    return String(value);
  }

  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: MANILA_TIME_ZONE,
  });
}

function formatDayTime(dateValue, timeValue) {
  const date = toValidDate(dateValue);
  const day = date
    ? date.toLocaleDateString("en-US", {
        weekday: "long",
        timeZone: MANILA_TIME_ZONE,
      })
    : "Visit";

  if (timeValue) {
    return `${day} - ${timeValue}`;
  }

  if (timeValue === null || !date) return day;

  return `${day} - ${date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: MANILA_TIME_ZONE,
  })}`;
}

function normalizeVisitTime(value) {
  const text = cleanRecordValue(value);
  const clock = text.match(/^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\s*(AM|PM)?$/i);
  if (!clock) return "";
  let hour = Number(clock[1]);
  if (clock[4]) {
    if (hour < 1 || hour > 12) return "";
    hour = (hour % 12) + (clock[4].toUpperCase() === "PM" ? 12 : 0);
  } else if (hour > 23) {
    return "";
  }
  return `${String(hour).padStart(2, "0")}:${clock[2]}:${clock[3] || "00"}`;
}

function resolveVisitTiming(row, formData, linkedSchedule) {
  const sources = [
    [linkedSchedule?.start_time],
    [firstRecordValue(formData.appointmentDate, formData.appointment_date),
      firstRecordValue(formData.appointmentTime, formData.appointment_time)],
    [firstRecordValue(formData.visitDate, formData.visit_date),
      firstRecordValue(formData.visitTime, formData.visit_time)],
    [row.uploaded_at],
    [row.created_at],
  ];

  for (const [source, time] of sources) {
    const text = cleanRecordValue(source);
    if (!text) continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      const calendarDate = toValidDate(`${text}T00:00:00Z`);
      if (!calendarDate || calendarDate.toISOString().slice(0, 10) !== text) continue;
      const clock = normalizeVisitTime(time);
      const date = toValidDate(`${text}T${clock || "00:00:00"}+08:00`);
      return { date, time: clock ? time : null };
    }
    const date = toValidDate(text);
    if (date) return { date, time: undefined };
  }
  return { date: "", time: null };
}

function normalizeMeasurement(value, unit = "", fallbackUnit = "") {
  const rawValue = value && typeof value === "object" ? value.value ?? value.result : value;
  const text = cleanRecordValue(rawValue);
  const explicitUnit = firstRecordValue(value?.unit, unit);
  const embeddedUnit = text.match(/^(-?\d+(?:\.\d+)?)\s*(kg|g|kilograms?|grams?)$/i);
  return {
    value: embeddedUnit ? embeddedUnit[1] : text,
    unit: embeddedUnit ? embeddedUnit[2] : explicitUnit || fallbackUnit,
  };
}

function getEstimatedFetalWeight(formData, clinicalFindings) {
  // Current top-level camelCase saves use kg; the Doctor reader's legacy
  // snake_case/nested measurements use g. Explicit stored units always win.
  const sources = [
    [formData.estimatedFetalWeight, "kg", formData.estimatedFetalWeightUnit],
    [formData.estimated_fetal_weight, "g", formData.estimated_fetal_weight_unit],
    [clinicalFindings.estimatedFetalWeight, "g", clinicalFindings.estimatedFetalWeightUnit],
    [clinicalFindings.estimated_fetal_weight, "g", clinicalFindings.estimated_fetal_weight_unit],
  ];
  for (const [value, fallbackUnit, unit] of sources) {
    const measurement = normalizeMeasurement(value, unit, fallbackUnit);
    if (measurement.value) return measurement;
  }
  return { value: "", unit: "" };
}

function normalizeFinding(item) {
  if (typeof item === "string") return { label: item, value: "-", unit: "" };
  const label = (Array.isArray(item) ? item[0] : item?.label || item?.name) || "Finding";
  const rawValue = Array.isArray(item) ? item[1] : item?.value ?? item?.result;
  const unit = Array.isArray(item) ? item[2] : item?.unit;
  const normalizedLabel = String(label).trim().toLowerCase();
  const measurement = normalizedLabel === "estimated fetal weight"
    ? normalizeMeasurement(rawValue, unit)
    : { value: cleanRecordValue(rawValue), unit: cleanRecordValue(unit) || findingUnits[normalizedLabel] || "" };
  return { label, value: measurement.value || "-", unit: measurement.unit };
}

function normalizeFindings(formData, baselineHeight = "") {
  const clinicalFindings = formData.clinicalFindings || formData.clinical_findings || {};
  const isFollowUp = isFollowUpClinicalVisit(formData);
  const currentHeight = getClinicalVisitHeight(formData);
  const displayHeight = currentHeight || (isFollowUp ? baselineHeight : "");
  const heightLabel = isFollowUp && !currentHeight && displayHeight
    ? "Baseline Height"
    : "Height";
  const weight = getClinicalVisitWeight(formData);
  const bmi =
    calculateClinicalBmi(weight, displayHeight) ||
    cleanRecordValue(clinicalFindings.bmi || formData.bmi);
  const fetalWeight = getEstimatedFetalWeight(formData, clinicalFindings);
  const findingValue = (camelKey, snakeKey = camelKey) => firstRecordValue(
    formData[camelKey], formData[snakeKey], clinicalFindings[camelKey], clinicalFindings[snakeKey]
  );

  if (Array.isArray(formData.findings) && formData.findings.length) {
    const findings = formData.findings
      .map(normalizeFinding)
      .filter((item) => {
        const label = String(item.label || "").trim().toLowerCase();
        return !["heart rate", "maternal heart rate", "height", "baseline height", "bmi"].includes(label);
      });

    if (displayHeight) findings.push({ label: heightLabel, value: displayHeight, unit: "cm" });
    if (bmi) findings.push({ label: "BMI", value: bmi, unit: "kg/m²" });
    return findings;
  }

  return [
    { label: "Blood Pressure", value: findingValue("bloodPressure", "blood_pressure") || "-", unit: "mmHg" },
    { label: "Weight", value: weight || "-", unit: "kg" },
    { label: "Temp", value: findingValue("temperature") || "-", unit: "C" },
    { label: "Respiratory Rate", value: findingValue("respiratoryRate", "respiratory_rate"), unit: "breaths/min" },
    { label: heightLabel, value: displayHeight, unit: "cm" },
    { label: "BMI", value: bmi, unit: "kg/m²" },
    { label: "Oxygen Saturation", value: findingValue("oxygenSaturation", "oxygen_saturation"), unit: "%" },
    { label: "Fetal Heart Rate", value: clinicalFindings.fetalHeartRate || formData.fetalHeartRate || "-", unit: "bpm" },
    { label: "Fundal Height", value: clinicalFindings.fundalHeight || formData.fundalHeight || "-", unit: "cm" },
    { label: "Estimated Fetal Weight", ...fetalWeight },
    { label: "Baby Position", value: clinicalFindings.babyPosition || formData.babyPosition, unit: "" },
    { label: "Fetal Movement", value: clinicalFindings.fetalMovement || formData.fetalMovement, unit: "" },
    { label: "Additional Findings", value: clinicalFindings.additionalFindings || formData.additionalFindings, unit: "" },
  ].filter((item) => cleanRecordValue(item.value) || ["Blood Pressure", "Weight", "Temp", "Fetal Heart Rate", "Fundal Height"].includes(item.label));
}

function normalizeAssessment(formData) {
  const values = firstRecordList(formData.assessment, formData.clinicalAssessment, formData.clinical_assessment);
  return values.length ? values : ["No assessment recorded."];
}

function normalizeTreatment(formData) {
  const values = [
    ...toList(formData.treatment),
    ...firstRecordList(formData.treatmentPlan, formData.treatment_plan, formData.planTreatment, formData.plan_treatment, formData.plan),
    ...firstRecordList(formData.followUpInstructions, formData.follow_up_instructions),
  ];
  return values.length ? [...new Set(values)] : ["No treatment plan recorded."];
}

function normalizeMedication(value) {
  if (!value || typeof value !== "object") return toList(value);
  const name = firstRecordValue(value.medication, value.name, value.medicationName, value.medication_name);
  if (!name) return [];
  return [[name, firstRecordValue(value.dosage, value.dose), cleanRecordValue(value.frequency),
    cleanRecordValue(value.duration), firstRecordValue(value.instructions, value.instruction)]
    .filter(Boolean).join(" - ")];
}

function normalizePrescriptions(formData) {
  const prescription = formData.prescription && typeof formData.prescription === "object" && !Array.isArray(formData.prescription)
    ? formData.prescription : {};
  const legacy = formData.prescriptions;
  const legacyObject = legacy && typeof legacy === "object" && !Array.isArray(legacy) ? legacy : {};
  const medicationLists = [formData.medications, prescription.medications, legacyObject.medications];
  const values = [
    ...medicationLists.flatMap((items) => Array.isArray(items) ? items.flatMap(normalizeMedication) : []),
    ...(Array.isArray(legacy) ? legacy.flatMap(normalizeMedication) : toList(legacy)),
    ...toList(formData.prescription),
    ...firstRecordList(formData.prescriptionInstructions, formData.prescription_instructions, prescription.instructions, legacyObject.instructions),
  ];
  return [...new Set(values)];
}

function normalizeDiagnosticResults(formData) {
  const laboratory = firstRecordList(formData.laboratoryResultSummary, formData.laboratory_result_summary,
    formData.laboratoryReview?.resultSummary, formData.laboratoryReview?.result_summary,
    formData.laboratoryReview);
  const ultrasound = firstRecordList(formData.ultrasoundFindings, formData.ultrasound_findings,
    formData.ultrasoundReview?.findings, formData.ultrasoundReview);
  return [...new Set([
    ...toList(formData.diagnosticResults),
    ...laboratory.map((value) => `Laboratory: ${value}`),
    ...ultrasound.map((value) => `Ultrasound: ${value}`),
  ])];
}

function normalizeObstetric(formData) {
  const obstetric = Array.isArray(formData.obstetric) ? formData.obstetric : [];
  const pregnancyStatus =
    formData.pregnancyStatus && typeof formData.pregnancyStatus === "object"
      ? formData.pregnancyStatus
      : {};

  if (obstetric.length) {
    return obstetric
      .map((item) => {
        const label = (Array.isArray(item) ? item[0] : item?.label || item?.name) || "Information";
        const value = Array.isArray(item) ? item[1] : item?.value;
        return {
          label,
          value: /^(gestational age|ga)$/i.test(String(label).trim())
            ? formatGestationalAge(value, "-") : cleanRecordValue(value) || "-",
          wide: Boolean(item?.wide),
        };
      })
      .filter((item) => String(item.label).trim().toLowerCase() !== "follow-up date");
  }

  return [
    {
      label: "Gestational Age",
      value: formatGestationalAge(formData.gestationalAge, "-"),
    },
    {
      label: "Pregnancy Status",
      value:
        pregnancyStatus.riskLevel ||
        cleanRecordValue(formData.riskLevel) ||
        cleanRecordValue(formData.pregnancyRiskLevel) ||
        cleanRecordValue(formData.pregnancyStatus) ||
        "-",
    },
    {
      label: "Expected Delivery Date",
      value: pregnancyStatus.expectedDeliveryDate || formData.expectedDeliveryDate || "-",
      wide: true,
    },
  ];
}

function normalizeAttachmentMeta(value, fallbackLabel = "Medical report") {
  if (!value || typeof value !== "object") return null;

  const path = cleanRecordValue(value.path);
  const name =
    cleanRecordValue(value.name) ||
    cleanRecordValue(value.fileName) ||
    cleanRecordValue(value.filename) ||
    fallbackLabel;
  const type =
    cleanRecordValue(value.type) ||
    cleanRecordValue(value.mimeType) ||
    "application/pdf";
  const size = Number(value.size || 0) || 0;

  if (!path && !cleanRecordValue(value.url)) return null;

  return {
    name,
    type,
    size,
    path,
    url: cleanRecordValue(value.url),
  };
}

function getClinicalAttachments(formData, row) {
  const laboratoryReview =
    formData.laboratoryReview && typeof formData.laboratoryReview === "object"
      ? formData.laboratoryReview
      : {};
  const ultrasoundReview =
    formData.ultrasoundReview && typeof formData.ultrasoundReview === "object"
      ? formData.ultrasoundReview
      : {};

  const candidates = [
    {
      kind: "Laboratory",
      value:
        formData.laboratoryAttachment ||
        laboratoryReview.attachment ||
        formData.labAttachment ||
        formData.labReview?.attachment,
    },
    {
      kind: "Ultrasound",
      value:
        formData.ultrasoundAttachment ||
        ultrasoundReview.attachment ||
        formData.ultrasoundReportAttachment ||
        formData.ultrasound?.attachment,
    },
  ];

  const attachments = candidates
    .map(({ kind, value }) => {
      const attachment = normalizeAttachmentMeta(value, `${kind} report.pdf`);
      return attachment ? { ...attachment, kind } : null;
    })
    .filter(Boolean);

  // Preserve any legacy/general medical-record attachment too.
  if (row.file_name) {
    attachments.push({
      kind: "Medical Record",
      name: row.file_name,
      type: row.file_type || "File",
      size: 0,
      path: "",
      url: row.file_data_url || "",
    });
  }

  const seen = new Set();
  return attachments.filter((attachment) => {
    const key = attachment.path || `${attachment.kind}:${attachment.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatAttachmentSize(size) {
  const bytes = Number(size || 0);
  if (!bytes) return "PDF report";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function createAttachmentUrl(attachment) {
  if (attachment.url) return attachment.url;

  if (!attachment.path) {
    throw new Error("This report does not have a valid storage path.");
  }

  const { data, error } = await supabase.storage
    .from("medical-records")
    .createSignedUrl(attachment.path, 600);

  if (error || !data?.signedUrl) {
    throw error || new Error("Unable to create a secure report link.");
  }

  return data.signedUrl;
}

function mapMedicalRecord(row, linkedSchedule = null, baselineHeight = "") {
  const formData = getFormData(row);

  // The linked appointment remains authoritative. Unlinked records use the
  // producer's saved visit date/time before the database creation timestamp.
  const timing = resolveVisitTiming(row, formData, linkedSchedule);
  const visitDate = timing.date;
  const displayDate = formatLongDate(visitDate);
  const dayTime = formatDayTime(visitDate, timing.time);
  const complaint = firstRecordValue(formData.chiefComplaint, formData.chief_complaint, formData.complaint)
    || "No chief complaint recorded.";
  const diagnosis = firstRecordValue(formData.diagnosis, formData.finalDiagnosis, formData.final_diagnosis)
    || "No diagnosis recorded.";

  const appointmentReference = formatAppointmentReference(
    linkedSchedule?.maternal_appointment_id ||
      formData.displayAppointmentId ||
      formData.appointmentId ||
      formData.maternalAppointmentId ||
      row.schedule_id ||
      ""
  );

  const doctorName =
    cleanRecordValue(linkedSchedule?.doctor_name) ||
    cleanRecordValue(formData.attendingPhysician) ||
    cleanRecordValue(formData.doctorName) ||
    cleanRecordValue(formData.doctor) ||
    "Doctor not recorded";

  return {
    id: row.id,
    date: displayDate,
    dayTime,
    visitType: formData.visitType || row.type || row.title || "Medical Record",
    gestationalAge: formatGestationalAge(formData.gestationalAge),
    doctor: doctorName,
    appointmentReference,
    createdDate: formatLongDate(row.uploaded_at, "Not recorded"),
    updatedDate: formData.updatedAt || "Not recorded",
    recordStatus: formatStatusLabel(
      formData.recordStatus || formData.record_status || "completed"
    ),
    complaint,
    findings: normalizeFindings(formData, baselineHeight),
    assessment: normalizeAssessment(formData),
    obstetric: normalizeObstetric(formData),
    treatment: normalizeTreatment(formData),
    diagnosis,
    doctorOrder: firstRecordValue(formData.doctorOrder, formData.doctor_order),
    prescriptions: normalizePrescriptions(formData),
    diagnosticResults: normalizeDiagnosticResults(formData),
    attachments: getClinicalAttachments(formData, row),
    sortTime: toValidDate(visitDate)?.getTime() || 0,
    uploadedTime: toValidDate(row.uploaded_at)?.getTime() || 0,
    createdTime: toValidDate(row.created_at)?.getTime() || 0,
    isDraft: formData.isDraft || formData.is_draft || false,
    deleted: formData.deleted ?? false,
  };
}

function compareMedicalRecords(first, second) {
  const timeDifference = (second.sortTime || 0) - (first.sortTime || 0)
    || (second.uploadedTime || 0) - (first.uploadedTime || 0)
    || (second.createdTime || 0) - (first.createdTime || 0);
  if (timeDifference) return timeDifference;
  const firstId = String(first.id || "");
  const secondId = String(second.id || "");
  return secondId > firstId ? 1 : secondId < firstId ? -1 : 0;
}

function acceptMedicalRecordCache(cache, patientId) {
  // Older mapped snapshots discarded draft/deletion flags and use the previous
  // clinical mappings. Refresh them instead of displaying unverifiable entries.
  if (cache?.version !== MEDICAL_RECORD_CACHE_VERSION) return null;
  return {
    ...cache,
    patientRecords: (cache.patientRecords || []).filter((record) =>
      record.id !== `registration-${patientId}` && isCompletedClinicalVisitRecord(record)
    ).sort(compareMedicalRecords),
  };
}

function formatAppointmentReference(value) {
  const text = String(value || "").trim();
  if (!text) return "No appointment reference";

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
    return text.slice(0, 8);
  }

  return text.length > 24 ? text.slice(0, 8) : text;
}

function formatStatusLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "Not recorded";

  return text
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function hasMeaningfulRecordValue(value) {
  const text = String(value || "").trim();
  return Boolean(
    text &&
      !["not recorded", "no appointment reference", "n/a", "not provided"].includes(
        text.toLowerCase()
      )
  );
}

function buildRegistrationObstetricHistory(patient, obstetric) {
  return [
    { label: "Gravida (G)", value: obstetric?.gravida ?? "Not provided" },
    { label: "Para (P)", value: obstetric?.para ?? "Not provided" },
    { label: "Full Term (T)", value: obstetric?.full_term ?? "Not provided" },
    { label: "Preterm (P)", value: obstetric?.preterm ?? "Not provided" },
    { label: "Abortion/Miscarriage (A)", value: obstetric?.abortion_miscarriage ?? "Not provided" },
    { label: "Living Children (L)", value: obstetric?.living_children ?? "Not provided" },
    {
      label: "Last Menstrual Period",
      value: formatLongDate(obstetric?.last_menstrual_period, "Not provided"),
    },
    {
      label: "Expected Delivery Date",
      value: formatLongDate(
        obstetric?.expected_delivery_date || patient?.expected_delivery_date,
        "Not provided"
      ),
    },
  ];
}

async function loadPatientRow() {
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData?.user?.id) {
    if (authError) console.warn("Patient medical record authentication lookup failed:", authError);
    return null;
  }

  const { data, error } = await supabase
    .rpc("get_patient_own_record")
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("Patient medical record patient-user lookup failed:", error);
    return null;
  }

  return data || null;
}

async function loadPatientDetailRow(table, patientId, onError) {
  if (!patientId) return null;

  let selectedObstetricId = "";
  if (table === "patient_obstetric_history") {
    // Reuse the existing server-side current pregnancy selection: EDD within
    // current_date - 14 / + 300, then updated_at, created_at and ID descending.
    // Fetch its full row because the summary intentionally omits T/P/A/L.
    const { data, error } = await supabase.rpc("get_my_patient_profile_summary");
    const summary = Array.isArray(data) ? data[0] : data;
    if (error || summary?.patient?.id !== patientId) {
      const selectionError = error || new Error("The obstetric summary did not match the authenticated Patient record.");
      console.warn("Patient medical record obstetric selection failed:", selectionError);
      onError?.(selectionError);
      return null;
    }
    selectedObstetricId = summary.obstetric?.id || "";
    if (!selectedObstetricId) return null;
  }

  let query = supabase.from(table).select("*").eq("patient_id", patientId);
  if (selectedObstetricId) {
    query = query.eq("id", selectedObstetricId);
  } else {
    query = query.limit(1);
  }
  const { data, error } = await query.maybeSingle();
  if (error) {
    console.warn(`Patient medical record ${table} lookup failed:`, error);
    onError?.(error);
    return null;
  }
  return data || null;
}

export default function PatientPWAMedicalRecords({ profile }) {
  const patientId = profile?.recordId || "";
  const [initialCache] = useState(() =>
    acceptMedicalRecordCache(getPatientPwaSessionCache(patientId, "medical-records"), patientId)
  );
  const initialCacheRef = useRef(initialCache);
  const [query, setQuery] = useState("");
  const [patientRecords, setPatientRecords] = useState(
    () => initialCache?.patientRecords || []
  );
  const [selectedRecordId, setSelectedRecordId] = useState(
    () => initialCache?.selectedRecordId || ""
  );
  const [isLoading, setIsLoading] = useState(() => !initialCache);
  const [loadError, setLoadError] = useState("");
  const [registrationHistory, setRegistrationHistory] = useState(
    () => initialCache?.registrationHistory || null
  );

  useEffect(() => {
    let active = true;

    const loadRecords = async () => {
      if (!initialCacheRef.current) {
        setIsLoading(true);
      }
      setLoadError("");

      const patient = await loadPatientRow();
      const { data, error } = patient?.id
        ? await supabase
            .from("medical_records")
            .select(medicalRecordColumns)
            .eq("patient_id", patient.id)
            .order("uploaded_at", { ascending: false })
        : { data: [], error: null };

      const formalRecords = error ? [] : (data || []).filter(isCompletedClinicalVisitRecord);
      const scheduleIds = [
        ...new Set(
          formalRecords
            .map((record) => record.schedule_id)
            .filter(Boolean)
        ),
      ];

      let schedulesById = new Map();

      if (scheduleIds.length) {
        const { data: scheduleRows, error: scheduleError } = await supabase
          .from("schedule")
          .select(scheduleColumns)
          .in("id", scheduleIds);

        if (scheduleError) {
          console.warn(
            "Patient medical record linked schedule lookup failed:",
            scheduleError
          );
        } else {
          schedulesById = new Map(
            (scheduleRows || []).map((schedule) => [schedule.id, schedule])
          );
        }
      }

      let obstetricError = null;
      const [obstetric] = patient?.id
        ? await Promise.all([
            loadPatientDetailRow("patient_obstetric_history", patient.id, (detailError) => {
              obstetricError = detailError;
            }),
            loadPatientDetailRow("patient_medical_history", patient.id),
            loadPatientDetailRow("patient_initial_assessment", patient.id),
          ])
        : [null, null, null];

      if (!active) return;

      setIsLoading(false);
      setRegistrationHistory(!patient || obstetricError
        ? {
            status: "error",
            error: "Registration / obstetric history could not be loaded. Please reopen this page to try again.",
          }
        : {
            status: "ready",
            items: buildRegistrationObstetricHistory(patient, obstetric),
          });

      if (error) {
        console.error("Patient medical records load failed:", error);
        setLoadError(`Formal medical records could not be loaded: ${error.message}`);
        if (initialCacheRef.current) return;
      }

      const baselineHeight = getLatestInitialVisitHeight(formalRecords);
      const mappedRecords = formalRecords.map((record) =>
        mapMedicalRecord(
          record,
          schedulesById.get(record.schedule_id) || null,
          baselineHeight
        )
      );

      const nextRecords = mappedRecords.sort(compareMedicalRecords);

      setPatientRecords(nextRecords);
      setSelectedRecordId((current) =>
        current && nextRecords.some((record) => record.id === current)
          ? current
          : nextRecords[0]?.id || ""
      );
    };

    loadRecords();

    const channel = supabase
      .channel(`patient-pwa-medical-records-${patientId || "unresolved"}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "medical_records",
          ...(patientId ? { filter: `patient_id=eq.${patientId}` } : {}),
        },
        loadRecords
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "schedule",
          ...(patientId ? { filter: `patient_id=eq.${patientId}` } : {}),
        },
        loadRecords
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "patients",
          ...(patientId ? { filter: `id=eq.${patientId}` } : {}),
        },
        loadRecords
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "patient_obstetric_history",
          ...(patientId ? { filter: `patient_id=eq.${patientId}` } : {}),
        },
        loadRecords
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "patient_medical_history",
          ...(patientId ? { filter: `patient_id=eq.${patientId}` } : {}),
        },
        loadRecords
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "patient_initial_assessment",
          ...(patientId ? { filter: `patient_id=eq.${patientId}` } : {}),
        },
        loadRecords
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [patientId]);

  useEffect(() => {
    if (isLoading) return;

    const snapshot = { version: MEDICAL_RECORD_CACHE_VERSION, patientRecords, selectedRecordId, registrationHistory };
    initialCacheRef.current = snapshot;
    setPatientPwaSessionCache(patientId, "medical-records", snapshot);
  }, [isLoading, patientId, patientRecords, selectedRecordId, registrationHistory]);

  const filteredRecords = useMemo(() => {
    const value = query.trim().toLowerCase();

    if (!value) return patientRecords;

    return patientRecords.filter((record) =>
      [
        record.date,
        record.dayTime,
        record.visitType,
        record.gestationalAge,
        record.doctor,
        record.complaint,
        record.diagnosis,
      ]
        .join(" ")
        .toLowerCase()
        .includes(value)
    );
  }, [patientRecords, query]);

  const selectedRecord = useMemo(() => {
    return (
      filteredRecords.find((record) => record.id === selectedRecordId) ||
      filteredRecords[0] ||
      null
    );
  }, [filteredRecords, selectedRecordId]);

  return (
    <section className="pwa-page pwa-medical-page">
      <PatientPageHeader
        title="My Medical Record"
        subtitle="Review visit summaries, clinical findings, and care plans from your clinic."
        className="pwa-medical-title"
      />

      <RegistrationObstetricHistory history={registrationHistory} />
      <div className="pwa-record-divider" aria-hidden="true" />

      <label className="pwa-medical-search" aria-label="Search medical records">
        <Icon icon="solar:magnifer-linear" />
        <input
          type="search"
          placeholder={isLoading ? "Loading records..." : "Search medical records..."}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          disabled={isLoading}
        />
      </label>

      {loadError ? (
        <p className="pwa-medical-alert">{loadError}</p>
      ) : null}

      {filteredRecords.length > 1 ? (
        <div className="pwa-medical-record-tabs" aria-label="Medical record list">
          {filteredRecords.map((record) => (
            <button
              key={record.id}
              type="button"
              className={record.id === selectedRecord?.id ? "is-active" : ""}
              onClick={() => setSelectedRecordId(record.id)}
              title={record.visitType}
              aria-label={`${record.date}, ${record.visitType}`}
            >
              <span>{record.date}</span>
              <strong>{record.visitType}</strong>
            </button>
          ))}
        </div>
      ) : null}

      {!selectedRecord ? (
        <section
          className={`pwa-medical-empty ${isLoading ? "is-loading" : ""}`}
          aria-busy={isLoading}
          role="status"
        >
          <span aria-hidden="true">
            <Icon
              icon={isLoading ? "solar:refresh-circle-bold" : "solar:folder-open-linear"}
            />
          </span>
          <div>
            <h2>
              {isLoading
                ? "Loading medical records"
                : patientRecords.length
                  ? "No matching medical record found"
                  : "No medical records available yet"}
            </h2>
            <p>
              {isLoading
                ? "Checking your latest clinic records."
                : patientRecords.length
                  ? "Try searching by visit date, doctor, visit type, or diagnosis."
                  : "Completed consultations will appear here once your clinic publishes them."}
            </p>
          </div>
        </section>
      ) : (
        <MedicalRecordCard record={selectedRecord} />
      )}
    </section>
  );
}

function RegistrationObstetricHistory({ history }) {
  return (
    <section
      className="pwa-record-section"
      aria-labelledby="pwa-registration-history-title"
      aria-busy={!history}
    >
      <h3 id="pwa-registration-history-title">Registration / Obstetric History</h3>
      {!history ? (
        <p role="status">Loading registration history...</p>
      ) : history.status === "error" ? (
        <p className="pwa-medical-alert" role="alert">{history.error}</p>
      ) : (
        <div className="pwa-obstetric-grid">
          {history.items.map((item) => (
            <div key={item.label}>
              <small>{item.label}</small>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function MedicalRecordCard({ record }) {
  return (
    <section className="pwa-medical-card">
      <aside className="pwa-medical-side">
        <div className="pwa-medical-record-date">
          <div>
            <h2>
              <Icon icon="solar:calendar-linear" />
              {record.date}
            </h2>
            <p>{record.dayTime}</p>
          </div>
          <mark>{record.recordStatus}</mark>
        </div>

        <div className="pwa-medical-primary-meta">
          <MedicalMeta
            icon="solar:camera-bold-duotone"
            label="Visit Type"
            value={record.visitType}
            tone="pink"
          />
          <MedicalMeta
            icon="solar:clock-circle-bold-duotone"
            label="Gestational Age"
            value={record.gestationalAge}
            tone="blue"
          />
          <MedicalMeta
            icon="solar:user-rounded-bold-duotone"
            label="Doctor"
            value={record.doctor}
            tone="violet"
          />
        </div>

        <details className="pwa-medical-secondary-meta">
          <summary>
            <span>Record details</span>
            <Icon icon="solar:alt-arrow-down-linear" aria-hidden="true" />
          </summary>
          <div>
            <MedicalMeta
              icon="solar:calendar-mark-bold-duotone"
              label="Appointment Reference"
              value={record.appointmentReference}
              tone="pink"
            />
            <MedicalMeta
              icon="solar:document-add-bold-duotone"
              label="Created"
              value={record.createdDate}
              tone="blue"
            />
            <MedicalMeta
              icon="solar:refresh-circle-bold-duotone"
              label="Last Updated"
              value={record.updatedDate}
              tone="violet"
            />
          </div>
        </details>
      </aside>

      <article className="pwa-medical-body">
        <header className="pwa-medical-body-header">
          <span>Visit summary</span>
          <h2>{record.visitType}</h2>
          <p>{record.doctor} · {record.gestationalAge}</p>
        </header>

        <div className="pwa-medical-top-grid">
          <section className="pwa-record-section pwa-chief-section">
            <SectionTitle title="Chief Complaint" />
            <p>{record.complaint}</p>
          </section>

          <section className="pwa-record-section pwa-findings-section">
            <SectionTitle title="Clinical Findings" />
            <div className="pwa-findings-grid">
              {record.findings.map((item) => (
                <div key={`${item.label}-${item.value}`}>
                  <small>{item.label}</small>
                  <strong>{item.value}</strong>
                  <span>{item.unit}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="pwa-record-section pwa-assessment-section">
            <SectionTitle title="Assessment" />
            <ul className="pwa-assessment-list">
              {record.assessment.map((item) => (
                <li key={item}>
                  <Icon icon="solar:check-circle-bold" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="pwa-record-divider" />

        <div className="pwa-medical-bottom-grid">
          <section className="pwa-record-section">
            <h3>Obstetric Information</h3>
            <div className="pwa-obstetric-grid">
              {record.obstetric.map((item) => (
                <div key={item.label} className={item.wide ? "is-wide" : ""}>
                  <small>{item.label}</small>
                  <strong>{item.value}</strong>
                </div>
              ))}
            </div>

            <h3 className="pwa-diagnosis-title">Diagnosis</h3>
            <div className="pwa-diagnosis-box">{record.diagnosis}</div>

            {record.doctorOrder ? (
              <>
                <h3 className="pwa-diagnosis-title">Doctor&apos;s Order</h3>
                <p>{record.doctorOrder}</p>
              </>
            ) : null}
          </section>

          <section className="pwa-record-section">
            <h3>Plan / Treatment</h3>
            <ul className="pwa-treatment-list">
              {record.treatment.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>

            {record.prescriptions.length ? (
              <>
                <h3>Prescriptions</h3>
                <ul className="pwa-treatment-list">
                  {record.prescriptions.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </>
            ) : null}

            {record.diagnosticResults.length ? (
              <>
                <h3>Diagnostic Results</h3>
                <ul className="pwa-treatment-list">
                  {record.diagnosticResults.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </>
            ) : null}

            {record.attachments?.length ? (
              <>
                <h3 className="pwa-attachment-title">
                  Reports ({record.attachments.length})
                </h3>
                <div className="pwa-report-list">
                  {record.attachments.map((attachment) => (
                    <PatientReportAttachment
                      key={attachment.path || `${attachment.kind}-${attachment.name}`}
                      attachment={attachment}
                    />
                  ))}
                </div>
              </>
            ) : null}
          </section>
        </div>
      </article>
    </section>
  );
}

function PatientReportAttachment({ attachment }) {
  const [action, setAction] = useState("");
  const [error, setError] = useState("");

  const handleView = async () => {
    if (action) return;

    setError("");
    setAction("view");

    try {
      const signedUrl = await createAttachmentUrl(attachment);
      window.open(signedUrl, "_blank", "noopener,noreferrer");
    } catch (attachmentError) {
      console.error("Patient report view failed:", attachmentError);
      setError(
        attachmentError?.message ||
          "This report could not be opened. Please try again."
      );
    } finally {
      setAction("");
    }
  };

  const handleDownload = async () => {
    if (action) return;

    setError("");
    setAction("download");

    try {
      const signedUrl = await createAttachmentUrl(attachment);
      const response = await fetch(signedUrl);

      if (!response.ok) {
        throw new Error("The report could not be downloaded.");
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = objectUrl;
      link.download = attachment.name || "medical-report.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();

      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (attachmentError) {
      console.error("Patient report download failed:", attachmentError);
      setError(
        attachmentError?.message ||
          "This report could not be downloaded. Please try again."
      );
    } finally {
      setAction("");
    }
  };

  return (
    <div className="pwa-report-card">
      <div className="pwa-report-file">
        <span className="pwa-report-icon" aria-hidden="true">
          <Icon icon="solar:file-text-bold-duotone" />
        </span>

        <div>
          <strong>{attachment.name}</strong>
          <small>
            {attachment.kind} · {formatAttachmentSize(attachment.size)}
          </small>
        </div>
      </div>

      <div className="pwa-report-actions">
        <button
          type="button"
          onClick={handleView}
          disabled={Boolean(action)}
        >
          <Icon icon="solar:eye-linear" />
          {action === "view" ? "Opening..." : "View"}
        </button>

        <button
          type="button"
          onClick={handleDownload}
          disabled={Boolean(action)}
        >
          <Icon icon="solar:download-minimalistic-linear" />
          {action === "download" ? "Downloading..." : "Download"}
        </button>
      </div>

      {error ? <p className="pwa-report-error">{error}</p> : null}
    </div>
  );
}

function MedicalMeta({ icon, label, value, tone }) {
  return (
    <div className={`pwa-medical-meta is-${tone} ${
      hasMeaningfulRecordValue(value) ? "" : "is-empty"
    }`}>
      <span>
        <Icon icon={icon} />
      </span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function SectionTitle({ title }) {
  return (
    <h3 className="pwa-dot-title">
      <span />
      {title}
    </h3>
  );
}
