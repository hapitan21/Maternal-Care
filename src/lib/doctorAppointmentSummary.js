import { classifyAppointment, compareHistoryAppointments, compareUpcomingAppointments } from "./appointmentDate.js";

import { isCompletedClinicalVisitRecord, isMeaningfulClinicalValue, normalizeClinicalVisitFormData } from "./clinicalVisitData.js";

// Display only: retain the saved numbers while normalizing their unit labels.
function formatRecordedGestationalAge(value) {
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return text + " Weeks";
  return text.replace(/\bweeks?\b/gi, "Weeks").replace(/\bdays?\b/gi, "Days");
}

// Only persisted clinical-visit values qualify; never fall back to current dating.
export function resolveDoctorAppointmentHistory(appointments, medicalRecords, patientId) {
  const agesBySchedule = new Map();
  for (const record of medicalRecords) {
    if (!patientId || record.patient_id !== patientId || !record.schedule_id ||
        !isCompletedClinicalVisitRecord(record) || agesBySchedule.has(record.schedule_id)) continue;
    const data = normalizeClinicalVisitFormData(record);
    const visit = data.visitInformation || data.visit_information || {};
    const value = [data.gestationalAge, visit.gestationalAge, visit.gestational_age]
      .find(isMeaningfulClinicalValue);
    // The bulk loader orders newest first. Missing data in that record stays missing.
    agesBySchedule.set(record.schedule_id, value === undefined ? "Not recorded" : formatRecordedGestationalAge(value));
  }
  return appointments.map(appointment => ({
    ...appointment,
    recordedGestationalAge: patientId && appointment.patient_id === patientId
      ? agesBySchedule.get(appointment.id) || "Not recorded"
      : "Not recorded",
  }));
}

// Preserve the Medical Record tab's existing classification and attendance rules.
export function buildDoctorAppointmentSummary(appointments = [], now = new Date(), { medicalRecords = [], patientId = "" } = {}) {
  const classifiedAppointments = resolveDoctorAppointmentHistory(appointments, medicalRecords, patientId).map(appointment => ({
    ...appointment, classification: classifyAppointment(appointment, now),
  }));
  const upcomingAppointments = classifiedAppointments.filter(item => item.classification.isUpcoming).sort(compareUpcomingAppointments);
  const historyAppointments = [...classifiedAppointments].sort(compareHistoryAppointments);
  const total = classifiedAppointments.length;
  const countCategory = category => classifiedAppointments.filter(item => item.classification.category === category).length;
  const completed = countCategory("completed");
  const missedCancelled = classifiedAppointments.filter(item => ["cancelled", "missed", "overdue"].includes(item.classification.category)).length;
  const attendanceTotal = completed + missedCancelled;
  const attendanceRate = attendanceTotal ? Math.round(completed / attendanceTotal * 100) : 0;
  const percent = count => total ? Math.round(count / total * 100) + "%" : "0%";
  const additional = [];
  const checkedIn = countCategory("checked_in");
  const unavailableDates = countCategory("invalid");
  if (checkedIn) additional.push(checkedIn + " checked-in awaiting completion");
  if (unavailableDates) additional.push(unavailableDates + " with unavailable dates");
  const additionalNote = additional.length ? "Also included in Total Visits: " + additional.join("; ") + "." : "";
  const metrics = [
    { label: "Total Visits", value: String(total), note: "All time", icon: "mingcute:calendar-line", iconClass: "is-calendar", tone: "purple" },
    { label: "Completed", value: String(completed), note: percent(completed), icon: "simple-line-icons:check", iconClass: "is-check", tone: "pink" },
    { label: "Upcoming", value: String(upcomingAppointments.length), note: percent(upcomingAppointments.length), icon: "tabler:clock", iconClass: "is-clock", tone: "yellow" },
    { label: "Missed / Cancelled", value: String(missedCancelled), note: percent(missedCancelled), icon: "charm:circle-cross", iconClass: "is-close", tone: "green" },
    { label: "Attendance Rate", value: attendanceRate + "%", note: attendanceRate + "% attended", icon: "streamline-ultimate:presentation-board-graph", iconClass: "is-attendance", tone: "blue" },
  ];
  return { metrics, historyAppointments, upcomingAppointments, additionalNote };
}
