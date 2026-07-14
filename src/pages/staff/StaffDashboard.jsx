import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import {
  getStaffInitials,
  getStaffSettings,
  staffSettingsUpdatedEvent,
} from "../../lib/staffProfile";
import StaffAppointmentsContent from "./Staff_Appointments";
import StaffPatientsContent from "./Staff_Patients";
import StaffSettingsContent from "./Staff_Settings";
import StaffViewProfileContent from "./Staff_ViewProfile";
import "../../styles/doctor-dashboard.css";
import "../../styles/doctor-patients.css";
import "../../styles/doctor-appointments.css";
import "../../styles/doctor-settings.css";
import "../../styles/doctor-viewprofile.css";
import "../../styles/staff-dashboard.css";
import "../../styles/staff-settings.css";
import "../../styles/staff-patients.css";
import "../../styles/staff-appointments.css";

const staffProfilePhotoKey = "staff_profile_photo";
const defaultStaffProfilePhoto = "/images/doctor-kempee-profile.svg";
const STAFF_SIGN_OUT_TIMEOUT_MS = 8000;

const staffPagePaths = {
  dashboard: "/staff/dashboard",
  patients: "/staff/patients",
  appointments: "/staff/appointments",
  profile: "/staff/profile",
  settings: "/staff/settings",
};

async function signOutStaffWithTimeout() {
  return Promise.race([
    supabase.auth.signOut(),
    new Promise((_, reject) => {
      window.setTimeout(
        () => reject(new Error("Sign out timed out.")),
        STAFF_SIGN_OUT_TIMEOUT_MS
      );
    }),
  ]);
}

async function logoutStaff(navigate) {
  try {
    const { error } = await signOutStaffWithTimeout();

    if (error) {
      console.error("Unable to sign out:", error.message);
    }
  } catch (error) {
    console.error("Unable to sign out:", error);
  } finally {
    navigate("/login?logout=1", { replace: true });
  }
}

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

function getInitialStaffDashboardSettings() {
  return {
    ...getStaffSettings(),
    displayName: "",
  };
}

function getStaffAccountDisplayName(user, personal, profile, fallbackName) {
  const metadataName =
    user?.user_metadata?.full_name ||
    user?.user_metadata?.name ||
    "";
  const emailName = user?.email ? user.email.split("@")[0] : "";

  return (
    String(personal?.full_name || "").trim() ||
    String(profile?.full_name || "").trim() ||
    String(metadataName || "").trim() ||
    String(fallbackName || "").trim() ||
    String(emailName || "").trim() ||
    "Staff"
  );
}

async function loadStaffDashboardSettings() {
  const fallbackSettings = getStaffSettings();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return fallbackSettings;
  }

  const [personalResult, profileResult] = await Promise.all([
    supabase
      .from("staff_personal_information")
      .select("full_name")
      .eq("auth_user_id", user.id)
      .limit(1)
      .maybeSingle(),

    supabase
      .from("profiles")
      .select("full_name")
      .eq("id", user.id)
      .maybeSingle(),
  ]);

  return {
    ...fallbackSettings,
    displayName: getStaffAccountDisplayName(
      user,
      personalResult.error ? null : personalResult.data,
      profileResult.error ? null : profileResult.data,
      fallbackSettings.displayName
    ),
  };
}

async function getSafeStaffDashboardSettings() {
  try {
    return await loadStaffDashboardSettings();
  } catch (error) {
    console.error("Staff dashboard profile load failed:", error);
    return getStaffSettings();
  }
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

function formatDashboardDate(value) {
  if (!value) return "-";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

function formatDashboardTime(value) {
  if (!value) return "-";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function mapUpcomingSession(row) {
  return {
    // Keep the UUID only as the React key/internal database identifier.
    id: row.id,

    // Display only the public-facing Maternal Appointment ID.
    // Never fall back to row.id because row.id is the long UUID shown
    // in the screenshot.
    appointmentId:
      row.maternal_appointment_id || "MA ID not assigned",

    initials: getStaffInitials(row.patient_name || "Patient"),
    patient: row.patient_name || "Patient",
    date: formatDashboardDate(row.start_time),
    time: formatDashboardTime(row.start_time),
    avatarClass: "avatar-pink",
  };
}

function StaffProfileDropdown({
  onViewProfile,
  onSettings,
  onLogout,
  profilePhoto,
  displayName,
}) {
  const initials = getStaffInitials(displayName);

  return (
    <div className="doctor-profile-dropdown" role="menu">
      <div className="doctor-dropdown-user">
        <div className="doctor-dropdown-avatar">
          {profilePhoto ? <img src={profilePhoto} alt="" /> : initials}
        </div>

        <div>
          <strong>{displayName}</strong>
          <span>Staff Account</span>
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

function StaffProfileCard({ onNavigate }) {
  const navigate = useNavigate();
  const dropdownRef = useRef(null);

  const [isOpen, setIsOpen] = useState(false);
  const [settings, setSettings] = useState(getInitialStaffDashboardSettings);
  const [isProfileReady, setIsProfileReady] = useState(false);
  const [profilePhoto, setProfilePhoto] = useState(getStaffProfilePhoto);

  useEffect(() => {
    let active = true;

    const syncProfile = async () => {
      const nextSettings = await getSafeStaffDashboardSettings();

      if (active) {
        setSettings(nextSettings);
        setProfilePhoto(getStaffProfilePhoto());
        setIsProfileReady(true);
      }
    };

    const handleClickOutside = (event) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target)
      ) {
        setIsOpen(false);
      }
    };

    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener(staffSettingsUpdatedEvent, syncProfile);
    window.addEventListener("doctor-settings-updated", syncProfile);
    window.addEventListener("storage", syncProfile);
    syncProfile();

    return () => {
      active = false;
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener(staffSettingsUpdatedEvent, syncProfile);
      window.removeEventListener("doctor-settings-updated", syncProfile);
      window.removeEventListener("storage", syncProfile);
    };
  }, []);

  const handleViewProfile = () => {
    setIsOpen(false);
    onNavigate("profile");
  };

  const handleSettings = () => {
    setIsOpen(false);
    onNavigate("settings");
  };

  const handleLogout = async () => {
    setIsOpen(false);
    await logoutStaff(navigate);
  };

  const displayName = isProfileReady && settings.displayName
    ? settings.displayName
    : "Staff";
  const initials = getStaffInitials(displayName);

  return (
    <div
      className="doctor-profile-wrapper staff-profile-wrapper"
      ref={dropdownRef}
    >
      <button
        className={`doctor-profile-card staff-profile-card ${
          isOpen ? "open" : ""
        }`}
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <div className="doctor-profile-avatar">
          {profilePhoto ? <img src={profilePhoto} alt="" /> : initials}
        </div>

        <div className="doctor-profile-info">
          <strong>{displayName}</strong>
          <span>Staff</span>
        </div>

        <Icon
          className="doctor-profile-arrow"
          icon="ri:arrow-drop-down-line"
        />
      </button>

      {isOpen ? (
        <StaffProfileDropdown
          displayName={displayName}
          profilePhoto={profilePhoto}
          onViewProfile={handleViewProfile}
          onSettings={handleSettings}
          onLogout={handleLogout}
        />
      ) : null}
    </div>
  );
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

function DashboardHome({ onNavigate, headerAction }) {
  const [settings, setSettings] = useState(getInitialStaffDashboardSettings);
  const [isProfileReady, setIsProfileReady] = useState(false);

  const [dashboardStats, setDashboardStats] = useState({
    totalPatients: 0,
    todaysAppointments: 0,
    completedSessions: 0,
    completionProgress: 0,
  });

  const [upcomingSessions, setUpcomingSessions] = useState([]);
  const [dashboardMessage, setDashboardMessage] = useState("");

  useEffect(() => {
    let active = true;

    const syncSettings = async () => {
      const nextSettings = await getSafeStaffDashboardSettings();

      if (active) {
        setSettings(nextSettings);
        setIsProfileReady(true);
      }
    };

    window.addEventListener(staffSettingsUpdatedEvent, syncSettings);
    window.addEventListener("storage", syncSettings);
    syncSettings();

    return () => {
      active = false;
      window.removeEventListener(staffSettingsUpdatedEvent, syncSettings);
      window.removeEventListener("storage", syncSettings);
    };
  }, []);

  useEffect(() => {
    let active = true;

    const loadDashboardStats = async () => {
      const todayRange = getTodayRange();

      /*
       * The dashboard reads appointments from public.schedule.
       * maternal_appointment_id is selected explicitly so the UI displays
       * MA-0001 instead of the internal schedule.id UUID.
       */
      const [
        patientsResult,
        todaysResult,
        completedResult,
        upcomingResult,
      ] = await Promise.all([
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
          .ilike("status", "completed")
          .gte("start_time", todayRange.start)
          .lt("start_time", todayRange.end),

        supabase
          .from("schedule")
          .select(
            "id, maternal_appointment_id, patient_name, start_time, status"
          )
          .gte("start_time", new Date().toISOString())
          .order("start_time", { ascending: true })
          .limit(4),
      ]);

      if (!active) {
        return;
      }

      const errors = [
        patientsResult.error,
        todaysResult.error,
        completedResult.error,
        upcomingResult.error,
      ]
        .filter(Boolean)
        .map((error) => error.message);

      if (errors.length > 0) {
        setDashboardMessage(
          `Unable to load dashboard totals: ${errors.join(" ")}`
        );
      } else {
        setDashboardMessage("");
      }

      const todaysAppointments = todaysResult.count ?? 0;
      const completedSessions = completedResult.count ?? 0;

      setDashboardStats({
        totalPatients: patientsResult.count ?? 0,
        todaysAppointments,
        completedSessions,
        completionProgress:
          todaysAppointments > 0
            ? Math.min(
                100,
                Math.round(
                  (completedSessions / todaysAppointments) * 100
                )
              )
            : 0,
      });

      setUpcomingSessions(
        (upcomingResult.data || []).map(mapUpcomingSession)
      );
    };

    loadDashboardStats();

    const patientsChannel = supabase
      .channel("staff-dashboard-patients-count")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "patients",
        },
        loadDashboardStats
      )
      .subscribe();

    const scheduleChannel = supabase
      .channel("staff-dashboard-schedule-count")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "schedule",
        },
        loadDashboardStats
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(patientsChannel);
      supabase.removeChannel(scheduleChannel);
    };
  }, []);

  const statusCards = dashboardStatusCards.map((card) => ({
    ...card,
    value: String(dashboardStats[card.statKey] ?? 0),
    progress: card.progressKey
      ? dashboardStats[card.progressKey]
      : card.progress,
  }));
  const welcomeName = isProfileReady && settings.displayName
    ? `, ${settings.displayName}`
    : "";

  return (
    <div className="doctor-dashboard-home staff-dashboard-home">
      <header className="doctor-topbar staff-section-header">
        <h2>Dashboard</h2>
        {headerAction}
      </header>

      <section className="doctor-hero-card staff-hero-card">
        <div className="doctor-hero-blur doctor-hero-blur-one" />
        <div className="doctor-hero-blur doctor-hero-blur-two" />

        <div className="doctor-hero-text">
          <h1>Welcome back{welcomeName}!</h1>

          <p>
            Here&apos;s what&apos;s happening with your practice today. You
            have
            {` ${dashboardStats.todaysAppointments} appointments scheduled today.`}
          </p>
        </div>

        <img
          className="doctor-hero-illustration staff-hero-illustration"
          src="/images/staff-dashboard-hero.png"
          alt="Maternal care team"
        />
      </section>

      <section className="doctor-status-row staff-status-row">
        {statusCards.map((card) => (
          <button
            className="doctor-status-card"
            key={card.label}
            type="button"
            onClick={() => onNavigate(card.target)}
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

            {card.badge ? (
              <span className="doctor-growth-badge">
                {card.badge}
              </span>
            ) : null}

            {card.avatars ? (
              <div className="doctor-mini-avatars">
                <span />
                <span />
              </div>
            ) : null}

            {card.progress ? (
              <div className="doctor-progress-track">
                <span style={{ width: `${card.progress}%` }} />
              </div>
            ) : null}
          </button>
        ))}
      </section>

      {dashboardMessage ? (
        <p className="staff-dashboard-status-message">
          {dashboardMessage}
        </p>
      ) : null}

      <section className="doctor-upcoming-section staff-upcoming-section">
        <div className="doctor-section-header">
          <h2>Upcoming Sessions</h2>

          <button
            type="button"
            onClick={() => onNavigate("appointments")}
          >
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
                    <td>{session.appointmentId}</td>

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
                      <span className="doctor-time-pill">
                        {session.time}
                      </span>
                    </td>

                    <td>
                      <button
                        type="button"
                        className="doctor-table-action"
                        aria-label={`Open actions for ${session.patient}`}
                        onClick={() => onNavigate("appointments")}
                      >
                        <Icon icon="solar:menu-dots-bold" />
                      </button>
                    </td>
                  </tr>
                ))}

                {!upcomingSessions.length ? (
                  <tr>
                    <td
                      colSpan="5"
                      className="staff-dashboard-empty-sessions"
                    >
                      No upcoming sessions yet.
                    </td>
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

function getInitialPage(pathname) {
  if (pathname.includes("/staff/patients")) {
    return "patients";
  }

  if (pathname.includes("/staff/appointments")) {
    return "appointments";
  }

  if (pathname.includes("/staff/profile")) {
    return "profile";
  }

  if (pathname.includes("/staff/settings")) {
    return "settings";
  }

  return "dashboard";
}

function StaffDashboard() {
  const location = useLocation();
  const navigate = useNavigate();

  const [activePage, setActivePage] = useState(() =>
    getInitialPage(location.pathname)
  );

  /*
   * This is the main refresh fix.
   *
   * Previously, clicking a menu only changed activePage. The browser URL
   * stayed unchanged, so refreshing the page loaded the old URL again.
   *
   * Now every page change also updates the URL.
   */
  const navigateToPage = useCallback(
    (page, options = {}) => {
      const safePage = staffPagePaths[page] ? page : "dashboard";
      const destination = staffPagePaths[safePage];

      setActivePage(safePage);

      if (location.pathname !== destination) {
        navigate(destination, {
          replace: options.replace === true,
        });
      }
    },
    [location.pathname, navigate]
  );

  /*
   * Keep activePage synchronized with browser Back, Forward, direct URL,
   * and localhost refresh.
   */
  useEffect(() => {
    const pageFromUrl = getInitialPage(location.pathname);

    setActivePage(pageFromUrl);

    /*
     * Normalize /staff or an unknown /staff/... address to the dashboard
     * URL. This makes refresh behavior consistent.
     */
    const validPaths = Object.values(staffPagePaths);
    const isKnownStaffPath = validPaths.some(
      (path) =>
        location.pathname === path ||
        location.pathname.startsWith(`${path}/`)
    );

    if (
      (location.pathname === "/staff" ||
        location.pathname === "/staff/" ||
        (location.pathname.startsWith("/staff/") &&
          !isKnownStaffPath))
    ) {
      navigate(staffPagePaths.dashboard, {
        replace: true,
      });
    }
  }, [location.pathname, navigate]);

  useEffect(() => {
    const handleStaffNavigation = async (event) => {
      const section = event.detail?.section;

      if (!section) {
        return;
      }

      if (section === "logout") {
        await logoutStaff(navigate);
        return;
      }

      navigateToPage(section);
    };

    window.addEventListener(
      "staff:navigate",
      handleStaffNavigation
    );

    return () => {
      window.removeEventListener(
        "staff:navigate",
        handleStaffNavigation
      );
    };
  }, [navigate, navigateToPage]);

  const headerAction = (
    <StaffProfileCard onNavigate={navigateToPage} />
  );

  const renderContent = () => {
    switch (activePage) {
      case "patients":
        return (
          <StaffPatientsContent headerAction={headerAction} />
        );

      case "appointments":
        return (
          <StaffAppointmentsContent headerAction={headerAction} />
        );

      case "profile":
        return (
          <StaffViewProfileContent headerAction={headerAction} />
        );

      case "settings":
        return (
          <StaffSettingsContent headerAction={headerAction} />
        );

      case "dashboard":
      default:
        return (
          <DashboardHome
            onNavigate={navigateToPage}
            headerAction={headerAction}
          />
        );
    }
  };

  return (
    <div className="doctor-dashboard staff-dashboard-shell">
      <aside className="doctor-sidebar">
        <div className="doctor-sidebar-inner">
          <div className="doctor-brand">
            <div className="doctor-brand-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle
                  cx="12"
                  cy="5.6"
                  r="2.2"
                  fill="currentColor"
                />

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
              <p>
                Reminder &amp; Appointment Management System
              </p>
            </div>
          </div>

          <nav
            className="doctor-nav"
            aria-label="Staff dashboard navigation"
          >
            {navItems.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => navigateToPage(item.key)}
                className={`doctor-nav-link ${
                  activePage === item.key ? "active" : ""
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
        <div className="doctor-content">
          {renderContent()}
        </div>
      </main>
    </div>
  );
}

export default StaffDashboard;
