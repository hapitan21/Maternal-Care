import {
  formatAppointmentDate,
  formatAppointmentTime,
} from "./appointmentDate.js";
import { formatReportTimestamp } from "./reportExport.js";

function formatRate(value, emptyLabel = "No completed outcomes") {
  return value === null || value === undefined ? emptyLabel : `${value}%`;
}

function formatReportPeriod(startDate, endDate) {
  if (!startDate || !endDate) return "Not available";
  const start = formatAppointmentDate(`${startDate}T00:00:00+08:00`);
  const end = formatAppointmentDate(`${endDate}T00:00:00+08:00`);
  return startDate === endDate ? start : `${start} - ${end}`;
}

function getResponseTimestamp(row) {
  if (row.status === "taken" || row.status === "skipped") return row.action_at;
  if (row.status === "missed") return row.missed_at;
  return null;
}

function getExportStatusLabel(row) {
  const labels = {
    taken: "Taken",
    skipped: "Skipped",
    missed: "Missed",
    notified: "Due",
    processing: "Processing",
    failed: "Unavailable",
  };
  return labels[row.status] || row.statusLabel || "Unavailable";
}

export function getReportPatientDisplay(patientById, patientId) {
  const patient = patientById.get(patientId);
  return patient
    ? {
        name: patient.full_name || "Patient",
        displayId: patient.patient_id || "Not assigned",
      }
    : {
        name: "Archived Patient",
        displayId: "Not available",
      };
}

export function buildPatientAdherenceCsvRows({
  patient,
  doctorName,
  dateRange,
  dateFilter,
  statusFilter,
  trendData,
  historyRows,
  generatedAt,
}) {
  const current = trendData.currentSummary;
  const previous = trendData.previousSummary;
  const comparison = trendData.comparison;

  return [
    ["Report", "Medication Adherence Report"],
    ["Patient", patient?.full_name || "Patient"],
    ["Patient ID", patient?.patient_id || "Not assigned"],
    ["Doctor", doctorName || "Doctor"],
    [
      "Report Period",
      formatReportPeriod(dateRange.startDate, dateRange.endDate),
    ],
    ["Generated", formatReportTimestamp(generatedAt)],
    ["Timezone", "Asia/Manila"],
    ["Date Filter", dateFilter],
    ["History Status Filter", statusFilter],
    [],
    ["Medication Adherence Summary"],
    ["Total Completed Outcomes", current.completedOutcomes],
    ["Taken", current.taken],
    ["Skipped", current.skipped],
    ["Missed", current.missed],
    ["Adherence Rate", formatRate(current.adherenceRate)],
    [],
    ["Period Comparison"],
    [
      "Previous Period",
      trendData.dailyPrevious.length
        ? `${trendData.dailyPrevious[0].dateLabel} - ${
            trendData.dailyPrevious.at(-1).dateLabel
          }`
        : "Not available",
    ],
    ["Previous Completed Outcomes", previous.completedOutcomes],
    ["Previous Adherence Rate", formatRate(previous.adherenceRate)],
    [
      "Change in Percentage Points",
      comparison.changePercentagePoints === null
        ? "Not available"
        : comparison.changePercentagePoints,
    ],
    [],
    ["Medication Adherence History"],
    [
      "Scheduled Date",
      "Scheduled Time",
      "Medication",
      "Dosage",
      "Status",
      "Response Date",
      "Response Time",
    ],
    ...(historyRows || []).map((row) => {
      const responseTimestamp = getResponseTimestamp(row);
      return [
        formatAppointmentDate(row.scheduled_for),
        formatAppointmentTime(row.scheduled_for),
        row.medicationName,
        row.dosage,
        getExportStatusLabel(row),
        responseTimestamp
          ? formatAppointmentDate(responseTimestamp)
          : "Not available",
        responseTimestamp
          ? formatAppointmentTime(responseTimestamp)
          : "Not available",
      ];
    }),
  ];
}
