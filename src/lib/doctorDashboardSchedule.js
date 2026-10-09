import { appointmentStatuses, normalizeAppointmentStatus } from "./appointmentDate.js";

const schedulePageSize = 500;
const scheduleColumns =
  "id, maternal_appointment_id, patient_id, patient_name, start_time, end_time, status";

export function isDoctorDashboardActiveStatus(status) {
  const normalized = normalizeAppointmentStatus(status);
  return normalized === appointmentStatuses.scheduled || normalized === appointmentStatuses.checkedIn;
}

export async function fetchDoctorDashboardSchedule(client, doctorId, isCurrent = () => true) {
  if (!doctorId) throw new Error("A Doctor ID is required to load dashboard appointments.");

  const rowsById = new Map();
  const cursors = new Set();
  let cursor = null;

  while (isCurrent()) {
    let query = client
      .from("schedule")
      .select(scheduleColumns)
      .eq("doctor_id", doctorId)
      .order("start_time", { ascending: true, nullsFirst: false })
      .order("id", { ascending: true })
      .limit(schedulePageSize);

    if (cursor) {
      query = cursor.startTime == null
        ? query.is("start_time", null).gt("id", cursor.id)
        : query.or(
          `start_time.gt.${cursor.startTime},and(start_time.eq.${cursor.startTime},id.gt.${cursor.id}),start_time.is.null`
        );
    }

    const result = await query;
    if (!isCurrent()) return { data: null, error: null };
    if (result.error) throw result.error;
    if (!Array.isArray(result.data)) throw new Error("Dashboard appointment results are unavailable.");
    if (!result.data.length) return { data: Array.from(rowsById.values()), error: null };

    for (const row of result.data) {
      if (!row?.id) throw new Error("A dashboard appointment is missing its schedule ID.");
      rowsById.set(String(row.id), row);
    }

    const lastRow = result.data.at(-1);
    cursor = { startTime: lastRow.start_time ?? null, id: String(lastRow.id) };
    const cursorKey = JSON.stringify(cursor);
    if (cursors.has(cursorKey)) throw new Error("Dashboard appointment pagination did not advance.");
    cursors.add(cursorKey);

    // A server cap can be lower than our requested page size. Only an empty
    // next page establishes completion; a short page is not a stopping rule.
  }

  return { data: null, error: null };
}
