export const patientPwaUpdateEvent = "maternal:patient-pwa-update-available";

let pendingPatientPwaUpdate = null;

export function getPendingPatientPwaUpdate() {
  return pendingPatientPwaUpdate;
}

export function activatePatientPwaUpdate(registration = pendingPatientPwaUpdate) {
  const waitingWorker = registration?.waiting;
  if (!waitingWorker) return false;

  sessionStorage.setItem("maternal-sw-refresh-ready", "1");
  waitingWorker.postMessage({ type: "SKIP_WAITING" });
  return true;
}

function announcePatientPwaUpdate(registration) {
  if (!registration?.waiting) return;

  pendingPatientPwaUpdate = registration;
  window.dispatchEvent(
    new CustomEvent(patientPwaUpdateEvent, { detail: registration })
  );
}

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
    pendingPatientPwaUpdate = null;
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
        announcePatientPwaUpdate(registration);

        registration.addEventListener("updatefound", () => {
          const installingWorker = registration.installing;
          if (!installingWorker) return;

          installingWorker.addEventListener("statechange", () => {
            if (
              installingWorker.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              announcePatientPwaUpdate(registration);
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
