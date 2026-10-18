import { useLayoutEffect } from "react";

// Section identity deliberately excludes query/state changes used by in-page previews.
export function usePatientSectionScroll(section, enabled, mainRef) {
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    return () => { window.history.scrollRestoration = previous; };
  }, [enabled]);

  useLayoutEffect(() => {
    if (!enabled) return;
    // The main region (header and page together) owns scrolling; reset before paint without remounting data.
    mainRef.current?.scrollTo({ top: 0, left: 0, behavior: "instant" });
    document.scrollingElement?.scrollTo({ top: 0, left: 0, behavior: "instant" });
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [section, enabled, mainRef]);

  useLayoutEffect(() => {
    if (!enabled) return undefined;
    const shell = mainRef.current?.closest(".pwa-shell");
    if (!shell) return undefined;
    const previous = shell.style.getPropertyValue("--pwa-viewport-height");
    const resize = () => shell.style.setProperty("--pwa-viewport-height",
      `${Math.min(window.innerHeight, window.visualViewport?.height || window.innerHeight)}px`);
    resize();
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      if (previous) shell.style.setProperty("--pwa-viewport-height", previous);
      else shell.style.removeProperty("--pwa-viewport-height");
    };
  }, [enabled, mainRef]);

  useLayoutEffect(() => {
    const scroller = mainRef.current;
    if (!enabled || !scroller) return undefined;
    const previousOverflow = scroller.style.overflowY;
    let locked = false;
    let position;
    const syncLock = () => {
      const hasModal = [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')]
        .some(dialog => dialog.getClientRects().length > 0);
      const nextLocked = document.body.style.overflow === "hidden" || hasModal;
      if (nextLocked === locked) return;
      locked = nextLocked;
      if (locked) {
        position = { top: scroller.scrollTop, left: scroller.scrollLeft, behavior: "instant" };
        scroller.style.overflowY = "hidden";
      } else {
        scroller.style.overflowY = previousOverflow;
        scroller.scrollTo(position);
      }
    };
    syncLock();
    const observer = new MutationObserver(syncLock);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["style", "open", "aria-modal", "hidden"] });
    return () => {
      observer.disconnect();
      scroller.style.overflowY = previousOverflow;
    };
  }, [section, enabled, mainRef]);
}
