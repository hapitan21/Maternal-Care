import { useEffect, useId, useRef, useState } from "react";
import { CalendarDays, ChevronDown, X } from "lucide-react";
import { AppointmentControlGroup } from "./AppointmentUi";
import { formatAppointmentDateRange, getAppointmentDateRangeError } from "../../lib/appointmentDateRange";
import "../../styles/appointment-date-range.css";

export default function AppointmentDateRangeFilter({ value, onApply, className = "" }) {
  const id = useId();
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const fromRef = useRef(null);
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState("");
  const summary = formatAppointmentDateRange(value);

  useEffect(() => {
    if (!isOpen) return undefined;
    fromRef.current?.focus();
    const outside = (event) => {
      if (!rootRef.current?.contains(event.target)) setIsOpen(false);
    };
    const escape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setIsOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("focusin", outside);
    };
  }, [isOpen]);

  const close = () => { setIsOpen(false); triggerRef.current?.focus(); };
  const apply = () => {
    const message = getAppointmentDateRangeError(draft);
    setError(message);
    if (message) return;
    onApply(draft);
    close();
  };

  return (
    <AppointmentControlGroup label="Filter by Date Range" area="month" className={className}>
      <div className="appointment-date-range" ref={rootRef}>
        <button type="button" className="appointment-date-range__trigger" ref={triggerRef}
          aria-label={`Filter appointments by date range: ${summary}`} title={summary}
          aria-haspopup="dialog" aria-expanded={isOpen} aria-controls={isOpen ? `${id}-dialog` : undefined}
          onClick={() => {
            setDraft({ ...value }); setError(""); setIsOpen(!isOpen);
          }}>
          <CalendarDays aria-hidden="true" /><span>{summary}</span><ChevronDown aria-hidden="true" />
        </button>
        {isOpen ? (
          <div className="appointment-date-range__popover" role="dialog" id={`${id}-dialog`} aria-labelledby={`${id}-title`}>
            <div className="appointment-date-range__heading">
              <strong id={`${id}-title`}>Appointment date range</strong>
              <button type="button" aria-label="Close date range filter" onClick={close}><X aria-hidden="true" /></button>
            </div>
            <label htmlFor={`${id}-from`}>From</label>
            <input id={`${id}-from`} type="date" value={draft.from} ref={fromRef}
              aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
              onChange={(event) => { setDraft({ ...draft, from: event.target.value }); setError(""); }} />
            <label htmlFor={`${id}-to`}>To</label>
            <input id={`${id}-to`} type="date" value={draft.to}
              aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
              onChange={(event) => { setDraft({ ...draft, to: event.target.value }); setError(""); }} />
            {error ? <p className="appointment-date-range__error" id={`${id}-error`} role="alert">{error}</p> : null}
            <div className="appointment-date-range__actions">
              <button type="button" onClick={() => { onApply({ from: "", to: "" }); close(); }}>Clear</button>
              <button type="button" className="appointment-date-range__apply" onClick={apply}>Apply Range</button>
            </div>
          </div>
        ) : null}
      </div>
    </AppointmentControlGroup>
  );
}
