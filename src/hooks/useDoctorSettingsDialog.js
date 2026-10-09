import { useEffect, useRef } from "react";

const controls = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';

function visible(element) {
  if (!element?.isConnected || element.closest('[hidden], [inert]')) return false;
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  return style.visibility !== "hidden" && style.visibility !== "collapse" && element.getClientRects().length > 0;
}

function enabled(element) {
  return visible(element) && !element.matches(':disabled, [aria-disabled="true"]');
}

// Only the Doctor workspace is blocked. The clinic inactivity dialog remains
// outside this boundary and takes priority when its provider makes us inert.
export function manageDoctorSettingsDialog(dialog, close, trigger) {
  const doc = dialog.ownerDocument;
  const root = dialog.closest('.doctor-dashboard') || dialog.closest('.doctor-settings-page');
  const previousInert = new Map();
  const usable = () => visible(dialog);
  const tabbable = () => [...dialog.querySelectorAll(controls)]
    .filter(element => enabled(element) && element.tabIndex >= 0)
    .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
  const focusInitial = () => {
    if (!usable()) return;
    const preferred = [...dialog.querySelectorAll('[data-dialog-initial-focus]')].find(enabled);
    (preferred || tabbable()[0] || dialog).focus({ preventScroll: true });
  };
  const blockBackground = () => {
    if (!root) return;
    for (let branch = dialog; branch !== root && branch.parentElement; branch = branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || previousInert.has(sibling)) continue;
        previousInert.set(sibling, sibling.hasAttribute('inert'));
        sibling.setAttribute('inert', '');
      }
    }
  };
  const keepFocus = () => {
    if (!usable()) return;
    if (!dialog.contains(doc.activeElement) || !enabled(doc.activeElement)) focusInitial();
  };
  const keydown = event => {
    if (!usable()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(); // The existing close handler decides whether busy work can close.
    } else if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      const candidates = tabbable();
      const current = candidates.indexOf(doc.activeElement);
      const next = event.shiftKey
        ? (current <= 0 ? candidates.length - 1 : current - 1)
        : (current + 1) % candidates.length;
      (candidates[next] || dialog).focus({ preventScroll: true });
    }
  };
  const preventBackgroundScroll = event => {
    if (usable() && !dialog.contains(event.target)) event.preventDefault();
  };
  blockBackground();
  doc.addEventListener('keydown', keydown, true);
  doc.addEventListener('focusin', keepFocus, true);
  doc.addEventListener('wheel', preventBackgroundScroll, { passive: false });
  doc.addEventListener('touchmove', preventBackgroundScroll, { passive: false });
  const observer = new doc.defaultView.MutationObserver(() => {
    blockBackground();
    keepFocus();
  });
  if (root) observer.observe(root, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['disabled', 'hidden', 'tabindex', 'style', 'class'] });
  focusInitial();
  return () => {
    observer.disconnect();
    doc.removeEventListener('keydown', keydown, true);
    doc.removeEventListener('focusin', keepFocus, true);
    doc.removeEventListener('wheel', preventBackgroundScroll);
    doc.removeEventListener('touchmove', preventBackgroundScroll);
    for (const [element, wasInert] of previousInert) {
      if (!wasInert) element.removeAttribute('inert');
    }
    if (enabled(trigger)) trigger.focus({ preventScroll: true });
  };
}

export function rememberDoctorSettingsDialogTrigger(ref, event) {
  const element = event.currentTarget;
  ref.current = element.tagName === 'FORM'
    ? element.ownerDocument.activeElement
    : element;
}

export function useDoctorSettingsDialog(open, onClose, triggerRef) {
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    return manageDoctorSettingsDialog(dialog, () => closeRef.current(),
      triggerRef.current || dialog.ownerDocument.activeElement);
  }, [open, triggerRef]);
  return dialogRef;
}
