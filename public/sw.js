const CACHE_NAME = "maternal-care-patient-shell-v10";
const DEV_HOST_PATTERNS = [
  /^localhost$/,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];
const IS_DEV_HOST = DEV_HOST_PATTERNS.some((pattern) => pattern.test(self.location.hostname));
const APP_SHELL = [
  "/patient/access",
  "/patient/create-account",
  "/patient/login",
  "/patient/",
  "/patient/dashboard",
  "/patient/medical-record",
  "/patient/medical-records",
  "/patient/appointments",
  "/patient/reminders",
  "/patient/reminders/medications",
  "/patient/profile",
  "/patient/settings",
  "/index.html",
  "/manifest.webmanifest",
  "/icons/maternal-care-icon-32.png",
  "/icons/maternal-care-icon-48.png",
  "/icons/maternal-care-icon-192.png",
  "/icons/maternal-care-icon-512.png",
  "/icons/maternal-care-favicon.png",
  "/images/maternal-care-logo.png",
  "/images/dashboard-hero-people.png",
  "/images/maria-makiling-profile.svg"
];
const DEFAULT_NOTIFICATION_URL = "/patient/reminders";
const ALLOWED_PATIENT_NOTIFICATION_ROUTES = new Set([
  "/patient/dashboard",
  "/patient/appointments",
  "/patient/reminders",
  "/patient/reminders/medications",
  "/patient/medical-records",
  "/patient/profile",
  "/patient/settings",
]);

function getSafeNotificationText(value, fallback, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, maxLength);
}

function getAllowedPatientNotificationUrl(value) {
  if (typeof value !== "string") {
    return DEFAULT_NOTIFICATION_URL;
  }

  try {
    const url = new URL(value, self.location.origin);
    if (
      url.origin !== self.location.origin ||
      !ALLOWED_PATIENT_NOTIFICATION_ROUTES.has(url.pathname)
    ) {
      return DEFAULT_NOTIFICATION_URL;
    }

    return url.pathname;
  } catch {
    return DEFAULT_NOTIFICATION_URL;
  }
}

function getSafeNotificationPayload(payload) {
  const data = payload && typeof payload === "object" ? payload : {};
  const targetUrl = getAllowedPatientNotificationUrl(
    data.type === "medication_reminder"
      ? "/patient/reminders/medications"
      : data.url
  );
  const notificationId =
    typeof data.notificationId === "string"
      ? data.notificationId.trim().slice(0, 128)
      : "";
  const suppliedTag =
    typeof data.tag === "string" ? data.tag.trim().slice(0, 128) : "";

  return {
    audience: "patient",
    notificationId,
    title: getSafeNotificationText(data.title, "Maternal Care", 80),
    body: getSafeNotificationText(
      data.body,
      "You have a new notification. Tap to view it securely.",
      180
    ),
    url: targetUrl,
    tag:
      suppliedTag ||
      `patient-notification-${notificationId || `${Date.now()}-${Math.random()}`}`,
  };
}

self.addEventListener("install", (event) => {
  if (IS_DEV_HOST) {
    event.waitUntil(self.skipWaiting());
    return;
  }

  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  if (IS_DEV_HOST) {
    event.waitUntil(
      caches
        .keys()
        .then((cacheNames) => Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName))))
        .then(() => self.clients.claim())
    );
    return;
  }

  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((cacheName) => cacheName !== CACHE_NAME)
            .map((cacheName) => caches.delete(cacheName))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") {
    return;
  }

  const requestUrl = new URL(request.url);

  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  if (IS_DEV_HOST) {
  // During local Vite development, allow the browser to handle
  // same-origin GET requests normally instead of proxying them
  // through the service worker.
  return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put("/index.html", responseClone.clone());
            cache.put(request, responseClone);
          });
          return response;
        })
        .catch(() => caches.match("/index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(request).then((response) => {
        if (!response || response.status !== 200 || response.type !== "basic") {
          return response;
        }

        const responseClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
        return response;
      });
    })
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  if (event.data?.type !== "MATERNAL_SHOW_NOTIFICATION") {
    return;
  }

  if (event.data.payload?.audience === "doctor") {
    return;
  }

  const payload = getSafeNotificationPayload(event.data.payload);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icons/maternal-care-icon-192.png",
      badge: "/icons/maternal-care-icon-192.png",
      tag: payload.tag,
      data: {
        audience: payload.audience,
        notificationId: payload.notificationId,
        url: payload.url,
      },
    })
  );
});

self.addEventListener("push", (event) => {
  let rawPayload = {};

  if (event.data) {
    try {
      rawPayload = event.data.json();
    } catch {
      rawPayload = {};
    }
  }

  if (rawPayload?.audience === "doctor") {
    return;
  }

  const payload = getSafeNotificationPayload(rawPayload);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icons/maternal-care-icon-192.png",
      badge: "/icons/maternal-care-icon-192.png",
      tag: payload.tag,
      data: {
        audience: payload.audience,
        notificationId: payload.notificationId,
        url: payload.url,
      },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = getAllowedPatientNotificationUrl(event.notification.data?.url);

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clients) => {
        const existingClient = clients.find((client) => {
          try {
            const url = new URL(client.url);
            return (
              url.origin === self.location.origin &&
              url.pathname.startsWith("/patient/")
            );
          } catch {
            return false;
          }
        });

        if (existingClient) {
          const navigatedClient = await existingClient.navigate(targetUrl);
          return (navigatedClient || existingClient).focus();
        }

        return self.clients.openWindow(targetUrl);
      })
  );
});
