import { useCallback, useEffect, useRef, useState } from "react";
import { getDoctorRouteAuthorization } from "../lib/doctorRouteAuthorization";
import { supabase } from "../lib/supabaseClient";

function createLoadingState() {
  return {
    loading: true,
    authorized: false,
    reason: "doctor_authorization_loading",
    redirectTo: "",
    role: "",
    user: null,
    profile: null,
  };
}

export function useDoctorRouteAuthorization() {
  const mountedRef = useRef(false);
  const requestIdRef = useRef(0);
  const [authorization, setAuthorization] = useState(createLoadingState);

  const markAuthorizationLoading = useCallback(() => {
    setAuthorization((current) => {
      if (current.authorized && current.user?.id) {
        return { ...current, loading: true };
      }

      return createLoadingState();
    });
  }, []);

  const resolveAuthorization = useCallback(async (authUserOverride) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (mountedRef.current) {
      markAuthorizationLoading();
    }

    let user = authUserOverride;
    let authError = null;

    if (authUserOverride === undefined) {
      try {
        const authResult = await supabase.auth.getUser();
        user = authResult.data.user;
        authError = authResult.error;
      } catch (error) {
        user = null;
        authError = error;
      }
    }

    if (authError || !user?.id) {
      const decision = getDoctorRouteAuthorization({ user, authError });
      if (mountedRef.current && requestIdRef.current === requestId) {
        setAuthorization({ loading: false, ...decision });
      }
      return decision;
    }

    let profile;
    let profileError;

    try {
      const profileResult = await supabase
        .from("profiles")
        .select("id, role, account_status")
        .eq("id", user.id)
        .maybeSingle();
      profile = profileResult.data;
      profileError = profileResult.error;
    } catch (error) {
      profileError = error;
    }

    const decision = getDoctorRouteAuthorization({
      user,
      profile,
      profileError,
    });

    if (mountedRef.current && requestIdRef.current === requestId) {
      setAuthorization({ loading: false, ...decision });
    }

    return decision;
  }, [markAuthorizationLoading]);

  useEffect(() => {
    mountedRef.current = true;
    const timers = new Set();

    const clearTimers = () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };

    const invalidateAndSchedule = (authUserOverride) => {
      requestIdRef.current += 1;
      clearTimers();
      markAuthorizationLoading();

      const timer = window.setTimeout(() => {
        timers.delete(timer);
        resolveAuthorization(authUserOverride);
      }, 0);
      timers.add(timer);
    };

    invalidateAndSchedule(undefined);

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      const authUser = session?.user || null;

      if (!authUser?.id) {
        requestIdRef.current += 1;
        clearTimers();
        setAuthorization({
          loading: false,
          ...getDoctorRouteAuthorization({ user: null }),
        });
        return;
      }

      invalidateAndSchedule(authUser);
    });

    const handleWindowFocus = () => invalidateAndSchedule(undefined);
    window.addEventListener("focus", handleWindowFocus);

    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      clearTimers();
      authListener.subscription.unsubscribe();
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [markAuthorizationLoading, resolveAuthorization]);

  return authorization;
}
