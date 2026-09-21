import { createPortal } from "react-dom";

export default function AppointmentNoShowDialog({
  busy = false,
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
        <h2 id="appointment-no-show-title">Mark patient as No Show?</h2>
        <p>
          This patient did not attend the scheduled appointment. Mark this
          appointment as No Show?
        </p>

        <div className="appointment-no-show-actions">
          <button type="button" className="is-cancel" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="is-confirm" disabled={busy} onClick={onConfirm}>
            {busy ? "Updating..." : "Mark as No Show"}
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}
