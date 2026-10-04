export function dashboardSectionState({ hasData, failed, count = 0 }) {
  if (hasData) return count ? "data" : "empty";
  return failed ? "error" : "loading";
}

export function positionDashboardMenu(rect, size, viewport) {
  const margin = 8;
  const gap = 7;
  const below = viewport.height - rect.bottom - gap - margin;
  const above = rect.top - gap - margin;
  const upward = below < size.height && above > below;
  const maxHeight = Math.max(0, upward ? above : below);
  const height = Math.min(size.height, maxHeight);
  const width = Math.min(size.width, Math.max(0, viewport.width - margin * 2));
  return {
    left: Math.max(margin, Math.min(rect.right - width, viewport.width - width - margin)),
    top: upward ? Math.max(margin, rect.top - gap - height) : rect.bottom + gap,
    width,
    maxHeight,
    direction: upward ? "up" : "down",
  };
}
