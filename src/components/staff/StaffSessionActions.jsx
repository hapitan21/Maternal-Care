import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";
import { positionDashboardMenu } from "../../lib/doctorDashboardPresentation";
import "../../styles/staff-session-actions.css";

// Keep viewport coordinates outside the table's clipping/stacking contexts.
export default function StaffSessionActions({ patient, open, onToggle, onClose, children }) {
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [position, setPosition] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    const update = () => {
      const trigger = triggerRef.current;
      if (!trigger?.isConnected) { onClose(); return; }
      const rect = trigger.getBoundingClientRect();
      const clip = trigger.closest(".doctor-sessions-scroll")?.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 ||
          rect.left >= window.innerWidth || (clip && (rect.right <= clip.left ||
          rect.left >= clip.right || rect.bottom <= clip.top || rect.top >= clip.bottom))) {
        onClose();
        return;
      }
      setPosition(positionDashboardMenu(rect, {
        width: 188, height: (menuRef.current?.scrollHeight || 102) + 2,
      }, { width: window.innerWidth, height: window.innerHeight }));
    };
    const frame = window.requestAnimationFrame(() => {
      update();
      menuRef.current?.querySelector("button")?.focus();
    });
    const outside = event => {
      if (!menuRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) onClose();
    };
    const keyboard = event => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        triggerRef.current?.focus();
      }
      if (event.key === "Tab") onClose();
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const buttons = [...(menuRef.current?.querySelectorAll("button") || [])];
        const index = buttons.indexOf(document.activeElement);
        buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    };
    const scroll = event => { if (!menuRef.current?.contains(event.target)) update(); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keyboard);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", update);
    const observer = new ResizeObserver(update);
    observer.observe(triggerRef.current);
    if (menuRef.current) observer.observe(menuRef.current);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keyboard);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", update);
    };
  }, [open, onClose]);

  return (
    <div className="staff-session-actions">
      <button ref={triggerRef} type="button" className="doctor-table-action"
        aria-label={`Open actions for ${patient}`} aria-haspopup="menu" aria-expanded={open}
        onClick={() => {
          setPosition(positionDashboardMenu(triggerRef.current.getBoundingClientRect(),
            { width: 188, height: 104 }, { width: window.innerWidth, height: window.innerHeight }));
          onToggle();
        }}>
        <Icon icon="solar:menu-dots-bold" />
      </button>
      {open && position ? createPortal(
        <div ref={menuRef} className="staff-dashboard-session-menu" role="menu"
          aria-label={`Actions for ${patient}`} data-direction={position.direction}
          style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}>
          {children}
        </div>, document.body) : null}
    </div>
  );
}
