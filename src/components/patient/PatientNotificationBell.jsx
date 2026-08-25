import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { usePatientNotifications } from "../../hooks/usePatientNotifications";
import { getSafePatientNotificationTarget } from "../../lib/patientNotificationRoutes";
import PatientNotificationPanel from "./PatientNotificationPanel";

export default function PatientNotificationBell({ onNavigate }) {
  const wrapperRef = useRef(null);
  const [open, setOpen] = useState(false);
  const {
    notifications,
    unreadCount,
    loading,
    updating,
    error,
    refresh,
    markAsRead,
    markAllAsRead,
  } = usePatientNotifications();

  useEffect(() => {
    const closeOnOutside = (event) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  const handleSelect = async (notification) => {
    if (!notification.read_at) {
      const marked = await markAsRead(notification.id);
      if (!marked) return;
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
        type="button"
        className="pwa-notification-bell"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
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
          notifications={notifications}
          unreadCount={unreadCount}
          loading={loading}
          updating={updating}
          error={error}
          onRetry={refresh}
          onMarkAllAsRead={markAllAsRead}
          onSelect={handleSelect}
        />
      ) : null}
    </div>
  );
}
