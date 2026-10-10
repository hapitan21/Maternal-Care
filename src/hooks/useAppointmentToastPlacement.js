import { useLayoutEffect, useRef } from "react";

// Keep appointment feedback in a clear lane above the page's primary content.
export function useAppointmentToastPlacement(message, version, workspaceSelector) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const toast = ref.current;
    if (!toast || !message) return undefined;
    const workspace = toast.closest(".appointment-workspace") || (workspaceSelector ? document.querySelector(workspaceSelector) : null);
    const header = workspace?.querySelector(workspaceSelector ? ".appointment-ui-header, .staff-dashboard-home > .doctor-topbar" : ".appointment-ui-header");
    const toolbar = workspace?.querySelector(workspaceSelector ? ".appointment-ui-toolbar, .doctor-request-tools, .staff-dashboard-home > .staff-hero-card" : ".appointment-ui-toolbar");
    const scrollContainer = workspace?.closest(".doctor-main") ?? workspace;
    const originalAnchor = scrollContainer?.style.getPropertyValue("overflow-anchor");
    const originalAnchorPriority = scrollContainer?.style.getPropertyPriority("overflow-anchor");
    // Reserving notification space must not make browser scroll anchoring undo it.
    scrollContainer?.style.setProperty("overflow-anchor", "none");
    const originalMargin = header?.style.getPropertyValue("margin-bottom");
    const originalPriority = header?.style.getPropertyPriority("margin-bottom");
    const baseMargin = header ? parseFloat(getComputedStyle(header).marginBottom) : 0;
    let reservedSpace = 0;
    const reserve = (space) => {
      if (!header || Math.abs(space - reservedSpace) < 0.1) return;
      reservedSpace = space;
      header.style.setProperty("margin-bottom", `${baseMargin + space}px`, "important");
    };
    let frame;
    const place = () => {
      for (const key of ["top", "left", "right"]) toast.style.removeProperty(key);
      const width = document.documentElement.clientWidth;
      const height = window.innerHeight;
      toast.style.maxWidth = `${width - 24}px`;
      const box = toast.getBoundingClientRect();
      const style = getComputedStyle(toast);
      const mobile = window.innerWidth <= 640;
      const profiles = [...document.querySelectorAll(".doctor-global-profile-slot, .doctor-profile-card, .staff-profile-card")]
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width && rect.height && rect.bottom > 0 && rect.top < height);
      const profileBottom = Math.max(0, ...profiles.map((rect) => rect.bottom));
      const contentRight = workspace?.getBoundingClientRect().right ?? width - parseFloat(style.right);
      const preferred = {
        top: Math.max(parseFloat(style.top), profileBottom + 12),
        left: mobile ? (width - box.width) / 2 : Math.max(12, Math.min(contentRight, width - 12) - box.width),
      };
      const obstacles = () => [...document.querySelectorAll(`button, input, select, textarea, .doctor-sidebar, .doctor-profile-dropdown, .doctor-global-profile-slot, .doctor-profile-card, .staff-profile-card, .appointment-ui-toolbar, .doctor-appointment-summary, .staff-appointment-summary, .appointment-ui-table-card, .appointment-status-popover${workspaceSelector ? ", .staff-dashboard-home .doctor-hero-text" : ""}`)]
        .filter((element) => !toast.contains(element))
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width && rect.height && rect.bottom > 0 && rect.top < height && rect.right > 0 && rect.left < width);
      let controls = obstacles();
      const fits = ({ top, left }) => top >= 12 && top + box.height <= height - 12 && left >= 12 && left + box.width <= width - 12 &&
        !controls.some((rect) => left < rect.right + 8 && left + box.width > rect.left - 8 && top < rect.bottom + 8 && top + box.height > rect.top - 8);
      if (reservedSpace && toolbar && fits(preferred)) {
        const toolbarTopWithoutSpace = toolbar.getBoundingClientRect().top - reservedSpace;
        reserve(Math.max(0, preferred.top + box.height + 12 - toolbarTopWithoutSpace));
        controls = obstacles();
      }
      let position = preferred;
      if (!fits(preferred) && header && toolbar) {
        // A narrow viewport or wrapped message needs its own notification space.
        preferred.top = Math.max(12, header.getBoundingClientRect().bottom + 12, profileBottom + 12);
        const toolbarTopWithoutSpace = toolbar.getBoundingClientRect().top - reservedSpace;
        reserve(Math.max(0, preferred.top + box.height + 12 - toolbarTopWithoutSpace));
        controls = obstacles();
        position = preferred;
      }
      if (!fits(preferred)) {
        const tops = new Set([preferred.top, 12, height - box.height - 12, ...controls.flatMap((rect) => [rect.bottom + 12, rect.top - box.height - 12])]);
        const lefts = new Set([preferred.left, 12, width - box.width - 12, ...controls.flatMap((rect) => [rect.right + 12, rect.left - box.width - 12])]);
        const distance = (candidate) => (candidate.top - preferred.top) ** 2 + (candidate.left - preferred.left) ** 2;
        position = [...tops].flatMap((top) => [...lefts].map((left) => ({ top, left })))
          .sort((first, second) => distance(first) - distance(second)).find(fits) || preferred;
      }
      toast.style.top = `${position.top}px`;
      toast.style.left = `${position.left + (mobile ? box.width / 2 : 0)}px`;
      toast.style.right = "auto";
    };
    const schedule = () => { window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(place); };
    place();
    const size = new ResizeObserver(schedule);
    size.observe(toast);
    if (workspace) size.observe(workspace);
    if (header) size.observe(header);
    const menus = new MutationObserver(schedule);
    menus.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      size.disconnect(); menus.disconnect(); window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      if (header) {
        if (originalMargin) header.style.setProperty("margin-bottom", originalMargin, originalPriority);
        else header.style.removeProperty("margin-bottom");
      }
      if (scrollContainer) {
        if (originalAnchor) scrollContainer.style.setProperty("overflow-anchor", originalAnchor, originalAnchorPriority);
        else scrollContainer.style.removeProperty("overflow-anchor");
      }
    };
  }, [message, version, workspaceSelector]);
  return ref;
}
