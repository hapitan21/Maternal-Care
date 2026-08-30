import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
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

const staffAppointmentSummaryCards = [
  {
    key: "cancelled",
    label: "Cancelled",
    image: "/images/profile-ui/appointment-cancelled.png",
    path: "/staff/appointments?status=cancelled&view=history",
  },
  {
    key: "today",
    label: "Today's",
    image: "/images/profile-ui/appointment-today.png",
    path: "/staff/appointments",
  },
  {
    key: "pending",
    label: "Pending",
    image: "/images/profile-ui/appointment-pending.png",
    path: "/staff/appointments?status=pending&view=main",
  },
  {
    key: "completed",
    label: "Completed",
    image: "/images/profile-ui/appointment-completed.png",
    path: "/staff/appointments?status=completed&view=history",
  },
];

const staffAppointmentSummaryPeriods = [
  { value: "this-month", label: "This month" },
  { value: "last-month", label: "Last month" },
  { value: "all-time", label: "All time" },
];

const emptyStaffAppointmentSummary = {
  cancelled: 0,
  today: 0,
  pending: 0,
  completed: 0,
};

function getStaffSummaryRange(period) {
  if (period === "all-time") return null;

  const now = new Date();
  const monthOffset = period === "last-month" ? -1 : 0;
  const start = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 1);

  return {
    start: start.getTime(),
    end: end.getTime(),
  };
}

function isStaffAppointmentInSummaryPeriod(appointment, period) {
  const range = getStaffSummaryRange(period);
  if (!range) return true;

  const appointmentTime = new Date(appointment?.start_time || "").getTime();

  return (
    Number.isFinite(appointmentTime) &&
    appointmentTime >= range.start &&
    appointmentTime < range.end
  );
}

function isStaffAppointmentToday(appointment) {
  const appointmentTime = new Date(appointment?.start_time || "");

  if (Number.isNaN(appointmentTime.getTime())) return false;

  const today = new Date();

  return (
    appointmentTime.getFullYear() === today.getFullYear() &&
    appointmentTime.getMonth() === today.getMonth() &&
    appointmentTime.getDate() === today.getDate()
  );
}

function normalizeStaffAppointmentStatus(value) {
  return String(value || "").trim().toLowerCase();
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
  return { ...emptyStaffAppointmentSummary };
}

function ProfileInfoRow({ item }) {
  return (
    <div className="doctor-profile-info-row">
      <div
        className={`doctor-profile-row-icon ${
          item.image ? "has-reference-image" : ""
        }`}
      >
        {item.image ? (
          <img src={item.image} alt="" aria-hidden="true" />
        ) : (
          <Icon icon={item.icon} />
        )}
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

function StaffViewProfileContent({
  headerAction,
  initialProfilePhoto = "",
}) {
  const navigate = useNavigate();
  const initialProfileSnapshot = getSharedProfileSnapshot();

  const [activeTab, setActiveTab] = useState("personal");
  const [profilePhoto, setProfilePhoto] = useState(
    () => initialProfilePhoto || ""
  );

  /*
   * StaffDashboard stays mounted while Staff moves between sections.
   * Reuse its already-loaded avatar immediately so View Profile never
   * falls back to initials/old artwork while Supabase refreshes.
   */
  useEffect(() => {
    setProfilePhoto(initialProfilePhoto || "");
  }, [initialProfilePhoto]);

  const [profile, setProfile] = useState(
    initialProfileSnapshot
  );

  const [loadingProfile, setLoadingProfile] = useState(
    !hasProfileSnapshot(initialProfileSnapshot)
  );

  const [profileError, setProfileError] = useState("");

  const [appointmentSummaryPeriod, setAppointmentSummaryPeriod] =
    useState("this-month");

  const [appointmentStats, setAppointmentStats] = useState(
    () =>
      cachedStaffProfile &&
      cachedStaffAppointmentStats
        ? { ...cachedStaffAppointmentStats }
        : getDefaultAppointmentStats()
  );

  const [appointmentSummaryMessage, setAppointmentSummaryMessage] =
    useState("");

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
      /*
       * Do not replace a valid shell-provided avatar with an empty value
       * when the background avatar refresh fails or returns no URL.
       * Explicit Remove Photo is still handled by profilePictureUpdatedEvent
       * and ProfilePictureActions.
       */
      if (avatarResult.displayUrl) {
        setProfilePhoto(avatarResult.displayUrl);
      }

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
      const { data, error } = await supabase
        .from("schedule")
        .select("id, start_time, status")
        .order("start_time", { ascending: true });

      if (!active) return;

      if (error) {
        if (import.meta.env.DEV) {
          console.warn(
            "Unable to load Staff appointment summary:",
            error.message
          );
        }

        setAppointmentSummaryMessage(
          "Appointment summary could not be refreshed."
        );
        return;
      }

      setAppointmentSummaryMessage("");

      const nextSummary = (data || []).reduce(
        (summary, appointment) => {
          const status = normalizeStaffAppointmentStatus(
            appointment?.status
          );

          if (isStaffAppointmentToday(appointment)) {
            summary.today += 1;
          }

          if (
            !isStaffAppointmentInSummaryPeriod(
              appointment,
              appointmentSummaryPeriod
            )
          ) {
            return summary;
          }

          if (status === "cancelled" || status === "canceled") {
            summary.cancelled += 1;
          }

          if (
            status === "pending" ||
            status === "scheduled" ||
            status === "accepted"
          ) {
            summary.pending += 1;
          }

          if (status === "completed") {
            summary.completed += 1;
          }

          return summary;
        },
        { ...emptyStaffAppointmentSummary }
      );

      cachedStaffAppointmentStats = {
        ...nextSummary,
      };

      setAppointmentStats(nextSummary);
    };

    const refresh = () => {
      void loadAppointmentSummary();
    };

    refresh();

    const channel = supabase
      .channel(
        `staff-profile-appointment-summary-${appointmentSummaryPeriod}`
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "schedule",
        },
        refresh
      )
      .subscribe();

    const handleWindowFocus = () => refresh();
    window.addEventListener("focus", handleWindowFocus);

    return () => {
      active = false;
      window.removeEventListener("focus", handleWindowFocus);
      supabase.removeChannel(channel);
    };
  }, [appointmentSummaryPeriod]);

  const contactDetails = [
    {
      icon: "solar:letter-linear",
      image: "/images/profile-ui/profile-email.png",
      label: "Email Address",
      value: profile.email,
    },
    {
      icon: "solar:phone-linear",
      image: "/images/profile-ui/profile-phone.png",
      label: "Phone Number",
      value: profile.contactNumber,
    },
    {
      icon: "solar:map-point-linear",
      image: "/images/profile-ui/profile-location.png",
      label: "Location",
      value: [profile.clinicName, profile.clinicAddress]
        .filter(Boolean)
        .join(", "),
    },
  ];

  const personalInfo = [
    {
      icon: "solar:user-rounded-linear",
      image: "/images/profile-ui/profile-full-name.png",
      label: "Full Name",
      value: profile.displayName,
    },
    {
      icon:
        String(profile.gender || "").trim().toLowerCase() === "male"
          ? "mdi:gender-male"
          : String(profile.gender || "").trim().toLowerCase() === "female"
            ? "mdi:gender-female"
            : "mdi:gender-male-female",
      image:
        String(profile.gender || "").trim().toLowerCase() === "male"
          ? "/images/profile-ui/profile-gender-male.png"
          : String(profile.gender || "").trim().toLowerCase() === "female"
            ? "/images/profile-ui/profile-gender-female.png"
            : "",
      label: "Gender",
      value: profile.gender,
    },
    {
      icon: "solar:calendar-linear",
      image: "/images/profile-ui/profile-birthdate.png",
      label: "Birthdate",
      value: formatBirthdate(profile.birthdate),
    },
    {
      icon: "solar:flag-linear",
      image: "/images/profile-ui/profile-nationality.png",
      label: "Nationality",
      value: profile.nationality,
    },
  ];

  const personalContactInfo = [
    {
      icon: "solar:heart-linear",
      image: "/images/profile-ui/profile-civil-status.png",
      label: "Civil Status",
      value: profile.civilStatus,
    },
    {
      icon: "solar:map-point-linear",
      image: "/images/profile-ui/profile-location.png",
      label: "Address",
      value: profile.address,
    },
  ];

  const professionalLeftColumn = [
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
      label: "Hospital Clinic",
      value: profile.clinicName,
    },
    {
      label: "Clinic Address",
      value: profile.clinicAddress,
    },
  ];

  const professionalRightColumn = [
    {
      label: "Email",
      value: profile.email,
    },
    {
      label: "Contact Number",
      value: profile.contactNumber,
    },
    {
      label: "Employment Status",
      value: profile.employmentStatus,
    },
  ];

  const personalColumns = [personalInfo, personalContactInfo];
  const professionalColumns = [
    professionalLeftColumn,
    professionalRightColumn,
  ];

  const initials = getStaffInitials(
    profile.displayName || "Staff"
  );

  return (
    <section className="doctor-profile-page staff-profile-page">
      <header className="doctor-profile-page-header staff-section-header">
        <div className="doctor-page-title-block">
          <h2>Profile</h2>
          <p>View staff account information and professional details.</p>
        </div>

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
              <div
                className={`doctor-profile-contact-icon ${
                  item.image ? "has-reference-image" : ""
                }`}
              >
                {item.image ? (
                  <img src={item.image} alt="" aria-hidden="true" />
                ) : (
                  <Icon icon={item.icon} />
                )}
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

          <label className="doctor-profile-summary-period">
            <span className="doctor-profile-summary-period-label">
              Summary period
            </span>

            <select
              value={appointmentSummaryPeriod}
              onChange={(event) =>
                setAppointmentSummaryPeriod(event.target.value)
              }
              aria-label="Appointment summary period"
            >
              {staffAppointmentSummaryPeriods.map((period) => (
                <option value={period.value} key={period.value}>
                  {period.label}
                </option>
              ))}
            </select>

            <Icon
              icon="solar:alt-arrow-down-linear"
              aria-hidden="true"
            />
          </label>
        </div>

        {appointmentSummaryMessage ? (
          <p className="doctor-profile-summary-message" role="status">
            {appointmentSummaryMessage}
          </p>
        ) : null}

        <div className="doctor-profile-summary-grid">
          {staffAppointmentSummaryCards.map((card) => (
            <button
              className="doctor-profile-summary-card"
              type="button"
              key={card.key}
              onClick={() => navigate(card.path)}
              aria-label={`Open ${card.label} appointments`}
            >
              <div className="doctor-profile-summary-icon has-reference-image">
                <img
                  src={card.image}
                  alt=""
                  aria-hidden="true"
                  draggable="false"
                />
              </div>

              <div>
                <span>{card.label}</span>
                <strong>{appointmentStats[card.key]}</strong>
              </div>
            </button>
          ))}
        </div>
      </section>
    </section>
  );
}

export default StaffViewProfileContent;
