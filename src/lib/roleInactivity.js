export const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
export const INACTIVITY_WARNING_MS = 14 * 60 * 1000;
export const INACTIVITY_STORAGE_PREFIX = "maternal_clinic_activity:";
export const INACTIVITY_LOGIN_PATH = "/login?reason=inactivity";

export function isClinicRole(role) {
  return ["admin", "doctor", "staff"].includes(role);
}

export function isClinicPath(path) {
  return /^\/(?:admin|doctor|staff)(?:\/|$)/.test(path);
}

// Logical session identity stays in memory. Refreshing the JWT preserves session_id.
export function getLogicalSessionIdentity(session) {
  try {
    const payload = JSON.parse(atob(session.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return session.user?.id && payload.session_id
      ? session.user.id + ":" + payload.session_id
      : "";
  } catch {
    return "";
  }
}

export async function getInactivityScope(identity) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Injectable clock/storage make the production deadlines deterministically testable.
export function createRoleInactivityManager({
  now = Date.now,
  storage,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onChange = () => {},
  onExpire = () => {},
  onRemoteLogout = () => {},
} = {}) {
  let current = null;
  const remembered = new Map();
  let timer = null;
  let phase = "disabled";
  const key = () => INACTIVITY_STORAGE_PREFIX + current.scope;
  const read = () => {
    try {
      const saved = JSON.parse(storage?.getItem(key()) || "null");
      return saved && Number.isFinite(saved.lastActivity) && typeof saved.expired === "boolean" ? saved : null;
    } catch { return null; }
  };
  const write = () => {
    remembered.set(current.scope, { lastActivity: current.lastActivity, expired: current.expired });
    try { storage?.setItem(key(), JSON.stringify({ lastActivity: current.lastActivity, expired: current.expired })); }
    catch { /* The same-tab deadline remains enforced if storage is unavailable. */ }
  };
  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const publish = () => onChange({
    phase,
    secondsRemaining: current ? Math.max(0, Math.ceil((current.lastActivity + INACTIVITY_TIMEOUT_MS - now()) / 1000)) : 0,
  });
  const check = () => {
    cancelTimer();
    if (!current || phase === "expired") return;
    const saved = read();
    if (saved) {
      current.lastActivity = Math.max(current.lastActivity, saved.lastActivity);
      current.expired ||= saved.expired;
    }
    remembered.set(current.scope, { lastActivity: current.lastActivity, expired: current.expired });
    const elapsed = now() - current.lastActivity;
    if (current.expired || elapsed >= INACTIVITY_TIMEOUT_MS) {
      phase = "expired";
      current.expired = true;
      write();
      publish();
      onExpire();
      return;
    }
    phase = elapsed >= INACTIVITY_WARNING_MS ? "warning" : "active";
    publish();
    timer = setTimer(check, phase === "warning" ? Math.min(1000, INACTIVITY_TIMEOUT_MS - elapsed) : INACTIVITY_WARNING_MS - elapsed);
  };
  return {
    activate({ role, userId, scope, authorized }) {
      if (!authorized || !userId || !scope || !isClinicRole(role)) {
        this.stop();
        return false;
      }
      if (current?.scope !== scope) {
        cancelTimer();
        current = { scope, lastActivity: now(), expired: false };
        phase = "active";
        const saved = read() || remembered.get(scope);
        if (saved) Object.assign(current, saved);
        else write();
      }
      check();
      return true;
    },
    activity() {
      check();
      if (!current || phase !== "active") return false;
      current.lastActivity = now();
      write();
      check();
      return true;
    },
    stayLoggedIn() {
      check();
      if (!current || phase === "expired") return false;
      current.lastActivity = now();
      write();
      check();
      return true;
    },
    check,
    storageChanged(event) {
      if (!current || event.key !== key()) return;
      if (event.newValue === null) {
        remembered.delete(current.scope);
        cancelTimer();
        current = null;
        phase = "disabled";
        publish();
        onRemoteLogout();
      } else check();
    },
    stop({ clear = false } = {}) {
      cancelTimer();
      if (clear) remembered.clear();
      if (clear && current) {
        try { storage?.removeItem(key()); } catch { /* No blanket storage cleanup. */ }
      }
      current = null;
      phase = "disabled";
      publish();
    },
    snapshot() { return { phase, lastActivity: current?.lastActivity, scope: current?.scope }; },
  };
}

// Default/global logout first. If the server cannot be reached, remove only this
// expired session's SDK persistence, then use public signOut to notify the SDK
// and other tabs. Never call private SDK methods or clear unrelated storage.
export async function signOutExpiredClinicSession({ auth, storage, authStorageKey, identity, isCurrent, cleanup, warn = () => {} }) {
  if (!isCurrent()) return false;
  let result;
  try { result = await auth.signOut(); } catch { result = { error: true }; }
  if (result?.error) {
    warn();
    if (!isCurrent()) return false;
    try {
      const saved = JSON.parse(storage.getItem(authStorageKey) || "null");
      if (saved && getLogicalSessionIdentity(saved) !== identity) return false;
      storage.removeItem(authStorageKey);
      storage.removeItem(authStorageKey + "-code-verifier");
      storage.removeItem(authStorageKey + "-user");
      result = await auth.signOut({ scope: "local" });
    } catch { return false; }
    if (result?.error) return false;
  }
  const final = await auth.getSession().catch(() => ({ error: true }));
  if (final.error || final.data?.session) return false;
  cleanup();
  return true;
}
