import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";
import "../../styles/patient-health-tips-preview.css";

// Shared with Reminders: presentation only; callers retain their existing data/access rules.
export function PatientHealthTipList({ tips, isLoading, error }) {
  return (
    <div className="patient-reminder-health-tip-list" role="region" aria-label="Daily health tips" tabIndex={0}>
      {isLoading && !tips.length ? (
        <article className="patient-reminder-view-all-empty" role="status">
          <h3>Loading health tips...</h3><p>Checking daily guidance from your clinic.</p>
        </article>
      ) : error && !tips.length ? (
        <article className="patient-reminder-view-all-empty" role="alert">
          <h3>Health tips could not be loaded.</h3><p>{error}</p>
        </article>
      ) : tips.length ? tips.map((tip) => (
        <article className="patient-reminder-health-tip-item" key={tip.id || `${tip.title}-${tip.text}`}>
          <div className="patient-reminder-health-tip-image">
            {tip.image ? <img src={tip.image} alt="" /> : <Icon icon="solar:lightbulb-bold-duotone" />}
          </div>
          <div>
            <div className="patient-reminder-health-tip-meta">
              <span>{tip.category || "General Health"}</span><span>{tip.displaySchedule || "Daily"}</span>
            </div>
            <h3>{tip.title}</h3><p>{tip.text}</p>
          </div>
        </article>
      )) : (
        <article className="patient-reminder-view-all-empty"><h3>No active daily health tips right now.</h3></article>
      )}
    </div>
  );
}

export default function PatientHealthTipsPreview({ open, tips, isLoading, error, onClose }) {
  const dialogRef = useRef(null);
  const closingRef = useRef(false);
  const closeRequestedRef = useRef(false);
  const requestClose = () => {
    if (closeRequestedRef.current) return;
    closeRequestedRef.current = true;
    onClose();
  };
  useEffect(() => {
    if (!open) return undefined;
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    closingRef.current = false;
    closeRequestedRef.current = false;
    const viewport = window.visualViewport;
    const resize = () => {
      dialog.style.setProperty("--tips-viewport-height", `${viewport?.height || window.innerHeight}px`);
      dialog.style.setProperty("--tips-viewport-width", `${viewport?.width || window.innerWidth}px`);
      dialog.style.setProperty("--tips-viewport-top", `${viewport?.offsetTop || 0}px`);
      dialog.style.setProperty("--tips-viewport-left", `${viewport?.offsetLeft || 0}px`);
    };
    resize();
    window.addEventListener("resize", resize);
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    dialog.showModal(); // Native modal focus containment and background inertness.
    dialog.querySelector("button")?.focus({ preventScroll: true });
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("resize", resize);
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
      closingRef.current = true;
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <dialog
      ref={dialogRef}
      className="pwa-dashboard-tips-preview"
      aria-labelledby="dashboard-health-tips-title"
      aria-modal="true"
      onCancel={(event) => { event.preventDefault(); requestClose(); }}
      onClose={() => { if (!closingRef.current && !dialogRef.current?.open) requestClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right ||
            event.clientY < bounds.top || event.clientY > bounds.bottom) requestClose();
      }}
    >
      <header>
        <div>
          <h2 id="dashboard-health-tips-title">All Health Tips</h2>
          <p>{tips.length} active {tips.length === 1 ? "tip" : "tips"}</p>
        </div>
        <button type="button" aria-label="Close health tips preview" onClick={requestClose}>
          <span aria-hidden="true">×</span>
        </button>
      </header>
      {error && tips.length ? <p className="pwa-dashboard-tips-status" role="status">{error}</p> : null}
      <PatientHealthTipList tips={tips} isLoading={isLoading} error={error} />
    </dialog>, document.body
  );
}
