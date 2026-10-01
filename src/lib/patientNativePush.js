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
  abortSignal
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
    .abortSignal(abortSignal);

  if (error) {
    throw createNativePushError("persistence_failed");
  }

  return data;
}

async function compensateForPossibleUpsert() {
  try {
    await withTimeout(
      deactivateCurrentInstallation({ notify: false }),
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
  let persistenceStarted = false;

  try {
    const pushToken = await waitForRegistrationToken(operation);
    if (!isCurrentRegistration(operation)) {
      throw createNativePushError(
        operation.cancelCode || "registration_cancelled"
      );
    }

    persistenceStarted = true;
    operation.abortController = new AbortController();
    const registration = await persistRegistrationToken(
      pushToken,
      installationId,
      operation.abortController.signal
    );

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
      await compensateForPossibleUpsert();
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
    operation.cancelWaiting = null;
  }
}

async function deactivateCurrentInstallation({ notify = true } = {}) {
  const installationId = getOrCreatePatientNativePushInstallationId();
  const { data, error } = await supabase.rpc(
    "deactivate_my_patient_native_push_device",
    { p_installation_id: installationId }
  );

  if (error) {
    throw createNativePushError("deactivation_failed");
  }

  if (notify) dispatchStatusChanged(false);
  return data;
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
  lifecycleGeneration += 1;
  registrationBlocked = false;

  if (registrationInFlight) {
    cancelRegistration(registrationInFlight, "session_replaced");
  }
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

  const operation = {
    abortController: null,
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

  if (pendingRegistration) {
    await withTimeout(
      pendingRegistration.completion,
      settingsOperationTimeoutMs,
      "registration_cancellation_timeout"
    ).catch(() => undefined);
  }

  try {
    await withTimeout(
      deactivateCurrentInstallation(),
      settingsOperationTimeoutMs,
      "deactivation_timeout"
    );
  } catch (error) {
    deactivationError = error;
  }

  try {
    await withTimeout(
      unregisterNativePush(),
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

  if (pendingRegistration) {
    await withTimeout(
      pendingRegistration.completion,
      logoutOperationTimeoutMs,
      "registration_cancellation_timeout"
    ).catch(() => undefined);
  }

  try {
    await withTimeout(
      deactivateCurrentInstallation(),
      logoutOperationTimeoutMs,
      "deactivation_timeout"
    );
    deactivated = true;
  } catch {
    deactivated = false;
  }

  try {
    await withTimeout(
      unregisterNativePush(),
      logoutOperationTimeoutMs,
      "unregister_timeout"
    );
    unregistered = true;
  } catch {
    unregistered = false;
  }

  return { deactivated, unregistered, skipped: false };
}
