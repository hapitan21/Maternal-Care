import React from "react";
import { Icon } from "@iconify/react";
import { useNavigate, useSearchParams } from "react-router-dom";
import AdminAccountStatusDialog from "../../components/admin/AdminAccountStatusDialog";
import AdminPageHeader from "../../components/admin/AdminPageHeader";
import { useAdminAuth } from "../../hooks/useAdminAuth";
import { useAdminUserManagement } from "../../hooks/useAdminUserManagement";
import "../../styles/adminDashboard.css";
import "../../styles/adminUserManagement.css";

const TABS = [
  { key: "patients", label: "Patients", icon: "solar:users-group-rounded-linear" },
  { key: "doctors", label: "Doctors", icon: "solar:stethoscope-linear" },
  { key: "staff", label: "Staff", icon: "solar:user-rounded-linear" },
];

const VALID_TABS = new Set(TABS.map((tab) => tab.key));

const STATUS_OPTIONS = {
  patients: [
    ["all", "All non-archived"],
    ["active", "Active"],
    ["inactive", "Inactive"],
    ["not_linked", "Not Linked"],
    ["archived", "Archived"],
  ],
  clinic: [
    ["all", "All"],
    ["active", "Active"],
    ["inactive", "Inactive"],
  ],
};

const SORT_OPTIONS = [
  ["date", "Date registered"],
  ["name", "Name"],
  ["status", "Account status"],
];

function cleanText(value) {
  return String(value ?? "").trim();
}

function titleCase(value) {
  const text = cleanText(value).replaceAll("_", " ").toLowerCase();
  return text ? text.replace(/\b\w/g, (character) => character.toUpperCase()) : "Unknown";
}

function formatManilaDate(value) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function initials(name) {
  return cleanText(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "UM";
}

function AccountAvatar({ account }) {
  return (
    <span className="admin-user-avatar" aria-hidden="true">
      {initials(account?.name || account?.full_name)}
    </span>
  );
}

function StatusBadge({ status }) {
  const sourceStatus = cleanText(status).toLowerCase().replaceAll("-", "_").replaceAll(" ", "_") || "unknown";
  const normalized = ["inactive", "deactivated", "suspended"].includes(sourceStatus)
    ? "inactive"
    : ["pending", "pending_activation", "temporary", "not_linked"].includes(sourceStatus)
      ? "temporary"
      : sourceStatus;
  return (
    <span className={`admin-user-status is-${normalized}`}>
      {titleCase(normalized)}
    </span>
  );
}

function SummaryCard({ icon, label, counts, loading }) {
  return (
    <article className="admin-user-summary-card" aria-busy={loading}>
      <span className="admin-user-summary-icon"><Icon icon={icon} /></span>
      <div>
        <p>{label}</p>
        {loading ? <span className="admin-user-summary-skeleton" aria-hidden="true" /> : <strong>{counts.total}</strong>}
        {loading ? <span className="admin-user-sr-only">Loading total</span> : null}
      </div>
    </article>
  );
}

function getPageItems(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const values = new Set([1, total, current - 1, current, current + 1]);
  const pages = [...values].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const result = [];
  pages.forEach((page, index) => {
    if (index && page - pages[index - 1] > 1) result.push(`ellipsis-${page}`);
    result.push(page);
  });
  return result;
}

function Pagination({ page, totalPages, pageSize, total, noun, onPage, onPageSize }) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Number(pageSize) || 10);
  const safeTotalPages = Math.max(1, Number(totalPages) || 1);

  const firstRow =
    safeTotal === 0 ? 0 : (safePage - 1) * safePageSize + 1;

  const lastRow =
    safeTotal === 0
      ? 0
      : Math.min(safePage * safePageSize, safeTotal);

  return (
    <footer className="admin-user-pagination" aria-label={`${noun} pagination`}>
      <p>Showing {firstRow}-{lastRow} of {safeTotal} {noun}</p>
      <label>
        Rows
        <select value={safePageSize} onChange={(event) => onPageSize(Number(event.target.value))}>
          {[5, 10, 20].map((size) => <option key={size} value={size}>{size}</option>)}
        </select>
      </label>
      <nav aria-label={`${noun} pages`}>
        <button type="button" onClick={() => onPage(1)} disabled={safePage === 1} aria-label="First page">
          <Icon icon="solar:rewind-back-linear" />
        </button>
        <button type="button" onClick={() => onPage(safePage - 1)} disabled={safePage === 1} aria-label="Previous page">
          <Icon icon="solar:alt-arrow-left-linear" />
        </button>
        <span className="admin-user-page-window">
          {getPageItems(safePage, safeTotalPages).map((item) => typeof item === "string" ? (
            <span className="admin-user-page-ellipsis" key={item} aria-hidden="true">…</span>
          ) : (
            <button
              key={item}
              type="button"
              className={item === safePage ? "is-active" : ""}
              aria-label={`Page ${item}`}
              aria-current={item === safePage ? "page" : undefined}
              onClick={() => onPage(item)}
            >
              {item}
            </button>
          ))}
        </span>
        <button type="button" onClick={() => onPage(safePage + 1)} disabled={safePage === safeTotalPages} aria-label="Next page">
          <Icon icon="solar:alt-arrow-right-linear" />
        </button>
        <button type="button" onClick={() => onPage(safeTotalPages)} disabled={safePage === safeTotalPages} aria-label="Last page">
          <Icon icon="solar:rewind-forward-linear" />
        </button>
      </nav>
    </footer>
  );
}

function getStatusAction(account, type) {
  if (type === "patient" && account.linkStatus !== "linked") return null;
  if (account.accountStatus === "active") return "deactivate";
  if (["inactive", "deactivated", "suspended"].includes(account.accountStatus)) return "reactivate";
  if (type === "patient" && ["pending", "pending_activation"].includes(account.accountStatus)) return "activate";
  return null;
}

function ActionMenu({ account, type, open, onToggle, onAction, buttonRef }) {
  const statusAction = getStatusAction(account, type);
  return (
    <div className="admin-user-action-wrap">
      <button
        ref={buttonRef}
        className="admin-user-action-trigger"
        type="button"
        aria-label={`Open actions for ${account.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Icon icon="solar:menu-dots-bold" />
      </button>
      {open ? (
        <div className="admin-user-action-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => onAction("details", account, type)}>
            <Icon icon="solar:eye-linear" /> View Account
          </button>
          {statusAction ? (
            <button type="button" role="menuitem" onClick={() => onAction(statusAction, account, type)}>
              <Icon icon={statusAction === "deactivate" ? "solar:user-block-linear" : "solar:restart-linear"} />
              {titleCase(statusAction)} Account
            </button>
          ) : (
            <span className="is-disabled" role="menuitem" aria-disabled="true">
              <Icon icon="solar:info-circle-linear" />
              {type === "patient" && account.linkStatus !== "linked"
                ? "This Patient does not have a linked login account."
                : "No account-status action is available."}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

function FilterBar({ type, manager }) {
  const isPatient = type === "patients";
  const prefix = type === "doctors" ? "doctor" : type === "staff" ? "staff" : "";
  const search = isPatient ? manager.search : manager[`${prefix}Search`];
  const setSearch = isPatient ? manager.setSearch : manager[`set${titleCase(prefix)}Search`];
  const status = isPatient ? manager.statusFilter : manager[`${prefix}StatusFilter`];
  const setStatus = isPatient ? manager.setStatusFilter : manager[`set${titleCase(prefix)}StatusFilter`];
  const sort = isPatient ? manager.sortBy : manager[`${prefix}SortBy`];
  const setSort = isPatient ? manager.setSortBy : manager[`set${titleCase(prefix)}SortBy`];
  const secondary = type === "doctors" ? manager.doctorSpecialtyFilter : manager.staffPositionFilter;
  const setSecondary = type === "doctors" ? manager.setDoctorSpecialtyFilter : manager.setStaffPositionFilter;
  const options = type === "doctors" ? manager.doctorSpecialtyOptions : manager.staffPositionOptions;
  return (
    <div className={`admin-user-toolbar is-${type}`}>
      <label className="admin-user-search">
        <span>Search</span>
        <Icon icon="solar:magnifer-linear" />
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={isPatient
            ? "Search patients by ID, name, contact, or email..."
            : type === "doctors"
              ? "Search doctors by ID, name, email, or certification..."
              : "Search staff by ID, name, email, or position..."}
        />
      </label>
      <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}>
        {(isPatient ? STATUS_OPTIONS.patients : STATUS_OPTIONS.clinic).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      {!isPatient ? <label><span>{type === "doctors" ? "Board Certification" : "Position"}</span><select value={secondary} onChange={(event) => setSecondary(event.target.value)}>
        <option value="all">All</option>{options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select></label> : null}
      <label><span>Sort by</span><select value={sort} onChange={(event) => setSort(event.target.value)}>
        {SORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
    </div>
  );
}

function UserTable({ type, manager, openMenuId, setOpenMenuId, onAction, actionRefs }) {
  const rows = manager[type];
  const isPatient = type === "patients";
  const singular = type === "staff" ? "staff" : type.slice(0, -1);
  const columns = isPatient
    ? ["Control No.", "Patient Name", "Contact Number", "Status", "Date Registered", "Actions"]
    : [type === "doctors" ? "Doctor ID" : "Staff ID", titleCase(singular), type === "doctors" ? "Board Certification" : "Position", "Status", "Registered", "Actions"];
  return (
    <>
      <FilterBar type={type} manager={manager} />
      <div className={`admin-user-table-scroll${openMenuId ? " has-open-menu" : ""}`}>
        <table className="admin-user-table">
          <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>
            {manager.loading ? <tr><td colSpan="6" className="admin-user-empty">Loading {type}…</td></tr> : null}
            {!manager.loading && !rows.length ? <tr><td colSpan="6" className="admin-user-empty">No {type} match the current filters.</td></tr> : null}
            {!manager.loading && rows.map((account) => (
              <tr key={account.id}>
                <td data-label={columns[0]}>{account.displayId}</td>
                <td data-label={columns[1]}>
                  <div className="admin-user-person">
                    <AccountAvatar account={account} />
                    <div>
                      <button
                        type="button"
                        className="admin-user-name-button"
                        onClick={() => onAction("details", account, singular)}
                      >
                        <strong>{account.name}</strong>
                      </button>
                      {!isPatient && account.email ? <small>{account.email}</small> : null}
                    </div>
                  </div>
                </td>
                <td data-label={columns[2]}>{isPatient ? account.contact || "Not recorded" : account.secondaryText || "Not recorded"}</td>
                <td data-label={columns[3]}><StatusBadge status={account.accountStatus} /></td>
                <td data-label={columns[4]}>{formatManilaDate(account.createdAt)}</td>
                <td data-label="Actions">
                  <ActionMenu
                    account={account}
                    type={singular}
                    open={openMenuId === account.id}
                    buttonRef={(node) => { if (node) actionRefs.current[account.id] = node; }}
                    onToggle={() => setOpenMenuId((current) => current === account.id ? "" : account.id)}
                    onAction={onAction}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination
        page={isPatient ? manager.page : manager[`${singular}Page`]}
        totalPages={isPatient ? manager.totalPages : manager[`${singular}TotalPages`]}
        pageSize={isPatient ? manager.pageSize : manager[`${singular}PageSize`]}
        total={isPatient ? manager.totalFilteredPatients : manager[`totalFiltered${titleCase(type)}`]}
        noun={type}
        onPage={isPatient ? manager.setPage : manager[`set${titleCase(singular)}Page`]}
        onPageSize={isPatient ? manager.setPageSize : manager[`set${titleCase(singular)}PageSize`]}
      />
    </>
  );
}

export default function AdminUserManagement() {
  const { isAdmin } = useAdminAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const activeTab = VALID_TABS.has(requestedTab) ? requestedTab : "patients";
  const [openMenuId, setOpenMenuId] = React.useState("");
  const [confirmState, setConfirmState] = React.useState(null);
  const [modalError, setModalError] = React.useState("");
  const actionRefs = React.useRef({});
  const manager = useAdminUserManagement({ enabled: isAdmin, activeTab });

  React.useEffect(() => {
    const close = (event) => {
      if (!event.target.closest?.(".admin-user-action-wrap")) setOpenMenuId("");
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const returnFocus = React.useCallback((id) => {
    window.setTimeout(() => actionRefs.current[id]?.focus(), 0);
  }, []);

  const closeConfirm = React.useCallback(() => {
    if (manager.saving) return;
    const id = confirmState?.account?.id;
    setConfirmState(null);
    setModalError("");
    if (id) returnFocus(id);
  }, [confirmState?.account?.id, manager.saving, returnFocus]);

  const onAction = (action, account, type) => {
    setOpenMenuId("");
    setModalError("");
    if (action !== "details") {
      setConfirmState({ action, account, type });
      return;
    }
    navigate(`/admin/user-management/${type}/${account.id}`);
  };

  const confirmAction = async () => {
    if (!confirmState || manager.saving) return;
    setModalError("");
    const result = await manager.updateAccountStatus(confirmState.type, confirmState.account, confirmState.action);
    if (!result.ok) {
      setModalError(result.error || "Unable to change account access.");
      return;
    }
    closeConfirm();
  };

  return (
    <div className="admin-user-page">
      <AdminPageHeader title="User Management" subtitle="Manage patient, doctor, and staff accounts" />
      <section className="admin-user-summary-grid" aria-label="User Management totals">
        <SummaryCard icon="solar:users-group-rounded-bold" label="Total Patients" counts={manager.summary.patients} loading={manager.summaryLoading} />
        <SummaryCard icon="solar:stethoscope-bold" label="Total Doctors" counts={manager.summary.doctors} loading={manager.summaryLoading} />
        <SummaryCard icon="solar:user-bold" label="Total Staff" counts={manager.summary.staff} loading={manager.summaryLoading} />
      </section>

      {manager.error ? <div className="admin-user-message is-error" role="alert"><span>{manager.error}</span><button type="button" onClick={manager.refresh}>Retry</button></div> : null}
      {manager.notice ? <div className="admin-user-message is-success" role="status"><span>{manager.notice}</span><button type="button" onClick={() => manager.setNotice("")}>Dismiss</button></div> : null}

      <section className="admin-user-card">
        <div className="admin-user-tabs" role="tablist" aria-label="User types">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              className={activeTab === tab.key ? "is-active" : ""}
              onClick={() => {
                manager.resetPageForTab(tab.key);
                const nextParams = new URLSearchParams(searchParams);
                if (tab.key === "patients") nextParams.delete("tab");
                else nextParams.set("tab", tab.key);
                setSearchParams(nextParams);
                setOpenMenuId("");
              }}
            >
              <Icon icon={tab.icon} /> {tab.label}
            </button>
          ))}
        </div>
        <UserTable type={activeTab} manager={manager} openMenuId={openMenuId} setOpenMenuId={setOpenMenuId} onAction={onAction} actionRefs={actionRefs} />
      </section>

      {confirmState ? (
        <AdminAccountStatusDialog
          state={confirmState}
          saving={manager.saving}
          error={modalError}
          onCancel={closeConfirm}
          onConfirm={confirmAction}
        />
      ) : null}
    </div>
  );
}
