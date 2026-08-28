import React from "react";
import { Icon } from "@iconify/react";
import AdminPageHeader from "../../components/admin/AdminPageHeader";
import {
  hasSettingsSectionChanges,
  loadAdminSystemSettings,
  mergeSettingsSection,
  persistentSettingsSections,
  updateAdminSystemSettings,
  validateSettingsSection,
} from "../../lib/adminSystemSettings";
import "../../styles/adminSystemSettings.css";

const settingsSections = [
  { id: "general", label: "General / Clinic", icon: "solar:settings-linear", description: "Clinic identity and general configuration." },
  { id: "appointments", label: "Appointment Policy", icon: "solar:calendar-mark-linear", description: "Clinic hours and booking policy values." },
  { id: "notifications", label: "Notification Policy", icon: "solar:bell-linear", description: "Reminder and alert policy values." },
];

const timezoneOptions = ["Asia/Manila", "Asia/Singapore", "UTC"];
const appointmentDurationOptions = ["15", "30", "45", "60"];
const appointmentReminderOptions = ["12 hours before", "24 hours before", "48 hours before"];
const secondReminderOptions = ["Disabled", "1 hour before", "2 hours before", "4 hours before"];

const initialValues = {
  systemName: "Maternal Care Reminder & Appointment Management System",
  clinicName: "Maternal Care Clinic",
  clinicEmail: "",
  contactNumber: "",
  clinicAddress: "",
  timezone: "Asia/Manila",
  clinicOpeningTime: "08:00",
  clinicClosingTime: "17:00",
  appointmentDuration: "30",
  bookingInterval: "30",
  cancellationWindow: "24",
  maximumDailyAppointments: "30",
  appointmentReminders: true,
  medicationReminderAlerts: true,
  browserPushNotifications: false,
  appointmentReminderTiming: "24 hours before",
  secondReminder: "2 hours before",
  // These persisted display preferences are not editable on this page.
  dateFormat: "MM/DD/YYYY",
  timeFormat: "12-hour",
  recordsPerPage: "20",
  dashboardRefreshInterval: "60",
};

function Field({ id, label, description = "", className = "", children }) {
  return (
    <div className={`admin-settings-field ${className}`.trim()}>
      <label htmlFor={id}>{label}</label>
      {children}
      {description ? <small className="admin-settings-field__help">{description}</small> : null}
    </div>
  );
}

function SettingsGroup({ title, className = "", children }) {
  return (
    <section className={`admin-settings-group ${className}`.trim()}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Toggle({ id, label, description, checked, onChange }) {
  return (
    <label className="admin-settings-toggle" htmlFor={id}>
      <span className="admin-settings-toggle__copy">
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
      <input id={id} type="checkbox" checked={checked} onChange={onChange} />
      <span className="admin-settings-toggle__control" aria-hidden="true">
        <span />
      </span>
    </label>
  );
}

function SettingsCard({ icon, title, description, children, actionLabel, onSubmit, status, disabled, saving }) {
  const statusIcon = status?.tone === "error"
    ? "solar:danger-triangle-linear"
    : "solar:check-circle-linear";

  return (
    <form className="admin-settings-card" noValidate onSubmit={onSubmit}>
      <header>
        <span className="admin-settings-card__icon">
          <Icon icon={icon} aria-hidden="true" />
        </span>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </header>
      <fieldset className="admin-settings-card__body" disabled={saving}>{children}</fieldset>
      <footer>
        <div className="admin-settings-save-status" role="status" aria-live="polite">
          {status ? (
            <span className={`is-${status.tone}`}>
              <Icon icon={statusIcon} aria-hidden="true" />
              {status.message}
            </span>
          ) : null}
        </div>
        <button className="admin-settings-save" type="submit" disabled={disabled || saving}>
          <Icon className={saving ? "is-spinning" : ""} icon={saving ? "solar:refresh-linear" : "solar:diskette-linear"} aria-hidden="true" />
          {saving ? "Saving..." : actionLabel}
        </button>
      </footer>
    </form>
  );
}

export default function AdminSystemSettings() {
  const [activeSection, setActiveSection] = React.useState("general");
  const [values, setValues] = React.useState(initialValues);
  const [baselineValues, setBaselineValues] = React.useState(initialValues);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState("");
  const [savingSection, setSavingSection] = React.useState("");
  const [feedback, setFeedback] = React.useState(null);
  const loadRequestRef = React.useRef(0);

  const loadSettings = React.useCallback(async () => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    setLoading(true);
    setLoadError("");
    setFeedback(null);

    const result = await loadAdminSystemSettings(initialValues);
    if (requestId !== loadRequestRef.current) return;

    if (result.error) {
      setLoadError(result.error);
    } else {
      setValues(result.settings);
      setBaselineValues(result.settings);
    }
    setLoading(false);
  }, []);

  React.useEffect(() => {
    const loadTimer = window.setTimeout(loadSettings, 0);
    return () => {
      window.clearTimeout(loadTimer);
      loadRequestRef.current += 1;
    };
  }, [loadSettings]);

  const updateValue = (key) => (event) => {
    const nextValue = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    setValues((current) => ({ ...current, [key]: nextValue }));
    setFeedback((current) => (current?.section === activeSection ? null : current));
  };

  const selectSection = (sectionId) => {
    setActiveSection(sectionId);
    setFeedback(null);
  };

  const saveSettings = async (event) => {
    event.preventDefault();
    const validationMessage = validateSettingsSection(activeSection, values);
    if (validationMessage) {
      setFeedback({ section: activeSection, tone: "error", message: validationMessage });
      return;
    }

    if (!persistentSettingsSections.has(activeSection)
      || !hasSettingsSectionChanges(values, baselineValues, activeSection)) return;

    const sectionBeingSaved = activeSection;
    setSavingSection(sectionBeingSaved);
    setFeedback(null);
    const result = await updateAdminSystemSettings(sectionBeingSaved, values);

    if (result.error) {
      setFeedback({ section: sectionBeingSaved, tone: "error", message: result.error });
    } else {
      setValues((current) => mergeSettingsSection(current, result.settings, sectionBeingSaved));
      setBaselineValues((current) => mergeSettingsSection(current, result.settings, sectionBeingSaved));
      setFeedback({
        section: sectionBeingSaved,
        tone: "success",
        message: "Settings saved successfully.",
      });
    }
    setSavingSection("");
  };

  React.useEffect(() => {
    if (!feedback?.message) return undefined;
    const feedbackTimer = window.setTimeout(() => setFeedback(null), 3500);
    return () => window.clearTimeout(feedbackTimer);
  }, [feedback]);

  const status = feedback?.section === activeSection ? feedback : null;
  const activeSectionIsPersistent = persistentSettingsSections.has(activeSection);
  const activeSectionIsDirty = activeSectionIsPersistent
    && hasSettingsSectionChanges(values, baselineValues, activeSection);
  const saveDisabled = loading
    || Boolean(savingSection)
    || (activeSectionIsPersistent && !activeSectionIsDirty);

  return (
    <section className="admin-system-settings-page">
      <AdminPageHeader
        className="admin-system-settings-header"
        title="System Settings"
        subtitle="Manage stored clinic configuration and policy values."
      />

      <div className="admin-settings-integration-note" role="note">
        <Icon icon="solar:info-circle-linear" aria-hidden="true" />
        <p>Configuration values are stored securely. Integration with scheduling, reminders, and application-wide behavior is being enabled per feature.</p>
      </div>

      <div className="admin-settings-layout">
        <nav className="admin-settings-navigation" aria-label="System settings sections">
          <h2>Settings</h2>
          <div>
            {settingsSections.map((section) => (
              <button
                key={section.id}
                type="button"
                className={activeSection === section.id ? "is-active" : ""}
                aria-pressed={activeSection === section.id}
                disabled={loading || Boolean(savingSection)}
                onClick={() => selectSection(section.id)}
              >
                <Icon icon={section.icon} aria-hidden="true" />
                <span>
                  <strong>{section.label}</strong>
                  <small>{section.description}</small>
                </span>
                <Icon className="admin-settings-navigation__arrow" icon="solar:alt-arrow-right-linear" aria-hidden="true" />
              </button>
            ))}
          </div>
        </nav>

        <div className="admin-settings-content" id={`admin-settings-panel-${activeSection}`}>
          {loading ? (
            <section className="admin-settings-state-card" role="status" aria-live="polite">
              <Icon className="is-spinning" icon="solar:refresh-linear" aria-hidden="true" />
              <h2>Loading system settings</h2>
              <p>Retrieving the approved operational settings.</p>
            </section>
          ) : loadError ? (
            <section className="admin-settings-state-card is-error" role="alert">
              <Icon icon="solar:danger-triangle-linear" aria-hidden="true" />
              <h2>System settings unavailable</h2>
              <p>{loadError}</p>
              <button type="button" onClick={loadSettings}>Try Again</button>
            </section>
          ) : (
            <>
          {activeSection === "general" ? (
            <SettingsCard
              icon="solar:settings-linear"
              title="General / Clinic Settings"
              description="Manage the clinic identity and general system configuration."
              actionLabel="Save General Settings"
              onSubmit={saveSettings}
              status={status}
              disabled={saveDisabled}
              saving={savingSection === "general"}
            >
              <SettingsGroup title="System Information">
                <div className="admin-settings-fields">
                  <Field id="system-name" label="System Name" className="is-full-width">
                    <input id="system-name" type="text" value={values.systemName} onChange={updateValue("systemName")} />
                  </Field>
                  <Field id="clinic-name" label="Clinic Name">
                    <input id="clinic-name" type="text" value={values.clinicName} onChange={updateValue("clinicName")} />
                  </Field>
                </div>
              </SettingsGroup>

              <SettingsGroup title="Contact Information" className="has-divider">
                <div className="admin-settings-fields">
                  <Field id="clinic-email" label="Clinic Email">
                    <input id="clinic-email" type="email" value={values.clinicEmail} placeholder="clinic@example.com" onChange={updateValue("clinicEmail")} />
                  </Field>
                  <Field id="contact-number" label="Contact Number">
                    <input id="contact-number" type="tel" value={values.contactNumber} placeholder="Enter clinic contact number" onChange={updateValue("contactNumber")} />
                  </Field>
                  <Field id="clinic-address" label="Clinic Address" className="is-full-width">
                    <textarea id="clinic-address" rows="4" value={values.clinicAddress} placeholder="Enter the clinic address" onChange={updateValue("clinicAddress")} />
                  </Field>
                  <Field id="timezone" label="Timezone">
                    <select id="timezone" value={values.timezone} onChange={updateValue("timezone")}>
                      {!timezoneOptions.includes(values.timezone) ? <option value={values.timezone}>{values.timezone}</option> : null}
                      {timezoneOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  </Field>
                </div>
              </SettingsGroup>
            </SettingsCard>
          ) : null}

          {activeSection === "appointments" ? (
            <SettingsCard
              icon="solar:calendar-mark-linear"
              title="Appointment Policy"
              description="Store clinic operating hours and appointment policy values."
              actionLabel="Save Appointment Policy"
              onSubmit={saveSettings}
              status={status}
              disabled={saveDisabled}
              saving={savingSection === "appointments"}
            >
              <SettingsGroup title="Clinic Hours">
                <div className="admin-settings-fields">
                  <Field id="clinic-opening-time" label="Clinic Opening Time">
                    <div className="admin-settings-input-with-icon">
                      <Icon icon="solar:clock-circle-linear" aria-hidden="true" />
                      <input id="clinic-opening-time" type="time" value={values.clinicOpeningTime} onChange={updateValue("clinicOpeningTime")} />
                    </div>
                  </Field>
                  <Field id="clinic-closing-time" label="Clinic Closing Time">
                    <div className="admin-settings-input-with-icon">
                      <Icon icon="solar:clock-circle-linear" aria-hidden="true" />
                      <input id="clinic-closing-time" type="time" value={values.clinicClosingTime} onChange={updateValue("clinicClosingTime")} />
                    </div>
                  </Field>
                </div>
              </SettingsGroup>

              <SettingsGroup title="Booking Rules" className="has-divider">
                <div className="admin-settings-fields">
                  <Field id="appointment-duration" label="Default Appointment Duration">
                    <select id="appointment-duration" value={values.appointmentDuration} onChange={updateValue("appointmentDuration")}>
                      {!appointmentDurationOptions.includes(values.appointmentDuration) ? (
                        <option value={values.appointmentDuration}>{values.appointmentDuration} minutes</option>
                      ) : null}
                      {appointmentDurationOptions.map((option) => <option key={option} value={option}>{option} minutes</option>)}
                    </select>
                  </Field>
                  <Field id="booking-interval" label="Booking Interval">
                    <div className="admin-settings-input-with-suffix">
                      <input id="booking-interval" type="number" min="5" step="5" value={values.bookingInterval} onChange={updateValue("bookingInterval")} />
                      <span>minutes</span>
                    </div>
                  </Field>
                  <Field id="cancellation-window" label="Cancellation Window">
                    <div className="admin-settings-input-with-suffix">
                      <input id="cancellation-window" type="number" min="0" value={values.cancellationWindow} onChange={updateValue("cancellationWindow")} />
                      <span>hours</span>
                    </div>
                  </Field>
                  <Field id="maximum-daily-appointments" label="Maximum Daily Appointments">
                    <input id="maximum-daily-appointments" type="number" min="1" value={values.maximumDailyAppointments} onChange={updateValue("maximumDailyAppointments")} />
                  </Field>
                </div>
              </SettingsGroup>
            </SettingsCard>
          ) : null}

          {activeSection === "notifications" ? (
            <SettingsCard
              icon="solar:bell-linear"
              title="Notification Policy"
              description="Store reminder, alert, and notification policy values."
              actionLabel="Save Notification Policy"
              onSubmit={saveSettings}
              status={status}
              disabled={saveDisabled}
              saving={savingSection === "notifications"}
            >
              <SettingsGroup title="Notification Preferences">
                <div className="admin-settings-toggle-list">
                  <Toggle id="appointment-reminders" label="Appointment Reminders" description="Send reminders for scheduled Patient appointments." checked={values.appointmentReminders} onChange={updateValue("appointmentReminders")} />
                  <Toggle id="medication-reminder-alerts" label="Medication Reminder Alerts" description="Notify Patients about scheduled medication reminders." checked={values.medicationReminderAlerts} onChange={updateValue("medicationReminderAlerts")} />
                  <Toggle id="browser-push-notifications" label="Browser Push Notifications" description="Allow supported browsers to display operational notifications." checked={values.browserPushNotifications} onChange={updateValue("browserPushNotifications")} />
                </div>
              </SettingsGroup>

              <SettingsGroup title="Reminder Timing" className="has-divider">
                <div className="admin-settings-fields">
                  <Field id="appointment-reminder-timing" label="Appointment Reminder Timing">
                    <select id="appointment-reminder-timing" value={values.appointmentReminderTiming} onChange={updateValue("appointmentReminderTiming")}>
                      {!appointmentReminderOptions.includes(values.appointmentReminderTiming) ? (
                        <option value={values.appointmentReminderTiming}>{values.appointmentReminderTiming}</option>
                      ) : null}
                      {appointmentReminderOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  </Field>
                  <Field id="second-reminder" label="Second Reminder">
                    <select id="second-reminder" value={values.secondReminder} onChange={updateValue("secondReminder")}>
                      {!secondReminderOptions.includes(values.secondReminder) ? (
                        <option value={values.secondReminder}>{values.secondReminder}</option>
                      ) : null}
                      {secondReminderOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  </Field>
                </div>
              </SettingsGroup>
            </SettingsCard>
          ) : null}

            </>
          )}
        </div>
      </div>
    </section>
  );
}
