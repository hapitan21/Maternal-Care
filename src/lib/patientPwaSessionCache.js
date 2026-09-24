const patientPwaSessionCache = new Map();
let activePatientId = "";

function getCacheKey(patientId, section) {
  const normalizedPatientId = String(patientId || "").trim();
  const normalizedSection = String(section || "").trim();

  return normalizedPatientId && normalizedSection
    ? `${normalizedPatientId}:${normalizedSection}`
    : "";
}

export function getPatientPwaSessionCache(patientId, section) {
  const normalizedPatientId = String(patientId || "").trim();

  if (activePatientId && normalizedPatientId !== activePatientId) {
    return null;
  }

  const cacheKey = getCacheKey(patientId, section);
  return cacheKey ? patientPwaSessionCache.get(cacheKey) || null : null;
}

export function setPatientPwaSessionCache(patientId, section, value) {
  const normalizedPatientId = String(patientId || "").trim();

  if (activePatientId && normalizedPatientId !== activePatientId) {
    patientPwaSessionCache.clear();
  }
  if (normalizedPatientId) {
    activePatientId = normalizedPatientId;
  }

  const cacheKey = getCacheKey(patientId, section);

  if (cacheKey) {
    patientPwaSessionCache.set(cacheKey, value);
  }
}

export function clearPatientPwaSessionCache() {
  patientPwaSessionCache.clear();
  activePatientId = "";
}
