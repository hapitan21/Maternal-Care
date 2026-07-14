export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.error("Service worker registration failed:", error);
    });
  });
}

export async function unregisterServiceWorkers({ reloadControlledPage = false } = {}) {
  if (!("serviceWorker" in navigator)) {
    return;
  }

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
}
