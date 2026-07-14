import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { supabase } from "../../lib/supabaseClient";
import "../../styles/doctor-patients.css";

const svgToDataUri = (svg) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
const doctorSettingsKey = "doctor_dashboard_settings";
const defaultDoctorMenuProfile = {
  displayName: "Doctor",
  roleLabel: "Doctor",
};

const doctorPhoto = svgToDataUri(`
<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#FFE4ED"/><stop offset="1" stop-color="#F7D8B9"/>
    </linearGradient>
  </defs>
  <rect width="120" height="120" rx="60" fill="url(#bg)"/>
  <circle cx="60" cy="48" r="22" fill="#2f2b32"/>
  <circle cx="60" cy="53" r="17" fill="#F2C6A8"/>
  <path d="M33 108c4-23 18-34 27-34s23 11 27 34" fill="#ffffff"/>
  <path d="M43 106c2-17 9-26 17-26s15 9 17 26" fill="#A9C2B8" opacity=".9"/>
  <circle cx="53" cy="53" r="2" fill="#333"/><circle cx="67" cy="53" r="2" fill="#333"/>
  <path d="M53 62c5 4 10 4 15 0" fill="none" stroke="#9E4F54" stroke-width="2" stroke-linecap="round"/>
</svg>`);

function getStoredDoctorMenuProfile() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(doctorSettingsKey));

    return {
      ...defaultDoctorMenuProfile,
      displayName:
        String(saved?.displayName || "").trim() ||
        defaultDoctorMenuProfile.displayName,
    };
  } catch {
    return { ...defaultDoctorMenuProfile };
  }
}

function getDoctorMenuDisplayName(user, profile, fallbackName) {
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
    defaultDoctorMenuProfile.displayName
  );
}

async function loadDoctorMenuProfile() {
  const fallbackProfile = getStoredDoctorMenuProfile();
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
    displayName: getDoctorMenuDisplayName(
      user,
      profile,
      fallbackProfile.displayName
    ),
    roleLabel: "Doctor",
  };
}

const mariaPhoto = svgToDataUri(`
<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 220 220">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#FFF7EF"/><stop offset="1" stop-color="#DDECE7"/>
    </linearGradient>
    <linearGradient id="scrub" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#D9F0EB"/><stop offset="1" stop-color="#8CB9AD"/>
    </linearGradient>
  </defs>
  <rect width="220" height="220" rx="26" fill="url(#bg)"/>
  <path d="M55 105c0-44 24-72 57-72s55 27 55 72v61H55z" fill="#2d272a"/>
  <circle cx="111" cy="86" r="38" fill="#F1C09D"/>
  <path d="M73 83c10-35 48-47 77-18 0 0-11 14-34 15-19 1-35-7-43 3z" fill="#211d20"/>
  <circle cx="97" cy="90" r="3" fill="#2b2528"/><circle cx="125" cy="90" r="3" fill="#2b2528"/>
  <path d="M98 106c9 7 20 7 29 0" fill="none" stroke="#9B4D50" stroke-width="4" stroke-linecap="round"/>
  <path d="M48 205c7-45 34-70 63-70s56 25 63 70" fill="url(#scrub)"/>
  <path d="M82 142l30 40 29-40" fill="none" stroke="#F8FFFC" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`);

const pregnancyIllustration = svgToDataUri(`
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
  <rect width="240" height="240" rx="32" fill="#FFE5D8"/>
  <circle cx="122" cy="126" r="70" fill="#F7C1A6" opacity=".62"/>
  <path d="M105 65c28 4 50 32 43 61-6 26-21 45-20 73H91c4-37 8-64-7-84-13-17-10-45 21-50z" fill="#A7433D"/>
  <path d="M103 99c24-8 45 12 46 42 1 27-15 45-38 45-17 0-31-20-28-42 3-22 10-41 20-45z" fill="#D96F5B"/>
  <path d="M120 130c-1 21 16 36 34 34" fill="none" stroke="#FFEFEA" stroke-width="8" stroke-linecap="round"/>
  <path d="M69 178c12-16 30-18 45-10" fill="none" stroke="#BA5948" stroke-width="5" stroke-linecap="round"/>
  <path d="M166 82c10-3 20-12 22-24 8 12 7 25-3 36" fill="#C96B48"/>
  <path d="M51 184c10 5 20 11 29 24M184 160c14 3 24 11 31 24" stroke="#CC7A57" stroke-width="4" stroke-linecap="round"/>
</svg>`);


const babyScanImage = svgToDataUri(`
<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
  <defs>
    <radialGradient id="scanGlow" cx="50%" cy="48%" r="58%">
      <stop offset="0" stop-color="#FFE8DF"/>
      <stop offset="0.42" stop-color="#D2745C"/>
      <stop offset="0.74" stop-color="#6F3340"/>
      <stop offset="1" stop-color="#1F1830"/>
    </radialGradient>
    <linearGradient id="scanPanel" x1="0" x2="1" y1="0" y2="1">
      <stop stop-color="#3B2144"/>
      <stop offset="1" stop-color="#FFE6F0"/>
    </linearGradient>
  </defs>
  <rect width="160" height="160" rx="28" fill="url(#scanPanel)"/>
  <circle cx="80" cy="80" r="50" fill="url(#scanGlow)"/>
  <circle cx="80" cy="80" r="37" fill="none" stroke="#FFE5D7" stroke-width="3" opacity=".55"/>
  <path d="M70 55c18 1 32 19 28 39-3 15-14 25-29 25-17 0-29-14-28-31 1-16 12-31 29-33z" fill="#F9B08E" opacity=".92"/>
  <path d="M77 64c12 5 16 15 12 28-3 10-13 14-23 10" fill="none" stroke="#873F35" stroke-width="7" stroke-linecap="round"/>
  <circle cx="88" cy="76" r="5" fill="#FFF1E6" opacity=".9"/>
</svg>`);

const patientsSeed = [
  {
    initials: "MM",
    avatarClass: "patient-avatar-pink",
    photo: mariaPhoto,
    name: "Patient",
    patientId: "00-00-01",
    id: "Patient ID: 00-00-01",
    sexAge: "Female • 34 years old",
    dateOfBirth: "January 01, 1990",
    birthdate: "January 01, 1990",
    contact: "0998 765 4321",
    email: "maria.makiling@gmail.com",
    address: "Mount Makiling, Laguna",
    bloodType: "O+",
    maritalStatus: "Married",
    status: "Active Patient",
    pregnancyNo: "G2P1",
    gestationalAge: "28 Weeks",
    deliveryDate: "December 15, 2026",
    shortDeliveryDate: "Dec 15, 2026",
    riskLevel: "Low Risk",
    progressWeeks: "28 of 40 weeks",
    lastVisitDate: "April 19, 2025",
    lastVisitDoctor: "Dr. Kampan Vergara",
  },
  {
    initials: "PG",
    avatarClass: "patient-avatar-purple",
    photo: "",
    name: "Patient",
    patientId: "00-00-02",
    id: "Patient ID: 00-00-02",
    sexAge: "Female • 20 years old",
    dateOfBirth: "July 30, 2004",
    birthdate: "July 30, 2004",
    contact: "0912 778 4521",
    email: "patsy.gascon@gmail.com",
    address: "Iloilo City",
    bloodType: "A+",
    maritalStatus: "Single",
    status: "Active Patient",
    pregnancyNo: "G1P0",
    gestationalAge: "20 Weeks",
    deliveryDate: "February 08, 2027",
    shortDeliveryDate: "Feb 8, 2027",
    riskLevel: "Low Risk",
    progressWeeks: "20 of 40 weeks",
    lastVisitDate: "May 10, 2025",
    lastVisitDoctor: "Dr. Kempee Vergara",
  },
  {
    initials: "RS",
    avatarClass: "patient-avatar-blue",
    photo: "",
    name: "Patient",
    patientId: "00-00-03",
    id: "Patient ID: 00-00-03",
    sexAge: "Female • 28 years old",
    dateOfBirth: "March 15, 1996",
    birthdate: "March 15, 1996",
    contact: "0908 456 7741",
    email: "rose.santos@gmail.com",
    address: "La Paz, Iloilo",
    bloodType: "B+",
    maritalStatus: "Married",
    status: "Active Patient",
    pregnancyNo: "G2P1",
    gestationalAge: "24 Weeks",
    deliveryDate: "November 03, 2026",
    shortDeliveryDate: "Nov 3, 2026",
    riskLevel: "Low Risk",
    progressWeeks: "24 of 40 weeks",
    lastVisitDate: "April 27, 2025",
    lastVisitDoctor: "Dr. Kempee Vergara",
  },
];

const recordTabs = [
  "Overview",
  "Prenatal History",
  "Appointments",
  "Medical Record",
  "Diagnostic Results",
  "Prescriptions",
  "Pregnancy Tracking",
];

const pregnancyMetrics = [
  { icon: "solar:heart-linear", title: "Fetal Heart Rate", value: "148", unit: "bpm", date: "April 19, 2024", tone: "blue" },
  { icon: "mdi:ruler-square", title: "Fundal Height", value: "28", unit: "cm", date: "April 19, 2024", tone: "pink" },
  { icon: "healthicons:baby-outline", title: "Baby Position", value: "Cephalic", unit: "", date: "April 19, 2024", tone: "orange" },
  { icon: "fluent:footprints-20-regular", title: "Movement", value: "Active", unit: "", date: "April 19, 2024", tone: "green" },
];

const vitalSigns = [
  { label: "Blood Pressure", value: "120/80", unit: "mmHg" },
  { label: "Heart Rate", value: "72", unit: "bpm" },
  { label: "Weight", value: "65", unit: "kg" },
  { label: "Temperature", value: "36.7", unit: "°C" },
];

const appointments = [
  { date: "4-01-25", time: "9:00 AM", gestationalAge: "12 Weeks", doctor: "Dr. Kempee Vergara", purpose: "Initial Prenatal Check-up", status: "Completed" },
  { date: "5-01-25", time: "9:00 AM", gestationalAge: "20 Weeks", doctor: "Dr. Kempee Vergara", purpose: "Prenatal Check-up", status: "Completed" },
];

const appointmentTimeline = [
  { week: "Week 12", title: "Initial Prenatal Check-up", date: "April 1, 2025", status: "Completed" },
  { week: "Week 20", title: "Anatomy Scan", date: "May 1, 2025", status: "Completed" },
  { week: "Week 24", title: "Routine Follow-up", date: "May 25, 2025", status: "Completed" },
];

const medicalRecords = [
  {
    id: "mr-001",
    date: "April 1, 2025",
    dayTime: "Tuesday • 9:00 AM",
    visitType: "Initial Prenatal Check-up",
    gestationalAge: "12 Weeks",
    doctor: "Dr. Kempee Vergara",
    chiefComplaint: "Missed menstrual period and positive pregnancy test. Patient presents for initial prenatal consultation.",
    diagnosis: "Normal Early Intrauterine Pregnancy",
    attachment: "Pregnancy Confirmation Report.pdf",
  },
];

const diagnosticResults = [
  { date: "April 1, 2025", gpa: "12 weeks GPA", test: "Hepatitis B Surface Antigen", subtitle: "HBsAG Laboratory Screen", status: "Normal", orderedBy: "Dr. Kempee Vergara", file: "HBsAg.pdf", size: "PDF 185KB" },
  { date: "April 1, 2025", gpa: "12 weeks GPA", test: "Blood type and RH", subtitle: "Complete Blood Profile", status: "-", orderedBy: "Dr. Kempee Vergara", file: "Blood Type and RH.pdf", size: "PDF 212KB" },
];

const prescriptions = [
  {
    title: "Prescription #RX-2025-001",
    doctor: "Dr. Kempee Vergara",
    date: "April 1, 2025",
    file: "Prescription #RX-2025-001.pdf",
    size: "PDF 185KB",
    instructions: "Take after breakfast. Ensure consistent timing for optimal prenatal health. Stay hydrated throughout the day.",
    medications: [
      { medication: "Folic Acid", dosage: "400 mcg", frequency: "Once Daily", duration: "90 days" },
      { medication: "Prenatal Vitamins", dosage: "1 tablet", frequency: "Once Daily", duration: "90 days" },
    ],
  },
];

const journeyMilestones = [
  { week: "Week 8", title: "Pregnancy Confirmed", note: "First prenatal assessment completed", icon: "twemoji:seedling", done: true },
  { week: "Week 10", title: "Heartbeat Detected", note: "Strong fetal heartbeat observed", icon: "twemoji:heart-suit", done: true },
  { week: "Week 12", title: "First Trimester Done", note: "Reduced risk of early complications", icon: "twemoji:blossom", done: true },
  { week: "Week 18", title: "Baby Movements", note: "Mother reports feeling baby move", icon: "twemoji:footprints", done: true },
  { week: "Week 20", title: "Anatomy Complete", note: "Major organs and structures formed", icon: "twemoji:brain", done: true },
  { week: "Week 28", title: "3rd Trimester", note: "Rapid growth and weight gain", icon: "twemoji:level-slider", current: true },
  { week: "Week 34", title: "Lung Development", note: "Lungs maturing and strengthening", icon: "twemoji:lungs", done: false },
  { week: "Week 37", title: "Full-Term Pregnancy", note: "Baby is considered full-term and ready anytime.", icon: "twemoji:baby", done: false },
  { week: "Week 40", title: "Expected Delivery", note: "Expected arrival soon!", icon: "twemoji:wrapped-gift", done: false },
];

const patientSelectColumns =
  "id, full_name, patient_id, date_of_birth, age, contact_number, email, address, status, expected_delivery_date, gestational_age, blood_type, risk_level, created_at";

function isActivePatientRow(row) {
  const status = String(row?.status || "").trim().toLowerCase();

  return !["inactive", "deleted", "archived"].includes(status);
}

function getPatientInitials(name) {
  const parts = String(name || "Patient").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "PT";

  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function formatPatientDate(value, fallback = "-") {
  if (!value) return fallback;
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "2-digit",
    year: "numeric",
  });
}

function formatPatientShortDate(value) {
  if (!value) return "-";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatAgeLabel(age) {
  const cleanAge = String(age || "").replace(/[^\d]/g, "");
  return cleanAge ? `Female - ${cleanAge} years old` : "Female";
}

function formatGestationalProgress(gestationalAge) {
  const weeks = Number(String(gestationalAge || "").match(/\d+/)?.[0]);
  return Number.isFinite(weeks) && weeks > 0 ? `${weeks} of 40 weeks` : "-";
}

function mapSupabasePatient(row) {
  const visibleId = row.patient_id || String(row.id || "").slice(0, 8) || "-";
  const birthdate = formatPatientDate(row.date_of_birth);
  const deliveryDate = formatPatientDate(row.expected_delivery_date);

  return {
    recordId: row.id,
    initials: getPatientInitials(row.full_name),
    avatarClass: "patient-avatar-pink",
    photo: "",
    name: row.full_name || "Unnamed Patient",
    patientId: visibleId,
    id: `Patient ID: ${visibleId}`,
    sexAge: formatAgeLabel(row.age),
    dateOfBirth: birthdate,
    birthdate,
    contact: row.contact_number || "-",
    email: row.email || "-",
    address: row.address || "-",
    bloodType: row.blood_type || "-",
    maritalStatus: "-",
    status: row.status || "Active Patient",
    pregnancyNo: "-",
    gestationalAge: row.gestational_age || "-",
    deliveryDate,
    shortDeliveryDate: formatPatientShortDate(row.expected_delivery_date),
    riskLevel: row.risk_level || "-",
    progressWeeks: formatGestationalProgress(row.gestational_age),
    lastVisitDate: "-",
    lastVisitDoctor: "Dr. Kempee Vergara",
  };
}

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function ProfileMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const [profile, setProfile] = useState(getStoredDoctorMenuProfile);
  const profileRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handleClickOutside = (event) => {
      if (profileRef.current && !profileRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    const handleEscape = (event) => {
      if (event.key === "Escape") setIsOpen(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  useEffect(() => {
    let active = true;

    const syncProfile = async () => {
      const nextProfile = await loadDoctorMenuProfile();

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

  const goToDoctorSection = (section) => {
    setIsOpen(false);
    window.dispatchEvent(new CustomEvent("doctor:navigate", { detail: { section } }));
    window.localStorage.setItem("doctor_active_section", section);
  };

  return (
    <div className={`doctor-patients-profile-wrap ${isOpen ? "is-open" : ""}`} ref={profileRef}>
      <button
        className="doctor-patients-profile"
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className="doctor-patients-profile-avatar">
          <img src={doctorPhoto} alt="" />
        </span>

        <span className="doctor-patients-profile-info">
          <strong>{profile.displayName}</strong>
          <small>{profile.roleLabel}</small>
        </span>

        <Icon icon={isOpen ? "ri:arrow-drop-up-line" : "ri:arrow-drop-down-line"} />
      </button>

      {isOpen ? (
        <div className="doctor-patients-profile-dropdown" role="menu">
          <div className="doctor-patients-profile-dropdown__header">
            <span className="doctor-patients-profile-dropdown__avatar">
              <img src={doctorPhoto} alt="" />
            </span>
            <span>
              <strong>{profile.displayName}</strong>
              <small>{profile.roleLabel} Account</small>
            </span>
          </div>

          <div className="doctor-patients-profile-dropdown__divider" />

          <button type="button" role="menuitem" onClick={() => goToDoctorSection("profile")}>
            <Icon icon="solar:user-linear" />
            View Profile
          </button>
          <button type="button" role="menuitem" onClick={() => goToDoctorSection("settings")}>
            <Icon icon="solar:settings-linear" />
            Settings
          </button>
          <button className="is-danger" type="button" role="menuitem" onClick={() => goToDoctorSection("logout")}>
            <Icon icon="solar:logout-2-linear" />
            Logout
          </button>
        </div>
      ) : null}
    </div>
  );
}

function PatientAvatar({ patient, large = false }) {
  return (
    <span className={`doctor-patient-avatar ${patient.avatarClass} ${large ? "doctor-patient-avatar-large" : ""}`}>
      {patient.photo ? <img src={patient.photo} alt={patient.name} /> : patient.initials}
    </span>
  );
}

function PatientListPage({ patients, searchTerm, setSearchTerm, onViewRecord, statusMessage }) {
  const filteredPatients = useMemo(() => {
    const value = searchTerm.trim().toLowerCase();
    if (!value) return patients;

    return patients.filter((patient) =>
      [patient.name, patient.patientId, patient.sexAge, patient.dateOfBirth]
        .join(" ")
        .toLowerCase()
        .includes(value)
    );
  }, [patients, searchTerm]);

  return (
    <section className="doctor-patients-list-page">
      <header className="doctor-patients-header">
        <div>
          <h2>Patients</h2>
          <p>Manage and view patient information across your practice.</p>
        </div>
        <ProfileMenu />
      </header>

      <label className="doctor-patients-search-wrap">
        <Icon icon="solar:magnifer-linear" />
        <input
          type="text"
          placeholder="Search by name or ID"
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
        />
      </label>

      {statusMessage ? (
        <p className="doctor-patients-status-message">{statusMessage}</p>
      ) : null}

      <div className="doctor-patients-table-card">
        <div className="doctor-patients-table-scroll">
          <table className="doctor-patients-table">
            <thead>
              <tr>
                <th>Name <Icon icon="solar:sort-vertical-linear" /></th>
                <th>Patient ID <Icon icon="solar:sort-vertical-linear" /></th>
                <th>Date of Birth <Icon icon="solar:sort-vertical-linear" /></th>
                <th>Medical Records</th>
              </tr>
            </thead>

            <tbody>
              {filteredPatients.map((patient) => (
                <tr key={patient.patientId}>
                  <td>
                    <div className="doctor-patient-info-cell">
                      <PatientAvatar patient={patient} />
                      <span>
                        <strong>{patient.name}</strong>
                        <small>{patient.sexAge}</small>
                      </span>
                    </div>
                  </td>
                  <td>{patient.patientId}</td>
                  <td>{patient.dateOfBirth}</td>
                  <td>
                    <button className="doctor-patient-view-btn" type="button" onClick={() => onViewRecord(patient.patientId)}>
                      View
                    </button>
                  </td>
                </tr>
              ))}

              {!filteredPatients.length ? (
                <tr>
                  <td colSpan="4" className="doctor-patients-empty-cell">No patient found.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function MedicalHeader({ activeTab, onBack, onEdit }) {
  return (
    <header className="medical-record-header">
      <div className="medical-record-heading-copy">
        <button className="medical-record-back" type="button" onClick={onBack}>
          <Icon icon="solar:arrow-left-linear" />
          Back to patients
        </button>
        <h2>Medical Record</h2>
        <p>View and manage patient medical information</p>
      </div>

      {activeTab === "Overview" ? (
        <div className="medical-record-header-actions medical-record-header-actions--edit-only">
          <button className="medical-record-edit-btn" type="button" onClick={onEdit}>
            <Icon icon="solar:pen-new-square-linear" />
            Edit Record
          </button>
        </div>
      ) : null}
    </header>
  );
}

function PatientSummary({ patient }) {
  const details = [
    { icon: "solar:calendar-linear", label: "Birthdate", value: patient.birthdate },
    { icon: "solar:map-point-linear", label: "Address", value: patient.address },
    { icon: "solar:phone-linear", label: "Contact Number", value: patient.contact },
    { icon: "healthicons:blood-drop-outline", label: "Blood Type", value: patient.bloodType },
    { icon: "solar:letter-linear", label: "Email", value: patient.email },
    { icon: "solar:heart-linear", label: "Marital Status", value: patient.maritalStatus },
  ];

  return (
    <div className="medical-record-main-grid">
      <section className="medical-record-patient-card">
        <PatientAvatar patient={patient} large />

        <div className="medical-record-patient-copy">
          <div className="medical-record-name-row">
            <h3>{patient.name}</h3>
            <span>{patient.status}</span>
          </div>
          <p>{patient.id}</p>

          <div className="medical-record-info-grid">
            {details.map((item) => (
              <article key={item.label}>
                <Icon icon={item.icon} />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.value}</small>
                </span>
              </article>
            ))}
          </div>
        </div>
      </section>

      <aside className="medical-record-pregnancy-card">
        <h3>Current Pregnancy</h3>
        <dl>
          <div>
            <dt>Pregnancy number</dt>
            <dd>{patient.pregnancyNo}</dd>
          </div>
          <div>
            <dt>Gestational Age</dt>
            <dd>{patient.gestationalAge}</dd>
          </div>
          <div>
            <dt>Expected Delivery Date</dt>
            <dd>{patient.deliveryDate}</dd>
          </div>
          <div>
            <dt>Risk Level</dt>
            <dd><span>{patient.riskLevel}</span></dd>
          </div>
        </dl>
      </aside>
    </div>
  );
}

function TabBar({ activeTab, setActiveTab }) {
  return (
    <nav className="medical-record-tab-bar" aria-label="Medical record sections">
      {recordTabs.map((tab) => (
        <button
          key={tab}
          type="button"
          className={activeTab === tab ? "is-active" : ""}
          onClick={() => setActiveTab(tab)}
        >
          {tab}
        </button>
      ))}
    </nav>
  );
}

function PinkTable({ headers, rows, className = "" }) {
  return (
    <div className={`medical-pink-table-wrap ${className}`}>
      <table className="medical-pink-table">
        <thead>
          <tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${rowIndex}-${row.join("-")}`}>
              {row.map((cell, cellIndex) => <td key={`${cellIndex}-${cell}`}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ status }) {
  const normalized = status.toLowerCase().replace(/[^a-z]/g, "-") || "empty";
  return <span className={`medical-status-pill is-${normalized}`}>{status}</span>;
}

function SearchBar({ value, onChange, placeholder, className = "" }) {
  return (
    <label className={`medical-record-section-search ${className}`}>
      <Icon icon="solar:magnifer-linear" />
      <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function OverviewPanel({ patient, onTabChange }) {
  return (
    <div className="medical-record-lower-grid">
      <main className="medical-record-left-stack">
        <section className="medical-record-progress-card">
          <div className="medical-record-card-title-row">
            <h3>Pregnancy Progress</h3>
            <span>{patient.progressWeeks}</span>
          </div>

          <div className="medical-record-progress"><span style={{ width: "70%" }} /></div>

          <div className="medical-record-progress-labels">
            <span>Conception</span>
            <span>Trimester 3</span>
            <span>Full Term</span>
          </div>

          <div className="medical-record-metric-grid">
            {pregnancyMetrics.map((metric) => (
              <article className={`medical-record-metric is-${metric.tone}`} key={metric.title}>
                <Icon icon={metric.icon} />
                <strong>{metric.title}</strong>
                <p>{metric.value}{metric.unit ? <small> {metric.unit}</small> : null}</p>
                <span>{metric.date}</span>
              </article>
            ))}
          </div>
        </section>

        <div className="medical-record-two-column">
          <section className="medical-record-simple-card">
            <div className="medical-record-mini-heading">
              <span><Icon icon="solar:clipboard-heart-linear" /></span>
              <h3>Vital Signs<small>(Latest)</small></h3>
            </div>

            <div className="medical-record-vital-list">
              {vitalSigns.map((item) => (
                <article key={item.label}>
                  <span>{item.label}</span>
                  <strong>{item.value}<small> {item.unit}</small></strong>
                </article>
              ))}
            </div>

            <button className="medical-record-outline-btn" type="button" onClick={() => onTabChange("Medical Record")}>
              View All Vital Signs
            </button>
          </section>

          <section className="medical-record-simple-card">
            <div className="medical-record-mini-heading medical-record-mini-heading-schedule">
              <span><Icon icon="solar:calendar-mark-linear" /></span>
              <h3>Next Schedule</h3>
              <button type="button" onClick={() => onTabChange("Appointments")}>View All</button>
            </div>

            <div className="medical-record-next-card">
              <mark>Upcoming</mark>
              <h4>Next Prenatal Visit</h4>
              <p><Icon icon="solar:calendar-linear" />June 1, 2026</p>
              <p><Icon icon="solar:clock-circle-linear" />9:00 AM</p>
              <div>
                <button type="button">Confirm</button>
                <button type="button">Reschedule</button>
              </div>
            </div>
          </section>
        </div>
      </main>

      <aside className="medical-record-right-stack">
        <section className="medical-record-side-card">
          <div className="medical-record-mini-heading">
            <span><Icon icon="solar:history-2-linear" /></span>
            <h3>Last Visit</h3>
          </div>

          <div className="medical-record-detail-list">
            <article><span>Date:</span><strong>{patient.lastVisitDate}</strong></article>
            <article><span>Doctor:</span><strong>{patient.lastVisitDoctor}</strong></article>
          </div>

          <h4>Assessment:</h4>
          <p className="medical-record-note-box">Health Pregnancy Progression. Patient reports normal fetal activity and minimal discomfort.</p>

          <button className="medical-record-outline-btn" type="button" onClick={() => onTabChange("Medical Record")}>
            View Full Record
          </button>
        </section>

        <section className="medical-record-side-card medical-record-notes-card">
          <div className="medical-record-mini-heading">
            <span><Icon icon="solar:notes-linear" /></span>
            <h3>Notes</h3>
          </div>

          <div className="medical-record-note-section">
            <strong>Chief Complaint</strong>
            <p>Routine prenatal check-up</p>
          </div>
          <div className="medical-record-note-section">
            <strong>Assessment</strong>
            <p>Pregnancy progressing normally. No significant concerns found during current screening.</p>
          </div>
          <div className="medical-record-note-section">
            <strong>Plan</strong>
            <ul>
              <li>Continue prenatal vitamins</li>
              <li>Monitor fetal movement</li>
              <li>Return after 2 weeks</li>
            </ul>
          </div>
          <footer>Last Updated: April 19, 2024</footer>
        </section>
      </aside>
    </div>
  );
}

function PrenatalHistoryPanel() {
  const [conditions, setConditions] = useState(() => [
    { label: "Hypertension", checked: true },
    { label: "Anemia", checked: true },
    { label: "Diabetes", checked: false },
    { label: "Heart Disease", checked: false },
    { label: "Asthma", checked: false },
    { label: "Thyroid Disorder", checked: false },
    { label: "Kidney Disease", checked: false },
    { label: "Tuberculosis", checked: false },
  ]);

  const toggleCondition = (label) => {
    setConditions((currentConditions) =>
      currentConditions.map((condition) =>
        condition.label === label
          ? { ...condition, checked: !condition.checked }
          : condition
      )
    );
  };

  return (
    <div className="prenatal-history-panel">
      <section className="prenatal-section-card prenatal-section-card-full prenatal-obstetric-card">
        <h3>1. Obstetric History</h3>

        <div className="obstetric-summary-grid">
          {[
            ["Gravida", "2"],
            ["Para", "1"],
            ["Abortion/Miscarriage", "0"],
            ["Living Children", "1"],
            ["Multiple Pregnancy", "No"],
          ].map(([label, value]) => (
            <article key={label}>
              <strong>{label}</strong>
              <span>{value}</span>
            </article>
          ))}
        </div>

        <h4>Pregnancy History</h4>

        <PinkTable
          className="pregnancy-history-table"
          headers={["Pregnancy Number", "Year", "Outcome", "Delivery Type", "Birth weight", "Complications"]}
          rows={[
            ["1", "2022", "Full Term", "Normal", "3.1kg", "None"],
            ["2", "Current", "On going", "-", "-", "-"],
          ]}
        />
      </section>

      <section className="prenatal-section-card prenatal-section-card-full prenatal-current-card">
        <h3>2. Current Pregnancy Information</h3>

        <div className="prenatal-info-grid">
          <article>
            <strong>Last Menstrual Period</strong>
            <span>March 10, 2025</span>
          </article>
          <article>
            <strong>Pregnancy Number</strong>
            <span>Second Pregnancy</span>
          </article>
          <article>
            <strong>Expected Delivery Date</strong>
            <span>December 15, 2026</span>
          </article>
          <article>
            <strong>Risk Classification</strong>
            <span className="prenatal-risk-badge">Low Risk</span>
          </article>
          <article>
            <strong>Gestational Age</strong>
            <span>28 Weeks</span>
          </article>
        </div>
      </section>

      <div className="prenatal-two-column">
        <section className="prenatal-section-card prenatal-conditions-card">
          <h3>3. Maternal Medical Conditions</h3>

          <div className="prenatal-checkbox-grid">
            {conditions.map((condition) => (
              <label key={condition.label}>
                <input
                  type="checkbox"
                  checked={condition.checked}
                  onChange={() => toggleCondition(condition.label)}
                />
                <span>{condition.label}</span>
              </label>
            ))}
          </div>
        </section>

        <section className="prenatal-section-card prenatal-family-card">
          <h3>4. Family Medical History</h3>

          <PinkTable
            className="family-medical-table"
            headers={["Condition", "Mother", "Father"]}
            rows={[
              ["Hypertension", "Yes", "No"],
              ["Diabetes", "Yes", "No"],
              ["Heart Disease", "Yes", "No"],
              ["Genetic Disorder", "Yes", "No"],
            ]}
          />
        </section>
      </div>

      <div className="prenatal-two-column">
        <section className="prenatal-section-card prenatal-allergies-card">
          <h3>5. Allergies</h3>

          <PinkTable
            className="allergy-table"
            headers={["Type", "Allergen", "Reaction"]}
            rows={[
              ["Medication", "Penicillin", "Skin Rash"],
              ["Food", "Seafood", "Mild Allergy"],
              ["Environmental", "Dust", "Sneezing"],
            ]}
          />
        </section>

        <section className="prenatal-section-card prenatal-lifestyle-card">
          <h3>6. Lifestyle Assessment</h3>

          <div className="prenatal-lifestyle-grid">
            <article>
              <strong>Smoker</strong>
              <span>No</span>
            </article>
            <article>
              <strong>Occupation</strong>
              <span>Teacher</span>
            </article>
            <article>
              <strong>Alcohol Use</strong>
              <span>No</span>
            </article>
            <article>
              <strong>Physical Activity</strong>
              <span>Moderate</span>
            </article>
            <article>
              <strong>Drug Use</strong>
              <span>No</span>
            </article>
            <article>
              <strong>Diet</strong>
              <span>Balanced</span>
            </article>
          </div>
        </section>
      </div>

      <section className="prenatal-section-card prenatal-section-card-full prenatal-immunization-card">
        <h3>7. Immunization During Pregnancy</h3>

        <PinkTable
          className="immunization-table"
          headers={["Vaccine", "Date Given"]}
          rows={[
            ["Influenza Vaccine", "June 1, 2025"],
            ["Tetanus Toxoid 2", "May 1, 2025"],
            ["Tetanus Toxoid 1", "April 1, 2025"],
          ]}
        />
      </section>

      <section className="prenatal-section-card prenatal-section-card-full prenatal-visit-card">
        <h3>8. Prenatal Visit History</h3>

        <PinkTable
          className="prenatal-visit-table"
          headers={["Date", "Gestational Age", "Weight", "Blood Pressure", "Fetal Heart Rate", "Notes"]}
          rows={[
            ["04-01-2025", "12 Weeks", "60 kg", "120/80 mm-Hg", "145 bpm", "Initial prenatal Check up"],
            ["05-01-2025", "20 Weeks", "63 kg", "118/78 mm-Hg", "148 bpm", "Prenatal Check up"],
          ]}
        />
      </section>
    </div>
  );
}

function AppointmentsPanel() {
  const historyRef = useRef(null);
  const [showAllTimeline, setShowAllTimeline] = useState(false);
  const [activeHistoryFilter, setActiveHistoryFilter] = useState("All");

  const appointmentStats = [
    {
      icon: "solar:calendar-bold",
      label: "Total Visits",
      value: "8",
      meta: "All time",
      tone: "blue",
      filter: "All",
    },
    {
      icon: "solar:check-circle-bold",
      label: "Completed",
      value: "3",
      meta: "25%",
      tone: "pink",
      filter: "Completed",
    },
    {
      icon: "solar:clock-circle-bold",
      label: "Upcoming",
      value: "5",
      meta: "75%",
      tone: "orange",
      filter: "Upcoming",
    },
    {
      icon: "solar:close-circle-bold",
      label: "Missed / Cancelled",
      value: "0",
      meta: "0%",
      tone: "green",
      filter: "Missed",
    },
    {
      icon: "solar:chart-square-bold",
      label: "Attendance Rate",
      value: "100",
      meta: "100%",
      tone: "blue",
      filter: "All",
    },
  ];

  const fullTimeline = [
    ...appointmentTimeline,
    { week: "Week 28", title: "Growth Monitoring", date: "June 1, 2026", status: "Upcoming" },
    { week: "Week 32", title: "Routine Prenatal Visit", date: "July 1, 2026", status: "Upcoming" },
  ];

  const timelineToShow = showAllTimeline ? fullTimeline : appointmentTimeline;
  const filteredAppointments = appointments.filter((item) => {
    if (activeHistoryFilter === "All") return true;
    if (activeHistoryFilter === "Missed") return item.status === "Missed" || item.status === "Cancelled";
    return item.status === activeHistoryFilter;
  });

  const scrollToHistory = (filter = "All") => {
    setActiveHistoryFilter(filter);
    window.requestAnimationFrame(() => {
      historyRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <div className="appointments-panel">
      <div className="appointments-stat-grid" aria-label="Appointment summary">
        {appointmentStats.map((stat) => (
          <button
            className={`appointment-stat-card is-${stat.tone} ${activeHistoryFilter === stat.filter ? "is-active" : ""}`}
            key={stat.label}
            type="button"
            onClick={() => scrollToHistory(stat.filter)}
          >
            <span><Icon icon={stat.icon} /></span>
            <strong>{stat.label}</strong>
            <b>{stat.value}</b>
            <small>{stat.meta}</small>
          </button>
        ))}
      </div>

      <div className="appointments-mid-grid">
        <section className="appointments-card upcoming-appointment-card">
          <header>
            <h3>Upcoming Appointments</h3>
            <button type="button" onClick={() => scrollToHistory("Upcoming")}>View All</button>
          </header>

          <article className="next-appointment-tile">
            <span><Icon icon="solar:calendar-linear" /></span>
            <div>
              <h4>Next Prenatal Visit</h4>
              <p>June 1, 2026 (Monday)</p>
              <p>Dr. Kempee Vergara</p>
              <strong><Icon icon="solar:clock-circle-linear" />9:00 AM</strong>
            </div>
          </article>
        </section>

        <section className="appointments-card timeline-card">
          <header>
            <h3>Prenatal Appointment Timeline</h3>
            <button type="button" onClick={() => setShowAllTimeline((current) => !current)}>
              {showAllTimeline ? "Show Less" : "View All"}
            </button>
          </header>

          <div className="appointment-timeline">
            {timelineToShow.map((item) => (
              <article key={`${item.week}-${item.title}`}>
                <span><Icon icon={item.status === "Completed" ? "solar:check-circle-bold" : "solar:clock-circle-bold"} /></span>
                <div>
                  <h4>{item.week}</h4>
                  <p>{item.title}</p>
                  <small>{item.date}</small>
                </div>
                <StatusPill status={item.status} />
              </article>
            ))}
          </div>
        </section>
      </div>

      <section className="appointments-card appointment-history-card" ref={historyRef}>
        <div className="appointment-history-heading-row">
          <h3>Appointment History</h3>
          {activeHistoryFilter !== "All" ? (
            <button type="button" onClick={() => setActiveHistoryFilter("All")}>Show All</button>
          ) : null}
        </div>

        <div className="appointment-history-table-wrap">
          <table className="appointment-history-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Time</th>
                <th>Gestational Age</th>
                <th>Doctor</th>
                <th>Purpose</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredAppointments.map((item) => (
                <tr key={`${item.date}-${item.purpose}`}>
                  <td><span className="appointment-date-stack">{item.date}</span></td>
                  <td><span className="appointment-time-stack">9:00<br />AM</span></td>
                  <td>{item.gestationalAge}</td>
                  <td>{item.doctor}</td>
                  <td>{item.purpose}</td>
                  <td><StatusPill status={item.status} /></td>
                </tr>
              ))}

              {!filteredAppointments.length ? (
                <tr>
                  <td colSpan="6" className="appointment-history-empty">No appointments found.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function MedicalRecordPanel() {
  const [query, setQuery] = useState("");
  const [activeRecordIndex, setActiveRecordIndex] = useState(0);

  const filteredRecords = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return medicalRecords;

    return medicalRecords.filter((record) => {
      return (
        record.date.toLowerCase().includes(value) ||
        record.visitType.toLowerCase().includes(value) ||
        record.doctor.toLowerCase().includes(value) ||
        record.chiefComplaint.toLowerCase().includes(value) ||
        record.diagnosis.toLowerCase().includes(value)
      );
    });
  }, [query]);

  const record = filteredRecords[activeRecordIndex] || filteredRecords[0] || medicalRecords[0];
  const nextRecord = filteredRecords[(activeRecordIndex + 1) % Math.max(filteredRecords.length, 1)] || medicalRecords[1];

  const selectedDetails = record.id === "mr-002"
    ? {
        bloodPressure: "118/78",
        weight: "63",
        temp: "36.5",
        heartRate: "148",
        height: "160",
        bmi: "24.6",
        gravidaPara: "G2 / P1",
        lmp: "March 13, 2025",
        pregnancyType: "Singleton Pregnancy",
        deliveryDate: "December 15, 2026",
        assessment: [
          "Pregnancy progressing normally.",
          "Fetal movement is active and reassuring.",
          "No significant concern found during screening.",
          "Continue routine prenatal monitoring.",
        ],
        treatment: [
          "Continue prenatal vitamins and hydration plan.",
          "Monitor fetal movement daily and report unusual changes.",
          "Return after 2 weeks for routine follow-up.",
        ],
      }
    : {
        bloodPressure: "120/80",
        weight: "65",
        temp: "36.7",
        heartRate: "148",
        height: "160",
        bmi: "25.4",
        gravidaPara: "G2 / P1",
        lmp: "March 13, 2025",
        pregnancyType: "Singleton Pregnancy",
        deliveryDate: "December 15, 2026",
        assessment: [
          "Confirmed intrauterine pregnancy.",
          "First prenatal visit completed.",
          "No vaginal bleeding or abdominal pain.",
          "Patient reports mild nausea and occasional fatigue.",
        ],
        treatment: [
          "Start Folic Acid 400 mcg daily and Prenatal Vitamins.",
          "Request baseline laboratory tests (CBC, Urinalysis, Blood Typing, Hepatitis B, HIV).",
          "Follow-up in 4 weeks for routine assessment.",
        ],
      };

  const currentRecordPosition = Math.max(1, medicalRecords.findIndex((item) => item.id === record.id) + 1);

  return (
    <div className="medical-record-detail-panel">
      <SearchBar value={query} onChange={setQuery} placeholder="Search medical records..." />

      <section className="medical-record-document-card">
        <aside className="medical-record-visit-column">
          <h3><Icon icon="solar:calendar-linear" />{record.date}</h3>
          <p>{record.dayTime}</p>

          <div className="visit-meta-list">
            <article>
              <span><Icon icon="solar:camera-linear" /></span>
              <div>
                <small>Visit Type</small>
                <strong>{record.visitType}</strong>
              </div>
            </article>
            <article>
              <span><Icon icon="solar:clock-circle-linear" /></span>
              <div>
                <small>Gestational Age</small>
                <strong>{record.gestationalAge}</strong>
              </div>
            </article>
            <article>
              <span><Icon icon="solar:user-linear" /></span>
              <div>
                <small>Doctor</small>
                <strong>{record.doctor}</strong>
              </div>
            </article>
          </div>
        </aside>

        <main className="medical-record-document-body">
          <section className="record-chief-section">
            <h4><i />Chief Complaint</h4>
            <p>{record.chiefComplaint}</p>
          </section>

          <section className="record-findings-section">
            <h4><i />Clinical Findings</h4>
            <div className="clinical-findings-grid">
              {[
                ["Blood Pressure", selectedDetails.bloodPressure, "mmHg"],
                ["Weight", selectedDetails.weight, "kg"],
                ["Temp", selectedDetails.temp, "°C"],
                ["Heart Rate", selectedDetails.heartRate, "bpm"],
                ["Height", selectedDetails.height, "cm"],
                ["BMI", selectedDetails.bmi, "kg/m²"],
              ].map(([label, value, unit]) => (
                <article key={label}>
                  <small>{label}</small>
                  <strong>{value}</strong>
                  <span>{unit}</span>
                </article>
              ))}
            </div>
          </section>

          <section className="record-assessment-section">
            <h4><i />Assessment</h4>
            <ul className="check-list">
              {selectedDetails.assessment.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>

          <div className="medical-record-document-split">
            <section className="obstetric-document-section">
              <h4>Obstetric Information</h4>
              <div className="obstetric-info-cards">
                <article><small>Gravida / Para</small><strong>{selectedDetails.gravidaPara}</strong></article>
                <article><small>Last Menstrual Period</small><strong>{selectedDetails.lmp}</strong></article>
                <article><small>Pregnancy Type</small><strong>{selectedDetails.pregnancyType}</strong></article>
                <article><small>Expected Delivery Date</small><strong>{selectedDetails.deliveryDate}</strong></article>
              </div>

              <h4>Diagnosis</h4>
              <p className="diagnosis-box">{record.diagnosis}</p>
            </section>

            <section className="treatment-document-section">
              <h4>Plan / Treatment</h4>
              <ul className="pink-bullet-list">
                {selectedDetails.treatment.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>

              <h4>Attachments (1)</h4>
              <button
                className="medical-attachment-card"
                type="button"
                onClick={() => downloadTextFile(record.attachment, "Pregnancy confirmation report placeholder")}
              >
                <span><Icon icon="solar:file-text-bold" /></span>
                <strong>{record.attachment}<small>PDF • 312KB</small></strong>
                <Icon icon="solar:download-linear" />
              </button>
            </section>
          </div>
        </main>
      </section>

      <button
        className="medical-record-detail-footer"
        type="button"
        onClick={() => setActiveRecordIndex((current) => (current + 1) % Math.max(filteredRecords.length, 1))}
        aria-label="Show the next medical record"
      >
        <span><Icon icon="solar:calendar-linear" />{nextRecord?.date || "May 1, 2025"}</span>
        <span>{nextRecord?.dayTime || "Thursday • 9:00 AM"}</span>
        <span>Showing {currentRecordPosition} to {filteredRecords.length || medicalRecords.length} of {medicalRecords.length} medical records</span>
        <span>Show full medical record for this visit <Icon icon="solar:alt-arrow-down-linear" /></span>
      </button>
    </div>
  );
}

function DiagnosticResultsPanel() {
  const [query, setQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState("All");

  const filtered = diagnosticResults.filter((item) => {
    const matchesSearch = [item.test, item.subtitle, item.orderedBy, item.file]
      .join(" ")
      .toLowerCase()
      .includes(query.toLowerCase());
    const matchesStatus =
      statusFilter === "All" ||
      (statusFilter === "Normal" && item.status === "Normal") ||
      (statusFilter === "Pending" && item.status === "-");

    return matchesSearch && matchesStatus;
  });

  const filterOptions = ["All", "Normal", "Pending"];

  return (
    <section className="diagnostic-results-panel diagnostic-results-redesign">
      <div className="diagnostic-results-card-shell">
        <div className="diagnostic-toolbar diagnostic-toolbar-redesign">
          <SearchBar value={query} onChange={setQuery} placeholder="Search Laboratory Results..." />

          <div className="diagnostic-filter-wrap">
            <button
              type="button"
              className={`filter-btn ${filterOpen ? "is-open" : ""}`}
              onClick={() => setFilterOpen((current) => !current)}
              aria-expanded={filterOpen}
              aria-haspopup="menu"
            >
              <Icon icon="solar:filter-bold" />
              Filter
            </button>

            {filterOpen ? (
              <div className="diagnostic-filter-menu" role="menu">
                {filterOptions.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={statusFilter === option ? "is-active" : ""}
                    onClick={() => {
                      setStatusFilter(option);
                      setFilterOpen(false);
                    }}
                  >
                    {option}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="diagnostic-table-card diagnostic-table-card-redesign">
          <div className="diagnostic-table-scroll">
            <table className="diagnostic-redesign-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Test</th>
                  <th>Status</th>
                  <th>Ordered By</th>
                  <th>Actions</th>
                </tr>
              </thead>

              <tbody>
                {filtered.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong className="diagnostic-date-main">{item.date}</strong>
                      <span className="diagnostic-date-sub">({item.gpa})</span>
                    </td>
                    <td>
                      <strong className="diagnostic-test-main">{item.test}</strong>
                      <span className="diagnostic-test-sub">{item.subtitle}</span>
                    </td>
                    <td>
                      <StatusPill status={item.status} />
                    </td>
                    <td>
                      <span className="diagnostic-doctor-name">{item.orderedBy}</span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="diagnostic-file-chip"
                        onClick={() => downloadTextFile(item.file, `${item.test}\n${item.subtitle}\nOrdered by: ${item.orderedBy}`)}
                      >
                        <span className="diagnostic-file-icon"><Icon icon="solar:file-text-bold" /></span>
                        <strong>{item.file}<small>{item.size}</small></strong>
                        <Icon icon="solar:download-linear" />
                      </button>
                    </td>
                  </tr>
                ))}

                {!filtered.length ? (
                  <tr>
                    <td colSpan="5" className="diagnostic-empty-cell">No diagnostic result found.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <p>Showing 1 to {filtered.length} of {diagnosticResults.length} Diagnostic results</p>
        </div>
      </div>
    </section>
  );
}

function PrescriptionsPanel() {
  const [query, setQuery] = useState("");
  const filtered = prescriptions.filter((item) =>
    [item.title, item.doctor, item.file, item.instructions]
      .join(" ")
      .toLowerCase()
      .includes(query.toLowerCase())
  );

  return (
    <section className="prescriptions-panel prescriptions-redesign-panel">
      <SearchBar value={query} onChange={setQuery} placeholder="Search Prescriptions..." />

      {filtered.map((prescription) => (
        <article className="prescription-card prescription-card-redesign" key={prescription.title}>
          <header>
            <div>
              <span><Icon icon="solar:clipboard-heart-bold" /></span>
              <h3>{prescription.title}<small>{prescription.doctor}</small></h3>
            </div>
            <time><Icon icon="solar:calendar-linear" />{prescription.date}</time>
          </header>

          <div className="prescription-table-scroll">
            <table className="prescription-medication-table">
              <thead>
                <tr>
                  <th>Medication</th>
                  <th>Dosage</th>
                  <th>Frequency</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {prescription.medications.map((item) => (
                  <tr key={item.medication}>
                    <td>{item.medication}</td>
                    <td>{item.dosage}</td>
                    <td>{item.frequency}</td>
                    <td>{item.duration}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <section className="prescription-instructions">
            <strong>Instructions</strong>
            <p>"{prescription.instructions}"</p>
          </section>

          <footer>
            <button
              className="prescription-file"
              type="button"
              onClick={() => downloadTextFile(prescription.file, prescription.instructions)}
            >
              <span><Icon icon="solar:document-text-bold" /></span>
              <strong>{prescription.file}<small>{prescription.size}</small></strong>
            </button>
            <button
              className="download-outline-btn"
              type="button"
              onClick={() => downloadTextFile(prescription.file, prescription.instructions)}
            >
              <Icon icon="solar:download-linear" />Download
            </button>
          </footer>
        </article>
      ))}

      {!filtered.length ? <p className="empty-panel-note">No prescription found.</p> : null}
    </section>
  );
}

function PregnancyTrackingPanel({ patient }) {
  const journeyEmoji = {
    "Week 8": "🌱",
    "Week 10": "💗",
    "Week 12": "🌼",
    "Week 18": "👣",
    "Week 20": "🧠",
    "Week 28": "🧺",
    "Week 34": "🫁",
    "Week 37": "👶",
    "Week 40": "🎁",
  };

  return (
    <section className="pregnancy-tracking-panel pregnancy-tracking-redesign">
      <article className="pregnancy-hero-card pregnancy-hero-redesign-card">
        <div className="pregnancy-ring" aria-label="Week 28 of 40 pregnancy progress">
          <div>
            <span>Week</span>
            <strong>28</strong>
            <small>of 40</small>
          </div>
        </div>

        <div className="pregnancy-hero-copy">
          <span>Current Pregnancy Progress</span>
          <h3>The Patient is in her 3rd Trimester</h3>
          <p>12 weeks to go!</p>
          <div className="pregnancy-hero-progress"><span /></div>
          <div className="pregnancy-hero-chips">
            <article>
              <Icon icon="solar:calendar-bold" />
              <span>Expected Delivery Date<strong>{patient.deliveryDate}</strong></span>
            </article>
            <article>
              <Icon icon="solar:shield-check-bold" />
              <span>Pregnancy Status<strong>Low Risk</strong></span>
            </article>
          </div>
        </div>

        <img className="pregnancy-illustration" src={pregnancyIllustration} alt="Pregnancy illustration" />
      </article>

      <div className="pregnancy-two-grid pregnancy-two-grid-redesign">
        <article className="pregnancy-info-card baby-development-card">
          <header><h3>Baby Development</h3><Icon icon="solar:smile-circle-linear" /></header>
          <div className="baby-development-content">
            <div className="pregnancy-info-list">
              {[
                ["Estimated Weight", "1.1 kg"],
                ["Estimated Length", "48 cm"],
                ["Position", "Cephalic"],
                ["Fetal Heart Rate", "148 bpm"],
                ["Movement", "Active"],
              ].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
            </div>
            <img className="baby-scan-thumb" src={babyScanImage} alt="Baby ultrasound preview" />
          </div>
          <p><Icon icon="solar:heart-bold" />The baby is about the size of a large eggplant.</p>
        </article>

        <article className="pregnancy-info-card maternal-progress-card">
          <header><h3>Maternal Progress</h3><Icon icon="solar:clipboard-list-linear" /></header>
          <div className="pregnancy-info-list">
            {[
              ["Pre-pregnancy Weight", "58 kg"],
              ["Current Weight", "65 kg"],
              ["Total Weight Gain", "+7 kg"],
              ["BMI", "25.4 kg/m2"],
              ["Blood Pressure (Latest)", "120/80 mmHg"],
            ].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
          </div>
          <p><Icon icon="solar:info-circle-bold" />Weight gain is within the recommended healthy range.</p>
        </article>
      </div>

      <section className="pregnancy-journey-card pregnancy-journey-redesign-card">
        <h3>Pregnancy Journey</h3>
        <div className="pregnancy-journey-grid">
          {journeyMilestones.map((item) => (
            <article
              className={`${item.current ? "is-current" : ""} ${item.done ? "is-done" : ""}`}
              key={item.week}
              tabIndex="0"
            >
              <span className="journey-emoji" aria-hidden="true">{journeyEmoji[item.week] || "💗"}</span>
              <strong>{item.week}</strong>
              <span>{item.title}</span>
              <small>{item.note}</small>
              <b><Icon icon="solar:check-circle-bold" /></b>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}

function EditRecordModal({ patient, onClose, onSave }) {
  const [form, setForm] = useState(patient);

  const updateField = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  return (
    <div className="medical-record-modal-overlay" role="presentation">
      <section className="medical-record-edit-modal" role="dialog" aria-modal="true" aria-label="Edit medical record">
        <button className="medical-record-modal-close" type="button" onClick={onClose} aria-label="Close modal">
          <Icon icon="solar:close-circle-linear" />
        </button>
        <h3>Edit Patient Record</h3>

        <div className="medical-record-modal-grid">
          {[
            ["name", "Patient Name"],
            ["birthdate", "Birthdate"],
            ["contact", "Contact Number"],
            ["email", "Email"],
            ["address", "Address"],
            ["bloodType", "Blood Type"],
            ["maritalStatus", "Marital Status"],
            ["gestationalAge", "Gestational Age"],
            ["deliveryDate", "Expected Delivery Date"],
            ["riskLevel", "Risk Level"],
          ].map(([field, label]) => (
            <label key={field}>
              {label}
              <input value={form[field]} onChange={(event) => updateField(field, event.target.value)} />
            </label>
          ))}
        </div>

        <div className="medical-record-modal-actions">
          <button type="button" onClick={() => onSave(form)}>Save Changes</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </section>
    </div>
  );
}

function MedicalRecordPage({ patient, activeTab, setActiveTab, onBack, onEdit }) {
  const [medicalQuery, setMedicalQuery] = useState("");

  const renderPanel = () => {
    if (activeTab === "Prenatal History") return <PrenatalHistoryPanel />;
    if (activeTab === "Appointments") return <AppointmentsPanel />;
    if (activeTab === "Medical Record") return <MedicalRecordPanel query={medicalQuery} setQuery={setMedicalQuery} />;
    if (activeTab === "Diagnostic Results") return <DiagnosticResultsPanel />;
    if (activeTab === "Prescriptions") return <PrescriptionsPanel />;
    if (activeTab === "Pregnancy Tracking") return <PregnancyTrackingPanel patient={patient} />;
    return <OverviewPanel patient={patient} onTabChange={setActiveTab} />;
  };

  return (
    <section className="doctor-medical-record-page">
      <MedicalHeader activeTab={activeTab} onBack={onBack} onEdit={onEdit} />
      <PatientSummary patient={patient} />
      <TabBar activeTab={activeTab} setActiveTab={setActiveTab} />
      {renderPanel()}
    </section>
  );
}

function DoctorPatientsContent() {
  const [patients, setPatients] = useState([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedPatientId, setSelectedPatientId] = useState(null);
  const [activeTab, setActiveTab] = useState("Overview");
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Loading patients...");

  useEffect(() => {
    let active = true;

    const loadPatients = async () => {
      setStatusMessage("Loading patients...");

      const { data, error } = await supabase
        .from("patients")
        .select(patientSelectColumns)
        .order("created_at", { ascending: false });

      if (!active) return;

      if (error) {
        console.error("Load doctor patients failed:", error);
        setPatients([]);
        setStatusMessage(`Unable to load patients: ${error.message}`);
        return;
      }

      setPatients((data || []).filter(isActivePatientRow).map(mapSupabasePatient));
      setStatusMessage("");
    };

    loadPatients();

    const patientsChannel = supabase
      .channel("doctor-patients-list")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "patients" },
        loadPatients
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(patientsChannel);
    };
  }, []);

  const selectedPatient = patients.find((patient) => patient.patientId === selectedPatientId) || null;

  const handleViewRecord = (patientId) => {
    setSelectedPatientId(patientId);
    setActiveTab("Overview");
    setIsEditOpen(false);
    requestAnimationFrame(() => {
      document
        .querySelector(".doctor-medical-record-page, .doctor-patients-list-page")
        ?.scrollTo({ top: 0, behavior: "smooth" });
    });
  };

  const handleBack = () => {
    setSelectedPatientId(null);
    setIsEditOpen(false);
    setActiveTab("Overview");

    requestAnimationFrame(() => {
      document
        .querySelector(".doctor-medical-record-page, .doctor-patients-list-page")
        ?.scrollTo({ top: 0, behavior: "smooth" });
    });
  };

  const handleSave = (updatedPatient) => {
    setPatients((currentPatients) =>
      currentPatients.map((patient) =>
        patient.patientId === updatedPatient.patientId
          ? {
              ...updatedPatient,
              dateOfBirth: updatedPatient.birthdate,
              id: `Patient ID: ${updatedPatient.patientId}`,
            }
          : patient
      )
    );
    setIsEditOpen(false);
  };

  return (
    <section className="doctor-patients-page">
      {selectedPatient ? (
        <MedicalRecordPage
          patient={selectedPatient}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onBack={handleBack}
          onEdit={() => setIsEditOpen(true)}
        />
      ) : (
        <PatientListPage
          patients={patients}
          searchTerm={searchTerm}
          setSearchTerm={setSearchTerm}
          onViewRecord={handleViewRecord}
          statusMessage={statusMessage}
        />
      )}

      {isEditOpen && selectedPatient ? (
        <EditRecordModal patient={selectedPatient} onClose={() => setIsEditOpen(false)} onSave={handleSave} />
      ) : null}
    </section>
  );
}

export default DoctorPatientsContent;
