import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { isClinicAccountInactive } from "../lib/clinicAccountStatus";
import {
  getProfilePictureDisplayUrl,
  profilePictureUpdatedEvent,
} from "../lib/profilePicture";

const doctorPersonalTable = "doctor_personal_information";
const doctorProfessionalTable = "doctor_professional_information";

function createDoctorIdentityError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isSchemaColumnError(error) {
  if (!error) return false;

  const message = `${error.message || ""} ${error.details || ""}`.toLowerCase();

  return (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    message.includes("schema cache") ||
    message.includes("could not find") ||
    message.includes("column")
  );
}

function getAuthenticatedDisplayName(authUser, profile, personalInformation) {
  const metadataName =
    authUser?.user_metadata?.full_name || authUser?.user_metadata?.name || "";
  const emailName = authUser?.email ? authUser.email.split("@")[0] : "";

  return (
    String(personalInformation?.full_name || "").trim() ||
    String(profile?.full_name || "").trim() ||
    String(metadataName || "").trim() ||
    String(emailName || "").trim() ||
    "Doctor"
  );
}

export async function loadAuthenticatedDoctor(authUserOverride = null) {
  let authUser = authUserOverride;
  let authError = null;

  if (!authUser) {
    const authResult = await supabase.auth.getUser();
    authUser = authResult.data.user;
    authError = authResult.error;
  }

  if (authError) {
    throw createDoctorIdentityError(
      `Unable to load the authenticated Doctor: ${authError.message}`,
      "doctor_auth_error"
    );
  }

  if (!authUser?.id) {
    throw createDoctorIdentityError(
      "No authenticated Doctor account was found. Please log in again.",
      "doctor_not_authenticated"
    );
  }

  let { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, full_name, email, contact_number, role, account_status, avatar_url")
    .eq("id", authUser.id)
    .maybeSingle();

  if (profileError && isSchemaColumnError(profileError)) {
    const withoutAvatarResult = await supabase
      .from("profiles")
      .select("id, full_name, email, contact_number, role, account_status")
      .eq("id", authUser.id)
      .maybeSingle();
    profile = withoutAvatarResult.data;
    profileError = withoutAvatarResult.error;

    if (profileError && isSchemaColumnError(profileError)) {
      const legacyResult = await supabase
        .from("profiles")
        .select("id, full_name, email, contact_number, role")
        .eq("id", authUser.id)
        .maybeSingle();
      profile = legacyResult.data;
      profileError = legacyResult.error;
    }
  }

  if (profileError) {
    throw createDoctorIdentityError(
      `Unable to load the Doctor profile: ${profileError.message}`,
      "doctor_profile_query_error"
    );
  }

  if (!profile) {
    throw createDoctorIdentityError(
      "Doctor profile not found for the authenticated account.",
      "doctor_profile_missing"
    );
  }

  if (String(profile.role || "").trim().toLowerCase() !== "doctor") {
    throw createDoctorIdentityError(
      "The authenticated account is not assigned the Doctor role.",
      "doctor_role_mismatch"
    );
  }

  if (isClinicAccountInactive(profile.account_status)) {
    throw createDoctorIdentityError(
      "Your Doctor account has been deactivated. Please contact the administrator.",
      "doctor_account_inactive"
    );
  }

  const [personalResult, professionalResult] = await Promise.all([
    supabase
      .from(doctorPersonalTable)
      .select(
        "id, auth_user_id, full_name, birthdate, civil_status, gender, nationality, years_of_experience"
      )
      .eq("auth_user_id", authUser.id)
      .maybeSingle(),
    supabase
      .from(doctorProfessionalTable)
      .select(
        "id, auth_user_id, doctor_code, license_number, board_certification, email_address, contact_number, clinic_hospital_name, clinic_address"
      )
      .eq("auth_user_id", authUser.id)
      .maybeSingle(),
  ]);

  if (personalResult.error) {
    throw createDoctorIdentityError(
      `Unable to load Doctor personal information: ${personalResult.error.message}`,
      "doctor_personal_query_error"
    );
  }

  if (professionalResult.error) {
    throw createDoctorIdentityError(
      `Unable to load Doctor professional information: ${professionalResult.error.message}`,
      "doctor_professional_query_error"
    );
  }

  const personalInformation = personalResult.data || null;
  const professionalInformation = professionalResult.data || null;
  const doctorDisplayName = getAuthenticatedDisplayName(
    authUser,
    profile,
    personalInformation
  );
  let avatarUrl = "";

  if (profile.avatar_url) {
    try {
      avatarUrl = await getProfilePictureDisplayUrl(profile.avatar_url);
    } catch (avatarError) {
      if (import.meta.env.DEV) {
        console.warn("[Doctor Identity] unable to resolve profile picture", avatarError);
      }
    }
  }

  return {
    authUser,
    profile,
    personalInformation,
    professionalInformation,
    doctorDisplayName,
    doctorEmail:
      authUser.email ||
      professionalInformation?.email_address ||
      profile.email ||
      "",
    doctorContactNumber:
      professionalInformation?.contact_number || profile.contact_number || "",
    avatarUrl,
    role: "doctor",
  };
}

export function useAuthenticatedDoctor() {
  const mountedRef = useRef(true);
  const identityRef = useRef(null);
  const requestIdRef = useRef(0);
  const pendingRequestRef = useRef(null);
  const [identity, setIdentity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const clearIdentity = useCallback(() => {
    requestIdRef.current += 1;
    pendingRequestRef.current = null;
    identityRef.current = null;

    if (mountedRef.current) {
      setIdentity(null);
      setError(null);
      setLoading(false);
    }
  }, []);

  const resolveDoctorIdentity = useCallback(async (authUser, { force = false } = {}) => {
    if (!authUser?.id) {
      clearIdentity();
      return null;
    }

    const existingIdentity = identityRef.current;
    if (!force && existingIdentity?.authUser?.id === authUser.id) {
      if (existingIdentity.authUser !== authUser) {
        const updatedIdentity = { ...existingIdentity, authUser };
        identityRef.current = updatedIdentity;
        if (mountedRef.current) setIdentity(updatedIdentity);
        return updatedIdentity;
      }
      return existingIdentity;
    }

    if (pendingRequestRef.current?.userId === authUser.id) {
      return pendingRequestRef.current.promise;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const hasResolvedIdentity = existingIdentity?.authUser?.id === authUser.id;

    if (mountedRef.current) {
      setLoading(!hasResolvedIdentity);
      if (!hasResolvedIdentity) {
        setError(null);
      }
    }

    const request = loadAuthenticatedDoctor(authUser);
    pendingRequestRef.current = { userId: authUser.id, promise: request };

    try {
      const nextIdentity = await request;

      if (mountedRef.current && requestIdRef.current === requestId) {
        identityRef.current = nextIdentity;
        setIdentity(nextIdentity);
        setError(null);
        setLoading(false);
      }

      return nextIdentity;
    } catch (nextError) {
      if (mountedRef.current && requestIdRef.current === requestId) {
        if (
          identityRef.current?.authUser?.id !== authUser.id ||
          nextError.code === "doctor_account_inactive"
        ) {
          identityRef.current = null;
          setIdentity(null);
          setError(nextError);
        } else if (import.meta.env.DEV) {
          console.warn("[Doctor Identity] keeping last resolved Doctor after refresh error", nextError);
        }

        setLoading(false);
      }

      return null;
    } finally {
      if (pendingRequestRef.current?.promise === request) {
        pendingRequestRef.current = null;
      }
    }
  }, [clearIdentity]);

  const refresh = useCallback(async () => {
    const currentAuthUser = identityRef.current?.authUser;
    if (currentAuthUser?.id) {
      return resolveDoctorIdentity(currentAuthUser, { force: true });
    }

    const { data, error: authError } = await supabase.auth.getUser();
    if (authError) {
      const nextError = createDoctorIdentityError(
        `Unable to load the authenticated Doctor: ${authError.message}`,
        "doctor_auth_error"
      );
      if (mountedRef.current) {
        setError(nextError);
        setLoading(false);
      }
      return null;
    }

    return resolveDoctorIdentity(data.user, { force: true });
  }, [resolveDoctorIdentity]);

  useEffect(() => {
    mountedRef.current = true;
    const syncDoctorIdentity = () => refresh();
    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      const authUser = session?.user || null;

      if (event === "SIGNED_OUT" || !authUser) {
        clearIdentity();
        return;
      }

      if (event === "TOKEN_REFRESHED") {
        resolveDoctorIdentity(authUser);
        return;
      }

      resolveDoctorIdentity(authUser, { force: event === "USER_UPDATED" });
    });

    window.addEventListener("doctor-settings-updated", syncDoctorIdentity);
    window.addEventListener(profilePictureUpdatedEvent, syncDoctorIdentity);

    return () => {
      mountedRef.current = false;
      authListener.subscription.unsubscribe();
      window.removeEventListener("doctor-settings-updated", syncDoctorIdentity);
      window.removeEventListener(profilePictureUpdatedEvent, syncDoctorIdentity);
    };
  }, [clearIdentity, refresh, resolveDoctorIdentity]);

  return {
    authUser: identity?.authUser || null,
    profile: identity?.profile || null,
    personalInformation: identity?.personalInformation || null,
    professionalInformation: identity?.professionalInformation || null,
    doctorDisplayName: identity?.doctorDisplayName || "",
    doctorEmail: identity?.doctorEmail || "",
    doctorContactNumber: identity?.doctorContactNumber || "",
    avatarUrl: identity?.avatarUrl || "",
    role: identity?.role || "",
    loading,
    error,
    refresh,
  };
}
