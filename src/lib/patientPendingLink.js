export const patientPendingLinkStorageKey = "maternal_patient_pending_link";

function normalize(value) {
  return String(value || "").trim();
}

function readStoredDetails() {
  if (typeof window === "undefined") return { patientId: "", controlNumber: "" };

  try {
    const stored = JSON.parse(
      window.sessionStorage.getItem(patientPendingLinkStorageKey) || "{}"
    );

    return {
      patientId: normalize(stored.patientId),
      controlNumber: normalize(stored.controlNumber),
    };
  } catch {
    return { patientId: "", controlNumber: "" };
  }
}

export function resolvePatientPendingLink(searchParams) {
  const stored = readStoredDetails();
  const patientId = normalize(searchParams?.get("patientId")) || stored.patientId;
  const controlNumber =
    normalize(searchParams?.get("control")) || stored.controlNumber;
  const details = { patientId, controlNumber };

  if (patientId || controlNumber) {
    window.sessionStorage.setItem(
      patientPendingLinkStorageKey,
      JSON.stringify(details)
    );
  }

  return details;
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
