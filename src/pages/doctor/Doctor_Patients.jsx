import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { supabase } from "../../lib/supabaseClient";
import {
  PatientDirectoryHeader,
  PatientDirectorySearch,
  PatientDirectoryToolbar,
  PatientTableShell,
} from "../../components/patients/PatientDirectoryUi";
import "../../styles/doctor-patients.css";

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

function PatientAvatar({ patient }) {
  return (
    <span className={`doctor-patient-avatar ${patient.avatarClass}`}>
      {patient.photo ? (
        <img src={patient.photo} alt={patient.name} />
      ) : (
        patient.initials
      )}
    </span>
  );
}

function PatientListPage({
  patients,
  searchTerm,
  setSearchTerm,
  onViewRecord,
  statusMessage,
  headerAction,
}) {
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
      <PatientDirectoryHeader
        subtitle="Manage and view patient information across your practice."
        action={headerAction ?? null}
        className="doctor-patients-header"
      />

      <PatientDirectoryToolbar searchOnly>
        <PatientDirectorySearch
          value={searchTerm}
          onChange={setSearchTerm}
          className="doctor-patients-search-wrap"
        />
      </PatientDirectoryToolbar>

      {statusMessage ? (
        <p className="doctor-patients-status-message">{statusMessage}</p>
      ) : null}

      <PatientTableShell
        as="div"
        className="doctor-patients-table-card"
        scrollClassName="doctor-patients-table-scroll"
      >
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
                    <button
                      className="doctor-patient-view-btn"
                      type="button"
                      onClick={() => onViewRecord(patient.patientId)}
                    >
                      <Icon icon="solar:document-medicine-linear" aria-hidden="true" />
                      Open record
                    </button>
                  </td>
                </tr>
              ))}

              {!filteredPatients.length ? (
                <tr>
                  <td colSpan="4" className="doctor-patients-empty-cell">
                    No patient found.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
      </PatientTableShell>
    </section>
  );
}

function DoctorPatientsContent({ headerAction = null }) {
  const [patients, setPatients] = useState([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusMessage, setStatusMessage] = useState("Loading patients...");

  useEffect(() => {
    let active = true;

    const loadPatients = async () => {
      setStatusMessage("Loading patients...");

      const { data, error } = await supabase
        .rpc("get_doctor_patient_directory")
        .select(patientSelectColumns)
        .order("created_at", { ascending: false });

      if (!active) return;

      if (error) {
        console.error("Load doctor patients failed:", error);
        setPatients([]);
        setStatusMessage(`Unable to load patients: ${error.message}`);
        return;
      }

      setPatients(
        (data || []).filter(isActivePatientRow).map(mapSupabasePatient)
      );
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

  const handleViewRecord = (patientId) => {
    const patient = patients.find((item) => item.patientId === patientId);
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
    <section className="doctor-patients-page patient-directory patient-directory--doctor">
      <PatientListPage
        patients={patients}
        searchTerm={searchTerm}
        setSearchTerm={setSearchTerm}
        onViewRecord={handleViewRecord}
        statusMessage={statusMessage}
        headerAction={headerAction}
      />
    </section>
  );
}

export default DoctorPatientsContent;
