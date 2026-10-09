import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { DoctorSignOutContext, RoleInactivityContext } from "../../context/roleInactivityContext";
import { supabase } from "../../lib/supabaseClient";
import { clearClinicSessionCaches } from "../../lib/clinicSessionCleanup";
import {
  createRoleInactivityManager, getInactivityScope, getLogicalSessionIdentity,
  INACTIVITY_LOGIN_PATH, INACTIVITY_STORAGE_PREFIX, isClinicPath, isClinicRole, signOutExpiredClinicSession,
} from "../../lib/roleInactivity";
import InactivityWarningDialog from "./InactivityWarningDialog";

const authStorageKey = "sb-" + new URL(import.meta.env.VITE_SUPABASE_URL).hostname.split(".")[0] + "-auth-token";

export default function RoleInactivityProvider({ children }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [view, setView] = useState({ phase: "disabled", secondsRemaining: 0 });
  const [restoring, setRestoring] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const [manualLogout, setManualLogout] = useState(false);
  const logoutStatusRef = useRef(null);
  const controllerMountedRef = useRef(false);
  const rootRef = useRef(null);
  const pathRef = useRef(pathname);
  const managerRef = useRef(null);
  const verifiedRef = useRef(null);
  const authRef = useRef({ identity: "", scope: "", userId: "", generation: 0 });
  const expiredRef = useRef(null);
  const logoutRef = useRef(null);
  const restoreRef = useRef(0);
  const restoreModeRef = useRef("");
  const restoreTargetRef = useRef(null);

  const blockImmediately = useCallback(() => {
    if (rootRef.current) {
      rootRef.current.hidden = true;
      rootRef.current.inert = true;
    }
  }, []);

  const logoutExpired = useCallback(() => {
    const expired = expiredRef.current;
    if (!expired || logoutRef.current) return logoutRef.current;
    blockImmediately();
    setLogoutFailed(false);
    const isCurrent = () => controllerMountedRef.current && expiredRef.current === expired &&
      (authRef.current.identity === expired.identity || (!authRef.current.identity && !authRef.current.userId));
    const request = (async () => {
      let storage;
      try { storage = window.localStorage; } catch { /* Missing persistence keeps a failed logout blocked. */ }
      const locallySignedOut = await signOutExpiredClinicSession({
        auth: supabase.auth,
        storage,
        authStorageKey,
        identity: expired.identity,
        isCurrent,
        cleanup: () => { if (isCurrent()) clearClinicSessionCaches(); },
        warn: () => console.warn("Inactivity sign-out could not reach the server; removing the expired local session."),
      }).catch(() => false);
      if (!isCurrent()) return;
      if (locallySignedOut) {
        navigate(expired.reason === "manual" ? "/login?logout=1" : INACTIVITY_LOGIN_PATH, { replace: true });
      } else {
        setLogoutFailed(true);
        console.warn("Inactivity sign-out is incomplete. Protected access remains blocked.");
      }
    })();
    logoutRef.current = request;
    void request.finally(() => {
      if (logoutRef.current === request) logoutRef.current = null;
    });
    return request;
  }, [blockImmediately, navigate]);

  const requestDoctorSignOut = useCallback(() => {
    if (!/^\/doctor(?:\/|$)/.test(pathRef.current)) return undefined;
    managerRef.current?.check();
    if (expiredRef.current) return logoutExpired();
    if (logoutRef.current) return logoutRef.current;
    const auth = authRef.current;
    const verified = verifiedRef.current;
    if (!auth.identity || verified?.role !== "doctor" || verified.userId !== auth.userId) return undefined;

    // Manual logout is terminal for this workspace too. Reuse the existing
    // fence, lock, targeted cleanup, SDK fallback and blocked retry rendering.
    expiredRef.current = { identity: auth.identity, reason: "manual" };
    blockImmediately();
    setRestoring(false);
    setManualLogout(true);
    managerRef.current?.stop();
    setView({ phase: "expired", secondsRemaining: 0 });
    clearClinicSessionCaches();
    return logoutExpired();
  }, [blockImmediately, logoutExpired]);

  useEffect(() => {
    if (manualLogout && view.phase === "expired") logoutStatusRef.current?.focus();
  }, [manualLogout, view.phase, logoutFailed]);

  const activateVerified = useCallback(() => {
    const verified = verifiedRef.current;
    const auth = authRef.current;
    if (expiredRef.current || !managerRef.current || !isClinicPath(pathRef.current)) return;
    if (!verified || verified.userId !== auth.userId || !auth.scope || !isClinicRole(verified.role)) {
      managerRef.current.stop();
      return;
    }
    managerRef.current.activate({ ...verified, scope: auth.scope, authorized: true });
    if (restoreModeRef.current === "auth-change" && !expiredRef.current) {
      restoreModeRef.current = "";
      setRestoring(false);
    }
  }, []);

  const register = useCallback((identity) => {
    verifiedRef.current = identity;
    activateVerified();
    return () => {
      if (verifiedRef.current !== identity) return;
      verifiedRef.current = null;
      if (!expiredRef.current) managerRef.current?.stop();
    };
  }, [activateVerified]);

  const restoreAuthorization = useCallback(async () => {
    managerRef.current?.check();
    if (expiredRef.current || !isClinicPath(pathRef.current)) return;
    blockImmediately();
    setRestoring(true);
    restoreModeRef.current = "restore";
    const restore = ++restoreRef.current;
    const verified = verifiedRef.current || restoreTargetRef.current;
    const identity = authRef.current.identity;
    try {
      // Reuse the guard's authoritative check; the provider never queries roles.
      const result = await verified?.revalidate();
      const current = await supabase.auth.getSession();
      const resultUserId = result?.authUser?.id || result?.user?.id;
      if (restore !== restoreRef.current || expiredRef.current) return;
      if (!current.error && identity && getLogicalSessionIdentity(current.data?.session) === identity &&
          result?.authorized !== false && resultUserId === verified?.userId && result?.role === verified?.role) {
        managerRef.current?.check();
        if (!expiredRef.current) {
          restoreModeRef.current = "";
          setRestoring(false);
        }
      }
    } catch { /* Keep the restored workspace blocked until reauthorization succeeds. */ }
  }, [blockImmediately]);

  useEffect(() => {
    controllerMountedRef.current = true;
    let alive = true;
    let scrollIntentUntil = 0;
    let storage;
    try { storage = window.localStorage; } catch { /* Same-tab timer still works. */ }
    const manager = createRoleInactivityManager({
      storage,
      onChange: (next) => {
        if (!alive) return;
        if (!expiredRef.current || next.phase === "expired") setView(next);
      },
      onExpire: () => {
        setRestoring(false);
        expiredRef.current = { identity: authRef.current.identity };
        blockImmediately();
        clearClinicSessionCaches();
        logoutExpired();
      },
      onRemoteLogout: () => {
        blockImmediately();
        setRestoring(true);
        void restoreAuthorization();
      },
    });
    managerRef.current = manager;

    const synchronizeSession = (session) => {
      if (!alive) return;
      const identity = getLogicalSessionIdentity(session);
      const previous = authRef.current;
      const changed = identity !== previous.identity;
      const previousVerified = verifiedRef.current;
      if (!changed && (!identity || previous.scope)) return;
      const generation = previous.generation + 1;
      authRef.current = { identity, scope: "", userId: session?.user?.id || "", generation };
      restoreRef.current += 1;
      manager.stop({ clear: changed });
      if (changed && previous.scope) {
        try { storage?.removeItem(INACTIVITY_STORAGE_PREFIX + previous.scope); } catch { /* Targeted cleanup only. */ }
      }
      if (changed && previous.identity) {
        verifiedRef.current = null;
        restoreTargetRef.current = previousVerified ? { ...previousVerified, userId: session?.user?.id || "" } : null;
        clearClinicSessionCaches();
        if (isClinicPath(pathRef.current)) {
          blockImmediately();
          restoreModeRef.current = "auth-change";
          setRestoring(true);
        }
      }
      if (!identity) {
        if (expiredRef.current) setRestoring(false);
        return;
      }
      if (changed && previousVerified && (previousVerified.role === "staff" ||
          (previousVerified.role === "admin" && previous.userId === session.user?.id))) {
        // These guards do not automatically revalidate every SIGNED_IN event.
        // Defer outside the SDK auth callback/lock and reuse their own checks.
        window.setTimeout(() => {
          if (alive && authRef.current.generation === generation) void previousVerified.revalidate();
        }, 0);
      }
      // A replacement session cannot inherit an expired state or stale logout work.
      if (expiredRef.current && identity !== expiredRef.current.identity) {
        expiredRef.current = null;
        setManualLogout(false);
        setLogoutFailed(false);
        setView({ phase: "disabled", secondsRemaining: 0 });
      }
      void getInactivityScope(identity).then((scope) => {
        if (!alive || authRef.current.generation !== generation) return;
        authRef.current.scope = scope;
        activateVerified();
        if (verifiedRef.current?.userId === authRef.current.userId && !expiredRef.current) setRestoring(false);
      }).catch(() => {
        if (isClinicPath(pathRef.current)) {
          blockImmediately();
          setRestoring(true);
        }
      });
    };
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      synchronizeSession(session);
    });
    const initialGeneration = authRef.current.generation;
    void supabase.auth.getSession().then(({ data, error }) => {
      if (alive && !error && authRef.current.generation === initialGeneration) synchronizeSession(data.session);
    });

    const activity = (event) => {
      if (!event.isTrusted) return;
      scrollIntentUntil = Date.now() + 2000;
      manager.activity();
    };
    const wheel = (event) => {
      if (event.deltaX || event.deltaY) activity(event);
    };
    const scroll = (event) => {
      if (event.isTrusted && Date.now() <= scrollIntentUntil) manager.activity();
    };
    const checkTime = () => manager.check();
    const pageHide = (event) => {
      if (event.persisted && isClinicPath(pathRef.current) && !expiredRef.current) blockImmediately();
    };
    const pageShow = (event) => {
      manager.check();
      if (event.persisted) void restoreAuthorization();
    };
    const storageChanged = (event) => {
      manager.storageChanged(event);
      if (event.key !== authStorageKey) return;
      const verified = verifiedRef.current || restoreTargetRef.current;
      void supabase.auth.getSession().then(({ data, error }) => {
        if (!alive || error) return;
        const changed = getLogicalSessionIdentity(data.session) !== authRef.current.identity;
        synchronizeSession(data.session);
        // Also covers browsers where SDK BroadcastChannel delivery is unavailable.
        if (changed && verified && isClinicPath(pathRef.current)) void verified.revalidate();
      });
    };
    for (const name of ["pointerdown", "keydown", "touchstart"]) document.addEventListener(name, activity, { capture: true, passive: true });
    document.addEventListener("wheel", wheel, { capture: true, passive: true });
    document.addEventListener("scroll", scroll, { capture: true, passive: true });
    document.addEventListener("visibilitychange", checkTime);
    window.addEventListener("focus", checkTime);
    window.addEventListener("pageshow", pageShow);
    window.addEventListener("pagehide", pageHide);
    window.addEventListener("storage", storageChanged);
    activateVerified();
    return () => {
      alive = false;
      controllerMountedRef.current = false;
      manager.stop();
      managerRef.current = null;
      subscription.unsubscribe();
      for (const name of ["pointerdown", "keydown", "touchstart"]) document.removeEventListener(name, activity, true);
      document.removeEventListener("wheel", wheel, true);
      document.removeEventListener("scroll", scroll, true);
      document.removeEventListener("visibilitychange", checkTime);
      window.removeEventListener("focus", checkTime);
      window.removeEventListener("pageshow", pageShow);
      window.removeEventListener("pagehide", pageHide);
      window.removeEventListener("storage", storageChanged);
    };
  }, [activateVerified, blockImmediately, logoutExpired, navigate, restoreAuthorization]);

  useLayoutEffect(() => {
    pathRef.current = pathname;
    if (rootRef.current) {
      rootRef.current.hidden = isClinicPath(pathname) && restoring;
      rootRef.current.inert = isClinicPath(pathname) && (restoring || view.phase === "warning");
    }
  }, [pathname, restoring, view.phase]);

  useEffect(() => {
    if (isClinicPath(pathname)) activateVerified();
    else managerRef.current?.stop();
  }, [activateVerified, pathname]);

  const clinicPath = isClinicPath(pathname);
  return (
    <RoleInactivityContext.Provider value={register}>
      <DoctorSignOutContext.Provider value={requestDoctorSignOut}>
        <div ref={rootRef} hidden={clinicPath && restoring} inert={clinicPath && (restoring || view.phase === "warning") ? true : undefined}>
          {clinicPath && view.phase === "expired" ? (
            <main ref={logoutStatusRef} className="inactivity-state" role="status" tabIndex={-1}>
              <p>{manualLogout
                ? logoutFailed ? "Unable to finish signing out. Your workspace is blocked. Please retry." : "Signing you out..."
                : logoutFailed ? "Your session has expired. Please retry signing out." : "Your session has expired. Signing you out..."}</p>
              {logoutFailed ? <button type="button" onClick={logoutExpired}>Retry sign out</button> : null}
            </main>
          ) : children}
        </div>
        {clinicPath && restoring && view.phase !== "expired" ? (
          <main className="inactivity-state" role="status">
            <p>Checking account access...</p>
            <button type="button" onClick={restoreAuthorization}>Retry</button>
          </main>
        ) : null}
        {clinicPath && !restoring && view.phase === "warning" ? (
          <InactivityWarningDialog secondsRemaining={view.secondsRemaining} onStayLoggedIn={() => managerRef.current?.stayLoggedIn()} />
        ) : null}
      </DoctorSignOutContext.Provider>
    </RoleInactivityContext.Provider>
  );
}
