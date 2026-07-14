const CACHE_NAME = "maternal-care-shell-v4";
const DEV_HOST_PATTERNS = [
  /^localhost$/,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];
const IS_DEV_HOST = DEV_HOST_PATTERNS.some((pattern) => pattern.test(self.location.hostname));
const APP_SHELL = [
  "/",
  "/login",
  "/patient/access",
  "/patient",
  "/patient/appointments",
  "/patient/reminders",
  "/index.html",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/images/maternal-care-logo.png",
  "/images/dashboard-hero-people.png",
  "/images/maria-makiling-profile.svg"
];

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
        .then(() => self.registration.unregister())
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
    event.respondWith(fetch(request, { cache: "no-store" }));
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
  if (event.data?.type !== "MATERNAL_SHOW_NOTIFICATION") {
    return;
  }

  const { title, body, url } = event.data.payload || {};
  event.waitUntil(
    self.registration.showNotification(title || "Maternal Care", {
      body: body || "You have a new patient reminder.",
      icon: "/images/maternal-care-logo.png",
      badge: "/favicon.svg",
      data: { url: url || "/patient/reminders" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/patient/reminders";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        const existingClient = clients.find((client) => client.url.includes("/patient"));

        if (existingClient) {
          existingClient.focus();
          existingClient.navigate(targetUrl);
          return;
        }

        return self.clients.openWindow(targetUrl);
      })
  );
});
