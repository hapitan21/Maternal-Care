import React from "react";
import { Icon } from "@iconify/react";
import { Link, useParams } from "react-router-dom";
import AdminAccountStatusDialog from "../../components/admin/AdminAccountStatusDialog";
import AdminPageHeader from "../../components/admin/AdminPageHeader";
import { useAdminUserManagement } from "../../hooks/useAdminUserManagement";
import "../../styles/adminUserDetails.css";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INACTIVE_STATUSES = new Set([
  "inactive",
  "deactivated",
  "suspended",
  "disabled",
  "blocked",
]);

const PENDING_STATUSES = new Set([
  "pending",
  "pending_activation",
  "pending_registration",
  "temporary",
  "for_activation",
  "awaiting_activation",
]);

const ROLE_CONFIG = {
  doctor: {
    label: "Doctor",
    possessiveAccounts: "Doctor's Accounts",
    idLabel: "Doctor ID",
    subtitle: "View doctor account details and manage account status.",
  },
  staff: {
    label: "Staff",
    possessiveAccounts: "Staff's Accounts",
    idLabel: "Employment ID",
    subtitle: "View staff account details and manage account status.",
  },
};

function cleanText(value) {
  return String(value ?? "").trim();
}

function present(value) {
  return cleanText(value) || "Not recorded";
}

function normalizeStatus(value) {
  return cleanText(value).toLowerCase() || "unknown";
}

function getStatusKey(value) {
  return normalizeStatus(value).replace(/[\s-]+/g, "_");
}

function getStatusAction(value) {
  const status = getStatusKey(value);

  if (status === "active") return "deactivate";
  if (INACTIVE_STATUSES.has(status)) return "reactivate";
  if (PENDING_STATUSES.has(status)) return "activate";

  return "";
}

function getStatusActionLabel(action) {
  if (action === "deactivate") return "Deactivate Account";
  if (action === "reactivate") return "Reactivate Account";
  if (action === "activate") return "Activate Account";
  return "";
}

function titleCase(value) {
  const text = cleanText(value).replaceAll("_", " ").toLowerCase();
  return text ? text.replace(/\b\w/g, (character) => character.toUpperCase()) : "Not recorded";
}

function formatDate(value) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "long",
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

function getDisplayStatus(status) {
  const normalized = getStatusKey(status);

  if (normalized === "active") return "active";
  if (INACTIVE_STATUSES.has(normalized)) return "inactive";
  if (PENDING_STATUSES.has(normalized)) return "pending_activation";

  return normalized;
}

function StatusBadge({ status }) {
  const displayStatus = getDisplayStatus(status);
  return (
    <span className={`admin-user-details-status is-${displayStatus}`}>
      <span aria-hidden="true" />
      {titleCase(displayStatus)}
    </span>
  );
}

function DetailSection({ icon, title, fields }) {
  return (
    <section className="admin-user-details-card">
      <header className="admin-user-details-card-title">
        <span><Icon icon={icon} aria-hidden="true" /></span>
        <h2>{title}</h2>
      </header>
      <dl className="admin-user-details-grid">
        {fields.map(({ label, value }) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{React.isValidElement(value) ? value : present(value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ContactRow({ icon, label, value }) {
  return (
    <div className="admin-user-details-contact-row">
      <span><Icon icon={icon} aria-hidden="true" /></span>
      <div>
        <small>{label}</small>
        <strong>{present(value)}</strong>
      </div>
    </div>
  );
}

function ProfileHero({ detail, config, onStatusAction }) {
  const statusKey = getStatusKey(detail.account_status);
  const statusAction = getStatusAction(statusKey);
  const active = statusKey === "active";
  const pending = statusAction === "activate";
  const statusActionAvailable = Boolean(statusAction);

  const accessMessage = active
    ? `This ${config.label.toLowerCase()} account is active and has access to the system.`
    : pending
      ? `This ${config.label.toLowerCase()} account is pending activation and cannot access the system yet.`
      : `This ${config.label.toLowerCase()} account is inactive and cannot access the system.`;

  const actionIcon =
    statusAction === "deactivate"
      ? "solar:user-block-linear"
      : statusAction === "reactivate"
        ? "solar:restart-linear"
        : "solar:user-check-linear";

  return (
    <section className="admin-user-details-hero">
      <div className="admin-user-details-identity">
        <div className="admin-user-details-person">
          <span className="admin-user-details-avatar" aria-hidden="true">
            {detail.avatar_url ? <img src={detail.avatar_url} alt="" /> : initials(detail.full_name)}
          </span>
          <div>
            <div className="admin-user-details-name-row">
              <h2>{present(detail.full_name)}</h2>
              <StatusBadge status={detail.account_status} />
            </div>
            <small>{config.idLabel}: {present(detail.display_id)}</small>
          </div>
        </div>

        <div className={`admin-user-details-access-notice ${active ? "is-active" : "is-inactive"}`}>
          <Icon
            icon={active ? "solar:verified-check-bold" : "solar:shield-warning-bold"}
            aria-hidden="true"
          />
          <span>{accessMessage}</span>
        </div>

        {statusActionAvailable ? (
          <button
            className={`admin-user-details-status-action ${active ? "is-danger" : "is-activate"}`}
            type="button"
            onClick={onStatusAction}
          >
            <Icon icon={actionIcon} aria-hidden="true" />
            {getStatusActionLabel(statusAction)}
          </button>
        ) : (
          <p className="admin-user-details-action-unavailable">
            No account-status action is available for this status.
          </p>
        )}
      </div>

      <aside className="admin-user-details-contacts" aria-label={`${config.label} contact information`}>
        <ContactRow icon="solar:letter-linear" label="Email" value={detail.email} />
        <ContactRow icon="solar:phone-calling-linear" label="Contact Number" value={detail.contact_number} />
      </aside>
    </section>
  );
}

function ProfileState({ type = "loading", message, onRetry, backTo }) {
  return (
    <section className={`admin-user-details-state is-${type}`} role={type === "loading" ? "status" : "alert"}>
      <Icon
        icon={type === "loading" ? "solar:refresh-circle-linear" : type === "not-found" ? "solar:user-cross-linear" : "solar:danger-triangle-linear"}
        aria-hidden="true"
      />
      <h2>{type === "loading" ? "Loading account profile" : type === "not-found" ? "Account not found" : "Unable to load account profile"}</h2>
      <p>{message}</p>
      <div>
        {onRetry ? <button type="button" onClick={onRetry}>Try Again</button> : null}
        <Link to={backTo}>Back to User Management</Link>
      </div>
    </section>
  );
}

export default function AdminUserDetails({ userType }) {
  const { id } = useParams();
  const config = ROLE_CONFIG[userType];
  const backTo = `/admin/user-management?tab=${userType === "doctor" ? "doctors" : "staff"}`;
  const {
    loadDetails,
    updateAccountStatus,
    saving,
  } = useAdminUserManagement({ enabled: false, activeTab: `${userType}s` });
  const [detail, setDetail] = React.useState(null);
  const [pageState, setPageState] = React.useState("loading");
  const [error, setError] = React.useState("");
  const [success, setSuccess] = React.useState("");
  const [confirmState, setConfirmState] = React.useState(null);
  const [modalError, setModalError] = React.useState("");
  const requestRef = React.useRef(0);

  const loadAccount = React.useCallback(async () => {
    const requestId = ++requestRef.current;
    setDetail(null);
    setError("");
    setPageState("loading");

    if (!config || !UUID_PATTERN.test(id || "")) {
      if (requestId === requestRef.current) {
        setError("The requested Admin User Management account does not exist.");
        setPageState("not-found");
      }
      return;
    }

    const result = await loadDetails(userType, id);
    if (requestId !== requestRef.current) return;
    if (!result.ok) {
      const message = result.error || "The account profile could not be loaded.";
      setError(message);
      setPageState(message.toLowerCase().includes("not found") ? "not-found" : "error");
      return;
    }

    if (
      !result.detail?.id
      || result.detail.type !== userType
      || cleanText(result.detail.id).toLowerCase() !== cleanText(id).toLowerCase()
    ) {
      setError("The requested Admin User Management account does not exist.");
      setPageState("not-found");
      return;
    }

    setDetail(result.detail);
    setPageState("ready");
  }, [config, id, loadDetails, userType]);

  React.useEffect(() => {
    const timer = window.setTimeout(loadAccount, 0);
    return () => {
      requestRef.current += 1;
      window.clearTimeout(timer);
    };
  }, [loadAccount]);

  const openStatusAction = () => {
    if (!detail) return;

    const status = getStatusKey(detail.account_status);
    const action = getStatusAction(status);

    if (!action) {
      setModalError("No account-status action is available for this status.");
      return;
    }

    setModalError("");
    setConfirmState({
      action,
      type: userType,
      account: {
        id: detail.id,
        name: detail.full_name,
        accountStatus: status,
      },
    });
  };

  const closeConfirm = React.useCallback(() => {
    if (saving) return;
    setConfirmState(null);
    setModalError("");
  }, [saving]);

  const confirmStatusAction = async () => {
    if (!confirmState || saving) return;
    setModalError("");
    const result = await updateAccountStatus(
      confirmState.type,
      confirmState.account,
      confirmState.action
    );
    if (!result.ok) {
      setModalError(result.error || "Unable to change account access.");
      return;
    }

    const nextStatus = confirmState.action === "deactivate" ? "inactive" : "active";
    const accountName = confirmState.account.name;
    setDetail((current) => current ? { ...current, account_status: nextStatus } : current);
    setSuccess(`${accountName} was ${confirmState.action === "deactivate" ? "deactivated" : "activated"}.`);
    setConfirmState(null);

    const refreshRequestId = ++requestRef.current;
    const freshResult = await loadDetails(userType, id);
    if (refreshRequestId === requestRef.current && freshResult.ok && freshResult.detail?.id === id) {
      setDetail(freshResult.detail);
    }
  };

  const pageTitle = `${config?.label || "Account"} Profile`;
  const breadcrumbName = detail?.full_name || "Account Details";

  const personalFields = detail ? (userType === "doctor" ? [
    { label: "Full Name", value: detail.full_name },
    { label: "Email Address", value: detail.email },
    { label: "Contact Number", value: detail.contact_number },
  ] : [
    { label: "Full Name", value: detail.full_name },
    { label: "Employment ID", value: detail.display_id },
    { label: "Position", value: detail.position },
    { label: "Email Address", value: detail.email },
    { label: "Contact Number", value: detail.contact_number },
  ]) : [];

  const professionalFields = detail && userType === "doctor" ? [
    { label: "Doctor ID", value: detail.display_id },
    { label: "Board Certification", value: detail.board_certification },
    { label: "License Number", value: detail.license_number },
    { label: "Clinic / Hospital", value: detail.clinic_hospital },
  ] : [];

  const accountFields = detail ? [
    { label: "Role", value: config.label },
    { label: "Account Status", value: <StatusBadge status={detail.account_status} /> },
    { label: "Date Created", value: formatDate(detail.created_at) },
  ] : [];

  return (
    <div className="admin-user-details-page">
      <nav className="admin-user-details-breadcrumbs" aria-label="Breadcrumb">
        <Link to={backTo}><Icon icon="solar:arrow-left-linear" aria-hidden="true" />User Management</Link>
        <Icon icon="solar:alt-arrow-right-linear" aria-hidden="true" />
        <span>{config?.possessiveAccounts}</span>
        <Icon icon="solar:alt-arrow-right-linear" aria-hidden="true" />
        <strong aria-current="page">{breadcrumbName}</strong>
      </nav>

      <AdminPageHeader className="admin-user-details-heading" title={pageTitle} subtitle={config?.subtitle} />

      {pageState === "loading" ? (
        <ProfileState message="Retrieving the selected account from User Management…" backTo={backTo} />
      ) : null}
      {pageState === "error" ? (
        <ProfileState type="error" message={error} onRetry={loadAccount} backTo={backTo} />
      ) : null}
      {pageState === "not-found" ? (
        <ProfileState type="not-found" message={error} backTo={backTo} />
      ) : null}

      {pageState === "ready" && detail ? (
        <>
          {success ? (
            <div className="admin-user-details-success" role="status">
              <Icon icon="solar:check-circle-bold" aria-hidden="true" />
              <span>{success}</span>
              <button type="button" onClick={() => setSuccess("")} aria-label="Dismiss status update">Dismiss</button>
            </div>
          ) : null}

          <ProfileHero detail={detail} config={config} onStatusAction={openStatusAction} />

          <div className="admin-user-details-sections">
            <DetailSection icon="solar:user-id-linear" title="Personal Information" fields={personalFields} />
            {userType === "doctor" ? <DetailSection icon="solar:case-round-linear" title="Professional Information" fields={professionalFields} /> : null}
            <DetailSection icon="solar:shield-keyhole-linear" title="Account Information" fields={accountFields} />
          </div>
        </>
      ) : null}

      {confirmState ? (
        <AdminAccountStatusDialog
          state={confirmState}
          saving={saving}
          error={modalError}
          onCancel={closeConfirm}
          onConfirm={confirmStatusAction}
          activateLabel={confirmState.action === "reactivate" ? "Reactivate" : "Activate"}
        />
      ) : null}
    </div>
  );
}
