import { supabase } from "./supabaseClient";

export const ADMIN_FOLLOWUP_PAGE_SIZE = 25;

export const adminFollowupStatusOptions = Object.freeze([
  { value: "", label: "All" },
  { value: "open", label: "Open" },
  { value: "contacted", label: "Contacted" },
  { value: "monitoring", label: "Monitoring" },
  { value: "resolved", label: "Resolved" },
]);

export const adminFollowupSeverityOptions = Object.freeze([
  { value: "", label: "All" },
  { value: "warning", label: "Warning" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
]);

export const adminFollowupEscalationOptions = Object.freeze([
  { value: "", label: "All" },
  { value: "due_today", label: "Due Today" },
  { value: "recently_overdue", label: "Recently Overdue" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
  { value: "not_due", label: "Not Due" },
]);

export const adminFollowupSortOptions = Object.freeze([
  { value: "most_urgent", label: "Most urgent" },
  { value: "oldest_case", label: "Oldest case" },
  { value: "newest_case", label: "Newest case" },
  { value: "next_follow_up_earliest", label: "Next follow-up earliest" },
  { value: "recently_updated", label: "Recently updated" },
]);

const eventLabels = Object.freeze({
  followup_started: "Follow-up started",
  note_added: "Activity recorded",
  contact_attempt: "Contact attempted",
  patient_contacted: "Patient contacted",
  notification_sent: "Reminder notification sent",
  status_changed: "Status changed",
  followup_scheduled: "Follow-up scheduled",
  resolved: "Follow-up resolved",
  reopened: "Follow-up reopened",
  attention_acknowledged: "Attention acknowledged",
  attention_snoozed: "Alert snoozed",
  doctor_reassigned: "Doctor reassigned",
});

const statusLabels = Object.freeze({
  open: "Open",
  contacted: "Contacted",
  monitoring: "Monitoring",
  resolved: "Resolved",
});

const severityLabels = Object.freeze({
  warning: "Warning",
  high: "High",
  critical: "Critical",
});

const escalationLabels = Object.freeze({
  not_due: "Not Due",
  due_today: "Due Today",
  recently_overdue: "Recently Overdue",
  high: "High",
  critical: "Critical",
});

function cleanText(value) {
  return String(value || "").trim();
}

function getRpcErrorMessage(error) {
  const message = cleanText(error?.message).toLowerCase();
  if (error?.code === "PGRST202" || message.includes("schema cache")) {
    return "Admin follow-up oversight is not installed yet. Review and apply the Phase 5C.1 SQL.";
  }
  if (error?.code === "42501" || message.includes("active admin")) {
    return "Your account is not authorized to view clinic-wide follow-ups.";
  }
  if (error?.code === "22023") {
    return "One or more follow-up filters are invalid. Clear the filters and retry.";
  }
  return "Medication follow-up oversight could not be loaded. Please retry.";
}

function throwSafeRpcError(error) {
  console.error("Admin follow-up oversight request failed.", {
    code: error?.code || "unknown",
  });
  throw new Error(getRpcErrorMessage(error));
}

function getManagementErrorMessage(error) {
  const message = cleanText(error?.message).toLowerCase();
  if (error?.code === "PGRST202" || message.includes("schema cache")) {
    return "Admin follow-up coordination is not installed yet. Review and apply the Phase 5C.2 SQL.";
  }
  if (error?.code === "42501" || message.includes("active admin")) {
    return "Your account is not authorized to coordinate this follow-up.";
  }
  if (error?.code === "40001" || message.includes("changed after it was opened")) {
    return "This case changed after you opened it. Review the refreshed details before retrying.";
  }
  if (error?.code === "P0002" || message.includes("was not found")) {
    return "This follow-up is no longer available. Refresh the queue.";
  }
  if (message.includes("resolved")) {
    return "This historical case is resolved and cannot be administratively modified.";
  }
  if (message.includes("different active doctor")) {
    return "Select a Doctor other than the currently assigned Doctor.";
  }
  if (message.includes("not an active doctor")) {
    return "The selected Doctor is no longer active. Refresh the Doctor list and choose another account.";
  }
  if (message.includes("between 5 and 500")) {
    return "Enter a reassignment reason between 5 and 500 characters.";
  }
  return "The Doctor reassignment could not be completed. Refresh the case and retry.";
}

function throwSafeManagementError(error) {
  console.error("Admin follow-up coordination request failed.", {
    action: "reassign",
    code: error?.code || "unknown",
  });
  const safeError = new Error(getManagementErrorMessage(error));
  safeError.code = error?.code || "";
  throw safeError;
}

function normalizeSummary(data) {
  const row = Array.isArray(data) ? data[0] : data;
  return {
    activeCases: Math.max(0, Number(row?.active_cases) || 0),
    dueToday: Math.max(0, Number(row?.due_today) || 0),
    overdue: Math.max(0, Number(row?.overdue) || 0),
    critical: Math.max(0, Number(row?.critical) || 0),
    resolved: Math.max(0, Number(row?.resolved) || 0),
    doctorOptions: Array.isArray(row?.doctor_options) ? row.doctor_options : [],
    generatedAt: row?.generated_at || null,
  };
}

export async function loadAdminFollowupOversightSummary({
  resolvedStartDate,
  resolvedEndDate,
}) {
  const { data, error } = await supabase.rpc(
    "get_admin_followup_oversight_summary",
    {
      p_start_date: resolvedStartDate || null,
      p_end_date: resolvedEndDate || null,
    }
  );
  if (error) throwSafeRpcError(error);
  return normalizeSummary(data);
}

export async function loadAdminFollowupOversightQueue({
  search,
  status,
  severity,
  escalation,
  doctorId,
  startDate,
  endDate,
  sort,
  limit = ADMIN_FOLLOWUP_PAGE_SIZE,
  offset = 0,
}) {
  const { data, error } = await supabase.rpc(
    "get_admin_followup_oversight_queue",
    {
      p_search: cleanText(search) || null,
      p_status: status || null,
      p_severity: severity || null,
      p_escalation: escalation || null,
      p_doctor_id: doctorId || null,
      p_start_date: startDate || null,
      p_end_date: endDate || null,
      p_sort: sort || "most_urgent",
      p_limit: limit,
      p_offset: offset,
    }
  );
  if (error) throwSafeRpcError(error);

  const rows = data || [];
  return {
    rows,
    totalCount: Math.max(0, Number(rows[0]?.total_count) || 0),
    generatedAt: rows[0]?.generated_at || null,
  };
}

export async function loadAdminFollowupOversightDetail(followupId) {
  const { data, error } = await supabase.rpc(
    "get_admin_followup_oversight_detail",
    { p_followup_id: followupId }
  );
  if (error) throwSafeRpcError(error);
  return (Array.isArray(data) ? data[0] : data) || null;
}

export async function reassignAdminFollowupDoctor({
  followupId,
  newDoctorId,
  reason,
  expectedUpdatedAt,
}) {
  const normalizedReason = cleanText(reason);
  if (normalizedReason.length < 5 || normalizedReason.length > 500) {
    throw new Error("Enter a reassignment reason between 5 and 500 characters.");
  }
  if (!newDoctorId) throw new Error("Select a new active Doctor.");
  if (!expectedUpdatedAt) {
    throw new Error("The current case version is unavailable. Refresh the case and retry.");
  }

  const { data, error } = await supabase.rpc(
    "admin_reassign_medication_followup",
    {
      p_followup_id: followupId,
      p_new_doctor_id: newDoctorId,
      p_reason: normalizedReason,
      p_expected_updated_at: expectedUpdatedAt,
    }
  );
  if (error) throwSafeManagementError(error);
  return (Array.isArray(data) ? data[0] : data) || null;
}

export function formatAdminFollowupDoctorName(value) {
  const name = cleanText(value) || "Doctor";
  return /^dr\.?\s/i.test(name) ? name : `Dr. ${name}`;
}

export function formatAdminFollowupStatus(value) {
  return statusLabels[cleanText(value).toLowerCase()] || "Unknown";
}

export function formatAdminFollowupSeverity(value) {
  return severityLabels[cleanText(value).toLowerCase()] || "Warning";
}

export function formatAdminFollowupEscalation(value) {
  return escalationLabels[cleanText(value).toLowerCase()] || "Not Due";
}

export function formatAdminFollowupEvent(value) {
  return eventLabels[cleanText(value).toLowerCase()] || "Follow-up activity";
}

export function formatAdminFollowupDateTime(value, fallback = "Not recorded") {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatAdminFollowupDate(value, fallback = "Not recorded") {
  if (!value) return fallback;
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function formatAdminFollowupRelativeTime(row) {
  if (row?.status === "resolved") return "Resolved";
  if (row?.is_snoozed) {
    return `Snoozed until ${formatAdminFollowupDateTime(row.snoozed_until)}`;
  }
  if (!row?.next_follow_up_at || row?.seconds_from_due === null) {
    return "Not scheduled";
  }

  const seconds = Number(row.seconds_from_due);
  if (!Number.isFinite(seconds)) return "Schedule unavailable";
  const overdue = seconds >= 0;
  const absoluteMinutes = Math.max(1, Math.round(Math.abs(seconds) / 60));
  let duration;
  if (absoluteMinutes < 60) {
    duration = `${absoluteMinutes}m`;
  } else if (absoluteMinutes < 1440) {
    const hours = Math.floor(absoluteMinutes / 60);
    const minutes = absoluteMinutes % 60;
    duration = `${hours}h${minutes ? ` ${minutes}m` : ""}`;
  } else {
    const days = Math.floor(absoluteMinutes / 1440);
    const hours = Math.floor((absoluteMinutes % 1440) / 60);
    duration = `${days}d${hours ? ` ${hours}h` : ""}`;
  }
  return overdue ? `${duration} overdue` : `Due in ${duration}`;
}
