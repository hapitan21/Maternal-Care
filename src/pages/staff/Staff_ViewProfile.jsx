import { useCallback, useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { supabase } from "../../lib/supabaseClient";
import ProfilePictureActions from "../../components/common/ProfilePictureActions";
import ProfileAvatarContent from "../../components/common/ProfileAvatarContent";
import {
  loadCurrentProfilePicture,
  profilePictureUpdatedEvent,
} from "../../lib/profilePicture";
import {
  cacheStaffSettings,
  getStaffInitials,
  getStaffSettings,
  staffSettingsUpdatedEvent,
} from "../../lib/staffProfile";
import "../../styles/doctor-viewprofile.css";
import "../../styles/staff-viewprofile.css";

const staffPersonalSelect = `
  auth_user_id,
  full_name,
  birthdate,
  civil_status,
  gender,
  nationality,
  address
`;
const staffPersonalLegacySelect = `
  auth_user_id,
  full_name,
  birthdate,
  civil_status,
  gender,
  nationality
`;
const staffProfessionalSelect = `
  auth_user_id,
  staff_code,
  position,
  date_hired,
  employment_status,
  email_address,
  contact_number,
  clinic_hospital_name,
  clinic_address
`;
const staffProfessionalLegacySelect = `
  auth_user_id,
  staff_code,
  email_address,
  contact_number,
  clinic_hospital_name,
  clinic_address
`;

function getTodayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function hasValue(value) {
  return (
    value !== null &&
    value !== undefined &&
    String(value).trim() !== ""
  );
}

function normalizeDateForInput(value) {
  if (!value) return "";

  const textValue = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(textValue)) {
    return textValue;
  }

  const parsedDate = new Date(textValue);

  if (Number.isNaN(parsedDate.getTime())) {
    return "";
  }

  const year = parsedDate.getFullYear();
  const month = String(parsedDate.getMonth() + 1).padStart(2, "0");
  const day = String(parsedDate.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function formatBirthdate(value) {
  if (!value) return "Not provided";

  const parts = String(value).split("-");

  if (parts.length !== 3) {
    return value;
  }

  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);

  const date = new Date(year, month - 1, day);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function displayValue(value) {
  return hasValue(value) ? value : "Not provided";
}

function isSchemaColumnError(error) {
  if (!error) return false;
  const message = `${error.message || ""} ${error.details || ""}`.toLowerCase();
  return (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    message.includes("schema cache") ||
    message.includes("could not find") ||
    message.includes("column")
  );
}

async function loadStaffRecord(tableName, selectColumns, fallbackColumns, userId) {
  let { data, error } = await supabase
    .from(tableName)
    .select(selectColumns)
    .eq("auth_user_id", userId)
    .maybeSingle();

  if (error && isSchemaColumnError(error) && fallbackColumns) {
    const fallbackResult = await supabase
      .from(tableName)
      .select(fallbackColumns)
      .eq("auth_user_id", userId)
      .maybeSingle();
    data = fallbackResult.data;
    error = fallbackResult.error;
  }

  return { data, error };
}

function getEmptyProfile() {
  return {
    displayName: "",
    birthdate: "",
    civilStatus: "",
    gender: "",
    nationality: "",
    address: "",
    employeeId: "",
    position: "",
    dateHired: "",
    employmentStatus: "",
    email: "",
    contactNumber: "",
    clinicName: "",
    clinicAddress: "",
    accountStatus: "",
  };
}

let cachedStaffProfile = null;

let cachedStaffAppointmentStats = null;

function getSharedProfileSnapshot() {
  const sharedSettings = getStaffSettings();

  const cachedEmail = String(
    cachedStaffProfile?.email || ""
  )
    .trim()
    .toLowerCase();

  const sharedEmail = String(
    sharedSettings.email || ""
  )
    .trim()
    .toLowerCase();

  /*
   * Reuse the module snapshot only when it belongs to the currently
   * authorized Staff identity. This avoids showing a previous Staff account
   * after logout/login in the same browser tab.
   */
  if (
    cachedStaffProfile &&
    sharedEmail &&
    cachedEmail === sharedEmail
  ) {
    return {
      ...cachedStaffProfile,
    };
  }

  if (
    cachedStaffProfile &&
    (!sharedEmail || cachedEmail !== sharedEmail)
  ) {
    cachedStaffProfile = null;
    cachedStaffAppointmentStats = null;
  }

  return {
    ...getEmptyProfile(),
    displayName: sharedSettings.displayName || "",
    birthdate: sharedSettings.birthdate || "",
    civilStatus: sharedSettings.civilStatus || "",
    gender: sharedSettings.gender || "",
    nationality: sharedSettings.nationality || "",
    address: sharedSettings.address || "",
    employeeId:
      sharedSettings.employeeId ||
      sharedSettings.doctorId ||
      "",
    position: sharedSettings.position || "",
    dateHired: sharedSettings.dateHired || "",
    employmentStatus:
      sharedSettings.employmentStatus || "",
    email: sharedSettings.email || "",
    contactNumber: sharedSettings.contactNumber || "",
    clinicName: sharedSettings.clinicName || "",
    clinicAddress: sharedSettings.clinicAddress || "",
  };
}

function hasProfileSnapshot(profile) {
  return Boolean(
    profile?.displayName ||
      profile?.email ||
      profile?.employeeId ||
      profile?.contactNumber
  );
}

function getDefaultAppointmentStats() {
  return [
    {
      icon: "solar:calendar-remove-linear",
      label: "Canceled",
      value: "0",
    },
    {
      icon: "solar:calendar-mark-linear",
      label: "Today's",
      value: "0",
    },
    {
      icon: "solar:clock-circle-linear",
      label: "Pending",
      value: "0",
    },
    {
      icon: "solar:check-circle-linear",
      label: "Completed",
      value: "0",
    },
  ];
}

function ProfileInfoRow({ item }) {
  return (
    <div className="doctor-profile-info-row">
      <div className="doctor-profile-row-icon">
        <Icon icon={item.icon} />
      </div>

      <div className="doctor-profile-row-text">
        <span>{item.label}</span>
        <strong>{displayValue(item.value)}</strong>
      </div>
    </div>
  );
}

function ProfileDetailRow({ item }) {
  return (
    <div className="doctor-profile-detail-row">
      <span>{item.label}</span>
      <strong>{displayValue(item.value)}</strong>
    </div>
  );
}

function StaffViewProfileContent({ headerAction }) {
  const initialProfileSnapshot = getSharedProfileSnapshot();

  const [activeTab, setActiveTab] = useState("personal");
  const [profilePhoto, setProfilePhoto] = useState("");

  const [profile, setProfile] = useState(
    initialProfileSnapshot
  );

  const [loadingProfile, setLoadingProfile] = useState(
    !hasProfileSnapshot(initialProfileSnapshot)
  );

  const [profileError, setProfileError] = useState("");

  const [appointmentStats, setAppointmentStats] = useState(
    () =>
      cachedStaffProfile &&
      cachedStaffAppointmentStats
        ? cachedStaffAppointmentStats.map((item) => ({
            ...item,
          }))
        : getDefaultAppointmentStats()
  );

  const loadStaffProfile = useCallback(async () => {
    /*
     * Keep the last successful profile visible while Supabase refreshes.
     * Only show the blocking profile loader when there is no usable snapshot.
     */
    if (!cachedStaffProfile) {
      const sharedSnapshot = getSharedProfileSnapshot();

      if (!hasProfileSnapshot(sharedSnapshot)) {
        setLoadingProfile(true);
      } else {
        setProfile(sharedSnapshot);
        setLoadingProfile(false);
      }
    }

    setProfileError("");

    try {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError) {
        throw userError;
      }

      if (!user) {
        throw new Error(
          "No logged-in staff account was found. Please log in again."
        );
      }

      const [profileResult, personalResult, professionalResult, avatarResult] = await Promise.all([
        supabase
          .from("profiles")
          .select("full_name, email, account_status")
          .eq("id", user.id)
          .maybeSingle(),
        loadStaffRecord(
          "staff_personal_information",
          staffPersonalSelect,
          staffPersonalLegacySelect,
          user.id
        ),
        loadStaffRecord(
          "staff_professional_information",
          staffProfessionalSelect,
          staffProfessionalLegacySelect,
          user.id
        ),
        loadCurrentProfilePicture().catch((error) => {
          if (import.meta.env.DEV) {
            console.warn("Unable to load Staff profile picture:", error);
          }
          return { displayUrl: "" };
        }),
      ]);

      if (profileResult.error) {
        throw profileResult.error;
      }

      if (personalResult.error) {
        throw personalResult.error;
      }

      if (professionalResult.error) {
        throw professionalResult.error;
      }

      const authMetadataName =
        user.user_metadata?.full_name || user.user_metadata?.name || "";
      const profileData = profileResult.data;
      const personalData = personalResult.data;
      const professionalData = professionalResult.data;
      setProfilePhoto(avatarResult.displayUrl || "");

      const loadedProfile = {
        displayName:
          personalData?.full_name ||
          profileData?.full_name ||
          authMetadataName ||
          "",

        birthdate:
          normalizeDateForInput(personalData?.birthdate),

        civilStatus:
          personalData?.civil_status || "",

        gender:
          personalData?.gender || "",

        nationality:
          personalData?.nationality || "",

        address:
          personalData?.address || "",

        employeeId:
          professionalData?.staff_code || "",

        position:
          professionalData?.position || "",

        dateHired:
          normalizeDateForInput(professionalData?.date_hired),

        employmentStatus:
          professionalData?.employment_status || "",

        email:
          professionalData?.email_address ||
          profileData?.email ||
          user.email ||
          "",

        contactNumber:
          professionalData?.contact_number || "",

        clinicName:
          professionalData?.clinic_hospital_name || "",

        clinicAddress:
          professionalData?.clinic_address || "",

        accountStatus:
          profileData?.account_status || "",
      };

      cachedStaffProfile = {
        ...loadedProfile,
      };

      setProfile(loadedProfile);

      /*
       * Synchronize the shared Staff UI snapshot after the Supabase read.
       * Supabase remains authoritative; this only prevents cross-page flashes.
       */
      cacheStaffSettings(
        {
          ...getStaffSettings(),
          displayName: loadedProfile.displayName,
          birthdate: loadedProfile.birthdate,
          civilStatus: loadedProfile.civilStatus,
          gender: loadedProfile.gender,
          nationality: loadedProfile.nationality,
          address: loadedProfile.address,
          employeeId: loadedProfile.employeeId,
          position: loadedProfile.position,
          dateHired: loadedProfile.dateHired,
          employmentStatus:
            loadedProfile.employmentStatus,
          email: loadedProfile.email,
          contactNumber: loadedProfile.contactNumber,
          clinicName: loadedProfile.clinicName,
          clinicAddress: loadedProfile.clinicAddress,
        },
        { broadcast: false }
      );
    } catch (error) {
      console.error("Unable to load staff profile:", error);

      setProfileError(
        error?.message || "Unable to load the staff profile."
      );
    } finally {
      setLoadingProfile(false);
    }
  }, []);

  useEffect(() => {
    const loadProfileTimer = window.setTimeout(loadStaffProfile, 0);

    return () => {
      window.clearTimeout(loadProfileTimer);
    };
  }, [loadStaffProfile]);

  useEffect(() => {
    const syncProfile = () => {
      loadStaffProfile();
    };

    const syncProfilePicture = (event) => {
      setProfilePhoto(event.detail?.displayUrl || "");
    };

    window.addEventListener(
      staffSettingsUpdatedEvent,
      syncProfile
    );

    window.addEventListener(
      "doctor-settings-updated",
      syncProfile
    );

    window.addEventListener("storage", syncProfile);
    window.addEventListener(profilePictureUpdatedEvent, syncProfilePicture);

    return () => {
      window.removeEventListener(
        staffSettingsUpdatedEvent,
        syncProfile
      );

      window.removeEventListener(
        "doctor-settings-updated",
        syncProfile
      );

      window.removeEventListener("storage", syncProfile);
      window.removeEventListener(profilePictureUpdatedEvent, syncProfilePicture);
    };
  }, [loadStaffProfile]);

  useEffect(() => {
    let active = true;

    const loadAppointmentSummary = async () => {
      const todayRange = getTodayRange();

      const [
        cancelledResult,
        todayResult,
        pendingResult,
        completedResult,
      ] = await Promise.all([
        supabase
          .from("schedule")
          .select("id", { count: "exact", head: true })
          .in("status", ["cancelled", "canceled"]),

        supabase
          .from("schedule")
          .select("id", { count: "exact", head: true })
          .gte("start_time", todayRange.start)
          .lt("start_time", todayRange.end),

        supabase
          .from("schedule")
          .select("id", { count: "exact", head: true })
          .in("status", [
            "scheduled",
            "pending",
            "accepted",
          ]),

        supabase
          .from("schedule")
          .select("id", { count: "exact", head: true })
          .in("status", ["completed"]),
      ]);

      if (!active) return;

      const nextAppointmentStats = [
        {
          icon: "solar:calendar-remove-linear",
          label: "Canceled",
          value: String(cancelledResult.count ?? 0),
        },
        {
          icon: "solar:calendar-mark-linear",
          label: "Today's",
          value: String(todayResult.count ?? 0),
        },
        {
          icon: "solar:clock-circle-linear",
          label: "Pending",
          value: String(pendingResult.count ?? 0),
        },
        {
          icon: "solar:check-circle-linear",
          label: "Completed",
          value: String(completedResult.count ?? 0),
        },
      ];

      cachedStaffAppointmentStats =
        nextAppointmentStats.map((item) => ({
          ...item,
        }));

      setAppointmentStats(nextAppointmentStats);
    };

    loadAppointmentSummary();

    const channel = supabase
      .channel("staff-profile-appointment-summary")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "schedule",
        },
        loadAppointmentSummary
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, []);

  const contactDetails = [
    {
      icon: "solar:letter-linear",
      label: "Email Address",
      value: profile.email,
    },
    {
      icon: "solar:phone-linear",
      label: "Phone Number",
      value: profile.contactNumber,
    },
    {
      icon: "solar:map-point-linear",
      label: "Clinic Address",
      value: profile.clinicAddress,
    },
  ];

  const personalInfo = [
    {
      icon: "solar:user-rounded-linear",
      label: "Full Name",
      value: profile.displayName,
    },
    {
      icon: "solar:woman-linear",
      label: "Gender",
      value: profile.gender,
    },
    {
      icon: "solar:calendar-linear",
      label: "Birthdate",
      value: formatBirthdate(profile.birthdate),
    },
    {
      icon: "solar:flag-linear",
      label: "Nationality",
      value: profile.nationality,
    },
    {
      icon: "solar:heart-linear",
      label: "Civil Status",
      value: profile.civilStatus,
    },
    {
      icon: "solar:map-point-linear",
      label: "Address",
      value: profile.address,
    },
  ];

  const professionalInfo = [
    {
      label: "Employee ID",
      value: profile.employeeId,
    },
    {
      label: "Position",
      value: profile.position,
    },
    {
      label: "Date Hired",
      value: formatBirthdate(profile.dateHired),
    },
    {
      label: "Employment Status",
      value: profile.employmentStatus,
    },
    {
      label: "Clinic/Hospital Name",
      value: profile.clinicName,
    },
    {
      label: "Clinic Address",
      value: profile.clinicAddress,
    },
    {
      label: "Email",
      value: profile.email,
    },
    {
      label: "Contact Number",
      value: profile.contactNumber,
    },
  ];

  const personalColumns = [personalInfo.slice(0, 3), personalInfo.slice(3)];
  const professionalColumns = [professionalInfo.slice(0, 4), professionalInfo.slice(4)];

  const initials = getStaffInitials(
    profile.displayName || "Staff"
  );

  return (
    <section className="doctor-profile-page staff-profile-page">
      <header className="doctor-profile-page-header staff-section-header">
        <h2>Profile</h2>
        {headerAction}
      </header>

      <section className="doctor-profile-hero-card">
        <div className="profile-picture-editor staff-profile-picture-editor">
          <div className="doctor-profile-main-photo-wrap">
            <div className="doctor-profile-main-photo">
              <ProfileAvatarContent
                src={profilePhoto}
                alt={profile.displayName || "Staff profile"}
                fallback={initials}
              />
            </div>
          </div>

          <ProfilePictureActions
            avatarUrl={profilePhoto}
            disabled={loadingProfile}
            onChange={(nextAvatarUrl) => setProfilePhoto(nextAvatarUrl)}
          />
        </div>

        <div className="doctor-profile-main-info">
          <div className="doctor-profile-name-line">
            <h3>
              {loadingProfile &&
              !hasProfileSnapshot(profile)
                ? "Loading..."
                : displayValue(profile.displayName)}
            </h3>

            <span className="doctor-profile-status">
              <span />
              Active
            </span>
          </div>

          <p>{displayValue(profile.position || "Staff")}</p>

          <span>
            Employee ID: {displayValue(profile.employeeId)}
          </span>
        </div>

        <div className="doctor-profile-contact-list">
          {contactDetails.map((item) => (
            <div
              className="doctor-profile-contact-item"
              key={item.label}
            >
              <div className="doctor-profile-contact-icon">
                <Icon icon={item.icon} />
              </div>

              <div>
                <span>{item.label}</span>
                <strong>
                  {displayValue(item.value)}
                </strong>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="doctor-profile-tabs-card">
        <div className="staff-profile-tab-topbar">
          <div
            className="doctor-profile-tabs"
            role="tablist"
            aria-label="Profile information"
          >
            <button
              type="button"
              className={
                activeTab === "personal" ? "active" : ""
              }
              role="tab"
              aria-selected={activeTab === "personal"}
              onClick={() => setActiveTab("personal")}
            >
              Personal Information
            </button>

            <button
              type="button"
              className={
                activeTab === "professional"
                  ? "active"
                  : ""
              }
              role="tab"
              aria-selected={
                activeTab === "professional"
              }
              onClick={() =>
                setActiveTab("professional")
              }
            >
              Professional Information
            </button>
          </div>
        </div>

        {profileError && (
          <div
            className="staff-profile-message error"
            role="alert"
          >
            <Icon icon="solar:danger-circle-linear" />
            <span>{profileError}</span>
          </div>
        )}

        <div
          className="doctor-profile-tab-content"
          key={activeTab}
          role="tabpanel"
        >
          {loadingProfile &&
          !hasProfileSnapshot(profile) ? (
            <div className="staff-profile-loading">
              <Icon icon="solar:refresh-linear" />
              Loading staff information...
            </div>
          ) : activeTab === "personal" ? (
            <>
              {personalColumns.map((column, index) => (
                <div
                  className="doctor-profile-info-column"
                  key={`personal-${index}`}
                >
                  {column.map((item) => (
                    <ProfileInfoRow
                      item={item}
                      key={item.label}
                    />
                  ))}
                </div>
              ))}
            </>
          ) : (
            professionalColumns.map((column, index) => (
              <div
                className="doctor-profile-detail-column"
                key={`professional-${index}`}
              >
                {column.map((item) => (
                  <ProfileDetailRow
                    item={item}
                    key={item.label}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      </section>

      <section className="doctor-profile-summary">
        <div className="doctor-profile-summary-header">
          <div>
            <Icon icon="solar:chart-square-linear" />
            <h3>Appointment Summary</h3>
          </div>

          <button type="button">
            This month
            <Icon icon="solar:alt-arrow-down-linear" />
          </button>
        </div>

        <div className="doctor-profile-summary-grid">
          {appointmentStats.map((stat) => (
            <article
              className="doctor-profile-summary-card"
              key={stat.label}
            >
              <div className="doctor-profile-summary-icon">
                <Icon icon={stat.icon} />
              </div>

              <div>
                <span>{stat.label}</span>
                <strong>{stat.value}</strong>
              </div>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}

export default StaffViewProfileContent;
