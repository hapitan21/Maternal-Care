import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { usePatientNotifications } from "../../hooks/usePatientNotifications";
import { getSafePatientNotificationTarget } from "../../lib/patientNotificationRoutes";
import PatientNotificationPanel from "./PatientNotificationPanel";

export default function PatientNotificationBell({ onNavigate }) {
  const wrapperRef = useRef(null);
  const bellRef = useRef(null);
  const [open, setOpen] = useState(false);
  const {
    notifications,
    unreadCount,
    loading,
    updating,
    error,
    online,
    refresh,
    markAsRead,
    markAllAsRead,
  } = usePatientNotifications();

  useEffect(() => {
    if (!open) return undefined;

    const closeOnOutside = (event) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        window.requestAnimationFrame(() => bellRef.current?.focus());
      }
    };

    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const closePanel = () => {
    setOpen(false);
    window.requestAnimationFrame(() => {
      wrapperRef.current?.querySelector(".pwa-notification-bell")?.focus();
    });
  };

  const handleSelect = async (notification) => {
    if (!notification.read_at) {
      await markAsRead(notification.id);
    }

    setOpen(false);
    onNavigate(getSafePatientNotificationTarget(notification));
  };

  return (
    <div
      className={`pwa-notification-center ${open ? "is-open" : ""}`}
      ref={wrapperRef}
    >
      <button
        ref={bellRef}
        type="button"
        className="pwa-notification-bell"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls="patient-notification-panel"
        aria-haspopup="dialog"
        aria-label={`Notifications, ${unreadCount} unread`}
        title="Notifications"
      >
        <Icon icon={unreadCount ? "solar:bell-bing-bold" : "solar:bell-linear"} />
        {unreadCount ? (
          <span className="pwa-notification-badge" aria-hidden="true">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <PatientNotificationPanel
          id="patient-notification-panel"
          notifications={notifications}
          unreadCount={unreadCount}
          loading={loading}
          updating={updating}
          error={error}
          online={online}
          onRetry={refresh}
          onMarkAllAsRead={markAllAsRead}
          onSelect={handleSelect}
          onClose={closePanel}
          onOpenSettings={() => {
            setOpen(false);
            onNavigate("/patient/settings");
          }}
        />
      ) : null}
    </div>
  );
}
