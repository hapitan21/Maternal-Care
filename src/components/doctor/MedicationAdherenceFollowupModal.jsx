import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";
import SendPatientNotificationAction from "../notifications/SendPatientNotificationAction";
import {
  addMedicationAdherenceFollowupEvent,
  loadMedicationAdherenceFollowup,
  loadMedicationAdherenceFollowupEvents,
  startMedicationAdherenceFollowup,
  updateMedicationAdherenceFollowupStatus,
} from "../../lib/medicationAdherenceFollowupApi";
import {
  MEDICATION_ADHERENCE_FOLLOWUP_CONTACT_METHODS,
  canTransitionMedicationAdherenceFollowup,
  formatMedicationFollowupContactMethod,
  formatMedicationFollowupDate,
  formatMedicationFollowupDateInput,
  formatMedicationFollowupDateTime,
  formatMedicationFollowupEventLabel,
  formatMedicationFollowupRate,
  formatMedicationFollowupSeverity,
  formatMedicationFollowupStatus,
  getMedicationFollowupDateTimeIso,
  getMedicationFollowupNotificationId,
  validateMedicationAdherenceFollowupResolution,
} from "../../lib/medicationAdherenceFollowups";
import {
  MEDICATION_ADHERENCE_FOLLOWUP_NOTIFICATION_CONTEXT,
  getMedicationAdherenceAlertDateRange,
} from "../../lib/medicationAdherence";
import "../../styles/medication-adherence-followups.css";

const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const actionTitles = {
  note: "Add Follow-up Note",
  contact_attempt: "Record Contact Attempt",
  contacted: "Mark Patient Contacted",
  monitoring: "Set Follow-up to Monitoring",
  schedule: "Schedule Follow-up",
  resolve: "Resolve Follow-up",
};

function getAssignedDoctorName(followup, fallback) {
  const joined = Array.isArray(followup?.assigned_doctor)
    ? followup.assigned_doctor[0]
    : followup?.assigned_doctor;
  return joined?.full_name || fallback || "Assigned Doctor";
}

function FollowupSummary({ followup, liveAlert }) {
  const liveSeverity = liveAlert?.severity || "normal";
  const liveSeverityLabel = liveAlert?.severityLabel || "Normal";
  const hasLiveAdherence = Boolean(liveAlert);

  return (
    <div className="maf-summary-grid">
      <section aria-labelledby="maf-original-summary">
        <h3 id="maf-original-summary">Adherence alert</h3>
        <dl>
          <div><dt>Alert severity</dt><dd>{formatMedicationFollowupSeverity(followup.severity_snapshot)}</dd></div>
          <div><dt>Adherence rate</dt><dd>{formatMedicationFollowupRate(followup.adherence_rate_snapshot)}</dd></div>
          <div><dt>Missed doses</dt><dd>{followup.missed_count_snapshot}</dd></div>
          <div><dt>Consecutive missed doses</dt><dd>{followup.maximum_missed_streak_snapshot}</dd></div>
          <div>
            <dt>Analysis period</dt>
            <dd>
              {formatMedicationFollowupDate(followup.analysis_window_start)} -{" "}
              {formatMedicationFollowupDate(followup.analysis_window_end)}
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="maf-live-summary">
        <h3 id="maf-live-summary">Follow-up plan</h3>
        <dl>
          {hasLiveAdherence ? (
            <>
              <div>
                <dt>Current severity</dt>
                <dd><span className={`maf-severity is-${liveSeverity}`}>{liveSeverityLabel}</span></dd>
              </div>
              <div><dt>Current adherence</dt><dd>{formatMedicationFollowupRate(liveAlert?.adherenceRate)}</dd></div>
            </>
          ) : null}
          <div><dt>Case created</dt><dd>{formatMedicationFollowupDate(followup.created_at)}</dd></div>
          <div><dt>Last contacted</dt><dd>{formatMedicationFollowupDateTime(followup.last_contacted_at, "Not recorded")}</dd></div>
          <div><dt>Next action</dt><dd>{formatMedicationFollowupDateTime(followup.next_follow_up_at, "Not scheduled")}</dd></div>
        </dl>
      </section>
    </div>
  );
}

function StartFollowupForm({
  patient,
  alert,
  isSaving,
  errorMessage,
  onCancel,
  onSubmit,
}) {
  const [initialNote, setInitialNote] = useState("");
  const [nextDate, setNextDate] = useState("");
  const [nextTime, setNextTime] = useState("");
  const dateRange = getMedicationAdherenceAlertDateRange();

  const handleSubmit = (event) => {
    event.preventDefault();
    onSubmit({
      initialNote,
      nextFollowUpAt: getMedicationFollowupDateTimeIso(nextDate, nextTime),
      dateRange,
    });
  };

  return (
    <form className="maf-form" onSubmit={handleSubmit}>
      <section className="maf-start-summary" aria-label="Medication adherence alert summary">
        <div><span>Patient</span><strong>{patient?.full_name || "Patient"}</strong></div>
        <div><span>Severity</span><strong>{alert?.severityLabel}</strong></div>
        <div><span>Adherence rate</span><strong>{alert?.adherenceRate ?? 0}%</strong></div>
        <div><span>Taken</span><strong>{alert?.takenCount ?? 0}</strong></div>
        <div><span>Skipped</span><strong>{alert?.skippedCount ?? 0}</strong></div>
        <div><span>Missed</span><strong>{alert?.missedCount ?? 0}</strong></div>
        <div><span>Consecutive missed</span><strong>{alert?.maximumMissedStreak ?? 0}</strong></div>
        <div>
          <span>Analysis period</span>
          <strong>
            {formatMedicationFollowupDate(dateRange.startDate)} -{" "}
            {formatMedicationFollowupDate(dateRange.endDate)}
          </strong>
        </div>
      </section>

      <label>
        <span>Initial note</span>
        <textarea
          rows="4"
          maxLength="2000"
          required
          value={initialNote}
          disabled={isSaving}
          onChange={(event) => setInitialNote(event.target.value)}
        />
        <small>{initialNote.length} / 2000</small>
      </label>

      <fieldset className="maf-date-fields">
        <legend>Next follow-up (optional)</legend>
        <label>
          <span>Date</span>
          <input
            type="date"
            min={formatMedicationFollowupDateInput()}
            value={nextDate}
            disabled={isSaving}
            onChange={(event) => setNextDate(event.target.value)}
          />
        </label>
        <label>
          <span>Time</span>
          <input
            type="time"
            value={nextTime}
            disabled={isSaving}
            onChange={(event) => setNextTime(event.target.value)}
          />
        </label>
      </fieldset>

      {errorMessage ? <p className="maf-error" role="alert">{errorMessage}</p> : null}

      <footer className="maf-footer">
        <button type="button" onClick={onCancel} disabled={isSaving}>Cancel</button>
        <button
          type="submit"
          className="is-primary"
          disabled={
            isSaving ||
            !initialNote.trim() ||
            Boolean(nextDate) !== Boolean(nextTime)
          }
        >
          {isSaving ? "Starting follow-up..." : "Start Follow-up"}
        </button>
      </footer>
    </form>
  );
}

function FollowupActionForm({
  action,
  followup,
  isSaving,
  errorMessage,
  onCancel,
  onSubmit,
}) {
  const [note, setNote] = useState("");
  const [contactMethod, setContactMethod] = useState("phone");
  const [nextDate, setNextDate] = useState("");
  const [nextTime, setNextTime] = useState("");
  const [resolutionSummary, setResolutionSummary] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const needsContactMethod = ["contact_attempt", "contacted"].includes(action);
  const hasOptionalSchedule = action === "contacted";
  const needsSchedule = action === "schedule";
  const needsNote = action === "note";

  const handleSubmit = (event) => {
    event.preventDefault();
    const nextFollowUpAt =
      nextDate || nextTime
        ? getMedicationFollowupDateTimeIso(nextDate, nextTime)
        : null;
    onSubmit({
      note,
      contactMethod: needsContactMethod ? contactMethod : null,
      nextFollowUpAt,
      resolutionSummary,
    });
  };

  const resolutionError =
    action === "resolve"
      ? validateMedicationAdherenceFollowupResolution(followup, resolutionSummary)
      : "";
  const scheduleInvalid =
    (needsSchedule || hasOptionalSchedule) &&
    Boolean(nextDate) !== Boolean(nextTime);
  const isInvalid =
    (needsNote && !note.trim()) ||
    (needsSchedule && (!nextDate || !nextTime)) ||
    scheduleInvalid ||
    (action === "resolve" && (Boolean(resolutionError) || !confirmed));

  return (
    <form className="maf-form maf-action-form" onSubmit={handleSubmit}>
      {needsContactMethod ? (
        <label>
          <span>Contact method</span>
          <select
            value={contactMethod}
            disabled={isSaving}
            onChange={(event) => setContactMethod(event.target.value)}
          >
            {MEDICATION_ADHERENCE_FOLLOWUP_CONTACT_METHODS
              .filter((method) => method.value !== "in_app_notification")
              .map((method) => (
                <option key={method.value} value={method.value}>{method.label}</option>
              ))}
          </select>
        </label>
      ) : null}

      {action === "resolve" ? (
        <label>
          <span>Resolution summary</span>
          <textarea
            rows="4"
            maxLength="2000"
            required
            value={resolutionSummary}
            disabled={isSaving}
            onChange={(event) => setResolutionSummary(event.target.value)}
          />
          <small>{resolutionSummary.length} / 2000</small>
        </label>
      ) : null}

      <label>
        <span>
          {action === "resolve" ? "Final note (optional)" : needsNote ? "Note" : "Note (optional)"}
        </span>
        <textarea
          rows="4"
          maxLength="2000"
          required={needsNote}
          value={note}
          disabled={isSaving}
          onChange={(event) => setNote(event.target.value)}
        />
        <small>{note.length} / 2000</small>
      </label>

      {needsSchedule || hasOptionalSchedule ? (
        <fieldset className="maf-date-fields">
          <legend>{needsSchedule ? "Next follow-up" : "Next follow-up (optional)"}</legend>
          <label>
            <span>Date</span>
            <input
              type="date"
              min={formatMedicationFollowupDateInput()}
              required={needsSchedule}
              value={nextDate}
              disabled={isSaving}
              onChange={(event) => setNextDate(event.target.value)}
            />
          </label>
          <label>
            <span>Time</span>
            <input
              type="time"
              required={needsSchedule}
              value={nextTime}
              disabled={isSaving}
              onChange={(event) => setNextTime(event.target.value)}
            />
          </label>
        </fieldset>
      ) : null}

      {action === "resolve" ? (
        <label className="maf-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={isSaving}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>I confirm this follow-up is ready to be resolved.</span>
        </label>
      ) : null}

      {errorMessage ? <p className="maf-error" role="alert">{errorMessage}</p> : null}

      <footer className="maf-footer">
        <button type="button" onClick={onCancel} disabled={isSaving}>Cancel</button>
        <button type="submit" className="is-primary" disabled={isSaving || isInvalid}>
          {isSaving ? "Saving..." : actionTitles[action]}
        </button>
      </footer>
    </form>
  );
}

function FollowupTimeline({ events, status, onRetry }) {
  if (status === "loading") {
    return <div className="maf-timeline-state">Loading follow-up activity...</div>;
  }
  if (status === "error") {
    return (
      <div className="maf-timeline-state is-error" role="alert">
        <span>Medication adherence follow-up could not be loaded.</span>
        <button type="button" onClick={onRetry}>Retry</button>
      </div>
    );
  }
  if (!events.length) {
    return <div className="maf-timeline-state">No follow-up activity has been recorded yet.</div>;
  }

  return (
    <ol className="maf-timeline">
      {events.map((event) => (
        <li key={event.id}>
          <span className="maf-timeline-marker" aria-hidden="true" />
          <div>
            <header>
              <strong>{formatMedicationFollowupEventLabel(event.event_type)}</strong>
              <span>{formatMedicationFollowupDateTime(event.created_at, "")}</span>
            </header>
            <small>
              {Array.isArray(event.created_by_profile)
                ? event.created_by_profile[0]?.full_name
                : event.created_by_profile?.full_name || "Doctor"}
            </small>
            {event.from_status && event.to_status ? (
              <p>
                {formatMedicationFollowupStatus(event.from_status)} to{" "}
                {formatMedicationFollowupStatus(event.to_status)}
              </p>
            ) : null}
            {event.contact_method ? (
              <p>Contact method: {formatMedicationFollowupContactMethod(event.contact_method)}</p>
            ) : null}
            {event.next_follow_up_at ? (
              <p>
                {event.event_type === "attention_snoozed"
                  ? "Snoozed until"
                  : "Next follow-up"}
                : {formatMedicationFollowupDateTime(event.next_follow_up_at)}
              </p>
            ) : null}
            {event.resolution_summary ? (
              <p>Resolution summary: {event.resolution_summary}</p>
            ) : null}
            {event.note ? <p className="maf-timeline-note">{event.note}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function MedicationAdherenceFollowupModal({
  patient,
  liveAlert,
  followup: initialFollowup = null,
  initialAction = "",
  onClose,
  onChanged,
}) {
  const [followup, setFollowup] = useState(initialFollowup);
  const [action, setAction] = useState(initialFollowup ? initialAction : "start");
  const [events, setEvents] = useState([]);
  const [timelineStatus, setTimelineStatus] = useState(initialFollowup ? "loading" : "ready");
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);
  const savingRef = useRef(false);
  const actionRef = useRef(action);
  const recordedNotificationIdsRef = useRef(new Set());
  const followupId = followup?.id || "";

  const loadEvents = useCallback(async () => {
    if (!followupId) return;
    setTimelineStatus("loading");
    try {
      setEvents(await loadMedicationAdherenceFollowupEvents(followupId));
      setTimelineStatus("ready");
    } catch {
      setTimelineStatus("error");
    }
  }, [followupId]);

  useEffect(() => {
    if (!followupId) return undefined;
    const timer = window.setTimeout(loadEvents, 0);
    return () => window.clearTimeout(timer);
  }, [followupId, loadEvents]);

  useEffect(() => {
    savingRef.current = isSaving;
  }, [isSaving]);

  useEffect(() => {
    actionRef.current = action;
  }, [action]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const returnFocusElement = document.activeElement;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => closeButtonRef.current?.focus());

    const handleKeyDown = (event) => {
      if (!dialogRef.current?.contains(document.activeElement)) return;
      if (event.key === "Escape" && !savingRef.current) {
        event.preventDefault();
        if (actionRef.current && actionRef.current !== "start") {
          setAction("");
          setErrorMessage("");
        } else {
          onClose();
        }
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll(focusableSelector));
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
  }, [onClose]);

  const isResolved = followup?.status === "resolved";
  const canContact = useMemo(
    () => canTransitionMedicationAdherenceFollowup(followup?.status, "contacted"),
    [followup?.status]
  );
  const canMonitor = useMemo(
    () => canTransitionMedicationAdherenceFollowup(followup?.status, "monitoring"),
    [followup?.status]
  );
  const canResolve = useMemo(
    () => canTransitionMedicationAdherenceFollowup(followup?.status, "resolved"),
    [followup?.status]
  );

  const runAction = async (operation, success) => {
    if (isSaving) return;
    setIsSaving(true);
    setErrorMessage("");
    let result;
    try {
      result = await operation();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "The follow-up action could not be saved. Please try again.");
      setIsSaving(false);
      return;
    }

    setAction("");
    setSuccessMessage(success);

    try {
      const followupId = result?.status ? result.id : followup?.id;
      if (followupId) {
        const refreshedFollowup = await loadMedicationAdherenceFollowup(followupId);
        if (refreshedFollowup) setFollowup(refreshedFollowup);
        setEvents(await loadMedicationAdherenceFollowupEvents(followupId));
        setTimelineStatus("ready");
      }
      await onChanged?.(result);
    } catch {
      setTimelineStatus("error");
      setErrorMessage("The action was saved, but the latest follow-up details could not be loaded.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleStart = ({ initialNote, nextFollowUpAt, dateRange }) => {
    runAction(
      () =>
        startMedicationAdherenceFollowup({
          patientId: patient.id,
          alert: liveAlert,
          dateRange,
          initialNote,
          nextFollowUpAt,
        }),
      "Medication adherence follow-up started."
    );
  };

  const handleAction = ({ note, contactMethod, nextFollowUpAt, resolutionSummary }) => {
    if (action === "note") {
      return runAction(
        () => addMedicationAdherenceFollowupEvent({
          followupId: followup.id,
          eventType: "note_added",
          note,
        }),
        "Follow-up note added."
      );
    }
    if (action === "contact_attempt") {
      return runAction(
        () => addMedicationAdherenceFollowupEvent({
          followupId: followup.id,
          eventType: "contact_attempt",
          contactMethod,
          note,
        }),
        "Contact attempt recorded."
      );
    }
    if (action === "schedule") {
      return runAction(
        () => addMedicationAdherenceFollowupEvent({
          followupId: followup.id,
          eventType: "followup_scheduled",
          note,
          nextFollowUpAt,
        }),
        "Next follow-up scheduled."
      );
    }

    const nextStatus =
      action === "contacted"
        ? "contacted"
        : action === "monitoring"
          ? "monitoring"
          : "resolved";
    return runAction(
      () => updateMedicationAdherenceFollowupStatus({
        followupId: followup.id,
        status: nextStatus,
        contactMethod,
        note,
        nextFollowUpAt,
        resolutionSummary,
      }),
      nextStatus === "resolved"
        ? "Medication adherence follow-up resolved."
        : `Follow-up set to ${formatMedicationFollowupStatus(nextStatus)}.`
    );
  };

  const handleNotificationSent = async (notification) => {
    const notificationId = getMedicationFollowupNotificationId(notification);
    if (!notificationId) {
      setErrorMessage("Notification was sent, but follow-up activity could not be saved.");
      return;
    }

    if (recordedNotificationIdsRef.current.has(notificationId)) return;
    recordedNotificationIdsRef.current.add(notificationId);
    try {
      await addMedicationAdherenceFollowupEvent({
        followupId: followup.id,
        eventType: "notification_sent",
        relatedNotificationId: notificationId,
      });
      setSuccessMessage("Notification sent and follow-up activity recorded.");
      await loadEvents();
      await onChanged?.();
    } catch {
      recordedNotificationIdsRef.current.delete(notificationId);
      setErrorMessage("Notification was sent, but follow-up activity could not be saved.");
    }
  };

  return createPortal(
    <div
      className="maf-backdrop clinical-workflow-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSaving) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="maf-modal clinical-workflow-dialog clinical-workflow-dialog--followup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="maf-title"
      >
        <header className="maf-header clinical-workflow-dialog-header">
          <div>
            <span className="maf-header-icon" aria-hidden="true">
              <Icon icon="solar:clipboard-heart-bold" />
            </span>
            <div>
              <h2 id="maf-title">
                {followup ? "Medication Follow-up" : "Start Medication Follow-up"}
              </h2>
              <p>{patient?.full_name || "Selected Patient"}</p>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Close medication adherence follow-up"
            disabled={isSaving}
            onClick={onClose}
          >
            <Icon icon="solar:close-circle-linear" />
          </button>
        </header>

        <div className="maf-body clinical-workflow-dialog-body">
          {!followup ? (
            <StartFollowupForm
              patient={patient}
              alert={liveAlert}
              isSaving={isSaving}
              errorMessage={errorMessage}
              onCancel={onClose}
              onSubmit={handleStart}
            />
          ) : action ? (
            <section className="maf-action-section">
              <header>
                <button
                  type="button"
                  aria-label="Back to follow-up details"
                  disabled={isSaving}
                  onClick={() => {
                    setAction("");
                    setErrorMessage("");
                  }}
                >
                  <Icon icon="solar:arrow-left-linear" />
                </button>
                <h3>{actionTitles[action]}</h3>
              </header>
              <FollowupActionForm
                key={action}
                action={action}
                followup={followup}
                isSaving={isSaving}
                errorMessage={errorMessage}
                onCancel={() => {
                  setAction("");
                  setErrorMessage("");
                }}
                onSubmit={handleAction}
              />
            </section>
          ) : (
            <>
              <div className="maf-case-heading">
                <div>
                  <span>Status</span>
                  <strong className={`maf-status is-${followup.status}`}>
                    {formatMedicationFollowupStatus(followup.status)}
                  </strong>
                </div>
              </div>

              {liveAlert?.severity === "normal" && !isResolved ? (
                <p className="maf-improved" role="status">
                  Adherence has improved. Doctor review is still required before resolving this follow-up.
                </p>
              ) : null}

              <FollowupSummary
                followup={followup}
                liveAlert={liveAlert}
              />

              {!isResolved ? (
                <section className="maf-actions" aria-label="Follow-up actions">
                  <h3>Follow-up actions</h3>
                  <div>
                    <button type="button" onClick={() => setAction("note")}>
                      <Icon icon="solar:notes-linear" /> Add Note
                    </button>
                    <button type="button" onClick={() => setAction("contact_attempt")}>
                      <Icon icon="solar:phone-calling-linear" /> Record Contact Attempt
                    </button>
                    {canContact ? (
                      <button type="button" onClick={() => setAction("contacted")}>
                        <Icon icon="solar:user-check-linear" /> Mark Patient Contacted
                      </button>
                    ) : null}
                    {canMonitor ? (
                      <button type="button" onClick={() => setAction("monitoring")}>
                        <Icon icon="solar:eye-linear" /> Set Monitoring
                      </button>
                    ) : null}
                    <button type="button" onClick={() => setAction("schedule")}>
                      <Icon icon="solar:calendar-add-linear" /> Schedule Follow-up
                    </button>
                    {canResolve ? (
                      <button type="button" className="is-resolve" onClick={() => setAction("resolve")}>
                        <Icon icon="solar:check-circle-linear" /> Resolve Follow-up
                      </button>
                    ) : null}
                    <SendPatientNotificationAction
                      patientId={patient.id}
                      patientName={patient.full_name}
                      defaultType={MEDICATION_ADHERENCE_FOLLOWUP_NOTIFICATION_CONTEXT.type}
                      defaultTitle={MEDICATION_ADHERENCE_FOLLOWUP_NOTIFICATION_CONTEXT.title}
                      defaultMessage={MEDICATION_ADHERENCE_FOLLOWUP_NOTIFICATION_CONTEXT.message}
                      defaultPriority={MEDICATION_ADHERENCE_FOLLOWUP_NOTIFICATION_CONTEXT.priority}
                      lockedType={MEDICATION_ADHERENCE_FOLLOWUP_NOTIFICATION_CONTEXT.type}
                      hideTypeSelector
                      lockedTargetPath={MEDICATION_ADHERENCE_FOLLOWUP_NOTIFICATION_CONTEXT.targetPath}
                      contextLabel={MEDICATION_ADHERENCE_FOLLOWUP_NOTIFICATION_CONTEXT.contextLabel}
                      contextHelper={MEDICATION_ADHERENCE_FOLLOWUP_NOTIFICATION_CONTEXT.contextHelper}
                      triggerLabel={MEDICATION_ADHERENCE_FOLLOWUP_NOTIFICATION_CONTEXT.triggerLabel}
                      className="maf-notification-action"
                      outline
                      onSent={handleNotificationSent}
                    />
                  </div>
                </section>
              ) : null}

              {successMessage ? <p className="maf-success" role="status" aria-live="polite">{successMessage}</p> : null}
              {errorMessage ? <p className="maf-error" role="alert">{errorMessage}</p> : null}

              <section className="maf-timeline-section" aria-labelledby="maf-timeline-heading">
                <header>
                  <h3 id="maf-timeline-heading">Follow-up activity</h3>
                  <button type="button" onClick={loadEvents} disabled={timelineStatus === "loading"}>
                    <Icon icon="solar:refresh-linear" aria-hidden="true" />
                    Refresh
                  </button>
                </header>
                <FollowupTimeline events={events} status={timelineStatus} onRetry={loadEvents} />
              </section>
            </>
          )}
        </div>
      </section>
    </div>,
    document.body
  );
}

export function MedicationAdherencePreviousFollowups({ followups, onView }) {
  const resolved = (followups || []).filter((item) => item.status === "resolved").slice(0, 5);

  return (
    <section className="maf-history" aria-labelledby="maf-history-title">
      <header>
        <div>
          <h3 id="maf-history-title">Previous Medication Follow-ups</h3>
          <p>Resolved medication adherence follow-up history.</p>
        </div>
      </header>
      {resolved.length ? (
        <div className="maf-history-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Created</th>
                <th>Resolved</th>
                <th>Original severity</th>
                <th>Snapshot adherence</th>
                <th>Assigned Doctor</th>
                <th>Resolution</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {resolved.map((followup) => (
                <tr key={followup.id}>
                  <td>{formatMedicationFollowupDate(followup.created_at)}</td>
                  <td>{formatMedicationFollowupDate(followup.resolved_at)}</td>
                  <td>{formatMedicationFollowupSeverity(followup.severity_snapshot)}</td>
                  <td>{formatMedicationFollowupRate(followup.adherence_rate_snapshot)}</td>
                  <td>{getAssignedDoctorName(followup)}</td>
                  <td>{followup.resolution_summary}</td>
                  <td>
                    <button type="button" onClick={() => onView(followup)}>
                      View Timeline
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="maf-history-empty">No previous medication adherence follow-ups.</p>
      )}
    </section>
  );
}
