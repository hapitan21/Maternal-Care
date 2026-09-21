export const APPOINTMENT_STATUS_POPOVER_WIDTH = 176;
export const APPOINTMENT_STATUS_POPOVER_FALLBACK_HEIGHT = 160;

export function getAppointmentStatusPopoverPosition({
  triggerRect,
  menuRect,
  viewportWidth,
  viewportHeight,
  viewportPadding = 10,
  menuGap = 8,
}) {
  if (!triggerRect) return null;

  const menuWidth = menuRect?.width || APPOINTMENT_STATUS_POPOVER_WIDTH;
  const menuHeight = menuRect?.height || APPOINTMENT_STATUS_POPOVER_FALLBACK_HEIGHT;
  const maximumLeft = Math.max(
    viewportPadding,
    viewportWidth - menuWidth - viewportPadding
  );
  const left = Math.min(
    Math.max(triggerRect.right - menuWidth, viewportPadding),
    maximumLeft
  );
  const spaceBelow = viewportHeight - triggerRect.bottom - viewportPadding;
  const top = spaceBelow >= menuHeight + menuGap
    ? triggerRect.bottom + menuGap
    : Math.max(viewportPadding, triggerRect.top - menuHeight - menuGap);

  return {
    left: Math.round(left),
    top: Math.round(top),
  };
}
