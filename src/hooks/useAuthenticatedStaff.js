import { useCallback, useEffect, useRef, useState } from "react";
import { isClinicAccountInactive } from "../lib/clinicAccountStatus";
import { supabase } from "../lib/supabaseClient";
import { clearStaffSessionCache } from "../lib/staffSessionCache";
import {
  clearStaffSettingsMemoryCache,
  hydrateStaffSettingsFromIdentity,
} from "../lib/staffProfile";

const inactiveStaffMessage =
  "Your Staff account has been deactivated. Please contact the system administrator.";

let cachedStaffIdentity = null;

function createStaffAccessError(message, code, role = "") {
  const error = new Error(message);
  error.code = code;
  error.role = role;
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

function isDefinitiveStaffAccessError(error) {
  return [
    "staff_not_authenticated",
    "staff_profile_missing",
    "staff_role_mismatch",
    "staff_account_inactive",
  ].includes(error?.code);
}

export function useAuthenticatedStaff() {
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const inFlightRef = useRef(null);

  /*
   * Reuse the already-authorized Staff identity when React Router moves
   * between /staff pages. This prevents "Checking Staff account access..."
   * from flashing on every Staff navigation.
   */
  const [identity, setIdentity] = useState(() => cachedStaffIdentity);
  const [loading, setLoading] = useState(() => !cachedStaffIdentity);
  const [error, setError] = useState(null);
  const [refreshError, setRefreshError] = useState(null);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) {
      return inFlightRef.current;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    /*
     * Only block the Staff route when there has never been a successful
     * authorization in this app session. Focus/tab refreshes are silent.
     */
    if (!cachedStaffIdentity && mountedRef.current) {
      setLoading(true);
    }

    const request = (async () => {
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser();

      if (authError || !user?.id) {
        throw createStaffAccessError(
          "No authenticated Staff account was found. Please log in again.",
          "staff_not_authenticated"
        );
      }

      let { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("id, full_name, email, role, account_status")
        .eq("id", user.id)
        .maybeSingle();

      if (profileError && isSchemaColumnError(profileError)) {
        const legacyResult = await supabase
          .from("profiles")
          .select("id, full_name, email, role")
          .eq("id", user.id)
          .maybeSingle();

        profile = legacyResult.data;
        profileError = legacyResult.error;
      }

      if (profileError) {
        throw profileError;
      }

      if (!profile) {
        throw createStaffAccessError(
          "The Staff profile connected to this account was not found.",
          "staff_profile_missing"
        );
      }

      const role = String(profile.role || "").trim().toLowerCase();

      if (role !== "staff") {
        throw createStaffAccessError(
          "The authenticated account is not assigned the Staff role.",
          "staff_role_mismatch",
          role
        );
      }

      if (isClinicAccountInactive(profile.account_status)) {
        cachedStaffIdentity = null;
        await supabase.auth.signOut();

        throw createStaffAccessError(
          inactiveStaffMessage,
          "staff_account_inactive",
          role
        );
      }

      const nextIdentity = {
        authUser: user,
        profile,
        role,
      };

      if (
        cachedStaffIdentity?.authUser?.id &&
        cachedStaffIdentity.authUser.id !== user.id
      ) {
        clearStaffSessionCache();
      }

      cachedStaffIdentity = nextIdentity;
      hydrateStaffSettingsFromIdentity(nextIdentity, { broadcast: false });

      if (
        mountedRef.current &&
        requestIdRef.current === requestId
      ) {
        setIdentity(nextIdentity);
        setError(null);
        setRefreshError(null);
        setLoading(false);
      }

      return nextIdentity;
    })()
      .catch((nextError) => {
        if (
          !mountedRef.current ||
          requestIdRef.current !== requestId
        ) {
          return null;
        }

        if (isDefinitiveStaffAccessError(nextError)) {
          cachedStaffIdentity = null;
          clearStaffSessionCache();
          clearStaffSettingsMemoryCache();
          setIdentity(null);
          setError(nextError);
          setRefreshError(null);
        } else if (cachedStaffIdentity) {
          /*
           * A temporary background refresh/network failure must not wipe an
           * already-authorized Staff workspace.
           */
          setIdentity(cachedStaffIdentity);
          setError(null);
          setRefreshError(nextError);

          if (import.meta.env.DEV) {
            console.warn(
              "[Staff Auth] background refresh failed; keeping last authorized identity",
              nextError
            );
          }
        } else {
          setIdentity(null);
          setError(nextError);
          setRefreshError(null);
        }

        setLoading(false);
        return null;
      })
      .finally(() => {
        if (inFlightRef.current === request) {
          inFlightRef.current = null;
        }
      });

    inFlightRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    const timer = window.setTimeout(refresh, 0);

    const handleFocus = () => {
      /*
       * Revalidate security after returning to the tab, but do it silently.
       */
      refresh();
    };

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        cachedStaffIdentity = null;
        clearStaffSessionCache();
        clearStaffSettingsMemoryCache();

        if (mountedRef.current) {
          setIdentity(null);
          setError(null);
          setRefreshError(null);
          setLoading(false);
        }
      }
    });

    window.addEventListener("focus", handleFocus);

    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      window.clearTimeout(timer);
      window.removeEventListener("focus", handleFocus);
      subscription.unsubscribe();
    };
  }, [refresh]);

  return {
    identity,
    loading,
    error,
    refreshError,
    isStaff: Boolean(identity?.role === "staff"),
    refresh,
  };
}
