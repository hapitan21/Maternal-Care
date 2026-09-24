import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import ProfilePictureActions from "../../components/common/ProfilePictureActions";
import { PatientPageHeader } from "../../components/patient/PatientPwaUi";
import { isValidPhilippineMobileNumber } from "../../lib/philippinePhone";
import {
  loadPatientProfileSummary,
  mapPatientProfileSummary,
  updatePatientEmergencyContact,
  updatePatientProfile,
} from "../../lib/patientProfile";
import "../../styles/patient-PWA-viewprofile.css";

const defaultProfile = {
  personalInfoId: null,
  emergencyContactId: null,

  displayName: "Patient",
  patientId: "Not provided",
  pregnancyStatus: "Not provided",
  avatar: "",

  sexAtBirth: "",
  gender: "",
  birthdate: "",
  nationality: "",
  email: "",
  address: "",
  bloodType: "",
  civilStatus: "",
  phone: "",

  emergencyName: "",
  emergencyRelation: "",
  emergencyPhone: "",

  trimester: "",
  pregnancyWeek: "",
  gravida: "",
  para: "",
  dueDate: "",
  physician: "",
  clinic: "",
};

export default function PatientPWAViewProfile({ profile, onAvatarChange, onProfileChange }) {
  const initialProfile = normalizeProfile(profile);

  const [profileData, setProfileData] = useState(initialProfile);
  const [personalDraft, setPersonalDraft] = useState(() =>
    createPersonalDraft(initialProfile)
  );
  const [emergencyDraft, setEmergencyDraft] = useState(() =>
    createEmergencyDraft(initialProfile)
  );

  const [editingPersonal, setEditingPersonal] = useState(false);
  const [editingEmergency, setEditingEmergency] = useState(false);

  const [loading, setLoading] = useState(false);
  const [savingPersonal, setSavingPersonal] = useState(false);
  const [savingEmergency, setSavingEmergency] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [feedbackTone, setFeedbackTone] = useState("info");
  const feedbackTimerRef = useRef(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const nextProfile = normalizeProfile(profile);
      setProfileData(nextProfile);
      setPersonalDraft(createPersonalDraft(nextProfile));
      setEmergencyDraft(createEmergencyDraft(nextProfile));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [profile]);

  useEffect(() => () => window.clearTimeout(feedbackTimerRef.current), []);

  const showFeedback = (message, tone = "info", autoHide = tone === "success") => {
    window.clearTimeout(feedbackTimerRef.current);
    setSyncMessage(message);
    setFeedbackTone(tone);
    if (autoHide) {
      feedbackTimerRef.current = window.setTimeout(() => {
        setSyncMessage("");
        setFeedbackTone("info");
      }, 4000);
    }
  };

  const reconcileProfile = async () => {
    setLoading(true);
    try {
      const summary = await loadPatientProfileSummary();
      const mapped = mapPatientProfileSummary(summary, {
        userId: profile.userId,
        fullName: profile.displayName,
        email: profile.email,
        avatarDisplayUrl: profileData.avatar,
        emailVerified: profile.emailVerified,
        lastLoginAt: profile.lastLoginAt,
      });
      const nextProfile = normalizeProfile({ ...profile, ...mapped });
      setProfileData(nextProfile);
      setPersonalDraft(createPersonalDraft(nextProfile));
      setEmergencyDraft(createEmergencyDraft(nextProfile));
      onProfileChange?.(mapped);
      return nextProfile;
    } finally {
      setLoading(false);
    }
  };

  const updatePersonalDraft = (field, value) => {
    setPersonalDraft((draft) => ({ ...draft, [field]: value }));
  };

  const updateEmergencyDraft = (field, value) => {
    setEmergencyDraft((draft) => ({ ...draft, [field]: value }));
  };

  const startPersonalEdit = () => {
    setPersonalDraft(createPersonalDraft(profileData));
    setEditingPersonal(true);
    showFeedback("");
  };

  const cancelPersonalEdit = () => {
    setPersonalDraft(createPersonalDraft(profileData));
    setEditingPersonal(false);
    showFeedback("");
  };

  async function savePersonalEdit() {
    try {
      setSavingPersonal(true);
      showFeedback("");

      if (!cleanText(personalDraft.displayName)) {
        throw new Error("Full name is required.");
      }
      if (!isValidPhilippineMobileNumber(personalDraft.phone)) {
        throw new Error("Enter a valid Philippine mobile number.");
      }

      await updatePatientProfile({
        full_name: cleanText(personalDraft.displayName),
        date_of_birth: toDatabaseDate(personalDraft.birthdate),
        nationality: cleanText(personalDraft.nationality),
        address: cleanText(personalDraft.address),
        blood_type: cleanText(personalDraft.bloodType),
        civil_status: cleanText(personalDraft.civilStatus),
        contact_number: cleanText(personalDraft.phone),
      });
      await reconcileProfile();
      setEditingPersonal(false);
      showFeedback("Profile information saved successfully.", "success");
    } catch (error) {
      console.error("Save personal information error:", error);
      showFeedback(error?.message || "Unable to save profile information.", "error", false);
    } finally {
      setSavingPersonal(false);
    }
  }

  const startEmergencyEdit = () => {
    setEmergencyDraft(createEmergencyDraft(profileData));
    setEditingEmergency(true);
    showFeedback("");
  };

  const cancelEmergencyEdit = () => {
    setEmergencyDraft(createEmergencyDraft(profileData));
    setEditingEmergency(false);
    showFeedback("");
  };

  async function saveEmergencyEdit() {
    try {
      setSavingEmergency(true);
      showFeedback("");

      if (!cleanText(emergencyDraft.emergencyName) || !cleanText(emergencyDraft.emergencyRelation)) {
        throw new Error("Contact person and relationship are required.");
      }
      if (!isValidPhilippineMobileNumber(emergencyDraft.emergencyPhone)) {
        throw new Error("Enter a valid Philippine mobile number for the emergency contact.");
      }

      await updatePatientEmergencyContact({
        contact_person: cleanText(emergencyDraft.emergencyName),
        relationship: cleanText(emergencyDraft.emergencyRelation),
        contact_number: cleanText(emergencyDraft.emergencyPhone),
      });
      await reconcileProfile();
      setEditingEmergency(false);
      showFeedback("Emergency contact saved successfully.", "success");
    } catch (error) {
      console.error("Save emergency contact error:", error);
      showFeedback(error?.message || "Unable to save the emergency contact.", "error", false);
    } finally {
      setSavingEmergency(false);
    }
  }

  const ageText = calculateAge(profileData.birthdate, profileData.age);
  const hasMissingOptionalDetails = [
    profileData.sexAtBirth,
    profileData.civilStatus,
    profileData.nationality,
    profileData.bloodType,
    profileData.emergencyName,
    profileData.emergencyRelation,
    profileData.emergencyPhone,
  ].some((value) => !hasMeaningfulValue(value));
  const visibleMessage = syncMessage || (
    !editingPersonal && !editingEmergency && hasMissingOptionalDetails
      ? "Some optional profile details have not been added yet."
      : ""
  );
  const visibleFeedbackTone = syncMessage ? feedbackTone : "info";
  const pregnancySummary = formatPregnancySummary(
    profileData.trimester,
    profileData.pregnancyWeek
  );
  const emergencySummary = formatCombinedValues([
    profileData.emergencyName,
    profileData.emergencyRelation,
    profileData.emergencyPhone,
  ]);

  return (
    <main className="pwa-page pwa-profile-page">
      <PatientPageHeader
        title="My Profile"
        subtitle="Review your personal, pregnancy, and emergency contact information."
        className="pwa-profile-title"
      />

      {loading || visibleMessage ? (
        <div
          className={`pwa-profile-feedback ${visibleFeedbackTone === "error" ? "is-error" : visibleFeedbackTone === "success" ? "is-success" : ""}`.trim()}
          role={visibleFeedbackTone === "error" ? "alert" : "status"}
        >
          <Icon
            icon={loading ? "solar:refresh-linear" : "solar:info-circle-bold-duotone"}
            aria-hidden="true"
          />
          <span>{loading ? "Refreshing your profile information..." : visibleMessage}</span>
        </div>
      ) : null}

      <section className="pwa-profile-hero">
        <div className="profile-picture-editor patient-profile-picture-editor">
          <div className="pwa-profile-photo-ring">
            <Avatar profile={profileData} />
          </div>

          <ProfilePictureActions
            avatarUrl={profileData.avatar}
            disabled={loading}
            onChange={(nextAvatarUrl) => {
              setProfileData((current) => ({
                ...current,
                avatar: nextAvatarUrl,
              }));
              onAvatarChange?.(nextAvatarUrl);
            }}
          />
        </div>

        <div className="pwa-profile-main-copy">
          <div className="pwa-profile-name-row">
            <h2>{formatDisplayValue(profileData.displayName)}</h2>
            <span>{formatStatusLabel(profileData.pregnancyStatus)}</span>
          </div>

          <p>Patient ID: {formatDisplayValue(profileData.patientId)}</p>

          <ul>
            <li>
              <Icon icon="solar:user-rounded-linear" /> {formatDisplayValue(ageText)}
            </li>
            <li>
              <Icon icon="solar:users-group-rounded-linear" />{" "}
              {formatDisplayValue(profileData.sexAtBirth)}
            </li>
            <li>
              <Icon icon="solar:heart-linear" />{" "}
              {formatDisplayValue(profileData.civilStatus)}
            </li>
          </ul>

          <strong>
            <Icon icon="solar:heart-bold" /> {pregnancySummary}
          </strong>
        </div>

        <dl className="pwa-profile-contact-list">
          <Contact
            icon="solar:letter-bold-duotone"
            value={formatDisplayValue(profileData.email)}
          />
          <Contact
            icon="solar:phone-bold-duotone"
            value={formatDisplayValue(profileData.phone)}
          />
          <Contact
            icon="solar:map-point-bold-duotone"
            value={formatDisplayValue(profileData.address)}
          />
          <Contact
            icon="solar:users-group-rounded-bold-duotone"
            value={emergencySummary}
          />
        </dl>

        <button
          className="pwa-edit-profile-btn"
          type="button"
          onClick={startPersonalEdit}
          disabled={loading || savingPersonal}
        >
          <Icon icon="solar:pen-new-square-linear" />
          Edit Profile
        </button>
      </section>

      <InfoCard
        title="Personal Information"
        icon="solar:user-rounded-bold-duotone"
        action={editingPersonal ? (savingPersonal ? "Saving..." : "Save") : "Edit"}
        secondaryAction={editingPersonal ? "Cancel" : null}
        onAction={editingPersonal ? savePersonalEdit : startPersonalEdit}
        onSecondaryAction={cancelPersonalEdit}
        actionDisabled={loading || savingPersonal}
      >
        <EditableInfo
          label="Full Name"
          value={profileData.displayName}
          draftValue={personalDraft.displayName}
          field="displayName"
          icon="solar:user-linear"
          editing={editingPersonal}
          onChange={updatePersonalDraft}
        />

        <Info label="Age" value={ageText} icon="solar:clock-circle-linear" />

        <Info
          label="Sex at Birth"
          value={profileData.sexAtBirth}
          icon="solar:users-group-rounded-linear"
        />

        <EditableInfo
          label="Blood Type"
          value={profileData.bloodType}
          draftValue={personalDraft.bloodType}
          field="bloodType"
          icon="solar:heart-linear"
          editing={editingPersonal}
          onChange={updatePersonalDraft}
        />

        <EditableInfo
          label="Birthdate"
          value={formatDateForDisplay(profileData.birthdate)}
          draftValue={personalDraft.birthdate}
          field="birthdate"
          icon="solar:calendar-linear"
          editing={editingPersonal}
          onChange={updatePersonalDraft}
          type="date"
        />

        <EditableInfo
          label="Civil Status"
          value={profileData.civilStatus}
          draftValue={personalDraft.civilStatus}
          field="civilStatus"
          icon="solar:heart-linear"
          editing={editingPersonal}
          onChange={updatePersonalDraft}
        />

        <EditableInfo
          label="Nationality"
          value={profileData.nationality}
          draftValue={personalDraft.nationality}
          field="nationality"
          icon="solar:globus-linear"
          editing={editingPersonal}
          onChange={updatePersonalDraft}
        />

        <EditableInfo
          label="Contact Number"
          value={profileData.phone}
          draftValue={personalDraft.phone}
          field="phone"
          icon="solar:phone-linear"
          editing={editingPersonal}
          onChange={updatePersonalDraft}
        />

        <Info
          label="Email"
          value={profileData.email}
          icon="solar:letter-linear"
        />

        <EditableInfo
          label="Address"
          value={profileData.address}
          draftValue={personalDraft.address}
          field="address"
          icon="solar:map-point-linear"
          editing={editingPersonal}
          onChange={updatePersonalDraft}
          wide
        />
      </InfoCard>

      <InfoCard title="Pregnancy Information" icon="solar:heart-bold-duotone">
        <Info
          label="Pregnancy Status"
          value={formatStatusLabel(profileData.pregnancyStatus)}
          icon="solar:user-linear"
        />
        <Info
          label="Gravida (G)"
          value={profileData.gravida}
          icon="solar:users-group-rounded-linear"
        />
        <Info
          label="Current Pregnancy Week"
          value={formatPregnancyWeek(profileData.pregnancyWeek)}
          icon="solar:clock-circle-linear"
        />
        <Info
          label="Para (P)"
          value={profileData.para}
          icon="solar:users-group-rounded-linear"
        />
        <Info
          label="Estimated Due Date"
          value={formatDateForDisplay(profileData.dueDate)}
          icon="solar:calendar-linear"
        />
        <Info
          label="Attending Physician"
          value={profileData.physician}
          icon="solar:user-id-linear"
        />
        <Info
          label="Clinic"
          value={profileData.clinic}
          icon="solar:buildings-3-linear"
          wide
        />
      </InfoCard>

      <InfoCard
        title="Emergency Contact"
        className="pwa-emergency-contact-card"
        icon="solar:users-group-rounded-bold-duotone"
        action={
          editingEmergency ? (savingEmergency ? "Saving..." : "Save") : "Edit"
        }
        secondaryAction={editingEmergency ? "Cancel" : null}
        onAction={editingEmergency ? saveEmergencyEdit : startEmergencyEdit}
        onSecondaryAction={cancelEmergencyEdit}
        actionDisabled={loading || savingEmergency}
      >
        <EditableInfo
          label="Contact Person"
          value={profileData.emergencyName}
          draftValue={emergencyDraft.emergencyName}
          field="emergencyName"
          editing={editingEmergency}
          onChange={updateEmergencyDraft}
        />

        <EditableInfo
          label="Contact Number"
          value={profileData.emergencyPhone}
          draftValue={emergencyDraft.emergencyPhone}
          field="emergencyPhone"
          editing={editingEmergency}
          onChange={updateEmergencyDraft}
        />

        <EditableInfo
          label="Relationship"
          value={profileData.emergencyRelation}
          draftValue={emergencyDraft.emergencyRelation}
          field="emergencyRelation"
          editing={editingEmergency}
          onChange={updateEmergencyDraft}
        />
      </InfoCard>
    </main>
  );
}

function normalizeProfile(profile) {
  return {
    ...defaultProfile,
    ...(profile || {}),
  };
}

function hasMeaningfulValue(value) {
  const text = String(value ?? "").trim();
  return Boolean(
    text &&
      !["n/a", "na", "not provided", "not recorded", "none", "null", "undefined"].includes(
        text.toLowerCase()
      )
  );
}

function formatDisplayValue(value, fallback = "Not provided") {
  return hasMeaningfulValue(value) ? String(value).trim() : fallback;
}

function formatStatusLabel(value) {
  if (!hasMeaningfulValue(value)) return "Not provided";

  return String(value)
    .trim()
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function formatCombinedValues(values) {
  const parts = values.map((value) => formatDisplayValue(value, "")).filter(Boolean);
  return parts.length ? parts.join(" — ") : "Not provided";
}

function formatPregnancySummary(trimester, pregnancyWeek) {
  const normalizedWeek = normalizePregnancyWeek(pregnancyWeek);
  const weekText = normalizedWeek !== null ? `Week ${normalizedWeek}` : "";

  return formatCombinedValues([trimester, weekText]);
}

function normalizePregnancyWeek(value) {
  const match = String(value ?? "").match(/\d+/);
  const week = match ? Number.parseInt(match[0], 10) : Number.NaN;
  return Number.isFinite(week) && week >= 0 && week <= 42 ? week : null;
}

function formatPregnancyWeek(value) {
  const week = normalizePregnancyWeek(value);
  if (week === null) return "Not provided";
  return `Week ${week}`;
}

function createPersonalDraft(profile) {
  return {
    displayName: getEditableValue(profile.displayName),
    bloodType: getEditableValue(profile.bloodType),
    birthdate: toDateInputValue(profile.birthdate),
    civilStatus: getEditableValue(profile.civilStatus),
    nationality: getEditableValue(profile.nationality),
    phone: getEditableValue(profile.phone),
    address: getEditableValue(profile.address),
  };
}

function createEmergencyDraft(profile) {
  return {
    emergencyName: getEditableValue(profile.emergencyName),
    emergencyRelation: getEditableValue(profile.emergencyRelation),
    emergencyPhone: getEditableValue(profile.emergencyPhone),
  };
}

function getEditableValue(value) {
  return hasMeaningfulValue(value) ? String(value).trim() : "";
}

function cleanText(value) {
  if (value === undefined || value === null) return null;

  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function getDateObject(value) {
  if (!value) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDatabaseDate(value) {
  const date = getDateObject(value);

  if (!date) return null;

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function toDateInputValue(value) {
  return toDatabaseDate(value) || "";
}

function formatDateForDisplay(value) {
  const date = getDateObject(value);

  if (!date) return formatDisplayValue(value);

  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function calculateAge(birthdate, fallback = "Not provided") {
  const birth = getDateObject(birthdate);

  if (!birth) return fallback || "Not provided";

  const today = new Date();
  if (birth > today) return "Not provided";

  let age = today.getFullYear() - birth.getFullYear();
  const monthDifference = today.getMonth() - birth.getMonth();

  if (
    monthDifference < 0 ||
    (monthDifference === 0 && today.getDate() < birth.getDate())
  ) {
    age -= 1;
  }

  return `${age} years old`;
}

function Contact({ icon, value }) {
  return (
    <div>
      <dt>
        <Icon icon={icon} />
      </dt>
      <dd>{formatDisplayValue(value)}</dd>
    </div>
  );
}

function InfoCard({
  title,
  className = "",
  icon,
  action,
  secondaryAction,
  onAction,
  onSecondaryAction,
  actionDisabled,
  children,
}) {
  const isSaving = action === "Saving...";

  return (
    <section className={`pwa-info-card ${className}`.trim()}>
      <header>
        <span>
          <Icon icon={icon} />
        </span>

        <h2>{title}</h2>

        {action ? (
          <div className="pwa-info-actions">
            {secondaryAction ? (
              <button
                type="button"
                className="is-muted"
                onClick={onSecondaryAction}
                disabled={actionDisabled}
              >
                {secondaryAction}
              </button>
            ) : null}

            <button type="button" onClick={onAction} disabled={actionDisabled}>
              <Icon
                icon={
                  isSaving
                    ? "solar:refresh-linear"
                    : action === "Save"
                    ? "solar:diskette-bold"
                    : "solar:pen-new-square-linear"
                }
              />{" "}
              {action}
            </button>
          </div>
        ) : null}
      </header>

      <div className="pwa-profile-info-grid">{children}</div>
    </section>
  );
}

function EditableInfo({
  label,
  value,
  draftValue,
  field,
  icon,
  editing,
  onChange,
  wide,
  type = "text",
}) {
  if (!editing) {
    return <Info label={label} value={value} icon={icon} wide={wide} />;
  }

  return (
    <article className={wide ? "is-wide" : ""}>
      {icon ? (
        <span>
          <Icon icon={icon} />
        </span>
      ) : null}

      <label className="pwa-edit-field">
        <small>{label}</small>
        <input
          type={type}
          value={draftValue || ""}
          onChange={(event) => onChange(field, event.target.value)}
        />
      </label>
    </article>
  );
}

function Info({ label, value, icon, wide }) {
  return (
    <article className={wide ? "is-wide" : ""}>
      {icon ? (
        <span>
          <Icon icon={icon} />
        </span>
      ) : null}

      <div>
        <small>{label}</small>
        <strong>{formatDisplayValue(value)}</strong>
      </div>
    </article>
  );
}

function Avatar({ profile }) {
  const [failedAvatarUrl, setFailedAvatarUrl] = useState("");

  if (!profile.avatar || failedAvatarUrl === profile.avatar) {
    return (
      <span className="pwa-profile-photo-fallback">
        {getInitials(profile.displayName)}
      </span>
    );
  }

  return (
    <img
      src={profile.avatar}
      alt=""
      onError={() => setFailedAvatarUrl(profile.avatar)}
    />
  );
}

function getInitials(name) {
  if (!name) return "P";

  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}
