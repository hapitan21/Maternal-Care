import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { supabase } from "../../lib/supabaseClient";
import { PatientPageHeader } from "../../components/patient/PatientPwaUi";
import "../../styles/patient-PWA-viewprofile.css";

const defaultProfile = {
  personalInfoId: null,
  emergencyContactId: null,

  displayName: "Patient",
  patientId: "Not provided",
  pregnancyStatus: "Not provided",
  avatar: "",

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

export default function PatientPWAViewProfile({ profile }) {
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

  const [loading, setLoading] = useState(true);
  const [savingPersonal, setSavingPersonal] = useState(false);
  const [savingEmergency, setSavingEmergency] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");

  async function getCurrentUserSafe() {
    const { data, error } = await supabase.auth.getUser();

    if (error) {
      console.warn("Supabase auth check:", error.message);
      return null;
    }

    return data?.user || null;
  }

  async function findPatientRow(user) {
    if (user?.id) {
      const { data, error } = await supabase
        .from("patient_personal_information")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      if (data) return data;
    }

    if (profile?.recordId) {
      const { data, error } = await supabase
        .from("patient_personal_information")
        .select("*")
        .eq("patient_record_id", profile.recordId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      if (data) return data;
    }

    return null;
  }

  async function loadProfileFromSupabase() {
    try {
      setLoading(true);
      setSyncMessage("");

      const user = await getCurrentUserSafe();
      const personalData = await findPatientRow(user);

      if (!personalData) {
        setProfileData(initialProfile);
        setPersonalDraft(createPersonalDraft(initialProfile));
        setEmergencyDraft(createEmergencyDraft(initialProfile));
        setSyncMessage(
          hasLinkedPatientRecord(initialProfile)
            ? "Some optional profile details have not been added yet."
            : "Profile details are not available yet."
        );
        return;
      }

      const { data: emergencyData, error: emergencyError } = await supabase
        .from("patient_emergency_contact")
        .select("*")
        .eq("patient_id", personalData.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (emergencyError) {
        console.warn("Emergency contact fetch error:", emergencyError.message);
      }

      const mappedPersonal = mapPersonalInformationRow(personalData, initialProfile);
      const mappedProfile = mapEmergencyContactRow(emergencyData, mappedPersonal);

      setProfileData(mappedProfile);
      setPersonalDraft(createPersonalDraft(mappedProfile));
      setEmergencyDraft(createEmergencyDraft(mappedProfile));
      setSyncMessage(
        emergencyData ? "" : "Some optional profile details have not been added yet."
      );
    } catch (error) {
      console.error("Load profile error:", error);
      setSyncMessage(`Failed to load profile: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(loadProfileFromSupabase, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updatePersonalDraft = (field, value) => {
    setPersonalDraft((draft) => ({ ...draft, [field]: value }));
  };

  const updateEmergencyDraft = (field, value) => {
    setEmergencyDraft((draft) => ({ ...draft, [field]: value }));
  };

  const startPersonalEdit = () => {
    setPersonalDraft(createPersonalDraft(profileData));
    setEditingPersonal(true);
    setSyncMessage("");
  };

  const cancelPersonalEdit = () => {
    setPersonalDraft(createPersonalDraft(profileData));
    setEditingPersonal(false);
    setSyncMessage("");
  };

  async function savePersonalEdit() {
    try {
      setSavingPersonal(true);
      setSyncMessage("");

      const user = await getCurrentUserSafe();

      const oldEmail = cleanText(profileData.email) || cleanText(profile.email);

      const newEmail = cleanText(personalDraft.email) || oldEmail;

      const personalPayload = {
        patient_record_id: profile.recordId || null,
        patient_code:
          profile.patientId && profile.patientId !== "Not provided"
            ? profile.patientId
            : null,
        full_name: cleanText(personalDraft.displayName) || "Unnamed Patient",
        gender: cleanText(personalDraft.gender),
        birthdate: toDatabaseDate(personalDraft.birthdate),
        nationality: cleanText(personalDraft.nationality),
        email: newEmail,
        address: cleanText(personalDraft.address),
        blood_type: cleanText(personalDraft.bloodType),
        civil_status: cleanText(personalDraft.civilStatus),
        contact_number: cleanText(personalDraft.phone),
        updated_at: new Date().toISOString(),
      };

      if (user?.id) {
        personalPayload.user_id = user.id;
      }

      let targetPatientId = profileData.personalInfoId;

      if (!targetPatientId && user?.id) {
        const { data, error } = await supabase
          .from("patient_personal_information")
          .select("id")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (error) throw error;
        targetPatientId = data?.id || null;
      }

      if (!targetPatientId && profile.recordId) {
        const { data, error } = await supabase
          .from("patient_personal_information")
          .select("id")
          .eq("patient_record_id", profile.recordId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (error) throw error;
        targetPatientId = data?.id || null;
      }

      let savedPersonal = null;

      if (targetPatientId) {
        const { data, error } = await supabase
          .from("patient_personal_information")
          .update(personalPayload)
          .eq("id", targetPatientId)
          .select("*")
          .single();

        if (error) throw error;
        savedPersonal = data;
      } else {
        const { data, error } = await supabase
          .from("patient_personal_information")
          .insert(personalPayload)
          .select("*")
          .single();

        if (error) throw error;
        savedPersonal = data;
      }

      const updatedProfile = mapPersonalInformationRow(savedPersonal, profileData);

      setProfileData(updatedProfile);
      setPersonalDraft(createPersonalDraft(updatedProfile));
      setEditingPersonal(false);

      setSyncMessage("Patient information saved to Supabase successfully.");
      console.log("Saved patient row:", savedPersonal);
    } catch (error) {
      console.error("Save personal information error:", error);
      setSyncMessage(`Supabase save failed: ${error.message}`);
    } finally {
      setSavingPersonal(false);
    }
  }

  const startEmergencyEdit = () => {
    setEmergencyDraft(createEmergencyDraft(profileData));
    setEditingEmergency(true);
    setSyncMessage("");
  };

  const cancelEmergencyEdit = () => {
    setEmergencyDraft(createEmergencyDraft(profileData));
    setEditingEmergency(false);
    setSyncMessage("");
  };

  async function saveEmergencyEdit() {
    try {
      setSavingEmergency(true);
      setSyncMessage("");

      if (!profileData.personalInfoId) {
        setSyncMessage(
          "Please save Personal Information first before saving Emergency Contact."
        );
        return;
      }

      const emergencyPayload = {
        patient_id: profileData.personalInfoId,
        contact_person:
          cleanText(emergencyDraft.emergencyName) || "Emergency Contact",
        relationship: cleanText(emergencyDraft.emergencyRelation),
        contact_number: cleanText(emergencyDraft.emergencyPhone),
        updated_at: new Date().toISOString(),
      };

      let savedEmergency = null;

      if (profileData.emergencyContactId) {
        const { data, error } = await supabase
          .from("patient_emergency_contact")
          .update(emergencyPayload)
          .eq("id", profileData.emergencyContactId)
          .select("*")
          .maybeSingle();

        if (error) throw error;
        savedEmergency = data;
      }

      if (!savedEmergency) {
        const { data: existingEmergency, error: findError } = await supabase
          .from("patient_emergency_contact")
          .select("id")
          .eq("patient_id", profileData.personalInfoId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (findError) throw findError;

        if (existingEmergency?.id) {
          const { data, error } = await supabase
            .from("patient_emergency_contact")
            .update(emergencyPayload)
            .eq("id", existingEmergency.id)
            .select("*")
            .single();

          if (error) throw error;
          savedEmergency = data;
        }
      }

      if (!savedEmergency) {
        const { data, error } = await supabase
          .from("patient_emergency_contact")
          .insert(emergencyPayload)
          .select("*")
          .single();

        if (error) throw error;
        savedEmergency = data;
      }

      const updatedProfile = mapEmergencyContactRow(savedEmergency, profileData);

      setProfileData(updatedProfile);
      setEmergencyDraft(createEmergencyDraft(updatedProfile));
      setEditingEmergency(false);

      setSyncMessage("Emergency contact saved to Supabase successfully.");
    } catch (error) {
      console.error("Save emergency contact error:", error);
      setSyncMessage(`Supabase save failed: ${error.message}`);
    } finally {
      setSavingEmergency(false);
    }
  }

  const ageText = calculateAge(profileData.birthdate, profileData.age);
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

      {loading || syncMessage ? (
        <div
          className={`pwa-profile-feedback ${syncMessage?.toLowerCase().includes("failed") ? "is-error" : ""}`.trim()}
          role="status"
        >
          <Icon
            icon={loading ? "solar:refresh-linear" : "solar:info-circle-bold-duotone"}
            aria-hidden="true"
          />
          <span>{loading ? "Loading your latest profile information..." : syncMessage}</span>
        </div>
      ) : null}

      <section className="pwa-profile-hero">
        <div className="pwa-profile-photo-ring">
          <Avatar profile={profileData} />
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
              {formatDisplayValue(profileData.gender)}
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

        <EditableInfo
          label="Gender"
          value={profileData.gender}
          draftValue={personalDraft.gender}
          field="gender"
          icon="solar:users-group-rounded-linear"
          editing={editingPersonal}
          onChange={updatePersonalDraft}
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

        <EditableInfo
          label="Email"
          value={profileData.email}
          draftValue={personalDraft.email}
          field="email"
          icon="solar:letter-linear"
          editing={editingPersonal}
          onChange={updatePersonalDraft}
          type="email"
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
          value={profileData.dueDate}
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
          label="Relationship"
          value={profileData.emergencyRelation}
          draftValue={emergencyDraft.emergencyRelation}
          field="emergencyRelation"
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
  const weekText = normalizedWeek ? `Week ${normalizedWeek}` : "";

  return formatCombinedValues([trimester, weekText]);
}

function normalizePregnancyWeek(value) {
  const match = String(value ?? "").match(/\d+/);
  const week = match ? Number.parseInt(match[0], 10) : Number.NaN;
  return Number.isFinite(week) && week >= 1 && week <= 45 ? week : null;
}

function formatPregnancyWeek(value) {
  const week = normalizePregnancyWeek(value);
  if (!week) return "Not provided";
  return `${week} ${week === 1 ? "Week" : "Weeks"}`;
}

function hasLinkedPatientRecord(profile) {
  return [
    profile?.recordId,
    profile?.patientId,
    profile?.email,
    profile?.phone,
  ].some(hasMeaningfulValue);
}

function createPersonalDraft(profile) {
  return {
    displayName: profile.displayName || "",
    gender: profile.gender || "",
    bloodType: profile.bloodType || "",
    birthdate: toDateInputValue(profile.birthdate),
    civilStatus: profile.civilStatus || "",
    nationality: profile.nationality || "",
    phone: profile.phone || "",
    email: profile.email || "",
    address: profile.address || "",
  };
}

function createEmergencyDraft(profile) {
  return {
    emergencyName: profile.emergencyName || "",
    emergencyRelation: profile.emergencyRelation || "",
    emergencyPhone: profile.emergencyPhone || "",
  };
}

function mapPersonalInformationRow(row, currentProfile) {
  return {
    ...currentProfile,
    personalInfoId: row.id,
    patientId: row.patient_code || currentProfile.patientId,
    displayName: row.full_name || currentProfile.displayName || "",
    gender: row.gender || "",
    birthdate: row.birthdate || "",
    nationality: row.nationality || "",
    email: row.email || currentProfile.email || "",
    address: row.address || "",
    bloodType: row.blood_type || "",
    civilStatus: row.civil_status || "",
    phone: row.contact_number || currentProfile.phone || "",
  };
}

function mapEmergencyContactRow(row, currentProfile) {
  if (!row) return currentProfile;

  return {
    ...currentProfile,
    emergencyContactId: row.id,
    emergencyName: row.contact_person || "",
    emergencyRelation: row.relationship || "",
    emergencyPhone: row.contact_number || "",
  };
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
    <section className="pwa-info-card">
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
  const [error, setError] = useState(false);

  if (!profile.avatar || error) {
    return (
      <span className="pwa-profile-photo-fallback">
        {getInitials(profile.displayName)}
      </span>
    );
  }

  return <img src={profile.avatar} alt="" onError={() => setError(true)} />;
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
