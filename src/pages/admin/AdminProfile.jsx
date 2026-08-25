import { Icon } from "@iconify/react";
import { Link } from "react-router-dom";
import { useAdminAuth } from "../../hooks/useAdminAuth";
import "../../styles/adminProfile.css";

function getInitials(name) {
  return String(name || "Admin")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("") || "AD";
}

function formatDateTime(value) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";

  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Manila",
  }).format(date);
}

export default function AdminProfile() {
  const { identity } = useAdminAuth();
  const accountStatus = identity?.profile?.account_status || "Active";
  const createdAt = identity?.authUser?.created_at;
  const lastSignInAt = identity?.authUser?.last_sign_in_at;

  return (
    <section className="admin-profile-page">
      <header className="admin-profile-page__heading">
        <div>
          <p>Account</p>
          <h1>Admin Profile</h1>
          <span>Review your administrator identity and account access details.</span>
        </div>
        <span className="admin-profile-status">
          <Icon icon="solar:shield-check-linear" aria-hidden="true" />
          {accountStatus}
        </span>
      </header>

      <div className="admin-profile-page__grid">
        <article className="admin-profile-summary-card">
          <div className="admin-profile-summary-card__avatar" aria-hidden="true">
            {identity?.avatarUrl ? <img src={identity.avatarUrl} alt="" /> : getInitials(identity?.displayName)}
          </div>
          <div>
            <span>System administrator</span>
            <h2>{identity?.displayName || "Admin profile not found"}</h2>
            <p>{identity?.email || "No email recorded"}</p>
          </div>
        </article>

        <article className="admin-profile-details-card">
          <header>
            <span><Icon icon="solar:user-id-linear" aria-hidden="true" /></span>
            <div>
              <h2>Account details</h2>
              <p>Identity information used by the Admin workspace.</p>
            </div>
          </header>
          <dl>
            <div><dt>Full name</dt><dd>{identity?.displayName || "Not recorded"}</dd></div>
            <div><dt>Email</dt><dd>{identity?.email || "Not recorded"}</dd></div>
            <div><dt>Role</dt><dd>System Admin</dd></div>
            <div><dt>Account created</dt><dd>{formatDateTime(createdAt)}</dd></div>
            <div><dt>Last sign-in</dt><dd>{formatDateTime(lastSignInAt)}</dd></div>
          </dl>
        </article>

        <article className="admin-profile-access-card">
          <header>
            <span><Icon icon="solar:lock-keyhole-linear" aria-hidden="true" /></span>
            <div>
              <h2>Access &amp; security</h2>
              <p>Use the existing system tools to review policy and account activity.</p>
            </div>
          </header>
          <div className="admin-profile-quick-links">
            <Link to="/admin/system-settings">
              <span><Icon icon="solar:settings-linear" aria-hidden="true" /></span>
              <span><strong>System settings</strong><small>Review security and system policies</small></span>
              <Icon icon="solar:alt-arrow-right-linear" aria-hidden="true" />
            </Link>
            <Link to="/admin/audit-logs">
              <span><Icon icon="solar:clipboard-list-linear" aria-hidden="true" /></span>
              <span><strong>Audit logs</strong><small>Review recent administrator activity</small></span>
              <Icon icon="solar:alt-arrow-right-linear" aria-hidden="true" />
            </Link>
          </div>
        </article>
      </div>
    </section>
  );
}
