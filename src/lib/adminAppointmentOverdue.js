import { getAppointmentStart } from "./appointmentDate";
import { supabase } from "./supabaseClient";

const overdueScheduleColumns =
  "id, maternal_appointment_id, patient_id, doctor_id, patient_name, doctor_name, title, start_time, end_time, status";

const overdueQueryPageSize = 1000;

const activeAppointmentStatuses = new Set([
  "scheduled",
  "pending",
  "accepted",
  "upcoming",
  "rescheduled",
  "reschedule",
]);

function normalizeStatusToken(status) {
  return String(status || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function isUnresolvedOverdueAppointment(
  appointment,
  nowValue = new Date()
) {
  const start = getAppointmentStart(appointment);
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);

  return Boolean(
    start &&
      !Number.isNaN(now.getTime()) &&
      activeAppointmentStatuses.has(normalizeStatusToken(appointment?.status)) &&
      start.getTime() < now.getTime()
  );
}

export async function queryAdminOverdueScheduleRows(nowValue = new Date()) {
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);

  if (Number.isNaN(now.getTime())) {
    return {
      data: [],
      error: new Error("The current appointment time is invalid."),
    };
  }

  const rows = [];

  for (let offset = 0; ; offset += overdueQueryPageSize) {
    const { data, error } = await supabase
      .from("schedule")
      .select(overdueScheduleColumns)
      .lt("start_time", now.toISOString())
      .order("start_time", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + overdueQueryPageSize - 1);

    if (error) return { data: [], error };

    const pageRows = data || [];
    rows.push(...pageRows);

    if (pageRows.length < overdueQueryPageSize) break;
  }

  return {
    data: rows.filter((row) =>
      isUnresolvedOverdueAppointment(row, now)
    ),
    error: null,
  };
}
