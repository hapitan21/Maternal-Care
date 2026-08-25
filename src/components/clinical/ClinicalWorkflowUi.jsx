import { Icon } from "@iconify/react";

function joinClasses(...classNames) {
  return classNames.filter(Boolean).join(" ");
}

export function ClinicalWorkflowHeader({
  title,
  subtitle,
  action,
  className,
  titleId,
}) {
  return (
    <header className={joinClasses("clinical-workflow-header", className)}>
      <div className="clinical-workflow-title-block">
        <h1 id={titleId}>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>

      {action}
    </header>
  );
}

export function ClinicalWorkflowSearch({
  value,
  onChange,
  onClear,
  placeholder,
  ariaLabel,
  className,
}) {
  return (
    <label className={joinClasses("clinical-workflow-search", className)}>
      <Icon icon="solar:magnifer-linear" aria-hidden="true" />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        aria-label={ariaLabel}
      />

      {value && onClear ? (
        <button type="button" aria-label="Clear search" onClick={onClear}>
          <Icon icon="material-symbols:close-rounded" aria-hidden="true" />
        </button>
      ) : null}
    </label>
  );
}
