import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";
import { useSendPatientNotification } from "../../hooks/useSendPatientNotification";
import {
  PATIENT_NOTIFICATION_PRIORITIES,
  PATIENT_NOTIFICATION_TARGET_LABELS,
  PATIENT_NOTIFICATION_TYPES,
  getPatientNotificationType,
  isAllowedPatientNotificationTarget,
  isAllowedPatientNotificationType,
  isUuid,
} from "../../lib/patientNotificationTypes";

const focusableSelector = [
  "button:not([disabled])",
  "select:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export default function SendPatientNotificationModal({
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
  allowedTypes = null,
  onClose,
  onSent,
  returnFocusRef,
}) {
  const safeLockedType = isAllowedPatientNotificationType(lockedType)
    ? lockedType
    : "";

  const allowedTypeValues = Array.isArray(allowedTypes)
    ? allowedTypes.filter((type) => isAllowedPatientNotificationType(type))
    : null;

  const availableTypes =
    allowedTypeValues?.length
      ? PATIENT_NOTIFICATION_TYPES.filter((type) =>
          allowedTypeValues.includes(type.value)
        )
      : PATIENT_NOTIFICATION_TYPES;

  const defaultTypeIsAvailable =
    isAllowedPatientNotificationType(defaultType) &&
    availableTypes.some((type) => type.value === defaultType);

  const initialType =
    safeLockedType ||
    (defaultTypeIsAvailable
      ? defaultType
      : availableTypes[0]?.value || "general");

  const initialDefinition = getPatientNotificationType(initialType);
  const [selectedType, setSelectedType] = useState(initialType);
  const [title, setTitle] = useState(
    String(defaultTitle || initialDefinition.title)
  );
  const [message, setMessage] = useState(
    String(defaultMessage || initialDefinition.message)
  );
  const [priority, setPriority] = useState(
    PATIENT_NOTIFICATION_PRIORITIES.some(
      (item) => item.value === defaultPriority
    )
      ? defaultPriority
      : "normal"
  );
  const [errorMessage, setErrorMessage] = useState("");
  const dialogRef = useRef(null);
  const typeSelectRef = useRef(null);
  const titleInputRef = useRef(null);
  const isSendingRef = useRef(false);
  const { isSending, sendPatientNotification } = useSendPatientNotification();
  const selectedDefinition = getPatientNotificationType(selectedType);
  const lockedTargetMatchesType =
    Boolean(safeLockedType) &&
    isAllowedPatientNotificationTarget(lockedTargetPath) &&
    getPatientNotificationType(safeLockedType).targetPath === lockedTargetPath;
  const targetPath = lockedTargetMatchesType
    ? lockedTargetPath
    : selectedDefinition.targetPath;
  const typeSelectorHidden = hideTypeSelector || Boolean(safeLockedType);
  const trimmedTitle = title.trim();
  const trimmedMessage = message.trim();

  const isValid = useMemo(
    () =>
      isUuid(patientId) &&
      isAllowedPatientNotificationType(selectedType) &&
      (Boolean(safeLockedType) ||
        availableTypes.some((type) => type.value === selectedType)) &&
      trimmedTitle.length >= 1 &&
      trimmedTitle.length <= 120 &&
      trimmedMessage.length >= 1 &&
      trimmedMessage.length <= 500 &&
      PATIENT_NOTIFICATION_PRIORITIES.some((item) => item.value === priority) &&
      isAllowedPatientNotificationTarget(targetPath),
    [
      availableTypes,
      patientId,
      priority,
      safeLockedType,
      selectedType,
      targetPath,
      trimmedMessage.length,
      trimmedTitle.length,
    ]
  );

  useEffect(() => {
    isSendingRef.current = isSending;
  }, [isSending]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const returnFocusElement = returnFocusRef?.current;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => {
      (typeSelectRef.current || titleInputRef.current)?.focus();
    });

    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !isSendingRef.current) {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll(focusableSelector)
      );
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => returnFocusElement?.focus());
    };
  }, [onClose, returnFocusRef]);

  const handleTypeChange = (event) => {
    if (safeLockedType) return;
    const nextType = event.target.value;
    const nextDefinition = getPatientNotificationType(nextType);
    setSelectedType(nextType);
    setTitle(nextDefinition.title);
    setMessage(nextDefinition.message);
    setErrorMessage("");
  };

  const handleBackdropClick = (event) => {
    event.stopPropagation();
    if (event.target === event.currentTarget && !isSending) onClose();
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!isValid || isSending) return;
    setErrorMessage("");

    try {
      const notification = await sendPatientNotification({
        patientId,
        type: selectedType,
        title: trimmedTitle,
        message: trimmedMessage,
        priority,
        targetPath,
        appointmentId,
        medicalRecordId,
        reminderId,
      });
      onSent(notification);
      onClose();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to send notification.");
    }
  };

  return createPortal(
    <div
      className="send-patient-notification-backdrop"
      role="presentation"
      onClick={handleBackdropClick}
    >
      <section
        ref={dialogRef}
        className="send-patient-notification-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="send-patient-notification-title"
        aria-describedby="send-patient-notification-description"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="send-patient-notification-header">
          <div>
            <span className="send-patient-notification-header-icon">
              <Icon icon="solar:bell-bing-bold" aria-hidden="true" />
            </span>
            <div>
              <h2 id="send-patient-notification-title">
                Send Patient Notification
              </h2>
              <p id="send-patient-notification-description">
                Send a privacy-safe in-app message through Maternal Care.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="send-patient-notification-close"
            aria-label="Close notification form"
            disabled={isSending}
            onClick={onClose}
          >
            <Icon icon="solar:close-circle-linear" />
          </button>
        </header>

        <form onSubmit={handleSubmit}>
          <div className="send-patient-notification-patient">
            <span>Patient</span>
            <strong>{patientName || "Selected Patient"}</strong>
          </div>

          {contextLabel ? (
            <section
              className="send-patient-notification-context"
              aria-label={`Notification purpose: ${contextLabel}`}
            >
              <strong>Notification purpose: {contextLabel}</strong>
              {contextHelper ? <p>{contextHelper}</p> : null}
            </section>
          ) : null}

          {!typeSelectorHidden ? (
            <label className="send-patient-notification-field">
              <span>Notification Type</span>
              <select
                ref={typeSelectRef}
                value={selectedType}
                disabled={isSending}
                onChange={handleTypeChange}
              >
                {availableTypes.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="send-patient-notification-field">
            <span>Title</span>
            <input
              ref={titleInputRef}
              type="text"
              maxLength="120"
              value={title}
              disabled={isSending}
              onChange={(event) => {
                setTitle(event.target.value);
                setErrorMessage("");
              }}
            />
            <small>{title.length} / 120</small>
          </label>

          <label className="send-patient-notification-field">
            <span>Message</span>
            <textarea
              rows="4"
              maxLength="500"
              value={message}
              disabled={isSending}
              onChange={(event) => {
                setMessage(event.target.value);
                setErrorMessage("");
              }}
            />
            <small>{message.length} / 500</small>
          </label>

          <fieldset className="send-patient-notification-priority">
            <legend>Priority</legend>
            <div>
              {PATIENT_NOTIFICATION_PRIORITIES.map((item) => (
                <button
                  type="button"
                  key={item.value}
                  className={priority === item.value ? "is-active" : ""}
                  aria-pressed={priority === item.value}
                  disabled={isSending}
                  onClick={() => setPriority(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="send-patient-notification-target">
            <span>Open when tapped</span>
            <strong>
              {PATIENT_NOTIFICATION_TARGET_LABELS[targetPath]}
            </strong>
            <code>{targetPath}</code>
          </div>

          <section
            className={`send-patient-notification-preview is-${priority}`}
            aria-label="Patient notification preview"
          >
            <span className="send-patient-notification-preview-icon">
              <Icon icon={selectedDefinition.icon} aria-hidden="true" />
            </span>
            <div>
              <small>{contextLabel || selectedDefinition.label}</small>
              <strong>{trimmedTitle || "Notification title"}</strong>
              <p>{trimmedMessage || "Notification message"}</p>
            </div>
            <span className="send-patient-notification-preview-priority">
              {priority}
            </span>
          </section>

          {errorMessage ? (
            <p className="send-patient-notification-error" role="alert">
              {errorMessage}
            </p>
          ) : null}

          <footer className="send-patient-notification-actions">
            <button
              type="button"
              className="is-secondary"
              disabled={isSending}
              onClick={onClose}
            >
              Cancel
            </button>
            <button type="submit" className="is-primary" disabled={!isValid || isSending}>
              <Icon icon="solar:bell-bing-bold" aria-hidden="true" />
              {isSending ? "Sending notification..." : "Send Notification"}
            </button>
          </footer>
        </form>
      </section>
    </div>,
    document.body
  );
}
