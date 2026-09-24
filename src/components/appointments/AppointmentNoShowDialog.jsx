import { createPortal } from "react-dom";

export default function AppointmentNoShowDialog({
  busy = false,
  error = "",
  onCancel,
  onConfirm,
  open,
}) {
  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="appointment-no-show-overlay">
      <section
        className="appointment-no-show-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="appointment-no-show-title"
      >
        <button
          type="button"
          className="appointment-no-show-close"
          aria-label="Close No Show confirmation"
          disabled={busy}
          onClick={onCancel}
        >
          <span aria-hidden="true">&times;</span>
        </button>

        <h2 id="appointment-no-show-title">Mark patient as No Show?</h2>
        <p>
          This patient did not attend the scheduled appointment. Mark this
          appointment as No Show?
        </p>

        {error ? (
          <p className="appointment-no-show-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="appointment-no-show-actions">
          <button type="button" className="is-cancel" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="is-confirm" disabled={busy} onClick={onConfirm}>
            {busy ? "Marking..." : "Mark as No Show"}
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}
