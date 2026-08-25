import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import {
  activatePatientPwaUpdate,
  getPendingPatientPwaUpdate,
  patientPwaUpdateEvent,
} from "../../registerServiceWorker";

const restoredMessageDurationMs = 4000;

export default function PatientPwaStatus() {
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const [restored, setRestored] = useState(false);
  const [updateRegistration, setUpdateRegistration] = useState(() =>
    getPendingPatientPwaUpdate()
  );
  const restoredTimerRef = useRef(null);
  const wasOfflineRef = useRef(navigator.onLine === false);

  useEffect(() => {
    const clearRestoredTimer = () => {
      if (restoredTimerRef.current) {
        window.clearTimeout(restoredTimerRef.current);
        restoredTimerRef.current = null;
      }
    };

    const handleOffline = () => {
      clearRestoredTimer();
      wasOfflineRef.current = true;
      setRestored(false);
      setOnline(false);
    };

    const handleOnline = () => {
      setOnline(true);

      if (!wasOfflineRef.current) return;
      wasOfflineRef.current = false;
      setRestored(true);
      clearRestoredTimer();
      restoredTimerRef.current = window.setTimeout(() => {
        setRestored(false);
      }, restoredMessageDurationMs);
    };

    const handleUpdate = (event) => {
      setUpdateRegistration(event.detail || getPendingPatientPwaUpdate());
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    window.addEventListener(patientPwaUpdateEvent, handleUpdate);

    return () => {
      clearRestoredTimer();
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener(patientPwaUpdateEvent, handleUpdate);
    };
  }, []);

  const applyUpdate = () => {
    if (activatePatientPwaUpdate(updateRegistration)) {
      setUpdateRegistration(null);
    }
  };

  if (!online) {
    return (
      <aside className="pwa-connectivity-toast is-offline" role="status" aria-live="polite">
        <span aria-hidden="true"><Icon icon="solar:cloud-cross-bold-duotone" /></span>
        <div>
          <strong>You&apos;re offline</strong>
          <small>Previously loaded information remains available. Reconnect before saving changes.</small>
        </div>
      </aside>
    );
  }

  if (updateRegistration) {
    return (
      <aside className="pwa-connectivity-toast is-update" role="status" aria-live="polite">
        <span aria-hidden="true"><Icon icon="solar:refresh-circle-bold-duotone" /></span>
        <div>
          <strong>Maternal Care has an update</strong>
          <small>Refresh when you&apos;re ready to use the latest version.</small>
        </div>
        <button type="button" onClick={applyUpdate}>Refresh now</button>
        <button
          type="button"
          className="is-dismiss"
          onClick={() => setUpdateRegistration(null)}
          aria-label="Dismiss update message"
        >
          <Icon icon="solar:close-circle-linear" />
        </button>
      </aside>
    );
  }

  if (restored) {
    return (
      <aside className="pwa-connectivity-toast is-online" role="status" aria-live="polite">
        <span aria-hidden="true"><Icon icon="solar:cloud-check-bold-duotone" /></span>
        <div>
          <strong>Back online</strong>
          <small>Your live care updates are connected again.</small>
        </div>
      </aside>
    );
  }

  return null;
}
