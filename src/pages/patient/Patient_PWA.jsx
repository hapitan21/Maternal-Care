import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import WorkspaceSectionFallback from "../../components/common/WorkspaceSectionFallback";
import MaternalCareLogo from "../../components/common/MaternalCareLogo";
import PatientNotificationBell from "../../components/patient/PatientNotificationBell";
import PatientNotificationsProvider from "../../components/patient/PatientNotificationsProvider";
import PatientPwaStatus from "../../components/patient/PatientPwaStatus";
import {
  getProfilePictureDisplayUrl,
  profilePictureUpdatedEvent,
} from "../../lib/profilePicture";
import { PatientTopbarSecondaryProvider } from "../../components/patient/PatientPwaUi";
import {
  isPatientRecordArchived,
  normalizePatientAccountStatus,
  patientAccountStatuses,
} from "../../lib/patientAccountStatus";
import {
  loadPatientProfileSummary,
  mapPatientProfileSummary,
} from "../../lib/patientProfile";
import {
  clearPatientPwaSessionCache,
  getPatientPwaSessionCache,
  setPatientPwaSessionCache,
} from "../../lib/patientPwaSessionCache";
import "../../styles/patient-PWA.css";
import "../../styles/patient-notifications.css";
import "../../styles/patient-pwa-ui-system.css";
import "../../styles/patient-pwa-status.css";

const PatientPWADashboard = lazy(() => import("./Patient_PWA_Dashboard"));
const PatientPWAViewProfile = lazy(() => import("./Patient_PWA_ViewProfile"));
const PatientPWASettings = lazy(() => import("./Patient_PWA_Settings"));
const PatientPWAMedicalRecords = lazy(() => import("./Patient_PWA_MedicalRecords"));
const PatientPWAAppointments = lazy(() => import("./Patient_PWA_Appointments"));
const PatientBookAppointment = lazy(() => import("../../components/patient/PatientBookAppointment"));
const PatientPWAReminder = lazy(() => import("./Patient_PWA_Reminder"));

const defaultPatientProfile = {
  recordId: "",
  displayName: "Patient",
  patientId: "Not provided",
  avatar: "",
  age: "Not provided",
  sexAtBirth: "Not provided",
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
const patientAccountCacheSection = "account-shell";
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
  "book-appointment": "/patient/appointments/book",
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

function getCachedPatientAccount() {
  try {
    const rememberedSession = JSON.parse(
      window.localStorage.getItem(patientSessionStorageKey) || "null"
    );
    const recordId = String(rememberedSession?.recordId || "").trim();
    const userId = String(rememberedSession?.userId || "").trim();

    if (!recordId || !userId) return null;

    const cachedAccount = getPatientPwaSessionCache(
      recordId,
      patientAccountCacheSection
    );

    if (
      !cachedAccount?.profile ||
      cachedAccount.userId !== userId ||
      cachedAccount.profile.recordId !== recordId
    ) {
      return null;
    }

    return cachedAccount;
  } catch {
    return null;
  }
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
        <MaternalCareLogo decorative variant="status" />
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
        <MaternalCareLogo decorative variant="status" />
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
  const [topbarSecondaryTarget, setTopbarSecondaryTarget] = useState(null);
  const [initialAccountCache] = useState(getCachedPatientAccount);
  const initialAccountCacheRef = useRef(initialAccountCache);
  const [profile, setProfile] = useState(
    () => initialAccountCache?.profile || defaultPatientProfile
  );
  const [accessState, setAccessState] = useState(() =>
    initialAccountCache
      ? { status: "active", message: "", details: "" }
      : {
          status: "loading",
          message: patientLoadingMessage,
          details: "",
        }
  );
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;

    const loadPatientProfile = async () => {
      const routePath = window.location.pathname;
      const routeSearch = window.location.search;

      if (!initialAccountCacheRef.current) {
        setAccessState({
          status: "loading",
          message: patientLoadingMessage,
          details: "",
        });
      }

      try {
        const { data: userData, error: userError } = await supabase.auth.getUser();

        if (!active) return;

        if (userError && isMissingAuthSession(userError)) {
          logPatientAccess("unauthenticated", {
            route: routePath,
            redirectDestination: "/patient/login",
          });
          window.localStorage.removeItem(patientSessionStorageKey);
          clearPatientPwaSessionCache();
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
          clearPatientPwaSessionCache();
          setAccessState({
            status: "unauthenticated",
            message: "Please log in to open your Patient dashboard.",
            details: "",
          });
          return;
        }

        const user = userData.user;
        if (
          initialAccountCacheRef.current &&
          initialAccountCacheRef.current.userId !== user.id
        ) {
          initialAccountCacheRef.current = null;
          clearPatientPwaSessionCache();
          setProfile(defaultPatientProfile);
          setAccessState({
            status: "loading",
            message: patientLoadingMessage,
            details: "",
          });
        }
        logPatientAccess("authenticated user", {
          authenticatedUserId: user.id,
          route: routePath,
          qrContainsPatientAccessParameters: Boolean(
            new URLSearchParams(routeSearch).get("patientId") &&
              new URLSearchParams(routeSearch).get("control")
          ),
        });

        let { data: profileRow, error: profileError } = await supabase
          .from("profiles")
          .select("id, full_name, email, role, avatar_url")
          .eq("id", user.id)
          .maybeSingle();

        if (
          profileError &&
          ["42703", "PGRST204"].includes(profileError.code)
        ) {
          const legacyResult = await supabase
            .from("profiles")
            .select("id, full_name, email, role")
            .eq("id", user.id)
            .maybeSingle();
          profileRow = legacyResult.data;
          profileError = legacyResult.error;
        }

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
          clearPatientPwaSessionCache();
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
          clearPatientPwaSessionCache();
          setAccessState({
            status: "unlinked",
            message: "No patient record is linked to this account yet.",
            details: "",
          });
          return;
        }

        if (linkedStatus !== patientAccountStatuses.active) {
          window.localStorage.removeItem(patientSessionStorageKey);
          clearPatientPwaSessionCache();
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
          clearPatientPwaSessionCache();
          await supabase.auth.signOut().catch(() => null);
          setAccessState({ ...nextAccessState, details: "" });
          return;
        }

        const profileSummary = await loadPatientProfileSummary();

        if (!active) return;

        if (profileSummary.patient.id !== patientRow.id) {
          throw new Error("The Patient profile summary did not match the linked Patient record.");
        }

        let avatarDisplayUrl = "";
        if (profileRow?.avatar_url) {
          try {
            avatarDisplayUrl = await getProfilePictureDisplayUrl(profileRow.avatar_url);
          } catch (avatarError) {
            if (import.meta.env.DEV) {
              console.warn("Unable to load Patient profile picture:", avatarError);
            }
          }
        }

        const nextProfile = {
          ...defaultPatientProfile,
          ...mapPatientProfileSummary(profileSummary, {
            userId: user.id,
            fullName: profileRow?.full_name,
            email: user.email || profileRow?.email,
            avatarDisplayUrl,
            emailVerified: Boolean(user.email_confirmed_at),
            lastLoginAt: user.last_sign_in_at || "",
          }),
        };
        setProfile(nextProfile);
        rememberPatientProfile(profileSummary.patient, {
          ...(profileRow || {}),
          email: user.email || profileRow?.email,
        });
        const nextAccountCache = {
          userId: user.id,
          profile: nextProfile,
        };
        initialAccountCacheRef.current = nextAccountCache;
        setPatientPwaSessionCache(
          profileSummary.patient.id,
          patientAccountCacheSection,
          nextAccountCache
        );
        setAccessState({ status: "active", message: "", details: "" });
      } catch (error) {
        if (!active) return;

        if (isMissingAuthSession(error)) {
          window.localStorage.removeItem(patientSessionStorageKey);
          clearPatientPwaSessionCache();
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
    if (
      accessState.status !== "active" ||
      !profile.recordId ||
      !profile.userId
    ) {
      return;
    }

    const nextAccountCache = {
      userId: profile.userId,
      profile,
    };
    initialAccountCacheRef.current = nextAccountCache;
    setPatientPwaSessionCache(
      profile.recordId,
      patientAccountCacheSection,
      nextAccountCache
    );
  }, [accessState.status, profile]);

  useEffect(() => {
    const syncProfilePicture = (event) => {
      setProfile((current) => ({
        ...current,
        avatar: event.detail?.displayUrl || "",
      }));
    };

    window.addEventListener(profilePictureUpdatedEvent, syncProfilePicture);
    return () => {
      window.removeEventListener(profilePictureUpdatedEvent, syncProfilePicture);
    };
  }, []);

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
    if (typeof page === "string" && page.startsWith("/patient/")) {
      navigate(page);
      return;
    }

    navigate(pageRoutes[page] || pageRoutes.dashboard);
  };

  const handleLogout = async () => {
    window.localStorage.removeItem(patientSessionStorageKey);
    clearPatientPwaSessionCache();
    const { error } = await supabase.auth.signOut();

    if (error) {
      console.error("Logout failed:", error);
    }

    navigate("/patient/login", { replace: true });
  };

  const renderContent = () => {
    switch (activePage) {
      case "profile":
        return (
          <PatientPWAViewProfile
            profile={profile}
            onProfileChange={(updates) =>
              setProfile((current) => ({ ...current, ...updates }))
            }
            onAvatarChange={(avatar) =>
              setProfile((current) => ({ ...current, avatar }))
            }
          />
        );

      case "settings":
        return <PatientPWASettings profile={profile} />;

      case "medical-record":
        return <PatientPWAMedicalRecords profile={profile} />;

      case "appointments":
        return <PatientPWAAppointments profile={profile} />;

      case "book-appointment":
        return <PatientBookAppointment profile={profile} />;

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
      <PatientTopbarSecondaryProvider target={topbarSecondaryTarget}>
        <div className="pwa-shell">
        <aside className="pwa-sidebar">
        <div className="pwa-brand maternal-care-brand">
          <MaternalCareLogo variant="patient-sidebar" />
        </div>

        <nav className="pwa-nav" aria-label="Patient PWA navigation">
          {navItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`pwa-nav-item ${
                activePage === item.key ||
                (item.key === "appointments" && activePage === "book-appointment")
                  ? "is-active"
                  : ""
              }`}
              onClick={() => handleNavigate(item.key)}
              aria-label={item.label}
              aria-current={
                activePage === item.key ||
                (item.key === "appointments" && activePage === "book-appointment")
                  ? "page"
                  : undefined
              }
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
              <MaternalCareLogo decorative variant="mobile" />
            </button>

            <div className="pwa-topbar-actions">
              <PatientNotificationBell onNavigate={(targetPath) => navigate(targetPath)} />
              <TopProfile
                profile={profile}
                onNavigate={handleNavigate}
                onLogout={handleLogout}
                onOpenChange={setProfileMenuOpen}
              />
              <div
                className="pwa-topbar-secondary"
                ref={setTopbarSecondaryTarget}
              />
            </div>
          </header>
          <PatientPwaStatus />
          <div className="pwa-content">
            <Suspense fallback={<WorkspaceSectionFallback label="Patient workspace" />}>
              {renderContent()}
            </Suspense>
          </div>
        </main>
        </div>
      </PatientTopbarSecondaryProvider>
    </PatientNotificationsProvider>
  );
}

function TopProfile({ profile, onNavigate, onLogout, onOpenChange }) {
  const wrapperRef = useRef(null);
  const triggerRef = useRef(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;

    onOpenChange?.(open);
  }, [onOpenChange, open]);

  useEffect(() => {
    const closeOnOutside = (event) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setOpen(false);
      }
    };

    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        window.requestAnimationFrame(() => triggerRef.current?.focus());
      }
    };

    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

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
        ref={triggerRef}
        className={`pwa-profile-pill ${open ? "is-open" : ""}`}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={open ? "Close patient profile menu" : "Open patient profile menu"}
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
          <button type="button" role="menuitem" onClick={() => goTo("profile")}>
            <Icon icon="solar:user-rounded-bold" aria-hidden="true" />
            <span>Profile</span>
          </button>
          <button type="button" role="menuitem" onClick={() => goTo("settings")}>
            <Icon icon="solar:settings-bold" aria-hidden="true" />
            <span>Settings</span>
          </button>
          <button type="button" role="menuitem" className="pwa-profile-logout" onClick={handleLogoutClick}>
            <Icon icon="solar:logout-2-bold" aria-hidden="true" />
            <span>Log out</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Avatar({ profile, className = "" }) {
  const [failedAvatarUrl, setFailedAvatarUrl] = useState("");

  if (!profile.avatar || failedAvatarUrl === profile.avatar) {
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
      onError={() => setFailedAvatarUrl(profile.avatar)}
    />
  );
}
