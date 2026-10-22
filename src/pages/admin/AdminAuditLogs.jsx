import React from "react";
import { Icon } from "@iconify/react";
import { useAdminAuditLogs } from "../../hooks/useAdminAuditLogs";
import { useAdminAuth } from "../../hooks/useAdminAuth";
import AdminPageHeader from "../../components/admin/AdminPageHeader";
import { getManilaDateKey, toManilaISOString } from "../../lib/appointmentDate";
import { getAuditEventDetails } from "../../lib/adminAuditPresentation";
import "../../styles/adminDashboard.css";
import "../../styles/AdminAuditLogs.css";

const canonicalModules = [
  "authentication",
  "user_management",
  "patient_management",
  "appointment_management",
  "reminder_management",
  "visit_records",
  "reports",
  "system_settings",
];

const canonicalActions = [
  "create",
  "update",
  "delete",
  "login",
  "logout",
  "activate",
  "deactivate",
  "reactivate",
  "cancel",
  "reschedule",
  "check_in",
  "complete",
  "export",
  "print",
  "archive",
  "link",
  "register",
  "finish",
  "acknowledge",
  "reassign",
  "role_change",
  "settings_update",
];

const patientControlNumberPattern = /^(?:pat|lp|control|ctrl)[\s_-]*\d/i;

function addDays(dateKey, amount) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function getDefaultRange() {
  const today = getManilaDateKey(new Date());
  return { from: addDays(today, -6), to: today };
}

function titleCaseToken(value, fallback = "Unknown") {
  const text = String(value || "").trim();
  if (!text) return fallback;
  return text
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function roleLabel(value) {
  const role = String(value || "").trim().toLowerCase().replace(/[_-]+/g, " ");
  if (role === "admin" || role === "administrator" || role === "system administrator") {
    return "System Administrator";
  }
  if (role.includes("doctor")) return "Doctor";
  if (role.includes("staff")) return "Staff";
  if (role.includes("patient")) return "Patient";
  return role ? titleCaseToken(role) : "System";
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function formatFullTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(date);
}

function optionalText(value) {
  return String(value ?? "").trim() || "Not recorded";
}

function actorDisplayName(row) {
  const name = String(row?.actor_name ?? "").trim();
  if (name && !/^(?:unknown user|system)$/i.test(name)) return name;
  if (row?.actor_user_id) return `Actor ${String(row.actor_user_id).slice(0, 8)}…`;
  return name || "System";
}

function safeTargetId(row) {
  const value = String(row?.entity_id ?? "").trim();
  if (!value) return "";
  if (patientControlNumberPattern.test(value)) return "Not displayed";
  return value;
}

function formatTarget(row) {
  const type = String(row?.entity_type ?? "").trim();
  const id = safeTargetId(row);
  if (!type && !id) return "—";
  if (!type) return id;
  if (!id) return titleCaseToken(type);
  return `${titleCaseToken(type)} • ${id}`;
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function getActorOptions(rows) {
  const actors = new Map();
  rows.forEach((row) => {
    if (!row.actor_user_id || actors.has(row.actor_user_id)) return;
    actors.set(row.actor_user_id, {
      id: row.actor_user_id,
      name: actorDisplayName(row),
      role: roleLabel(row.actor_role),
    });
  });
  return [...actors.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function pageNumbers(page, pageCount) {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);
  const values = new Set([1, pageCount, page - 1, page, page + 1]);
  const sorted = [...values].filter((number) => number >= 1 && number <= pageCount).sort((a, b) => a - b);
  const result = [];
  sorted.forEach((number, index) => {
    if (index && number - sorted[index - 1] > 1) result.push(`ellipsis-${number}`);
    result.push(number);
  });
  return result;
}

function ActionBadge({ action }) {
  const value = String(action || "other").trim().toLowerCase() || "other";
  const classToken = value.replace(/[^a-z0-9]+/g, "-");
  return <span className={`admin-audit-action is-${classToken}`}>{titleCaseToken(value)}</span>;
}

function AuditEventDetails({ event, onClose }) {
  const dialogRef = React.useRef(null);
  const closeButtonRef = React.useRef(null);

  React.useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const restoreFocusTarget = document.activeElement;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);

    const handleKeyDown = (keyboardEvent) => {
      if (keyboardEvent.key === "Escape") {
        onClose();
        return;
      }
      if (keyboardEvent.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (keyboardEvent.shiftKey && document.activeElement === first) {
        keyboardEvent.preventDefault();
        last.focus();
      } else if (!keyboardEvent.shiftKey && document.activeElement === last) {
        keyboardEvent.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => restoreFocusTarget?.focus());
    };
  }, [onClose]);

  const targetId = safeTargetId(event);
  const details = [
    ["Event ID", optionalText(event.id)],
    ["Full Timestamp", formatFullTimestamp(event.created_at)],
    ["Actor", actorDisplayName(event)],
    ["Actor ID", optionalText(event.actor_user_id)],
    ["Actor Role", roleLabel(event.actor_role)],
    ["Module", titleCaseToken(event.module)],
    ["Action", titleCaseToken(event.action)],
    ["Status", titleCaseToken(event.status, "Not recorded")],
    ["Target Type", event.entity_type ? titleCaseToken(event.entity_type) : "Not recorded"],
    ["Target ID", targetId || "Not recorded"],
    ["IP Address", optionalText(event.ip_address)],
    ...getAuditEventDetails(event),
  ];

  return (
    <div
      className="admin-audit-detail-backdrop"
      role="presentation"
      onMouseDown={(mouseEvent) => mouseEvent.target === mouseEvent.currentTarget && onClose()}
    >
      <section
        ref={dialogRef}
        className="admin-audit-detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-audit-detail-title"
      >
        <header>
          <div>
            <p>Administrative history</p>
            <h2 id="admin-audit-detail-title">Audit Event Details</h2>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Close audit event details">
            <Icon icon="solar:close-circle-linear" />
          </button>
        </header>
        <dl className="admin-audit-detail-grid">
          {details.map(([label, value]) => (
            <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
          ))}
        </dl>
        <div className="admin-audit-detail-description">
          <h3>Full Description</h3>
          <p>{optionalText(event.description)}</p>
        </div>
        <footer><button type="button" onClick={onClose}>Close</button></footer>
      </section>
    </div>
  );
}

function AuditTable({ rows, count, page, pageSize, onPageChange, onViewDetails }) {
  const pageCount = Math.max(1, Math.ceil(count / pageSize));
  const safePage = Math.min(page, pageCount);
  const first = count ? (safePage - 1) * pageSize + 1 : 0;
  const last = rows.length ? Math.min(first + rows.length - 1, count) : 0;
  return (
    <section className="admin-audit-table-card">
      <h2>Audit Logs Details</h2>
      <div className="admin-audit-table-wrap" role="region" aria-label="Audit log details table" tabIndex={0}>
        <table>
          <thead><tr><th>Date and Time</th><th>User</th><th>Role</th><th>Activity</th><th>Module</th><th>Affected Record</th><th>Status</th><th>Description</th><th>Action</th></tr></thead>
          <tbody>
            {rows.length ? rows.map((row) => (
              <tr key={row.id}>
                <td>{formatDateTime(row.created_at)}</td>
                <td><strong title={row.actor_user_id || undefined}>{actorDisplayName(row)}</strong></td>
                <td>{roleLabel(row.actor_role)}</td>
                <td><ActionBadge action={row.action} /></td>
                <td>{titleCaseToken(row.module)}</td>
                <td><span className="admin-audit-target" title={formatTarget(row)}>{formatTarget(row)}</span></td>
                <td>{titleCaseToken(row.status, "Not recorded")}</td>
                <td><span className="admin-audit-description" title={row.description || "No description recorded."}>{row.description || "No description recorded."}</span></td>
                <td><button className="admin-audit-details-button" type="button" onClick={() => onViewDetails(row)}>View Details</button></td>
              </tr>
            )) : null}
          </tbody>
        </table>
      </div>
      <footer className="admin-audit-table-footer">
        <p>Showing {first} to {last} of {count} activities</p>
        <nav aria-label="Audit log pages">
          <button type="button" disabled={safePage === 1} onClick={() => onPageChange(safePage - 1)} aria-label="Previous page"><Icon icon="solar:alt-arrow-left-linear" /></button>
          {pageNumbers(safePage, pageCount).map((item) => typeof item === "string" ? <span key={item}>...</span> : (
            <button key={item} className={item === safePage ? "is-active" : ""} type="button" onClick={() => onPageChange(item)} aria-current={item === safePage ? "page" : undefined}>{item}</button>
          ))}
          <button type="button" disabled={safePage === pageCount} onClick={() => onPageChange(safePage + 1)} aria-label="Next page"><Icon icon="solar:alt-arrow-right-linear" /></button>
        </nav>
      </footer>
    </section>
  );
}

export default function AdminAuditLogs() {
  const { isAdmin, user: adminUser } = useAdminAuth();
  const [range, setRange] = React.useState(getDefaultRange);
  const [user, setUser] = React.useState("all");
  const [role, setRole] = React.useState("all");
  const [module, setModule] = React.useState("all");
  const [action, setAction] = React.useState("all");
  const [status, setStatus] = React.useState("all");
  const [page, setPage] = React.useState(1);
  const [selectedEvent, setSelectedEvent] = React.useState(null);

  const filters = React.useMemo(() => ({
    startIso: toManilaISOString(range.from, "00:00"),
    endIso: toManilaISOString(addDays(range.to, 1), "00:00"),
    user,
    role,
    module,
    action,
    status,
    page,
  }), [action, module, page, range.from, range.to, role, status, user]);
  const audit = useAdminAuditLogs(filters, isAdmin, adminUser?.id);

  const actorOptions = React.useMemo(() => getActorOptions(audit.actorRows), [audit.actorRows]);
  const moduleOptions = React.useMemo(() => uniqueSorted([...canonicalModules, ...audit.analyticsRows.map((row) => row.module)]), [audit.analyticsRows]);
  const actionOptions = React.useMemo(() => uniqueSorted([...canonicalActions, ...audit.analyticsRows.map((row) => row.action)]), [audit.analyticsRows]);
  const closeDetails = React.useCallback(() => setSelectedEvent(null), []);
  const pageOutOfRange = audit.canDisplay && !audit.error && !audit.pageLoading
    && page > Math.max(1, Math.ceil(audit.count / audit.pageSize));
  React.useEffect(() => {
    if (!pageOutOfRange) return undefined;
    const timer = window.setTimeout(() => setPage(Math.max(1, Math.ceil(audit.count / audit.pageSize))), 0);
    return () => window.clearTimeout(timer);
  }, [audit.count, audit.pageSize, pageOutOfRange]);

  const changeFilter = (setter) => (value) => {
    setter(value);
    setPage(1);
  };
  const updateRange = (field, value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    setRange((current) => {
      if (field === "from") return { from: value, to: value > current.to ? value : current.to };
      return { from: current.from, to: value < current.from ? current.from : value };
    });
    setPage(1);
  };
  const resetFilters = () => {
    setRange(getDefaultRange());
    setUser("all");
    setRole("all");
    setModule("all");
    setAction("all");
    setStatus("all");
    setPage(1);
  };
  return (
    <>
        <AdminPageHeader
          className="admin-audit-title"
          title="Audit Logs"
          subtitle="Track system activities and changes for security and accountability."
        />

        <section className="admin-audit-filter-card" aria-label="Audit log filters">
          <div className="admin-audit-filter admin-audit-filter--date">
            <span>Date Range</span>
            <div><Icon icon="solar:calendar-linear" /><label><span className="admin-sr-only">Start date</span><input type="date" value={range.from} max={range.to} onChange={(event) => updateRange("from", event.target.value)} /></label><b>to</b><label><span className="admin-sr-only">End date</span><input type="date" value={range.to} min={range.from} onChange={(event) => updateRange("to", event.target.value)} /></label></div>
          </div>
          <label className="admin-audit-filter"><span>User</span><select value={user} onChange={(event) => changeFilter(setUser)(event.target.value)}><option value="all">All Users</option>{actorOptions.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.role})</option>)}</select></label>
          <label className="admin-audit-filter"><span>Role</span><select value={role} onChange={(event) => changeFilter(setRole)(event.target.value)}><option value="all">All Roles</option><option value="admin">Admin</option><option value="doctor">Doctor</option><option value="staff">Staff</option><option value="patient">Patient</option></select></label>
          <label className="admin-audit-filter"><span>Module</span><select value={module} onChange={(event) => changeFilter(setModule)(event.target.value)}><option value="all">All Modules</option>{moduleOptions.map((item) => <option key={item} value={item}>{titleCaseToken(item)}</option>)}</select></label>
          <label className="admin-audit-filter"><span>Action</span><select value={action} onChange={(event) => changeFilter(setAction)(event.target.value)}><option value="all">All Actions</option>{actionOptions.map((item) => <option key={item} value={item}>{titleCaseToken(item)}</option>)}</select></label>
          <label className="admin-audit-filter"><span>Status</span><select value={status} onChange={(event) => changeFilter(setStatus)(event.target.value)}><option value="all">All Statuses</option><option value="success">Success</option><option value="failure">Failed</option><option value="rejected">Rejected</option><option value="reported">Reported</option></select></label>
          <div className="admin-audit-filter-actions">
            <button className="admin-audit-reset" type="button" onClick={resetFilters}><Icon icon="solar:restart-linear" /> Reset Filters</button>
            <button className="admin-audit-reset" type="button" onClick={audit.refresh} disabled={audit.refreshing} aria-busy={audit.refreshing}>{audit.refreshing ? "Refreshing..." : "Refresh"}</button>
          </div>
        </section>

        {audit.migrationRequired ? (
          <section className="admin-audit-state is-warning" role="alert"><Icon icon="solar:database-linear" /><div><strong>Audit infrastructure could not be verified.</strong><p>Ask an authorized administrator to review the installed audit definitions.</p></div><button type="button" onClick={audit.refresh}>Retry</button></section>
        ) : audit.error ? (
          <section className="admin-audit-state is-error" role="alert"><Icon icon="solar:danger-triangle-linear" /><div><strong>{audit.canDisplay ? "Refresh failed. Showing previously loaded audit data." : "Unable to load audit logs. Please try again."}</strong></div><button type="button" onClick={audit.refresh}>Retry</button></section>
        ) : null}
        {audit.stale && !audit.error ? <p className="admin-audit-limit-note" role="status">Showing previously loaded data while checking for updates.</p> : null}
        {audit.realtimeError ? <p className="admin-audit-limit-note" role="status">{audit.realtimeError}</p> : null}
        {audit.updatesAvailable ? <p className="admin-audit-limit-note" role="status">New activity may be available. Refresh to update this page; your filters and page selection will be kept.</p> : null}
        {(!audit.error || audit.canDisplay) && !audit.migrationRequired ? (
          <>
            {audit.actorTruncated ? <p className="admin-audit-limit-note" role="status">The User filter is based on a limited event sample and may omit some users. All Users still includes their activities.</p> : null}
            {audit.pageLoading || pageOutOfRange ? <div className="admin-audit-loading" role="status" aria-live="polite"><span /><p>Loading audit logs...</p></div> : audit.count === 0 ? (audit.error ? null : <div className="admin-audit-empty" role="status"><Icon icon="solar:clipboard-list-linear" /><div><p>No recorded {module === "all" ? "audit" : titleCaseToken(module)} activities match {range.from} to {range.to} (Philippine time).</p><small>Try a wider date range or clear the other filters.</small></div></div>) : <AuditTable rows={audit.rows} count={audit.count} page={page} pageSize={audit.pageSize} onPageChange={setPage} onViewDetails={setSelectedEvent} />}
          </>
        ) : null}

        <aside className="admin-audit-info"><Icon icon="solar:info-circle-bold" /><p>Audit logs are automatically recorded for supported important system activities.</p></aside>
        {selectedEvent && audit.canDisplay && audit.rows.some(row => row.id === selectedEvent.id) ? <AuditEventDetails event={selectedEvent} onClose={closeDetails} /> : null}
    </>
  );
}
