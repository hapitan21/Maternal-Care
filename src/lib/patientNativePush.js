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
let registrationTokens = null;
let disableInFlight = null;

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
  if (operation.tokens === registrationTokens) disposeRegistrationTokens();
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
    const expected = registrationInFlight?.identity || disableInFlight?.identity || observedAuthIdentity;
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
      disableInFlight?.abortController.abort();
      cancelRegistration(registrationInFlight, "auth_changed");
      disposeRegistrationTokens();
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

function isCurrentTokenListener(tokens) {
  return tokens === registrationTokens && !tokens.disposed &&
    !registrationBlocked && tokens.generation === lifecycleGeneration;
}

function disposeRegistrationTokens() {
  const tokens = registrationTokens;
  registrationTokens = null;
  if (!tokens) return;
  tokens.disposed = true;
  tokens.latest = null;
  void removeListener(tokens.handle);
  void removeListener(tokens.errorHandle);
}

function receiveRegistrationToken(tokens, value) {
  if (!isCurrentTokenListener(tokens)) return;
  if (isExplicitlyDisabled() && !(registrationInFlight?.tokens === tokens &&
      registrationInFlight.allowExplicitlyDisabled)) return;

  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length < 32) {
    tokens.waiting?.(createNativePushError("registration_failed"));
    return;
  }
  if (normalized === tokens.latest) return;
  tokens.latest = normalized;
  tokens.revision += 1;
  tokens.waiting?.();
  if (tokens.enabled && !registrationInFlight) {
    // Rotations share the same serialization and authorization as initial registration.
    // Failures wait for a new event or explicit reconciliation; they never spin/replay old tokens.
    void startRegistration({ tokens, rotation: true }).catch(() => undefined);
  }
}

function createRegistrationTokens(operation) {
  const tokens = {
    identity: operation.identity, patientId: operation.patientId,
    installationId: operation.installationId, generation: operation.generation,
    latest: null, revision: 0, enabled: false,
    disposed: false, handle: null, errorHandle: null, waiting: null,
  };
  registrationTokens = tokens;
  return tokens;
}

async function waitForRegistrationToken(operation) {
  const tokens = operation.tokens;
  let timeoutId;
  let settled = false;
  let started = false;
  let initialError;

  return new Promise((resolve, reject) => {
    const finish = (error) => {
      if (settled) return;
      settled = true;
      tokens.waiting = null;
      operation.cancelWaiting = null;
      window.clearTimeout(timeoutId);
      if (error) reject(error);
      else resolve();
    };
    tokens.waiting = (error) => {
      if (error) initialError = error;
      if (!started) return;
      if (tokens.latest) finish();
      else if (initialError) finish(initialError);
    };
    operation.cancelWaiting = () => finish(createNativePushError(
      operation.cancelCode || "registration_cancelled"
    ));
    timeoutId = window.setTimeout(() => {
      cancelRegistration(operation, "registration_timeout");
    }, registrationTimeoutMs);

    const start = async () => {
      if (!tokens.handle) {
        tokens.handle = await PushNotifications.addListener("registration", (token) => {
          receiveRegistrationToken(tokens, token?.value);
        });
        if (!isCurrentTokenListener(tokens)) {
          await removeListener(tokens.handle);
          return;
        }
        tokens.errorHandle = await PushNotifications.addListener("registrationError", () => {
          tokens.waiting?.(createNativePushError("registration_failed"));
        });
        if (!isCurrentTokenListener(tokens)) {
          await removeListener(tokens.errorHandle);
          return;
        }
      }
      assertCurrentRegistration(operation);
      // Retained callbacks run on addListener. They must never skip the fresh getToken request.
      await PushNotifications.register();
      assertCurrentRegistration(operation);
      started = true;
      tokens.waiting?.();
    };
    void start().catch(() => finish(createNativePushError("registration_failed")));
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

  const installationId = operation.tokens?.installationId || getOrCreatePatientNativePushInstallationId();
  operation.installationId = installationId;
  let persistenceStarted = false;

  try {
    await authorizeRegistration(operation, await awaitRegistrationWork(operation, operation.initialSession));
    operation.tokens ||= createRegistrationTokens(operation);
    const tokens = operation.tokens;
    if (!operation.rotation) await waitForRegistrationToken(operation);
    assertCurrentRegistration(operation);

    let registration;
    do {
      const session = await authorizeRegistration(operation);
      assertCurrentRegistration(operation);
      // Read after authorization so callbacks received during those awaits coalesce.
      const pushToken = tokens.latest;
      operation.tokenRevision = tokens.revision;
      persistenceStarted = true;
      try {
        registration = await awaitRegistrationWork(operation, persistRegistrationToken(
          pushToken, installationId, operation.abortController.signal, session
        ));
      } catch (error) {
        assertCurrentRegistration(operation);
        // An older failed request cannot discard an already received newer token.
        if (tokens.revision !== operation.tokenRevision) continue;
        throw error;
      }
      assertCurrentRegistration(operation);
    } while (tokens.revision !== operation.tokenRevision);

    tokens.enabled = true;
    setExplicitlyDisabled(false);
    dispatchStatusChanged(true);
    return { installationId, registration };
  } catch (error) {
    if (persistenceStarted) {
      await compensateForPossibleUpsert(operation);
    }
    if (!operation.tokens?.enabled || error?.code === "inactive_patient") {
      if (operation.tokens === registrationTokens) disposeRegistrationTokens();
    }
    if (operation.cancelled) {
      throw createNativePushError(operation.cancelCode || "registration_cancelled");
    }
    throw error?.code ? error : createNativePushError("persistence_failed");
  } finally {
    operation.abortController = null;
    operation.initialSession = null;
    operation.cancelWaiting = null;
  }
}

async function deactivateCurrentInstallation({ notify = true, session, abortSignal,
  installationId = getOrCreatePatientNativePushInstallationId() } = {}) {
  const request = supabase.rpc(
    "deactivate_my_patient_native_push_device",
    { p_installation_id: installationId }
  );
  if (session) request.setHeader("Authorization", "Bearer " + session.access_token);
  if (abortSignal) request.abortSignal(abortSignal);
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
  disableInFlight?.abortController.abort();
  disposeRegistrationTokens();
  registrationBlocked = false;

  if (registrationInFlight) {
    cancelRegistration(registrationInFlight, "session_replaced");
  }
}

export function endPatientNativePushSession() {
  registrationBlocked = true;
  lifecycleGeneration += 1;
  authGeneration += 1;
  disableInFlight?.abortController.abort();
  cancelRegistration(registrationInFlight, "session_ended");
  disposeRegistrationTokens();
  authSubscription?.unsubscribe();
  authSubscription = null;
  observedAuthIdentity = null;
  authObserved = false;
}

export function registerPatientNativePushDevice({ allowExplicitlyDisabled = false } = {}) {
  return startRegistration({ allowExplicitlyDisabled });
}

function startRegistration({
  allowExplicitlyDisabled = false, tokens = registrationTokens, rotation = false,
} = {}) {
  if (disableInFlight?.generation === lifecycleGeneration) {
    return Promise.reject(createNativePushError("registration_cancelled"));
  }
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
    identity: tokens?.identity || null,
    patientId: tokens?.patientId || null,
    tokens, rotation, allowExplicitlyDisabled, tokenRevision: tokens?.revision || 0,
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
      const tokens = operation.tokens;
      if (tokens?.enabled && isCurrentTokenListener(tokens) &&
          tokens.revision > operation.tokenRevision) {
        void startRegistration({ tokens, rotation: true }).catch(() => undefined);
      }
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

export function disablePatientNativePushDevice() {
  if (!isNativeAndroidPushAvailable()) {
    return Promise.resolve({
      deactivated: false,
      unregistered: false,
      deactivationError: createNativePushError("unsupported"),
      unregisterError: null,
    });
  }
  if (disableInFlight?.generation === lifecycleGeneration) return disableInFlight.promise;

  lifecycleGeneration += 1;
  const pendingRegistration = registrationInFlight;
  cancelRegistration(pendingRegistration, "explicit_disable");
  disposeRegistrationTokens();
  const operation = {
    generation: lifecycleGeneration,
    binding: captureCleanupSession(),
    installationId: getOrCreatePatientNativePushInstallationId(),
    identity: null,
    abortController: new AbortController(),
    promise: null,
  };
  disableInFlight = operation;
  operation.promise = performDisable(operation, pendingRegistration).finally(() => {
    if (disableInFlight === operation) disableInFlight = null;
  });
  return operation.promise;
}

function assertCurrentDisable(operation, session) {
  if (session) operation.identity ||= getSessionIdentity(session);
  if (registrationBlocked || operation.abortController.signal.aborted ||
      operation.generation !== lifecycleGeneration || operation.binding.generation !== authGeneration ||
      (authObserved && operation.identity && !sameIdentity(operation.identity, observedAuthIdentity))) {
    throw createNativePushError("auth_changed");
  }
}

async function performDisable(operation, pendingRegistration) {
  let deactivationError = null;
  let unregisterError = null;

  if (pendingRegistration) {
    await withTimeout(pendingRegistration.completion, settingsOperationTimeoutMs,
      "registration_cancellation_timeout").catch(() => undefined);
  }

  try {
    assertCurrentDisable(operation);
    await runBoundCleanup(operation.binding, (session) => {
      assertCurrentDisable(operation, session);
      return deactivateCurrentInstallation({ session, notify: false,
        installationId: operation.installationId, abortSignal: operation.abortController.signal });
    }, settingsOperationTimeoutMs, "deactivation_timeout");
    assertCurrentDisable(operation);
  } catch (error) {
    deactivationError = error;
    operation.abortController.abort();
  }

  // A failed server operation leaves the saved preference and native token usable.
  // The temporary in-flight guard prevents reconciliation from re-enabling mid-Disable.
  if (!deactivationError) {
    try {
      await runBoundCleanup(operation.binding, (session) => {
        assertCurrentDisable(operation, session);
        return unregisterNativePush();
      }, settingsOperationTimeoutMs, "unregister_timeout");
    } catch (error) {
      unregisterError = error;
    }
    try {
      assertCurrentDisable(operation);
      // Server delivery is off even if native unregister failed; retain explicit Disable.
      setExplicitlyDisabled(true);
      dispatchStatusChanged(false);
    } catch (error) {
      deactivationError = error;
    }
  }

  return {
    deactivated: deactivationError === null,
    unregistered: deactivationError === null && unregisterError === null,
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
  disableInFlight?.abortController.abort();
  cancelRegistration(pendingRegistration, "logout_cleanup");
  disposeRegistrationTokens();
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
