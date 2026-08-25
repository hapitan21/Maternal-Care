import React from "react";
import { Icon } from "@iconify/react";
import "../../styles/adminAccountStatusDialog.css";

function cleanText(value) {
  return String(value ?? "").trim();
}

function titleCase(value) {
  const text = cleanText(value).replaceAll("_", " ").toLowerCase();
  return text ? text.replace(/\b\w/g, (character) => character.toUpperCase()) : "Account";
}

function initials(name) {
  return cleanText(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "UM";
}

export default function AdminAccountStatusDialog({
  state,
  saving,
  error,
  onCancel,
  onConfirm,
  activateLabel = "Reactivate",
  title = "",
  description = "",
  question = "",
  statusLabel = "",
  showClose = false,
}) {
  const dialogRef = React.useRef(null);
  const cancelRef = React.useRef(null);
  const isDeactivate = state.action === "deactivate";
  const actionLabel = isDeactivate ? "Deactivate" : activateLabel;
  const normalizedStatus = cleanText(statusLabel).toLowerCase().replaceAll("_", "-");

  React.useEffect(() => {
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.setTimeout(() => cancelRef.current?.focus(), 0);

    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !saving) onCancel();
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = [...dialogRef.current.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )];
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

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = priorOverflow;
    };
  }, [onCancel, saving]);

  const accountName = cleanText(state.account?.name) || `Selected ${state.type}`;
  const avatarUrl = cleanText(state.account?.avatarUrl);
  const resolvedTitle = cleanText(title) || `${actionLabel} Account`;
  const resolvedDescription = cleanText(description) || (isDeactivate
    ? `This will prevent this ${state.type} from signing in. Their records and history will remain available.`
    : `This will restore this ${state.type}'s login access.`);
  const resolvedQuestion = cleanText(question) || `Confirm ${actionLabel.toLowerCase()} for ${accountName}?`;

  return (
    <div
      className={`admin-account-dialog-backdrop${statusLabel ? " is-profile-action" : ""}`}
      onMouseDown={(event) => event.target === event.currentTarget && !saving && onCancel()}
    >
      <section
        ref={dialogRef}
        className={`admin-account-dialog${statusLabel ? " is-profile-action" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-account-dialog-title"
      >
        <header className="admin-account-dialog-header">
          <h2 id="admin-account-dialog-title">{resolvedTitle}</h2>
          {showClose ? (
            <button type="button" disabled={saving} onClick={onCancel} aria-label="Close confirmation dialog">
              <Icon icon="solar:close-circle-linear" aria-hidden="true" />
            </button>
          ) : null}
        </header>
        <div className="admin-account-dialog-person">
          <span className="admin-account-dialog-avatar" aria-hidden="true">
            {avatarUrl ? <img src={avatarUrl} alt="" /> : initials(accountName)}
          </span>
          <div>
            <strong>{accountName}</strong>
            {statusLabel ? (
              <small className={`admin-account-dialog-status is-${normalizedStatus}`}>{cleanText(statusLabel)}</small>
            ) : (
              <small>{titleCase(state.type)}</small>
            )}
          </div>
        </div>
        <p className="admin-account-dialog-description">{resolvedDescription}</p>
        <p className="admin-account-dialog-question">
          {resolvedQuestion}
        </p>
        {error ? <div className="admin-account-dialog-error" role="alert">{error}</div> : null}
        <div className="admin-account-dialog-actions">
          <button ref={cancelRef} type="button" disabled={saving} onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className={isDeactivate ? "is-danger" : "is-success"}
            disabled={saving}
            onClick={onConfirm}
          >
            {saving ? "Saving…" : `${actionLabel} Account`}
          </button>
        </div>
      </section>
    </div>
  );
}
