import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { supabase } from "./supabaseClient";

export const patientNativePushStatusChangedEvent =
  "maternal:native-push-status-changed";

const installationIdStorageKey = "maternal_native_push_installation_id";
const explicitlyDisabledStorageKey =
  "maternal_native_push_explicitly_disabled";
const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const registrationTimeoutMs = 20_000;
const settingsOperationTimeoutMs = 15_000;
const logoutOperationTimeoutMs = 2_500;

let registrationInFlight = null;
let registrationBarrier = Promise.resolve();
let lifecycleGeneration = 0;
let registrationBlocked = false;
let authSubscription = null;
let observedAuthIdentity = null;
let authObserved = false;
let authGeneration = 0;

function createNativePushError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function createRandomUuid() {
  const cryptoApi = globalThis.crypto;

  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  if (typeof cryptoApi?.getRandomValues !== "function") {
    throw createNativePushError("installation_id_unavailable");
  }

  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));

  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

function normalizePermission(receive) {
  if (receive === "granted") return "granted";
  if (receive === "denied") return "denied";
  return "default";
}

function isExplicitlyDisabled() {
  return window.localStorage.getItem(explicitlyDisabledStorageKey) === "true";
}

export function isPatientNativePushExplicitlyDisabled() {
  return isExplicitlyDisabled();
}

function setExplicitlyDisabled(disabled) {
  if (disabled) {
    window.localStorage.setItem(explicitlyDisabledStorageKey, "true");
    return;
  }

  window.localStorage.removeItem(explicitlyDisabledStorageKey);
}

function dispatchStatusChanged(enabled) {
  window.dispatchEvent(
    new CustomEvent(patientNativePushStatusChangedEvent, {
      detail: { enabled: enabled === true },
    })
  );
}

async function removeListener(handle) {
  if (!handle) return;
  await handle.remove().catch(() => undefined);
}

function withTimeout(promise, timeoutMs, timeoutCode) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(
      () => reject(createNativePushError(timeoutCode)),
      timeoutMs
    );
  });

  return Promise.race([promise, timeout]).finally(() => {
    window.clearTimeout(timeoutId);
  });
}

function isCurrentRegistration(operation) {
  return (
    !operation.cancelled &&
    !registrationBlocked &&
    operation.generation === lifecycleGeneration &&
    registrationInFlight === operation
  );
}

function cancelRegistration(operation, code = "registration_cancelled") {
  if (!operation || operation.cancelled) return;

  operation.cancelled = true;
  operation.cancelCode = code;
  operation.abortController?.abort();
  operation.cancelWaiting?.();
}

// The logical session identifier survives token refresh, but changes on a new login.
// These identities stay in memory and are never logged or stored.
function getSessionIdentity(session) {
  try {
    const encoded = session.access_token.split(".")[1];
    const payload = JSON.parse(globalThis.atob(
      encoded.replace(/-/g, "+").replace(/_/g, "/")
    ));
    if (!session.user?.id || typeof payload.session_id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.session_id)) {
      return null;
    }
    return { userId: session.user.id, sessionId: payload.session_id };
  } catch {
    return null;
  }
}

function sameIdentity(first, second) {
  return Boolean(first && second && first.userId === second.userId &&
    first.sessionId === second.sessionId);
}

function observeRegistrationAuth() {
  if (authSubscription) return;
  authSubscription = supabase.auth.onAuthStateChange((event, session) => {
    // Keep the callback synchronous: Supabase auth callbacks must not await SDK calls.
    const identity = getSessionIdentity(session);
    const expected = registrationInFlight?.identity || observedAuthIdentity;
    const boundary = event === "SIGNED_OUT" || event === "PASSWORD_RECOVERY" ||
      !identity || (expected && !sameIdentity(expected, identity)) ||
      (!expected && registrationInFlight && event !== "INITIAL_SESSION");
    observedAuthIdentity = identity;
    authObserved = true;
    if (boundary) {
      authGeneration += 1;
      lifecycleGeneration += 1;
      if (!identity || event === "SIGNED_OUT" || event === "PASSWORD_RECOVERY") {
        registrationBlocked = true;
      }
      cancelRegistration(registrationInFlight, "auth_changed");
    }
  }).data.subscription;
}

function assertCurrentRegistration(operation) {
  if (!isCurrentRegistration(operation)) {
    throw createNativePushError(operation.cancelCode || "registration_cancelled");
  }
}

async function awaitRegistrationWork(operation, work) {
  assertCurrentRegistration(operation);
  const signal = operation.abortController.signal;
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(createNativePushError(operation.cancelCode || "registration_cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function assertMatchingSession(operation, session) {
  const identity = getSessionIdentity(session);
  if (!sameIdentity(operation.identity, identity) ||
      (authObserved && !sameIdentity(observedAuthIdentity, identity))) {
    cancelRegistration(operation, "auth_changed");
  }
  assertCurrentRegistration(operation);
}

async function authorizeRegistration(operation, sessionResult) {
  assertCurrentRegistration(operation);
  const current = sessionResult || await awaitRegistrationWork(operation, supabase.auth.getSession());
  assertCurrentRegistration(operation);
  const session = current.data?.session;
  if (current.error || !getSessionIdentity(session)) {
    cancelRegistration(operation, "auth_changed");
    assertCurrentRegistration(operation);
  }
  operation.identity ||= getSessionIdentity(session);
  if (!authObserved) {
    observedAuthIdentity = operation.identity;
    authObserved = true;
  }
  assertMatchingSession(operation, session);

  const user = await awaitRegistrationWork(operation, supabase.auth.getUser(session.access_token));
  assertCurrentRegistration(operation);
  if (user.error || user.data?.user?.id !== operation.identity.userId) {
    throw createNativePushError("inactive_patient");
  }

  const authorization = "Bearer " + session.access_token;
  const profile = await awaitRegistrationWork(operation, supabase.from("profiles")
    .select("role, account_status").eq("id", operation.identity.userId)
    .maybeSingle().setHeader("Authorization", authorization)
    .abortSignal(operation.abortController.signal));
  assertCurrentRegistration(operation);
  if (profile.error || profile.data?.role?.trim().toLowerCase() !== "patient" ||
      profile.data?.account_status?.trim().toLowerCase() !== "active") {
    throw createNativePushError("inactive_patient");
  }

  const account = await awaitRegistrationWork(operation, supabase.rpc("get_current_patient_account_status")
    .setHeader("Authorization", authorization).abortSignal(operation.abortController.signal));
  assertCurrentRegistration(operation);
  const patient = Array.isArray(account.data) ? account.data[0] : account.data;
  if (account.error || !patient?.id || patient.account_status !== "active" ||
      (operation.patientId && operation.patientId !== patient.id)) {
    throw createNativePushError("inactive_patient");
  }
  operation.patientId = patient.id;

  const finalSession = await awaitRegistrationWork(operation, supabase.auth.getSession());
  assertCurrentRegistration(operation);
  if (finalSession.error) throw createNativePushError("inactive_patient");
  assertMatchingSession(operation, finalSession.data?.session);
  return finalSession.data.session;
}

async function waitForRegistrationToken(operation) {
  let registrationHandle;
  let registrationErrorHandle;
  let timeoutId;
  let settled = false;

  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      operation.cancelWaiting = null;
      window.clearTimeout(timeoutId);

      void Promise.all([
        removeListener(registrationHandle),
        removeListener(registrationErrorHandle),
      ]).finally(() => callback(value));
    };

    operation.cancelWaiting = () => {
      finish(
        reject,
        createNativePushError(operation.cancelCode || "registration_cancelled")
      );
    };

    const start = async () => {
      registrationHandle = await PushNotifications.addListener(
        "registration",
        (token) => {
          finish(resolve, token?.value);
        }
      );
      if (settled) {
        await removeListener(registrationHandle);
        return;
      }

      registrationErrorHandle = await PushNotifications.addListener(
        "registrationError",
        () => {
          finish(reject, createNativePushError("registration_failed"));
        }
      );
      if (settled) {
        await Promise.all([
          removeListener(registrationHandle),
          removeListener(registrationErrorHandle),
        ]);
        return;
      }

      timeoutId = window.setTimeout(() => {
        cancelRegistration(operation, "registration_timeout");
      }, registrationTimeoutMs);

      if (operation.cancelled) {
        operation.cancelWaiting?.();
        return;
      }

      await PushNotifications.register();
    };

    void start().catch(() => {
      finish(reject, createNativePushError("registration_failed"));
    });
  });
}

async function persistRegistrationToken(
  pushToken,
  installationId,
  abortSignal,
  session
) {
  const normalizedToken = String(pushToken || "").trim();

  if (normalizedToken.length < 32) {
    throw createNativePushError("registration_failed");
  }

  const { data, error } = await supabase
    .rpc("upsert_my_patient_native_push_device", {
      p_installation_id: installationId,
      p_push_token: normalizedToken,
      p_platform: "android",
    })
    .setHeader("Authorization", "Bearer " + session.access_token)
    .abortSignal(abortSignal);

  if (error) {
    throw createNativePushError("persistence_failed");
  }

  return data;
}

async function compensateForPossibleUpsert(operation) {
  if (operation.authGeneration !== authGeneration) return;
  try {
    const generation = authGeneration;
    const current = await supabase.auth.getSession();
    if (current.error || generation !== authGeneration ||
        !sameIdentity(operation.identity, getSessionIdentity(current.data?.session))) return;
    await withTimeout(
      deactivateCurrentInstallation({ notify: false, session: current.data.session,
        installationId: operation.installationId }),
      logoutOperationTimeoutMs,
      "deactivation_timeout"
    );
  } catch {
    // The caller still performs its own final deactivation when stopping a lifecycle.
  }
}

async function performRegistration(operation) {
  if (!isNativeAndroidPushAvailable()) {
    throw createNativePushError("unsupported");
  }

  const installationId = getOrCreatePatientNativePushInstallationId();
  operation.installationId = installationId;
  let persistenceStarted = false;

  try {
    await authorizeRegistration(operation, await awaitRegistrationWork(operation, operation.initialSession));
    const pushToken = await waitForRegistrationToken(operation);
    if (!isCurrentRegistration(operation)) {
      throw createNativePushError(
        operation.cancelCode || "registration_cancelled"
      );
    }

    const session = await authorizeRegistration(operation);
    assertCurrentRegistration(operation);
    persistenceStarted = true;
    const registration = await awaitRegistrationWork(operation, persistRegistrationToken(
      pushToken,
      installationId,
      operation.abortController.signal,
      session
    ));

    if (!isCurrentRegistration(operation)) {
      throw createNativePushError(
        operation.cancelCode || "registration_cancelled"
      );
    }

    setExplicitlyDisabled(false);
    dispatchStatusChanged(true);
    return { installationId, registration };
  } catch (error) {
    if (persistenceStarted) {
      await compensateForPossibleUpsert(operation);
    }

    if (operation.cancelled) {
      throw createNativePushError(
        operation.cancelCode || "registration_cancelled"
      );
    }

    throw error?.code
      ? error
      : createNativePushError("persistence_failed");
  } finally {
    operation.abortController = null;
    operation.initialSession = null;
    operation.cancelWaiting = null;
  }
}

async function deactivateCurrentInstallation({ notify = true, session,
  installationId = getOrCreatePatientNativePushInstallationId() } = {}) {
  const request = supabase.rpc(
    "deactivate_my_patient_native_push_device",
    { p_installation_id: installationId }
  );
  if (session) request.setHeader("Authorization", "Bearer " + session.access_token);
  const { data, error } = await request;

  if (error) {
    throw createNativePushError("deactivation_failed");
  }

  if (notify) dispatchStatusChanged(false);
  return data;
}

function captureCleanupSession() {
  return {
    identity: registrationInFlight?.identity || observedAuthIdentity,
    generation: authGeneration,
    session: supabase.auth.getSession().catch(() => ({ error: true })),
  };
}

async function getCleanupSession(binding) {
  const result = await binding.session;
  const session = result.data?.session;
  const identity = getSessionIdentity(session);
  if (result.error || !identity || binding.generation !== authGeneration ||
      (binding.identity && !sameIdentity(binding.identity, identity))) {
    throw createNativePushError("auth_changed");
  }
  return session;
}

function runBoundCleanup(binding, action, timeoutMs, timeoutCode) {
  let active = true;
  const work = getCleanupSession(binding).then((session) => {
    if (!active || binding.generation !== authGeneration) {
      throw createNativePushError("auth_changed");
    }
    return action(session);
  });
  return withTimeout(work, timeoutMs, timeoutCode).finally(() => { active = false; });
}

async function unregisterNativePush() {
  try {
    await PushNotifications.unregister();
    return true;
  } catch {
    throw createNativePushError("unregister_failed");
  }
}

export function isNativeAndroidPushAvailable() {
  return (
    Capacitor.isNativePlatform() &&
    Capacitor.getPlatform() === "android" &&
    Capacitor.isPluginAvailable("PushNotifications")
  );
}

export function getOrCreatePatientNativePushInstallationId() {
  if (!isNativeAndroidPushAvailable()) {
    throw createNativePushError("unsupported");
  }

  const storedInstallationId = String(
    window.localStorage.getItem(installationIdStorageKey) || ""
  ).trim();

  if (uuidV4Pattern.test(storedInstallationId)) {
    return storedInstallationId.toLowerCase();
  }

  const installationId = createRandomUuid().toLowerCase();

  try {
    window.localStorage.setItem(installationIdStorageKey, installationId);
  } catch {
    throw createNativePushError("installation_id_unavailable");
  }

  return installationId;
}

export async function checkPatientNativePushPermission() {
  if (!isNativeAndroidPushAvailable()) {
    return "unsupported";
  }

  try {
    const permission = await PushNotifications.checkPermissions();
    return normalizePermission(permission.receive);
  } catch {
    throw createNativePushError("permission_check_failed");
  }
}

export async function requestPatientNativePushPermission() {
  if (!isNativeAndroidPushAvailable()) {
    return "unsupported";
  }

  try {
    const permission = await PushNotifications.requestPermissions();
    return normalizePermission(permission.receive);
  } catch {
    throw createNativePushError("permission_request_failed");
  }
}

export function beginPatientNativePushSession() {
  if (isNativeAndroidPushAvailable()) observeRegistrationAuth();
  lifecycleGeneration += 1;
  registrationBlocked = false;

  if (registrationInFlight) {
    cancelRegistration(registrationInFlight, "session_replaced");
  }
}

export function endPatientNativePushSession() {
  registrationBlocked = true;
  lifecycleGeneration += 1;
  authGeneration += 1;
  cancelRegistration(registrationInFlight, "session_ended");
  authSubscription?.unsubscribe();
  authSubscription = null;
  observedAuthIdentity = null;
  authObserved = false;
}

export function registerPatientNativePushDevice({
  allowExplicitlyDisabled = false,
} = {}) {
  if (registrationBlocked) {
    return Promise.reject(createNativePushError("registration_cancelled"));
  }

  if (isExplicitlyDisabled() && !allowExplicitlyDisabled) {
    return Promise.reject(createNativePushError("registration_disabled"));
  }

  if (
    registrationInFlight &&
    registrationInFlight.generation === lifecycleGeneration
  ) {
    return registrationInFlight.promise;
  }

  observeRegistrationAuth();
  const operation = {
    abortController: new AbortController(),
    identity: null,
    patientId: null,
    authGeneration,
    initialSession: supabase.auth.getSession().catch(() => ({ error: true })),
    cancelled: false,
    cancelCode: "",
    cancelWaiting: null,
    completion: null,
    generation: lifecycleGeneration,
    promise: null,
  };
  const previousCompletion = registrationBarrier;
  operation.promise = previousCompletion.then(() => {
    if (!isCurrentRegistration(operation)) {
      throw createNativePushError(
        operation.cancelCode || "registration_cancelled"
      );
    }

    return performRegistration(operation);
  });
  operation.completion = operation.promise.then(
    () => undefined,
    () => undefined
  );
  registrationInFlight = operation;
  registrationBarrier = operation.completion;

  const clearInFlight = () => {
    if (registrationInFlight === operation) {
      registrationInFlight = null;
    }
  };
  operation.completion.then(clearInFlight);

  return operation.promise;
}

export async function reconcilePatientNativePushRegistration() {
  if (!isNativeAndroidPushAvailable()) {
    return { permission: "unsupported", registered: false };
  }

  const permission = await checkPatientNativePushPermission();
  if (permission !== "granted" || isExplicitlyDisabled()) {
    return { permission, registered: false };
  }

  await registerPatientNativePushDevice();
  return { permission, registered: true };
}

export async function getPatientNativePushDeviceStatus() {
  if (!isNativeAndroidPushAvailable()) {
    throw createNativePushError("unsupported");
  }

  const installationId = getOrCreatePatientNativePushInstallationId();
  const { data, error } = await supabase.rpc(
    "get_my_patient_native_push_device_status",
    { p_installation_id: installationId }
  );

  if (error) {
    throw createNativePushError("status_failed");
  }

  return data || { found: false, enabled: false, platform: "android" };
}

export async function disablePatientNativePushDevice() {
  if (!isNativeAndroidPushAvailable()) {
    return {
      deactivated: false,
      unregistered: false,
      deactivationError: createNativePushError("unsupported"),
      unregisterError: null,
    };
  }

  let deactivationError = null;
  let unregisterError = null;
  setExplicitlyDisabled(true);

  lifecycleGeneration += 1;
  const pendingRegistration = registrationInFlight;
  cancelRegistration(pendingRegistration, "explicit_disable");
  const cleanupBinding = captureCleanupSession();

  if (pendingRegistration) {
    await withTimeout(
      pendingRegistration.completion,
      settingsOperationTimeoutMs,
      "registration_cancellation_timeout"
    ).catch(() => undefined);
  }

  try {
    await runBoundCleanup(
      cleanupBinding,
      (session) => deactivateCurrentInstallation({ session }),
      settingsOperationTimeoutMs,
      "deactivation_timeout"
    );
  } catch (error) {
    deactivationError = error;
  }

  try {
    await runBoundCleanup(
      cleanupBinding,
      () => unregisterNativePush(),
      settingsOperationTimeoutMs,
      "unregister_timeout"
    );
  } catch (error) {
    unregisterError = error;
  }

  return {
    deactivated: deactivationError === null,
    unregistered: unregisterError === null,
    deactivationError,
    unregisterError,
  };
}

export async function cleanupPatientNativePushBeforeLogout() {
  if (!isNativeAndroidPushAvailable()) {
    return { deactivated: false, unregistered: false, skipped: true };
  }

  let deactivated;
  let unregistered;

  registrationBlocked = true;
  lifecycleGeneration += 1;
  const pendingRegistration = registrationInFlight;
  cancelRegistration(pendingRegistration, "logout_cleanup");
  const cleanupBinding = captureCleanupSession();

  if (pendingRegistration) {
    await withTimeout(
      pendingRegistration.completion,
      logoutOperationTimeoutMs,
      "registration_cancellation_timeout"
    ).catch(() => undefined);
  }

  try {
    await runBoundCleanup(
      cleanupBinding,
      (session) => deactivateCurrentInstallation({ session }),
      logoutOperationTimeoutMs,
      "deactivation_timeout"
    );
    deactivated = true;
  } catch {
    deactivated = false;
  }

  try {
    await runBoundCleanup(
      cleanupBinding,
      () => unregisterNativePush(),
      logoutOperationTimeoutMs,
      "unregister_timeout"
    );
    unregistered = true;
  } catch {
    unregistered = false;
  }

  return { deactivated, unregistered, skipped: false };
}
