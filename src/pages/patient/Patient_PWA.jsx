import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import PatientPWADashboard from "./Patient_PWA_Dashboard";
import PatientPWAViewProfile from "./Patient_PWA_ViewProfile";
import PatientPWASettings from "./Patient_PWA_Settings";
import PatientPWAMedicalRecords from "./Patient_PWA_MedicalRecords";
import PatientPWAAppointments from "./Patient_PWA_Appointments";
import PatientPWAReminder from "./Patient_PWA_Reminder";
import PatientNotificationBell from "../../components/patient/PatientNotificationBell";
import PatientNotificationsProvider from "../../components/patient/PatientNotificationsProvider";
import {
  isPatientRecordArchived,
  normalizePatientAccountStatus,
  patientAccountStatuses,
} from "../../lib/patientAccountStatus";
import "../../styles/patient-PWA.css";
import "../../styles/patient-PWA-dashboard.css";
import "../../styles/patient-PWA-viewprofile.css";
import "../../styles/patient_PWA_settings.css";
import "../../styles/patient-PWA-medicalrecords.css";
import "../../styles/patient-PWA-appointments.css";
import "../../styles/patient-PWA-reminder.css";
import "../../styles/patient-notifications.css";
import "../../styles/patient-pwa-ui-system.css";

const defaultPatientProfile = {
  recordId: "",
  displayName: "Patient",
  patientId: "Not provided",
  avatar: "",
  age: "Not provided",
  gender: "Not provided",
  civilStatus: "Not provided",
  trimester: "Not provided",
  pregnancyWeek: "",
  bloodType: "Not provided",
  email: "Not provided",
  phone: "Not provided",
  address: "Not provided",
  emergencyName: "Not provided",
  emergencyRelation: "Not provided",
  emergencyPhone: "Not provided",
  nationality: "Not provided",
  birthdate: "Not provided",
  pregnancyStatus: "Not provided",
  gravida: "Not provided",
  para: "Not provided",
  dueDate: "Not provided",
  physician: "Not assigned",
  clinic: "La Paz Maternity and Reproductive Health Center",
  accountStatus: "Not provided",
  emailVerified: null,
  lastLoginAt: "",
};

const patientSessionStorageKey = "maternal_patient_session";
const patientLoadingMessage = "Loading your Maternal Care account...";

const navItems = [
  { key: "dashboard", label: "Dashboard", mobileLabel: "Home", icon: "solar:widget-2-bold" },
  { key: "medical-record", label: "Medical Record", mobileLabel: "Records", icon: "solar:document-medicine-linear" },
  { key: "appointments", label: "Appointments", mobileLabel: "Visits", icon: "solar:calendar-linear" },
  { key: "reminders", label: "Reminders", mobileLabel: "Reminders", icon: "solar:bell-linear" },
];

const pageRoutes = {
  dashboard: "/patient/dashboard",
  profile: "/patient/profile",
  settings: "/patient/settings",
  "medical-record": "/patient/medical-record",
  appointments: "/patient/appointments",
  reminders: "/patient/reminders",
};

const routePages = Object.entries(pageRoutes).reduce((routes, [page, path]) => {
  routes[path] = page;
  return routes;
}, {});

routePages["/patient/dashboard"] = "dashboard";
routePages["/patient"] = "dashboard";
routePages["/patient/medical-records"] = "medical-record";
routePages["/patient/reminders/medications"] = "reminders";

function getPageFromPath(pathname) {
  return routePages[pathname.replace(/\/$/, "") || "/patient"] || "not-found";
}

function isMissingPatientLinkingRpc(error) {
  if (!error) return false;

  const message = `${error.message || ""} ${error.details || ""}`.toLowerCase();
  return (
    error.code === "42883" ||
    error.code === "PGRST202" ||
    message.includes("could not find the function") ||
    message.includes("schema cache")
  );
}

function isMissingAuthSession(error) {
  const message = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return (
    message.includes("auth session missing") ||
    message.includes("missing auth session") ||
    message.includes("session missing")
  );
}

function formatDateForDisplay(value) {
  if (!value) return "";

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function getAgeLabel(row) {
  if (!row?.date_of_birth) {
    return row?.age ? `${row.age} years old` : defaultPatientProfile.age;
  }

  const birth = new Date(`${row.date_of_birth}T00:00:00`);
  if (Number.isNaN(birth.getTime())) return "Not provided";

  const today = new Date();
  if (birth > today) return "Not provided";

  let age = today.getFullYear() - birth.getFullYear();
  const monthDelta = today.getMonth() - birth.getMonth();

  if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < birth.getDate())) {
    age -= 1;
  }

  return `${age} years old`;
}

function mapPatientProfile(row, profile) {
  const authUser = profile?.authUser || null;

  return {
    ...defaultPatientProfile,
    recordId: row?.id || "",
    displayName: row?.full_name || profile?.full_name || defaultPatientProfile.displayName,
    patientId: row?.patient_id || defaultPatientProfile.patientId,
    age: getAgeLabel(row),
    email: row?.email || profile?.email || defaultPatientProfile.email,
    phone: row?.contact_number || defaultPatientProfile.phone,
    address: row?.address || defaultPatientProfile.address,
    birthdate: formatDateForDisplay(row?.date_of_birth) || defaultPatientProfile.birthdate,
    bloodType: row?.blood_type || defaultPatientProfile.bloodType,
    trimester: row?.trimester || defaultPatientProfile.trimester,
    pregnancyWeek: row?.gestational_age || defaultPatientProfile.pregnancyWeek,
    dueDate: formatDateForDisplay(row?.expected_delivery_date) || defaultPatientProfile.dueDate,
    pregnancyStatus: row?.status || defaultPatientProfile.pregnancyStatus,
    accountStatus: row?.account_status || row?.status || defaultPatientProfile.accountStatus,
    emailVerified: authUser?.email_confirmed_at ? true : null,
    lastLoginAt: authUser?.last_sign_in_at || "",
  };
}

function rememberPatientProfile(row, profile) {
  if (!row?.id && !row?.patient_id) return;

  window.localStorage.setItem(
    patientSessionStorageKey,
    JSON.stringify({
      userId: row?.user_id || profile?.userId || "",
      recordId: row?.id || profile?.recordId || "",
      patientId: row?.patient_id || "",
      email: row?.email || profile?.email || "",
      displayName: row?.full_name || profile?.full_name || profile?.displayName || "Patient",
    })
  );
}

function logPatientAccess(label, details = {}) {
  if (import.meta.env.DEV) {
    console.info(`[Patient Access] ${label}:`, details);
  }
}

function getUsefulSupabaseError(error) {
  return error?.message || error?.details || "Unknown Supabase error";
}

function getPatientAccessState(patientRow, supportsAccountStatus) {
  if (isPatientRecordArchived(patientRow)) {
    return {
      status: "archived",
      message: "This patient record is archived. Please contact the clinic.",
    };
  }

  if (!supportsAccountStatus || patientRow.account_status === undefined) {
    return {
      status: "missing_status",
      message:
        "Patient account status is not available yet. Please ask the clinic to apply the account-status migration.",
    };
  }

  const normalizedStatus = normalizePatientAccountStatus(patientRow.account_status);

  if (normalizedStatus === patientAccountStatuses.active) {
    return { status: "active", message: "" };
  }

  if (normalizedStatus === patientAccountStatuses.inactive) {
    return {
      status: "inactive",
      message: "Your Patient account is inactive. Please contact the clinic.",
    };
  }

  if (normalizedStatus === patientAccountStatuses.archived) {
    return {
      status: "archived",
      message: "This patient record is archived. Please contact the clinic.",
    };
  }

  return {
    status: "pending_activation",
    message: "Your Patient account is pending Admin activation.",
  };
}

function PatientLoadingScreen() {
  return (
    <div className="pwa-shell pwa-loading-shell">
      <div className="pwa-loading-card" role="status">
        <img src="/images/maternal-care-logo.png" alt="" />
        <span>{patientLoadingMessage}</span>
      </div>
    </div>
  );
}

function PatientAccessStateScreen({ state, onRetry, linkPatientUrl }) {
  const message =
    state.message ||
    (state.status === "unauthenticated"
      ? "Please log in to open your Patient dashboard."
      : "Unable to open your Patient dashboard.");

  const showRetry = state.status === "query_failure" || state.status === "missing_status";
  const isUnlinked = state.status === "unlinked";

  return (
    <main className="pwa-access-state" role="alert">
      <section className="pwa-access-state-card">
        <img src="/images/maternal-care-logo.png" alt="" />
        <h1>Maternal Care Patient</h1>
        <p>{message}</p>
        {import.meta.env.DEV && state.details ? (
          <pre>{state.details}</pre>
        ) : null}
        <div>
          {showRetry ? (
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          ) : null}
          <a href={isUnlinked ? linkPatientUrl : "/patient/login"}>
            {isUnlinked ? "Link Patient Record" : "Return to Login"}
          </a>
        </div>
      </section>
    </main>
  );
}

function PatientNotFound({ onNavigate }) {
  return (
    <section className="pwa-page pwa-not-found-page">
      <div className="pwa-page-title">
        <h1>Page not found</h1>
        <p>The Patient page you opened does not exist.</p>
      </div>
      <button type="button" className="pwa-primary-action" onClick={() => onNavigate("dashboard")}>
        Open Dashboard
      </button>
    </section>
  );
}

export default function PatientPWA() {
  const location = useLocation();
  const navigate = useNavigate();
  const activePage = getPageFromPath(location.pathname);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [profile, setProfile] = useState(defaultPatientProfile);
  const [accessState, setAccessState] = useState({
    status: "loading",
    message: patientLoadingMessage,
    details: "",
  });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;

    const loadPatientProfile = async () => {
      const routePath = window.location.pathname;
      const routeSearch = window.location.search;

      setAccessState({
        status: "loading",
        message: patientLoadingMessage,
        details: "",
      });

      try {
        const { data: userData, error: userError } = await supabase.auth.getUser();

        if (!active) return;

        if (userError && isMissingAuthSession(userError)) {
          logPatientAccess("unauthenticated", {
            route: routePath,
            redirectDestination: "/patient/login",
          });
          window.localStorage.removeItem(patientSessionStorageKey);
          setAccessState({
            status: "unauthenticated",
            message: "Please log in to open your Patient dashboard.",
            details: "",
          });
          return;
        }

        if (userError) {
          throw userError;
        }

        if (!userData.user) {
          logPatientAccess("unauthenticated", {
            route: routePath,
            redirectDestination: "/patient/login",
          });
          window.localStorage.removeItem(patientSessionStorageKey);
          setAccessState({
            status: "unauthenticated",
            message: "Please log in to open your Patient dashboard.",
            details: "",
          });
          return;
        }

        const user = userData.user;
        logPatientAccess("authenticated user", {
          authenticatedUserId: user.id,
          route: routePath,
          qrContainsPatientAccessParameters: Boolean(
            new URLSearchParams(routeSearch).get("patientId") &&
              new URLSearchParams(routeSearch).get("control")
          ),
        });

        const { data: profileRow, error: profileError } = await supabase
          .from("profiles")
          .select("id, full_name, email, role")
          .eq("id", user.id)
          .maybeSingle();

        if (!active) return;

        if (profileError) {
          console.error("Patient profile lookup failed:", profileError);
        }

        if (profileRow?.role && profileRow.role.toLowerCase() !== "patient") {
          logPatientAccess("role mismatch", {
            authenticatedUserId: user.id,
            role: profileRow.role,
            redirectDestination: "/patient/login",
          });
          window.localStorage.removeItem(patientSessionStorageKey);
          setAccessState({
            status: "unauthenticated",
            message: "This login is not a patient account.",
            details: "",
          });
          return;
        }

        const { data: linkedStatusData, error: linkedStatusError } =
          await supabase.rpc("get_current_patient_account_status");

        if (!active) return;

        if (linkedStatusError) {
          const statusErrorMessage = isMissingPatientLinkingRpc(linkedStatusError)
            ? "Patient account linking is not available yet. Please ask the clinic to apply the reviewed patient account-linking SQL."
            : `Unable to verify patient account access: ${getUsefulSupabaseError(linkedStatusError)}`;
          setAccessState({
            status: "query_failure",
            message: statusErrorMessage,
            details: getUsefulSupabaseError(linkedStatusError),
          });
          return;
        }

        const linkedSummary = Array.isArray(linkedStatusData)
          ? linkedStatusData[0] || null
          : linkedStatusData || null;
        const linkedStatus = linkedSummary
          ? normalizePatientAccountStatus(linkedSummary.account_status)
          : "unlinked";

        logPatientAccess("linked patient status", {
          authenticatedUserId: user.id,
          matchingPatientsUserIdRowFound: Boolean(linkedSummary),
          patientDatabaseId: linkedSummary?.id || null,
          normalizedAccountStatus: linkedStatus,
          route: routePath,
        });

        if (!linkedSummary) {
          window.localStorage.removeItem(patientSessionStorageKey);
          setAccessState({
            status: "unlinked",
            message: "No patient record is linked to this account yet.",
            details: "",
          });
          return;
        }

        if (linkedStatus !== patientAccountStatuses.active) {
          window.localStorage.removeItem(patientSessionStorageKey);
          await supabase.auth.signOut().catch(() => null);
          setAccessState(
            getPatientAccessState(
              { account_status: linkedSummary.account_status },
              true
            )
          );
          return;
        }

        const supportsAccountStatus = true;
        const { data: byUser, error: byUserError } = await supabase
          .rpc("get_patient_own_record")
          .limit(1)
          .maybeSingle();

        if (!active) return;

        if (byUserError) {
          logPatientAccess("access-query error", {
            authenticatedUserId: user.id,
            route: routePath,
            error: byUserError,
          });
          setAccessState({
            status: "query_failure",
            message: `Unable to verify patient account access: ${getUsefulSupabaseError(byUserError)}`,
            details: getUsefulSupabaseError(byUserError),
          });
          return;
        }

        const patientRow = byUser || null;
        logPatientAccess("patient row lookup", {
          authenticatedUserId: user.id,
          foundPatientRow: Boolean(patientRow),
          patientDatabaseId: patientRow?.id || null,
          route: routePath,
        });

        if (!patientRow) {
          window.localStorage.removeItem(patientSessionStorageKey);
          setAccessState({
            status: "query_failure",
            message:
              "Your linked patient record could not be loaded. Please retry or contact the clinic.",
            details: "The active linked patient row was not visible to the authenticated account.",
          });
          return;
        }

        const nextAccessState = getPatientAccessState(patientRow, supportsAccountStatus);
        logPatientAccess("account status", {
          authenticatedUserId: user.id,
          patientDatabaseId: patientRow.id,
          normalizedAccountStatus: nextAccessState.status,
          rawAccountStatus: patientRow.account_status,
          route: routePath,
        });

        if (nextAccessState.status !== "active") {
          window.localStorage.removeItem(patientSessionStorageKey);
          await supabase.auth.signOut().catch(() => null);
          setAccessState({ ...nextAccessState, details: "" });
          return;
        }

        setProfile(
          mapPatientProfile(patientRow, {
            ...(profileRow || { email: user.email }),
            authUser: user,
          })
        );
        rememberPatientProfile(patientRow, profileRow || { email: user.email });
        setAccessState({ status: "active", message: "", details: "" });
      } catch (error) {
        if (!active) return;

        if (isMissingAuthSession(error)) {
          window.localStorage.removeItem(patientSessionStorageKey);
          setAccessState({
            status: "unauthenticated",
            message: "Please log in to open your Patient dashboard.",
            details: "",
          });
          return;
        }

        console.error("Patient access verification failed:", error);
        logPatientAccess("access-query error", {
          route: window.location.pathname,
          error,
        });
        setAccessState({
          status: "query_failure",
          message: `Unable to verify patient account access: ${getUsefulSupabaseError(error)}`,
          details: getUsefulSupabaseError(error),
        });
      }
    };

    loadPatientProfile();

    return () => {
      active = false;
    };
  }, [reloadToken]);

  useEffect(() => {
    if (accessState.status !== "active") {
      return;
    }

    if (location.pathname.replace(/\/$/, "") === "/patient") {
      logPatientAccess("redirect destination", {
        from: location.pathname,
        to: pageRoutes.dashboard,
      });
      navigate(pageRoutes.dashboard, { replace: true });
    }
  }, [accessState.status, location.pathname, navigate]);

  const handleNavigate = (page) => {
    navigate(pageRoutes[page] || pageRoutes.dashboard);
  };

  const handleLogout = async () => {
    window.localStorage.removeItem(patientSessionStorageKey);
    const { error } = await supabase.auth.signOut();

    if (error) {
      console.error("Logout failed:", error);
    }

    navigate("/patient/login", { replace: true });
  };

  const renderContent = () => {
    switch (activePage) {
      case "profile":
        return <PatientPWAViewProfile profile={profile} />;

      case "settings":
        return <PatientPWASettings profile={profile} />;

      case "medical-record":
        return <PatientPWAMedicalRecords profile={profile} />;

      case "appointments":
        return <PatientPWAAppointments profile={profile} />;

      case "reminders":
        return <PatientPWAReminder profile={profile} />;

      case "dashboard":
        return <PatientPWADashboard profile={profile} onNavigate={handleNavigate} />;

      case "not-found":
      default:
        return <PatientNotFound onNavigate={handleNavigate} />;
    }
  };

  if (accessState.status === "loading") {
    return <PatientLoadingScreen />;
  }

  if (accessState.status !== "active") {
    return (
      <PatientAccessStateScreen
        state={accessState}
        onRetry={() => setReloadToken((current) => current + 1)}
        linkPatientUrl={`/patient/access${location.search || ""}`}
      />
    );
  }

  return (
    <PatientNotificationsProvider patientId={profile.recordId}>
      <div className="pwa-shell">
        <aside className="pwa-sidebar">
        <div className="pwa-brand">
          <span className="pwa-brand-icon">
            <Icon icon="mdi:human-pregnant" />
          </span>
          <div>
            <h1>Maternal Care</h1>
            <p>Reminder &amp; Management</p>
          </div>
        </div>

        <nav className="pwa-nav" aria-label="Patient PWA navigation">
          {navItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`pwa-nav-item ${
                activePage === item.key
                  ? "is-active"
                  : ""
              }`}
              onClick={() => handleNavigate(item.key)}
              aria-label={item.label}
              aria-current={activePage === item.key ? "page" : undefined}
              data-mobile-label={item.mobileLabel}
              title={item.label}
            >
              <Icon icon={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        </aside>

        <main className={`pwa-main ${profileMenuOpen ? "is-profile-open" : ""}`}>
          <header className="pwa-topbar">
            <button
              type="button"
              className="pwa-mobile-brand"
              onClick={() => handleNavigate("dashboard")}
              aria-label="Open patient dashboard"
            >
              <span aria-hidden="true"><Icon icon="mdi:human-pregnant" /></span>
              <span>
                <strong>Maternal Care</strong>
                <small>Patient portal</small>
              </span>
            </button>

            <div className="pwa-topbar-actions">
              <PatientNotificationBell onNavigate={(targetPath) => navigate(targetPath)} />
              <TopProfile
                profile={profile}
                onNavigate={handleNavigate}
                onLogout={handleLogout}
                onOpenChange={setProfileMenuOpen}
              />
            </div>
          </header>
          <div className="pwa-content">{renderContent()}</div>
        </main>
      </div>
    </PatientNotificationsProvider>
  );
}

function TopProfile({ profile, onNavigate, onLogout, onOpenChange }) {
  const wrapperRef = useRef(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    onOpenChange?.(open);
  }, [onOpenChange, open]);

  useEffect(() => {
    const closeOnOutside = (event) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setOpen(false);
      }
    };

    const closeOnEscape = (event) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  const goTo = (page) => {
    onNavigate(page);
    setOpen(false);
  };

  const handleLogoutClick = async () => {
    setOpen(false);
    await onLogout();
  };

  return (
    <div className={`pwa-top-profile ${open ? "is-open" : ""}`} ref={wrapperRef}>
      <button
        className={`pwa-profile-pill ${open ? "is-open" : ""}`}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Open patient profile menu"
      >
        <Avatar profile={profile} className="pwa-profile-pill-avatar" />
        <span className="pwa-profile-pill-copy">
          <strong>{profile.displayName}</strong>
          <small>Patient</small>
        </span>
        <Icon icon="solar:alt-arrow-down-linear" />
      </button>

      {open ? (
        <div className="pwa-profile-menu" role="menu">
          <button type="button" onClick={() => goTo("profile")}>
            <Icon icon="solar:user-rounded-bold" />
            <span>Profile</span>
          </button>
          <button type="button" onClick={() => goTo("settings")}>
            <Icon icon="solar:settings-bold" />
            <span>Settings</span>
          </button>
          <button type="button" className="pwa-profile-logout" onClick={handleLogoutClick}>
            <Icon icon="solar:logout-2-bold" />
            <span>Log out</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Avatar({ profile, className = "" }) {
  const [imageError, setImageError] = useState(false);

  if (!profile.avatar || imageError) {
    return (
      <span className={`pwa-avatar-fallback ${className}`}>
        {profile.displayName
          .split(" ")
          .map((part) => part[0])
          .join("")
          .slice(0, 2)}
      </span>
    );
  }

  return (
    <img
      className={className}
      src={profile.avatar}
      alt=""
      onError={() => setImageError(true)}
    />
  );
}
