import { appointmentStatuses, classifyAppointment, getManilaDateKey, normalizeAppointmentStatus, toManilaISOString } from "./appointmentDate.js";

export const emptyDoctorProfileSummary = { cancelled: 0, today: 0, pending: 0, completed: 0 };

export function getDoctorProfileSummaryRange(period, now = new Date()) {
  if (period === "all-time") return null;
  if (!["this-month", "last-month"].includes(period)) throw new Error("Unknown appointment summary period.");
  const [year, month] = getManilaDateKey(now).split("-").map(Number);
  const offset = period === "last-month" ? -1 : 0;
  const dateKey = index => new Date(Date.UTC(year, index, 1)).toISOString().slice(0, 10);
  return {
    start: Date.parse(toManilaISOString(dateKey(month - 1 + offset))),
    end: Date.parse(toManilaISOString(dateKey(month + offset))),
  };
}

export function summarizeDoctorProfileAppointments(rows, period, now = new Date()) {
  const range = getDoctorProfileSummaryRange(period, now);
  const summary = { ...emptyDoctorProfileSummary };
  for (const appointment of rows) {
    // Today includes every stored status, independently of the selected period.
    if (classifyAppointment(appointment, now).isToday) summary.today += 1;
    const time = Date.parse(appointment.start_time || "");
    if (range && !(Number.isFinite(time) && time >= range.start && time < range.end)) continue;
    const status = normalizeAppointmentStatus(appointment.status);
    if (status === appointmentStatuses.cancelled) summary.cancelled += 1;
    if (status === appointmentStatuses.scheduled) summary.pending += 1;
    if (status === appointmentStatuses.completed) summary.completed += 1;
  }
  return summary;
}

// Match the established Dashboard keyset pattern, selecting only summary fields.
// Each page is bounded; only an empty page establishes complete retrieval, even
// when the server's row cap is below our requested limit.
export async function fetchDoctorProfileAppointments(client, doctorId, isCurrent = () => true) {
  if (!doctorId) throw new Error("A Doctor ID is required to load appointments.");
  const rows = new Map(), cursors = new Set();
  let cursor = null;
  for (let page = 0; page < 10000 && isCurrent(); page += 1) {
    let query = client.from("schedule").select("id, doctor_id, start_time, status")
      .eq("doctor_id", doctorId).order("start_time", { ascending: true, nullsFirst: false })
      .order("id", { ascending: true }).limit(500);
    if (cursor) query = cursor.startTime == null
      ? query.is("start_time", null).gt("id", cursor.id)
      : query.or(
        `start_time.gt.${cursor.startTime},and(start_time.eq.${cursor.startTime},id.gt.${cursor.id}),start_time.is.null`
      );
    const result = await query;
    if (!isCurrent()) return null;
    if (result.error) throw result.error;
    if (!Array.isArray(result.data)) throw new Error("Appointment results are unavailable.");
    if (!result.data.length) return Array.from(rows.values());
    for (const row of result.data) {
      if (!row?.id || row.doctor_id !== doctorId) throw new Error("Appointment ownership or schedule ID could not be confirmed.");
      rows.set(String(row.id), row);
    }
    const last = result.data.at(-1);
    cursor = { startTime: last.start_time ?? null, id: String(last.id) };
    const key = JSON.stringify(cursor);
    if (cursors.has(key)) throw new Error("Appointment pagination did not advance.");
    cursors.add(key);
  }
  if (!isCurrent()) return null;
  throw new Error("Appointment pagination exceeded its safety limit. Please retry.");
}
