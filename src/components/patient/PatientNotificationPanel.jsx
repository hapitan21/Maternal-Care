import { Icon } from "@iconify/react";
import {
  getPatientNotificationConfig,
  getSafePatientNotificationTarget,
} from "../../lib/patientNotificationRoutes";

function formatNotificationTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const elapsedSeconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (elapsedSeconds < 60) return "Just now";

  const elapsedMinutes = Math.round(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;

  const elapsedDays = Math.round(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d ago`;

  return date.toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

const destinationLabels = {
  "/patient/dashboard": "Open dashboard",
  "/patient/appointments": "View appointments",
  "/patient/reminders": "View reminders",
  "/patient/reminders/medications": "View medication schedule",
  "/patient/medical-records": "View medical records",
  "/patient/profile": "View profile",
  "/patient/settings": "Open settings",
};

function groupNotifications(notifications) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - 6);

  const groups = [
    { key: "today", label: "Today", rows: [] },
    { key: "week", label: "Earlier this week", rows: [] },
    { key: "earlier", label: "Earlier", rows: [] },
  ];

  notifications.forEach((notification) => {
    const createdAt = new Date(notification.created_at);
    const timestamp = Number.isNaN(createdAt.getTime()) ? 0 : createdAt.getTime();

    if (timestamp >= today.getTime()) {
      groups[0].rows.push(notification);
    } else if (timestamp >= weekStart.getTime()) {
      groups[1].rows.push(notification);
    } else {
      groups[2].rows.push(notification);
    }
  });

  return groups.filter((group) => group.rows.length);
}

function NotificationSkeleton() {
  return (
    <div className="pwa-notification-skeleton" aria-hidden="true">
      <span />
      <div>
        <span />
        <span />
      </div>
    </div>
  );
}

export default function PatientNotificationPanel({
  id,
  notifications,
  unreadCount,
  loading,
  updating,
  error,
  online,
  onRetry,
  onMarkAllAsRead,
  onSelect,
  onClose,
  onOpenSettings,
}) {
  const groups = groupNotifications(notifications);

  return (
    <section
      id={id}
      className="pwa-notification-panel"
      role="dialog"
      aria-label="Patient notifications"
      aria-busy={loading || updating}
    >
      <header className="pwa-notification-panel-header">
        <span className="pwa-notification-panel-icon" aria-hidden="true">
          <Icon icon="solar:bell-bing-bold-duotone" />
        </span>
        <div className="pwa-notification-panel-heading">
          <h2>Notifications</h2>
          <p>{unreadCount ? `${unreadCount} unread` : "You're all caught up"}</p>
        </div>
        <div className="pwa-notification-header-actions">
          {unreadCount ? (
            <button
              type="button"
              className="is-mark-all"
              onClick={onMarkAllAsRead}
              disabled={updating || !online}
            >
              <Icon icon="solar:check-read-linear" />
              Mark all read
            </button>
          ) : null}
          <button
            type="button"
            className="is-close"
            onClick={onClose}
            aria-label="Close notifications"
            autoFocus
          >
            <Icon icon="solar:close-circle-linear" />
          </button>
        </div>
      </header>

      {error ? (
        <div className="pwa-notification-error" role="alert">
          <Icon icon={online ? "solar:danger-triangle-bold" : "solar:cloud-cross-bold"} />
          <span>{error}</span>
          {online ? (
            <button type="button" onClick={onRetry}>Try again</button>
          ) : (
            <em>Offline</em>
          )}
        </div>
      ) : null}

      <div className="pwa-notification-list">
        {loading ? (
          <>
            <span className="app-sr-only" role="status">Loading Patient notifications...</span>
            <NotificationSkeleton />
            <NotificationSkeleton />
            <NotificationSkeleton />
          </>
        ) : null}

        {!loading && !notifications.length ? (
          <div className="pwa-notification-empty">
            <span>
              <Icon icon="solar:bell-off-bold" />
            </span>
            <h3>No notifications yet</h3>
            <p>Updates from your care team will appear here.</p>
          </div>
        ) : null}

        {!loading
          ? groups.map((group) => (
              <section className="pwa-notification-group" key={group.key} aria-labelledby={`notification-group-${group.key}`}>
                <h3 id={`notification-group-${group.key}`}>{group.label}</h3>
                {group.rows.map((notification) => {
                  const config = getPatientNotificationConfig(notification.type);
                  const unread = !notification.read_at;
                  const targetPath = getSafePatientNotificationTarget(notification);
                  const destination = destinationLabels[targetPath] || "View update";

                  return (
                    <button
                      key={notification.id}
                      type="button"
                      className={`pwa-notification-item ${unread ? "is-unread" : ""}`}
                      onClick={() => onSelect(notification)}
                      disabled={updating}
                    >
                      <span className={`pwa-notification-icon type-${notification.type}`}>
                        <Icon icon={config.icon} />
                      </span>
                      <span className="pwa-notification-copy">
                        <span className="pwa-notification-title-row">
                          <strong>{notification.title}</strong>
                          {unread ? <i aria-label="Unread" /> : null}
                        </span>
                        <span className="pwa-notification-message">{notification.message}</span>
                        <span className="pwa-notification-meta">
                          <span>{formatNotificationTime(notification.created_at)}</span>
                          {notification.priority !== "normal" ? (
                            <em className={`priority-${notification.priority}`}>{notification.priority}</em>
                          ) : null}
                          <span className="pwa-notification-destination">
                            {destination}<Icon icon="solar:alt-arrow-right-linear" />
                          </span>
                        </span>
                      </span>
                    </button>
                  );
                })}
              </section>
            ))
          : null}
      </div>

      <footer className="pwa-notification-panel-footer">
        <button type="button" onClick={onOpenSettings}>
          <Icon icon="solar:settings-linear" />
          Notification settings
          <Icon icon="solar:alt-arrow-right-linear" />
        </button>
      </footer>
    </section>
  );
}
