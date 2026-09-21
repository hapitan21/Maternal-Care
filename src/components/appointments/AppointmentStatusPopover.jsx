import { Icon } from "@iconify/react";

export default function AppointmentStatusPopover({
  ariaLabel,
  actions,
  busy = false,
  currentLabel,
  currentTone,
  menuRef,
  onAction,
  position,
}) {
  if (!position) return null;

  const currentIcon = currentTone === "pending"
    ? "solar:clock-circle-bold"
    : "solar:check-circle-bold";

  return (
    <div
      ref={menuRef}
      className="appointment-status-popover"
      role="menu"
      aria-label={ariaLabel}
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
      onClick={(event) => event.stopPropagation()}
    >
      <div className={`appointment-status-popover-current is-${currentTone}`}>
        <Icon icon={currentIcon} aria-hidden="true" />
        <span>{currentLabel}</span>
      </div>

      {actions.length ? (
        <>
          <div className="appointment-status-popover-divider" aria-hidden="true" />
          <div className="appointment-status-popover-actions">
            {actions.map((action) => (
              <button
                key={action.value}
                type="button"
                role="menuitem"
                className={`appointment-status-popover-action is-${action.tone}`}
                disabled={busy}
                onClick={() => onAction(action)}
              >
                <Icon icon={action.icon} aria-hidden="true" />
                <span>{action.label}</span>
                {action.trailingIcon ? (
                  <Icon icon={action.trailingIcon} aria-hidden="true" />
                ) : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
