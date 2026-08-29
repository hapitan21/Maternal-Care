import { lazy, startTransition, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import { useAuthenticatedDoctor } from "../../hooks/useAuthenticatedDoctor";
import MaternalCareLogo from "../../components/common/MaternalCareLogo";
import WorkspaceSectionFallback from "../../components/common/WorkspaceSectionFallback";
import ProfileAvatarContent from "../../components/common/ProfileAvatarContent";
import {
  classifyAppointment,
  compareUpcomingAppointments,
  formatAppointmentDate,
  formatAppointmentTime,
  getManilaDayRange,
} from "../../lib/appointmentDate";
import "../../styles/doctor-dashboard.css";

const doctorSectionLoaders = {
  appointments: () => import("./Doctor_Appointments"),
  medicalRecords: () => import("./Doctor_Medical_Records"),
  patients: () => import("./Doctor_Patients"),
  reminders: () => import("./Doctor_Reminder"),
  settings: () => import("./Doctor_Settings"),
  profile: () => import("./Doctor_ViewProfile"),
};

function preloadDoctorSection(page) {
  const loadSection = doctorSectionLoaders[page];
  if (loadSection) void loadSection().catch(() => null);
}

const DoctorAppointmentsContent = lazy(() =>
  doctorSectionLoaders.appointments().then((module) => ({
    default: module.DoctorAppointmentsContent,
  }))
);
const DoctorMedicalRecords = lazy(doctorSectionLoaders.medicalRecords);
const DoctorPatientsContent = lazy(doctorSectionLoaders.patients);
const DoctorReminderContent = lazy(doctorSectionLoaders.reminders);
const DoctorSettingsContent = lazy(doctorSectionLoaders.settings);
const DoctorViewProfileContent = lazy(doctorSectionLoaders.profile);

const defaultDoctorDashboardProfile = {
  displayName: "Doctor",
  roleLabel: "Doctor",
};

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

const doctorPagePaths = {
  dashboard: "/doctor/dashboard",
  patients: "/doctor/patients",
  appointments: "/doctor/appointments",
  reminders: "/doctor/reminders",
  profile: "/doctor/profile",
  settings: "/doctor/settings",
};

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
    label: "Today's Appointments",
    statKey: "todaysAppointments",
    icon: "solar:clock-circle-bold",
    tone: "pink",
    target: "appointments",
  },
  {
    label: "Sessions Completed",
    statKey: "completedSessions",
    icon: "solar:check-circle-bold",
    tone: "blue",
    progressKey: "completionProgress",
    target: "appointments",
  },
];

const medicalRecordTabParamByLabel = {
  Overview: "overview",
  "Prenatal History": "prenatal-history",
  Appointments: "appointments",
  "Medical Record": "medical-record",
  "Diagnostic Results": "diagnostic-results",
  Prescriptions: "prescriptions",
  "Medication Adherence": "medication-adherence",
  "Pregnancy Tracking": "pregnancy-tracking",
};

const medicalRecordTabLabelByParam = {
  ...Object.fromEntries(
    Object.entries(medicalRecordTabParamByLabel).map(([label, param]) => [param, label])
  ),
  // Backwards compatibility for old bookmarked/shared URLs only.
  // The Laboratory Results tab itself has been removed.
  "laboratory-results": "Diagnostic Results",
};

function getMedicalRecordTargetFromSearch(search) {
  const params = new URLSearchParams(search || "");
  const patientId = params.get("patientId") || "";
  const recordId = params.get("recordId") || "";
  const tab = params.get("tab") || "";
  const view = params.get("view") || "";
  const activeTab = medicalRecordTabLabelByParam[tab] || "";

  if (!patientId || !activeTab) {
    return null;
  }

  return {
    patientId,
    activeTab,
    recordId,
    returnPage: doctorPagePaths[view] ? view : "patients",
  };
}

function getInitialDoctorPage(pathname, search) {
  const medicalRecordTarget = getMedicalRecordTargetFromSearch(search);

  if (medicalRecordTarget) return "medicalRecords";
  if (pathname.includes("/doctor/patients")) return "patients";
  if (pathname.includes("/doctor/appointments")) return "appointments";
  if (pathname.includes("/doctor/reminders")) return "reminders";
  if (pathname.includes("/doctor/profile")) return "profile";
  if (pathname.includes("/doctor/settings")) return "settings";

  return "dashboard";
}

function buildDoctorMedicalRecordSearch(target = {}) {
  const params = new URLSearchParams();
  const returnPage = doctorPagePaths[target.returnPage] ? target.returnPage : "patients";
  const tab = medicalRecordTabParamByLabel[target.activeTab] || "medical-record";

  params.set("view", returnPage);
  params.set("tab", tab);

  if (target.patientId) params.set("patientId", target.patientId);
  if (target.recordId) params.set("recordId", target.recordId);

  return `?${params.toString()}`;
}

function getInitials(name) {
  const parts = String(name || "Patient").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "PT";

  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function mapUpcomingSession(row) {
  return {
    id: row.id,
    patientId: row.patient_id || "",
    appointmentId: row.maternal_appointment_id || "MA ID not assigned",
    initials: getInitials(row.patient_name),
    patient: row.patient_name || "Patient",
    date: formatAppointmentDate(row.start_time, { month: "short", day: "2-digit" }),
    time: formatAppointmentTime(row.start_time),
    avatarClass: "avatar-pink",
  };
}

function ProfileDropdown({
  onViewProfile,
  onSettings,
  onLogout,
}) {
  return (
    <div className="doctor-profile-dropdown" role="menu" aria-label="Doctor profile menu">
      <div className="doctor-dropdown-menu">
        <button type="button" role="menuitem" onClick={onViewProfile}>
          <Icon icon="solar:user-rounded-bold" aria-hidden="true" />
          <span>Profile</span>
        </button>

        <button type="button" role="menuitem" onClick={onSettings}>
          <Icon icon="solar:settings-bold" aria-hidden="true" />
          <span>Settings</span>
        </button>

        <button type="button" role="menuitem" className="logout" onClick={onLogout}>
          <Icon icon="solar:logout-2-bold" aria-hidden="true" />
          <span>Log out</span>
        </button>
      </div>
    </div>
  );
}

function ProfileCard({ setActivePage, profile }) {
  const navigate = useNavigate();
  const dropdownRef = useRef(null);
  const triggerRef = useRef(null);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const initials = getInitials(profile.displayName || profile.roleLabel);

  useEffect(() => {
    if (!isDropdownOpen) return undefined;

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
        window.requestAnimationFrame(() => triggerRef.current?.focus());
      }
    }

    function handleCloseProfileMenu() {
      setIsDropdownOpen(false);
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("doctor:close-profile-menu", handleCloseProfileMenu);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("doctor:close-profile-menu", handleCloseProfileMenu);
    };
  }, [isDropdownOpen]);

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
        ref={triggerRef}
        className={`doctor-profile-card ${isDropdownOpen ? "open" : ""}`}
        type="button"
        onClick={() => setIsDropdownOpen((prev) => !prev)}
        aria-label={isDropdownOpen ? "Close Doctor account menu" : "Open Doctor account menu"}
        aria-expanded={isDropdownOpen}
        aria-haspopup="menu"
      >
        <div className="doctor-profile-avatar">
          <ProfileAvatarContent src={profile.avatarUrl} fallback={initials} />
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
        />
      )}
    </div>
  );
}

function DoctorHeaderControls({ setActivePage, profile, profileKey }) {
  return (
    <div className="doctor-shell-header-controls">
      <ProfileCard
        key={profileKey}
        setActivePage={setActivePage}
        profile={profile}
      />
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
  const [activeSessionActionId, setActiveSessionActionId] = useState("");

  useEffect(() => {
    const closeSessionActions = (event) => {
      if (event.type === "keydown" && event.key !== "Escape") {
        return;
      }

      if (
        event.type === "mousedown" &&
        event.target.closest?.(".doctor-session-actions")
      ) {
        return;
      }

      setActiveSessionActionId("");
    };

    document.addEventListener("mousedown", closeSessionActions);
    document.addEventListener("keydown", closeSessionActions);

    return () => {
      document.removeEventListener("mousedown", closeSessionActions);
      document.removeEventListener("keydown", closeSessionActions);
    };
  }, []);

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
        <p className="doctor-dashboard-message" role="alert">{dashboardMessage}</p>
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
                      <span className="doctor-time-pill">{session.time}</span>
                    </td>

                    <td>
                      <div
                        className={`doctor-session-actions ${
                          activeSessionActionId === session.id ? "is-open" : ""
                        }`}
                      >
                        <button
                          type="button"
                          className="doctor-table-action"
                          aria-label={`Open actions for ${session.patient}`}
                          aria-haspopup="menu"
                          aria-expanded={activeSessionActionId === session.id}
                          onClick={() =>
                            setActiveSessionActionId((current) =>
                              current === session.id ? "" : session.id
                            )
                          }
                        >
                          <Icon icon="solar:menu-dots-bold" />
                        </button>

                        {activeSessionActionId === session.id ? (
                          <div
                            className="doctor-session-action-menu"
                            role="menu"
                            aria-label={`Actions for ${session.patient}`}
                          >
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setActiveSessionActionId("");

                                const appointmentTarget =
                                  session.appointmentId &&
                                  session.appointmentId !== "MA ID not assigned"
                                    ? session.appointmentId
                                    : session.id;

                                setActivePage("appointments", {
                                  path: `/doctor/appointments?appointmentId=${encodeURIComponent(
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
                                onClick={() => {
                                  setActiveSessionActionId("");
                                  setActivePage("patients", {
                                    path: `/doctor/patients/${session.patientId}`,
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
                    <td colSpan="5">No upcoming sessions.</td>
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
  const location = useLocation();
  const isAppointmentVisitRoute = /^\/doctor\/appointments\/[^/]+\/(?:initial-visit|follow-up)\/?$/i.test(
    location.pathname
  );
  const [activePage, setActivePage] = useState(() =>
    getInitialDoctorPage(location.pathname, location.search)
  );
  const doctorIdentity = useAuthenticatedDoctor();
  const [dashboardStats, setDashboardStats] = useState({
    totalPatients: 0,
    todaysAppointments: 0,
    completedSessions: 0,
    completionProgress: 0,
  });
  const [upcomingSessions, setUpcomingSessions] = useState([]);
  const [dashboardMessage, setDashboardMessage] = useState("");
  const [medicalRecordTarget, setMedicalRecordTarget] = useState(() =>
    getMedicalRecordTargetFromSearch(location.search)
  );
  const [doctorPatientHeaderAction, setDoctorPatientHeaderAction] = useState(null);
  const dashboardStatsRequestRef = useRef(0);
  const navigate = useNavigate();
  const authenticatedDoctorId = doctorIdentity.profile?.id || "";
  const inactiveDoctorError =
    doctorIdentity.error?.code === "doctor_account_inactive"
      ? doctorIdentity.error
      : null;
  const profile = {
    ...defaultDoctorDashboardProfile,
    displayName: doctorIdentity.doctorDisplayName ||
      (doctorIdentity.loading
        ? "Loading Doctor profile..."
        : doctorIdentity.error
          ? "Doctor profile not found"
          : defaultDoctorDashboardProfile.displayName),
    avatarUrl: doctorIdentity.avatarUrl || "",
  };
  useEffect(() => {
    if (!inactiveDoctorError) {
      return undefined;
    }

    let active = true;

    const redirectInactiveDoctor = async () => {
      try {
        await supabase.auth.signOut();
      } catch (error) {
        console.error("Inactive Doctor sign out failed:", error);
      }

      if (!active) {
        return;
      }

      navigate(
        `/login?logout=1&reason=${encodeURIComponent(inactiveDoctorError.message)}`,
        { replace: true }
      );
    };

    redirectInactiveDoctor();

    return () => {
      active = false;
    };
  }, [inactiveDoctorError, navigate]);

  const loadDashboardStats = useCallback(async () => {
    const doctorId = authenticatedDoctorId;
    if (!doctorId) return;

    const requestId = dashboardStatsRequestRef.current + 1;
    dashboardStatsRequestRef.current = requestId;
    const todayRange = getManilaDayRange();

    const [patientsResult, scheduleResult] = await Promise.all([
      supabase
        .rpc("get_doctor_patient_directory", {}, { count: "exact", head: true })
        .select("id")
        .ilike("status", "active"),
      supabase
        .from("schedule")
        .select(
          "id, maternal_appointment_id, patient_id, patient_name, start_time, end_time, status"
        )
        .gte("start_time", todayRange.start.toISOString())
        .order("start_time", { ascending: true }),
    ]);

    if (dashboardStatsRequestRef.current !== requestId) return;

    const errors = [patientsResult.error, scheduleResult.error]
      .filter(Boolean)
      .map((error) => error.message);
    setDashboardMessage(
      errors.length ? `Unable to load dashboard totals: ${errors.join(" ")}` : ""
    );

    const scheduleRows = scheduleResult.error ? [] : scheduleResult.data || [];
    const todaysAppointments = scheduleRows.filter(
      (appointment) => classifyAppointment(appointment).isToday
    );
    const completedSessions = todaysAppointments.filter(
      (appointment) => classifyAppointment(appointment).category === "completed"
    ).length;

    setDashboardStats({
      totalPatients: patientsResult.count ?? 0,
      todaysAppointments: todaysAppointments.length,
      completedSessions,
      completionProgress: todaysAppointments.length
        ? Math.min(
            100,
            Math.round((completedSessions / todaysAppointments.length) * 100)
          )
        : 0,
    });

    setUpcomingSessions(
      scheduleRows
        .filter((appointment) => classifyAppointment(appointment).isUpcoming)
        .sort(compareUpcomingAppointments)
        .slice(0, 4)
        .map(mapUpcomingSession)
    );
  }, [authenticatedDoctorId]);

  useEffect(() => {
    if (activePage !== "dashboard" || !authenticatedDoctorId) {
      return undefined;
    }

    const refresh = () => loadDashboardStats();
    const handleWindowFocus = () => refresh();
    const initialLoadTimer = window.setTimeout(refresh, 0);
    const refreshTimer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", handleWindowFocus);

    const dashboardChannel = supabase
      .channel(`doctor-dashboard-${authenticatedDoctorId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "patients" },
        loadDashboardStats
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "schedule",
          filter: `doctor_id=eq.${authenticatedDoctorId}`,
        },
        loadDashboardStats
      )
      .subscribe();

    return () => {
      dashboardStatsRequestRef.current += 1;
      window.clearTimeout(initialLoadTimer);
      window.clearInterval(refreshTimer);
      window.removeEventListener("focus", handleWindowFocus);
      supabase.removeChannel(dashboardChannel);
    };
  }, [
    activePage,
    authenticatedDoctorId,
    loadDashboardStats,
  ]);

  const openMedicalRecordTarget = useCallback((target, options = {}) => {
    preloadDoctorSection("medicalRecords");
    setDoctorPatientHeaderAction(null);

    const returnPage =
      doctorPagePaths[target?.returnPage]
        ? target.returnPage
        : activePage === "medicalRecords"
          ? medicalRecordTarget?.returnPage || "patients"
          : doctorPagePaths[activePage]
            ? activePage
            : "patients";
    const nextTarget = {
      patientId: target?.patientId || "",
      activeTab: target?.activeTab || "Medical Record",
      recordId: target?.recordId || "",
      returnPage,
    };

    startTransition(() => {
      setMedicalRecordTarget(nextTarget);
      setActivePage("medicalRecords");

      if (nextTarget.patientId) {
        navigate(
          {
            pathname: "/doctor",
            search: buildDoctorMedicalRecordSearch(nextTarget),
          },
          { replace: options.replace === true }
        );
      }
    });
  }, [activePage, medicalRecordTarget?.returnPage, navigate]);

  const navigateDoctorPage = useCallback((page, options = {}) => {
    const safePage = doctorPagePaths[page] ? page : "dashboard";
    const destination =
      typeof options.path === "string" && options.path.startsWith("/doctor/")
        ? options.path
        : doctorPagePaths[safePage];
    preloadDoctorSection(safePage);

    startTransition(() => {
      if (safePage !== "medicalRecords") {
        setDoctorPatientHeaderAction(null);
      }

      setActivePage(safePage);

      const currentLocation = `${location.pathname}${location.search}`;
      if (safePage !== "medicalRecords" && currentLocation !== destination) {
        navigate(destination, { replace: options.replace === true });
      }
    });
  }, [location.pathname, location.search, navigate]);

  useEffect(() => {
    const nextTarget = getMedicalRecordTargetFromSearch(location.search);

    if (!nextTarget) {
      const nextPage = getInitialDoctorPage(location.pathname, location.search);
      const normalizedPath = location.pathname.replace(/\/+$/, "") || "/";
      const isDashboardPath =
        normalizedPath === "/doctor" || normalizedPath === doctorPagePaths.dashboard;
      const pageTimer = window.setTimeout(() => {
        if (nextPage === "dashboard" && !isDashboardPath) {
          navigate(doctorPagePaths.dashboard, { replace: true });
        }
        preloadDoctorSection(nextPage);
        startTransition(() => {
          setActivePage((current) => (current === nextPage ? current : nextPage));
        });
      }, 0);
      return () => window.clearTimeout(pageTimer);
    }

    const timer = window.setTimeout(() => {
      preloadDoctorSection("medicalRecords");
      startTransition(() => {
        setMedicalRecordTarget((current) => {
          if (
            current?.patientId === nextTarget.patientId &&
            current?.recordId === nextTarget.recordId &&
            current?.activeTab === nextTarget.activeTab
          ) {
            return current;
          }

          return nextTarget;
        });
        setActivePage("medicalRecords");
      });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [location.pathname, location.search, navigate]);

  useEffect(() => {
    const handleDoctorNavigation = async (event) => {
      const detail = event.detail || {};
      const section = detail.section;

      if (!section) {
        return;
      }

      if (section === "logout") {
        await supabase.auth.signOut();
        navigate("/");
        return;
      }

      if (section === "medicalRecords") {
        openMedicalRecordTarget(detail?.medicalRecordTarget || null);
        return;
      }

      navigateDoctorPage(section);
    };

    window.addEventListener("doctor:navigate", handleDoctorNavigation);

    return () => {
      window.removeEventListener("doctor:navigate", handleDoctorNavigation);
    };
  }, [navigate, navigateDoctorPage, openMedicalRecordTarget]);

  const renderContent = () => {
    const doctorPatientHeaderActions = (
      <div className="doctor-patient-header-actions">
        <DoctorHeaderControls
          profileKey={`medical-records-${location.pathname}-${location.search}`}
          setActivePage={navigateDoctorPage}
          profile={profile}
        />

        {doctorPatientHeaderAction ? (
          <button
            className="doctor-edit-record-button"
            type="button"
            onClick={doctorPatientHeaderAction.onClick}
            disabled={doctorPatientHeaderAction.disabled}
          >
            <Icon icon="solar:pen-new-square-linear" />
            <span>{doctorPatientHeaderAction.label}</span>
          </button>
        ) : null}
      </div>
    );

    switch (activePage) {
      case "patients":
        return (
          <DoctorPatientsContent
            headerAction={<span className="doctor-global-profile-placeholder" aria-hidden="true" />}
          />
        );

      case "appointments":
        return (
          <DoctorAppointmentsContent
            doctorIdentity={doctorIdentity}
            headerAction={<span className="doctor-global-profile-placeholder" aria-hidden="true" />}
            onOpenMedicalRecord={(target) => {
              openMedicalRecordTarget(target);
            }}
          />
        );

      case "medicalRecords":
        return (
          <DoctorMedicalRecords
            key={medicalRecordTarget?.patientId || "none"}
            initialPatient={medicalRecordTarget?.patientId ? { id: medicalRecordTarget.patientId } : null}
            initialActiveTab={medicalRecordTarget?.activeTab || "Medical Record"}
            focusedRecordId={medicalRecordTarget?.recordId || ""}
            headerActions={doctorPatientHeaderActions}
            doctorName={profile.displayName}
            onHeaderActionChange={setDoctorPatientHeaderAction}
            onRecordSelect={(recordId) => {
              if (!medicalRecordTarget?.patientId || !recordId) return;
              openMedicalRecordTarget(
                {
                  ...medicalRecordTarget,
                  recordId,
                },
                { replace: true }
              );
            }}
            onBackToPatients={() => navigateDoctorPage(medicalRecordTarget?.returnPage || "patients")}
          />
        );

      case "reminders":
        return <DoctorReminderContent doctorIdentity={doctorIdentity} headerAction={<span className="doctor-global-profile-placeholder" aria-hidden="true" />} />;

      case "profile":
        return (
          <DoctorViewProfileContent
            doctorIdentity={doctorIdentity}
            headerAction={<span className="doctor-global-profile-placeholder" aria-hidden="true" />}
          />
        );

      case "settings":
        return <DoctorSettingsContent doctorIdentity={doctorIdentity} headerAction={<span className="doctor-global-profile-placeholder" aria-hidden="true" />} />;

      case "dashboard":
      default:
        return (
          <DashboardHome
            setActivePage={navigateDoctorPage}
            headerAction={<span className="doctor-global-profile-placeholder" aria-hidden="true" />}
            dashboardStats={dashboardStats}
            upcomingSessions={upcomingSessions}
            dashboardMessage={doctorIdentity.error?.message || dashboardMessage}
            accountName={profile.displayName}
          />
        );
    }
  };

  if (inactiveDoctorError) {
    return (
      <div className="doctor-dashboard">
        <main className="doctor-main">
          <div className="doctor-content">
            <p className="doctor-dashboard-message" role="alert">{inactiveDoctorError.message}</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="doctor-dashboard">
      <aside className="doctor-sidebar">
        <div className="doctor-sidebar-inner">
          <div className="doctor-brand maternal-care-brand">
            <MaternalCareLogo variant="sidebar" />
          </div>

          <nav className="doctor-nav" aria-label="Doctor dashboard navigation">
            {navItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  aria-label={item.label}
                  aria-current={activePage === item.key ? "page" : undefined}
                  onPointerEnter={() => preloadDoctorSection(item.key)}
                  onFocus={() => preloadDoctorSection(item.key)}
                  onClick={() => navigateDoctorPage(item.key)}
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

      <main className={`doctor-main${isAppointmentVisitRoute ? " doctor-main--appointment-visit" : ""}`}>
        {activePage !== "medicalRecords" && !isAppointmentVisitRoute ? (
          <div className="doctor-global-profile-slot">
            <div className="doctor-patient-header-actions">
              <DoctorHeaderControls
                profileKey={`${activePage}-${location.pathname}-${location.search}`}
                setActivePage={navigateDoctorPage}
                profile={profile}
              />
            </div>
          </div>
        ) : null}

        <div className="doctor-content">
          <Suspense fallback={<WorkspaceSectionFallback label="Doctor workspace" />}>
            {renderContent()}
          </Suspense>
        </div>
      </main>
    </div>
  );
}

export default Doctor_Dashboard;
