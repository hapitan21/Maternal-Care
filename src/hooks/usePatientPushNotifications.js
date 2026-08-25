import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentPatientAccountStatus } from "../lib/patientAuthLinking";
import { patientAccountStatuses } from "../lib/patientAccountStatus";
import { supabase } from "../lib/supabaseClient";
import {
  getPatientServiceWorkerRegistration,
  getPushFeatureSupport,
  getPushSubscriptionPayload,
  getSafeDeviceLabel,
  getWebPushPublicKey,
  patientPushStatuses,
  urlBase64ToUint8Array,
} from "../lib/webPush";

const insecureMessage =
  "Push notifications require a secure HTTPS connection. Open the deployed Patient PWA or use an HTTPS development address.";
const unsupportedMessage = "Push notifications are not supported by this browser.";
const missingKeyMessage =
  "Push notification configuration is incomplete. The public VAPID key has not been configured.";
const deniedMessage =
  "Notification permission is blocked. Allow notifications in your browser or site settings, then return here.";
const offlineMessage =
  "You are offline. Connect to the internet before changing push notification settings.";

function getInitialState() {
  const support = getPushFeatureSupport();
  return {
    supported: support.supported,
    secureContext: support.secureContext,
    permission: support.permission,
    subscribed: false,
    status: patientPushStatuses.loading,
    loading: true,
    error: "",
    message: "",
  };
}

function getSafePushErrorMessage(error, fallback) {
  const message = String(error?.message || "").toLowerCase();

  if (message.includes("secure https")) return insecureMessage;
  if (message.includes("not supported")) return unsupportedMessage;
  if (message.includes("offline")) return offlineMessage;
  if (message.includes("active linked patient")) {
    return "An active linked Patient account is required to enable push notifications.";
  }
  if (message.includes("service worker")) {
    return "The Patient PWA service worker is not ready. Reload the app and try again.";
  }
  if (message.includes("public key") || message.includes("p-256")) {
    return missingKeyMessage;
  }
  if (message.includes("permission")) return deniedMessage;
  if (message.includes("network") || message.includes("fetch")) return offlineMessage;

  return fallback;
}

export function usePatientPushNotifications() {
  const [state, setState] = useState(getInitialState);
  const operationRef = useRef(0);
  const enablingRef = useRef(false);
  const disablingRef = useRef(false);

  const setFeatureState = useCallback((updates) => {
    const support = getPushFeatureSupport();
    setState((current) => ({
      ...current,
      supported: support.supported,
      secureContext: support.secureContext,
      permission: support.permission,
      ...updates,
    }));
  }, []);

  const refreshPushStatus = useCallback(async ({ keepMessage = false } = {}) => {
    const operationId = operationRef.current + 1;
    operationRef.current = operationId;
    const support = getPushFeatureSupport();

    const finish = (updates) => {
      if (operationRef.current !== operationId) return;
      setState((current) => ({
        ...current,
        supported: support.supported,
        secureContext: support.secureContext,
        permission: support.permission,
        loading: false,
        message: keepMessage ? current.message : "",
        ...updates,
      }));
    };

    setState((current) => ({
      ...current,
      supported: support.supported,
      secureContext: support.secureContext,
      permission: support.permission,
      status: patientPushStatuses.loading,
      loading: true,
      error: "",
      message: keepMessage ? current.message : "",
    }));

    if (!support.secureContext) {
      finish({
        subscribed: false,
        status: patientPushStatuses.insecure,
        error: insecureMessage,
      });
      return;
    }

    if (!support.supported) {
      finish({
        subscribed: false,
        status: patientPushStatuses.unsupported,
        error: unsupportedMessage,
      });
      return;
    }

    const publicKey = getWebPushPublicKey();
    if (!publicKey) {
      finish({
        subscribed: false,
        status: patientPushStatuses.missingPublicKey,
        error: missingKeyMessage,
      });
      return;
    }

    try {
      urlBase64ToUint8Array(publicKey);
    } catch (error) {
      finish({
        subscribed: false,
        status: patientPushStatuses.missingPublicKey,
        error: getSafePushErrorMessage(error, missingKeyMessage),
      });
      return;
    }

    if (support.permission === "denied") {
      finish({
        subscribed: false,
        status: patientPushStatuses.permissionDenied,
        error: deniedMessage,
      });
      return;
    }

    try {
      const registration = await getPatientServiceWorkerRegistration();
      const subscription = await registration.pushManager.getSubscription();

      if (!subscription) {
        finish({
          subscribed: false,
          status:
            support.permission === "default"
              ? patientPushStatuses.permissionDefault
              : patientPushStatuses.unsubscribed,
          error: "",
        });
        return;
      }

      const { endpoint } = getPushSubscriptionPayload(subscription);
      const { data, error } = await supabase
        .from("patient_push_subscriptions")
        .select("id, is_active")
        .eq("endpoint", endpoint)
        .maybeSingle();

      if (error) throw error;

      finish({
        subscribed: data?.is_active === true,
        status:
          data?.is_active === true
            ? patientPushStatuses.subscribed
            : patientPushStatuses.unsubscribed,
        error: "",
      });
    } catch (error) {
      finish({
        subscribed: false,
        status: patientPushStatuses.error,
        error: getSafePushErrorMessage(
          error,
          "Push notification status could not be loaded. Confirm that the Phase 3A SQL has been applied."
        ),
      });
    }
  }, []);

  useEffect(() => {
    refreshPushStatus();
  }, [refreshPushStatus]);

  const enablePushNotifications = useCallback(async () => {
    if (enablingRef.current) return false;
    enablingRef.current = true;
    operationRef.current += 1;
    setFeatureState({ enabling: true, error: "", message: "" });

    let createdSubscription = null;

    try {
      const account = await getCurrentPatientAccountStatus();
      if (
        !account.patient ||
        account.status !== patientAccountStatuses.active
      ) {
        throw new Error("An active linked Patient account is required.");
      }

      const support = getPushFeatureSupport();
      if (!support.secureContext) throw new Error(insecureMessage);
      if (!support.supported) throw new Error(unsupportedMessage);
      if (navigator.onLine === false) throw new Error(offlineMessage);

      const publicKey = getWebPushPublicKey();
      if (!publicKey) throw new Error(missingKeyMessage);
      const applicationServerKey = urlBase64ToUint8Array(publicKey);

      const registration = await getPatientServiceWorkerRegistration();
      let subscription = await registration.pushManager.getSubscription();
      let permission = window.Notification.permission;

      if (permission === "denied") throw new Error(deniedMessage);
      if (permission === "default") {
        permission = await window.Notification.requestPermission();
      }
      if (permission !== "granted") throw new Error(deniedMessage);

      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
        createdSubscription = subscription;
      }

      const payload = getPushSubscriptionPayload(subscription);
      const { error } = await supabase.rpc(
        "upsert_my_patient_push_subscription",
        {
          p_endpoint: payload.endpoint,
          p_p256dh: payload.p256dh,
          p_auth_key: payload.authKey,
          p_expiration_time: payload.expirationTime,
          p_user_agent: navigator.userAgent || null,
          p_device_label: getSafeDeviceLabel(),
        }
      );

      if (error) throw error;

      setFeatureState({
        subscribed: true,
        status: patientPushStatuses.subscribed,
        loading: false,
        enabling: false,
        error: "",
        message: "Push notifications are enabled on this device.",
      });
      return true;
    } catch (error) {
      if (createdSubscription) {
        await createdSubscription.unsubscribe().catch(() => false);
      }

      const support = getPushFeatureSupport();
      const status =
        !support.secureContext
          ? patientPushStatuses.insecure
          : !support.supported
            ? patientPushStatuses.unsupported
            : support.permission === "denied"
              ? patientPushStatuses.permissionDenied
              : !getWebPushPublicKey()
                ? patientPushStatuses.missingPublicKey
                : patientPushStatuses.error;

      setFeatureState({
        subscribed: false,
        status,
        loading: false,
        enabling: false,
        error: getSafePushErrorMessage(
          error,
          "Push notifications could not be enabled. Confirm the Phase 3A SQL and browser configuration."
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
    setFeatureState({ disabling: true, error: "", message: "" });

    try {
      if (navigator.onLine === false) throw new Error(offlineMessage);

      const registration = await getPatientServiceWorkerRegistration();
      const subscription = await registration.pushManager.getSubscription();

      if (!subscription) {
        setFeatureState({
          subscribed: false,
          status: patientPushStatuses.unsubscribed,
          loading: false,
          disabling: false,
          error: "",
          message: "Push notifications are already disabled on this device.",
        });
        return true;
      }

      const { endpoint } = getPushSubscriptionPayload(subscription);
      const { error } = await supabase.rpc(
        "deactivate_my_patient_push_subscription",
        { p_endpoint: endpoint }
      );

      if (error) throw error;

      let unsubscribed = false;
      try {
        unsubscribed = await subscription.unsubscribe();
      } catch {
        unsubscribed = false;
      }

      await refreshPushStatus();
      setFeatureState({
        subscribed: false,
        status: patientPushStatuses.unsubscribed,
        loading: false,
        disabling: false,
        error: unsubscribed
          ? ""
          : "Push delivery is disabled, but this browser could not remove its local subscription. You can safely retry.",
        message: unsubscribed
          ? "Push notifications are disabled on this device."
          : "Push delivery is disabled for this device.",
      });
      return true;
    } catch (error) {
      setFeatureState({
        loading: false,
        disabling: false,
        error: getSafePushErrorMessage(
          error,
          "Push notifications could not be disabled. Please try again."
        ),
        message: "",
      });
      return false;
    } finally {
      disablingRef.current = false;
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
