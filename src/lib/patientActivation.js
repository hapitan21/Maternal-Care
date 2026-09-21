import { supabase } from "./supabaseClient";
import { getPatientRpcRow, normalizePatientAccessValue } from "./patientAuthLinking";

const patientIdPattern = /^LP-\d{4}-\d{5,}$/i;
const activationTokenPattern = /^LPMRH-[A-Z0-9-]{8,64}$/i;

const activationMessages = {
  archived: "This Patient record is archived. Please contact the clinic.",
  malformed: "Invalid patient access QR code.",
  mismatch: "The Patient ID and access code do not match.",
  missing: "Invalid patient access link.",
  pending_registration:
    "Patient registration has not been completed. Please ask clinic staff to finish registration.",
  unavailable:
    "Unable to validate this patient access link right now. Please contact the clinic.",
  unknown: "Invalid patient access QR code.",
  used: "This patient account has already been activated.",
};

export function normalizePatientActivationDetails(details) {
  return {
    patientId: normalizePatientAccessValue(details?.patientId),
    controlNumber: normalizePatientAccessValue(details?.controlNumber),
  };
}

export function getPatientActivationFormatError(details) {
  const normalized = normalizePatientActivationDetails(details);

  if (!normalized.patientId || !normalized.controlNumber) {
    return activationMessages.missing;
  }

  if (
    !patientIdPattern.test(normalized.patientId) ||
    !activationTokenPattern.test(normalized.controlNumber)
  ) {
    return activationMessages.malformed;
  }

  return "";
}

export function getPatientActivationMessage(state, fallback = "") {
  return activationMessages[state] || fallback || activationMessages.unknown;
}

export async function validatePatientActivation(details) {
  const normalized = normalizePatientActivationDetails(details);
  const formatError = getPatientActivationFormatError(normalized);

  if (formatError) {
    return {
      valid: false,
      state: normalized.patientId || normalized.controlNumber ? "malformed" : "missing",
      patientId: "",
      email: "",
      expiresAt: null,
      message: formatError,
    };
  }

  const { data, error } = await supabase.rpc("validate_patient_activation_qr", {
    p_patient_id: normalized.patientId,
    p_activation_token: normalized.controlNumber,
  });

  if (error) {
    return {
      valid: false,
      state: "unavailable",
      patientId: "",
      email: "",
      expiresAt: null,
      message: activationMessages.unavailable,
    };
  }

  const result = getPatientRpcRow(data);
  const state = normalizePatientAccessValue(result?.state).toLowerCase() || "unknown";
  const valid = result?.valid === true && state === "valid";

  return {
    valid,
    state,
    patientId: valid ? normalizePatientAccessValue(result?.patient_id) : "",
    email: valid ? normalizePatientAccessValue(result?.email).toLowerCase() : "",
    expiresAt: result?.expires_at || null,
    message: valid ? "Patient activation details verified." : getPatientActivationMessage(state),
  };
}
