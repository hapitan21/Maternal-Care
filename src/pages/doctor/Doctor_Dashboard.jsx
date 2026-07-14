import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import { DoctorAppointmentsContent } from "./Doctor_Appointments";
import DoctorPatientsContent from "./Doctor_Patients";
import DoctorReminderContent from "./Doctor_Reminder";
import DoctorSettingsContent from "./Doctor_Settings";
import DoctorViewProfileContent from "./Doctor_ViewProfile";
import "../../styles/doctor-dashboard.css";

const doctorProfilePhotoKey = "doctor_profile_photo";
const doctorSettingsKey = "doctor_dashboard_settings";
const defaultDoctorProfilePhoto = "/images/doctor-kempee-profile.svg";
const defaultDoctorDashboardProfile = {
  displayName: "Doctor",
  roleLabel: "Doctor",
};

function getDoctorProfilePhoto() {
  try {
    return window.localStorage.getItem(doctorProfilePhotoKey) || defaultDoctorProfilePhoto;
  } catch {
    return defaultDoctorProfilePhoto;
  }
}

function getStoredDoctorDashboardProfile() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(doctorSettingsKey));

    return {
      ...defaultDoctorDashboardProfile,
      displayName:
        String(saved?.displayName || "").trim() ||
        defaultDoctorDashboardProfile.displayName,
      roleLabel: "Doctor",
    };
  } catch {
    return { ...defaultDoctorDashboardProfile };
  }
}

function getAccountDisplayName(user, profile, fallbackName) {
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
    defaultDoctorDashboardProfile.displayName
  );
}

async function loadDoctorDashboardProfile() {
  const fallbackProfile = getStoredDoctorDashboardProfile();
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
    displayName: getAccountDisplayName(
      user,
      profile,
      fallbackProfile.displayName
    ),
    roleLabel: "Doctor",
  };
}

const navItems = [
  {
    key: "dashboard",
    label: "Dashboard",
    icon: "solar:widget-2-bold",
  },
  {
    key: "patients",
    label: "Patients",
    icon: "solar:users-group-rounded-bold",
  },
  {
    key: "appointments",
    label: "Appointments",
    icon: "solar:calendar-linear",
  },
  {
    key: "reminders",
    label: "Reminders",
    icon: "solar:bell-linear",
  },
];

const dashboardStatusCards = [
  {
    label: "Total Patients",
    statKey: "totalPatients",
    icon: "solar:user-bold",
    tone: "red",
    badge: "Live count",
    target: "patients",
  },
  {
    label: "Today's Appointment",
    statKey: "todaysAppointments",
    icon: "solar:clock-circle-bold",
    tone: "pink",
    avatars: true,
    target: "appointments",
  },
  {
    label: "Session Completed",
    statKey: "completedSessions",
    icon: "solar:check-circle-bold",
    tone: "blue",
    progressKey: "completionProgress",
    target: "appointments",
  },
];

function getInitials(name) {
  const parts = String(name || "Patient").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "PT";

  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function formatDashboardDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

function formatDashboardTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function getTodayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(start.getDate() + 1);

  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function mapUpcomingSession(row) {
  return {
    id: row.id,
    initials: getInitials(row.patient_name),
    patient: row.patient_name || "Patient",
    date: formatDashboardDate(row.start_time),
    time: formatDashboardTime(row.start_time),
    avatarClass: "avatar-pink",
  };
}

function ProfileDropdown({
  onViewProfile,
  onSettings,
  onLogout,
  profile,
  profilePhoto,
}) {
  const initials = getInitials(profile.displayName || profile.roleLabel);

  return (
    <div className="doctor-profile-dropdown">
      <div className="doctor-dropdown-user">
        <div className="doctor-dropdown-avatar">
          {profilePhoto ? <img src={profilePhoto} alt="" /> : initials}
        </div>

        <div>
          <strong>{profile.displayName}</strong>
          <span>{profile.roleLabel} Account</span>
        </div>
      </div>

      <div className="doctor-dropdown-menu">
        <button type="button" onClick={onViewProfile}>
          <Icon icon="solar:user-rounded-linear" />
          <span>View Profile</span>
        </button>

        <button type="button" onClick={onSettings}>
          <Icon icon="solar:settings-linear" />
          <span>Settings</span>
        </button>

        <button type="button" className="logout" onClick={onLogout}>
          <Icon icon="solar:logout-2-linear" />
          <span>Logout</span>
        </button>
      </div>
    </div>
  );
}

function ProfileCard({ setActivePage, profile }) {
  const navigate = useNavigate();
  const dropdownRef = useRef(null);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [profilePhoto, setProfilePhoto] = useState(getDoctorProfilePhoto);
  const initials = getInitials(profile.displayName || profile.roleLabel);

  const syncProfilePhoto = () => {
    setProfilePhoto(getDoctorProfilePhoto());
  };

  useEffect(() => {
    function handleClickOutside(event) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target)
      ) {
        setIsDropdownOpen(false);
      }
    }

    function handleEscape(event) {
      if (event.key === "Escape") {
        setIsDropdownOpen(false);
      }
    }

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

  const handleViewProfile = () => {
    setActivePage("profile");
    setIsDropdownOpen(false);
  };

  const handleSettings = () => {
    setActivePage("settings");
    setIsDropdownOpen(false);
  };

  const handleLogout = async () => {
    setIsDropdownOpen(false);
    await supabase.auth.signOut();
    navigate("/");
  };

  return (
    <div className="doctor-profile-wrapper" ref={dropdownRef}>
      <button
        className={`doctor-profile-card ${isDropdownOpen ? "open" : ""}`}
        type="button"
        onClick={() => setIsDropdownOpen((prev) => !prev)}
        aria-expanded={isDropdownOpen}
        aria-haspopup="menu"
      >
        <div className="doctor-profile-avatar">
          {profilePhoto ? <img src={profilePhoto} alt="" /> : initials}
        </div>

        <div className="doctor-profile-info">
          <strong>{profile.displayName}</strong>
          <span>{profile.roleLabel}</span>
        </div>

        <Icon
          className="doctor-profile-arrow"
          icon="ri:arrow-drop-down-line"
        />
      </button>

      {isDropdownOpen && (
        <ProfileDropdown
          onViewProfile={handleViewProfile}
          onSettings={handleSettings}
          onLogout={handleLogout}
          profile={profile}
          profilePhoto={profilePhoto}
        />
      )}
    </div>
  );
}

function DashboardHome({
  setActivePage,
  headerAction,
  dashboardStats,
  upcomingSessions,
  dashboardMessage,
  accountName,
}) {
  const statusCards = dashboardStatusCards.map((card) => ({
    ...card,
    value: String(dashboardStats[card.statKey] ?? 0),
    progress: card.progressKey ? dashboardStats[card.progressKey] : card.progress,
  }));

  return (
    <div className="doctor-dashboard-home">
      <header className="doctor-topbar">
        <div className="doctor-page-title-block">
          <h2>Dashboard</h2>
          <p>Monitor today&apos;s appointments, patients, and session activity.</p>
        </div>
        {headerAction}
      </header>

      <section className="doctor-hero-card">
        <div className="doctor-hero-blur doctor-hero-blur-one" />
        <div className="doctor-hero-blur doctor-hero-blur-two" />

        <div className="doctor-hero-text">
          <h1>Welcome back, {accountName}!</h1>
          <p>
            Here&apos;s what&apos;s happening with your practice today. You have
            {` ${dashboardStats.todaysAppointments} appointments scheduled.`}
          </p>
        </div>

        <img
          className="doctor-hero-illustration"
          src="/images/dashboard-hero-people.png"
          alt="Maternal care team"
        />
      </section>

      {dashboardMessage ? (
        <p className="doctor-dashboard-message">{dashboardMessage}</p>
      ) : null}

      <section className="doctor-status-row">
        {statusCards.map((card) => (
          <button
            className="doctor-status-card"
            key={card.label}
            type="button"
            onClick={() => setActivePage(card.target)}
          >
            <div className="doctor-status-main">
              <div className={`doctor-status-icon ${card.tone}`}>
                <Icon icon={card.icon} />
              </div>

              <div className="doctor-status-copy">
                <p>{card.label}</p>
                <h3>{card.value}</h3>
              </div>
            </div>

            {card.badge && (
              <span className="doctor-growth-badge">{card.badge}</span>
            )}

            {card.avatars && (
              <div className="doctor-mini-avatars">
                <span />
                <span />
              </div>
            )}

            {card.progress && (
              <div className="doctor-progress-track">
                <span style={{ width: `${card.progress}%` }} />
              </div>
            )}
          </button>
        ))}
      </section>

      <section className="doctor-upcoming-section">
        <div className="doctor-section-header">
          <h2>Upcoming Sessions</h2>

          <button type="button" onClick={() => setActivePage("appointments")}>
            View All Sessions
            <Icon icon="lucide:chevron-right" />
          </button>
        </div>

        <div className="doctor-sessions-card">
          <div className="doctor-sessions-scroll">
            <table className="doctor-sessions-table">
              <thead>
                <tr>
                  <th>Appointment ID</th>
                  <th>Patient Name</th>
                  <th>Date</th>
                  <th>Time</th>
                  <th>Actions</th>
                </tr>
              </thead>

              <tbody>
                {upcomingSessions.map((session) => (
                  <tr key={session.id}>
                    <td>{session.id}</td>

                    <td>
                      <div className="doctor-patient-cell">
                        <span
                          className={`doctor-patient-avatar ${session.avatarClass}`}
                        >
                          {session.initials}
                        </span>

                        <span>{session.patient}</span>
                      </div>
                    </td>

                    <td>{session.date}</td>

                    <td>
                      <span className="doctor-time-pill">{session.time}</span>
                    </td>

                    <td>
                      <button
                        type="button"
                        className="doctor-table-action"
                        aria-label={`Open actions for ${session.patient}`}
                        onClick={() => setActivePage("appointments")}
                      >
                        <Icon icon="solar:menu-dots-bold" />
                      </button>
                    </td>
                  </tr>
                ))}

                {!upcomingSessions.length ? (
                  <tr>
                    <td colSpan="5">No upcoming sessions found.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}

function Doctor_Dashboard() {
  const [activePage, setActivePage] = useState("dashboard");
  const [profile, setProfile] = useState(getStoredDoctorDashboardProfile);
  const [dashboardStats, setDashboardStats] = useState({
    totalPatients: 0,
    todaysAppointments: 0,
    completedSessions: 0,
    completionProgress: 0,
  });
  const [upcomingSessions, setUpcomingSessions] = useState([]);
  const [dashboardMessage, setDashboardMessage] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;

    const syncProfile = async () => {
      const nextProfile = await loadDoctorDashboardProfile();

      if (active) {
        setProfile(nextProfile);
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

  useEffect(() => {
    let active = true;

    const loadDashboardStats = async () => {
      const todayRange = getTodayRange();

      const [patientsResult, todaysResult, completedResult, upcomingResult] = await Promise.all([
        supabase
          .from("patients")
          .select("id", { count: "exact", head: true })
          .ilike("status", "active"),
        supabase
          .from("schedule")
          .select("id", { count: "exact", head: true })
          .gte("start_time", todayRange.start)
          .lt("start_time", todayRange.end),
        supabase
          .from("schedule")
          .select("id", { count: "exact", head: true })
          .eq("status", "completed"),
        supabase
          .from("schedule")
          .select("id, patient_name, start_time, status")
          .gte("start_time", new Date().toISOString())
          .order("start_time", { ascending: true })
          .limit(4),
      ]);

      if (!active) return;

      const errors = [
        patientsResult.error,
        todaysResult.error,
        completedResult.error,
        upcomingResult.error,
      ]
        .filter(Boolean)
        .map((error) => error.message);

      setDashboardMessage(
        errors.length ? `Unable to load dashboard totals: ${errors.join(" ")}` : ""
      );

      const todaysAppointments = todaysResult.count ?? 0;
      const completedSessions = completedResult.count ?? 0;

      setDashboardStats({
        totalPatients: patientsResult.count ?? 0,
        todaysAppointments,
        completedSessions,
        completionProgress: todaysAppointments
          ? Math.min(100, Math.round((completedSessions / todaysAppointments) * 100))
          : 0,
      });

      setUpcomingSessions((upcomingResult.data || []).map(mapUpcomingSession));
    };

    loadDashboardStats();

    const patientsChannel = supabase
      .channel("doctor-dashboard-patients-count")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "patients" },
        loadDashboardStats
      )
      .subscribe();

    const scheduleChannel = supabase
      .channel("doctor-dashboard-schedule-count")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "schedule" },
        loadDashboardStats
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(patientsChannel);
      supabase.removeChannel(scheduleChannel);
    };
  }, []);

  useEffect(() => {
    const handleDoctorNavigation = async (event) => {
      const section = event.detail?.section;

      if (!section) {
        return;
      }

      if (section === "logout") {
        await supabase.auth.signOut();
        navigate("/");
        return;
      }

      setActivePage(section);
    };

    window.addEventListener("doctor:navigate", handleDoctorNavigation);

    return () => {
      window.removeEventListener("doctor:navigate", handleDoctorNavigation);
    };
  }, [navigate]);

  const renderContent = () => {
    switch (activePage) {
      case "patients":
        return <DoctorPatientsContent />;

      case "appointments":
        return <DoctorAppointmentsContent headerAction={<span className="doctor-global-profile-placeholder" aria-hidden="true" />} />;

      case "reminders":
        return <DoctorReminderContent headerAction={<span className="doctor-global-profile-placeholder" aria-hidden="true" />} />;

      case "profile":
        return <DoctorViewProfileContent setActivePage={setActivePage} />;

      case "settings":
        return <DoctorSettingsContent headerAction={<span className="doctor-global-profile-placeholder" aria-hidden="true" />} />;

      case "dashboard":
      default:
        return (
          <DashboardHome
            setActivePage={setActivePage}
            headerAction={
              <ProfileCard setActivePage={setActivePage} profile={profile} />
            }
            dashboardStats={dashboardStats}
            upcomingSessions={upcomingSessions}
            dashboardMessage={dashboardMessage}
            accountName={profile.displayName}
          />
        );
    }
  };

  return (
    <div className="doctor-dashboard">
      <aside className="doctor-sidebar">
        <div className="doctor-sidebar-inner">
          <div className="doctor-brand">
            <div className="doctor-brand-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="5.6" r="2.2" fill="currentColor" />
                <path
                  d="M8.3 12.2a3.7 3.7 0 0 1 7.4 0c0 2.5-1.4 4.8-3.7 6.9-2.3-2.1-3.7-4.4-3.7-6.9Z"
                  fill="currentColor"
                />
                <path
                  d="M7.8 9.7 12 3.4l4.2 6.3M9.2 21h5.6"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                />
              </svg>
            </div>

            <div className="doctor-brand-text">
              <h1>Maternal Care</h1>
              <p>Reminder &amp; Appointment Management System</p>
            </div>
          </div>

          <nav className="doctor-nav" aria-label="Doctor dashboard navigation">
            {navItems.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setActivePage(item.key)}
                className={`doctor-nav-link ${
                  activePage === item.key || (activePage === "settings" && item.key === "dashboard") ? "active" : ""
                }`}
              >
                <Icon icon={item.icon} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        </div>
      </aside>

      <main className="doctor-main">
        {activePage !== "dashboard" ? (
          <div className="doctor-global-profile-slot">
            <ProfileCard setActivePage={setActivePage} profile={profile} />
          </div>
        ) : null}

        <div className="doctor-content">{renderContent()}</div>
      </main>
    </div>
  );
}

export default Doctor_Dashboard;
