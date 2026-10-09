import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { createAuthenticatedMutation } from "../lib/authenticatedMutation";
import { getLogicalSessionIdentity } from "../lib/roleInactivity";
import { getDoctorRouteAuthorization } from "../lib/doctorRouteAuthorization.js";
import { fetchDoctorProfileAppointments, summarizeDoctorProfileAppointments } from "../lib/doctorProfileSummary.js";

export function useDoctorProfileSummary(doctorIdentity, period) {
  const authUser = doctorIdentity?.authUser;
  const doctorId = authUser?.id || "";
  const authorized = !doctorIdentity?.loading && !doctorIdentity?.error && getDoctorRouteAuthorization({
    user: authUser, profile: doctorIdentity?.profile,
  }).authorized;
  const [state, setState] = useState({ status: "loading", summary: null, error: "" });
  const [retryRevision, setRetryRevision] = useState(0);
  const [sessionRevision, setSessionRevision] = useState(0);
  const lastSuccessRef = useRef(null);

  useEffect(() => {
    let active = true, version = 0, ownerIdentity = "", pending = null;
    const key = { doctorId, period, sessionRevision };
    const current = request => active && version === request;
    const cancelPending = () => { pending?.controller.abort(); pending?.scope?.dispose(); pending = null; };
    if (!authorized) {
      lastSuccessRef.current = null;
      return undefined;
    }
    const invalidateSession = () => {
      if (!active) return;
      active = false; version += 1; cancelPending(); lastSuccessRef.current = null;
      setState({ ...key, status: "unavailable", summary: null, error: "Your session changed. Reopen Profile to refresh the appointment summary." });
    };
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      const nextIdentity = getLogicalSessionIdentity(session);
      if (event === "SIGNED_OUT" || session?.user?.id !== doctorId ||
          (ownerIdentity && nextIdentity !== ownerIdentity)) {
        invalidateSession();
        // A new session for the same Doctor needs a fresh load, even when the
        // parent still supplies the same user ID. Never carry its old counts.
        if (event !== "SIGNED_OUT" && session?.user?.id === doctorId && nextIdentity) {
          setSessionRevision(value => value + 1);
        }
      }
    });
    const previousSummary = () => {
      const previous = lastSuccessRef.current;
      return ownerIdentity && previous?.doctorId === doctorId && previous.period === period && previous.identity === ownerIdentity
        ? previous.summary : null;
    };
    const refresh = async ({ coalesce = false } = {}) => {
      if (!active || (coalesce && pending)) return;
      const request = ++version;
      cancelPending();
      const operation = { controller: new AbortController(), scope: null };
      pending = operation;
      // Only this effect's verified Doctor/session/period may retain counts.
      // Initial loads and changed periods/identities still start without data.
      const retained = previousSummary();
      setState(previous => ({ ...key, status: retained ? "refreshing" : "loading", summary: retained,
        error: retained ? previous.error : "" }));
      try {
        const scope = await createAuthenticatedMutation(supabase, {
          expectedUserId: doctorId, expectedIdentity: ownerIdentity,
          signal: operation.controller.signal, isCurrent: () => current(request),
        });
        operation.scope = scope;
        if (!current(request)) return;
        ownerIdentity = scope.identity;
        const rows = await fetchDoctorProfileAppointments(scope.client, doctorId, () => current(request));
        await scope.check();
        if (!current(request) || !rows) return;
        const nextSummary = summarizeDoctorProfileAppointments(rows, period, new Date());
        const previous = previousSummary();
        const summary = previous && Object.keys(nextSummary).every(field => nextSummary[field] === previous[field])
          ? previous : nextSummary;
        lastSuccessRef.current = { doctorId, period, identity: ownerIdentity, summary };
        setState({ ...key, status: "ready", summary, error: "" });
      } catch (error) {
        if (!current(request)) return;
        if (error?.code === "mutation_cancelled") {
          invalidateSession(); return;
        }
        // A failed HTTP request can mask a session-fence error. Confirm the
        // captured session again before exposing even explicitly stale counts.
        let verified = false;
        if (operation.scope) {
          try { await operation.scope.check(); verified = true; }
          catch (sessionError) {
            if (current(request) && sessionError?.code === "mutation_cancelled") invalidateSession();
          }
        }
        if (!current(request)) return;
        const previous = lastSuccessRef.current;
        const summary = verified && previous?.doctorId === doctorId && previous.period === period && previous.identity === ownerIdentity
          ? previous.summary : null;
        setState({ ...key, status: "error", summary,
          error: summary ? "Appointment summary could not be refreshed. Showing the last successful counts; they may be out of date."
            : "Appointment summary is unavailable. Please retry." });
      } finally {
        operation.scope?.dispose();
        if (pending === operation) pending = null;
      }
    };
    void refresh();
    const channel = supabase.channel(`doctor-profile-summary-${doctorId}-${period}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "schedule", filter: `doctor_id=eq.${doctorId}` }, () => { void refresh(); })
      .subscribe();
    const focus = () => { void refresh({ coalesce: true }); };
    const visibility = () => { if (document.visibilityState === "visible") focus(); };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      active = false; version += 1; cancelPending(); subscription.unsubscribe();
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
      void Promise.resolve(supabase.removeChannel(channel)).catch(() => {});
    };
  }, [doctorId, authorized, period, retryRevision, sessionRevision]);

  // Auth recovery/token refresh can replace the user object in the same logical
  // session. The Auth subscription and captured-session checks fence actual
  // session changes; object reference churn must not clear verified counts.
  // Hide old Doctor/period/session results before effect cleanup as well.
  const visible = authorized && state.doctorId === doctorId && state.period === period && state.sessionRevision === sessionRevision
    ? state : { status: authorized ? "loading" : "unavailable", summary: null, error: "" };
  return { ...visible, retry: () => setRetryRevision(value => value + 1) };
}
