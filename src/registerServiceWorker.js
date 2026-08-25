export function registerServiceWorker() {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) {
    return;
  }

  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing || !sessionStorage.getItem("maternal-sw-refresh-ready")) {
      return;
    }

    refreshing = true;
    sessionStorage.removeItem("maternal-sw-refresh-ready");
    window.location.reload();
  });

  window.addEventListener("load", () => {
    const patientScope = new URL("/patient/", window.location.origin).href;

    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) =>
        Promise.all(
          registrations
            .filter(
              (registration) =>
                registration.scope !== patientScope &&
                [
                  registration.active,
                  registration.waiting,
                  registration.installing,
                ].some((worker) => worker?.scriptURL?.endsWith("/sw.js"))
            )
            .map((registration) => registration.unregister())
        )
      )
      .then(() => navigator.serviceWorker.register("/sw.js", { scope: "/patient/" }))
      .then((registration) => {
        registration.addEventListener("updatefound", () => {
          const installingWorker = registration.installing;
          if (!installingWorker) return;

          installingWorker.addEventListener("statechange", () => {
            if (
              installingWorker.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              sessionStorage.setItem("maternal-sw-refresh-ready", "1");
              installingWorker.postMessage({ type: "SKIP_WAITING" });
            }
          });
        });
      })
      .catch((error) => {
        console.error("Service worker registration failed:", error);
      });
  });
}

export async function unregisterServiceWorkers({ reloadControlledPage = false } = {}) {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const hadServiceWorker = registrations.length > 0 || Boolean(navigator.serviceWorker.controller);
    await Promise.all(registrations.map((registration) => registration.unregister()));

    if ("caches" in window) {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)));
    }

    if (
      reloadControlledPage &&
      hadServiceWorker &&
      navigator.serviceWorker.controller &&
      !sessionStorage.getItem("maternal-dev-sw-cleaned")
    ) {
      sessionStorage.setItem("maternal-dev-sw-cleaned", "1");
      window.location.reload();
    }
  } catch (error) {
    console.error("Development service worker cleanup failed:", error);
  }
}
