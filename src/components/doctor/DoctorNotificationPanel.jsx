import { forwardRef } from "react";
import { Icon } from "@iconify/react";
import {
  formatDoctorNotificationTime,
  getDoctorNotificationPresentation,
} from "../../lib/doctorNotifications";
import DoctorPushNotificationControl from "./DoctorPushNotificationControl";

function formatFullManilaDateTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "Time unavailable";

  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function NotificationSkeleton() {
  return (
    <div className="doctor-notification-skeleton" aria-hidden="true">
      <span />
      <div><span /><span /></div>
    </div>
  );
}

const DoctorNotificationPanel = forwardRef(function DoctorNotificationPanel(
  {
    id,
    notifications,
    unreadCount,
    loading,
    updating,
    error,
    onRetry,
    onClose,
    onMarkAllAsRead,
    onSelect,
  },
  ref
) {
  return (
    <section
      ref={ref}
      id={id}
      className="doctor-notification-panel"
      role="dialog"
      aria-label="Doctor notifications"
      aria-busy={loading || updating}
    >
      <header className="doctor-notification-panel-header">
        <div>
          <h2>Notifications</h2>
          <p>{unreadCount ? `${unreadCount} unread` : "You're all caught up"}</p>
        </div>
        <div className="doctor-notification-panel-actions">
          <button
            type="button"
            className="doctor-notification-mark-all"
            onClick={onMarkAllAsRead}
            disabled={!unreadCount || updating}
          >
            Mark all as read
          </button>
          <button
            type="button"
            className="doctor-notification-close"
            onClick={onClose}
            aria-label="Close notifications"
            title="Close notifications"
          >
            <Icon icon="solar:close-circle-linear" aria-hidden="true" />
          </button>
        </div>
      </header>

      <DoctorPushNotificationControl />

      {error ? (
        <div className="doctor-notification-error" role="status">
          <Icon icon="solar:danger-triangle-bold" aria-hidden="true" />
          <span>{error}</span>
          <button type="button" onClick={onRetry}>Retry</button>
        </div>
      ) : null}

      <div className="doctor-notification-list">
        {loading ? (
          <>
            <NotificationSkeleton />
            <NotificationSkeleton />
            <NotificationSkeleton />
          </>
        ) : null}

        {!loading && !notifications.length ? (
          <div className="doctor-notification-empty">
            <Icon icon="solar:bell-off-linear" aria-hidden="true" />
            <h3>No notifications yet</h3>
            <p>Medication follow-up alerts assigned to you will appear here.</p>
          </div>
        ) : null}

        {!loading
          ? notifications.map((notification) => {
              const presentation = getDoctorNotificationPresentation(
                notification.notification_type
              );
              const unread = !notification.read_at;
              const fullDateTime = formatFullManilaDateTime(
                notification.created_at
              );

              return (
                <button
                  key={notification.id}
                  type="button"
                  className={`doctor-notification-item${unread ? " is-unread" : ""}`}
                  onClick={() => onSelect(notification)}
                  disabled={updating}
                  aria-label={`${notification.title}. ${presentation.label}. ${notification.message}. ${fullDateTime}`}
                >
                  <span
                    className={`doctor-notification-icon type-${notification.notification_type}`}
                    aria-hidden="true"
                  >
                    <Icon icon={presentation.icon} />
                  </span>
                  <span className="doctor-notification-copy">
                    <span className="doctor-notification-title-row">
                      <strong>{notification.title}</strong>
                      {unread ? <i aria-label="Unread" /> : null}
                    </span>
                    <span className="doctor-notification-message">
                      {notification.message}
                    </span>
                    <span className="doctor-notification-meta">
                      <time
                        dateTime={notification.created_at}
                        title={`${fullDateTime} Asia/Manila`}
                      >
                        {formatDoctorNotificationTime(notification.created_at)}
                      </time>
                      <em className={`priority-${notification.priority}`}>
                        {notification.priority}
                      </em>
                      <span>{presentation.label}</span>
                    </span>
                  </span>
                </button>
              );
            })
          : null}
      </div>
    </section>
  );
});

export default DoctorNotificationPanel;
