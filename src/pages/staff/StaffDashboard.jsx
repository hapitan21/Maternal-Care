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
import "../../styles/staff-doctor-parity.css";
import "../../styles/appointment-ui-system.css";
import "../../styles/patient-record-ui-system.css";

const staffProfilePhotoKey = "staff_profile_photo";
const defaultStaffProfilePhoto = "/images/doctor-kempee-profile.svg";

const staffDashboardScheduleColumns =
  "id, maternal_appointment_id, patient_id, doctor_id, patient_name, doctor_name, title, description, start_time, end_time, status";

const staffPagePaths = {
  dashboard: "/staff/dashboard",
  patients: "/staff/patients",
  appointments: "/staff/appointments",
  profile: "/staff/profile",
  settings: "/staff/settings",
};

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


const emptyStaffDashboardStats = {
  totalPatients: 0,
  todaysAppointments: 0,
  completedSessions: 0,
  completionProgress: 0,
};

/*
 * Module-level UI snapshot.
 *
 * DashboardHome is intentionally unmounted when Staff opens Patients or
 * Appointments. Keeping the last successful snapshot here prevents the cards
 * and session table from flashing back to zero/empty when Staff returns.
 * Supabase remains the source of truth and refreshes the snapshot immediately.
 */
let staffDashboardSnapshot = {
  stats: null,
  upcomingSessions: null,
  message: "",
};

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
  /*
   * Prefer the new Maternal Appointment ID.
   *
   * The fallbacks keep the dashboard working while older rows are being
   * migrated. Once every schedule row has maternal_appointment_id, that
   * value will always be displayed.
   */
  const displayedAppointmentId =
    row.maternal_appointment_id ||
    row.appointment_id ||
    row.id ||
    "-";

  return {
    id: row.id,
    patientId: row.patient_id || "",
    appointmentId: displayedAppointmentId,
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
  settings,
}) {
  const initials = getStaffInitials(settings.displayName);

  return (
    <div className="doctor-profile-dropdown" role="menu">
      <div className="doctor-dropdown-user">
        <div className="doctor-dropdown-avatar">
          {profilePhoto ? <img src={profilePhoto} alt="" /> : initials}
        </div>

        <div>
          <strong>{settings.displayName}</strong>
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
  const [settings, setSettings] = useState(getStaffSettings);
  const [profilePhoto, setProfilePhoto] = useState(getStaffProfilePhoto);

  useEffect(() => {
    const syncProfile = () => {
      setSettings(getStaffSettings());
      setProfilePhoto(getStaffProfilePhoto());
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

    return () => {
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

    const { error } = await supabase.auth.signOut();

    if (error) {
      console.error("Unable to sign out:", error.message);
      return;
    }

    navigate("/", { replace: true });
  };

  const initials = getStaffInitials(settings.displayName);

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
          <strong>{settings.displayName}</strong>
          <span>Staff</span>
        </div>

        <Icon
          className="doctor-profile-arrow"
          icon="ri:arrow-drop-down-line"
        />
      </button>

      {isOpen ? (
        <StaffProfileDropdown
          settings={settings}
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
  const [settings, setSettings] = useState(getStaffSettings);

  const [dashboardStats, setDashboardStats] = useState(
    () =>
      staffDashboardSnapshot.stats
        ? { ...staffDashboardSnapshot.stats }
        : { ...emptyStaffDashboardStats }
  );

  const [upcomingSessions, setUpcomingSessions] = useState(
    () =>
      staffDashboardSnapshot.upcomingSessions
        ? staffDashboardSnapshot.upcomingSessions.map(
            (session) => ({ ...session })
          )
        : []
  );

  const [dashboardMessage, setDashboardMessage] = useState(
    staffDashboardSnapshot.message || ""
  );

  const [activeSessionActionId, setActiveSessionActionId] =
    useState("");

  useEffect(() => {
    const syncSettings = () => {
      setSettings(getStaffSettings());
    };

    window.addEventListener(staffSettingsUpdatedEvent, syncSettings);
    window.addEventListener("storage", syncSettings);

    return () => {
      window.removeEventListener(staffSettingsUpdatedEvent, syncSettings);
      window.removeEventListener("storage", syncSettings);
    };
  }, []);

  useEffect(() => {
    const closeSessionActions = (event) => {
      if (
        event.type === "keydown" &&
        event.key !== "Escape"
      ) {
        return;
      }

      if (
        event.type === "mousedown" &&
        event.target.closest?.(".staff-session-actions")
      ) {
        return;
      }

      setActiveSessionActionId("");
    };

    document.addEventListener(
      "mousedown",
      closeSessionActions
    );
    document.addEventListener(
      "keydown",
      closeSessionActions
    );

    return () => {
      document.removeEventListener(
        "mousedown",
        closeSessionActions
      );
      document.removeEventListener(
        "keydown",
        closeSessionActions
      );
    };
  }, []);

  useEffect(() => {
    let active = true;

    const loadDashboardStats = async () => {
      const todayRange = getTodayRange();
      const nowIso = new Date().toISOString();

      /*
       * IMPORTANT:
       * Staff Patients intentionally uses the secure
       * get_staff_patient_directory() RPC instead of direct SELECT access to
       * public.patients. The old Dashboard used:
       *
       *   from("patients").select("id", { count: "exact", head: true })
       *
       * which now correctly returns HTTP 403 under the hardened Staff RLS.
       *
       * The Schedule page already has Staff SELECT access, so fetch the
       * schedule rows once and calculate Dashboard totals client-side. This
       * also avoids the HEAD/count requests that were producing the second
       * 403 in the browser console.
       */
      const [patientsResult, scheduleResult] =
        await Promise.all([
          supabase
            .rpc("get_staff_patient_directory")
            .order("created_at", { ascending: false }),

          supabase
            .from("schedule")
            .select(staffDashboardScheduleColumns)
            .order("start_time", { ascending: true }),
        ]);

      if (!active) {
        return;
      }

      const errors = [
        patientsResult.error,
        scheduleResult.error,
      ]
        .filter(Boolean)
        .map((error) => error.message);

      const hasExistingSnapshot = Boolean(
        staffDashboardSnapshot.stats
      );

      if (errors.length > 0) {
        if (import.meta.env.DEV) {
          console.warn(
            "[Staff Dashboard] refresh error:",
            errors
          );
        }

        /*
         * Keep the last successful Dashboard visible during a temporary
         * background refresh error. Only show an error on the very first load
         * when there is no valid snapshot yet.
         */
        setDashboardMessage(
          hasExistingSnapshot
            ? ""
            : "Dashboard data could not be loaded. Please refresh the page."
        );
      } else {
        setDashboardMessage("");
      }

      const previousStats =
        staffDashboardSnapshot.stats || {
          ...emptyStaffDashboardStats,
        };

      const patientRows = patientsResult.error
        ? null
        : patientsResult.data || [];

      const scheduleRows = scheduleResult.error
        ? null
        : scheduleResult.data || [];

      const totalPatients =
        patientRows === null
          ? previousStats.totalPatients
          : patientRows.length;

      const todaysAppointments =
        scheduleRows === null
          ? previousStats.todaysAppointments
          : scheduleRows.filter((appointment) => {
              const startTime = appointment?.start_time;

              return (
                startTime &&
                startTime >= todayRange.start &&
                startTime < todayRange.end
              );
            }).length;

      const completedSessions =
        scheduleRows === null
          ? previousStats.completedSessions
          : scheduleRows.filter((appointment) => {
              const startTime = appointment?.start_time;
              const status = String(
                appointment?.status || ""
              )
                .trim()
                .toLowerCase();

              return (
                status === "completed" &&
                startTime &&
                startTime >= todayRange.start &&
                startTime < todayRange.end
              );
            }).length;

      const nextStats = {
        totalPatients,
        todaysAppointments,
        completedSessions,
        completionProgress:
          todaysAppointments > 0
            ? Math.min(
                100,
                Math.round(
                  (completedSessions /
                    todaysAppointments) *
                    100
                )
              )
            : 0,
      };

      const nextUpcomingSessions =
        scheduleRows === null
          ? staffDashboardSnapshot.upcomingSessions || []
          : scheduleRows
              .filter((appointment) => {
                const startTime =
                  appointment?.start_time;

                return (
                  startTime &&
                  startTime >= nowIso
                );
              })
              .slice(0, 4)
              .map(mapUpcomingSession);

      /*
       * Only replace the shared snapshot with a fully successful refresh.
       * If one request fails, preserve the last known-good snapshot for the
       * failing section instead of flashing zero/empty content.
       */
      if (errors.length === 0) {
        staffDashboardSnapshot = {
          stats: {
            ...nextStats,
          },
          upcomingSessions:
            nextUpcomingSessions.map((session) => ({
              ...session,
            })),
          message: "",
        };
      }

      setDashboardStats(nextStats);
      setUpcomingSessions(
        nextUpcomingSessions
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
          <h1>
            <span>Welcome back,</span>
            <span>{settings.displayName}!</span>
          </h1>

          <p>
            <span>Here&apos;s what&apos;s happening with your practice today.</span>
            <span>
              You have {dashboardStats.todaysAppointments} appointments scheduled today.
            </span>
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
                      <div
                        className={`staff-session-actions ${
                          activeSessionActionId === session.id
                            ? "is-open"
                            : ""
                        }`}
                        style={{
                          position: "relative",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          zIndex:
                            activeSessionActionId === session.id
                              ? 200
                              : "auto",
                        }}
                      >
                        <button
                          type="button"
                          className="doctor-table-action"
                          aria-label={`Open actions for ${session.patient}`}
                          aria-haspopup="menu"
                          aria-expanded={
                            activeSessionActionId === session.id
                          }
                          onClick={() =>
                            setActiveSessionActionId(
                              (current) =>
                                current === session.id
                                  ? ""
                                  : session.id
                            )
                          }
                        >
                          <Icon icon="solar:menu-dots-bold" />
                        </button>

                        {activeSessionActionId === session.id ? (
                          <div
                            className="staff-session-action-menu"
                            role="menu"
                            aria-label={`Actions for ${session.patient}`}
                            style={{
                              position: "absolute",
                              zIndex: 9999,
                              top: "50%",
                              right: "calc(100% + 10px)",
                              transform: "translateY(-50%)",
                              width: "188px",
                              display: "grid",
                              gap: "4px",
                              padding: "8px",
                              border: "1px solid #e7e9ef",
                              borderRadius: "12px",
                              background: "#ffffff",
                              boxShadow:
                                "0 16px 34px rgba(17, 24, 39, 0.16)",
                            }}
                          >
                            <button
                              type="button"
                              role="menuitem"
                              style={{
                                width: "100%",
                                minHeight: "40px",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "flex-start",
                                gap: "9px",
                                border: 0,
                                borderRadius: "8px",
                                background: "transparent",
                                color: "#4b5160",
                                padding: "0 10px",
                                font: "inherit",
                                fontSize: "12px",
                                fontWeight: 700,
                                textAlign: "left",
                                cursor: "pointer",
                              }}
                              onClick={() => {
                                setActiveSessionActionId("");

                                const appointmentTarget =
                                  session.appointmentId &&
                                  session.appointmentId !== "-"
                                    ? session.appointmentId
                                    : session.id;

                                onNavigate("appointments", {
                                  path: `/staff/appointments?appointmentId=${encodeURIComponent(
                                    appointmentTarget
                                  )}`,
                                });
                              }}
                            >
                              <Icon icon="solar:calendar-linear" />
                              <span>View Appointment</span>
                            </button>

                            {session.patientId ? (
                              <button
                                type="button"
                                role="menuitem"
                                style={{
                                  width: "100%",
                                  minHeight: "40px",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "flex-start",
                                  gap: "9px",
                                  border: 0,
                                  borderRadius: "8px",
                                  background: "transparent",
                                  color: "#4b5160",
                                  padding: "0 10px",
                                  font: "inherit",
                                  fontSize: "12px",
                                  fontWeight: 700,
                                  textAlign: "left",
                                  cursor: "pointer",
                                }}
                                onClick={() => {
                                  setActiveSessionActionId("");

                                  onNavigate("patients", {
                                    path: `/staff/patients/${session.patientId}`,
                                  });
                                }}
                              >
                                <Icon icon="solar:user-rounded-linear" />
                                <span>View Patient</span>
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
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
      const safePage = staffPagePaths[page]
        ? page
        : "dashboard";

      const destination =
        typeof options.path === "string" &&
        options.path.startsWith("/staff/")
          ? options.path
          : staffPagePaths[safePage];

      setActivePage(safePage);

      const currentLocation =
        `${location.pathname}${location.search}`;

      if (currentLocation !== destination) {
        navigate(destination, {
          replace: options.replace === true,
        });
      }
    },
    [
      location.pathname,
      location.search,
      navigate,
    ]
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
        const { error } = await supabase.auth.signOut();

        if (error) {
          console.error("Unable to sign out:", error.message);
          return;
        }

        navigate("/", { replace: true });
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
