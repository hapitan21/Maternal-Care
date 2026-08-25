import {
  normalizePatientAccountStatus,
  patientAccountStatuses,
} from "./patientAccountStatus";

import { supabase } from "./supabaseClient";

export const linkingUnavailableMessage =
  "Patient account linking is not available yet. Please ask the clinic to apply the reviewed patient account-linking SQL.";

/**
 * Normalize values used throughout Patient account linking.
 */
export function normalizePatientAccessValue(value) {
  return String(value || "").trim();
}

/**
 * Supabase RPCs may return either one object or an array.
 * Always return the first available row.
 */
export function getPatientRpcRow(data) {
  if (Array.isArray(data)) {
    return data[0] || null;
  }

  return data || null;
}

/**
 * Detect when a required Patient RPC is missing.
 */
export function isMissingPatientRpcError(error) {
  if (!error) return false;

  const message = `${error.message || ""} ${
    error.details || ""
  }`.toLowerCase();

  return (
    error.code === "42883" ||
    error.code === "PGRST202" ||
    message.includes("could not find the function") ||
    message.includes("schema cache")
  );
}

/**
 * Detect an expired or missing Supabase Auth session.
 */
export function isMissingPatientAuthSession(error) {
  if (!error) return false;

  const message = String(
    error.message || ""
  ).toLowerCase();

  return (
    error.name === "AuthSessionMissingError" ||
    error.code === "session_not_found" ||
    message.includes("auth session missing") ||
    message.includes("session missing") ||
    message.includes("refresh token") ||
    message.includes("jwt expired")
  );
}

/**
 * Convert Patient account-linking errors into
 * user-friendly messages.
 */
export function getPatientLinkingErrorMessage(error) {
  if (isMissingPatientRpcError(error)) {
    return linkingUnavailableMessage;
  }

  const message = String(
    error?.message || ""
  ).toLowerCase();

  if (
    message.includes(
      "invalid patient id or control number"
    )
  ) {
    return "The Patient ID or one-time control number is incorrect.";
  }

  if (
    message.includes(
      "control number has already been used"
    )
  ) {
    return "This one-time control number has already been used.";
  }

  if (
    message.includes(
      "patient is already linked to another account"
    )
  ) {
    return "This Patient record is already linked to another account. Please contact the clinic.";
  }

  if (
    message.includes(
      "authentication account is already linked"
    )
  ) {
    return "This authentication account is already linked to another Patient record.";
  }

  if (
    message.includes(
      "patient record is archived"
    )
  ) {
    return "This Patient record is archived. Please contact the clinic.";
  }

  if (
    message.includes(
      "already linked to a different patient record"
    )
  ) {
    return "This Patient account is already linked to a different Patient record. Please contact the clinic.";
  }

  return (
    error?.message ||
    "Unable to link the Patient record. Please try again."
  );
}

/**
 * Get the Patient record linked to the currently
 * authenticated Patient account.
 *
 * IMPORTANT:
 *
 * The canonical account relationship is:
 *
 * auth.users.id
 *      ↓
 * patients.user_id
 *
 * profiles.patient_id is intentionally NOT used.
 */
export async function getCurrentPatientAccountStatus() {
  const { data, error } = await supabase.rpc(
    "get_current_patient_account_status"
  );

  if (error) {
    throw error;
  }

  const patient = getPatientRpcRow(data);

  return {
    patient,
    status: patient
      ? normalizePatientAccountStatus(
          patient.account_status
        )
      : patientAccountStatuses.unlinked,
  };
}

/**
 * Ensure that the authenticated Patient has a
 * public.profiles row.
 *
 * IMPORTANT:
 *
 * profiles.patient_id is no longer used as the
 * Patient/Auth ownership relationship.
 *
 * Patient ownership is determined by:
 *
 * patients.user_id = auth.uid()
 *
 * The patientId parameter is kept because existing
 * account-creation/login call sites already provide it,
 * and callers may still use the returned value.
 *
 * It is NOT written to public.profiles.
 */
export async function ensurePatientProfile(
  user,
  patientId
) {
  if (!user?.id) {
    throw new Error(
      "No authenticated Patient account was found."
    );
  }

  const linkedPatientId =
    normalizePatientAccessValue(patientId);

  // ============================================================
  // 1. Read existing profile
  // ============================================================
  const {
    data: profile,
    error: profileError,
  } = await supabase
    .from("profiles")
    .select(
      "id, role, full_name, email"
    )
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    throw profileError;
  }

  // ============================================================
  // 2. Make sure this Auth account is a Patient
  // ============================================================
  const existingRole =
    normalizePatientAccessValue(
      profile?.role
    ).toLowerCase();

  if (
    existingRole &&
    existingRole !== "patient"
  ) {
    throw new Error(
      "This login is not a Patient account."
    );
  }

  // ============================================================
  // 3. Build profile payload
  //
  // Notice that patient_id is intentionally NOT here.
  // ============================================================
  const profilePayload = {
    id: user.id,

    full_name:
      normalizePatientAccessValue(
        user.user_metadata?.full_name
      ) ||
      normalizePatientAccessValue(
        profile?.full_name
      ) ||
      "Patient",

    email:
      user.email ||
      profile?.email ||
      null,

    role: "patient",
  };

  // ============================================================
  // 4. Insert or update the Patient profile
  // ============================================================
  const { error: upsertError } =
    await supabase
      .from("profiles")
      .upsert(
        [profilePayload],
        {
          onConflict: "id",
        }
      );

  if (upsertError) {
    throw upsertError;
  }

  return {
    profileId: user.id,

    // This is only returned to the caller.
    // It is NOT stored in profiles.patient_id.
    patientId:
      linkedPatientId || null,
  };
}

/**
 * Human-readable Patient account access messages.
 */
export function getPatientAccountMessage(status) {
  if (
    status === patientAccountStatuses.pending
  ) {
    return "Your Patient account is pending Admin activation.";
  }

  if (
    status === patientAccountStatuses.inactive
  ) {
    return "Your Patient account is inactive. Please contact the clinic.";
  }

  if (
    status === patientAccountStatuses.archived
  ) {
    return "This Patient record is archived. Please contact the clinic.";
  }

  return "No Patient record is linked to this account yet.";
}