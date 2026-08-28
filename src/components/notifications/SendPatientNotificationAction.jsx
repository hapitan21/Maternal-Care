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
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const openerRef = useRef(null);

  useEffect(() => {
    if (!successMessage) return undefined;
    const timer = window.setTimeout(() => setSuccessMessage(""), 4500);
    return () => window.clearTimeout(timer);
  }, [successMessage]);

  return (
    <>
      <button
        ref={openerRef}
        type="button"
        className={`send-patient-notification-trigger ${outline ? "is-outline" : ""} ${className}`.trim()}
        disabled={!patientId}
        onClick={() => setIsOpen(true)}
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
          onSent={() => {
            setSuccessMessage(`Notification sent to ${patientName || "Patient"}.`);
          }}
        />
      ) : null}

      {successMessage ? (
        <div className="send-patient-notification-toast" role="status">
          <Icon icon="solar:check-circle-bold" aria-hidden="true" />
          {successMessage}
        </div>
      ) : null}

    </>
  );
}
