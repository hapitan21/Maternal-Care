import { useState } from "react";
import { Icon } from "@iconify/react";
import { useNavigate } from "react-router-dom";
import PatientPushNotificationSettings from "../../components/patient/PatientPushNotificationSettings";
import { PatientPageHeader } from "../../components/patient/PatientPwaUi";
import { supabase } from "../../lib/supabaseClient";
import "../../styles/patient_PWA_settings.css";

const settingsTabs = [
  { key: "profile", label: "Profile", icon: "solar:user-rounded-linear" },
  { key: "account", label: "Account", icon: "solar:user-id-linear" },
  { key: "password", label: "Password & Security", icon: "solar:lock-password-linear" },
  { key: "notifications", label: "Notifications", icon: "solar:bell-linear" },
];

export default function PatientPWASettings({ profile }) {
  const [activeTab, setActiveTab] = useState("profile");
  const navigate = useNavigate();

  const current = settingsTabs.find((item) => item.key === activeTab) || settingsTabs[0];

  return (
    <main className="pwa-page pwa-settings-page">
      <PatientPageHeader
        title="Settings"
        subtitle="Manage your patient account, security, and notification preferences."
        className="pwa-settings-title"
      />

      <div className="pwa-settings-layout">
        <aside className="pwa-settings-tabs" aria-label="Settings sections" role="tablist">
          {settingsTabs.map((item) => (
            <button
              key={item.key}
              type="button"
              id={`settings-tab-${item.key}`}
              role="tab"
              aria-selected={activeTab === item.key}
              aria-controls={`settings-panel-${item.key}`}
              className={activeTab === item.key ? "is-active" : ""}
              onClick={() => setActiveTab(item.key)}
            >
              <Icon icon={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </aside>

        <section
          className="pwa-settings-content"
          id={`settings-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`settings-tab-${activeTab}`}
          tabIndex={0}
        >
          <header className="pwa-settings-section-header">
            <span><Icon icon={current.icon} /></span>
            <div>
              <h2>{current.label} Settings</h2>
              <p>{getSubtitle(activeTab)}</p>
            </div>
          </header>

          {activeTab === "profile" ? (
            <ProfileSettings profile={profile} onManageProfile={() => navigate("/patient/profile")} />
          ) : null}
          {activeTab === "account" ? (
            <AccountSettings profile={profile} onManageProfile={() => navigate("/patient/profile")} />
          ) : null}
          {activeTab === "password" ? <PasswordSettings profile={profile} /> : null}
          {activeTab === "notifications" ? <PatientPushNotificationSettings /> : null}
        </section>
      </div>
    </main>
  );
}

function getSubtitle(tab) {
  switch (tab) {
    case "account":
      return "Manage your account details and information.";
    case "password":
      return "Update your password and manage your account securely.";
    case "notifications":
      return "Manage push notifications for this device.";
    case "profile":
    default:
      return "Manage your personal and pregnancy information.";
  }
}

function ProfileSettings({ profile, onManageProfile }) {
  return (
    <>
      <SettingsCard
        title="Personal Information"
        tone="pink"
        action="Manage in Profile"
        onAction={onManageProfile}
      >
        <SettingsInfo label="Full Name" value={profile.displayName} icon="solar:user-linear" />
        <SettingsInfo label="Gender" value={profile.gender} icon="solar:users-group-rounded-linear" />
        <SettingsInfo label="Date of Birth" value={profile.birthdate} icon="solar:calendar-linear" />
        <SettingsInfo label="Civil Status" value={profile.civilStatus} icon="solar:heart-linear" />
        <SettingsInfo label="Nationality" value={profile.nationality} icon="solar:globus-linear" />
        <SettingsInfo label="Blood Type" value={profile.bloodType} icon="solar:test-tube-linear" />
      </SettingsCard>

      <SettingsCard title="Pregnancy Information" tone="violet" badge="Provider managed">
        <SettingsInfo label="Pregnancy Status" value={profile.pregnancyStatus} icon="solar:user-linear" />
        <SettingsInfo label="Gravida (G)" value={profile.gravida} icon="solar:users-group-rounded-linear" />
        <SettingsInfo label="Current Pregnancy Week" value={`${profile.pregnancyWeek} Weeks`} icon="solar:clock-circle-linear" />
        <SettingsInfo label="Para (P)" value={profile.para} icon="solar:users-group-rounded-linear" />
        <SettingsInfo label="Estimated Due Date" value={profile.dueDate} icon="solar:calendar-linear" />
        <SettingsInfo label="Attending Physician" value={profile.physician} icon="solar:user-id-linear" />
        <SettingsInfo label="Clinic" value={profile.clinic} icon="solar:buildings-3-linear" wide />
        <p className="pwa-settings-note">
          <Icon icon="solar:info-circle-bold" />
          Pregnancy information is maintained by your healthcare provider.
        </p>
      </SettingsCard>

    </>
  );
}

function AccountSettings({ profile, onManageProfile }) {
  const emailStatus = profile.emailVerified === true ? "Verified" : "Unavailable";
  const accountStatus = profile.accountStatus || "Not provided";
  const lastLogin = formatLastLogin(profile.lastLoginAt);

  return (
    <>
      <section className="pwa-settings-card pwa-account-card">
        <header>
          <h3>Account Information</h3>
        </header>

        <div className="pwa-account-form">
          <label>
            <span>Email Address</span>
            <input type="email" value={profile.email || ""} readOnly />
          </label>
          <label>
            <span>Contact Number</span>
            <input type="text" value={profile.phone || ""} readOnly />
          </label>
        </div>

        <div className="pwa-account-guidance">
          <Icon icon="solar:info-circle-bold-duotone" aria-hidden="true" />
          <p>
            Contact details are managed from your Profile. Email changes may require clinic verification.
          </p>
          <button type="button" className="is-outline" onClick={onManageProfile}>
            Open Profile
          </button>
        </div>
      </section>

      <section className="pwa-settings-card pwa-account-status-card">
        <header>
          <span><Icon icon="solar:shield-check-bold-duotone" /></span>
          <h3>Account Status</h3>
        </header>

        <StatusRow
          icon="solar:letter-bold"
          title="Email Verification"
          description={profile.emailVerified === true ? "Your email address is verified." : "Verification status is not available."}
          badge={emailStatus}
        />
        <StatusRow
          icon="solar:user-id-bold"
          title="Account Status"
          description={`Your patient account status is ${accountStatus}.`}
          badge={accountStatus}
        />
        <StatusRow
          icon="solar:clock-circle-bold"
          title="Last Login"
          description={lastLogin}
          badge={profile.lastLoginAt ? "Recorded" : "Unavailable"}
          purple
        />
      </section>
    </>
  );
}

function PasswordSettings({ profile }) {
  const [show, setShow] = useState({ current: false, next: false, confirm: false });
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const toggleField = (field) => setShow((prev) => ({ ...prev, [field]: !prev[field] }));
  const updateField = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

  const savePassword = async (event) => {
    event.preventDefault();
    setMessage("");

    if (form.next !== form.confirm) {
      setMessage("Confirm New Password must match New Password.");
      return;
    }

    if (form.next.length < 8) {
      setMessage("New Password must be at least 8 characters.");
      return;
    }

    setIsSaving(true);

    try {
      const email = profile.email && profile.email !== "Not provided" ? profile.email : "";
      if (!email) {
        throw new Error("Your account email could not be resolved.");
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password: form.current,
      });

      if (signInError) throw signInError;

      const { error: updateError } = await supabase.auth.updateUser({
        password: form.next,
      });

      if (updateError) throw updateError;

      setForm({ current: "", next: "", confirm: "" });
      setMessage("Password updated successfully.");
    } catch (error) {
      setMessage(error?.message || "Unable to update password.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form className="pwa-security-grid" onSubmit={savePassword}>
      <section className="pwa-settings-card pwa-password-card">
        <header>
          <Icon icon="solar:key-bold-duotone" />
          <h3>Change Password</h3>
        </header>

        <PasswordInput
          label="Current Password"
          placeholder="Enter your current password"
          visible={show.current}
          value={form.current}
          onChange={(value) => updateField("current", value)}
          onToggle={() => toggleField("current")}
          autoComplete="current-password"
        />
        <PasswordInput
          label="New Password"
          placeholder="Enter new password"
          visible={show.next}
          value={form.next}
          onChange={(value) => updateField("next", value)}
          onToggle={() => toggleField("next")}
          autoComplete="new-password"
        />
        <PasswordInput
          label="Confirm New Password"
          placeholder="Confirm new password"
          visible={show.confirm}
          value={form.confirm}
          onChange={(value) => updateField("confirm", value)}
          onToggle={() => toggleField("confirm")}
          autoComplete="new-password"
        />

        <p className="pwa-password-help">
          <Icon icon="solar:info-circle-bold" /> Use at least 8 characters. A mix of letters, numbers, and symbols creates a stronger password.
        </p>

        {message ? <p className="pwa-settings-form-message" role="status">{message}</p> : null}
        <button type="submit" className="pwa-full-save" disabled={isSaving}>
          {isSaving ? "Saving..." : "Save Changes"}
        </button>
      </section>

      <section className="pwa-settings-card pwa-security-card">
        <header>
          <Icon icon="solar:shield-bold-duotone" />
          <h3>Security Options</h3>
        </header>

        <SecurityOption
          title="Two-Factor Authentication (2FA)"
          description="Two-factor authentication is not enabled in this Patient PWA yet."
        />
        <SecurityOption
          title="Login Notifications"
          description="Login notification controls are not enabled in this Patient PWA yet."
        />
      </section>
    </form>
  );
}

function SettingsCard({ title, tone, action, onAction, badge, children }) {
  return (
    <section className={`pwa-settings-card pwa-settings-card-${tone}`}>
      <header>
        <h3>{title}</h3>
        {action ? (
          <button type="button" onClick={onAction}>
            <Icon icon="solar:arrow-right-up-linear" /> {action}
          </button>
        ) : null}
        {badge ? <span className="pwa-settings-card-badge">{badge}</span> : null}
      </header>
      <div className="pwa-settings-info-grid">{children}</div>
    </section>
  );
}

function SettingsInfo({ icon, label, value, wide }) {
  return (
    <article className={wide ? "is-wide" : ""}>
      <span><Icon icon={icon} /></span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </article>
  );
}

function StatusRow({ icon, title, description, badge, purple }) {
  return (
    <div className="pwa-status-row">
      <span><Icon icon={icon} /></span>
      <div>
        <strong>{title}</strong>
        <small>{description}</small>
      </div>
      <em className={purple ? "is-purple" : ""}>{badge}</em>
    </div>
  );
}

function PasswordInput({ label, placeholder, visible, value, onChange, onToggle, autoComplete }) {
  return (
    <label className="pwa-password-field">
      <span>{label}</span>
      <div>
        <input
          type={visible ? "text" : "password"}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          required
        />
        <button type="button" onClick={onToggle} aria-label={`Toggle ${label}`}>
          <Icon icon={visible ? "solar:eye-linear" : "solar:eye-closed-linear"} />
        </button>
      </div>
    </label>
  );
}

function SecurityOption({ title, description }) {
  return (
    <article className="pwa-security-toggle">
      <div>
        <h4>{title}</h4>
        <p>{description}</p>
      </div>
      <span className="pwa-security-unavailable">Unavailable</span>
    </article>
  );
}

function formatLastLogin(value) {
  if (!value) return "Last login data is not available.";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Last login data is not available.";

  return date.toLocaleString("en-US", {
    timeZone: "Asia/Manila",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
