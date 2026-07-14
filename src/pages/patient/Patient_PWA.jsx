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
import "../../styles/patient-PWA.css";
import "../../styles/patient-PWA-dashboard.css";
import "../../styles/patient-PWA-viewprofile.css";
import "../../styles/patient_PWA_settings.css";
import "../../styles/patient-PWA-medicalrecords.css";
import "../../styles/patient-PWA-appointments.css";
import "../../styles/patient-PWA-reminder.css";

const defaultPatientProfile = {
  recordId: "",
  displayName: "Maria Makiling",
  patientId: "PAT-2026-00125",
  avatar: "/images/maria-makiling-profile.svg",
  age: "28 years old",
  gender: "Female",
  civilStatus: "Married",
  trimester: "2nd Trimester",
  pregnancyWeek: 18,
  bloodType: "O+",
  email: "maria.makiling@gmail.com",
  phone: "0912 345 6789",
  address: "La Paz, Iloilo City, Philippines",
  emergencyName: "Juan Makiling",
  emergencyRelation: "Husband",
  emergencyPhone: "0912 987 6543",
  nationality: "Filipino",
  birthdate: "January 10, 1998",
  pregnancyStatus: "Active",
  gravida: "2",
  para: "1",
  dueDate: "December 28, 2026",
  physician: "Dr. Kempee Vergara",
  clinic: "La Paz Maternity and Reproductive Health Center",
};

const patientColumns =
  "id, full_name, patient_id, user_id, email, date_of_birth, age, address, contact_number, expected_delivery_date, gestational_age, trimester, blood_type, status";
const patientSessionStorageKey = "maternal_patient_session";

const navItems = [
  { key: "dashboard", label: "Dashboard", icon: "solar:widget-2-bold" },
  { key: "medical-record", label: "Medical Record", icon: "solar:document-medicine-linear" },
  { key: "appointments", label: "Appointments", icon: "solar:calendar-linear" },
  { key: "reminders", label: "Reminders", icon: "solar:bell-linear" },
];

const pageRoutes = {
  dashboard: "/patient",
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
routePages["/patient/medical-records"] = "medical-record";

function getPageFromPath(pathname) {
  return routePages[pathname.replace(/\/$/, "") || "/patient"] || "dashboard";
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
  if (row?.age) return `${row.age} years old`;

  if (!row?.date_of_birth) return defaultPatientProfile.age;

  const birth = new Date(`${row.date_of_birth}T00:00:00`);
  if (Number.isNaN(birth.getTime())) return defaultPatientProfile.age;

  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const monthDelta = today.getMonth() - birth.getMonth();

  if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < birth.getDate())) {
    age -= 1;
  }

  return `${age} years old`;
}

function mapPatientProfile(row, profile) {
  return {
    ...defaultPatientProfile,
    recordId: row?.id || "",
    displayName: row?.full_name || profile?.full_name || defaultPatientProfile.displayName,
    patientId: row?.patient_id || profile?.patient_id || defaultPatientProfile.patientId,
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
  };
}

function rememberPatientProfile(row, profile) {
  if (!row?.id && !row?.patient_id && !profile?.patient_id) return;

  window.localStorage.setItem(
    patientSessionStorageKey,
    JSON.stringify({
      userId: row?.user_id || profile?.userId || "",
      recordId: row?.id || profile?.recordId || "",
      patientId: row?.patient_id || profile?.patient_id || "",
      email: row?.email || profile?.email || "",
      displayName: row?.full_name || profile?.full_name || profile?.displayName || "Patient",
    })
  );
}

export default function PatientPWA() {
  const location = useLocation();
  const navigate = useNavigate();
  const [activePage, setActivePage] = useState(() => getPageFromPath(location.pathname));
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [profile, setProfile] = useState(defaultPatientProfile);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    setActivePage(getPageFromPath(location.pathname));
  }, [location.pathname]);

  useEffect(() => {
    let active = true;

    const loadPatientProfile = async () => {
      const { data: userData, error: userError } = await supabase.auth.getUser();

      if (userError || !userData.user) {
        console.error("[Patient Appointment Flow] no authenticated patient session:", userError);
        window.localStorage.removeItem(patientSessionStorageKey);
        navigate("/patient/access?mode=login", { replace: true });
        return;
      }

      const user = userData.user;
      console.info("[Patient Appointment Flow] Patient PWA authenticated user ID:", user.id);
      const { data: profileRow, error: profileError } = await supabase
        .from("profiles")
        .select("full_name, email, role, patient_id")
        .or(`id.eq.${user.id},email.eq.${user.email}`)
        .maybeSingle();

      if (profileError) {
        console.error("Patient profile lookup failed:", profileError);
      }

      if (profileRow?.role && profileRow.role.toLowerCase() !== "patient") {
        console.error("[Patient Appointment Flow] active auth user is not a patient:", {
          userId: user.id,
          role: profileRow.role,
        });
        window.localStorage.removeItem(patientSessionStorageKey);
        navigate("/patient/access?mode=login", { replace: true });
        return;
      }

      let patientRow = null;

      const { data: byUser, error: byUserError } = await supabase
        .from("patients")
        .select(patientColumns)
        .eq("user_id", user.id)
        .limit(1)
        .maybeSingle();

      if (byUserError) {
        console.error("Patient row lookup failed:", byUserError);
      }

      patientRow = byUser || null;

      if (!patientRow) {
        console.error("[Patient Appointment Flow] no patients row found for authenticated user ID:", user.id);
        window.localStorage.removeItem(patientSessionStorageKey);
        navigate("/patient/access?mode=login", { replace: true });
        return;
      }

      if (!active) return;

      setProfile(mapPatientProfile(patientRow, profileRow || { email: user.email }));
      rememberPatientProfile(patientRow, profileRow || { email: user.email });
      setCheckingSession(false);
    };

    loadPatientProfile();

    return () => {
      active = false;
    };
  }, [navigate]);

  const handleNavigate = (page) => {
    setActivePage(page);
    navigate(pageRoutes[page] || pageRoutes.dashboard);
  };

  const handleLogout = async () => {
    window.localStorage.removeItem(patientSessionStorageKey);
    const { error } = await supabase.auth.signOut();

    if (error) {
      console.error("Logout failed:", error);
    }

    navigate("/patient/access?mode=login", { replace: true });
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
      default:
        return <PatientPWADashboard profile={profile} onNavigate={handleNavigate} />;
    }
  };

  if (checkingSession) {
    return (
      <div className="pwa-shell pwa-loading-shell">
        <div className="pwa-loading-card" role="status">
          <img src="/images/maternal-care-logo.png" alt="" />
          <span>Opening patient dashboard</span>
        </div>
      </div>
    );
  }

  return (
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
            >
              <Icon icon={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className={`pwa-main ${profileMenuOpen ? "is-profile-open" : ""}`}>
        <TopProfile
          profile={profile}
          onNavigate={handleNavigate}
          onLogout={handleLogout}
          onOpenChange={setProfileMenuOpen}
        />
        <div className="pwa-content">{renderContent()}</div>
      </main>
    </div>
  );
}

function TopProfile({ profile, onNavigate, onLogout, onOpenChange }) {
  const wrapperRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);

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
          <button
            type="button"
            onClick={() => setNotificationsEnabled((prev) => !prev)}
          >
            <Icon icon={notificationsEnabled ? "solar:bell-bold" : "solar:bell-off-bold"} />
            <span>{notificationsEnabled ? "Disable" : "Enable"} notifications</span>
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

function ComingSoonPage({ title, description }) {
  return (
    <section className="pwa-page pwa-coming-soon">
      <div className="pwa-page-title">
        <h1>{title}</h1>
        <p>{description}</p>
      </div>

      <div className="pwa-empty-card">
        <Icon icon="solar:heart-pulse-bold-duotone" />
        <h2>Ready for the next design</h2>
        <p>This area is already connected to the patient navigation.</p>
      </div>
    </section>
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
