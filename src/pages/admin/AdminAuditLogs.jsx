import React from "react";
import { Icon } from "@iconify/react";
import { useAdminAuditLogs } from "../../hooks/useAdminAuditLogs";
import { useAdminAuth } from "../../hooks/useAdminAuth";
import AdminPageHeader from "../../components/admin/AdminPageHeader";
import { getManilaDateKey, toManilaISOString } from "../../lib/appointmentDate";
import "../../styles/adminDashboard.css";
import "../../styles/AdminAuditLogs.css";

const moduleColors = [
  "#4dd783",
  "#5b9cf6",
  "#ff6d70",
  "#ffba26",
  "#eb62ad",
  "#8068e8",
  "#22b8b1",
  "#9aa4b6",
];

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

const summaryCards = [
  { key: "total", label: "Total Activity", icon: "solar:document-text-linear", tone: "blue" },
  { key: "auth", label: "Authentication Events", icon: "solar:login-2-linear", tone: "pink" },
  { key: "access", label: "Account Access Changes", icon: "solar:key-square-linear", tone: "green" },
];

const accountAccessActions = new Set(["activate", "deactivate", "reactivate", "role_change"]);
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

function percentage(value, total) {
  if (!total) return "0";
  return Number(((value / total) * 100).toFixed(2)).toString();
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
      name: String(row.actor_name || "Unknown user").trim() || "Unknown user",
      role: roleLabel(row.actor_role),
    });
  });
  return [...actors.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function buildModuleItems(rows) {
  const counts = new Map();
  rows.forEach((row) => {
    const key = String(row.module || "unknown").trim().toLowerCase() || "unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const total = rows.length;
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([key, value], index) => ({
      key,
      label: titleCaseToken(key),
      value,
      percent: percentage(value, total),
      color: moduleColors[index % moduleColors.length],
    }));
}

function getDonutBackground(items) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (!total) return "conic-gradient(#edf0f5 0 100%)";
  let cursor = 0;
  return `conic-gradient(${items
    .map((item) => {
      const start = cursor;
      cursor += (item.value / total) * 100;
      return `${item.color} ${start}% ${cursor}%`;
    })
    .join(",")})`;
}

function buildTimeBuckets(rows, range) {
  const days = Math.max(
    1,
    Math.round((new Date(`${range.to}T00:00:00Z`) - new Date(`${range.from}T00:00:00Z`)) / 86400000) + 1
  );
  const mode = days <= 14 ? "daily" : days <= 90 ? "weekly" : "monthly";
  const buckets = [];

  if (mode === "monthly") {
    let cursor = `${range.from.slice(0, 7)}-01`;
    while (cursor <= range.to) {
      buckets.push({ key: cursor.slice(0, 7), label: new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }).format(new Date(`${cursor}T00:00:00Z`)), value: 0 });
      const date = new Date(`${cursor}T00:00:00Z`);
      date.setUTCMonth(date.getUTCMonth() + 1);
      cursor = date.toISOString().slice(0, 10);
    }
  } else {
    const step = mode === "weekly" ? 7 : 1;
    for (let cursor = range.from; cursor <= range.to; cursor = addDays(cursor, step)) {
      buckets.push({
        key: cursor,
        end: mode === "weekly" ? [addDays(cursor, 6), range.to].sort()[0] : cursor,
        label: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${cursor}T00:00:00Z`)),
        value: 0,
      });
    }
  }

  rows.forEach((row) => {
    const key = getManilaDateKey(row.created_at);
    const bucket = mode === "monthly"
      ? buckets.find((item) => item.key === key.slice(0, 7))
      : buckets.find((item) => key >= item.key && key <= item.end);
    if (bucket) bucket.value += 1;
  });
  return buckets;
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

function SummaryCard({ definition, value, total, loading, truncated }) {
  return (
    <article className="admin-audit-summary-card">
      <span className={`admin-audit-summary-icon is-${definition.tone}`}><Icon icon={definition.icon} /></span>
      <div>
        <p>{definition.label}</p>
        {loading ? <span className="admin-skeleton admin-skeleton--number" /> : <strong>{value}</strong>}
        <small>{definition.key === "total"
          ? "Exact filtered total"
          : truncated
            ? "Count within latest 5,000 matches"
            : `${percentage(value, total)}% of filtered total`}</small>
      </div>
    </article>
  );
}

function ModuleChart({ items, total }) {
  const summary = items.map((item) => `${item.label}: ${item.value}`).join(", ") || "No activity";
  return (
    <section className="admin-audit-chart-card">
      <h2>Activities by Module</h2>
      <div className="admin-audit-module-chart">
        <div className="admin-audit-donut" style={{ background: getDonutBackground(items) }} role="img" aria-label={`Activities by module. ${summary}`}>
          <div><strong>{total}</strong><span>Total</span></div>
        </div>
        <div className="admin-audit-legend">
          {items.length ? items.map((item) => (
            <p key={item.key}><i style={{ backgroundColor: item.color }} /><span>{item.label}</span><strong>{item.value} ({item.percent}%)</strong></p>
          )) : <p className="admin-audit-chart-empty">No module activity in this range.</p>}
        </div>
      </div>
    </section>
  );
}

function TimeChart({ buckets }) {
  const max = Math.max(1, ...buckets.map((item) => item.value));
  const summary = buckets.map((item) => `${item.label}: ${item.value}`).join(", ");
  return (
    <section className="admin-audit-chart-card">
      <h2>Activities Over Time</h2>
      <div className="admin-audit-bars" role="img" aria-label={`Activities over time. ${summary}`}>
        {buckets.map((item) => (
          <div key={item.key}>
            <strong>{item.value}</strong>
            <span><i style={{ height: item.value ? `${Math.max(8, (item.value / max) * 100)}%` : "2px" }} /></span>
            <small>{item.label}</small>
          </div>
        ))}
      </div>
    </section>
  );
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
    ["Full Timestamp", formatFullTimestamp(event.created_at)],
    ["Actor", optionalText(event.actor_name)],
    ["Actor Role", roleLabel(event.actor_role)],
    ["Module", titleCaseToken(event.module)],
    ["Action", titleCaseToken(event.action)],
    ["Status", titleCaseToken(event.status, "Not recorded")],
    ["Target Type", event.entity_type ? titleCaseToken(event.entity_type) : "Not recorded"],
    ["Target ID", targetId || "Not recorded"],
    ["IP Address", optionalText(event.ip_address)],
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
  const last = Math.min(safePage * pageSize, count);
  return (
    <section className="admin-audit-table-card">
      <h2>Audit Logs Details</h2>
      <div className="admin-audit-table-wrap">
        <table>
          <thead><tr><th>Timestamp</th><th>Actor</th><th>Role</th><th>Module</th><th>Action</th><th>Target</th><th>Description</th><th>Details</th></tr></thead>
          <tbody>
            {rows.length ? rows.map((row) => (
              <tr key={row.id}>
                <td>{formatDateTime(row.created_at)}</td>
                <td><strong>{String(row.actor_name || "System").trim() || "System"}</strong></td>
                <td>{roleLabel(row.actor_role)}</td>
                <td>{titleCaseToken(row.module)}</td>
                <td><ActionBadge action={row.action} /></td>
                <td><span className="admin-audit-target" title={formatTarget(row)}>{formatTarget(row)}</span></td>
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
  const { isAdmin } = useAdminAuth();
  const [range, setRange] = React.useState(getDefaultRange);
  const [user, setUser] = React.useState("all");
  const [module, setModule] = React.useState("all");
  const [action, setAction] = React.useState("all");
  const [page, setPage] = React.useState(1);
  const [selectedEvent, setSelectedEvent] = React.useState(null);

  const filters = React.useMemo(() => ({
    startIso: toManilaISOString(range.from, "00:00"),
    endIso: toManilaISOString(addDays(range.to, 1), "00:00"),
    user,
    module,
    action,
    page,
  }), [action, module, page, range.from, range.to, user]);
  const audit = useAdminAuditLogs(filters, isAdmin);

  const actorOptions = React.useMemo(() => getActorOptions(audit.actorRows), [audit.actorRows]);
  const moduleOptions = React.useMemo(() => uniqueSorted([...canonicalModules, ...audit.analyticsRows.map((row) => row.module)]), [audit.analyticsRows]);
  const actionOptions = React.useMemo(() => uniqueSorted([...canonicalActions, ...audit.analyticsRows.map((row) => row.action)]), [audit.analyticsRows]);
  const moduleItems = React.useMemo(() => buildModuleItems(audit.analyticsRows), [audit.analyticsRows]);
  const timeBuckets = React.useMemo(() => buildTimeBuckets(audit.analyticsRows, range), [audit.analyticsRows, range]);
  const counts = React.useMemo(() => ({
    total: audit.count,
    auth: audit.analyticsRows.filter((row) => ["login", "logout"].includes(row.action)).length,
    access: audit.analyticsRows.filter((row) => accountAccessActions.has(row.action)).length,
  }), [audit.analyticsRows, audit.count]);
  const closeDetails = React.useCallback(() => setSelectedEvent(null), []);

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
    setModule("all");
    setAction("all");
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
          <label className="admin-audit-filter"><span>Module</span><select value={module} onChange={(event) => changeFilter(setModule)(event.target.value)}><option value="all">All Modules</option>{moduleOptions.map((item) => <option key={item} value={item}>{titleCaseToken(item)}</option>)}</select></label>
          <label className="admin-audit-filter"><span>Action</span><select value={action} onChange={(event) => changeFilter(setAction)(event.target.value)}><option value="all">All Actions</option>{actionOptions.map((item) => <option key={item} value={item}>{titleCaseToken(item)}</option>)}</select></label>
          <button className="admin-audit-reset" type="button" onClick={resetFilters}><Icon icon="solar:restart-linear" /> Reset Filters</button>
        </section>

        {audit.migrationRequired ? (
          <section className="admin-audit-state is-warning" role="alert"><Icon icon="solar:database-linear" /><div><strong>Audit log storage is not installed yet.</strong><p>Apply the reviewed <code>supabase_admin_audit_logs.sql</code> migration in Supabase, then retry this page.</p></div><button type="button" onClick={audit.refresh}>Retry</button></section>
        ) : audit.error ? (
          <section className="admin-audit-state is-error" role="alert"><Icon icon="solar:danger-triangle-linear" /><div><strong>Unable to load audit logs. Please try again.</strong></div><button type="button" onClick={audit.refresh}>Retry</button></section>
        ) : (
          <>
            <section className="admin-audit-summary-grid" aria-label="Audit activity summary">
              {summaryCards.map((definition) => <SummaryCard
                key={definition.key}
                definition={definition}
                value={counts[definition.key]}
                total={counts.total}
                loading={definition.key === "total" ? audit.pageLoading : audit.analyticsLoading}
                truncated={audit.truncated}
              />)}
            </section>
            {audit.truncated ? <p className="admin-audit-limit-note" role="status">Summary breakdowns and charts are based on the latest 5,000 matching audit events. Total Activity remains exact.</p> : null}
            <div className="admin-audit-chart-grid"><ModuleChart items={moduleItems} total={audit.analyticsRows.length} /><TimeChart buckets={timeBuckets} /></div>
            {audit.pageLoading ? <div className="admin-audit-loading" role="status" aria-live="polite"><span /><p>Loading audit logs...</p></div> : audit.count === 0 ? <div className="admin-audit-empty" role="status"><Icon icon="solar:clipboard-list-linear" /><p>No audit activities found for the selected filters.</p></div> : <AuditTable rows={audit.rows} count={audit.count} page={page} pageSize={audit.pageSize} onPageChange={setPage} onViewDetails={setSelectedEvent} />}
          </>
        )}

        <aside className="admin-audit-info"><Icon icon="solar:info-circle-bold" /><p>Audit logs are automatically recorded for supported important system activities.</p></aside>
        {selectedEvent ? <AuditEventDetails event={selectedEvent} onClose={closeDetails} /> : null}
    </>
  );
}
