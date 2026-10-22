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
  if (module === "user_management" || module === "patient_management") return "solar:users-group-rounded-bold";
  if (module === "appointment_management") return "solar:calendar-mark-bold";
  if (module === "reports") return "solar:chart-2-bold";
  if (module === "authentication") return "solar:login-2-bold";
  return "solar:clipboard-list-bold";
}

function getSafeDescription(row) {
  // Fixed labels only: never render clinical notes from a business audit payload.
  const businessLabels = {
    appointment: {
      create: "An appointment was created.",
      cancel: "An appointment was cancelled.",
      check_in: "An appointment was checked in.",
    },
    appointment_reschedule_event: { reschedule: "An appointment was rescheduled." },
    staff_initial_assessment: { create: "Staff Initial Assessment saved.", update: "Staff Initial Assessment updated." },
    staff_follow_up_assessment: { create: "Staff Follow-Up Assessment saved.", update: "Staff Follow-Up Assessment updated." },
    initial_visit_record: { create: "Initial Visit record saved.", update: "Initial Visit record updated." },
    follow_up_visit_record: { create: "Follow-Up Visit record saved.", update: "Follow-Up Visit record updated." },
    patient_registration: { register: "Patient registration finished." },
    appointment_reminder: { create: "An appointment reminder was created.", update: "An appointment reminder was updated.", delete: "An appointment reminder was deleted." },
    medication_reminder: { create: "A medication reminder was created.", update: "A medication reminder was updated.", delete: "A medication reminder was deleted." },
    appointment_booking_request: { create: "A Patient booking request was submitted." },
    medication_adherence: { acknowledge: "A Patient medication adherence response was recorded." },
  };
  const expectedModules = {
    appointment: "appointment_management", appointment_reschedule_event: "appointment_management",
    staff_initial_assessment: "visit_records", staff_follow_up_assessment: "visit_records",
    initial_visit_record: "visit_records", follow_up_visit_record: "visit_records",
    patient_registration: "patient_management", appointment_booking_request: "appointment_management",
    appointment_reminder: "reminder_management", medication_reminder: "reminder_management",
    medication_adherence: "reminder_management",
  };
  if (Object.hasOwn(businessLabels, row.entity_type) && row.module === expectedModules[row.entity_type]
      && Object.hasOwn(businessLabels[row.entity_type], row.action)) {
    return businessLabels[row.entity_type][row.action];
  }
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
