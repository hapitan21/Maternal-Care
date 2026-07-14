import { useCallback, useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { supabase } from "../../lib/supabaseClient";
import {
  getStaffInitials,
  getStaffSettings,
  staffSettingsUpdatedEvent,
} from "../../lib/staffProfile";
import "../../styles/staff-viewprofile.css";

const staffProfilePhotoKey = "staff_profile_photo";
const defaultStaffProfilePhoto = "/images/doctor-kempee-profile.svg";

function getStaffProfilePhoto() {
  try {
    return (
      window.localStorage.getItem(staffProfilePhotoKey) ||
      window.localStorage.getItem("doctor_profile_photo") ||
      defaultStaffProfilePhoto
    );
  } catch {
    return defaultStaffProfilePhoto;
  }
}

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
  if (!value) return "Not set";

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
  return hasValue(value) ? value : "Not set";
}

function getFallbackProfile() {
  const settings = getStaffSettings();

  const experienceValue = String(
    settings.yearsExperience ?? ""
  ).replace(/[^\d]/g, "");

  return {
    displayName: settings.displayName || "",
    birthdate: normalizeDateForInput(settings.birthdate),
    civilStatus: settings.civilStatus || "",
    gender: settings.gender || "",
    nationality: settings.nationality || "",
    yearsExperience: experienceValue,

    staffCode: settings.doctorId || "",
    licenseNumber: settings.licenseNumber || "",
    boardCertification: settings.boardCertification || "",
    email: settings.email || "",
    contactNumber: settings.contactNumber || "",
    clinicName: settings.clinicName || "",
    clinicAddress: settings.clinicAddress || "",
  };
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
  const [activeTab, setActiveTab] = useState("personal");
  const [profilePhoto, setProfilePhoto] = useState(getStaffProfilePhoto);

  const [profile, setProfile] = useState(getFallbackProfile);

  const [loadingProfile, setLoadingProfile] = useState(true);

  const [profileError, setProfileError] = useState("");

  const [appointmentStats, setAppointmentStats] = useState([
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
  ]);

  const loadStaffProfile = useCallback(async () => {
    setLoadingProfile(true);
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

      const [personalResult, professionalResult] = await Promise.all([
        supabase
          .from("staff_personal_information")
          .select(
            `
              auth_user_id,
              full_name,
              birthdate,
              civil_status,
              gender,
              nationality,
              years_of_experience
            `
          )
          .eq("auth_user_id", user.id)
          .maybeSingle(),

        supabase
          .from("staff_professional_information")
          .select(
            `
              auth_user_id,
              staff_code,
              license_number,
              board_certification,
              email_address,
              contact_number,
              clinic_hospital_name,
              clinic_address
            `
          )
          .eq("auth_user_id", user.id)
          .maybeSingle(),
      ]);

      if (personalResult.error) {
        throw personalResult.error;
      }

      if (professionalResult.error) {
        throw professionalResult.error;
      }

      const fallbackProfile = getFallbackProfile();
      const personalData = personalResult.data;
      const professionalData = professionalResult.data;

      const loadedProfile = {
        displayName:
          personalData?.full_name ??
          fallbackProfile.displayName,

        birthdate:
          normalizeDateForInput(personalData?.birthdate) ||
          fallbackProfile.birthdate,

        civilStatus:
          personalData?.civil_status ??
          fallbackProfile.civilStatus,

        gender:
          personalData?.gender ??
          fallbackProfile.gender,

        nationality:
          personalData?.nationality ??
          fallbackProfile.nationality,

        yearsExperience: hasValue(
          personalData?.years_of_experience
        )
          ? String(personalData.years_of_experience)
          : fallbackProfile.yearsExperience,

        staffCode:
          professionalData?.staff_code ??
          fallbackProfile.staffCode,

        licenseNumber:
          professionalData?.license_number ??
          fallbackProfile.licenseNumber,

        boardCertification:
          professionalData?.board_certification ??
          fallbackProfile.boardCertification,

        email:
          professionalData?.email_address ??
          user.email ??
          fallbackProfile.email,

        contactNumber:
          professionalData?.contact_number ??
          fallbackProfile.contactNumber,

        clinicName:
          professionalData?.clinic_hospital_name ??
          fallbackProfile.clinicName,

        clinicAddress:
          professionalData?.clinic_address ??
          fallbackProfile.clinicAddress,
      };

      setProfile(loadedProfile);
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
    loadStaffProfile();
  }, [loadStaffProfile]);

  useEffect(() => {
    const syncProfile = () => {
      setProfilePhoto(getStaffProfilePhoto());
      loadStaffProfile();
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
          .in("status", ["completed", "checked_in"]),
      ]);

      if (!active) return;

      setAppointmentStats([
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
      ]);
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
      label: "Practice Location",
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
  ];

  const personalProfessionalInfo = [
    {
      icon: "solar:case-round-linear",
      label: "Years of Experience",
      value: hasValue(profile.yearsExperience)
        ? `${profile.yearsExperience} years`
        : "",
    },
    {
      icon: "solar:medical-kit-linear",
      label: "Specialization",
      value: profile.boardCertification,
    },
    {
      icon: "solar:heart-linear",
      label: "Civil Status",
      value: profile.civilStatus,
    },
  ];

  const professionalInfo = [
    {
      label: "Staff ID",
      value: profile.staffCode,
    },
    {
      label: "Employee Number",
      value: profile.licenseNumber,
    },
    {
      label: "Department",
      value: "Maternal Care Operations",
    },
    {
      label: "Clinic/Hospital",
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

  const professionalColumns = [
    professionalInfo.slice(0, 4),
    professionalInfo.slice(4),
  ];

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
        <div className="doctor-profile-main-photo-wrap">
          <div className="doctor-profile-main-photo">
            {profilePhoto ? (
              <img
                src={profilePhoto}
                alt={profile.displayName || "Staff profile"}
              />
            ) : (
              initials
            )}
          </div>
        </div>

        <div className="doctor-profile-main-info">
          <div className="doctor-profile-name-line">
            <h3>
              {loadingProfile
                ? "Loading..."
                : displayValue(profile.displayName)}
            </h3>

            <span className="doctor-profile-status">
              <span />
              Active
            </span>
          </div>

          <p>Maternal Care Staff</p>

          <span>
            Employee No.:{" "}
            {displayValue(profile.licenseNumber)}
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
          {loadingProfile ? (
            <div className="staff-profile-loading">
              <Icon icon="solar:refresh-linear" />
              Loading staff information...
            </div>
          ) : activeTab === "personal" ? (
            <>
              <div className="doctor-profile-info-column">
                {personalInfo.map((item) => (
                  <ProfileInfoRow
                    item={item}
                    key={item.label}
                  />
                ))}
              </div>

              <div className="doctor-profile-info-column">
                {personalProfessionalInfo.map((item) => (
                  <ProfileInfoRow
                    item={item}
                    key={item.label}
                  />
                ))}
              </div>
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
