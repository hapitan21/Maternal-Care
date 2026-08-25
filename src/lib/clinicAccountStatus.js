export const clinicAccountStatuses = {
  active: "active",
  inactive: "inactive",
};

function cleanText(value) {
  return String(value || "").trim();
}

export function normalizeClinicAccountStatus(value) {
  const normalized = cleanText(value).toLowerCase().replace(/[_-]+/g, " ");

  if (["inactive", "deactivated", "disabled", "suspended", "blocked"].includes(normalized)) {
    return clinicAccountStatuses.inactive;
  }

  return clinicAccountStatuses.active;
}

export function getClinicAccountStatusLabel(value) {
  return normalizeClinicAccountStatus(value).toUpperCase();
}

export function isClinicAccountInactive(value) {
  return normalizeClinicAccountStatus(value) === clinicAccountStatuses.inactive;
}
