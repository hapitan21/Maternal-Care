import React from "react";
import { Icon } from "@iconify/react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAdminAuth } from "../../hooks/useAdminAuth";
import AdminPageHeader from "../../components/admin/AdminPageHeader";
import {
  formatAppointmentDate,
  formatAppointmentTime,
  getManilaDateKey,
  normalizeAppointmentOverviewStatus,
  toManilaISOString,
} from "../../lib/appointmentDate";
import {
  isPatientRecordArchived,
  normalizePatientAccountStatus,
  patientAccountStatuses,
} from "../../lib/patientAccountStatus";
import { supabase } from "../../lib/supabaseClient";
import { recordAuditEvent } from "../../lib/auditLog";
import {
  sanitizeFilename,
  sanitizeSpreadsheetCell,
} from "../../lib/reportExport";
import "../../styles/adminDashboard.css";
import "../../styles/AdminReports.css";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;
const PAGE_SIZE = 5;

const viewCopy = {
  landing: {
    title: "Reports",
    subtitle: "Generate and export administrative reports.",
  },
  appointment: {
    breadcrumb: "Appointment Summary",
    title: "Appointment Summary Report",
    subtitle: "Historical appointments by status, type, and Doctor performance.",
  },
  patient: {
    breadcrumb: "Patient Summary",
    title: "Patient Summary Report",
    subtitle: "Historical Patient registration and account-status reporting.",
  },
  trends: {
    breadcrumb: "Registration & Appointment Trends",
    title: "Registration & Appointment Trends",
    subtitle: "Historical Patient-registration and appointment-creation trends.",
  },
};

const reportCards = [
  {
    view: "appointment",
    title: "Appointment Summary",
    description: "Historical appointment analytics and Doctor workload/performance.",
    icon: "solar:calendar-mark-linear",
    route: "/admin/reports/appointment-summary",
  },
  {
    view: "patient",
    title: "Patient Summary",
    description: "Patient registration and account-status reporting.",
    icon: "solar:users-group-rounded-linear",
    route: "/admin/reports/patient-summary",
  },
  {
    view: "trends",
    title: "Registration & Appointment Trends",
    description: "Historical Patient-registration and appointment-creation trends.",
    icon: "solar:presentation-graph-linear",
    route: "/admin/reports/monthly-trends",
  },
];

const statusMeta = {
  completed: { label: "Completed", color: "#18bf7d" },
  upcoming: { label: "Upcoming", color: "#ff9a00" },
  canceled: { label: "Canceled", color: "#6978ff" },
  missed: { label: "Missed", color: "#ff476f" },
  rescheduled: { label: "Rescheduled", color: "#f4c64e" },
};

const scheduleColumns =
  "id, maternal_appointment_id, patient_id, doctor_id, patient_name, doctor_name, title, start_time, end_time, status, created_at";
const patientColumns =
  "id, full_name, patient_id, contact_number, status, account_status, archived_at, created_at";
const profileColumns = "id, full_name, role, account_status, created_at";
const professionalColumns = "auth_user_id, board_certification, clinic_hospital_name";

function cleanText(value) {
  return String(value || "").trim();
}

function lowerText(value) {
  return cleanText(value).toLowerCase();
}

function dateFromKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cleanText(key));
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateKeyFromDate(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function addDays(key, days) {
  const date = dateFromKey(key);
  if (!date) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return dateKeyFromDate(date);
}

function isValidDateKey(key) {
  const date = dateFromKey(key);
  return Boolean(date && dateKeyFromDate(date) === key);
}

function getRangeDays(range) {
  const start = dateFromKey(range.from);
  const end = dateFromKey(range.to);
  if (!start || !end) return 1;
  return Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1;
}

function normalizeRange(from, to, fallback) {
  let startKey = isValidDateKey(from) ? from : fallback.from;
  let endKey = isValidDateKey(to) ? to : fallback.to;
  if (startKey > endKey) endKey = startKey;
  if (getRangeDays({ from: startKey, to: endKey }) > MAX_RANGE_DAYS) {
    endKey = addDays(startKey, MAX_RANGE_DAYS - 1);
  }
  return { from: startKey, to: endKey };
}

function getDefaultRange(view) {
  const today = getManilaDateKey(new Date());
  return view === "trends" ? { from: addDays(today, -29), to: today } : { from: today, to: today };
}

function getPreviousRange(range) {
  const days = getRangeDays(range);
  return { from: addDays(range.from, -days), to: addDays(range.from, -1) };
}

function getRangeBoundaries(range) {
  return {
    startIso: toManilaISOString(range.from, "00:00"),
    endIso: toManilaISOString(addDays(range.to, 1), "00:00"),
  };
}

function formatDateKey(key, options = {}) {
  const iso = toManilaISOString(key, "12:00");
  return iso ? formatAppointmentDate(iso, options) : "—";
}

function formatRangeLabel(range) {
  return `${formatDateKey(range.from)} – ${formatDateKey(range.to)}`;
}

function normalizeReportStatus(status) {
  const normalized = lowerText(status).replace(/[_-]+/g, " ");
  if (["archived", "deleted"].includes(normalized)) return "excluded";
  if (["rescheduled", "reschedule"].includes(normalized)) return "rescheduled";
  return normalizeAppointmentOverviewStatus(status);
}

function formatType(value) {
  const text = cleanText(value) || "Appointment";
  if (text !== text.toUpperCase() && text !== text.toLowerCase()) return text;
  return text.toLowerCase().replace(/\b\w/g, (character) => character.toUpperCase());
}

function getInitials(name, fallback = "—") {
  return (
    cleanText(name)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("") || fallback
  );
}

function percent(value, total) {
  if (!total) return 0;
  return Number(((value / total) * 100).toFixed(2));
}

function comparison(current, previous) {
  if (!current && !previous) return { direction: "same", label: "No change" };
  if (!previous) return { direction: "up", label: "New activity" };
  const change = Number((((current - previous) / previous) * 100).toFixed(2));
  if (!change) return { direction: "same", label: "No change" };
  return {
    direction: change > 0 ? "up" : "down",
    label: `${Math.abs(change)}% from previous period`,
  };
}

async function fetchAllRows(table, columns, applyFilters) {
  const pageSize = 1000;
  const rows = [];
  for (let offset = 0; offset < 10000; offset += pageSize) {
    let query = supabase.from(table).select(columns);
    query = applyFilters(query).range(offset, offset + pageSize - 1);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < pageSize) break;
  }
  return rows;
}

async function fetchRowsByValues(table, columns, column, values) {
  const unique = Array.from(new Set(values.map(cleanText).filter(Boolean)));
  const chunks = [];
  for (let index = 0; index < unique.length; index += 100) chunks.push(unique.slice(index, index + 100));
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const { data, error } = await supabase.from(table).select(columns).in(column, chunk);
      if (error) throw error;
      return data || [];
    })
  );
  return results.flat();
}

async function fetchAllAdminPatients(applyFilters) {
  const pageSize = 1000;
  const rows = [];
  for (let offset = 0; offset < 10000; offset += pageSize) {
    let query = supabase.rpc("get_admin_patient_directory").select(patientColumns);
    query = applyFilters(query).range(offset, offset + pageSize - 1);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < pageSize) break;
  }
  return rows;
}

async function fetchAdminPatientsByIds(values) {
  const unique = Array.from(new Set(values.map(cleanText).filter(Boolean)));
  const chunks = [];
  for (let index = 0; index < unique.length; index += 100) {
    chunks.push(unique.slice(index, index + 100));
  }
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const { data, error } = await supabase
        .rpc("get_admin_patient_directory")
        .select(patientColumns)
        .in("id", chunk);
      if (error) throw error;
      return data || [];
    })
  );
  return results.flat();
}

function mapPatientStatus(row) {
  const normalized = normalizePatientAccountStatus(row);
  if (normalized === patientAccountStatuses.active) return "active";
  if (normalized === patientAccountStatuses.inactive) return "inactive";
  return "temporary";
}

function mapReportData({ schedules, createdSchedules, previousCreatedSchedules, patients, previousPatients, relatedPatients, profiles, professionals }) {
  const patientById = new Map([...patients, ...relatedPatients].map((row) => [cleanText(row.id), row]));
  const profileById = new Map(profiles.map((row) => [cleanText(row.id), row]));
  const professionalById = new Map(professionals.map((row) => [cleanText(row.auth_user_id), row]));

  const mapSchedule = (row) => {
    const status = normalizeReportStatus(row.status);
    if (!row?.id || status === "excluded") return null;
    const patient = patientById.get(cleanText(row.patient_id));
    const doctor = profileById.get(cleanText(row.doctor_id));
    const professional = professionalById.get(cleanText(row.doctor_id));
    const patientName = cleanText(patient?.full_name) || cleanText(row.patient_name) || "Patient";
    const doctorName = cleanText(doctor?.full_name) || cleanText(row.doctor_name) || "Unassigned";
    return {
      ...row,
      status,
      statusLabel: statusMeta[status]?.label || "Upcoming",
      patientName,
      patientDisplayId: cleanText(patient?.patient_id) || "—",
      doctorName,
      doctorSpecialization:
        cleanText(professional?.board_certification) ||
        cleanText(professional?.clinic_hospital_name) ||
        "Doctor",
      doctorKey: cleanText(row.doctor_id) || `name:${lowerText(doctorName)}`,
      appointmentType: formatType(row.title),
      dateLabel: formatAppointmentDate(row.start_time),
      timeLabel: formatAppointmentTime(row.start_time, { hour: "2-digit" }),
    };
  };

  const mapPatient = (row) => {
    if (!row?.id || isPatientRecordArchived(row)) return null;
    const name = cleanText(row.full_name) || "Unnamed Patient";
    const status = mapPatientStatus(row);
    return {
      ...row,
      name,
      displayId: cleanText(row.patient_id) || "—",
      contact: cleanText(row.contact_number) || "—",
      status,
      statusLabel: status === "active" ? "Active" : status === "inactive" ? "Inactive" : "Temporary",
      registeredLabel: row.created_at ? formatAppointmentDate(row.created_at) : "—",
      registeredDateTimeLabel: row.created_at
        ? `${formatAppointmentDate(row.created_at)} ${formatAppointmentTime(row.created_at)}`
        : "—",
      searchText: [name, row.patient_id, row.contact_number].map(lowerText).join(" "),
    };
  };

  return {
    appointments: schedules.map(mapSchedule).filter(Boolean).sort((a, b) => new Date(a.start_time) - new Date(b.start_time)),
    createdAppointments: createdSchedules.filter((row) => normalizeReportStatus(row.status) !== "excluded"),
    previousCreatedAppointments: previousCreatedSchedules.filter((row) => normalizeReportStatus(row.status) !== "excluded"),
    patients: patients.map(mapPatient).filter(Boolean).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
    previousPatients: previousPatients.filter((row) => !isPatientRecordArchived(row)),
    doctors: profiles
      .filter((row) => lowerText(row.role) === "doctor")
      .map((row) => ({
        id: cleanText(row.id),
        name: cleanText(row.full_name) || "Unnamed Doctor",
        specialization:
          cleanText(professionalById.get(cleanText(row.id))?.board_certification) ||
          cleanText(professionalById.get(cleanText(row.id))?.clinic_hospital_name) ||
          "Doctor",
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function logReportError(error) {
  if (!import.meta.env.DEV) return;
  console.error("Admin report load failed:", {
    code: error?.code || null,
    message: error?.message || null,
    details: error?.details || null,
    hint: error?.hint || null,
  });
}

function useAdminReportData(range, enabled, view) {
  const mountedRef = React.useRef(true);
  const requestRef = React.useRef(0);
  const pendingRef = React.useRef(null);
  const [state, setState] = React.useState({ data: null, loading: Boolean(enabled), error: null });

  const refresh = React.useCallback(() => {
    if (!enabled) return Promise.resolve(null);
    const key = `${view}:${range.from}:${range.to}`;
    if (pendingRef.current?.key === key) return pendingRef.current.promise;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setState((current) => ({ ...current, loading: true, error: null }));
    const previousRange = getPreviousRange(range);
    const currentBounds = getRangeBoundaries(range);
    const previousBounds = getRangeBoundaries(previousRange);

    const promise = (async () => {
      try {
        const needsScheduledAppointments = view === "appointment";
        const needsCreatedAppointments = view === "trends";
        const needsPatientRegistrations = view === "patient" || view === "trends";
        const rangeFilter = (column, bounds) => (query) =>
          query.gte(column, bounds.startIso).lt(column, bounds.endIso).order(column, { ascending: true });
        const [schedules, createdSchedules, previousCreatedSchedules, patients, previousPatients, profiles] =
          await Promise.all([
            needsScheduledAppointments
              ? fetchAllRows("schedule", scheduleColumns, rangeFilter("start_time", currentBounds))
              : Promise.resolve([]),
            needsCreatedAppointments
              ? fetchAllRows("schedule", scheduleColumns, rangeFilter("created_at", currentBounds))
              : Promise.resolve([]),
            needsCreatedAppointments
              ? fetchAllRows("schedule", scheduleColumns, rangeFilter("created_at", previousBounds))
              : Promise.resolve([]),
            needsPatientRegistrations
              ? fetchAllAdminPatients(rangeFilter("created_at", currentBounds))
              : Promise.resolve([]),
            needsPatientRegistrations
              ? fetchAllAdminPatients(rangeFilter("created_at", previousBounds))
              : Promise.resolve([]),
            needsScheduledAppointments
              ? fetchAllRows("profiles", profileColumns, (query) => query.ilike("role", "doctor").order("full_name"))
              : Promise.resolve([]),
          ]);

        const relatedPatients = needsScheduledAppointments
          ? await fetchAdminPatientsByIds(schedules.map((row) => row.patient_id))
          : [];
        const doctorIds = [
          ...profiles.map((row) => row.id),
          ...schedules.map((row) => row.doctor_id),
        ];
        const professionals = needsScheduledAppointments
          ? await fetchRowsByValues(
              "doctor_professional_information",
              professionalColumns,
              "auth_user_id",
              doctorIds
            )
          : [];
        const data = mapReportData({ schedules, createdSchedules, previousCreatedSchedules, patients, previousPatients, relatedPatients, profiles, professionals });
        if (mountedRef.current && requestRef.current === requestId) {
          setState({ data, loading: false, error: null });
        }
        return data;
      } catch (error) {
        logReportError(error);
        if (mountedRef.current && requestRef.current === requestId) {
          setState({ data: null, loading: false, error });
        }
        return null;
      }
    })();
    pendingRef.current = { key, promise };
    promise.finally(() => {
      if (pendingRef.current?.promise === promise) pendingRef.current = null;
    });
    return promise;
  }, [enabled, range, view]);

  React.useEffect(() => {
    mountedRef.current = true;
    const timer = window.setTimeout(refresh, 0);
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      window.clearTimeout(timer);
    };
  }, [refresh]);

  return { ...state, refresh };
}

function countStatuses(rows) {
  const counts = { total: rows.length, completed: 0, upcoming: 0, canceled: 0, missed: 0, rescheduled: 0 };
  rows.forEach((row) => {
    if (Object.hasOwn(counts, row.status)) counts[row.status] += 1;
  });
  return counts;
}

function patientStatusCounts(rows) {
  const counts = { total: rows.length, active: 0, temporary: 0, inactive: 0 };
  rows.forEach((row) => {
    const status = ["active", "temporary", "inactive"].includes(row.status)
      ? row.status
      : mapPatientStatus(row);
    if (Object.hasOwn(counts, status)) counts[status] += 1;
  });
  return counts;
}

function sanitizeExportValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return sanitizeSpreadsheetCell(cleanText(value));
}

function getReportTables(model) {
  if (Array.isArray(model.tables) && model.tables.length) return model.tables;
  return [{ title: "Report Data", headers: model.headers || [], rows: model.rows || [] }];
}

async function exportReportPdf(model) {
  const [{ jsPDF }, autoTableModule] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const autoTable = autoTableModule.autoTable || autoTableModule.default;
  const tables = getReportTables(model);
  const doc = new jsPDF({ orientation: tables.some((table) => table.headers.length > 6) ? "landscape" : "portrait" });
  doc.setFontSize(17);
  doc.text(model.title, 14, 18);
  doc.setFontSize(10);
  doc.text(`Date range: ${model.rangeLabel}`, 14, 26);
  model.summary.forEach((item, index) => doc.text(`${item.label}: ${item.value}`, 14, 34 + index * 6));
  let nextY = 40 + model.summary.length * 6;
  tables.forEach((table, index) => {
    if (index > 0) {
      nextY = (doc.lastAutoTable?.finalY || nextY) + 12;
      if (nextY > doc.internal.pageSize.getHeight() - 30) {
        doc.addPage();
        nextY = 18;
      }
    }
    doc.setFontSize(11);
    doc.text(table.title, 14, nextY);
    autoTable(doc, {
      startY: nextY + 4,
      head: [table.headers],
      body: table.rows.map((row) => row.map(sanitizeExportValue)),
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [251, 56, 126] },
    });
  });
  doc.save(`${sanitizeFilename(model.filename)}.pdf`);
}

async function exportReportExcel(model) {
  const ExcelJSModule = await import("exceljs");
  const ExcelJS = ExcelJSModule.default || ExcelJSModule;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Maternal Care Admin Reports";
  const sheet = workbook.addWorksheet("Report", { views: [{ state: "frozen", ySplit: 1 }] });
  const tables = getReportTables(model);
  sheet.addRow([sanitizeExportValue(model.title)]);
  sheet.addRow(["Date Range", sanitizeExportValue(model.rangeLabel)]);
  sheet.addRow([]);
  model.summary.forEach((item) => sheet.addRow([sanitizeExportValue(item.label), sanitizeExportValue(item.value)]));
  tables.forEach((table) => {
    sheet.addRow([]);
    const titleRow = sheet.addRow([sanitizeExportValue(table.title)]);
    titleRow.font = { bold: true, size: 12 };
    const headerRow = sheet.addRow(table.headers.map(sanitizeExportValue));
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFB387E" } };
    table.rows.forEach((row) => sheet.addRow(row.map(sanitizeExportValue)));
  });
  const maxColumns = Math.max(...tables.map((table) => table.headers.length), 2);
  sheet.columns = Array.from({ length: maxColumns }, (_, index) => {
    const headings = tables.map((table) => cleanText(table.headers[index]));
    const longestHeading = Math.max(...headings.map((heading) => heading.length), 8);
    return { key: `column-${index}`, width: Math.max(14, Math.min(34, longestHeading + 6)) };
  });
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${sanitizeFilename(model.filename)}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function buildBuckets(rows, range, dateField, mode = "adaptive") {
  const days = getRangeDays(range);
  const bucketMode = mode === "adaptive" ? (days <= 14 ? "daily" : days <= 90 ? "weekly" : "monthly") : mode;
  const buckets = [];
  if (bucketMode === "monthly") {
    let cursor = `${range.from.slice(0, 7)}-01`;
    while (cursor <= range.to) {
      const key = cursor.slice(0, 7);
      buckets.push({ key, label: formatDateKey(cursor, { month: "short", year: "numeric" }), value: 0 });
      const date = dateFromKey(cursor);
      date.setUTCMonth(date.getUTCMonth() + 1);
      cursor = dateKeyFromDate(date);
    }
  } else {
    const step = bucketMode === "weekly" ? 7 : 1;
    for (let start = range.from; start <= range.to; start = addDays(start, step)) {
      const end = step === 1 ? start : [addDays(start, step - 1), range.to].sort()[0];
      buckets.push({
        key: start,
        end,
        label:
          step === 1
            ? formatDateKey(start, { month: "short", day: "numeric" })
            : `${formatDateKey(start, { month: "short", day: "numeric" })} – ${formatDateKey(end, { month: "short", day: "numeric" })}`,
        value: 0,
      });
    }
  }
  rows.forEach((row) => {
    const key = getManilaDateKey(row[dateField]);
    const bucket =
      bucketMode === "monthly"
        ? buckets.find((item) => item.key === key.slice(0, 7))
        : buckets.find((item) => key >= item.key && key <= item.end);
    if (bucket) bucket.value += 1;
  });
  return buckets;
}

function DateRangeControl({ range, onChange, compact = false }) {
  const update = (field, value) => {
    if (!isValidDateKey(value)) return;
    const next = normalizeRange(
      field === "from" ? value : range.from,
      field === "to" ? value : range.to,
      range
    );
    onChange(next);
  };

  return (
    <div className={`admin-report-date-range ${compact ? "is-compact" : ""}`}>
      <Icon icon="solar:calendar-linear" />
      <label>
        <span className="admin-sr-only">Report start date</span>
        <input type="date" value={range.from} onChange={(event) => update("from", event.target.value)} />
      </label>
      <span aria-hidden="true">–</span>
      <label>
        <span className="admin-sr-only">Report end date</span>
        <input type="date" value={range.to} min={range.from} onChange={(event) => update("to", event.target.value)} />
      </label>
    </div>
  );
}

function SummaryCard({ icon, label, value, helper, tone = "pink", comparisonValue, loading }) {
  return (
    <article className="admin-report-summary-card">
      <span className={`admin-report-icon admin-report-icon--${tone}`}><Icon icon={icon} /></span>
      <div>
        <p>{label}</p>
        {loading ? <span className="admin-skeleton admin-skeleton--number" /> : <strong>{value}</strong>}
        {helper ? <small>{helper}</small> : null}
        {comparisonValue ? (
          <small className={`admin-report-comparison is-${comparisonValue.direction}`}>
            <Icon icon={comparisonValue.direction === "up" ? "solar:arrow-up-linear" : comparisonValue.direction === "down" ? "solar:arrow-down-linear" : "solar:minus-circle-linear"} />
            {comparisonValue.label}
          </small>
        ) : null}
      </div>
    </article>
  );
}

function ReportState({ loading, error, empty, onRetry, children }) {
  if (loading) {
    return (
      <div className="admin-report-state" role="status" aria-live="polite">
        <span className="admin-report-spinner" />
        <strong>Loading report data...</strong>
      </div>
    );
  }
  if (error) {
    return (
      <div className="admin-report-state is-error" role="alert">
        <Icon icon="solar:danger-triangle-linear" />
        <strong>Unable to load this report. Please try again.</strong>
        <button type="button" onClick={onRetry}>Retry</button>
      </div>
    );
  }
  if (empty) {
    return (
      <div className="admin-report-state">
        <Icon icon="solar:document-text-linear" />
        <strong>No report data found for the selected date range.</strong>
      </div>
    );
  }
  return children;
}

function ExportActions({ getModel }) {
  const [busy, setBusy] = React.useState("");
  const execute = async (type) => {
    if (busy) return;
    setBusy(type);
    try {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      const model = getModel();
      if (type === "pdf") await exportReportPdf(model);
      if (type === "excel") await exportReportExcel(model);
      if (type === "print") window.print();
      await recordAuditEvent({
        module: "reports",
        action: type === "print" ? "print" : "export",
        entityType: "report",
        entityId: model.filename,
        description: type === "print" ? "Prepared a report for printing." : `Exported a report as ${type.toUpperCase()}.`,
        metadata: { format: type, report: model.title },
      });
    } catch (error) {
      logReportError(error);
      window.alert(`Unable to ${type === "print" ? "prepare the report for printing" : `export ${type.toUpperCase()}`}.`);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="admin-report-export-actions" aria-label="Report export controls">
      <button type="button" disabled={Boolean(busy)} onClick={() => execute("pdf")}>
        <Icon icon="solar:download-minimalistic-linear" />
        {busy === "pdf" ? "Exporting PDF..." : "Export PDF"}
      </button>
      <button type="button" disabled={Boolean(busy)} onClick={() => execute("excel")}>
        <Icon icon="solar:file-text-linear" />
        {busy === "excel" ? "Exporting Excel..." : "Export Excel"}
      </button>
      <button className="is-primary" type="button" disabled={Boolean(busy)} onClick={() => execute("print")}>
        <Icon icon="solar:printer-linear" />
        {busy === "print" ? "Preparing Print..." : "Print Report"}
      </button>
    </div>
  );
}

function PrintReportData({ model }) {
  return (
    <div className="admin-report-print-data" aria-hidden="true">
      {getReportTables(model).map((table) => (
        <section className="admin-report-table-card" key={table.title}>
          <h2>{table.title}</h2>
          <div className="admin-report-table-wrap">
            <table>
              <thead><tr>{table.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
              <tbody>
                {table.rows.map((row, rowIndex) => (
                  <tr key={`${table.title}-${rowIndex}`}>
                    {row.map((value, columnIndex) => <td key={`${rowIndex}-${columnIndex}`}>{value}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

function FilterField({ label, value, onChange, children }) {
  return (
    <label className="admin-report-filter-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>{children}</select>
    </label>
  );
}

function ReportFilters({ range, onRangeChange, doctor, onDoctorChange, doctors, type, onTypeChange, types, status, statusOptions = [], onStatusChange, onReset }) {
  return (
    <section className="admin-report-filter-card" aria-label="Report filters">
      <div className="admin-report-filter-field admin-report-filter-field--date">
        <span>Date Range</span>
        <DateRangeControl range={range} onChange={onRangeChange} />
      </div>
      {onDoctorChange ? (
        <FilterField label="Doctor" value={doctor} onChange={onDoctorChange}>
          <option value="all">All Doctors</option>
          {doctors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </FilterField>
      ) : null}
      {onTypeChange ? (
        <FilterField label="Appointment Type" value={type} onChange={onTypeChange}>
          <option value="all">All Types</option>
          {types.map((item) => <option key={item} value={item}>{item}</option>)}
        </FilterField>
      ) : null}
      {onStatusChange ? (
        <FilterField label="Status" value={status} onChange={onStatusChange}>
          <option value="all">All Statuses</option>
          {statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </FilterField>
      ) : null}
      <button className="admin-report-reset" type="button" onClick={onReset}>
        <Icon icon="solar:restart-linear" /> Reset
      </button>
    </section>
  );
}

function StatusBadge({ status, label }) {
  return <span className={`admin-report-status admin-report-status--${status}`}>{label || statusMeta[status]?.label || status}</span>;
}

function Pagination({ page, count, pageSize = PAGE_SIZE, onChange }) {
  const pageCount = Math.max(1, Math.ceil(count / pageSize));
  if (pageCount <= 1) return null;
  const safePage = Math.min(page, pageCount);
  const start = Math.max(1, Math.min(safePage - 2, pageCount - 4));
  const pages = Array.from({ length: Math.min(5, pageCount) }, (_, index) => start + index);
  return (
    <nav className="admin-report-pagination" aria-label="Report table pages">
      <button type="button" disabled={safePage === 1} onClick={() => onChange(safePage - 1)} aria-label="Previous page"><Icon icon="solar:alt-arrow-left-linear" /></button>
      {pages.map((number) => (
        <button key={number} className={number === safePage ? "is-active" : ""} type="button" onClick={() => onChange(number)} aria-current={number === safePage ? "page" : undefined}>{number}</button>
      ))}
      <button type="button" disabled={safePage === pageCount} onClick={() => onChange(safePage + 1)} aria-label="Next page"><Icon icon="solar:alt-arrow-right-linear" /></button>
    </nav>
  );
}

function TableFooter({ page, count, pageSize = PAGE_SIZE, noun, onChange }) {
  const safePage = Math.min(page, Math.max(1, Math.ceil(count / pageSize)));
  const first = count ? (safePage - 1) * pageSize + 1 : 0;
  const last = Math.min(safePage * pageSize, count);
  return (
    <footer className="admin-report-table-footer">
      <p>Showing {first} to {last} of {count} {noun}</p>
      <Pagination page={safePage} count={count} pageSize={pageSize} onChange={onChange} />
    </footer>
  );
}

function DonutChart({ title, items }) {
  const visible = items.filter((item) => item.value > 0);
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const stops = visible.reduce(
    (result, item) => {
      const nextCursor = result.cursor + (total ? (item.value / total) * 100 : 0);
      return {
        cursor: nextCursor,
        values: [...result.values, `${item.color} ${result.cursor}% ${nextCursor}%`],
      };
    },
    { cursor: 0, values: [] }
  ).values;
  const background = stops.length ? `conic-gradient(${stops.join(",")})` : "#edf0f5";
  const summary = items.map((item) => `${item.label}: ${item.value}`).join(", ");
  return (
    <section className="admin-report-chart-card">
      <h2>{title}</h2>
      <div className="admin-report-donut-layout">
        <div className="admin-report-donut" style={{ background }} role="img" aria-label={`${title}. ${summary}`}>
          <div><strong>{total}</strong><span>Total</span></div>
        </div>
        <div className="admin-report-legend">
          {items.map((item) => (
            <p key={item.key}><i style={{ background: item.color }} /><span>{item.label}</span><strong>{item.value} ({percent(item.value, total)}%)</strong></p>
          ))}
        </div>
      </div>
    </section>
  );
}

function HorizontalBarChart({ title, items, axisLabel = "Number of Appointments" }) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return (
    <section className="admin-report-chart-card">
      <h2>{title}</h2>
      <div className="admin-report-horizontal-bars" role="img" aria-label={`${title}. ${items.map((item) => `${item.label}: ${item.value}`).join(", ")}`}>
        {items.length ? items.map((item, index) => (
          <div key={item.key || item.label}>
            <p><span>{item.label}</span><strong>{item.value}{item.percent === undefined ? "" : ` (${item.percent}%)`}</strong></p>
            <span className="admin-report-bar-track"><i style={{ width: `${(item.value / max) * 100}%`, opacity: Math.max(0.35, 1 - index * 0.15) }} /></span>
          </div>
        )) : <p className="admin-report-chart-empty">No chart data available.</p>}
        <small>{axisLabel}</small>
      </div>
    </section>
  );
}

function LineChart({ title, buckets, tone = "green" }) {
  const width = 640;
  const height = 230;
  const paddingX = 42;
  const paddingY = 34;
  const max = Math.max(1, ...buckets.map((item) => item.value));
  const points = buckets.map((item, index) => ({
    ...item,
    x: paddingX + (buckets.length <= 1 ? 0 : (index / (buckets.length - 1)) * (width - paddingX * 2)),
    y: height - paddingY - (item.value / max) * (height - paddingY * 2),
  }));
  const path = points.map((item, index) => `${index ? "L" : "M"}${item.x} ${item.y}`).join(" ");
  return (
    <section className={`admin-report-chart-card admin-report-line-chart is-${tone}`}>
      <h2>{title}</h2>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}. ${buckets.map((item) => `${item.label}: ${item.value}`).join(", ")}`}>
        {[0, 1, 2, 3].map((line) => <line key={line} x1={paddingX} x2={width - paddingX} y1={paddingY + line * 45} y2={paddingY + line * 45} />)}
        {points.length ? <path d={path} /> : null}
        {points.map((item) => <g key={item.key}><circle cx={item.x} cy={item.y} r="5" /><text x={item.x} y={item.y - 12} textAnchor="middle">{item.value}</text></g>)}
      </svg>
      <div>{points.map((item) => <small key={item.key}>{item.label}</small>)}</div>
    </section>
  );
}

function appointmentSummaryCards(counts, loading = false) {
  return [
    { key: "total", label: "Total Appointments", icon: "solar:calendar-mark-linear", tone: "pink" },
    { key: "completed", label: "Completed", icon: "solar:check-circle-linear", tone: "green" },
    { key: "upcoming", label: "Upcoming", icon: "solar:clock-circle-linear", tone: "orange" },
    { key: "canceled", label: "Canceled", icon: "solar:close-circle-linear", tone: "blue" },
    { key: "missed", label: "No Show", icon: "solar:danger-circle-linear", tone: "red" },
  ].map(({ key, ...cardProps }) => (
    <SummaryCard
      key={key}
      {...cardProps}
      value={counts[key] || 0}
      helper={key === "total" ? "" : `${percent(counts[key], counts.total)}%`}
      loading={loading}
    />
  ));
}

function LandingView({ range, onRangeChange, navigate }) {
  const query = `?from=${range.from}&to=${range.to}`;
  return (
    <>
      <div className="admin-reports-landing-range"><DateRangeControl range={range} onChange={onRangeChange} compact /></div>
      <section className="admin-reports-section">
        <h2>Available Reports</h2>
        <p>Select a report type to generate and view detailed data.</p>
        <div className="admin-report-card-grid">
          {reportCards.map((card, index) => (
            <article className="admin-report-option-card" key={card.view}>
              <span className={`admin-report-icon admin-report-icon--${["pink", "green", "purple"][index]}`}><Icon icon={card.icon} /></span>
              <h3>{card.title}</h3>
              <p>{card.description}</p>
              <button type="button" onClick={() => navigate(`${card.route}${query}`)}>Generate</button>
            </article>
          ))}
        </div>
      </section>
      <div className="admin-report-info-banner"><Icon icon="solar:info-circle-bold" /><span>Reports are based on the selected date range.</span></div>
    </>
  );
}

function AppointmentReportView({ data, loading, error, refresh, range, onRangeChange, originalRange }) {
  const [doctor, setDoctor] = React.useState("all");
  const [status, setStatus] = React.useState("all");
  const [type, setType] = React.useState("all");
  const [page, setPage] = React.useState(1);
  const types = React.useMemo(() => Array.from(new Set((data?.appointments || []).map((item) => item.appointmentType))).sort(), [data]);
  const appointments = React.useMemo(
    () => (data?.appointments || []).filter((item) =>
      (doctor === "all" || item.doctorKey === doctor) &&
      (status === "all" || item.status === status) &&
      (type === "all" || item.appointmentType === type)
    ),
    [data, doctor, status, type]
  );
  const counts = countStatuses(appointments);
  const doctorStats = buildDoctorStats(appointments, data?.doctors || []);
  const statusItems = Object.keys(statusMeta).map((key) => ({ key, ...statusMeta[key], value: counts[key] || 0 }));
  const typeItems = Array.from(
    appointments.reduce((map, item) => map.set(item.appointmentType, (map.get(item.appointmentType) || 0) + 1), new Map()),
    ([label, value]) => ({ key: label, label, value, percent: percent(value, counts.total) })
  ).sort((a, b) => b.value - a.value);
  const safePage = Math.min(page, Math.max(1, Math.ceil(appointments.length / PAGE_SIZE)));
  const rows = appointments.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const reset = () => { onRangeChange(originalRange); setDoctor("all"); setStatus("all"); setType("all"); setPage(1); };
  const model = {
    title: viewCopy.appointment.title,
    rangeLabel: formatRangeLabel(range),
    filename: `appointment-summary-${range.from}-to-${range.to}`,
    summary: ["total", "completed", "upcoming", "canceled", "missed"].map((key) => ({ label: key === "total" ? "Total Appointments" : statusMeta[key].label, value: counts[key] || 0 })),
    tables: [
      {
        title: "Appointment Details",
        headers: ["Date", "Time", "Patient", "Patient ID", "Doctor", "Specialization", "Appointment Type", "Status"],
        rows: appointments.map((item) => [item.dateLabel, item.timeLabel, item.patientName, item.patientDisplayId, item.doctorName, item.doctorSpecialization, item.appointmentType, item.statusLabel]),
      },
      {
        title: "Doctor Workload & Performance",
        headers: ["Doctor", "Specialization", "Total", "Completed", "Upcoming", "Canceled", "Missed", "Completion Rate"],
        rows: doctorStats.map((item) => [item.name, item.specialization, item.total, item.completed, item.upcoming, item.canceled, item.missed, `${item.completionRate}%`]),
      },
    ],
  };
  return (
    <>
      <ExportActions getModel={() => model} />
      <ReportFilters
        range={range} onRangeChange={(next) => { onRangeChange(next); setPage(1); }}
        doctor={doctor} onDoctorChange={(value) => { setDoctor(value); setPage(1); }} doctors={data?.doctors || []}
        status={status} statusOptions={Object.entries(statusMeta).map(([value, item]) => ({ value, label: item.label }))}
        onStatusChange={(value) => { setStatus(value); setPage(1); }}
        type={type} onTypeChange={(value) => { setType(value); setPage(1); }} types={types}
        onReset={reset}
      />
      <ReportState loading={loading} error={error} empty={!loading && !error && !appointments.length} onRetry={refresh}>
        <div className="admin-report-five-grid">{appointmentSummaryCards(counts)}</div>
        <div className="admin-report-chart-grid">
          <DonutChart title="Appointments by Status" items={statusItems} />
          <HorizontalBarChart title="Appointments by Type" items={typeItems} />
        </div>
        <section className="admin-report-table-card admin-report-screen-only">
          <h2>Appointment Details</h2>
          <div className="admin-report-table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Time</th><th>Patient</th><th>Doctor</th><th>Appointment Type</th><th>Status</th></tr></thead>
              <tbody>{rows.map((item) => (
                <tr key={item.id}>
                  <td>{item.dateLabel}</td><td>{item.timeLabel}</td>
                  <td><div className="admin-report-person"><span>{getInitials(item.patientName)}</span><div><strong>{item.patientName}</strong><small>{item.patientDisplayId}</small></div></div></td>
                  <td><div className="admin-report-person is-doctor"><span>{getInitials(item.doctorName, "DR")}</span><div><strong>{item.doctorName}</strong><small>{item.doctorSpecialization}</small></div></div></td>
                  <td>{item.appointmentType}</td><td><StatusBadge status={item.status} label={item.statusLabel} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <TableFooter page={safePage} count={appointments.length} noun="appointments" onChange={setPage} />
        </section>
        <HorizontalBarChart title="Appointments Handled by Doctor" items={doctorStats.map((item) => ({ key: item.key, label: item.name, value: item.total }))} />
        <section className="admin-report-table-card admin-report-screen-only">
          <h2>Doctor Workload &amp; Performance</h2>
          <div className="admin-report-table-wrap">
            <table>
              <thead><tr><th>Doctor</th><th>Total</th><th>Completed</th><th>Upcoming</th><th>Canceled</th><th>Missed</th><th>Completion Rate</th></tr></thead>
              <tbody>{doctorStats.map((item) => (
                <tr key={item.key}>
                  <td><div className="admin-report-person is-doctor"><span>{getInitials(item.name, "DR")}</span><div><strong>{item.name}</strong><small>{item.specialization}</small></div></div></td>
                  <td>{item.total}</td><td>{item.completed}</td><td>{item.upcoming}</td><td>{item.canceled}</td><td>{item.missed}</td>
                  <td><strong className={`admin-report-rate ${item.completionRate >= 70 ? "is-good" : ""}`}>{item.completionRate}%</strong></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
        <PrintReportData model={model} />
      </ReportState>
    </>
  );
}

function PatientReportView({ data, loading, error, refresh, range, onRangeChange, originalRange }) {
  const [status, setStatus] = React.useState("all");
  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const patients = data?.patients || [];
  const filtered = patients.filter((item) => (status === "all" || item.status === status) && (!lowerText(search) || item.searchText.includes(lowerText(search))));
  const counts = patientStatusCounts(patients);
  const previous = patientStatusCounts(data?.previousPatients || []);
  const safePage = Math.min(page, Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)));
  const rows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const reset = () => { onRangeChange(originalRange); setStatus("all"); setSearch(""); setPage(1); };
  const statusItems = [
    { key: "active", label: "Active", color: "#16bc82", value: counts.active },
    { key: "temporary", label: "Temporary", color: "#f4a000", value: counts.temporary },
    { key: "inactive", label: "Inactive", color: "#f64669", value: counts.inactive },
  ];
  const model = {
    title: viewCopy.patient.title,
    rangeLabel: formatRangeLabel(range),
    filename: `patient-summary-${range.from}-to-${range.to}`,
    summary: ["total", "active", "temporary", "inactive"].map((key) => ({ label: key === "total" ? "Total Patients" : key.charAt(0).toUpperCase() + key.slice(1), value: counts[key] || 0 })),
    tables: [{
      title: "Patient Registration Cohort",
      headers: ["Patient ID", "Name", "Contact Number", "Status", "Date Registered"],
      rows: filtered.map((item) => [item.displayId, item.name, item.contact, item.statusLabel, item.registeredDateTimeLabel]),
    }],
  };
  return (
    <>
      <ExportActions getModel={() => model} />
      <ReportFilters
        range={range}
        onRangeChange={(next) => { onRangeChange(next); setPage(1); }}
        status={status}
        statusOptions={[
          { value: "active", label: "Active" },
          { value: "temporary", label: "Temporary" },
          { value: "inactive", label: "Inactive" },
        ]}
        onStatusChange={(value) => { setStatus(value); setPage(1); }}
        onReset={reset}
      />
      <ReportState loading={loading} error={error} empty={!loading && !error && !patients.length} onRetry={refresh}>
        <div className="admin-report-four-grid">
          <SummaryCard icon="solar:users-group-rounded-linear" tone="blue" label="Total Patients" value={counts.total} comparisonValue={comparison(counts.total, previous.total)} />
          <SummaryCard icon="solar:check-circle-linear" tone="green" label="Active Patients" value={counts.active} comparisonValue={comparison(counts.active, previous.active)} />
          <SummaryCard icon="solar:clock-circle-linear" tone="orange" label="Temporary" value={counts.temporary} comparisonValue={comparison(counts.temporary, previous.temporary)} />
          <SummaryCard icon="solar:close-circle-linear" tone="red" label="Inactive" value={counts.inactive} comparisonValue={comparison(counts.inactive, previous.inactive)} />
        </div>
        <div className="admin-report-chart-grid is-single">
          <DonutChart title="Patients by Status" items={statusItems} />
        </div>
        <section className="admin-report-table-card admin-report-screen-only">
          <header className="admin-report-table-heading"><h2>Patient Registration Cohort</h2><label><Icon icon="solar:magnifer-linear" /><input type="search" placeholder="Search Patients..." value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></label></header>
          <div className="admin-report-table-wrap"><table><thead><tr><th>Patient ID</th><th>Name</th><th>Contact Number</th><th>Status</th><th>Date Registered</th></tr></thead><tbody>
            {rows.map((item) => <tr key={item.id}><td>{item.displayId}</td><td><div className="admin-report-person"><span>{getInitials(item.name)}</span><strong>{item.name}</strong></div></td><td>{item.contact}</td><td><StatusBadge status={item.status} label={item.statusLabel} /></td><td>{item.registeredLabel}</td></tr>)}
          </tbody></table></div>
          <TableFooter page={safePage} count={filtered.length} noun="Patients" onChange={setPage} />
        </section>
        <PrintReportData model={model} />
      </ReportState>
    </>
  );
}

function buildDoctorStats(appointments, doctors) {
  const known = new Map(doctors.map((doctor) => [doctor.id, { ...doctor, key: doctor.id, total: 0, completed: 0, upcoming: 0, canceled: 0, missed: 0, rescheduled: 0 }]));
  appointments.forEach((item) => {
    const key = item.doctorKey;
    if (!known.has(key)) known.set(key, { id: key, key, name: item.doctorName, specialization: item.doctorSpecialization, total: 0, completed: 0, upcoming: 0, canceled: 0, missed: 0, rescheduled: 0 });
    const stats = known.get(key);
    stats.total += 1;
    if (Object.hasOwn(stats, item.status)) stats[item.status] += 1;
  });
  return Array.from(known.values()).filter((item) => item.total > 0).map((item) => {
    // Completion rate uses only appointments with known terminal outcomes;
    // upcoming and rescheduled appointments have not failed completion.
    const terminalOutcomes = item.completed + item.canceled + item.missed;
    return { ...item, completionRate: percent(item.completed, terminalOutcomes) };
  }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

function TrendsReportView({ data, loading, error, refresh, range, onRangeChange, originalRange }) {
  const patients = data?.patients || [];
  const appointments = data?.createdAppointments || [];
  const patientBuckets = buildBuckets(patients, range, "created_at");
  const appointmentBuckets = buildBuckets(appointments, range, "created_at");
  const trendRows = patientBuckets.map((bucket, index) => [
    bucket.label,
    bucket.value,
    appointmentBuckets[index]?.value || 0,
  ]);
  const model = {
    title: viewCopy.trends.title,
    rangeLabel: formatRangeLabel(range),
    filename: `registration-appointment-trends-${range.from}-to-${range.to}`,
    summary: [{ label: "Patient Registrations", value: patients.length }, { label: "Appointments Created", value: appointments.length }],
    tables: [{
      title: "Trend Data",
      headers: ["Period", "Patient Registrations", "Appointments Created"],
      rows: trendRows,
    }],
  };
  return (
    <>
      <ExportActions getModel={() => model} />
      <ReportFilters range={range} onRangeChange={onRangeChange} onReset={() => onRangeChange(originalRange)} />
      <ReportState loading={loading} error={error} empty={!loading && !error && !patients.length && !appointments.length} onRetry={refresh}>
        <div className="admin-report-two-grid">
          <SummaryCard icon="solar:users-group-rounded-linear" tone="green" label="Patient Registrations" value={patients.length} comparisonValue={comparison(patients.length, data?.previousPatients?.length || 0)} />
          <SummaryCard icon="solar:calendar-mark-linear" tone="purple" label="Appointments Created" value={appointments.length} comparisonValue={comparison(appointments.length, data?.previousCreatedAppointments?.length || 0)} />
        </div>
        <div className="admin-report-chart-grid"><LineChart title="Patient Registration Trend" buckets={patientBuckets} /><LineChart title="Appointment Creation Trend" buckets={appointmentBuckets} tone="purple" /></div>
        <PrintReportData model={model} />
      </ReportState>
    </>
  );
}

function AdminReportsModule({ view }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { isAdmin } = useAdminAuth();
  const fallbackRange = React.useMemo(() => getDefaultRange(view), [view]);
  const [range, setRange] = React.useState(() =>
    normalizeRange(searchParams.get("from"), searchParams.get("to"), fallbackRange)
  );
  const [originalRange] = React.useState(range);
  const reportData = useAdminReportData(range, isAdmin && view !== "landing", view);
  const copy = viewCopy[view];

  const updateRange = React.useCallback((nextRange) => {
    const normalized = normalizeRange(nextRange.from, nextRange.to, fallbackRange);
    setRange(normalized);
    setSearchParams({ from: normalized.from, to: normalized.to }, { replace: true });
  }, [fallbackRange, setSearchParams]);

  return (
    <>
        <AdminPageHeader className="admin-reports-title" title={copy.title} subtitle={copy.subtitle}>
          {view !== "landing" ? (
            <nav className="admin-report-breadcrumb" aria-label="Breadcrumb">
              <button type="button" onClick={() => navigate(`/admin/reports?from=${range.from}&to=${range.to}`)}><Icon icon="solar:arrow-left-linear" /> Reports</button>
              <Icon icon="solar:alt-arrow-right-linear" /> <span>{copy.breadcrumb}</span>
            </nav>
          ) : null}
        </AdminPageHeader>

        {view === "landing" ? (
          <LandingView range={range} onRangeChange={updateRange} navigate={navigate} />
        ) : view === "appointment" ? (
          <AppointmentReportView {...reportData} range={range} onRangeChange={updateRange} originalRange={originalRange} />
        ) : view === "patient" ? (
          <PatientReportView {...reportData} range={range} onRangeChange={updateRange} originalRange={originalRange} />
        ) : (
          <TrendsReportView {...reportData} range={range} onRangeChange={updateRange} originalRange={originalRange} />
        )}
    </>
  );
}

export default function AdminReports() {
  return <AdminReportsModule view="landing" />;
}

export function AdminAppointmentSummaryReport() {
  return <AdminReportsModule view="appointment" />;
}

export function AdminPatientSummaryReport() {
  return <AdminReportsModule view="patient" />;
}

export function AdminRegistrationAppointmentTrendsReport() {
  return <AdminReportsModule view="trends" />;
}
