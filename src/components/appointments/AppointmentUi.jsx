function joinClasses(...classNames) {
  return classNames.filter(Boolean).join(" ");
}

export function AppointmentPageHeader({
  title,
  subtitle,
  tabs,
  activeTab,
  onTabChange,
  action,
  className,
  titleBlockClassName,
  tabsClassName,
  tabsLabel = "Appointment status",
}) {
  return (
    <header className={joinClasses("appointment-ui-header", className)}>
      <div
        className={joinClasses(
          "appointment-ui-title-block",
          titleBlockClassName
        )}
      >
        <h1>{title}</h1>

        {subtitle ? <p>{subtitle}</p> : null}

        <nav
          className={joinClasses("appointment-ui-tabs", tabsClassName)}
          aria-label={tabsLabel}
        >
          {tabs.map((tab) => (
            <button
              className={activeTab === tab ? "is-active" : ""}
              key={tab}
              type="button"
              onClick={() => onTabChange(tab)}
            >
              {tab}
            </button>
          ))}
        </nav>
      </div>

      {action}
    </header>
  );
}

export function AppointmentToolbar({
  as: Element = "section",
  className,
  children,
}) {
  return (
    <Element className={joinClasses("appointment-ui-toolbar", className)}>
      {children}
    </Element>
  );
}

export function AppointmentControlGroup({
  as: Element = "div",
  label,
  area,
  className,
  children,
  ...props
}) {
  return (
    <Element
      className={joinClasses(
        "appointment-ui-control",
        area ? `appointment-ui-control--${area}` : "",
        className
      )}
      {...props}
    >
      <span className="appointment-ui-control-label">{label}</span>
      {children}
    </Element>
  );
}

export function AppointmentPagination({
  className,
  currentPage,
  pageSize,
  pageSizes,
  totalItems,
  totalPages,
  onPageChange,
  onPageSizeChange,
}) {
  const start = totalItems ? (currentPage - 1) * pageSize + 1 : 0;
  const end = Math.min(currentPage * pageSize, totalItems);

  return (
    <div className={joinClasses("appointment-ui-pagination", className)}>
      <span>
        Showing {start}-{end} of {totalItems}
      </span>

      <label>
        Rows
        <select
          value={pageSize}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
          aria-label="Rows per page"
        >
          {pageSizes.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>

      <div>
        <button
          type="button"
          onClick={() => onPageChange(Math.max(1, currentPage - 1))}
          disabled={currentPage <= 1}
          aria-label="Previous appointments page"
        >
          Previous
        </button>

        <span aria-label={`Page ${currentPage} of ${totalPages}`}>
          {currentPage} / {totalPages}
        </span>

        <button
          type="button"
          onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
          disabled={currentPage >= totalPages}
          aria-label="Next appointments page"
        >
          Next
        </button>
      </div>
    </div>
  );
}
