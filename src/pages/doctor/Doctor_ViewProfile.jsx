import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import "../../styles/doctor-viewprofile.css";

const doctorProfilePhotoKey = "doctor_profile_photo";
const doctorSettingsKey = "doctor_dashboard_settings";
const defaultDoctorProfile = {
  displayName: "Doctor",
  roleLabel: "Doctor",
};

const contactDetails = [
  {
    icon: "solar:letter-linear",
    label: "Email Address",
    value: "kempee.vergara@gmail.com",
  },
  {
    icon: "solar:phone-linear",
    label: "Phone Number",
    value: "0912 345 6789",
  },
  {
    icon: "solar:map-point-linear",
    label: "Practice Location",
    value: "La Paz Maternity and Reproductive Health Center, La Paz, Iloilo City, Philippines",
  },
];

const personalInfo = [
  {
    icon: "solar:user-rounded-linear",
    label: "Full Name",
    value: "Kempee Vergara",
  },
  {
    icon: "solar:woman-linear",
    label: "Gender",
    value: "Female",
  },
  {
    icon: "solar:calendar-linear",
    label: "Birthdate",
    value: "January 10, 1990",
  },
  {
    icon: "solar:flag-linear",
    label: "Nationality",
    value: "Filipino",
  },
];

const personalProfessionalInfo = [
  {
    icon: "solar:case-round-linear",
    label: "Years of Experience",
    value: "8 Years",
  },
  {
    icon: "solar:medical-kit-linear",
    label: "Specialization",
    value: "Obstetrics & Gynecology",
  },
  {
    icon: "solar:heart-linear",
    label: "Civil Status",
    value: "Married",
  },
];

const professionalInfo = [
  {
    label: "Doctor ID",
    value: "DOC-2023-001",
  },
  {
    label: "License Number",
    value: "1234567",
  },
  {
    label: "Board Certification",
    value: "Obstetrics and Gynecology",
  },
  {
    label: "Hospital/Clinic",
    value: "La Paz Health Center",
  },
  {
    label: "Clinic Address",
    value: "La Paz, Iloilo City, Philippines",
  },
  {
    label: "Email",
    value: "kempee.vergara@gmail.com",
  },
  {
    label: "Contact Number",
    value: "0912 345 6789",
  },
];

const appointmentStats = [
  {
    icon: "solar:calendar-remove-linear",
    label: "Canceled",
    value: "0",
  },
  {
    icon: "solar:calendar-mark-linear",
    label: "Today's",
    value: "5",
  },
  {
    icon: "solar:clock-circle-linear",
    label: "Pending",
    value: "1",
  },
  {
    icon: "solar:check-circle-linear",
    label: "Completed",
    value: "12",
  },
];

function getDoctorInitials(name) {
  const initials = String(name || "Doctor")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

  return initials || "DR";
}

function getStoredDoctorProfile() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(doctorSettingsKey));

    return {
      ...defaultDoctorProfile,
      displayName:
        String(saved?.displayName || "").trim() ||
        defaultDoctorProfile.displayName,
    };
  } catch {
    return { ...defaultDoctorProfile };
  }
}

function getDoctorDisplayName(user, profile, fallbackName) {
  const metadataName =
    user?.user_metadata?.full_name ||
    user?.user_metadata?.name ||
    "";
  const emailName = user?.email ? user.email.split("@")[0] : "";

  return (
    String(profile?.full_name || "").trim() ||
    String(metadataName || "").trim() ||
    String(fallbackName || "").trim() ||
    String(emailName || "").trim() ||
    defaultDoctorProfile.displayName
  );
}

async function loadDoctorProfile() {
  const fallbackProfile = getStoredDoctorProfile();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return fallbackProfile;
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", user.id)
    .maybeSingle();

  return {
    ...fallbackProfile,
    displayName: getDoctorDisplayName(
      user,
      profile,
      fallbackProfile.displayName
    ),
    roleLabel: "Doctor",
  };
}

function ProfileDropdown({ setActivePage, profile }) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef(null);
  const navigate = useNavigate();
  const [profilePhoto, setProfilePhoto] = useState(() => {
    try {
      return window.localStorage.getItem(doctorProfilePhotoKey) || "";
    } catch {
      return "";
    }
  });
  const initials = getDoctorInitials(profile.displayName);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setOpen(false);
      }
    };

    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("doctor-settings-updated", syncProfilePhoto);
    window.addEventListener("storage", syncProfilePhoto);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("doctor-settings-updated", syncProfilePhoto);
      window.removeEventListener("storage", syncProfilePhoto);
    };
  }, []);

  const syncProfilePhoto = () => {
    try {
      setProfilePhoto(window.localStorage.getItem(doctorProfilePhotoKey) || "");
    } catch {
      setProfilePhoto("");
    }
  };

  const handleViewProfile = () => {
    setOpen(false);
    setActivePage?.("profile");
  };

  const handleSettings = () => {
    setOpen(false);
    setActivePage?.("settings");
  };

  const handleLogout = async () => {
    try {
      setOpen(false);

      const { error } = await supabase.auth.signOut();

      if (error) {
        console.error("Logout error:", error.message);
        return;
      }

      navigate("/");
    } catch (error) {
      console.error("Unexpected logout error:", error);
    }
  };

  return (
    <div className="doctor-profile-menu-wrap" ref={dropdownRef}>
      <button
        className={`doctor-profile-top-card ${open ? "is-open" : ""}`}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <div className="doctor-profile-top-avatar">
          {profilePhoto ? <img src={profilePhoto} alt="" /> : initials}
        </div>

        <div className="doctor-profile-top-info">
          <strong>{profile.displayName}</strong>
          <span>{profile.roleLabel}</span>
        </div>

        <Icon
          className="doctor-profile-top-arrow"
          icon="ri:arrow-drop-down-line"
        />
      </button>

      {open && (
        <div className="doctor-profile-dropdown-card" role="menu">
          <div className="doctor-profile-dropdown-head">
            <div className="doctor-profile-dropdown-avatar">
              {profilePhoto ? <img src={profilePhoto} alt="" /> : initials}
            </div>

            <div>
              <strong>{profile.displayName}</strong>
              <span>{profile.roleLabel} Account</span>
            </div>
          </div>

          <div className="doctor-profile-dropdown-nav">
            <button type="button" onClick={handleViewProfile}>
              <Icon icon="solar:user-rounded-linear" />
              <span>View Profile</span>
            </button>

            <button type="button" onClick={handleSettings}>
              <Icon icon="solar:settings-linear" />
              <span>Settings</span>
            </button>

            <button type="button" className="logout" onClick={handleLogout}>
              <Icon icon="solar:logout-2-linear" />
              <span>Logout</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProfileInfoRow({ item }) {
  return (
    <div className="doctor-profile-info-row">
      <div className="doctor-profile-row-icon">
        <Icon icon={item.icon} />
      </div>

      <div className="doctor-profile-row-text">
        <span>{item.label}</span>
        <strong>{item.value}</strong>
      </div>
    </div>
  );
}

function ProfileDetailRow({ item }) {
  return (
    <div className="doctor-profile-detail-row">
      <span>{item.label}</span>
      <strong>{item.value}</strong>
    </div>
  );
}

function DoctorViewProfileContent({ setActivePage }) {
  const [activeTab, setActiveTab] = useState("personal");
  const [profile, setProfile] = useState(getStoredDoctorProfile);
  const [profilePhoto, setProfilePhoto] = useState(() => {
    try {
      return window.localStorage.getItem(doctorProfilePhotoKey) || "";
    } catch {
      return "";
    }
  });
  const professionalColumns = [
    professionalInfo.slice(0, 4),
    professionalInfo.slice(4),
  ];

  useEffect(() => {
    let active = true;

    const syncProfile = async () => {
      try {
        const [nextProfile] = await Promise.all([loadDoctorProfile()]);

        if (active) {
          setProfile(nextProfile);
          setProfilePhoto(window.localStorage.getItem(doctorProfilePhotoKey) || "");
        }
      } catch {
        if (active) {
          setProfilePhoto("");
        }
      }
    };

    syncProfile();

    window.addEventListener("doctor-settings-updated", syncProfile);
    window.addEventListener("storage", syncProfile);

    return () => {
      active = false;
      window.removeEventListener("doctor-settings-updated", syncProfile);
      window.removeEventListener("storage", syncProfile);
    };
  }, []);
  const initials = getDoctorInitials(profile.displayName);

  return (
    <section className="doctor-profile-page">
      <header className="doctor-profile-page-header">
        <div className="doctor-page-title-block">
          <h2>Profile</h2>
          <p>View doctor account information and professional details.</p>
        </div>

        <ProfileDropdown setActivePage={setActivePage} profile={profile} />
      </header>

      <section className="doctor-profile-hero-card">
        <div className="doctor-profile-main-photo-wrap">
          <div className="doctor-profile-main-photo">
            {profilePhoto ? (
              <img src={profilePhoto} alt={profile.displayName} />
            ) : (
              initials
            )}
          </div>
        </div>

        <div className="doctor-profile-main-info">
          <div className="doctor-profile-name-line">
            <h3>{profile.displayName}</h3>

            <span className="doctor-profile-status">
              <span />
              Active
            </span>
          </div>

          <p>OB-GYN Specialist</p>
          <span>License No.: 1234567</span>
        </div>

        <div className="doctor-profile-contact-list">
          {contactDetails.map((item) => (
            <div className="doctor-profile-contact-item" key={item.label}>
              <div className="doctor-profile-contact-icon">
                <Icon icon={item.icon} />
              </div>

              <div>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="doctor-profile-tabs-card">
        <div className="doctor-profile-tabs" role="tablist" aria-label="Profile information">
          <button
            type="button"
            className={activeTab === "personal" ? "active" : ""}
            role="tab"
            aria-selected={activeTab === "personal"}
            onClick={() => setActiveTab("personal")}
          >
            Personal Information
          </button>

          <button
            type="button"
            className={activeTab === "professional" ? "active" : ""}
            role="tab"
            aria-selected={activeTab === "professional"}
            onClick={() => setActiveTab("professional")}
          >
            Professional Information
          </button>
        </div>

        <div className="doctor-profile-tab-content" key={activeTab} role="tabpanel">
          {activeTab === "personal" ? (
            <>
              <div className="doctor-profile-info-column">
                {personalInfo.map((item) => (
                  <ProfileInfoRow item={item} key={item.label} />
                ))}
              </div>

              <div className="doctor-profile-info-column">
                {personalProfessionalInfo.map((item) => (
                  <ProfileInfoRow item={item} key={item.label} />
                ))}
              </div>
            </>
          ) : (
            professionalColumns.map((column, index) => (
              <div className="doctor-profile-detail-column" key={`professional-${index}`}>
                {column.map((item) => (
                  <ProfileDetailRow item={item} key={item.label} />
                ))}
              </div>
            ))
          )}
        </div>
      </section>

      <section className="doctor-profile-summary">
        <div className="doctor-profile-summary-header">
          <div>
            <Icon icon="solar:calendar-date-linear" />
            <h3>Appointment Summary</h3>
          </div>

          <button type="button">
            This Month
            <Icon icon="ri:arrow-drop-down-line" />
          </button>
        </div>

        <div className="doctor-profile-summary-grid">
          {appointmentStats.map((stat) => (
            <article className="doctor-profile-summary-card" key={stat.label}>
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

export default DoctorViewProfileContent;
