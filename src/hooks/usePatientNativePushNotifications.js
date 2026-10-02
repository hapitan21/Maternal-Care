import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentPatientAccountStatus } from "../lib/patientAuthLinking";
import { patientAccountStatuses } from "../lib/patientAccountStatus";
import {
  checkPatientNativePushPermission,
  disablePatientNativePushDevice,
  getPatientNativePushDeviceStatus,
  isNativeAndroidPushAvailable,
  isPatientNativePushExplicitlyDisabled,
  patientNativePushStatusChangedEvent,
  registerPatientNativePushDevice,
  requestPatientNativePushPermission,
} from "../lib/patientNativePush";
import { patientPushStatuses } from "../lib/webPush";

const offlineMessage =
  "You are offline. Connect to the internet before changing push notification settings.";
const deniedMessage =
  "Notifications are blocked for Maternal Care. Allow them in Android Settings, then refresh the status.";

function getInitialState() {
  const supported = isNativeAndroidPushAvailable();
  return {
    supported,
    secureContext: true,
    permission: supported ? "default" : "unsupported",
    subscribed: false,
    status: supported
      ? patientPushStatuses.loading
      : patientPushStatuses.unsupported,
    loading: supported,
    enabling: false,
    disabling: false,
    disableRetry: false,
    error: "",
    message: "",
  };
}

function getSafeNativePushErrorMessage(error, fallback) {
  if (navigator.onLine === false) return offlineMessage;

  switch (error?.code) {
    case "installation_id_unavailable":
      return "This app installation could not be identified. Restart Maternal Care and try again.";
    case "permission_check_failed":
    case "permission_request_failed":
      return "Android notification permission could not be checked. Please try again.";
    case "registration_timeout":
      return "Android notification registration took too long. Check your connection and try again.";
    case "registration_failed":
      return "This device could not register for Android notifications. Please try again.";
    case "persistence_failed":
      return "This device registered with Android, but Maternal Care could not save the notification setting. Please try again.";
    case "status_failed":
      return "Push notification status could not be loaded. Please try again.";
    default:
      return fallback;
  }
}

export function usePatientNativePushNotifications() {
  const [state, setState] = useState(getInitialState);
  const operationRef = useRef(0);
  const enablingRef = useRef(false);
  const disablingRef = useRef(false);
  const mountedRef = useRef(false);
  const refreshInFlightRef = useRef(null);
  const refreshPendingRef = useRef(false);
  const disableErrorRef = useRef("");

  const setFeatureState = useCallback((updates, operationId) => {
    if (!mountedRef.current || operationId !== operationRef.current) return;
    setState((current) => ({ ...current, ...updates }));
  }, []);

  const refreshPushStatus = useCallback(function refreshStatus({ keepMessage = false } = {}) {
    if (!mountedRef.current) return Promise.resolve();
    if (enablingRef.current || disablingRef.current || refreshInFlightRef.current) {
      refreshPendingRef.current = true;
      return refreshInFlightRef.current || Promise.resolve();
    }
    refreshPendingRef.current = false;
    const operationId = ++operationRef.current;
    const finish = (updates) => {
      if (!mountedRef.current || operationRef.current !== operationId) return;
      setState((current) => ({
        ...current,
        loading: false,
        message: keepMessage ? current.message : "",
        ...updates,
      }));
    };
    setState((current) => ({
      ...current,
      status: patientPushStatuses.loading,
      loading: true,
      error: disableErrorRef.current,
      message: keepMessage ? current.message : "",
    }));

    const work = (async () => {
      if (!isNativeAndroidPushAvailable()) {
        finish({
          supported: false,
          permission: "unsupported",
          subscribed: false,
          status: patientPushStatuses.unsupported,
        });
        return;
      }
      let permission;
      try {
        permission = await checkPatientNativePushPermission();
        const deviceStatus = await getPatientNativePushDeviceStatus();
        const subscribed =
          !isPatientNativePushExplicitlyDisabled() && deviceStatus?.enabled === true;
        const status =
          permission === "denied"
            ? patientPushStatuses.permissionDenied
            : subscribed
              ? patientPushStatuses.subscribed
              : permission === "default"
                ? patientPushStatuses.permissionDefault
                : patientPushStatuses.unsubscribed;
        finish({
          supported: true,
          secureContext: true,
          permission,
          subscribed,
          status: disableErrorRef.current ? patientPushStatuses.error : status,
          error: disableErrorRef.current,
          disableRetry: Boolean(disableErrorRef.current),
        });
      } catch (error) {
        // A status-read failure must not remove an already usable Disable retry action.
        finish({
          supported: true,
          ...(permission ? { permission } : {}),
          status: patientPushStatuses.error,
          error: disableErrorRef.current || getSafeNativePushErrorMessage(
            error,
            "Push notification status could not be loaded. Please try again."
          ),
        });
      }
    })();
    const tracked = work.finally(() => {
      if (refreshInFlightRef.current !== tracked) return;
      refreshInFlightRef.current = null;
      if (mountedRef.current && refreshPendingRef.current &&
          !enablingRef.current && !disablingRef.current) {
        void refreshStatus({ keepMessage: true });
      }
    });
    refreshInFlightRef.current = tracked;
    return tracked;
  }, []);

  useEffect(() => {
    let active = true;
    let scheduled = false;
    mountedRef.current = true;
    const scheduleRefresh = () => {
      if (!active || scheduled) return;
      scheduled = true;
      void Promise.resolve().then(() => {
        scheduled = false;
        if (active) void refreshPushStatus({ keepMessage: true });
      });
    };
    const handleForeground = () => {
      if (document.visibilityState !== "hidden") scheduleRefresh();
    };
    scheduleRefresh();
    window.addEventListener(patientNativePushStatusChangedEvent, scheduleRefresh);
    document.addEventListener("visibilitychange", handleForeground);
    window.addEventListener("focus", handleForeground);
    return () => {
      active = false;
      mountedRef.current = false;
      operationRef.current += 1;
      refreshPendingRef.current = false;
      window.removeEventListener(patientNativePushStatusChangedEvent, scheduleRefresh);
      document.removeEventListener("visibilitychange", handleForeground);
      window.removeEventListener("focus", handleForeground);
    };
  }, [refreshPushStatus]);

  const enablePushNotifications = useCallback(async () => {
    if (!mountedRef.current || enablingRef.current || disablingRef.current) return false;
    enablingRef.current = true;
    const operationId = ++operationRef.current;
    const finish = (updates) => setFeatureState(updates, operationId);
    disableErrorRef.current = "";
    finish({
      enabling: true,
      disableRetry: false,
      loading: false,
      error: "",
      message: "",
    });

    try {
      if (navigator.onLine === false) {
        throw Object.assign(new Error("offline"), { code: "offline" });
      }

      const account = await getCurrentPatientAccountStatus();
      if (
        !account.patient ||
        account.status !== patientAccountStatuses.active
      ) {
        throw Object.assign(new Error("inactive_patient"), {
          code: "inactive_patient",
        });
      }

      let permission = await checkPatientNativePushPermission();
      if (permission === "default") {
        permission = await requestPatientNativePushPermission();
      }

      if (permission !== "granted") {
        finish({
          permission,
          subscribed: false,
          status:
            permission === "denied"
              ? patientPushStatuses.permissionDenied
              : patientPushStatuses.permissionDefault,
          enabling: false,
          error: permission === "denied" ? "" : deniedMessage,
          message: "",
        });
        return false;
      }

      await registerPatientNativePushDevice({
        allowExplicitlyDisabled: true,
      });
      finish({
        permission: "granted",
        subscribed: true,
        status: patientPushStatuses.subscribed,
        enabling: false,
        error: "",
        message: "Push notifications are enabled on this device.",
      });
      return true;
    } catch (error) {
      const inactivePatient = error?.code === "inactive_patient";
      finish({
        subscribed: false,
        status: patientPushStatuses.error,
        enabling: false,
        error: inactivePatient
          ? "An active linked Patient account is required to enable push notifications."
          : getSafeNativePushErrorMessage(
              error,
              "Push notifications could not be enabled. Please try again."
            ),
        message: "",
      });
      return false;
    } finally {
      enablingRef.current = false;
      if (mountedRef.current && refreshPendingRef.current) {
        void refreshPushStatus({ keepMessage: true });
      }
    }
  }, [refreshPushStatus, setFeatureState]);

  const disablePushNotifications = useCallback(async () => {
    if (!mountedRef.current || disablingRef.current || enablingRef.current) return false;
    disablingRef.current = true;
    const operationId = ++operationRef.current;
    const finish = (updates) => setFeatureState(updates, operationId);
    disableErrorRef.current = "";
    finish({
      disabling: true,
      loading: false,
      error: "",
      message: "",
    });

    try {
      const result = await disablePatientNativePushDevice();

      if (!result.deactivated) {
        disableErrorRef.current = navigator.onLine === false
          ? offlineMessage
          : "Maternal Care could not disable push delivery for this device. Connect to the internet and retry Disable.";
        finish({
          status: patientPushStatuses.error,
          disabling: false,
          disableRetry: true,
          error: disableErrorRef.current,
          message: "",
        });
        return false;
      }

      disableErrorRef.current = result.unregistered
        ? ""
        : "Push delivery is disabled, but Android could not finish removing its local registration. You can safely retry.";
      finish({
        subscribed: false,
        disableRetry: !result.unregistered,
        status: patientPushStatuses.unsubscribed,
        disabling: false,
        error: disableErrorRef.current,
        message: result.unregistered
          ? "Push notifications are no longer enabled on this device."
          : "Push delivery is no longer enabled for this device.",
      });
      return result.unregistered;
    } catch (error) {
      disableErrorRef.current = getSafeNativePushErrorMessage(
        error,
        "Push notifications could not be disabled. Please retry Disable."
      );
      finish({
        status: patientPushStatuses.error,
        disabling: false,
        disableRetry: true,
        error: disableErrorRef.current,
        message: "",
      });
      return false;
    } finally {
      disablingRef.current = false;
      if (mountedRef.current && refreshPendingRef.current) {
        void refreshPushStatus({ keepMessage: true });
      }
    }
  }, [refreshPushStatus, setFeatureState]);

  return {
    ...state,
    enabling: state.enabling === true,
    disabling: state.disabling === true,
    enablePushNotifications,
    disablePushNotifications,
    refreshPushStatus,
  };
}
