import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";
import { positionDashboardMenu } from "../../lib/doctorDashboardPresentation";

export default function DashboardSessionActions({ patient, open, onToggle, onClose, children }) {
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [position, setPosition] = useState(null);

  function measure() {
    return positionDashboardMenu(triggerRef.current.getBoundingClientRect(), {
      width: 176,
      height: menuRef.current ? menuRef.current.scrollHeight + 2 : 96,
    }, { width: window.innerWidth, height: window.innerHeight });
  }

  useEffect(() => {
    if (!open) return undefined;
    const frame = window.requestAnimationFrame(() => {
      setPosition(positionDashboardMenu(triggerRef.current.getBoundingClientRect(), {
        width: 176, height: menuRef.current?.scrollHeight || 96,
      }, { width: window.innerWidth, height: window.innerHeight }));
      menuRef.current?.querySelector("button")?.focus();
    });
    const close = (restoreFocus = false) => {
      onClose();
      if (restoreFocus) triggerRef.current?.focus();
    };
    const outside = event => {
      if (!menuRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) close();
    };
    const keyboard = event => {
      if (event.key === "Escape") { event.preventDefault(); close(true); }
      if (event.key === "Tab") {
        const buttons = Array.from(menuRef.current?.querySelectorAll("button") || []);
        const boundary = event.shiftKey ? buttons[0] : buttons.at(-1);
        if (document.activeElement === boundary) close(true);
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const buttons = Array.from(menuRef.current?.querySelectorAll("button") || []);
        const current = buttons.indexOf(document.activeElement);
        const next = (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    };
    const scroll = event => {
      if (!menuRef.current?.contains(event.target)) close(menuRef.current?.contains(document.activeElement));
    };
    const resize = () => close(true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keyboard);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keyboard);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", resize);
    };
  }, [open, onClose]);

  return (
    <div className="doctor-session-actions">
      <button ref={triggerRef} type="button" className="doctor-table-action"
        aria-label={"Open actions for " + patient} aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setPosition(measure()); onToggle(); }}>
        <Icon icon="solar:menu-dots-bold" />
      </button>
      {open && position ? createPortal(
        <div ref={menuRef} className="doctor-dashboard-session-menu" role="menu"
          aria-label={"Actions for " + patient} data-direction={position.direction}
          style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}>
          {children}
        </div>, document.body) : null}
    </div>
  );
}
