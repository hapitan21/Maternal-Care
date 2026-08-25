import { Icon } from "@iconify/react";

export function PatientPageHeader({ title, subtitle, eyebrow, action, className = "" }) {
  return (
    <header className={`pwa-page-title pwa-ui-page-header ${className}`.trim()}>
      <div>
        {eyebrow ? <span className="pwa-ui-eyebrow">{eyebrow}</span> : null}
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {action ? <div className="pwa-ui-page-action">{action}</div> : null}
    </header>
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
