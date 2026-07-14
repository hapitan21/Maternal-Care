import { useState } from "react";
import { Icon } from "@iconify/react";

const settingsTabs = [
  { key: "profile", label: "Profile", icon: "solar:user-rounded-linear" },
  { key: "account", label: "Account", icon: "solar:user-id-linear" },
  { key: "password", label: "Password & Security", icon: "solar:lock-password-linear" },
  { key: "notifications", label: "Notifications & Reminders", icon: "solar:bell-linear" },
];

export default function PatientPWASettings({ profile }) {
  const [activeTab, setActiveTab] = useState("profile");

  const current = settingsTabs.find((item) => item.key === activeTab) || settingsTabs[0];

  return (
    <main className="pwa-page pwa-settings-page">
      <section className="pwa-page-title pwa-settings-title">
        <h1>Settings</h1>
        <p>
          Settings <Icon icon="solar:alt-arrow-right-linear" /> <span>{current.label}</span>
        </p>
      </section>

      <div className="pwa-settings-layout">
        <aside className="pwa-settings-tabs" aria-label="Settings tabs">
          {settingsTabs.map((item) => (
            <button
              key={item.key}
              type="button"
              className={activeTab === item.key ? "is-active" : ""}
              onClick={() => setActiveTab(item.key)}
            >
              <Icon icon={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </aside>

        <section className="pwa-settings-content">
          <header className="pwa-settings-section-header">
            <span><Icon icon={current.icon} /></span>
            <div>
              <h2>{current.label} Settings</h2>
              <p>{getSubtitle(activeTab)}</p>
            </div>
          </header>

          {activeTab === "profile" ? <ProfileSettings profile={profile} /> : null}
          {activeTab === "account" ? <AccountSettings profile={profile} /> : null}
          {activeTab === "password" ? <PasswordSettings /> : null}
          {activeTab === "notifications" ? <NotificationSettings /> : null}
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
      return "Control reminders, health tips, and appointment notifications.";
    case "profile":
    default:
      return "Manage your personal and pregnancy information.";
  }
}

function ProfileSettings({ profile }) {
  return (
    <>
      <SettingsCard title="Personal Information" tone="pink" action="Edit">
        <SettingsInfo label="Full Name" value={profile.displayName} icon="solar:user-linear" />
        <SettingsInfo label="Gender" value={profile.gender} icon="solar:users-group-rounded-linear" />
        <SettingsInfo label="Date of Birth" value={profile.birthdate} icon="solar:calendar-linear" />
        <SettingsInfo label="Civil Status" value={profile.civilStatus} icon="solar:heart-linear" />
        <SettingsInfo label="Nationality" value={profile.nationality} icon="solar:globus-linear" />
        <SettingsInfo label="Blood Type" value={profile.bloodType} icon="solar:test-tube-linear" />
      </SettingsCard>

      <SettingsCard title="Pregnancy Information" tone="violet" action="View Only">
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

      <button className="pwa-save-fixed" type="button">Save Changes</button>
    </>
  );
}

function AccountSettings({ profile }) {
  return (
    <>
      <section className="pwa-settings-card pwa-account-card">
        <header>
          <h3>Account Information</h3>
        </header>

        <div className="pwa-account-form">
          <label>
            <span>Email Address</span>
            <input type="email" defaultValue={profile.email} />
          </label>
          <label>
            <span>Contact Number</span>
            <input type="text" defaultValue={profile.phone} />
          </label>
        </div>

        <div className="pwa-account-actions">
          <button type="button" className="is-solid">Save Changes</button>
          <button type="button" className="is-outline">Change Email</button>
        </div>
      </section>

      <section className="pwa-settings-card pwa-account-status-card">
        <header>
          <span><Icon icon="solar:shield-check-bold-duotone" /></span>
          <h3>Account Status</h3>
        </header>

        <StatusRow icon="solar:letter-bold" title="Email Verification" description="Your email address is verified." badge="Verified" />
        <StatusRow icon="solar:user-id-bold" title="Account Status" description="Your account is active and in good standing." badge="Active" />
        <StatusRow icon="solar:clock-circle-bold" title="Last Login" description="May 19, 2026 - 8:00 AM" badge="Today" purple />
      </section>
    </>
  );
}

function PasswordSettings() {
  const [show, setShow] = useState({ current: false, next: false, confirm: false });
  const [twoFactor, setTwoFactor] = useState(true);
  const [loginNotice, setLoginNotice] = useState(true);

  const toggleField = (field) => setShow((prev) => ({ ...prev, [field]: !prev[field] }));

  return (
    <div className="pwa-security-grid">
      <section className="pwa-settings-card pwa-password-card">
        <header>
          <Icon icon="solar:key-bold-duotone" />
          <h3>Change Password</h3>
        </header>

        <PasswordInput label="Current Password" placeholder="Enter your current password" visible={show.current} onToggle={() => toggleField("current")} />
        <PasswordInput label="New Password" placeholder="Enter new password" visible={show.next} onToggle={() => toggleField("next")} />
        <PasswordInput label="Confirm New Password" placeholder="Confirm new password" visible={show.confirm} onToggle={() => toggleField("confirm")} />

        <p className="pwa-password-help">
          <Icon icon="solar:info-circle-bold" /> Password must be at least 8 characters with a combination of letters, numbers and symbols.
        </p>

        <button type="button" className="pwa-full-save">Save Changes</button>
      </section>

      <section className="pwa-settings-card pwa-security-card">
        <header>
          <Icon icon="solar:shield-bold-duotone" />
          <h3>Security Options</h3>
        </header>

        <SecurityToggle
          title="Two-Factor Authentication (2FA)"
          description="Add an extra layer of security to your account by enabling two-factor authentication."
          checked={twoFactor}
          onChange={setTwoFactor}
        />
        <SecurityToggle
          title="Login Notifications"
          description="Get an email whenever a new device logs in to your account."
          checked={loginNotice}
          onChange={setLoginNotice}
        />
      </section>
    </div>
  );
}

function NotificationSettings() {
  const [settings, setSettings] = useState({ appointments: true, medications: true, healthTips: true });

  const update = (key) => setSettings((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <section className="pwa-settings-card pwa-notification-card">
      <header>
        <h3>Notification Preferences</h3>
      </header>

      <SecurityToggle title="Appointment Reminders" description="Receive reminders before each appointment." checked={settings.appointments} onChange={() => update("appointments")} />
      <SecurityToggle title="Medication Reminders" description="Notify me when it is time to take medicine or vitamins." checked={settings.medications} onChange={() => update("medications")} />
      <SecurityToggle title="Daily Health Tips" description="Receive pregnancy health tips and wellness messages." checked={settings.healthTips} onChange={() => update("healthTips")} />

      <button className="pwa-full-save" type="button">Save Changes</button>
    </section>
  );
}

function SettingsCard({ title, tone, action, children }) {
  return (
    <section className={`pwa-settings-card pwa-settings-card-${tone}`}>
      <header>
        <h3>{title}</h3>
        {action ? (
          <button type="button"><Icon icon={action === "Edit" ? "solar:pen-new-square-linear" : "solar:lock-keyhole-linear"} /> {action}</button>
        ) : null}
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

function PasswordInput({ label, placeholder, visible, onToggle }) {
  return (
    <label className="pwa-password-field">
      <span>{label}</span>
      <div>
        <input type={visible ? "text" : "password"} placeholder={placeholder} />
        <button type="button" onClick={onToggle} aria-label={`Toggle ${label}`}>
          <Icon icon={visible ? "solar:eye-linear" : "solar:eye-closed-linear"} />
        </button>
      </div>
    </label>
  );
}

function SecurityToggle({ title, description, checked, onChange }) {
  return (
    <article className="pwa-security-toggle">
      <div>
        <h4>{title}</h4>
        <p>{description}</p>
      </div>
      <button
        type="button"
        className={checked ? "is-on" : ""}
        onClick={() => onChange(!checked)}
        aria-pressed={checked}
      >
        <span />
      </button>
    </article>
  );
}
