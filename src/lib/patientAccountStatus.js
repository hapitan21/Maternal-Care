export const patientAccountStatuses = {
  unlinked: "unlinked",
  pending: "pending_activation",
  active: "active",
  inactive: "inactive",
  archived: "archived",
};

function cleanText(value) {
  return String(value || "").trim();
}

export function normalizePatientAccountStatus(rowOrStatus, fallbackStatus = "") {
  if (typeof rowOrStatus === "object" && rowOrStatus !== null && isPatientRecordArchived(rowOrStatus)) {
    return patientAccountStatuses.archived;
  }

  const rawValue =
    typeof rowOrStatus === "object" && rowOrStatus !== null
      ? rowOrStatus.account_status || rowOrStatus.accountStatus || rowOrStatus.status
      : rowOrStatus;
  const normalized = cleanText(rawValue || fallbackStatus)
    .toLowerCase()
    .replace(/[_-]+/g, " ");

  if (["archived", "archive", "deleted"].includes(normalized)) {
    return patientAccountStatuses.archived;
  }

  if (["unlinked", "not linked"].includes(normalized)) {
    return patientAccountStatuses.unlinked;
  }

  if (
    [
      "active",
      "activated",
      "approved",
      "enabled",
    ].includes(normalized)
  ) {
    return patientAccountStatuses.active;
  }

  if (
    [
      "inactive",
      "deactivated",
      "disabled",
      "suspended",
      "blocked",
    ].includes(normalized)
  ) {
    return patientAccountStatuses.inactive;
  }

  if (
    [
      "temporary",
      "pending",
      "pending activation",
      "pending registration",
      "for activation",
      "awaiting activation",
    ].includes(normalized)
  ) {
    return patientAccountStatuses.pending;
  }

  return patientAccountStatuses.pending;
}

export function isPatientRecordArchived(row) {
  const lifecycleStatus = cleanText(row?.status).toLowerCase();
  return (
    lifecycleStatus === "archived" ||
    lifecycleStatus === "deleted" ||
    Boolean(row?.archived_at)
  );
}

export function getPatientAccountStatusLabel(status) {
  const normalized = normalizePatientAccountStatus(status);

  if (normalized === patientAccountStatuses.unlinked) return "Not Linked";
  if (normalized === patientAccountStatuses.active) return "Active";
  if (normalized === patientAccountStatuses.inactive) return "Inactive";
  if (normalized === patientAccountStatuses.archived) return "Archived";
  return "Pending Activation";
}

export function getPatientAccessBlockMessage(row) {
  if (isPatientRecordArchived(row)) {
    return "This patient record is archived. Please contact the clinic.";
  }

  const status = normalizePatientAccountStatus(row);

  if (
    status === patientAccountStatuses.unlinked ||
    status === patientAccountStatuses.pending
  ) {
    return "Your Patient account is pending Admin activation.";
  }

  if (status === patientAccountStatuses.inactive) {
    return "Your Patient account is inactive. Please contact the clinic.";
  }

  return "";
}

export function getLegacyPatientStatusValue(accountStatus) {
  const normalized = normalizePatientAccountStatus(accountStatus);

  if (normalized === patientAccountStatuses.active) return "Active";
  if (normalized === patientAccountStatuses.inactive) return "Inactive";
  if (normalized === patientAccountStatuses.archived) return "Archived";
  return "Pending Activation";
}
