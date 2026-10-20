import { useLayoutEffect, useRef } from "react";

const messages = {
  staff: {
    initial: "Initial assessment saved successfully.",
    follow_up: "Follow-up assessment saved successfully.",
  },
  doctor: {
    initial: "Initial visit record saved successfully.",
    follow_up: "Follow-up visit record saved successfully.",
  },
};

// Presentation-only handoff after the existing form verifies its backend receipt.
export function useClinicalSaveFeedback(workspace, location, navigate, showSuccessMessage) {
  const consumedKey = useRef(null);
  useLayoutEffect(() => {
    const saved = location.state?.clinicalSave;
    if (location.pathname.replace(/\/$/, "") !== `/${workspace}/appointments` ||
        saved?.workspace !== workspace || !Object.hasOwn(messages[workspace] || {}, saved.visitType) ||
        consumedKey.current === location.key) return;

    const page = document.querySelector(`.${workspace}-appointments-page`);
    if (!page) return;
    consumedKey.current = location.key;

    // The Doctor/Staff shell can retain nested scroll offsets across form routes.
    // Reset only this destination's ancestors, preserving horizontal positions.
    for (let element = page; element; element = element.parentElement) {
      element.scrollTo({ top: 0, left: element.scrollLeft, behavior: "instant" });
    }
    window.scrollTo({ top: 0, behavior: "instant" });
    showSuccessMessage({ title: "Saved successfully", message: messages[workspace][saved.visitType] });

    // Consume the transient feedback without changing filters, query or other state.
    const state = { ...location.state };
    delete state.clinicalSave;
    navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, {
      replace: true,
      state,
    });
  }, [workspace, location, navigate, showSuccessMessage]);
}
