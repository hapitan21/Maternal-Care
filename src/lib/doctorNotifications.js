const doctorFollowupPath = "/doctor/follow-ups";
const followupIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escalationValues = new Set([
  "due_today",
  "recently_overdue",
  "high",
  "critical",
]);

const notificationPresentation = {
  medication_followup_due_today: {
    icon: "solar:clock-circle-bold",
    label: "Due Today",
  },
  medication_followup_recently_overdue: {
    icon: "solar:danger-triangle-bold",
    label: "Recently Overdue",
  },
  medication_followup_high: {
    icon: "solar:shield-warning-bold",
    label: "High Escalation",
  },
  medication_followup_critical: {
    icon: "solar:siren-rounded-bold",
    label: "Critical Escalation",
  },
};

const fallbackPresentation = {
  icon: "solar:bell-bold",
  label: "Follow-up Alert",
};

export const DOCTOR_NOTIFICATION_LIMIT = 50;

export function getDoctorNotificationPresentation(type) {
  return notificationPresentation[String(type || "").trim()] || fallbackPresentation;
}

export function getDoctorUnreadDisplay(count) {
  const normalized = Math.max(0, Math.floor(Number(count) || 0));
  return normalized > 99 ? "99+" : String(normalized);
}

export function getSafeDoctorNotificationTarget(targetPath) {
  const value = String(targetPath || "").trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("#")) {
    return doctorFollowupPath;
  }

  let parsed;
  try {
    parsed = new URL(value, "https://maternal-care.internal");
  } catch {
    return doctorFollowupPath;
  }

  if (parsed.pathname !== doctorFollowupPath) return doctorFollowupPath;
  if (!parsed.search) return doctorFollowupPath;

  const keys = Array.from(parsed.searchParams.keys());
  if (
    keys.length !== 2 ||
    !keys.includes("escalation") ||
    !keys.includes("followupId")
  ) {
    return doctorFollowupPath;
  }

  const escalation = String(parsed.searchParams.get("escalation") || "")
    .trim()
    .toLowerCase();
  const followupId = String(parsed.searchParams.get("followupId") || "").trim();
  if (!escalationValues.has(escalation) || !followupIdPattern.test(followupId)) {
    return doctorFollowupPath;
  }

  const safeParams = new URLSearchParams({ escalation, followupId });
  return `${doctorFollowupPath}?${safeParams.toString()}`;
}

export function getSafeDoctorFollowupId(value) {
  const normalized = String(value || "").trim();
  return followupIdPattern.test(normalized) ? normalized : "";
}

export function findAssignedDoctorFollowup(items, followupId, doctorId) {
  const safeFollowupId = getSafeDoctorFollowupId(followupId);
  const safeDoctorId = String(doctorId || "").trim();
  if (!safeFollowupId || !safeDoctorId) return null;

  return (
    (items || []).find(
      (item) =>
        item?.followup?.id === safeFollowupId &&
        item.followup.assigned_doctor_id === safeDoctorId
    ) || null
  );
}

export function formatDoctorNotificationTime(value, now = new Date()) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "Time unavailable";

  const elapsedMilliseconds = Math.max(0, now.getTime() - date.getTime());
  const elapsedMinutes = Math.floor(elapsedMilliseconds / 60_000);
  if (elapsedMinutes < 1) return "Just now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d ago`;

  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}
