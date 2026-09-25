import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { useLocation } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import { useDoctorDelayedLoader } from "../../hooks/useDoctorDelayedLoader";
import "../../styles/doctor-patients.css";

const patientSelectColumns =
  "id, full_name, patient_id, date_of_birth, age, contact_number, email, address, status, expected_delivery_date, gestational_age, blood_type, risk_level, created_at";

const doctorPatientSnapshots = new Map();

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

function deriveAgeFromBirthdate(value) {
  if (!value) return null;
  const birthdate = new Date(`${value}T00:00:00`);
  if (Number.isNaN(birthdate.getTime()) || birthdate.getTime() > Date.now()) return null;
  const today = new Date();
  let age = today.getFullYear() - birthdate.getFullYear();
  const birthdayThisYear = new Date(
    today.getFullYear(),
    birthdate.getMonth(),
    birthdate.getDate()
  );
  if (today < birthdayThisYear) age -= 1;
  return age >= 0 && age <= 130 ? age : null;
}

function formatAgeLabel(row) {
  const derivedAge = deriveAgeFromBirthdate(row?.date_of_birth);
  const storedAge = Number(String(row?.age || "").replace(/[^\d]/g, ""));
  const age =
    derivedAge ??
    (Number.isFinite(storedAge) && storedAge > 0 ? storedAge : null);
  return age === null ? "Patient" : `Patient - ${age} years old`;
}

function mapSupabasePatient(row) {
  const visibleId = row.patient_id || "Not provided";
  return {
    recordId: row.id,
    initials: getPatientInitials(row.full_name),
    avatarClass: "patient-avatar-pink",
    photo: "",
    name: row.full_name || "Unnamed Patient",
    patientId: visibleId,
    sexAge: formatAgeLabel(row),
    dateOfBirth: formatPatientDate(row.date_of_birth),
  };
}

async function fetchPatientAvatarMap(patientRows) {
  const patientIds = Array.from(
    new Set(patientRows.map((patient) => patient?.recordId).filter(Boolean))
  );

  if (!patientIds.length) return new Map();

  const { data, error } = await supabase.rpc("get_patient_avatar_urls", {
    p_patient_ids: patientIds,
  });

  if (error) {
    console.warn("Load Doctor patient profile pictures failed:", error);
    return null;
  }

  return new Map(
    (data || []).map((row) => [
      String(row.patient_id || ""),
      String(row.avatar_url || "").trim(),
    ])
  );
}

function mergePatientAvatarMap(patientRows, avatarMap) {
  if (!avatarMap) return patientRows;

  let changed = false;
  const nextRows = patientRows.map((patient) => {
    const nextPhoto = avatarMap.get(String(patient.recordId || "")) || "";
    if (nextPhoto === (patient.photo || "")) return patient;
    changed = true;
    return { ...patient, photo: nextPhoto };
  });

  return changed ? nextRows : patientRows;
}

function PatientAvatar({ patient }) {
  return (
    <span className={`doctor-patient-avatar ${patient.avatarClass}`}>
      {patient.photo ? (
        <img
          src={patient.photo}
          alt={`${patient.name} profile`}
          referrerPolicy="no-referrer"
          style={{
            width: "100%",
            height: "100%",
            display: "block",
            objectFit: "cover",
            borderRadius: "inherit",
          }}
        />
      ) : (
        patient.initials
      )}
    </span>
  );
}

function PatientTableSkeleton({ isVisible }) {
  return [0, 1, 2].map((rowIndex) => (
    <tr
      className={`doctor-patients-skeleton-row doctor-loading-shell${isVisible ? " is-visible" : ""}`}
      key={`patient-loading-${rowIndex}`}
      aria-hidden="true"
    >
      <td>
        <span className="doctor-patients-skeleton-person">
          <span className="doctor-loading-bar doctor-patients-skeleton-avatar" />
          <span className="doctor-patients-skeleton-copy">
            <span className="doctor-loading-bar" />
            <span className="doctor-loading-bar" />
          </span>
        </span>
      </td>
      <td><span className="doctor-loading-bar" /></td>
      <td><span className="doctor-loading-bar" /></td>
      <td><span className="doctor-loading-bar" /></td>
    </tr>
  ));
}

function PatientListPage({
  patients,
  searchTerm,
  setSearchTerm,
  onViewRecord,
  statusMessage,
  loadState,
  headerAction,
}) {
  const showLoadingSkeleton = useDoctorDelayedLoader(loadState === "loading");
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
        {headerAction ?? null}
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

      {loadState === "loading" ? (
        <p className="app-sr-only" role="status">Loading patients...</p>
      ) : null}

      {statusMessage ? (
        <p
          className="doctor-patients-status-message"
          role={statusMessage.startsWith("Unable to load patients:") ? "alert" : "status"}
        >
          {statusMessage}
        </p>
      ) : null}

      <div className="doctor-patients-table-card">
        <div className="doctor-patients-table-scroll">
          <table className="doctor-patients-table">
            <thead>
              <tr>
                <th>
                  Name <Icon icon="solar:sort-vertical-linear" />
                </th>
                <th>
                  Patient ID <Icon icon="solar:sort-vertical-linear" />
                </th>
                <th>
                  Date of Birth <Icon icon="solar:sort-vertical-linear" />
                </th>
                <th>Medical Records</th>
              </tr>
            </thead>

            <tbody>
              {loadState === "loaded" ? filteredPatients.map((patient) => (
                <tr key={patient.recordId}>
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
                    <button
                      className="doctor-patient-view-btn"
                      type="button"
                      onClick={() => onViewRecord(patient.recordId)}
                    >
                      View
                    </button>
                  </td>
                </tr>
              )) : null}

              {loadState === "loading" ? (
                <PatientTableSkeleton isVisible={showLoadingSkeleton} />
              ) : null}

              {loadState === "loaded" && !filteredPatients.length ? (
                <tr>
                  <td colSpan="4" className="doctor-patients-empty-cell">
                    No patient found.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function DoctorPatientsContent({ headerAction = null, doctorIdentity = null }) {
  const location = useLocation();
  const authenticatedDoctorId = doctorIdentity?.authUser?.id || "";
  const patientSnapshot = authenticatedDoctorId
    ? doctorPatientSnapshots.get(authenticatedDoctorId) || null
    : null;
  const [patients, setPatients] = useState(() => patientSnapshot || []);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [loadState, setLoadState] = useState(() =>
    patientSnapshot ? "loaded" : "loading"
  );
  const dashboardPatientTargetRef = useRef("");

  const dashboardPatientTarget = useMemo(() => {
    const match = location.pathname.match(
      /^\/doctor\/patients\/([^/?#]+)\/?$/i
    );
    if (!match?.[1]) return "";

    try {
      return decodeURIComponent(match[1]).trim();
    } catch {
      return String(match[1] || "").trim();
    }
  }, [location.pathname]);

  useEffect(() => {
    if (doctorIdentity?.loading || !authenticatedDoctorId) {
      return undefined;
    }

    let active = true;

    const loadPatients = async () => {
      const hasSnapshot = doctorPatientSnapshots.has(authenticatedDoctorId);
      if (!hasSnapshot) {
        setLoadState("loading");
      }
      setStatusMessage("");

      const { data, error } = await supabase
        .rpc("get_doctor_patient_directory")
        .select(patientSelectColumns)
        .order("created_at", { ascending: false });

      if (!active) return;

      if (error) {
        console.error("Load doctor patients failed:", error);
        if (!hasSnapshot) {
          setPatients([]);
          setLoadState("error");
        } else {
          setLoadState("loaded");
        }
        setStatusMessage(`Unable to load patients: ${error.message}`);
        return;
      }

      const mappedPatients = (data || [])
        .filter(isActivePatientRow)
        .map(mapSupabasePatient);

      doctorPatientSnapshots.set(authenticatedDoctorId, mappedPatients);
      setPatients(mappedPatients);
      setLoadState("loaded");
      setStatusMessage("");

      const avatarMap = await fetchPatientAvatarMap(mappedPatients);
      if (!active || !avatarMap) return;

      const patientsWithAvatars = mergePatientAvatarMap(mappedPatients, avatarMap);
      doctorPatientSnapshots.set(authenticatedDoctorId, patientsWithAvatars);
      setPatients(patientsWithAvatars);
    };

    loadPatients();

    const patientsChannel = supabase
      .channel(`doctor-patients-list-${authenticatedDoctorId}`)
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
  }, [authenticatedDoctorId, doctorIdentity?.loading]);

  useEffect(() => {
    if (!patients.length) return undefined;

    let active = true;

    const refreshPatientAvatars = async () => {
      if (document.visibilityState !== "visible") return;

      const avatarMap = await fetchPatientAvatarMap(patients);
      if (!active || !avatarMap) return;

      const nextPatients = mergePatientAvatarMap(patients, avatarMap);
      doctorPatientSnapshots.set(authenticatedDoctorId, nextPatients);
      setPatients(nextPatients);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshPatientAvatars();
      }
    };

    window.addEventListener("focus", refreshPatientAvatars);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      active = false;
      window.removeEventListener("focus", refreshPatientAvatars);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [authenticatedDoctorId, patients]);

  useEffect(() => {
    if (loadState !== "loaded") return undefined;

    const timer = window.setTimeout(() => {
      if (!dashboardPatientTarget) {
        if (dashboardPatientTargetRef.current) {
          dashboardPatientTargetRef.current = "";
          setSearchTerm("");
        }
        return;
      }

      const target = patients.find(
        (patient) =>
          String(patient.recordId || "") === dashboardPatientTarget ||
          String(patient.patientId || "") === dashboardPatientTarget
      );

      dashboardPatientTargetRef.current = dashboardPatientTarget;

      if (!target) {
        setSearchTerm("");
        setStatusMessage(
          `Patient ${dashboardPatientTarget} could not be found.`
        );
        return;
      }

      setSearchTerm(target.patientId || target.name);
      setStatusMessage("");
    }, 0);

    return () => window.clearTimeout(timer);
  }, [dashboardPatientTarget, loadState, patients]);

  const handleViewRecord = (recordId) => {
    const patient = patients.find((item) => item.recordId === recordId);
    if (!patient?.recordId) return;

    window.dispatchEvent(
      new CustomEvent("doctor:navigate", {
        detail: {
          section: "medicalRecords",
          medicalRecordTarget: {
            patientId: patient.recordId,
            activeTab: "Overview",
            recordId: "",
            returnPage: "patients",
          },
        },
      })
    );
  };

  return (
    <section className="doctor-patients-page">
      <PatientListPage
        patients={patients}
        searchTerm={searchTerm}
        setSearchTerm={setSearchTerm}
        onViewRecord={handleViewRecord}
        statusMessage={statusMessage}
        loadState={loadState}
        headerAction={headerAction}
      />
    </section>
  );
}

export default DoctorPatientsContent;
