const patientPwaSessionCache = new Map();
let activePatientId = "";
let patientStartupAuthorization = null;

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

export function setPatientPwaStartupAuthorization({
  userId,
  patientId,
  accountStatus,
}) {
  const normalizedUserId = String(userId || "").trim();
  const normalizedPatientId = String(patientId || "").trim();

  patientStartupAuthorization = normalizedUserId && normalizedPatientId
    ? {
        userId: normalizedUserId,
        patientId: normalizedPatientId,
        accountStatus,
      }
    : null;
}

export function takePatientPwaStartupAuthorization(userId) {
  const authorization = patientStartupAuthorization;
  patientStartupAuthorization = null;

  return authorization?.userId === String(userId || "").trim()
    ? authorization
    : null;
}

export function clearPatientPwaSessionCache() {
  patientPwaSessionCache.clear();
  activePatientId = "";
  patientStartupAuthorization = null;
}
