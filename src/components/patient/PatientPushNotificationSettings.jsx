import { Icon } from "@iconify/react";
import { usePatientPushNotifications } from "../../hooks/usePatientPushNotifications";
import {
  isIosOrIpadOs,
  isStandalonePwa,
  patientPushStatuses,
} from "../../lib/webPush";
import "../../styles/patient-push-settings.css";

const statusLabels = {
  [patientPushStatuses.subscribed]: "Enabled on this device",
  [patientPushStatuses.insecure]: "HTTPS required",
  [patientPushStatuses.unsupported]: "Not supported by this browser",
  [patientPushStatuses.missingPublicKey]: "Configuration incomplete",
  [patientPushStatuses.permissionDenied]: "Permission blocked",
  [patientPushStatuses.loading]: "Checking...",
  [patientPushStatuses.error]: "Status unavailable",
  [patientPushStatuses.permissionDefault]: "Not enabled",
  [patientPushStatuses.unsubscribed]: "Not enabled",
};

function getPermissionLabel(permission) {
  if (permission === "granted") return "Allowed";
  if (permission === "denied") return "Blocked";
  if (permission === "default") return "Not requested";
  return "Unavailable";
}

export default function PatientPushNotificationSettings() {
  const {
    secureContext,
    supported,
    permission,
    subscribed,
    status,
    loading,
    enabling,
    disabling,
    error,
    message,
    enablePushNotifications,
    disablePushNotifications,
    refreshPushStatus,
  } = usePatientPushNotifications();

  const busy = loading || enabling || disabling;
  const enableUnavailable =
    busy ||
    !secureContext ||
    !supported ||
    permission === "denied" ||
    status === patientPushStatuses.missingPublicKey;
  const showIosInstallGuidance = isIosOrIpadOs() && !isStandalonePwa();

  return (
    <section className="pwa-settings-card patient-push-settings-card">
      <header className="patient-push-settings-header">
        <span className="patient-push-settings-icon" aria-hidden="true">
          <Icon icon="solar:bell-bing-bold-duotone" />
        </span>
        <div>
          <h3>Push Notifications</h3>
          <p>
            Receive appointment and clinic reminders on this device even when
            the Maternal Care PWA is closed.
          </p>
        </div>
        <button
          className="patient-push-refresh"
          type="button"
          onClick={() => refreshPushStatus()}
          disabled={busy}
          aria-label="Refresh push notification status"
          title="Refresh status"
        >
          <Icon icon="solar:refresh-linear" />
        </button>
      </header>

      <div className="patient-push-status-list">
        <div>
          <span>Notification permission</span>
          <strong>{getPermissionLabel(permission)}</strong>
        </div>
        <div>
          <span>Current device status</span>
          <strong className={subscribed ? "is-enabled" : ""}>
            {statusLabels[status] || "Not enabled"}
          </strong>
        </div>
      </div>

      {showIosInstallGuidance ? (
        <p className="patient-push-guidance">
          <Icon icon="solar:smartphone-2-linear" />
          <span>
            To receive push notifications on iPhone or iPad, add Maternal Care
            to the Home Screen, open the installed app, and enable notifications
            there.
          </span>
        </p>
      ) : null}

      {permission === "denied" ? (
        <p className="patient-push-guidance is-warning">
          <Icon icon="solar:danger-triangle-linear" />
          <span>
            Notifications are blocked in your browser. Allow notifications in
            this site&apos;s browser settings, then refresh the status.
          </span>
        </p>
      ) : null}

      <div className="patient-push-feedback" aria-live="polite">
        {error && permission !== "denied" ? <p className="is-error">{error}</p> : null}
        {message ? <p className="is-success">{message}</p> : null}
      </div>

      <div className="patient-push-actions">
        {subscribed ? (
          <button
            className="is-disable"
            type="button"
            onClick={disablePushNotifications}
            disabled={busy}
          >
            <Icon icon="solar:bell-off-linear" />
            {disabling ? "Disabling..." : "Disable Push Notifications"}
          </button>
        ) : (
          <button
            className="is-enable"
            type="button"
            onClick={enablePushNotifications}
            disabled={enableUnavailable}
          >
            <Icon icon="solar:bell-bing-linear" />
            {enabling ? "Enabling..." : "Enable Push Notifications"}
          </button>
        )}
      </div>

      <p className="patient-push-shared-device-note">
        Using a shared device? Disable push notifications before signing out.
      </p>
    </section>
  );
}
