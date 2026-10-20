import { createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";

const PatientTopbarSecondaryTargetContext = createContext(null);
const PatientTopbarHeadingTargetContext = createContext(null);

export function PatientTopbarSecondaryProvider({ target, headingTarget = null, children }) {
  return (
    <PatientTopbarSecondaryTargetContext.Provider value={target}>
      <PatientTopbarHeadingTargetContext.Provider value={headingTarget}>
        {children}
      </PatientTopbarHeadingTargetContext.Provider>
    </PatientTopbarSecondaryTargetContext.Provider>
  );
}

export function PatientPageHeader({
  title,
  sharedHeader = false,
  subtitle,
  eyebrow,
  action,
  actionPlacement = "page",
  className = "",
}) {
  const headingTarget = useContext(PatientTopbarHeadingTargetContext);
  const renderHeadingInTopbar = sharedHeader && headingTarget;
  const HeadingContainer = renderHeadingInTopbar ? "div" : "header";
  const topbarSecondaryTarget = useContext(PatientTopbarSecondaryTargetContext);
  const usesTopbarSecondary = actionPlacement === "profile-secondary";
  const renderActionInTopbar = Boolean(action && usesTopbarSecondary && topbarSecondaryTarget);
  const actionElement = action ? <div className="pwa-ui-page-action">{action}</div> : null;

  const heading = (
    <HeadingContainer
      className={`pwa-page-title pwa-ui-page-header ${
        usesTopbarSecondary ? "has-profile-secondary-action" : ""
      } ${className}`.trim()}
    >
      <div>
        {eyebrow ? <span className="pwa-ui-eyebrow">{eyebrow}</span> : null}
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {!renderActionInTopbar ? actionElement : null}
    </HeadingContainer>
  );

  return (
    <>
      {renderHeadingInTopbar ? createPortal(heading, headingTarget) : heading}
      {renderActionInTopbar ? createPortal(actionElement, topbarSecondaryTarget) : null}
    </>
  );
}

export function PatientSectionHeader({ title, subtitle, action, id, className = "" }) {
  return (
    <header className={`pwa-ui-section-header ${className}`.trim()}>
      <div>
        <h2 id={id}>{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {action}
    </header>
  );
}

export function PatientQuickLink({ icon, title, helper, onClick }) {
  return (
    <button type="button" className="pwa-ui-quick-link" onClick={onClick}>
      <span aria-hidden="true">
        <Icon icon={icon} />
      </span>
      <span>
        <strong>{title}</strong>
        <small>{helper}</small>
      </span>
      <Icon icon="solar:alt-arrow-right-linear" aria-hidden="true" />
    </button>
  );
}
