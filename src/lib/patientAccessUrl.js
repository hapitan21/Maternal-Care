export const patientAccessPath = "/patient/access";

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function warnIfLocalhostPatientAccessUrl(accessUrl) {
  if (!import.meta.env.DEV || !accessUrl) return;

  try {
    const parsedUrl = new URL(accessUrl);

    if (
      parsedUrl.hostname === "localhost" ||
      parsedUrl.hostname === "127.0.0.1"
    ) {
      console.warn(
        "Patient Access URL uses localhost. A mobile device scanning this QR code cannot access the computer's localhost; set VITE_PATIENT_ACCESS_BASE_URL to the computer's LAN URL."
      );
    }
  } catch {
    // Relative URLs are allowed when no browser origin is available.
  }
}

function isMobileReachableHttpUrl(value) {
  try {
    const parsedUrl = new URL(value);
    return (
      (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") &&
      parsedUrl.hostname !== "localhost" &&
      parsedUrl.hostname !== "127.0.0.1" &&
      parsedUrl.hostname !== "0.0.0.0"
    );
  } catch {
    return false;
  }
}

export function getPublicAppOrigin() {
  /*
   * Canonical environment variable:
   *   VITE_PATIENT_ACCESS_BASE_URL=http://192.168.1.41:4173
   *
   * VITE_PATIENT_APP_URL is also supported as a backward-compatible alias
   * so an existing local .env does not silently fall back to localhost.
   */
  const configuredOrigin = normalizeBaseUrl(
    import.meta.env.VITE_PATIENT_ACCESS_BASE_URL ||
      import.meta.env.VITE_PATIENT_APP_URL
  );

  return (
    configuredOrigin ||
    (typeof window !== "undefined"
      ? normalizeBaseUrl(window.location.origin)
      : "")
  );
}

export function buildPatientAccessUrl({ patientId, controlNumber } = {}) {
  const normalizedPatientId = String(patientId || "").trim();
  const normalizedControlNumber = String(controlNumber || "").trim();

  if (!normalizedPatientId || !normalizedControlNumber) return "";

  const params = new URLSearchParams({
    patientId: normalizedPatientId,
    control: normalizedControlNumber,
  });

  const publicOrigin = getPublicAppOrigin();

  if (!publicOrigin) {
    return `${patientAccessPath}?${params.toString()}`;
  }

  try {
    const accessUrl = new URL(patientAccessPath, `${publicOrigin}/`);
    accessUrl.search = params.toString();

    const finalUrl = accessUrl.toString();
    warnIfLocalhostPatientAccessUrl(finalUrl);

    if (!isMobileReachableHttpUrl(finalUrl)) {
      return "";
    }

    return finalUrl;
  } catch (error) {
    if (import.meta.env.DEV) {
      console.error("Unable to build the patient access URL:", error);
    }

    return "";
  }
}
