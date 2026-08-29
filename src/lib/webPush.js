export const patientPushStatuses = Object.freeze({
  unsupported: "unsupported",
  insecure: "insecure",
  missingPublicKey: "missing_public_key",
  permissionDefault: "permission_default",
  permissionDenied: "permission_denied",
  unsubscribed: "unsubscribed",
  subscribed: "subscribed",
  loading: "loading",
  error: "error",
});

const patientServiceWorkerScope = "/patient/";
const serviceWorkerReadyTimeoutMs = 12000;

export function getWebPushPublicKey() {
  return String(import.meta.env.VITE_WEB_PUSH_PUBLIC_KEY || "").trim();
}

export function urlBase64ToUint8Array(value) {
  const compactValue = String(value || "").replace(/\s+/g, "");

  if (!compactValue) {
    throw new Error("The Web Push public key is not configured.");
  }

  const unpaddedValue = compactValue.replace(/=+$/, "");
  if (!/^[A-Za-z0-9_-]+$/.test(unpaddedValue)) {
    throw new Error("The Web Push public key is not valid URL-safe Base64.");
  }

  const padding = "=".repeat((4 - (unpaddedValue.length % 4)) % 4);
  const base64 = `${unpaddedValue}${padding}`
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  let decoded;
  try {
    decoded = window.atob(base64);
  } catch {
    throw new Error("The Web Push public key could not be decoded.");
  }

  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytes.length !== 65 || bytes[0] !== 4) {
    throw new Error("The Web Push public key must be an uncompressed P-256 public key.");
  }

  return bytes;
}

export function getPushFeatureSupport() {
  const browserAvailable =
    typeof window !== "undefined" && typeof navigator !== "undefined";
  const secureContext = browserAvailable && window.isSecureContext === true;
  const supported =
    browserAvailable &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  return {
    secureContext,
    supported,
    permission: supported ? window.Notification.permission : "unsupported",
  };
}

export async function getPatientServiceWorkerRegistration() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service workers are not supported by this browser.");
  }

  const existingRegistration =
    await navigator.serviceWorker.getRegistration(patientServiceWorkerScope);

  if (existingRegistration?.active) {
    return existingRegistration;
  }

  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(
      () => reject(new Error("The Patient service worker is not ready.")),
      serviceWorkerReadyTimeoutMs
    );
  });

  try {
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      timeout,
    ]);

    if (!registration?.active) {
      throw new Error("The Patient service worker is not active.");
    }

    return registration;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export function getPushSubscriptionPayload(subscription) {
  const json = subscription?.toJSON?.();
  const endpoint = String(subscription?.endpoint || json?.endpoint || "").trim();
  const p256dh = String(json?.keys?.p256dh || "").trim();
  const authKey = String(json?.keys?.auth || "").trim();

  if (!endpoint.startsWith("https://")) {
    throw new Error("The browser did not return a valid HTTPS push endpoint.");
  }

  if (!p256dh || !authKey) {
    throw new Error("The browser did not return complete push subscription keys.");
  }

  return {
    endpoint,
    expirationTime: subscription.expirationTime ?? json?.expirationTime ?? null,
    p256dh,
    authKey,
  };
}

export function getSafeDeviceLabel() {
  const userAgent = String(navigator.userAgent || "");
  const platform = String(navigator.platform || "");

  if (isIosOrIpadOs()) {
    return /iPad/i.test(userAgent) || platform === "MacIntel"
      ? "Maternal Care on iPad"
      : "Maternal Care on iPhone";
  }

  if (/Android/i.test(userAgent)) return "Maternal Care on Android";
  if (/Windows/i.test(userAgent)) return "Maternal Care on Windows";
  if (/Mac/i.test(platform)) return "Maternal Care on Mac";
  if (/Linux/i.test(platform)) return "Maternal Care on Linux";
  return "Maternal Care browser";
}

export function isIosOrIpadOs() {
  if (typeof navigator === "undefined") return false;

  return (
    /iPad|iPhone|iPod/i.test(navigator.userAgent || "") ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export function isStandalonePwa() {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }

  return (
    window.matchMedia?.("(display-mode: standalone)")?.matches === true ||
    window.matchMedia?.("(display-mode: fullscreen)")?.matches === true ||
    navigator.standalone === true
  );
}
