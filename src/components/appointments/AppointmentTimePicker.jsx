import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "../../styles/appointment-time-picker.css";

const hourOptions = Array.from({ length: 12 }, (_, index) =>
  String(index + 1).padStart(2, "0")
);
const minuteOptions = Array.from({ length: 60 }, (_, index) =>
  String(index).padStart(2, "0")
);
const defaultDraft = { hour: "08", minute: "00", period: "AM" };

function getTimeDraft(value, fallbackValue = "08:00") {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || fallbackValue));
  if (!match) return defaultDraft;

  const hour24 = Number(match[1]);
  const minute = Number(match[2]);
  if (hour24 < 0 || hour24 > 23 || minute < 0 || minute > 59) {
    return defaultDraft;
  }

  return {
    hour: String(hour24 % 12 || 12).padStart(2, "0"),
    minute: String(minute).padStart(2, "0"),
    period: hour24 >= 12 ? "PM" : "AM",
  };
}

function getAllowedTimeValues(values) {
  if (!Array.isArray(values)) return null;
  return [
    ...new Set(
      values
        .map(String)
        .filter((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value))
    ),
  ];
}

function getDraftFromAllowedValues(value, fallbackValue, allowedValues) {
  const currentValue = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""))
    ? String(value)
    : "";
  const fallback = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(fallbackValue || ""))
    ? String(fallbackValue)
    : "08:00";
  const selected = currentValue && (!allowedValues || allowedValues.includes(currentValue))
    ? currentValue
    : allowedValues?.[0] || fallback;
  return getTimeDraft(selected);
}

function getScheduleHourDrafts(hourRangeMinutes) {
  if (!hourRangeMinutes || !Number.isFinite(hourRangeMinutes.startMinute) ||
      !Number.isFinite(hourRangeMinutes.endMinute) ||
      hourRangeMinutes.endMinute <= hourRangeMinutes.startMinute) return null;

  const firstHour = Math.floor(hourRangeMinutes.startMinute / 60);
  const lastHour = Math.floor(hourRangeMinutes.endMinute / 60);
  return Array.from({ length: lastHour - firstHour + 1 }, (_, index) =>
    getTimeDraft(`${String(firstHour + index).padStart(2, "0")}:00`)
  );
}

function getTimeValue(draft) {
  const hour12 = Number(draft.hour);
  const minute = Number(draft.minute);
  if (hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) return "";

  let hour24 = hour12 % 12;
  if (draft.period === "PM") hour24 += 12;

  return `${String(hour24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatAppointmentTimePickerValue(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return "";

  const hour24 = Number(match[1]);
  const minute = Number(match[2]);
  if (hour24 < 0 || hour24 > 23 || minute < 0 || minute > 59) return "";

  const hour12 = hour24 % 12 || 12;
  return `${String(hour12).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${
    hour24 >= 12 ? "PM" : "AM"
  }`;
}

const AppointmentTimePicker = forwardRef(function AppointmentTimePicker(
  {
    id,
    label = "Appointment time",
    labelId,
    value,
    onChange,
    required = false,
    disabled = false,
    defaultValue = "08:00",
    placeholder = "Select time",
    className = "",
    allowedValues,
    hourRangeMinutes,
    onInvalid,
  },
  ref
) {
  const generatedId = useId();
  const pickerId = id || `appointment-time-${generatedId}`;
  const popoverId = `${pickerId}-popover`;
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  const hourSelectRef = useRef(null);
  const [isOpen, setIsOpen] = useState(false);
  const [placement, setPlacement] = useState("below");
  const [draft, setDraft] = useState(() => getTimeDraft(value, defaultValue));
  const normalizedAllowedValues = useMemo(
    () => getAllowedTimeValues(allowedValues),
    [allowedValues]
  );
  const allowedDrafts = useMemo(
    () => normalizedAllowedValues?.map((time) => getTimeDraft(time)) || null,
    [normalizedAllowedValues]
  );
  const scheduleHourDrafts = useMemo(
    () => getScheduleHourDrafts(hourRangeMinutes),
    [hourRangeMinutes]
  );
  const displayValue = formatAppointmentTimePickerValue(value);

  const resetDraft = useCallback(() => {
    setDraft(getDraftFromAllowedValues(value, defaultValue, normalizedAllowedValues));
  }, [defaultValue, normalizedAllowedValues, value]);

  const updateDraftPart = (part, nextValue) => {
    const candidate = { ...draft, [part]: nextValue };
    if (!allowedDrafts) {
      setDraft(candidate);
      return;
    }

    const matchingPart = allowedDrafts.filter((option) => option[part] === nextValue);
    if (!matchingPart.length) {
      if (part === "period") setDraft(candidate);
      return;
    }
    const bestMatch = matchingPart.find((option) =>
      option.hour === candidate.hour && option.minute === candidate.minute && option.period === candidate.period
    ) || matchingPart.find((option) =>
      option.hour === candidate.hour && option.period === candidate.period
    ) || matchingPart.find((option) => option.hour === candidate.hour) || matchingPart[0];
    setDraft(bestMatch);
  };

  const basePickerHourDrafts = scheduleHourDrafts || (allowedDrafts
    ? [...new Map(allowedDrafts.map((option) => [`${option.hour}-${option.period}`, option])).values()]
    : hourOptions.map((hour) => ({ hour, period: draft.period })));
  const selectedHourKey = `${draft.hour}-${draft.period}`;
  const pickerHourDrafts = basePickerHourDrafts.some((option) =>
    `${option.hour}-${option.period}` === selectedHourKey
  )
    ? basePickerHourDrafts
    : [...basePickerHourDrafts, { hour: draft.hour, period: draft.period, currentOnly: true }];
  const hourOptionsForPicker = pickerHourDrafts.map((option) => ({
    ...option,
    key: `${option.hour}-${option.period}`,
    disabled: Boolean(option.currentOnly || (allowedDrafts && !allowedDrafts.some((allowed) =>
      allowed.hour === option.hour && allowed.period === option.period
    ))),
  }));
  const minuteOptionsForPicker = allowedDrafts
    ? minuteOptions.map((minute) => ({
        minute,
        disabled: !allowedDrafts.some((option) =>
          option.hour === draft.hour && option.period === draft.period && option.minute === minute
        ),
      }))
    : minuteOptions.map((minute) => ({ minute, disabled: false }));
  const periodOptionsForPicker = ["AM", "PM"];

  const updateHourChoice = (key) => {
    const [hour, period] = key.split("-");
    const allowedChoice = allowedDrafts?.find((option) =>
      option.hour === hour && option.period === period && option.minute === draft.minute
    ) || allowedDrafts?.find((option) => option.hour === hour && option.period === period);
    setDraft(allowedChoice || { ...draft, hour, period });
  };

  const focusTrigger = useCallback(() => {
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const closeWithoutApplying = useCallback(
    ({ returnFocus = false } = {}) => {
      resetDraft();
      setIsOpen(false);
      if (returnFocus) focusTrigger();
    },
    [focusTrigger, resetDraft]
  );

  const updatePlacement = useCallback(() => {
    const root = rootRef.current;
    const popover = popoverRef.current;
    if (!root || !popover) return;

    const boundary = root.closest(
      "[data-time-picker-boundary], .appointment-form-card, .staff-add-appointment-modal"
    );
    const rootRect = root.getBoundingClientRect();
    const boundaryRect = boundary?.getBoundingClientRect() || {
      top: 0,
      bottom: window.innerHeight,
    };
    const popoverHeight = popover.getBoundingClientRect().height;
    const spaceBelow = boundaryRect.bottom - rootRect.bottom - 10;
    const spaceAbove = rootRect.top - boundaryRect.top - 10;

    setPlacement(
      spaceBelow < popoverHeight && spaceAbove > spaceBelow ? "above" : "below"
    );
  }, []);

  const openPicker = useCallback(() => {
    if (disabled) return;
    resetDraft();
    setIsOpen(true);
  }, [disabled, resetDraft]);

  useImperativeHandle(
    ref,
    () => ({
      focus: focusTrigger,
      open: openPicker,
    }),
    [focusTrigger, openPicker]
  );

  useLayoutEffect(() => {
    if (!isOpen) return undefined;

    updatePlacement();
    const focusFrame = window.requestAnimationFrame(() =>
      hourSelectRef.current?.focus()
    );

    const handleResize = () => updatePlacement();
    window.addEventListener("resize", handleResize);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("resize", handleResize);
    };
  }, [isOpen, updatePlacement]);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handleOutsidePointer = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        closeWithoutApplying();
      }
    };

    const handleEscape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeWithoutApplying({ returnFocus: true });
    };

    document.addEventListener("pointerdown", handleOutsidePointer, true);
    document.addEventListener("keydown", handleEscape, true);

    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointer, true);
      document.removeEventListener("keydown", handleEscape, true);
    };
  }, [closeWithoutApplying, isOpen]);

  const handleTriggerClick = () => {
    if (isOpen) {
      closeWithoutApplying({ returnFocus: true });
      return;
    }

    openPicker();
  };

  const handleApply = () => {
    const nextValue = getTimeValue(draft);
    if (!nextValue) return;
    if (normalizedAllowedValues && !normalizedAllowedValues.includes(nextValue)) {
      onInvalid?.("That time is outside this Doctor's available schedule or conflicts with another appointment. Choose an available time.");
      return;
    }

    onChange(nextValue);
    setIsOpen(false);
    focusTrigger();
  };

  return (
    <div
      ref={rootRef}
      className={[
        "appointment-time-picker",
        isOpen ? "is-open" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      data-placement={placement}
    >
      <button
        ref={triggerRef}
        id={pickerId}
        className="appointment-time-picker__trigger"
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? popoverId : undefined}
        aria-labelledby={labelId}
        aria-label={
          labelId
            ? undefined
            : `${label}${displayValue ? `, ${displayValue}` : ", not selected"}`
        }
        aria-required={required || undefined}
        onClick={handleTriggerClick}
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="8.25" />
          <path d="M12 7.7v4.7l3.1 1.8" />
        </svg>

        <div className={displayValue ? "" : "is-placeholder"}>
          {displayValue || placeholder}
        </div>

        <svg className="appointment-time-picker__chevron" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="m6 8 4 4 4-4" />
        </svg>
      </button>

      {isOpen ? (
        <div
          ref={popoverRef}
          id={popoverId}
          className="appointment-time-picker__popover"
          role="dialog"
          aria-label={`Choose ${label.toLowerCase()}`}
        >
          <div className="appointment-time-picker__heading">Choose time</div>

          <div className="appointment-time-picker__columns">
            <label>
              <small>Hour</small>
              <select
                ref={hourSelectRef}
                className="appointment-time-picker__select"
                value={selectedHourKey}
                onChange={(event) => updateHourChoice(event.target.value)}
                aria-label="Hour"
              >
                {hourOptionsForPicker.map((option) => (
                  <option key={option.key} value={option.key} disabled={option.disabled}>
                    {option.hour}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <small>Minute</small>
              <select
                className="appointment-time-picker__select"
                value={draft.minute}
                onChange={(event) => updateDraftPart("minute", event.target.value)}
                aria-label="Minute"
              >
                {minuteOptionsForPicker.map(({ minute, disabled: minuteDisabled }) => (
                  <option key={minute} value={minute} disabled={minuteDisabled}>
                    {minute}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <small>Period</small>
              <select
                className="appointment-time-picker__select"
                value={draft.period}
                onChange={(event) => updateDraftPart("period", event.target.value)}
                aria-label="AM or PM"
              >
                {periodOptionsForPicker.map((period) => (
                  <option key={period} value={period}>{period}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="appointment-time-picker__actions">
            <button
              className="appointment-time-picker__cancel"
              type="button"
              onClick={() => closeWithoutApplying({ returnFocus: true })}
            >
              Cancel
            </button>
            <button
              className="appointment-time-picker__apply"
              type="button"
              onClick={handleApply}
            >
              Apply
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
});

export default AppointmentTimePicker;
