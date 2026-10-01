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

  const setFeatureState = useCallback((updates) => {
    setState((current) => ({ ...current, ...updates }));
  }, []);

  const refreshPushStatus = useCallback(async ({ keepMessage = false } = {}) => {
    const operationId = operationRef.current + 1;
    operationRef.current = operationId;

    const finish = (updates) => {
      if (operationRef.current !== operationId) return;
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
      error: "",
      message: keepMessage ? current.message : "",
    }));

    if (!isNativeAndroidPushAvailable()) {
      finish({
        supported: false,
        permission: "unsupported",
        subscribed: false,
        status: patientPushStatuses.unsupported,
      });
      return;
    }

    try {
      const permission = await checkPatientNativePushPermission();
      const deviceStatus = await getPatientNativePushDeviceStatus();
      const explicitlyDisabled =
        isPatientNativePushExplicitlyDisabled();
      const subscribed =
        !explicitlyDisabled && deviceStatus?.enabled === true;
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
        status,
        error: "",
      });
    } catch (error) {
      finish({
        supported: true,
        subscribed: false,
        status: patientPushStatuses.error,
        error: getSafeNativePushErrorMessage(
          error,
          "Push notification status could not be loaded. Please try again."
        ),
      });
    }
  }, []);

  useEffect(() => {
    let active = true;
    const initializeStatus = async () => {
      await Promise.resolve();
      if (active) await refreshPushStatus();
    };
    void initializeStatus();

    const handleStatusChanged = () => {
      void refreshPushStatus({ keepMessage: true });
    };
    window.addEventListener(
      patientNativePushStatusChangedEvent,
      handleStatusChanged
    );

    return () => {
      active = false;
      window.removeEventListener(
        patientNativePushStatusChangedEvent,
        handleStatusChanged
      );
    };
  }, [refreshPushStatus]);

  const enablePushNotifications = useCallback(async () => {
    if (enablingRef.current) return false;
    enablingRef.current = true;
    operationRef.current += 1;
    setFeatureState({
      enabling: true,
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
        setFeatureState({
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
      setFeatureState({
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
      setFeatureState({
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
    }
  }, [setFeatureState]);

  const disablePushNotifications = useCallback(async () => {
    if (disablingRef.current) return false;
    disablingRef.current = true;
    operationRef.current += 1;
    setFeatureState({
      disabling: true,
      loading: false,
      error: "",
      message: "",
    });

    try {
      const result = await disablePatientNativePushDevice();

      if (!result.deactivated) {
        setFeatureState({
          subscribed: true,
          status: patientPushStatuses.error,
          disabling: false,
          error: navigator.onLine === false
            ? offlineMessage
            : "Android notifications were removed locally, but Maternal Care could not synchronize this setting. Connect to the internet and retry Disable.",
          message: "",
        });
        return false;
      }

      setFeatureState({
        subscribed: false,
        status: patientPushStatuses.unsubscribed,
        disabling: false,
        error: result.unregistered
          ? ""
          : "Push delivery is disabled, but Android could not finish removing its local registration. You can safely retry.",
        message: result.unregistered
          ? "Push notifications are no longer enabled on this device."
          : "Push delivery is no longer enabled for this device.",
      });
      return result.unregistered;
    } finally {
      disablingRef.current = false;
    }
  }, [setFeatureState]);

  return {
    ...state,
    enabling: state.enabling === true,
    disabling: state.disabling === true,
    enablePushNotifications,
    disablePushNotifications,
    refreshPushStatus,
  };
}
