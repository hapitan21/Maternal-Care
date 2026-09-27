import React from "react";
import { Icon } from "@iconify/react";

import "../../styles/adminSelect.css";

export default function AdminSelect({
  label,
  value,
  onChange,
  options = [],
  align = "left",
  placeholder = "Select an option",
  disabled = false,
}) {
  const selectId = React.useId();

  const rootRef = React.useRef(null);
  const triggerRef = React.useRef(null);
  const optionRefs = React.useRef([]);

  const [open, setOpen] = React.useState(false);

  const selectedIndex = React.useMemo(
    () =>
      options.findIndex(
        (option) =>
          String(option.value) ===
          String(value)
      ),
    [options, value]
  );

  const selectedOption =
    selectedIndex >= 0
      ? options[selectedIndex]
      : null;

  const focusOption = React.useCallback(
    (index) => {
      if (!options.length) return;

      let nextIndex = index;

      if (nextIndex < 0) {
        nextIndex =
          options.length - 1;
      }

      if (
        nextIndex >=
        options.length
      ) {
        nextIndex = 0;
      }

      window.requestAnimationFrame(
        () => {
          optionRefs.current[
            nextIndex
          ]?.focus();
        }
      );
    },
    [options.length]
  );

  React.useEffect(() => {
    const onPointerDown = (
      event
    ) => {
      if (
        !rootRef.current?.contains(
          event.target
        )
      ) {
        setOpen(false);
      }
    };

    document.addEventListener(
      "pointerdown",
      onPointerDown
    );

    return () => {
      document.removeEventListener(
        "pointerdown",
        onPointerDown
      );
    };
  }, []);

  React.useEffect(() => {
    if (!open) return;

    focusOption(
      selectedIndex >= 0
        ? selectedIndex
        : 0
    );
  }, [
    focusOption,
    open,
    selectedIndex,
  ]);

  const closeAndFocusTrigger =
    React.useCallback(() => {
      setOpen(false);

      window.requestAnimationFrame(
        () => {
          triggerRef.current?.focus();
        }
      );
    }, []);

  const chooseOption = (
    option
  ) => {
    if (
      option.disabled ||
      disabled
    ) {
      return;
    }

    onChange?.(option.value);

    closeAndFocusTrigger();
  };

  const handleTriggerKeyDown = (
    event
  ) => {
    if (disabled) return;

    if (
      event.key ===
        "ArrowDown" ||
      event.key === "ArrowUp"
    ) {
      event.preventDefault();

      setOpen(true);

      const startIndex =
        selectedIndex >= 0
          ? selectedIndex
          : 0;

      focusOption(
        event.key ===
          "ArrowDown"
          ? startIndex
          : startIndex
      );
    }

    if (
      event.key === "Enter" ||
      event.key === " "
    ) {
      event.preventDefault();

      setOpen(
        (current) => !current
      );
    }

    if (
      event.key === "Escape" &&
      open
    ) {
      event.preventDefault();

      closeAndFocusTrigger();
    }
  };

  const handleOptionKeyDown = (
    event,
    index
  ) => {
    if (
      event.key ===
      "ArrowDown"
    ) {
      event.preventDefault();

      focusOption(index + 1);

      return;
    }

    if (
      event.key === "ArrowUp"
    ) {
      event.preventDefault();

      focusOption(index - 1);

      return;
    }

    if (event.key === "Home") {
      event.preventDefault();

      focusOption(0);

      return;
    }

    if (event.key === "End") {
      event.preventDefault();

      focusOption(
        options.length - 1
      );

      return;
    }

    if (
      event.key === "Escape"
    ) {
      event.preventDefault();

      closeAndFocusTrigger();
    }
  };

  return (
    <div
      ref={rootRef}
      className="admin-select-field"
      data-align={align}
    >
      <span
        id={`${selectId}-label`}
        className="admin-select-label"
      >
        {label}
      </span>

      <div className="admin-select-control">
        <button
          ref={triggerRef}
          type="button"
          className="admin-select-trigger"
          aria-labelledby={`${selectId}-label ${selectId}-value`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={`${selectId}-listbox`}
          disabled={
            disabled ||
            !options.length
          }
          onClick={() =>
            setOpen(
              (current) =>
                !current
            )
          }
          onKeyDown={
            handleTriggerKeyDown
          }
        >
          <span
            id={`${selectId}-value`}
            className={
              selectedOption
                ? ""
                : "is-placeholder"
            }
          >
            {selectedOption?.label ||
              placeholder}
          </span>

          <Icon
            icon="solar:alt-arrow-down-linear"
            className={
              open
                ? "is-open"
                : ""
            }
            aria-hidden="true"
          />
        </button>

        {open ? (
          <div
            id={`${selectId}-listbox`}
            className="admin-select-menu"
            role="listbox"
            aria-labelledby={`${selectId}-label`}
          >
            {options.map(
              (option, index) => {
                const selected =
                  String(
                    option.value
                  ) ===
                  String(value);

                return (
                  <button
                    key={String(
                      option.value
                    )}
                    ref={(node) => {
                      optionRefs.current[
                        index
                      ] = node;
                    }}
                    type="button"
                    role="option"
                    aria-selected={
                      selected
                    }
                    className={
                      selected
                        ? "is-selected"
                        : ""
                    }
                    disabled={
                      option.disabled
                    }
                    onClick={() =>
                      chooseOption(
                        option
                      )
                    }
                    onKeyDown={(
                      event
                    ) =>
                      handleOptionKeyDown(
                        event,
                        index
                      )
                    }
                  >
                    <span>
                      {option.label}
                    </span>

                    {selected ? (
                      <Icon
                        icon="solar:check-circle-bold"
                        aria-hidden="true"
                      />
                    ) : null}
                  </button>
                );
              }
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}