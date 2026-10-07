import { useId, useRef, useState } from "react";
import AppointmentTimePicker from "./AppointmentTimePicker";
import { formatAppointmentDate, formatAppointmentTime, getManilaDateKey } from "../../lib/appointmentDate";
import { APPOINTMENT_REMINDER_MIN_LEAD_MS, clinicReminderLocalToISOString } from "../../lib/appointmentReminder";
import "../../styles/reminder-date-time-picker.css";

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dateKey = (date) => date.toISOString().slice(0, 10);
const calendarDate = (key) => new Date(`${key}T12:00:00Z`);

export default function ReminderDateTimePicker({ value, onChange, appointmentAt, now = new Date(), "aria-describedby": describedBy }) {
  const id = useId();
  const rootRef = useRef(null);
  const today = getManilaDateKey(now);
  const selectedDate = value?.slice(0, 10) || "";
  const [month, setMonth] = useState(() => (selectedDate || today).slice(0, 7));
  const [draftTime, setDraftTime] = useState(value?.slice(11, 16) || "08:00");
  const [focusDate, setFocusDate] = useState(selectedDate || today);
  const time = value?.slice(11, 16) || draftTime;
  const latestTimestamp = appointmentAt ? Date.parse(appointmentAt) - APPOINTMENT_REMINDER_MIN_LEAD_MS : NaN;
  const latestDate = Number.isFinite(latestTimestamp) ? getManilaDateKey(latestTimestamp) : "";
  const first = calendarDate(`${month}-01`);
  const daysInMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const days = Array.from({ length: daysInMonth }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`);
  const unavailable = (key) => key < today || Boolean(latestDate && key > latestDate);
  const available = days.filter((key) => !unavailable(key));
  const tabDate = available.includes(focusDate) ? focusDate : available.includes(selectedDate) ? selectedDate : available.includes(today) ? today : available[0];
  const previewAt = clinicReminderLocalToISOString(value);

  const changeMonth = (step) => {
    const next = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + step, 1));
    setMonth(dateKey(next).slice(0, 7));
  };
  const handleDayKey = (event, key) => {
    const date = calendarDate(key);
    const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -date.getUTCDay(), End: 6 - date.getUTCDay() };
    if (!(event.key in steps)) return;
    event.preventDefault();
    date.setUTCDate(date.getUTCDate() + steps[event.key]);
    const next = dateKey(date);
    if (unavailable(next)) return;
    setMonth(next.slice(0, 7));
    setFocusDate(next);
    window.requestAnimationFrame(() => rootRef.current?.querySelector(`[data-date="${next}"]`)?.focus());
  };

  return (
    <fieldset className="mc-reminder-picker" ref={rootRef} aria-describedby={describedBy} data-time-picker-boundary>
      <legend>Custom Reminder</legend>
      <div className="mc-reminder-picker__layout">
        <div className="mc-reminder-picker__date">
          <span className="mc-reminder-picker__label" id={`${id}-date`}>Select Date</span>
          <div className="mc-reminder-picker__date-value" aria-labelledby={`${id}-date`}>
            {selectedDate ? formatAppointmentDate(`${selectedDate}T00:00:00+08:00`) : "Choose a date below"}
          </div>
          <div className="mc-reminder-picker__calendar">
            <header>
              <button type="button" aria-label="Previous month" onClick={() => changeMonth(-1)} disabled={month <= today.slice(0, 7)}>‹</button>
              <strong aria-live="polite">{first.toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" })}</strong>
              <button type="button" aria-label="Next month" onClick={() => changeMonth(1)} disabled={Boolean(latestDate && month >= latestDate.slice(0, 7))}>›</button>
            </header>
            <div className="mc-reminder-picker__weekdays" aria-hidden="true">{weekdays.map((day) => <span key={day}>{day}</span>)}</div>
            <div className="mc-reminder-picker__days" role="group" aria-label="Reminder date">
              {Array.from({ length: first.getUTCDay() }, (_, index) => <span key={`blank-${index}`} aria-hidden="true" />)}
              {days.map((key) => (
                <button type="button" key={key} data-date={key} disabled={unavailable(key)}
                  className={`${key === selectedDate ? "is-selected" : ""}${key === today ? " is-today" : ""}`}
                  aria-label={formatAppointmentDate(`${key}T00:00:00+08:00`, { weekday: "long" })}
                  aria-pressed={key === selectedDate} aria-current={key === today ? "date" : undefined}
                  tabIndex={key === tabDate ? 0 : -1} onFocus={() => setFocusDate(key)}
                  onKeyDown={(event) => handleDayKey(event, key)}
                  onClick={() => onChange(`${key}T${time}`)}>
                  {Number(key.slice(-2))}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="mc-reminder-picker__time">
          <label className="mc-reminder-picker__label" id={`${id}-time`}>Select Time</label>
          <AppointmentTimePicker id={`${id}-time-control`} label="Reminder time" labelId={`${id}-time`}
            value={time} onChange={(next) => {
              setDraftTime(next);
              if (selectedDate) onChange(`${selectedDate}T${next}`);
            }} />
          <div className="mc-reminder-picker__preview" role="status" aria-live="polite">
            <strong>Reminder will be sent:</strong>
            <span>{previewAt ? `${formatAppointmentDate(previewAt)} • ${formatAppointmentTime(previewAt)}` : "Select a date and time."}</span>
          </div>
        </div>
      </div>
    </fieldset>
  );
}
