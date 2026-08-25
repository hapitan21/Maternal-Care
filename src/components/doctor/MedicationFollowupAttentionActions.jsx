import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";
import { addMedicationFollowupAttentionControl } from "../../lib/medicationAdherenceFollowupApi";
import {
  formatMedicationFollowupDateTime,
  getMedicationFollowupSnoozeUntil,
} from "../../lib/medicationAdherenceFollowups";
import { getManilaDateKey } from "../../lib/appointmentDate";
import "../../styles/medication-followup-attention.css";

const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const snoozeOptions = [
  { value: "30_minutes", label: "30 minutes" },
  { value: "1_hour", label: "1 hour" },
  { value: "4_hours", label: "4 hours" },
  { value: "tomorrow_morning", label: "Until tomorrow morning" },
  { value: "custom", label: "Custom date and time" },
];

export default function MedicationFollowupAttentionActions({
  item,
  doctorId,
  onChanged,
}) {
  const [action, setAction] = useState("");
  const [note, setNote] = useState("");
  const [snoozeOption, setSnoozeOption] = useState("30_minutes");
  const [customDate, setCustomDate] = useState(() => getManilaDateKey());
  const [customTime, setCustomTime] = useState("08:00");
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);
  const returnFocusRef = useRef(null);
  const savingRef = useRef(false);
  const isAssigned = item.followup.assigned_doctor_id === doctorId;
  const canControl =
    Boolean(doctorId) && isAssigned && item.escalation.requiresAttention;

  useEffect(() => {
    if (!action) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => closeButtonRef.current?.focus());

    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !savingRef.current) {
        event.preventDefault();
        setAction("");
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
      window.requestAnimationFrame(() => returnFocusRef.current?.focus());
    };
  }, [action]);

  if (!canControl) return null;

  const openDialog = (nextAction, trigger) => {
    returnFocusRef.current = trigger;
    setNote("");
    setErrorMessage("");
    setAction(nextAction);
  };

  const closeDialog = () => {
    if (!isSaving) setAction("");
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (savingRef.current) return;

    const snoozedUntil =
      action === "snooze"
        ? getMedicationFollowupSnoozeUntil({
            option: snoozeOption,
            customDate,
            customTime,
          })
        : null;
    if (action === "snooze") {
      const snoozeTime = new Date(snoozedUntil || "").getTime();
      if (!Number.isFinite(snoozeTime) || snoozeTime <= Date.now()) {
        setErrorMessage("Choose a future date and time for the alert snooze.");
        return;
      }
    }

    savingRef.current = true;
    setIsSaving(true);
    setErrorMessage("");
    try {
      await addMedicationFollowupAttentionControl({
        followupId: item.followup.id,
        eventType:
          action === "acknowledge"
            ? "attention_acknowledged"
            : "attention_snoozed",
        note,
        snoozedUntil,
      });
      const success =
        action === "acknowledge"
          ? "Alert acknowledged."
          : `Alert snoozed until ${formatMedicationFollowupDateTime(snoozedUntil)}.`;
      setSuccessMessage(success);
      setAction("");
      await onChanged?.({
        eventType:
          action === "acknowledge"
            ? "attention_acknowledged"
            : "attention_snoozed",
        snoozedUntil,
        message: success,
      });
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "The follow-up attention action could not be saved."
      );
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  return (
    <div className="doctor-followup-control-actions">
      <div>
        <button
          type="button"
          onClick={(event) => openDialog("acknowledge", event.currentTarget)}
        >
          <Icon icon="solar:eye-check-linear" aria-hidden="true" />
          Acknowledge Alert
        </button>
        <button
          type="button"
          onClick={(event) => openDialog("snooze", event.currentTarget)}
        >
          <Icon icon="solar:alarm-sleep-linear" aria-hidden="true" />
          Snooze Alert
        </button>
      </div>

      {successMessage ? (
        <p className="doctor-followup-control-success" role="status" aria-live="polite">
          {successMessage}
        </p>
      ) : null}

      {action
        ? createPortal(
            <div
              className="doctor-followup-control-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) closeDialog();
              }}
            >
              <section
                ref={dialogRef}
                className="doctor-followup-control-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="doctor-followup-control-title"
                aria-describedby="doctor-followup-control-description"
              >
                <header>
                  <div>
                    <h2 id="doctor-followup-control-title">
                      {action === "acknowledge" ? "Acknowledge Alert" : "Snooze Alert"}
                    </h2>
                    <p id="doctor-followup-control-description">
                      {action === "acknowledge"
                        ? "Record that this Doctor follow-up alert has been reviewed."
                        : "Temporarily suppress this alert from the Dashboard and sidebar badge."}
                    </p>
                  </div>
                  <button
                    ref={closeButtonRef}
                    type="button"
                    aria-label="Close attention action"
                    disabled={isSaving}
                    onClick={closeDialog}
                  >
                    <Icon icon="solar:close-circle-linear" aria-hidden="true" />
                  </button>
                </header>

                <form onSubmit={handleSubmit}>
                  <div className="doctor-followup-control-context">
                    <span>Patient</span>
                    <strong>{item.patientName}</strong>
                    <span>Escalation</span>
                    <strong>{item.escalation.label}</strong>
                  </div>

                  {action === "snooze" ? (
                    <>
                      <label>
                        <span>Snooze duration</span>
                        <select
                          value={snoozeOption}
                          disabled={isSaving}
                          onChange={(event) => setSnoozeOption(event.target.value)}
                        >
                          {snoozeOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      {snoozeOption === "custom" ? (
                        <div className="doctor-followup-control-custom-time">
                          <label>
                            <span>Date</span>
                            <input
                              type="date"
                              value={customDate}
                              disabled={isSaving}
                              onChange={(event) => setCustomDate(event.target.value)}
                            />
                          </label>
                          <label>
                            <span>Time</span>
                            <input
                              type="time"
                              value={customTime}
                              disabled={isSaving}
                              onChange={(event) => setCustomTime(event.target.value)}
                            />
                          </label>
                        </div>
                      ) : null}
                    </>
                  ) : null}

                  <label>
                    <span>Optional note</span>
                    <textarea
                      rows="4"
                      maxLength="1000"
                      value={note}
                      disabled={isSaving}
                      onChange={(event) => setNote(event.target.value)}
                    />
                    <small>{note.length} / 1000</small>
                  </label>

                  {errorMessage ? <p className="doctor-followup-control-error" role="alert">{errorMessage}</p> : null}

                  <footer>
                    <button type="button" disabled={isSaving} onClick={closeDialog}>Cancel</button>
                    <button type="submit" className="is-primary" disabled={isSaving}>
                      {isSaving
                        ? action === "acknowledge" ? "Acknowledging..." : "Snoozing..."
                        : action === "acknowledge" ? "Acknowledge Alert" : "Snooze Alert"}
                    </button>
                  </footer>
                </form>
              </section>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
