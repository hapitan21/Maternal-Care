export const patientPendingLinkStorageKey = "maternal_patient_pending_link";

function normalize(value) {
  return String(value || "").trim();
}

export function resolvePatientPendingLink(searchParams) {
  const patientId = normalize(searchParams?.get("patientId"));
  const controlNumber = normalize(searchParams?.get("control"));

  return { patientId, controlNumber };
}

export function buildPatientPendingLinkSearch(details) {
  const params = new URLSearchParams();
  const patientId = normalize(details?.patientId);
  const controlNumber = normalize(details?.controlNumber);

  if (patientId) params.set("patientId", patientId);
  if (controlNumber) params.set("control", controlNumber);

  const query = params.toString();
  return query ? `?${query}` : "";
}

export function clearPatientPendingLink() {
  if (typeof window !== "undefined") {
    window.sessionStorage.removeItem(patientPendingLinkStorageKey);
  }
}
