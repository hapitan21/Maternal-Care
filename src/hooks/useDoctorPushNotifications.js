import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import {
  getMaternalCarePushServiceWorkerRegistration,
  getPushFeatureSupport,
  getPushSubscriptionPayload,
  getSafeDeviceLabel,
  getWebPushPublicKey,
  pushStatuses,
  urlBase64ToUint8Array,
} from "../lib/webPush";

const insecureMessage =
  "Push alerts require a secure HTTPS connection.";
const unsupportedMessage =
  "Push alerts are not supported by this browser.";
const missingKeyMessage =
  "Push alert configuration is incomplete. The public VAPID key is missing.";
const deniedMessage =
  "Notification permission is blocked. Enable it in this browser's site settings, then retry.";
const offlineMessage =
  "You are offline. Connect to the internet before changing push alert settings.";

function getInitialState() {
  const support = getPushFeatureSupport();
  return {
    supported: support.supported,
    secureContext: support.secureContext,
    permission: support.permission,
    subscribed: false,
    status: pushStatuses.loading,
    loading: true,
    enabling: false,
    disabling: false,
    error: "",
    message: "",
  };
}

function getSafeErrorMessage(error, fallback) {
  const message = String(error?.message || "").toLowerCase();
  if (message.includes("secure https")) return insecureMessage;
  if (message.includes("not supported")) return unsupportedMessage;
  if (message.includes("offline") || message.includes("network") || message.includes("fetch")) {
    return offlineMessage;
  }
  if (message.includes("public key") || message.includes("p-256")) {
    return missingKeyMessage;
  }
  if (message.includes("permission")) return deniedMessage;
  if (message.includes("active doctor")) {
    return "An active Doctor account is required to manage push alerts.";
  }
  if (message.includes("service worker")) {
    return "The Maternal Care push service is not ready. Reload the app and retry.";
  }
  return fallback;
}

export function useDoctorPushNotifications() {
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
        enabling: false,
        disabling: false,
        message: keepMessage ? current.message : "",
        ...updates,
      }));
    };

    setState((current) => ({
      ...current,
      status: pushStatuses.loading,
      loading: true,
      error: "",
      message: keepMessage ? current.message : "",
    }));

    if (!support.secureContext) {
      finish({ subscribed: false, status: pushStatuses.insecure, error: insecureMessage });
      return;
    }
    if (!support.supported) {
      finish({ subscribed: false, status: pushStatuses.unsupported, error: unsupportedMessage });
      return;
    }

    const publicKey = getWebPushPublicKey();
    if (!publicKey) {
      finish({ subscribed: false, status: pushStatuses.missingPublicKey, error: missingKeyMessage });
      return;
    }

    try {
      urlBase64ToUint8Array(publicKey);
    } catch (error) {
      finish({
        subscribed: false,
        status: pushStatuses.missingPublicKey,
        error: getSafeErrorMessage(error, missingKeyMessage),
      });
      return;
    }

    if (support.permission === "denied") {
      finish({ subscribed: false, status: pushStatuses.permissionDenied, error: deniedMessage });
      return;
    }

    try {
      const registration = await getMaternalCarePushServiceWorkerRegistration();
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        finish({
          subscribed: false,
          status: support.permission === "default"
            ? pushStatuses.permissionDefault
            : pushStatuses.unsubscribed,
          error: "",
        });
        return;
      }

      const { endpoint } = getPushSubscriptionPayload(subscription);
      const { data, error } = await supabase
        .from("doctor_push_subscriptions")
        .select("id, is_active")
        .eq("endpoint", endpoint)
        .maybeSingle();
      if (error) throw error;

      finish({
        subscribed: data?.is_active === true,
        status: data?.is_active === true
          ? pushStatuses.subscribed
          : pushStatuses.unsubscribed,
        error: "",
      });
    } catch (error) {
      finish({
        subscribed: false,
        status: pushStatuses.error,
        error: getSafeErrorMessage(
          error,
          "Push alert status could not be loaded. Confirm the reviewed Doctor Web Push SQL is installed."
        ),
      });
    }
  }, []);

  useEffect(() => {
    const refreshTimer = window.setTimeout(refreshPushStatus, 0);
    return () => {
      window.clearTimeout(refreshTimer);
      operationRef.current += 1;
    };
  }, [refreshPushStatus]);

  const enablePushNotifications = useCallback(async () => {
    if (enablingRef.current) return false;
    enablingRef.current = true;
    operationRef.current += 1;
    setFeatureState({ enabling: true, error: "", message: "" });
    let createdSubscription = null;

    try {
      const support = getPushFeatureSupport();
      if (!support.secureContext) throw new Error(insecureMessage);
      if (!support.supported) throw new Error(unsupportedMessage);
      if (navigator.onLine === false) throw new Error(offlineMessage);

      const publicKey = getWebPushPublicKey();
      if (!publicKey) throw new Error(missingKeyMessage);
      const applicationServerKey = urlBase64ToUint8Array(publicKey);
      const registration = await getMaternalCarePushServiceWorkerRegistration();
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
      const { error } = await supabase.rpc("upsert_my_doctor_push_subscription", {
        p_endpoint: payload.endpoint,
        p_p256dh: payload.p256dh,
        p_auth_key: payload.authKey,
        p_expiration_time: payload.expirationTime,
        p_user_agent: navigator.userAgent || null,
        p_device_label: getSafeDeviceLabel(),
      });
      if (error) throw error;

      setFeatureState({
        subscribed: true,
        status: pushStatuses.subscribed,
        loading: false,
        enabling: false,
        error: "",
        message: "Push alerts enabled on this device.",
      });
      return true;
    } catch (error) {
      if (createdSubscription) {
        await createdSubscription.unsubscribe().catch(() => false);
      }

      const support = getPushFeatureSupport();
      const status = !support.secureContext
        ? pushStatuses.insecure
        : !support.supported
          ? pushStatuses.unsupported
          : support.permission === "denied"
            ? pushStatuses.permissionDenied
            : !getWebPushPublicKey()
              ? pushStatuses.missingPublicKey
              : pushStatuses.error;

      setFeatureState({
        subscribed: false,
        status,
        loading: false,
        enabling: false,
        error: getSafeErrorMessage(error, "Push alerts could not be enabled. Please retry."),
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
      const registration = await getMaternalCarePushServiceWorkerRegistration();
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        setFeatureState({
          subscribed: false,
          status: pushStatuses.unsubscribed,
          loading: false,
          disabling: false,
          error: "",
          message: "Push alerts are already disabled on this device.",
        });
        return true;
      }

      const { endpoint } = getPushSubscriptionPayload(subscription);
      const { error } = await supabase.rpc("deactivate_my_doctor_push_subscription", {
        p_endpoint: endpoint,
      });
      if (error) throw error;

      let unsubscribed = false;
      try {
        unsubscribed = await subscription.unsubscribe();
      } catch {
        unsubscribed = false;
      }

      setFeatureState({
        subscribed: false,
        status: pushStatuses.unsubscribed,
        loading: false,
        disabling: false,
        error: unsubscribed
          ? ""
          : "Server delivery is disabled, but the browser could not remove its local subscription. Retry safely.",
        message: unsubscribed
          ? "Push alerts disabled on this device."
          : "Push delivery is disabled for this device.",
      });
      return true;
    } catch (error) {
      setFeatureState({
        loading: false,
        disabling: false,
        error: getSafeErrorMessage(error, "Push alerts could not be disabled. Please retry."),
        message: "",
      });
      return false;
    } finally {
      disablingRef.current = false;
    }
  }, [setFeatureState]);

  return {
    ...state,
    enablePushNotifications,
    disablePushNotifications,
    refreshPushStatus,
  };
}
