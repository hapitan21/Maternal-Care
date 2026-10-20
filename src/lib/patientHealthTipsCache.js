import {
  getPatientPwaSessionCache,
  setPatientPwaSessionCache,
} from "./patientPwaSessionCache.js";

export function readPatientHealthTipsCache(patientId) {
  return getPatientPwaSessionCache(patientId, "health-tips");
}

export function savePatientHealthTipsCache(result) {
  if (result.patientId) setPatientPwaSessionCache(result.patientId, "health-tips", result);
}

export function retainPatientHealthTipsOnError(patientId, error) {
  // Permission/session errors must never keep showing previously authorized data.
  const denied = [401, 403].includes(Number(error?.status)) ||
    ["42501", "PGRST301", "PGRST302", "PGRST303"].includes(error?.code);
  if (denied) setPatientPwaSessionCache(patientId, "health-tips", null);
  return readPatientHealthTipsCache(patientId) || { patientId, tips: [] };
}
