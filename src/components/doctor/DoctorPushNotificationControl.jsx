import { Icon } from "@iconify/react";
import { useDoctorPushNotifications } from "../../hooks/useDoctorPushNotifications";
import { pushStatuses } from "../../lib/webPush";

function getStatusCopy(status, subscribed) {
  if (subscribed) return "Push alerts enabled on this device";
  if (status === pushStatuses.permissionDefault) return "Browser permission not requested";
  if (status === pushStatuses.permissionDenied) return "Permission blocked in site settings";
  if (status === pushStatuses.unsupported) return "This browser does not support push alerts";
  if (status === pushStatuses.insecure) return "A secure HTTPS connection is required";
  if (status === pushStatuses.missingPublicKey) return "Push alerts are not configured";
  if (status === pushStatuses.loading) return "Checking this device";
  return "Push alerts are off on this device";
}

export default function DoctorPushNotificationControl() {
  const push = useDoctorPushNotifications();
  const busy = push.loading || push.enabling || push.disabling;
  const unavailable = [
    pushStatuses.unsupported,
    pushStatuses.insecure,
    pushStatuses.missingPublicKey,
    pushStatuses.permissionDenied,
  ].includes(push.status);

  return (
    <div className="doctor-push-control" aria-busy={busy}>
      <span
        className={`doctor-push-control-icon${push.subscribed ? " is-enabled" : ""}`}
        aria-hidden="true"
      >
        <Icon icon={push.subscribed ? "solar:bell-bing-bold" : "solar:bell-linear"} />
      </span>
      <span className="doctor-push-control-copy">
        <strong>{getStatusCopy(push.status, push.subscribed)}</strong>
        <span>Due and overdue follow-up alerts</span>
      </span>
      <span className="doctor-push-control-actions">
        {push.subscribed ? (
          <button
            type="button"
            onClick={push.disablePushNotifications}
            disabled={busy}
            aria-label="Disable push alerts on this device"
          >
            {push.disabling ? "Disabling..." : "Disable"}
          </button>
        ) : null}
        {!push.subscribed && !unavailable && push.status !== pushStatuses.error ? (
          <button
            type="button"
            onClick={push.enablePushNotifications}
            disabled={busy}
            aria-label="Enable push alerts on this device"
          >
            {push.enabling ? "Enabling..." : "Enable push alerts"}
          </button>
        ) : null}
        {!push.subscribed && (push.status === pushStatuses.error || push.status === pushStatuses.permissionDenied) ? (
          <button
            type="button"
            onClick={() => push.refreshPushStatus({ keepMessage: true })}
            disabled={busy}
          >
            Retry
          </button>
        ) : null}
      </span>
      <span className="doctor-push-control-feedback" role="status" aria-live="polite">
        {push.error || push.message}
      </span>
    </div>
  );
}
