import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import SendPatientNotificationModal from "./SendPatientNotificationModal";
import "../../styles/send-patient-notification.css";

export default function SendPatientNotificationAction({
  patientId,
  patientName,
  appointmentId = null,
  medicalRecordId = null,
  reminderId = null,
  defaultType = "general",
  defaultTitle = "",
  defaultMessage = "",
  defaultPriority = "normal",
  lockedType = "",
  hideTypeSelector = false,
  lockedTargetPath = "",
  contextLabel = "",
  contextHelper = "",
  triggerLabel = "Send Notification",
  allowedTypes = null,
  className = "",
  outline = false,
  onSent = null,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [postSendError, setPostSendError] = useState("");
  const openerRef = useRef(null);

  useEffect(() => {
    if (!successMessage) return undefined;
    const timer = window.setTimeout(() => setSuccessMessage(""), 4500);
    return () => window.clearTimeout(timer);
  }, [successMessage]);

  useEffect(() => {
    if (!postSendError) return undefined;
    const timer = window.setTimeout(() => setPostSendError(""), 6500);
    return () => window.clearTimeout(timer);
  }, [postSendError]);

  return (
    <>
      <button
        ref={openerRef}
        type="button"
        className={`send-patient-notification-trigger ${outline ? "is-outline" : ""} ${className}`.trim()}
        disabled={!patientId}
        onClick={() => {
          setPostSendError("");
          setIsOpen(true);
        }}
      >
        <Icon icon="solar:bell-bing-bold" aria-hidden="true" />
        <span>{triggerLabel}</span>
      </button>

      {isOpen ? (
        <SendPatientNotificationModal
          patientId={patientId}
          patientName={patientName}
          appointmentId={appointmentId}
          medicalRecordId={medicalRecordId}
          reminderId={reminderId}
          defaultType={defaultType}
          defaultTitle={defaultTitle}
          defaultMessage={defaultMessage}
          defaultPriority={defaultPriority}
          lockedType={lockedType}
          hideTypeSelector={hideTypeSelector}
          lockedTargetPath={lockedTargetPath}
          contextLabel={contextLabel}
          contextHelper={contextHelper}
          allowedTypes={allowedTypes}
          returnFocusRef={openerRef}
          onClose={() => setIsOpen(false)}
          onSent={(notification) => {
            setSuccessMessage(`Notification sent to ${patientName || "Patient"}.`);
            if (typeof onSent === "function") {
              Promise.resolve(onSent(notification)).catch(() => {
                setPostSendError(
                  "Notification was sent, but related follow-up activity could not be saved."
                );
              });
            }
          }}
        />
      ) : null}

      {successMessage && !postSendError ? (
        <div className="send-patient-notification-toast" role="status">
          <Icon icon="solar:check-circle-bold" aria-hidden="true" />
          {successMessage}
        </div>
      ) : null}

      {postSendError ? (
        <div className="send-patient-notification-toast is-error" role="alert">
          <Icon icon="solar:danger-circle-bold" aria-hidden="true" />
          {postSendError}
        </div>
      ) : null}
    </>
  );
}
