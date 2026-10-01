import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { supabase } from "./supabaseClient";
import {
  getCurrentPatientAccountStatus,
  isMissingPatientAuthSession,
} from "./patientAuthLinking";
import { patientAccountStatuses } from "./patientAccountStatus";
import { getSafePatientNativeNotificationTarget } from "./patientNotificationRoutes";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pendingLifetimeMs = 5 * 60_000;
const authBootstrapTimeoutMs = 5_000;
const maxSeenNotifications = 100;
const subscribers = new Set();
const seenNotifications = new Set();

// The pending event contains only these three safe fields. Bindings are private
// and ephemeral; neither payloads nor credentials are retained here.
let pendingTap = null;
let pendingUserId = "";
let verifiedBinding = null;
let consuming = false;
let navigationRequested = false;
let revision = 0;
let authReady = false;
let authUserId = "";
let authSessionId = "";
let authGeneration = 0;
let tapGeneration = 0;
let navigationBlocked = false;
let verificationInFlight = null;
let expiryTimer;
let retryTimer;
let startPromise = null;
let finishAuthBootstrap;
let authBootstrapTimer;
let bootstrapGeneration = 0;
let pushListener;
let authSubscription;

function supported() {
  return Capacitor.isNativePlatform() &&
    Capacitor.getPlatform() === "android" &&
    Capacitor.isPluginAvailable("PushNotifications");
}

function emitChange() {
  revision += 1;
  subscribers.forEach((callback) => callback());
}

export function subscribePatientNativePushNavigation(callback) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

export function getPatientNativePushNavigationSnapshot() {
  return revision;
}

export function hasPendingPatientNativePushNavigation() {
  return pendingTap !== null;
}

export function clearPatientNativePushNavigation() {
  tapGeneration += 1;
  pendingTap = null;
  pendingUserId = "";
  verifiedBinding = null;
  consuming = false;
  navigationRequested = false;
  verificationInFlight = null;
  window.clearTimeout(expiryTimer);
  window.clearTimeout(retryTimer);
  expiryTimer = null;
  retryTimer = null;
  emitChange();
}

export function cancelPatientNativePushNavigationBeforeLogout() {
  navigationBlocked = true;
  authGeneration += 1;
  clearPatientNativePushNavigation();
}

// Read only the opaque session identifier, never retain the access token.
// A refresh preserves this identifier; a new login must invalidate old work.
function sessionIdentity(session) {
  try {
    const encoded = session.access_token.split(".")[1];
    const payload = JSON.parse(globalThis.atob(
      encoded.replace(/-/g, "+").replace(/_/g, "/")
    ));
    if (typeof payload.session_id !== "string" || !uuidPattern.test(payload.session_id) || !session.user?.id) return null;
    return { userId: session.user.id, sessionId: payload.session_id };
  } catch {
    return null;
  }
}

function settleAuthBootstrap() {
  window.clearTimeout(authBootstrapTimer);
  authBootstrapTimer = null;
  finishAuthBootstrap?.();
  finishAuthBootstrap = null;
}

function handleAuthChange(event, session) {
  // Supabase may emit SIGNED_IN or TOKEN_REFRESHED for a saved session before
  // INITIAL_SESSION. Neither event establishes the initial restoration boundary.
  // A bootstrap timeout mounts the UI but leaves this boundary unresolved.
  if (!authReady && event !== "INITIAL_SESSION" &&
    event !== "SIGNED_OUT" && event !== "PASSWORD_RECOVERY") return;

  const identity = sessionIdentity(session);
  const userId = identity?.userId || "";
  const sessionId = identity?.sessionId || "";
  const initialRestore = !authReady && event === "INITIAL_SESSION";
  const changed = userId !== authUserId || sessionId !== authSessionId;

  if (!authReady || changed || event === "SIGNED_OUT" || event === "PASSWORD_RECOVERY") {
    authGeneration += 1;
    authReady = true;
    authUserId = userId;
    authSessionId = sessionId;
    seenNotifications.clear();
    navigationBlocked = !identity || event === "SIGNED_OUT" || event === "PASSWORD_RECOVERY";

    if (initialRestore && identity && pendingTap && !navigationBlocked) {
      pendingUserId = userId;
      seenNotifications.add(pendingTap.notificationId);
      emitChange();
    } else {
      clearPatientNativePushNavigation();
    }
    settleAuthBootstrap();
    return;
  }

  // Auth callbacks stay synchronous. Database work runs in Router effects.
  if (pendingTap) emitChange();
}

function captureTap(action) {
  if (action?.actionId !== "tap" || navigationBlocked) return;
  const data = action.notification?.data;
  const notificationId = data?.notification_id;
  if (typeof notificationId !== "string" || !uuidPattern.test(notificationId)) return;
  if (authReady && !authUserId) return;

  const normalizedId = notificationId.toLowerCase();
  if (seenNotifications.has(normalizedId) || pendingTap?.notificationId === normalizedId) return;
  seenNotifications.add(normalizedId);
  if (seenNotifications.size > maxSeenNotifications) {
    seenNotifications.delete(seenNotifications.values().next().value);
  }

  clearPatientNativePushNavigation();
  pendingTap = Object.freeze({
    notificationId: normalizedId,
    sanitizedRoute: getSafePatientNativeNotificationTarget(data.notification_type, data.route),
    receivedAt: Date.now(),
  });
  pendingUserId = authReady ? authUserId : "";
  expiryTimer = window.setTimeout(clearPatientNativePushNavigation, pendingLifetimeMs);
  emitChange();
}

function isCurrent(operation) {
  if (
    pendingTap !== operation.tap ||
    tapGeneration !== operation.tapGeneration ||
    authGeneration !== operation.authGeneration ||
    authUserId !== operation.userId ||
    authSessionId !== operation.sessionId ||
    pendingUserId !== operation.userId ||
    navigationBlocked
  ) return false;

  if (Date.now() - operation.tap.receivedAt >= pendingLifetimeMs) {
    clearPatientNativePushNavigation();
    return false;
  }
  return true;
}

function matchingSession(operation, result) {
  const identity = sessionIdentity(result.data?.session);
  return !result.error && identity?.userId === operation.userId &&
    identity?.sessionId === operation.sessionId;
}

async function verify(operation) {
  try {
    const session = await supabase.auth.getSession();
    if (!isCurrent(operation)) return;
    if (!matchingSession(operation, session)) {
      clearPatientNativePushNavigation();
      return;
    }

    const { data, error } = await supabase.auth.getUser();
    if (!isCurrent(operation)) return;
    if (error) throw error;
    if (data.user?.id !== operation.userId) {
      clearPatientNativePushNavigation();
      return;
    }

    const profile = await supabase.from("profiles")
      .select("role").eq("id", operation.userId).maybeSingle();
    if (!isCurrent(operation)) return;
    if (profile.error) throw profile.error;
    if (typeof profile.data?.role !== "string" || profile.data.role.trim().toLowerCase() !== "patient") {
      clearPatientNativePushNavigation();
      return;
    }

    const account = await getCurrentPatientAccountStatus();
    if (!isCurrent(operation)) return;
    if (!account.patient?.id || account.status !== patientAccountStatuses.active) {
      clearPatientNativePushNavigation();
      return;
    }

    // The record ID is obtained from authenticated database state, not push data.
    // RLS additionally enforces ownership, active status and record lifecycle.
    const notification = await supabase.from("patient_notifications")
      .select("id")
      .eq("id", operation.tap.notificationId)
      .eq("patient_id", account.patient.id)
      .maybeSingle();
    if (!isCurrent(operation)) return;
    if (notification.error) throw notification.error;
    if (notification.data?.id !== operation.tap.notificationId) {
      clearPatientNativePushNavigation();
      return;
    }

    const finalSession = await supabase.auth.getSession();
    if (!isCurrent(operation)) return;
    if (!matchingSession(operation, finalSession)) {
      clearPatientNativePushNavigation();
      return;
    }
    verifiedBinding = { ...operation, patientId: account.patient.id };
    emitChange();
  } catch (error) {
    if (!isCurrent(operation)) return;
    if (isMissingPatientAuthSession(error) || error?.status === 401 || error?.status === 403) {
      clearPatientNativePushNavigation();
    } else {
      // Temporary failures retain only safe metadata until expiry or cancellation.
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        emitChange();
      }, 10_000);
    }
  }
}

export function verifyPendingPatientNativePushNavigation() {
  if (!pendingTap || !authReady || !authUserId || navigationBlocked || consuming || retryTimer) return Promise.resolve();
  if (verifiedBinding && isCurrent(verifiedBinding)) return Promise.resolve();
  if (verificationInFlight) return verificationInFlight;

  const operation = {
    tap: pendingTap,
    tapGeneration,
    authGeneration,
    userId: authUserId,
    sessionId: authSessionId,
  };
  const promise = verify(operation).finally(() => {
    if (verificationInFlight === promise) verificationInFlight = null;
  });
  verificationInFlight = promise;
  return promise;
}

export function canOpenPatientNativePushWorkspace() {
  return verifiedBinding !== null && isCurrent(verifiedBinding);
}

export function acknowledgePatientNativePushNavigation({ userId, patientId, pathname, search, hash }) {
  const binding = verifiedBinding;
  if (
    navigationRequested && binding && isCurrent(binding) &&
    binding.userId === userId && binding.patientId === patientId &&
    pathname === binding.tap.sanitizedRoute && !search && !hash
  ) {
    clearPatientNativePushNavigation();
  }
}

export async function consumePatientNativePushNavigation({ userId, patientId, pathname, search, hash, navigate, isMounted }) {
  const binding = verifiedBinding;
  if (!binding || consuming || !isCurrent(binding) || binding.userId !== userId || binding.patientId !== patientId) return;
  consuming = true;
  try {
    // Recheck immediately before navigation, including after lazy shell loading.
    verifiedBinding = null;
    await verify(binding);
    if (!isMounted() || !isCurrent(binding) || !verifiedBinding) return;
    if (verifiedBinding.patientId !== patientId) {
      clearPatientNativePushNavigation();
      return;
    }
    const target = binding.tap.sanitizedRoute;
    if (pathname !== target || search || hash) {
      // BrowserRouter may commit its location in a transition. Keep the tap
      // reserved until the shell observes that location, so /patient's default
      // redirect cannot win between navigate() and the Router commit.
      navigationRequested = true;
      navigate(target, { replace: true });
    } else {
      clearPatientNativePushNavigation();
    }
  } catch {
    if (isCurrent(binding)) clearPatientNativePushNavigation();
  } finally {
    if (isCurrent(binding) && !navigationRequested) {
      consuming = false;
      emitChange();
    }
  }
}

function retryPending() {
  if (pendingTap && document.visibilityState !== "hidden") {
    window.clearTimeout(retryTimer);
    retryTimer = null;
    emitChange();
  }
}

export function startPatientNativePushNavigation() {
  if (!supported()) return Promise.resolve();
  if (startPromise) return startPromise;
  const generation = ++bootstrapGeneration;
  window.addEventListener("online", retryPending);
  document.addEventListener("visibilitychange", retryPending);
  startPromise = PushNotifications.addListener("pushNotificationActionPerformed", captureTap)
    .then((handle) => {
      if (generation !== bootstrapGeneration) {
        void handle.remove().catch(() => undefined);
      } else {
        pushListener = handle;
        // Install the native listener before observing auth, so a retained
        // launch tap is staged even when INITIAL_SESSION reports no session.
        return new Promise((resolve) => {
          finishAuthBootstrap = resolve;
          authBootstrapTimer = window.setTimeout(() => {
            if (generation !== bootstrapGeneration || authReady) return;
            // Release the app without trusting restoration or carrying a tap
            // into a later login. Keep observing auth for a legitimate boundary.
            navigationBlocked = true;
            authGeneration += 1;
            clearPatientNativePushNavigation();
            settleAuthBootstrap();
          }, authBootstrapTimeoutMs);
          authSubscription = supabase.auth.onAuthStateChange((event, session) => {
            if (generation === bootstrapGeneration) handleAuthChange(event, session);
          }).data.subscription;
        });
      }
    }).catch(() => {
      if (generation === bootstrapGeneration) stopPatientNativePushNavigation();
    });
  return startPromise;
}

function stopPatientNativePushNavigation() {
  bootstrapGeneration += 1;
  authGeneration += 1;
  navigationBlocked = true;
  authSubscription?.unsubscribe();
  authSubscription = null;
  void pushListener?.remove().catch(() => undefined);
  pushListener = null;
  window.removeEventListener("online", retryPending);
  document.removeEventListener("visibilitychange", retryPending);
  clearPatientNativePushNavigation();
  seenNotifications.clear();
  authReady = false;
  authUserId = "";
  authSessionId = "";
  settleAuthBootstrap();
  startPromise = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(stopPatientNativePushNavigation);
}
