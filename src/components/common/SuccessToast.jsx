import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "../../styles/success-toast.css";

export default function SuccessToast({ toast, onDismiss, placement = "auto" }) {
  return toast ? <Toast key={toast.id} toast={toast} onDismiss={onDismiss} placement={placement} /> : null;
}

function Toast({ toast, onDismiss, placement }) {
  const rootRef = useRef(null);
  const exitTimer = useRef(null);
  const [closing, setClosing] = useState(false);
  const close = useCallback(() => {
    if (exitTimer.current !== null) return;
    setClosing(true);
    exitTimer.current = window.setTimeout(onDismiss, 180);
  }, [onDismiss]);

  useEffect(() => {
    const timer = window.setTimeout(close, 5000);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(exitTimer.current);
    };
  }, [close]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    // Opt-in to the fixed CSS position already used by appointment toasts.
    if (placement === "top-right") {
      for (const property of ["top", "left", "right"]) root.style.removeProperty(property);
      return undefined;
    }
    const place = () => {
      const mobile = window.innerWidth <= 640;
      const padding = mobile ? 12 : Math.min(42, Math.max(18, window.innerWidth * 0.03));
      const box = root.getBoundingClientRect();
      const leftEdge = document.querySelector(".doctor-reminder-page, .pwa-main")?.getBoundingClientRect().left || padding;
      const candidates = [
        { top: mobile ? 84 : 112, left: window.innerWidth - padding - box.width },
        { top: window.innerHeight - box.height - (mobile ? 92 : 24), left: window.innerWidth - padding - box.width },
        { top: window.innerHeight - box.height - (mobile ? 92 : 24), left: Math.max(padding, leftEdge + 12) },
      ];
      // Preserve the familiar upper-right placement when clear. Larger reminder
      // summaries move away from toolbars and profile menus without moving content.
      const avoid = [...document.querySelectorAll(
        ".doctor-reminder-toolbar, .doctor-reminder-page button, .doctor-reminder-profile, .doctor-reminder-profile-dropdown, .doctor-global-profile-slot, .doctor-profile-dropdown, .pwa-topbar, .pwa-profile-menu, .pwa-page button, .pwa-medication-schedule-toolbar, .pwa-full-save, .pwa-nav"
      )].map((element) => element.getBoundingClientRect()).filter((rect) => rect.width && rect.height);
      // On narrow screens both lower corners can contain actions. Try the
      // measured gaps between controls before falling back to a corner.
      for (const left of new Set(candidates.map((candidate) => candidate.left))) {
        candidates.push(...avoid.map((rect) => ({ top: rect.bottom + 12, left }))
          .sort((first, second) => first.top - second.top));
      }
      const overlaps = (candidate, rect) => candidate.left < rect.right && candidate.left + box.width > rect.left &&
        candidate.top < rect.bottom && candidate.top + box.height > rect.top;
      const position = candidates.find((candidate) => candidate.top >= 12 && candidate.top + box.height <= window.innerHeight - 12 &&
        candidate.left >= 12 && candidate.left + box.width <= window.innerWidth - 12 &&
        !avoid.some((rect) => overlaps(candidate, rect))) || candidates[1];
      root.style.top = `${Math.max(12, position.top)}px`;
      root.style.left = `${Math.max(12, position.left)}px`;
      root.style.right = "auto";
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(root);
    const menus = new MutationObserver(place);
    menus.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      menus.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [placement]);

  return createPortal(
    <aside ref={rootRef} className={`mc-success-toast${placement === "top-right" ? " mc-success-toast--top-right" : ""}${closing ? " is-closing" : ""}`}
      role="status" aria-live="polite" aria-atomic="true">
      <svg className="mc-success-toast__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" />
      </svg>
      <div className="mc-success-toast__copy">
        <strong>{toast.title}</strong>
        {toast.message ? <p>{toast.message}</p> : null}
        {toast.details?.map((detail, index) => <small key={index}>{detail}</small>)}
      </div>
      <button type="button" aria-label="Dismiss success notification" onClick={close} disabled={closing}>
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
      </button>
    </aside>, document.body
  );
}
