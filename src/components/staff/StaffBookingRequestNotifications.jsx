import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { useLocation } from "react-router-dom";
import { useAppointmentToastPlacement } from "../../hooks/useAppointmentToastPlacement";

export function StaffBookingRequestBadge({ count, error = "" }) {
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  const label = `${count} booking requests awaiting review${error ? "; last confirmed count, refresh unavailable" : ""}`;
  return <span className={`staff-booking-request-badge${error ? " is-stale" : ""}`} title={label} aria-label={label}>{count}{error ? <span aria-hidden="true">*</span> : null}</span>;
}

export function StaffBookingRequestToast({ toast, onDismiss, onView }) {
  return toast ? <RequestToast key={toast.id} toast={toast} onDismiss={onDismiss} onView={onView} /> : null;
}

function RequestToast({ toast, onDismiss, onView }) {
  const [paused, setPaused] = useState(false);
  const location = useLocation();
  const ref = useAppointmentToastPlacement("New Appointment Request", `${toast.id}:${location.pathname}`, ".staff-appointments-page, .staff-dashboard-home");
  useEffect(() => {
    if (paused) return undefined;
    const timer = window.setTimeout(onDismiss, 7000);
    return () => window.clearTimeout(timer);
  }, [onDismiss, paused]);
  return <div className="staff-booking-request-toast" ref={ref}
    onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
    onFocus={() => setPaused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false); }}>
    <Icon icon="solar:bell-bing-linear" aria-hidden="true" />
    <div className="staff-booking-request-toast__content">
      <div role="status" aria-live="polite" aria-atomic="true"><strong>New Appointment Request</strong><p>A patient has submitted a new booking request.</p></div>
      <button type="button" onClick={onView}>View requests</button>
    </div>
    <button type="button" className="staff-booking-request-toast__close" aria-label="Dismiss new appointment request notification" onClick={onDismiss}>×</button>
  </div>;
}
