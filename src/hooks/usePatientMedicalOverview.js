import { useMemo } from "react";
import {
  classifyAppointment,
  compareUpcomingAppointments,
  formatAppointmentDate,
  formatAppointmentTime,
  getAppointmentStart,
  parseAppointmentTimestamp,
} from "../lib/appointmentDate";
import {
  getLatestCompletedClinicalValue,
  isCompletedClinicalVisitRecord,
  normalizeClinicalVisitFormData,
} from "../lib/clinicalVisitData";

const emptyOverview = {
  latestVitalSigns: null,
  nextAppointment: null,
  lastVisit: null,
  latestNotes: null,
  pregnancyProgress: null,
};

const missingValues = new Set(["", "-", "na", "n/a", "none", "null", "undefined"]);

function cleanValue(value) {
  if (value === null || value === undefined) return "";
  const normalized = String(value).trim();
  return missingValues.has(normalized.toLowerCase()) ? "" : normalized;
}

function displayValue(value) {
  return cleanValue(value) || "Not recorded";
}

function getFormData(record) {
  return normalizeClinicalVisitFormData(record);
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.flatMap(normalizeList).filter(Boolean);
  }

  const clean = cleanValue(value);
  if (!clean) return [];

  return clean
    .split(/\r?\n|;/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseRecordDate(dateValue, timeValue) {
  const cleanDate = cleanValue(dateValue);
  const cleanTime = cleanValue(timeValue);
  const candidates = [
    cleanDate && cleanTime ? `${cleanDate} ${cleanTime}` : "",
    cleanDate,
  ];

  for (const candidate of candidates) {
    const date = parseAppointmentTimestamp(candidate);
    if (date) return date;
  }

  return null;
}

function getRecordTimestamp(record) {
  const formData = getFormData(record);
  return (
    parseRecordDate(formData.visitDate, formData.visitTime) ||
    parseRecordDate(formData.visit_date, formData.visit_time) ||
    parseRecordDate(formData.appointmentDate, formData.appointmentTime) ||
    parseRecordDate(formData.appointment_date, formData.appointment_time) ||
    parseAppointmentTimestamp(record?.uploaded_at) ||
    parseAppointmentTimestamp(record?.created_at)
  );
}

function getRecordCompletionTimestamp(record) {
  const formData = getFormData(record);
  return (
    parseAppointmentTimestamp(formData.completedAt) ||
    parseAppointmentTimestamp(formData.completed_at) ||
    parseAppointmentTimestamp(record?.completed_at)
  );
}

function getPastVisitTimestamp(record, schedule, now) {
  const scheduleTimestamp = getAppointmentStart(schedule);
  if (scheduleTimestamp && scheduleTimestamp.getTime() > now) {
    return null;
  }

  const completionTimestamp = getRecordCompletionTimestamp(record);
  if (completionTimestamp && completionTimestamp.getTime() <= now) {
    return completionTimestamp;
  }

  const recordTimestamp = getRecordTimestamp(record);
  if (recordTimestamp && recordTimestamp.getTime() <= now) {
    return recordTimestamp;
  }

  return scheduleTimestamp && scheduleTimestamp.getTime() <= now
    ? scheduleTimestamp
    : null;
}

function formatRecordDateTime(record) {
  const timestamp = getRecordTimestamp(record);
  if (!timestamp) return "Not recorded";

  return `${formatAppointmentDate(timestamp)} at ${formatAppointmentTime(timestamp)}`;
}

function normalizeLabel(value) {
  return String(value || "").trim().toLowerCase();
}

function findFinding(formData, labels) {
  const normalizedLabels = labels.map(normalizeLabel);
  const findings = Array.isArray(formData.findings) ? formData.findings : [];

  for (const item of findings) {
    const label = normalizeLabel(Array.isArray(item) ? item[0] : item?.label || item?.name);
    if (normalizedLabels.includes(label)) {
      const value = Array.isArray(item) ? item[1] : item?.value ?? item?.result;
      return cleanValue(value);
    }
  }

  return "";
}

function nestedFieldValue(formData, keys) {
  const sources = [
    formData.clinicalFindings,
    formData.clinical_findings,
    formData.pregnancyStatus,
    formData.pregnancy_status,
    formData.visitInformation,
    formData.visit_information,
  ].filter((source) => source && typeof source === "object" && !Array.isArray(source));

  for (const source of sources) {
    for (const key of keys) {
      const value = cleanValue(source[key]);
      if (value) return value;
    }
  }

  return "";
}

function fieldValue(formData, keys, labels = []) {
  for (const key of keys) {
    const value = cleanValue(formData[key]);
    if (value) return value;
  }

  const nestedValue = nestedFieldValue(formData, keys);
  if (nestedValue) return nestedValue;

  return labels.length ? findFinding(formData, labels) : "";
}

function withUnit(value, unit) {
  const clean = cleanValue(value);
  if (!clean) return "Not recorded";
  if (!unit) return clean;
  return clean.toLowerCase().includes(unit.toLowerCase()) ? clean : `${clean} ${unit}`;
}

function getDoctorNameFromProfile(profileMap, doctorId) {
  return doctorId ? profileMap.get(doctorId) || "" : "";
}

function getScheduleDoctor(schedule, profileMap) {
  return (
    cleanValue(schedule?.doctor_name) ||
    getDoctorNameFromProfile(profileMap, schedule?.doctor_id) ||
    "Doctor not recorded"
  );
}

function getRecordDoctor(record, schedule, profileMap) {
  const formData = getFormData(record);
  const visitInformation = formData.visitInformation || formData.visit_information || {};
  const recordDoctorId =
    record?.doctor_id ||
    formData.doctorId ||
    formData.doctor_id ||
    visitInformation.doctorId ||
    visitInformation.doctor_id;

  return (
    getDoctorNameFromProfile(profileMap, recordDoctorId) ||
    getDoctorNameFromProfile(profileMap, schedule?.doctor_id) ||
    cleanValue(formData.doctor) ||
    cleanValue(formData.attendingPhysician) ||
    cleanValue(formData.attending_physician) ||
    cleanValue(record?.uploaded_by) ||
    cleanValue(schedule?.doctor_name) ||
    "Doctor not recorded"
  );
}

function makeVitalSigns(records) {
  const record = records.find((item) => {
    const formData = getFormData(item);
    return Boolean(
      fieldValue(formData, ["bloodPressure"], ["Blood Pressure"]) ||
        fieldValue(formData, ["heartRate"], ["Heart Rate"]) ||
        fieldValue(formData, ["weight"], ["Weight"]) ||
        fieldValue(formData, ["temperature"], ["Temperature", "Temp"])
    );
  });

  if (!record) return null;

  const formData = getFormData(record);
  const optional = [
    ["Height", withUnit(fieldValue(formData, ["height"], ["Height"]), "cm")],
    ["BMI", withUnit(fieldValue(formData, ["bmi"], ["BMI"]), "kg/m²")],
    [
      "Fetal Heart Rate",
      withUnit(fieldValue(formData, ["fetalHeartRate"], ["Fetal Heart Rate"]), "bpm"),
    ],
  ].filter(([, value]) => value !== "Not recorded");

  return {
    recordId: record.id,
    measuredAt: formatRecordDateTime(record),
    rows: [
      ["Blood Pressure", withUnit(fieldValue(formData, ["bloodPressure"], ["Blood Pressure"]), "mmHg")],
      ["Heart Rate", withUnit(fieldValue(formData, ["heartRate"], ["Heart Rate"]), "bpm")],
      ["Weight", withUnit(fieldValue(formData, ["weight"], ["Weight"]), "kg")],
      ["Temperature", withUnit(fieldValue(formData, ["temperature"], ["Temperature", "Temp"]), "°C")],
      ...optional,
    ],
  };
}

function makeLatestNotes(records) {
  const record = records[0] || null;
  if (!record) return null;

  const formData = getFormData(record);
  const chiefComplaint = fieldValue(
    formData,
    ["chiefComplaint", "chief_complaint", "complaint", "chiefComplaints", "reasonForVisit"],
    ["Chief Complaint", "Chief Complaints", "Reason for Visit"]
  );
  const assessment = normalizeList(
    fieldValue(formData, ["assessment", "clinical_assessment"], ["Assessment", "Clinical Assessment"])
  ).join("; ");
  const plan = [
    ...normalizeList(formData.treatmentPlan),
    ...normalizeList(formData.planTreatment),
    ...normalizeList(formData.plan),
    ...normalizeList(formData.treatment),
    ...normalizeList(formData.followUpInstructions),
  ].join("; ");

  if (!chiefComplaint && !assessment && !plan) return null;

  return {
    recordId: record.id,
    updatedAt: formatRecordDateTime(record),
    sections: [
      ["Chief Complaint", displayValue(chiefComplaint)],
      ["Assessment", displayValue(assessment)],
      ["Plan / Treatment", displayValue(plan)],
    ],
  };
}

function getAssessmentSummary(record) {
  if (!record) return "Not recorded";
  const formData = getFormData(record);
  const assessment = normalizeList(formData.assessment);
  if (assessment.length) return assessment[0];
  return (
    cleanValue(formData.diagnosis) ||
    cleanValue(formData.chiefComplaint) ||
    cleanValue(formData.complaint) ||
    cleanValue(record.notes) ||
    "Not recorded"
  );
}

function makeLastVisit(records, schedules, profileMap) {
  const now = Date.now();
  const completedVisits = schedules
    .filter((schedule) => classifyAppointment(schedule).category === "completed")
    .map((schedule) => {
      const linkedRecords = records.filter((record) => record.schedule_id === schedule.id);
      const record = linkedRecords
        .map((item) => ({
          record: item,
          timestamp: getPastVisitTimestamp(item, schedule, now),
        }))
        .filter((item) => item.timestamp)
        .sort((first, second) => second.timestamp.getTime() - first.timestamp.getTime())[0]
        ?.record || null;
      const timestamp = getPastVisitTimestamp(record, schedule, now);

      return timestamp ? { record, schedule, timestamp } : null;
    })
    .filter(Boolean)
    .sort((first, second) => second.timestamp.getTime() - first.timestamp.getTime());

  if (completedVisits.length) {
    const { record, schedule, timestamp } = completedVisits[0];

    return {
      recordId: record?.id || "",
      scheduleId: schedule.id,
      date: timestamp ? formatAppointmentDate(timestamp) : "Not recorded",
      time: timestamp ? formatAppointmentTime(timestamp) : "Not recorded",
      doctor: getRecordDoctor(record, schedule, profileMap),
      visitType: cleanValue(record?.type) || cleanValue(schedule.title) || "Completed Visit",
      assessment: getAssessmentSummary(record),
    };
  }

  const clinicalVisit = records
    .filter((record) => {
      const formData = getFormData(record);
      return cleanValue(formData.visitType) || cleanValue(record.type);
    })
    .map((record) => ({
      record,
      timestamp: getPastVisitTimestamp(record, null, now),
    }))
    .filter((item) => item.timestamp)
    .sort((first, second) => second.timestamp.getTime() - first.timestamp.getTime())[0];

  if (!clinicalVisit) return null;

  const { record: clinicalRecord, timestamp } = clinicalVisit;
  return {
    recordId: clinicalRecord.id,
    scheduleId: clinicalRecord.schedule_id || "",
    date: timestamp ? formatAppointmentDate(timestamp) : "Not recorded",
    time: timestamp ? formatAppointmentTime(timestamp) : "Not recorded",
    doctor: getRecordDoctor(clinicalRecord, null, profileMap),
    visitType: cleanValue(getFormData(clinicalRecord).visitType) || cleanValue(clinicalRecord.type) || "Medical Record",
    assessment: getAssessmentSummary(clinicalRecord),
  };
}

function makeNextAppointment(schedules, profileMap) {
  const appointment = schedules
    .filter((schedule) => {
      const classification = classifyAppointment(schedule);
      return classification.category === "upcoming" && !classification.isTerminal;
    })
    .sort(compareUpcomingAppointments)[0];

  if (!appointment) return null;

  const classification = classifyAppointment(appointment);
  return {
    id: appointment.id,
    displayId: cleanValue(appointment.maternal_appointment_id),
    title: cleanValue(appointment.title) || "Appointment",
    date: formatAppointmentDate(appointment.start_time),
    time: formatAppointmentTime(appointment.start_time),
    doctor: getScheduleDoctor(appointment, profileMap),
    status: classification.displayStatus,
    raw: appointment,
  };
}

function makePregnancyProgress(records, pregnancyWeek) {
  const weeks = pregnancyWeek ?? null;
  const fetalHeartRate = getLatestCompletedClinicalValue(records, "fetalHeartRate");
  const fundalHeight = getLatestCompletedClinicalValue(records, "fundalHeight");
  const babyPosition = getLatestCompletedClinicalValue(records, "babyPosition");
  const fetalMovement = getLatestCompletedClinicalValue(records, "fetalMovement");

  return {
    weeks,
    progressPercent: weeks === null ? 0 : Math.max(0, Math.min(100, (weeks / 40) * 100)),
    stats: [
      {
        icon: "ph:heartbeat",
        title: "Fetal Heart rate",
        value: withUnit(fetalHeartRate.value, "bpm"),
        date: fetalHeartRate.record ? formatRecordDateTime(fetalHeartRate.record) : "",
        className: "purple",
      },
      {
        icon: "solar:ruler-broken",
        title: "Fundal Height",
        value: withUnit(fundalHeight.value, "cm"),
        date: fundalHeight.record ? formatRecordDateTime(fundalHeight.record) : "",
        className: "pink",
      },
      {
        icon: "glyphs:baby-outline",
        title: "Baby Position",
        value: displayValue(babyPosition.value),
        date: babyPosition.record ? formatRecordDateTime(babyPosition.record) : "",
        className: "yellow",
        iconClass: "mr-baby-position-icon",
      },
      {
        icon: "icon-park-outline:baby-feet",
        title: "Movement",
        value: displayValue(fetalMovement.value),
        date: fetalMovement.record ? formatRecordDateTime(fetalMovement.record) : "",
        className: "green",
      },
    ],
  };
}

function buildOverview({ records, schedules, profileMap, pregnancyWeek }) {
  const sortedRecords = records.filter(isCompletedClinicalVisitRecord).sort((first, second) => {
    const firstTime = getRecordTimestamp(first)?.getTime() ?? 0;
    const secondTime = getRecordTimestamp(second)?.getTime() ?? 0;
    return secondTime - firstTime;
  });
  return {
    latestVitalSigns: makeVitalSigns(sortedRecords),
    nextAppointment: makeNextAppointment(schedules, profileMap),
    lastVisit: makeLastVisit(sortedRecords, schedules, profileMap),
    latestNotes: makeLatestNotes(sortedRecords),
    pregnancyProgress: makePregnancyProgress(sortedRecords, pregnancyWeek),
  };
}

export function usePatientMedicalOverview({
  patientId,
  records = [],
  schedules = [],
  doctorProfilesById = null,
  pregnancyWeek = null,
  recordsLoading = false,
  schedulesLoading = false,
  recordsError = null,
  schedulesError = null,
} = {}) {
  const error = recordsError || schedulesError;
  const overview = useMemo(() => {
    if (!patientId || error) return emptyOverview;

    return buildOverview({
      records,
      schedules,
      profileMap: doctorProfilesById || new Map(),
      pregnancyWeek,
    });
  }, [doctorProfilesById, error, patientId, pregnancyWeek, records, schedules]);

  return useMemo(
    () => ({
      ...overview,
      loading: Boolean(patientId) && (recordsLoading || schedulesLoading),
      error,
    }),
    [error, overview, patientId, recordsLoading, schedulesLoading]
  );
}
