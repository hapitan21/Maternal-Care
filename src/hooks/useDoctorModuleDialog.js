import { useLayoutEffect, useRef } from "react";

const controls = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';
const visible = element => {
  if (!element?.isConnected || element.closest('[hidden], [inert]')) return false;
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  return style.visibility !== 'hidden' && style.visibility !== 'collapse' && element.getClientRects().length > 0;
};
const enabled = element => visible(element) && !element.matches(':disabled, [aria-disabled="true"]');

// Doctor body portals only. Settings keeps its established helper unchanged.
export function manageDoctorModuleDialog(dialog, close, trigger) {
  const doc = dialog.ownerDocument;
  const previousInert = new Map();
  const originalTabIndex = dialog.getAttribute('tabindex');
  if (originalTabIndex === null) dialog.setAttribute('tabindex', '-1');
  const regions = () => [dialog, ...[...doc.querySelectorAll('[data-doctor-dialog-owner]')]
    .filter(element => element.getAttribute('data-doctor-dialog-owner') === dialog.id)];
  const contains = element => regions().some(region => region.contains(element));
  const usable = () => visible(dialog) && !doc.querySelector('.inactivity-backdrop');
  const tabbable = () => regions().flatMap(region => [...region.querySelectorAll(controls)])
    .filter(element => enabled(element) && element.tabIndex >= 0);
  const initialFocus = () => {
    if (!usable()) return;
    const preferred = [...dialog.querySelectorAll('[data-dialog-initial-focus]')].find(enabled);
    (preferred || tabbable()[0] || dialog).focus({ preventScroll: true });
  };
  const blockBackground = () => {
    const allowed = regions();
    for (let branch = dialog; branch !== doc.body && branch.parentElement; branch = branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || sibling.matches('.inactivity-backdrop, script, style') ||
            allowed.some(region => sibling === region || sibling.contains(region)) || previousInert.has(sibling)) continue;
        previousInert.set(sibling, sibling.hasAttribute('inert'));
        sibling.setAttribute('inert', '');
      }
    }
  };
  const keepFocus = () => {
    if (usable() && (!contains(doc.activeElement) || !enabled(doc.activeElement))) initialFocus();
  };
  const keydown = event => {
    if (!usable() || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      // Let existing nested time pickers and the owned health-tip popup close first.
      const nestedOpen = [...dialog.querySelectorAll('[role="dialog"]')].some(visible);
      if (regions().length > 1 || nestedOpen) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      const candidates = tabbable();
      const current = candidates.indexOf(doc.activeElement);
      const next = event.shiftKey ? (current <= 0 ? candidates.length - 1 : current - 1)
        : (current + 1) % candidates.length;
      (candidates[next] || dialog).focus({ preventScroll: true });
    }
  };
  const preventBackgroundScroll = event => {
    if (usable() && !contains(event.target)) event.preventDefault();
  };
  blockBackground();
  doc.addEventListener('keydown', keydown, true);
  doc.addEventListener('focusin', keepFocus, true);
  doc.addEventListener('wheel', preventBackgroundScroll, { passive: false });
  doc.addEventListener('touchmove', preventBackgroundScroll, { passive: false });
  const observer = new doc.defaultView.MutationObserver(() => { blockBackground(); keepFocus(); });
  observer.observe(doc.body, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['disabled', 'hidden', 'tabindex', 'style', 'class', 'data-doctor-dialog-owner'] });
  initialFocus();
  return () => {
    observer.disconnect();
    doc.removeEventListener('keydown', keydown, true);
    doc.removeEventListener('focusin', keepFocus, true);
    doc.removeEventListener('wheel', preventBackgroundScroll);
    doc.removeEventListener('touchmove', preventBackgroundScroll);
    for (const [element, wasInert] of previousInert) if (!wasInert) element.removeAttribute('inert');
    if (originalTabIndex === null) dialog.removeAttribute('tabindex');
    if (enabled(trigger) && !doc.querySelector('.inactivity-backdrop')) trigger.focus({ preventScroll: true });
  };
}

export function useDoctorModuleDialog(key, selector, onClose) {
  const closeRef = useRef(onClose);
  const triggerRef = useRef(null);
  useLayoutEffect(() => { closeRef.current = onClose; }, [onClose]);
  useLayoutEffect(() => {
    if (key) {
      const dialog = document.querySelector(selector);
      if (dialog) return manageDoctorModuleDialog(dialog, () => closeRef.current(), triggerRef.current || document.activeElement);
      return;
    }
    const remember = event => { triggerRef.current = event.target.closest?.('button, a, input, select, textarea, [tabindex]') || event.target; };
    triggerRef.current = document.activeElement;
    document.addEventListener('focusin', remember, true);
    document.addEventListener('pointerdown', remember, true);
    return () => {
      document.removeEventListener('focusin', remember, true);
      document.removeEventListener('pointerdown', remember, true);
    };
  }, [key, selector]);
}
