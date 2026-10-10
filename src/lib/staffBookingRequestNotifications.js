import { getLogicalSessionIdentity } from "./roleInactivity";

export const staffBookingRequestTable = "create_patient_appointment_request";
const ledgers = new WeakMap();
export const emptyStaffBookingNotifications = {
  identity: "", count: null, error: "", realtime: "connecting", revision: 0, toast: null,
};

// This controller is owned by the authorized Staff shell, never individual pages.
// The bounded, memory-only ID ledger suppresses replay across shell remounts.
export function createStaffBookingRequestNotifications({
  client, userId, onChange, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout,
  setRepeater = setInterval, clearRepeater = clearInterval,
  windowTarget = typeof window === "undefined" ? null : window,
  documentTarget = typeof document === "undefined" ? null : document,
}) {
  let active = true, epoch = 0, authEvents = 0, channel, interval, timer, cycle;
  let snapshot = { ...emptyStaffBookingNotifications }, ledger, invalidation = 0;
  let queued = false;
  const publish = patch => {
    if (!active) return;
    snapshot = { ...snapshot, ...patch }; onChange(snapshot);
  };
  const removeChannel = () => {
    const previous = channel; channel = undefined;
    if (previous) { try { Promise.resolve(client.removeChannel(previous)).catch(() => {}); } catch { /* Already disconnected. */ } }
  };
  const clearWork = () => {
    epoch++; cycle?.abort.abort(); cycle = undefined; queued = false;
    clearTimer(timer); clearRepeater(interval);
    removeChannel();
  };
  function refresh(invalidate = false) {
    if (!active || !snapshot.identity) return Promise.resolve({ ok: false });
    if (invalidate) { invalidation++; if (cycle) queued = true; }
    if (cycle) return cycle.promise;
    const operation = { epoch, abort: new AbortController() };
    const current = () => active && operation.epoch === epoch;
    cycle = operation;
    operation.promise = Promise.resolve().then(async () => {
      let result = { ok: false };
      do {
        queued = false; const version = invalidation;
        try {
          let query = client.from(staffBookingRequestTable).select("id", { count: "exact", head: true }).eq("status", "pending");
          if (typeof query.abortSignal === "function") query = query.abortSignal(operation.abort.signal);
          const { count, error } = await query;
          if (!current()) return { ok: false };
          if (error) throw error;
          if (!Number.isSafeInteger(count) || count < 0) throw new Error("The outstanding request count is unavailable.");
          if (version === invalidation) {
            publish({ count, error: "", revision: snapshot.revision + 1 }); result = { ok: true, count };
          }
        } catch (error) {
          if (!current()) return { ok: false };
          if (version === invalidation) {
            const denied = ["42501", "PGRST301"].includes(error?.code) || [401,403].includes(Number(error?.status || error?.statusCode));
            publish({ error: "Unable to refresh booking requests. Please retry.", ...(denied ? { count: null, toast: null } : {}) });
          }
          result = { ok: false };
        }
      } while (current() && queued);
      return result;
    }).finally(() => { if (cycle === operation) cycle = undefined; });
    return operation.promise;
  }
  function schedule(invalidate = false) {
    if (invalidate) { invalidation++; if (cycle) queued = true; }
    clearTimer(timer);
    timer = setTimer(() => {
      void refresh();
    }, 0);
  }
  function receive(payload, startedEpoch) {
    if (!active || epoch !== startedEpoch || !snapshot.identity) return;
    schedule(true);
    const row = payload.new;
    if (payload.eventType !== "INSERT" || !row?.id || String(row.status || "").trim().toLowerCase() !== "pending") return;
    const id = String(row.id), created = Date.parse(row.created_at);
    if (ledger.seen.has(id)) return;
    ledger.seen.set(id, Number.isFinite(created) ? created : 0);
    while (ledger.seen.size > 2048) {
      const oldest = ledger.seen.keys().next().value;
      ledger.floor = Math.max(ledger.floor, ledger.seen.get(oldest)); ledger.seen.delete(oldest);
    }
    if (!Number.isFinite(created) || created < ledger.startedAt || created <= ledger.floor || snapshot.realtime !== "subscribed") return;
    publish({ toast: { id } });
  }
  function acceptSession(session) {
    if (!active) return;
    const identity = session?.user?.id === userId ? getLogicalSessionIdentity(session) : "";
    if (identity === snapshot.identity) {
      if (!identity) { ledgers.delete(client); publish({ error: "Unable to verify the Staff session. Please retry.", realtime: "unavailable" }); }
      return;
    }
    clearWork();
    if (!identity) {
      ledgers.delete(client); publish({ ...emptyStaffBookingNotifications, realtime: "unavailable" }); return;
    }
    const previous = ledgers.get(client);
    ledger = previous?.identity === identity ? previous : { identity, startedAt: now(), floor: -Infinity, seen: new Map() };
    ledgers.set(client, ledger);
    publish({ ...emptyStaffBookingNotifications, identity });
    const startedEpoch = epoch;
    try {
      channel = client.channel("staff-booking-request-notifications")
        .on("postgres_changes", { event: "*", schema: "public", table: staffBookingRequestTable }, payload => receive(payload, startedEpoch))
        .subscribe(status => {
          if (!active || epoch !== startedEpoch) return;
          publish({ realtime: status === "SUBSCRIBED" ? "subscribed" : "unavailable" });
          schedule(true);
        });
    } catch {
      publish({ realtime: "unavailable" });
    }
    schedule();
    interval = setRepeater(() => { if (!documentTarget || documentTarget.visibilityState === "visible") schedule(); }, 15000);
  }
  const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => { authEvents++; acceptSession(session); });
  const initialEvents = authEvents;
  Promise.resolve().then(() => active ? client.auth.getSession() : null).then(result => {
    if (active && authEvents === initialEvents) {
      if (result.error || !result.data?.session) publish({ error: "Unable to verify the Staff session. Please retry.", realtime: "unavailable" });
      else acceptSession(result.data.session);
    }
  }).catch(() => { if (active && authEvents === initialEvents) publish({ error: "Unable to verify the Staff session. Please retry.", realtime: "unavailable" }); });
  const focus = () => { if (!documentTarget || documentTarget.visibilityState === "visible") schedule(); };
  windowTarget?.addEventListener("focus", focus); documentTarget?.addEventListener("visibilitychange", focus);
  return {
    refresh: () => refresh(true),
    async retry() {
      if (snapshot.identity) return refresh(true);
      const events = authEvents;
      try {
        const result = await client.auth.getSession();
        if (active && events === authEvents && !result.error) acceptSession(result.data?.session);
      } catch { /* Existing retryable error stays visible. */ }
      return refresh(true);
    },
    dismissToast() { publish({ toast: null }); },
    dispose() {
      active = false; clearWork(); subscription.unsubscribe();
      windowTarget?.removeEventListener("focus", focus); documentTarget?.removeEventListener("visibilitychange", focus);
    },
  };
}
