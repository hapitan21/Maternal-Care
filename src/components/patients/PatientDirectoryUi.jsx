import { Icon } from "@iconify/react";

function joinClasses(...classNames) {
  return classNames.filter(Boolean).join(" ");
}

export function PatientDirectoryHeader({
  title = "Patients",
  subtitle,
  action,
  className,
}) {
  return (
    <header className={joinClasses("patient-ui-header", className)}>
      <div className="patient-ui-title-block">
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>

      {action}
    </header>
  );
}

export function PatientDirectoryToolbar({
  className,
  searchOnly = false,
  children,
}) {
  return (
    <div
      className={joinClasses(
        "patient-ui-toolbar",
        searchOnly ? "patient-ui-toolbar--search-only" : "",
        className
      )}
    >
      {children}
    </div>
  );
}

export function PatientDirectorySearch({
  value,
  onChange,
  placeholder = "Search by name or ID",
  className,
  ariaLabel = "Search patients by name or ID",
}) {
  return (
    <label className={joinClasses("patient-ui-search", className)}>
      <Icon icon="solar:magnifer-linear" aria-hidden="true" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
    </label>
  );
}

export function PatientTableShell({
  as: Element = "section",
  className,
  scrollClassName,
  children,
  ...props
}) {
  return (
    <Element className={joinClasses("patient-ui-table-card", className)} {...props}>
      <div className={joinClasses("patient-ui-table-scroll", scrollClassName)}>
        {children}
      </div>
    </Element>
  );
}
