import { Icon } from "@iconify/react";
import { getPatientNotificationConfig } from "../../lib/patientNotificationRoutes";

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
  notifications,
  unreadCount,
  loading,
  updating,
  error,
  onRetry,
  onMarkAllAsRead,
  onSelect,
}) {
  return (
    <section
      className="pwa-notification-panel"
      role="dialog"
      aria-label="Patient notifications"
    >
      <header className="pwa-notification-panel-header">
        <div>
          <h2>Notifications</h2>
          <p>{unreadCount ? `${unreadCount} unread` : "You're all caught up"}</p>
        </div>
        <button
          type="button"
          onClick={onMarkAllAsRead}
          disabled={!unreadCount || updating}
        >
          Mark all as read
        </button>
      </header>

      {error ? (
        <div className="pwa-notification-error" role="status">
          <Icon icon="solar:danger-triangle-bold" />
          <span>{error}</span>
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : null}

      <div className="pwa-notification-list">
        {loading ? (
          <>
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
          ? notifications.map((notification) => {
              const config = getPatientNotificationConfig(notification.type);
              const unread = !notification.read_at;

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
                    <span className="pwa-notification-message">
                      {notification.message}
                    </span>
                    <span className="pwa-notification-meta">
                      {formatNotificationTime(notification.created_at)}
                      {notification.priority !== "normal" ? (
                        <em className={`priority-${notification.priority}`}>
                          {notification.priority}
                        </em>
                      ) : null}
                    </span>
                  </span>
                </button>
              );
            })
          : null}
      </div>
    </section>
  );
}
