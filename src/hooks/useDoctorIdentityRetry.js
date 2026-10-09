import { useCallback, useEffect, useRef, useState } from "react";

const authorizationErrors = new Set([
  "doctor_not_authenticated", "doctor_profile_missing", "doctor_role_mismatch", "doctor_account_inactive",
]);
const queryErrors = new Set([
  "doctor_auth_error", "doctor_profile_query_error", "doctor_personal_query_error", "doctor_professional_query_error",
]);

export function isRetryableDoctorIdentityError(error) {
  if (!error || authorizationErrors.has(error.code)) return false;
  if (error.code && !queryErrors.has(error.code)) return false;
  const cause = error.cause || error;
  const status = error.status ?? cause.status;
  if (status === 401 || status === 403 || ["42501", "PGRST301", "PGRST302"].includes(cause.code)) return false;
  return status === 0 || status >= 500 || String(cause.code || "").startsWith("08") || cause.code === "57014" ||
    /failed to fetch|fetch failed|network|timed? ?out|timeout|connection|temporar|unavailable|transient|internal server error/i.test(cause.message || "");
}

export function useDoctorIdentityRetry(doctorIdentity) {
  const { error, loading, refresh } = doctorIdentity;
  const mountedRef = useRef(false);
  const pendingRef = useRef(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingRef.current = null;
    };
  }, []);

  const retry = useCallback(() => {
    if (pendingRef.current) return pendingRef.current;
    if (!mountedRef.current || loading || !isRetryableDoctorIdentityError(error)) return undefined;
    setRetrying(true);
    setRetryError(null);
    // Install a synchronous lock before calling the existing authorized refresh.
    const request = Promise.resolve()
      .then(() => mountedRef.current && pendingRef.current === request ? refresh() : null)
      .catch(error => {
        if (mountedRef.current && pendingRef.current === request) setRetryError(error);
        return null;
      })
      .finally(() => {
        if (mountedRef.current && pendingRef.current === request) setRetrying(false);
        if (pendingRef.current === request) pendingRef.current = null;
      });
    pendingRef.current = request;
    return request;
  }, [error, loading, refresh]);

  return { retry, retrying, retryError };
}
