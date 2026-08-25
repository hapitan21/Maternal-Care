const statusDefinitions = [
  { status: "pending", label: "Pending / Upcoming", color: "#fb387e" },
  { status: "checked_in", label: "Checked In", color: "#3b82f6" },
  { status: "completed", label: "Completed", color: "#22a06b" },
  { status: "rescheduled", label: "Rescheduled", color: "#f4b740" },
  { status: "cancelled", label: "Cancelled", color: "#ef6a78" },
  { status: "missed", label: "Missed / No Show", color: "#5b6478" },
  { status: "other", label: "Other", color: "#9b7ed8" },
];

export const adminAppointmentStatusDefinitions = statusDefinitions;

export function normalizeAdminDashboardAppointmentStatus(status) {
  const normalized = String(status || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (["scheduled", "pending", "upcoming"].includes(normalized)) return "pending";
  if (normalized === "checked_in") return "checked_in";
  if (["completed", "complete", "done"].includes(normalized)) return "completed";
  if (["cancel", "cancelled", "canceled"].includes(normalized)) return "cancelled";
  if (["rescheduled", "reschedule"].includes(normalized)) return "rescheduled";
  if (["missed", "no_show", "absent"].includes(normalized)) return "missed";
  return "other";
}

function titleCase(value, fallback) {
  const text = String(value || "").trim().replace(/[_-]+/g, " ");
  if (!text) return fallback;
  return text.replace(/\b\w/g, (character) => character.toUpperCase());
}

function getActivityTarget(module) {
  if (module === "user_management" || module === "patient_management") return "users";
  if (module === "appointment_management") return "appointments";
  if (module === "reports") return "reports";
  return "logs";
}

function getActivityIcon(module) {
  if (module === "user_management" || module === "patient_management") return "solar:users-group-rounded-linear";
  if (module === "appointment_management") return "solar:calendar-mark-linear";
  if (module === "reports") return "solar:chart-2-linear";
  if (module === "authentication") return "solar:login-2-linear";
  return "solar:clipboard-list-linear";
}

function getSafeDescription(row) {
  if (row.action === "reassign") return "A Doctor assignment was updated.";
  if (row.module === "visit_records") return "A visit-record activity was recorded.";
  if (row.module === "reminder_management") return "A reminder workflow activity was recorded.";
  if (row.module === "patient_management") return "A Patient management activity was recorded.";
  return String(row.description || "An Admin activity was recorded.").trim();
}

export function mapAdminAuditActivity(row, formatTime) {
  return {
    id: row.id,
    icon: getActivityIcon(row.module),
    description: getSafeDescription(row),
    actor: String(row.actor_name || "System").trim(),
    actorRole: titleCase(row.actor_role, "System"),
    module: titleCase(row.module, "System"),
    action: titleCase(row.action, "Activity"),
    timeLabel: formatTime(row.created_at),
    target: getActivityTarget(row.module),
  };
}
