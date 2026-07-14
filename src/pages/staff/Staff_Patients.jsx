import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { QRCodeCanvas } from "qrcode.react";
import { supabase } from "../../lib/supabaseClient";
import "../../styles/staff-patients.css";

const patientSelectColumns =
  "id, full_name, patient_id, control_number, date_of_birth, age, contact_number, email, address, status, created_at";
const patientLoginSelectColumns =
  "id, patient_record_id, full_name, patient_id, control_number, email, status, created_at";

const steps = [
  { id: 1, label: "Basic Information" },
  { id: 2, label: "Reproductive and Obstetric" },
  { id: 3, label: "Medical & Family History" },
  { id: 4, label: "Initial Assessment" },
];

const blankForm = {
  name: "",
  age: "",
  birthdate: "",
  address: "",
  contactNumber: "",
  occupation: "",
  workAddress: "",
  company: "",
  workContactNumber: "",
  email: "",
  husbandPartner: "",
  partnerContactNumber: "",

  ageMenarche: "",
  menstrualPattern: "Regular",
  cycleLength: "",
  durationMenstruation: "",
  sexuallyActive: "Yes",
  contraceptiveMethod: "",
  gravida: "",
  para: "",
  lmp: "",
  edd: "",
  pregnancyRecords: [],

  bloodType: "",
  allergyOne: "",
  allergyTwo: "",
  allergyThree: "",
  medicalConditions: [],
  medicalOther: "",
  familyHistory: [],
  familyOther: "",

  hpvVaccination: "Yes",
  lastPapSmear: "",
  assessmentOthers: "",
  height: "",
  weight: "",
  bloodPressure: "",
  temperature: "",
  respiratoryRate: "",
  oxygenSaturation: "",
  remarks: "",
};

const contraceptiveMethodOptions = [
  "None",
  "Oral Contraceptive Pill",
  "Injectable Contraceptive",
  "Contraceptive Implant",
  "Hormonal IUD",
  "Copper IUD",
  "Male Condom",
  "Female Condom",
  "Diaphragm",
  "Cervical Cap",
  "Contraceptive Patch",
  "Vaginal Ring",
  "Emergency Contraceptive Pill",
  "Natural Family Planning",
  "Withdrawal Method",
  "Lactational Amenorrhea Method (LAM)",
  "Tubal Ligation",
  "Partner Vasectomy",
];

const bloodTypeOptions = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

const allergyTypeOptions = [
  "Medication Allergy",
  "Food Allergy",
  "Environmental Allergy",
  "Insect Allergy",
  "Latex Allergy",
  "Chemical Allergy",
];

const pregnancyRecordTemplate = {
  birthdate: "",
  termPreterm: "",
  deliveryType: "",
  deliveryPlace: "",
  complications: "",
  nbsResult: "",
};

const medicalOptions = [
  "Hypertension",
  "Diabetes Mellitus",
  "Asthma",
  "Kidney Disease",
  "Thyroid Disorder",
  "Others",
];

const familyOptions = [
  "Hypertension",
  "Diabetes Mellitus",
  "Asthma",
  "Tuberculosis",
  "Cancer",
  "Goiter",
  "Heart Disease",
  "Twin Pregnancy",
  "Others",
];

function getCredentialPatientId(patient) {
  return patient?.patientId || patient?.patient_id || patient?.id || "";
}

function getCredentialControlNumber(patient) {
  return patient?.controlNumber || patient?.control_number || "";
}

function toCredentialEntry(patient) {
  return {
    patientId: getCredentialPatientId(patient),
    controlNumber: getCredentialControlNumber(patient),
  };
}

function addCredentialsToPool(pool, credentials) {
  const alreadyTracked = pool.some((item) => {
    return (
      getCredentialPatientId(item) === credentials.patientId ||
      getCredentialControlNumber(item) === credentials.controlNumber
    );
  });

  return alreadyTracked ? pool : [...pool, credentials];
}

function generatePatientId(existingPatients = []) {
  const year = new Date().getFullYear();
  const matchingIds = existingPatients
    .map(getCredentialPatientId)
    .filter((id) => typeof id === "string" && id.startsWith(`LP-${year}-`))
    .map((id) => Number(id.split("-").at(-1)))
    .filter((number) => Number.isFinite(number));
  const nextNumber = matchingIds.length
    ? Math.max(...matchingIds) + 1
    : existingPatients.length + 1;

  return `LP-${year}-${String(nextNumber).padStart(5, "0")}`;
}

function generateControlNumber(existingPatients = []) {
  const existingControlNumbers = new Set(
    existingPatients.map(getCredentialControlNumber).filter(Boolean)
  );
  const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const segment = (length) =>
      Array.from({ length }, () =>
        characters[Math.floor(Math.random() * characters.length)]
      ).join("");
    const controlNumber = `LPMRH-${segment(4)}-${segment(4)}`;

    if (!existingControlNumbers.has(controlNumber)) {
      return controlNumber;
    }
  }

  return `LPMRH-${Date.now().toString(36).toUpperCase()}`;
}

function createAccessCredentials(existingPatients = []) {
  return {
    patientId: generatePatientId(existingPatients),
    controlNumber: generateControlNumber(existingPatients),
  };
}

function isMissingPatientLoginTableError(error) {
  if (!error) return false;

  const message = `${error.message || ""} ${error.details || ""}`.toLowerCase();

  return (
    error.code === "42P01" ||
    error.code === "42703" ||
    error.code === "PGRST200" ||
    error.code === "PGRST204" ||
    error.code === "PGRST205" ||
    message.includes("patient_login") ||
    message.includes("could not find the table") ||
    message.includes("could not find the column") ||
    message.includes("schema cache")
  );
}

function isPatientLoginPatientIdConflict(error) {
  if (!error) return false;

  const message = `${error.message || ""} ${error.details || ""}`.toLowerCase();

  return (
    error.code === "23505" &&
    (message.includes("patient_login_patient_id_unique") ||
      message.includes("patient_id_unique") ||
      message.includes("patient_id"))
  );
}

function isPatientLoginPolicyError(error) {
  if (!error) return false;

  const message = `${error.message || ""} ${error.details || ""}`.toLowerCase();

  return (
    error.code === "42501" ||
    (message.includes("row-level security") &&
      message.includes("patient_login"))
  );
}

function isDuplicatePatientCredentialError(error) {
  if (!error) return false;

  const message = `${error.message || ""} ${error.details || ""}`.toLowerCase();

  return (
    error.code === "23505" &&
    (message.includes("patients_patient_id_unique") ||
      message.includes("patients_control_number_unique") ||
      message.includes("patient_id") ||
      message.includes("control_number"))
  );
}

function isSchemaCacheColumnError(error) {
  if (!error) return false;

  const message = `${error.message || ""} ${error.details || ""}`.toLowerCase();

  return (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    message.includes("could not find the") ||
    message.includes("schema cache") ||
    message.includes("column")
  );
}

function isActivePatientRow(row) {
  const status = String(row?.status || "").trim().toLowerCase();

  return ["active", "pending activation", "pending registration"].includes(status);
}

function omitPayloadFields(payload, fields) {
  return Object.fromEntries(
    Object.entries(payload).filter(([field]) => !fields.includes(field))
  );
}

function getMobileAccessOrigin() {
  const configuredOrigin = import.meta.env.VITE_MOBILE_ACCESS_ORIGIN;

  if (configuredOrigin) {
    const configuredUrl = new URL(configuredOrigin, window.location.origin);

    return configuredUrl.origin;
  }

  return window.location.origin;
}

function getInitials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "PT";
  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function computeAgeLabel(age) {
  if (!age) return "Age not set";
  const cleanAge = String(age).replace(/[^\d]/g, "");
  return cleanAge ? `${cleanAge} years old` : "Age not set";
}

function formatBirthdate(value) {
  if (!value) return "Not set";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "2-digit",
    year: "numeric",
  });
}

function parseAgeValue(value) {
  const cleanAge = String(value || "").replace(/[^\d]/g, "");
  return cleanAge ? Number(cleanAge) : null;
}

function parseOptionalNumber(value) {
  const match = String(value ?? "")
    .replace(/,/g, "")
    .match(/-?\d+(?:\.\d+)?/);

  if (!match) return null;

  const numberValue = Number(match[0]);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function isNumberInRange(value, min, max) {
  return value === null || (value >= min && value <= max);
}

function cleanText(value) {
  const cleaned = String(value ?? "").trim();
  return cleaned || null;
}

function getAllergyList(form) {
  return [form.allergyOne, form.allergyTwo, form.allergyThree]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function getMedicalConditionList(form) {
  return Array.isArray(form.medicalConditions)
    ? form.medicalConditions.filter(Boolean)
    : [];
}

function getPregnancyRecordList(form) {
  return Array.isArray(form.pregnancyRecords)
    ? form.pregnancyRecords.filter((record) =>
        Object.values(record || {}).some((value) => String(value || "").trim())
      )
    : [];
}

function formatPregnancyRecordsForNotes(form) {
  const records = getPregnancyRecordList(form);

  if (!records.length) return "";

  return [
    "Pregnancy records:",
    ...records.map((record, index) => {
      return [
        `${index + 1}. Birthdate: ${record.birthdate || "-"}`,
        `Term/Preterm: ${record.termPreterm || "-"}`,
        `Type of Delivery: ${record.deliveryType || "-"}`,
        `Place of Delivery: ${record.deliveryPlace || "-"}`,
        `Complications: ${record.complications || "-"}`,
        `NBS Result: ${record.nbsResult || "-"}`,
      ].join(" | ");
    }),
  ].join("\n");
}

function calculatePregnancyProgress(lmpValue) {
  if (!lmpValue) {
    return { gestationalAge: null, trimester: null };
  }

  const lmpDate = new Date(`${lmpValue}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (Number.isNaN(lmpDate.getTime()) || lmpDate > today) {
    return { gestationalAge: null, trimester: null };
  }

  const elapsedDays = Math.floor(
    (today.getTime() - lmpDate.getTime()) / (1000 * 60 * 60 * 24)
  );
  const weeks = Math.floor(elapsedDays / 7);
  const remainingDays = elapsedDays % 7;

  let trimester = "Third Trimester";
  if (weeks < 14) trimester = "First Trimester";
  else if (weeks < 28) trimester = "Second Trimester";

  return {
    gestationalAge: `${weeks} weeks${
      remainingDays ? ` ${remainingDays} days` : ""
    }`,
    trimester,
  };
}

function mapSupabasePatient(row) {
  const visibleId = row.patient_id || String(row.id || "").slice(0, 8);

  return {
    recordId: row.id,
    id: visibleId,
    patientId: visibleId,
    controlNumber: row.control_number || "",
    initials: getInitials(row.full_name || "Patient"),
    name: row.full_name || "Unnamed Patient",
    gender: "Female",
    age: computeAgeLabel(row.age),
    birthdate: formatBirthdate(row.date_of_birth),
    tone: "pink",
  };
}

function createPatientPayload(form, credentials) {
  const allergies = getAllergyList(form);
  const medicalConditions = getMedicalConditionList(form);
  const pregnancyProgress = calculatePregnancyProgress(form.lmp);
  const medicalNotes = [
    form.assessmentOthers,
    form.remarks,
    formatPregnancyRecordsForNotes(form),
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join("\n");

  return {
    full_name: form.name || "New Patient",
    patient_id: credentials.patientId,
    control_number: credentials.controlNumber,
    date_of_birth: form.birthdate || null,
    age: parseAgeValue(form.age),
    address: cleanText(form.address),
    contact_number: cleanText(form.contactNumber),
    email: cleanText(form.email),
    expected_delivery_date: form.edd || null,
    gestational_age: pregnancyProgress.gestationalAge,
    trimester: pregnancyProgress.trimester,
    blood_type: cleanText(form.bloodType),
    allergies: allergies.length ? allergies.join(", ") : null,
    chronic_illness: medicalConditions.length
      ? medicalConditions.join(", ")
      : null,
    medical_notes: medicalNotes || null,
    status: "Pending Activation",
  };
}

function createCorePatientPayload(form, credentials) {
  return omitPayloadFields(createPatientPayload(form, credentials), [
    "allergies",
    "chronic_illness",
    "medical_notes",
  ]);
}

function createPatientPersonalInfoPayload(form, savedPatient, credentials) {
  return {
    patient_record_id: savedPatient.id,
    patient_code: credentials.patientId,
    full_name: form.name || "New Patient",
    gender: "Female",
    email: cleanText(form.email),
    birthdate: form.birthdate || null,
    age: parseAgeValue(form.age),
    address: cleanText(form.address),
    contact_number: cleanText(form.contactNumber),
    occupation: cleanText(form.occupation),
    work_address: cleanText(form.workAddress),
    company: cleanText(form.company),
    work_contact_number: cleanText(form.workContactNumber),
    blood_type: cleanText(form.bloodType),
    civil_status: null,
    updated_at: new Date().toISOString(),
  };
}

function createCorePatientPersonalInfoPayload(form, savedPatient, credentials) {
  return omitPayloadFields(
    createPatientPersonalInfoPayload(form, savedPatient, credentials),
    ["occupation", "work_address", "company", "work_contact_number"]
  );
}

function createEmergencyContactPayload(form, personalInfoId) {
  if (!form.husbandPartner.trim() && !form.partnerContactNumber.trim()) {
    return null;
  }

  return {
    patient_id: personalInfoId,
    contact_person: cleanText(form.husbandPartner) || "Emergency Contact",
    relationship: "Husband/Partner",
    contact_number: cleanText(form.partnerContactNumber),
    updated_at: new Date().toISOString(),
  };
}

function createObstetricHistoryPayload(form, savedPatient) {
  const ageAtMenarche = parseOptionalNumber(form.ageMenarche);

  return {
    patient_id: savedPatient.id,
    age_at_menarche: isNumberInRange(ageAtMenarche, 8, 25)
      ? ageAtMenarche
      : null,
    menstrual_pattern: cleanText(form.menstrualPattern),
    cycle_length_days: parseOptionalNumber(form.cycleLength),
    menstruation_duration_days: parseOptionalNumber(form.durationMenstruation),
    sexually_active:
      form.sexuallyActive === "Yes"
        ? true
        : form.sexuallyActive === "No"
          ? false
          : null,
    contraceptive_method: cleanText(form.contraceptiveMethod),
    gravida: parseOptionalNumber(form.gravida) ?? 0,
    para: parseOptionalNumber(form.para) ?? 0,
    last_menstrual_period: form.lmp || null,
    expected_delivery_date: form.edd || null,
    updated_at: new Date().toISOString(),
  };
}

function createMedicalHistoryPayload(form, savedPatient) {
  return {
    patient_id: savedPatient.id,
    allergies: getAllergyList(form),
    medical_conditions: getMedicalConditionList(form),
    other_medical_condition: cleanText(form.medicalOther),
    family_history: Array.isArray(form.familyHistory)
      ? form.familyHistory.filter(Boolean)
      : [],
    other_family_history: cleanText(form.familyOther),
    updated_at: new Date().toISOString(),
  };
}

function createInitialAssessmentPayload(form, savedPatient) {
  return {
    patient_id: savedPatient.id,
    hpv_vaccinated:
      form.hpvVaccination === "Yes"
        ? true
        : form.hpvVaccination === "No"
          ? false
          : null,
    last_pap_smear: form.lastPapSmear || null,
    assessment_others: cleanText(form.assessmentOthers),
    height_cm: parseOptionalNumber(form.height),
    weight_kg: parseOptionalNumber(form.weight),
    blood_pressure: cleanText(form.bloodPressure),
    temperature_celsius: parseOptionalNumber(form.temperature),
    respiratory_rate: parseOptionalNumber(form.respiratoryRate),
    oxygen_saturation: parseOptionalNumber(form.oxygenSaturation),
    remarks: cleanText(form.remarks),
    updated_at: new Date().toISOString(),
  };
}

function createReservedPatientLoginPayload(credentials) {
  return {
    row_type: "credential",
    sort_order: 1,
    screen_key: "control_number",
    screen_title: "Enter Control Number",
    button_label: "Submit",
    patient_id: credentials.patientId,
    control_number: credentials.controlNumber,
    status: "Pending Registration",
  };
}

function createPatientLoginPayload(form, savedPatient, credentials) {
  return {
    row_type: "credential",
    sort_order: 1,
    screen_key: "control_number",
    screen_title: "Enter Control Number",
    button_label: "Submit",
    patient_record_id: savedPatient.id,
    full_name: form.name || "New Patient",
    patient_id: credentials.patientId,
    control_number: credentials.controlNumber,
    email: form.email || null,
    date_of_birth: form.birthdate || null,
    age: parseAgeValue(form.age),
    address: form.address || null,
    contact_number: form.contactNumber || null,
    status: "Pending Activation",
  };
}

function InputField({
  label,
  required = false,
  type = "text",
  value,
  onChange,
  placeholder = "",
  icon,
  className = "",
}) {
  return (
    <label className={`staff-register-field ${className}`}>
      {label ? (
        <span>
          {label}
          {required ? <b>*</b> : null}
        </span>
      ) : null}

      <div className="staff-register-input-wrap">
        <input
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
        {icon ? <Icon icon={icon} aria-hidden="true" /> : null}
      </div>
    </label>
  );
}

function SelectField({ label, value, onChange, children, className = "" }) {
  return (
    <label className={`staff-register-field ${className}`}>
      {label ? <span>{label}</span> : null}

      <div className="staff-register-input-wrap">
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {children}
        </select>
        <Icon icon="solar:alt-arrow-down-linear" aria-hidden="true" />
      </div>
    </label>
  );
}

function RadioGroup({ label, value, onChange, options }) {
  return (
    <div className="staff-register-radio-group">
      <span>{label}</span>
      <div>
        {options.map((option) => (
          <label key={option}>
            <input
              type="radio"
              checked={value === option}
              onChange={() => onChange(option)}
            />
            <i />
            {option}
          </label>
        ))}
      </div>
    </div>
  );
}

function CheckboxItem({ label, checked, onChange }) {
  return (
    <label className="staff-register-check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <i />
      <span>{label}</span>
    </label>
  );
}

function PatientRegisterSuccessCard() {
  return (
    <section className="staff-register-success-card">
      <span>
        <Icon icon="solar:check-circle-bold" aria-hidden="true" />
      </span>
      <h3>Patient will be registered</h3>
      <p>Once registered, a unique code will be generated for patient access.</p>
    </section>
  );
}

function CredentialsPanel({ credentials }) {
  const accessUrl = `${getMobileAccessOrigin()}/patient/access?patientId=${encodeURIComponent(
    credentials.patientId
  )}&control=${encodeURIComponent(credentials.controlNumber)}`;

  return (
    <aside className="staff-register-side">
      <section className="staff-register-credential-card">
        <header>
          <Icon icon="solar:lock-keyhole-linear" aria-hidden="true" />
          <h3>Access Credentials</h3>
        </header>

        <p>Provide the following to the patient to access the mobile application.</p>

        <div className="staff-credential-field">
          <small>Patient ID</small>
          <strong>{credentials.patientId}</strong>
        </div>

        <div className="staff-credential-field">
          <small>Control Number (One-Time)</small>
          <strong className="is-green">{credentials.controlNumber}</strong>
        </div>

        <div className="staff-qr-block">
          <small>QR Code</small>
          <div>
            <QRCodeCanvas
              value={accessUrl}
              size={148}
              level="H"
              includeMargin
            />
          </div>
        </div>

        <em>
          The patient can scan this QR code and enter the control number to download
          the app and activate their account.
        </em>
        <em>{accessUrl}</em>

        <div className="staff-important-box">
          <strong>Important!</strong>
          <p>The control number is one-time use only for activation.</p>
          <p>Keep this information secure and only share with the patient.</p>
        </div>
      </section>
    </aside>
  );
}

function Stepper({ currentStep, onStepSelect }) {
  const progress = `${((currentStep - 1) / (steps.length - 1)) * 100}%`;

  return (
    <div className="staff-register-stepper" style={{ "--step-progress": progress }}>
      <div className="staff-register-step-line" />

      {steps.map((item) => {
        const isReached = item.id <= currentStep;

        return (
          <button
            key={item.id}
            type="button"
            className={[
              "staff-register-step",
              item.id === currentStep ? "is-active" : "",
              item.id < currentStep ? "is-complete" : "",
              isReached ? "is-reached" : "",
            ].join(" ")}
            onClick={() => {
              if (isReached) onStepSelect(item.id);
            }}
            aria-current={item.id === currentStep ? "step" : undefined}
          >
            <span>{item.id}</span>
            <small>{item.label}</small>
          </button>
        );
      })}
    </div>
  );
}

function StaffPatientsContent({ headerAction }) {
  const [screen, setScreen] = useState("list");
  const [patients, setPatients] = useState([]);
  const [query, setQuery] = useState("");
  const [activeModal, setActiveModal] = useState(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [isLoadingPatients, setIsLoadingPatients] = useState(true);
  const [isSavingPatient, setIsSavingPatient] = useState(false);
  const [sortConfig, setSortConfig] = useState({
    key: "name",
    direction: "asc",
  });
  const [step, setStep] = useState(1);
  const [form, setForm] = useState(blankForm);
  const [accessCredentials, setAccessCredentials] = useState(() =>
    createAccessCredentials([])
  );
  const [credentialPool, setCredentialPool] = useState([]);

  useEffect(() => {
    let active = true;

    const loadPatients = async () => {
      setIsLoadingPatients(true);

      const [patientsResult, patientLoginResult] = await Promise.all([
        supabase
          .from("patients")
          .select(patientSelectColumns)
          .order("created_at", { ascending: false }),
        supabase
          .from("patient_login")
          .select(patientLoginSelectColumns),
      ]);

      if (!active) return;

      setIsLoadingPatients(false);

      if (patientsResult.error) {
        console.error("Load staff patients failed:", patientsResult.error);
        setStatusMessage(`Unable to load patients: ${patientsResult.error.message}`);
        return;
      }

      if (
        patientLoginResult.error &&
        !isMissingPatientLoginTableError(patientLoginResult.error)
      ) {
        console.warn("Load patient login credentials failed:", patientLoginResult.error);
      }

      const supabasePatients = patientsResult.data || [];
      const mappedPatients = supabasePatients
        .filter(isActivePatientRow)
        .map(mapSupabasePatient);
      const patientLoginCredentials = patientLoginResult.error
        ? []
        : (patientLoginResult.data || []).map(toCredentialEntry);
      const nextCredentialPool = [
        ...supabasePatients.map(toCredentialEntry),
        ...patientLoginCredentials,
      ];

      setPatients(mappedPatients);
      setCredentialPool(nextCredentialPool);
      setAccessCredentials(createAccessCredentials(nextCredentialPool));
    };

    loadPatients();

    return () => {
      active = false;
    };
  }, []);

  const filteredPatients = useMemo(() => {
    const keyword = query.trim().toLowerCase();

    const searchedPatients = !keyword
      ? patients
      : patients.filter((patient) => {
          return (
            patient.name.toLowerCase().includes(keyword) ||
            patient.id.toLowerCase().includes(keyword) ||
            patient.birthdate.toLowerCase().includes(keyword)
          );
        });

    return [...searchedPatients].sort((a, b) => {
      const firstValue = String(a[sortConfig.key]).toLowerCase();
      const secondValue = String(b[sortConfig.key]).toLowerCase();

      if (firstValue < secondValue) return sortConfig.direction === "asc" ? -1 : 1;
      if (firstValue > secondValue) return sortConfig.direction === "asc" ? 1 : -1;
      return 0;
    });
  }, [query, patients, sortConfig]);

  const updateForm = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const addPregnancyRecord = () => {
    setForm((current) => ({
      ...current,
      pregnancyRecords: [
        ...(Array.isArray(current.pregnancyRecords)
          ? current.pregnancyRecords
          : []),
        { ...pregnancyRecordTemplate },
      ],
    }));
  };

  const updatePregnancyRecord = (index, field, value) => {
    setForm((current) => ({
      ...current,
      pregnancyRecords: (Array.isArray(current.pregnancyRecords)
        ? current.pregnancyRecords
        : []
      ).map((record, recordIndex) =>
        recordIndex === index ? { ...record, [field]: value } : record
      ),
    }));
  };

  const toggleArrayValue = (field, value, checked) => {
    setForm((current) => ({
      ...current,
      [field]: checked
        ? [...current[field], value]
        : current[field].filter((item) => item !== value),
    }));
  };

  const requestSort = (key) => {
    setSortConfig((current) => ({
      key,
      direction:
        current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  };

  const savePatientLoginCredential = async (payload) => {
    const saveViaRpc = async () => {
      const rpcResult = await supabase.rpc("upsert_patient_login_credential", {
        credential_patient_record_id: payload.patient_record_id || null,
        credential_full_name: payload.full_name || null,
        credential_patient_id: payload.patient_id,
        credential_control_number: payload.control_number,
        credential_email: payload.email || null,
        credential_date_of_birth: payload.date_of_birth || null,
        credential_age: payload.age ?? null,
        credential_address: payload.address || null,
        credential_contact_number: payload.contact_number || null,
        credential_status: payload.status || "Pending Activation",
      });

      return {
        ...rpcResult,
        data: Array.isArray(rpcResult.data)
          ? rpcResult.data[0] || null
          : rpcResult.data,
      };
    };

    const result = await supabase
      .from("patient_login")
      .upsert([payload], {
        onConflict: "control_number",
      })
      .select(patientLoginSelectColumns)
      .single();

    if (!result.error) {
      return result;
    }

    if (isPatientLoginPolicyError(result.error)) {
      return saveViaRpc();
    }

    if (!isPatientLoginPatientIdConflict(result.error)) {
      return result;
    }

    const updateResult = await supabase
      .from("patient_login")
      .update(payload)
      .eq("patient_id", payload.patient_id)
      .select(patientLoginSelectColumns)
      .single();

    if (
      updateResult.error &&
      isPatientLoginPolicyError(updateResult.error)
    ) {
      return saveViaRpc();
    }

    return updateResult;
  };

  const reservePatientLoginCredentials = async (credentials) => {
    const payload = createReservedPatientLoginPayload(credentials);
    const { data, error } = await savePatientLoginCredential(payload);

    if (error) {
      console.warn("Patient login credential reservation failed:", error);

      if (!isPatientLoginPolicyError(error)) {
        setStatusMessage(
          `QR credential is not yet saved in patient_login: ${error.message}`
        );
      }

      return credentials;
    }

    const savedCredentials = toCredentialEntry(data || credentials);
    setCredentialPool((current) => addCredentialsToPool(current, savedCredentials));
    return savedCredentials;
  };

  const fetchLatestCredentialPool = async () => {
    const [patientsResult, patientLoginResult] = await Promise.all([
      supabase
        .from("patients")
        .select("id, patient_id, control_number"),
      supabase
        .from("patient_login")
        .select(patientLoginSelectColumns),
    ]);

    if (patientsResult.error) {
      throw patientsResult.error;
    }

    if (
      patientLoginResult.error &&
      !isMissingPatientLoginTableError(patientLoginResult.error)
    ) {
      throw patientLoginResult.error;
    }

    return [
      ...(patientsResult.data || []).map(toCredentialEntry),
      ...(patientLoginResult.error
        ? []
        : (patientLoginResult.data || []).map(toCredentialEntry)),
    ];
  };

  const createFreshReservedCredentials = async () => {
    const latestPool = await fetchLatestCredentialPool();
    const generatedCredentials = createAccessCredentials(latestPool);
    const savedCredentials = await reservePatientLoginCredentials(
      generatedCredentials
    );
    const nextPool = addCredentialsToPool(latestPool, savedCredentials);

    setCredentialPool(nextPool);
    setAccessCredentials(savedCredentials);

    return savedCredentials;
  };

  const cleanupPartialRegistration = async ({
    patientRecordId,
    personalInfoId,
  }) => {
    const cleanupErrors = [];

    const runDelete = async (table, column, value) => {
      if (!value) return;

      const { error } = await supabase
        .from(table)
        .delete()
        .eq(column, value);

      if (error) {
        cleanupErrors.push(`${table}: ${error.message}`);
        console.warn(`Cleanup failed for ${table}:`, error);
      }
    };

    if (personalInfoId) {
      await runDelete(
        "patient_emergency_contact",
        "patient_id",
        personalInfoId
      );
    }

    if (patientRecordId) {
      await runDelete(
        "patient_initial_assessment",
        "patient_id",
        patientRecordId
      );
      await runDelete(
        "patient_medical_history",
        "patient_id",
        patientRecordId
      );
      await runDelete(
        "patient_obstetric_history",
        "patient_id",
        patientRecordId
      );
    }

    if (personalInfoId) {
      await runDelete(
        "patient_personal_information",
        "id",
        personalInfoId
      );
    } else if (patientRecordId) {
      await runDelete(
        "patient_personal_information",
        "patient_record_id",
        patientRecordId
      );
    }

    if (patientRecordId) {
      await runDelete("patients", "id", patientRecordId);
    }

    return cleanupErrors;
  };

  const insertPatientRecord = async (credentials) => {
    const fullPayload = createPatientPayload(form, credentials);
    const fullResult = await supabase
      .from("patients")
      .insert([fullPayload])
      .select(patientSelectColumns)
      .single();

    if (!fullResult.error || !isSchemaCacheColumnError(fullResult.error)) {
      return fullResult;
    }

    console.warn(
      "Patients table is missing optional columns. Retrying with core patient payload.",
      fullResult.error
    );

    return supabase
      .from("patients")
      .insert([createCorePatientPayload(form, credentials)])
      .select(patientSelectColumns)
      .single();
  };

  const insertPersonalInfoRecord = async (savedPatient, credentials) => {
    const fullPayload = createPatientPersonalInfoPayload(
      form,
      savedPatient,
      credentials
    );
    const fullResult = await supabase
      .from("patient_personal_information")
      .insert([fullPayload])
      .select("id")
      .single();

    if (!fullResult.error || !isSchemaCacheColumnError(fullResult.error)) {
      return fullResult;
    }

    console.warn(
      "Patient personal information table is missing optional columns. Retrying with core payload.",
      fullResult.error
    );

    return supabase
      .from("patient_personal_information")
      .insert([
        createCorePatientPersonalInfoPayload(
          form,
          savedPatient,
          credentials
        ),
      ])
      .select("id")
      .single();
  };

  const saveOptionalPatientRecord = async (table, payload) => {
    const { error } = await supabase
      .from(table)
      .insert([payload])
      .select("id")
      .single();

    if (error) {
      console.warn(`Optional ${table} save failed:`, error);
      return `${table}: ${error.message}`;
    }

    return "";
  };

  const openRegister = async () => {
    setStep(1);
    setStatusMessage("");
    setScreen("register");

    const provisionalCredentials = createAccessCredentials(credentialPool);
    setAccessCredentials(provisionalCredentials);

    try {
      await createFreshReservedCredentials();
    } catch (error) {
      console.warn("Unable to refresh registration credentials:", error);
      const savedCredentials = await reservePatientLoginCredentials(
        provisionalCredentials
      );
      setAccessCredentials(savedCredentials);
      setStatusMessage(
        `Using locally generated credentials because the latest IDs could not be checked: ${error.message}`
      );
    }
  };

  const backToPatients = () => {
    setScreen("list");
    setStep(1);
  };

  const savePatient = async () => {
    setStatusMessage("");

    if (!form.name.trim()) {
      setStatusMessage("Patient name is required.");
      return;
    }

    if (!form.age.trim() || !form.birthdate || !form.address.trim()) {
      setStatusMessage(
        "Please complete the required age, birthdate, and home address fields."
      );
      return;
    }

    if (!form.contactNumber.trim()) {
      setStatusMessage("Patient contact number is required.");
      return;
    }

    if (!form.gravida.trim() || !form.para.trim()) {
      setStatusMessage("Gravida and Para are required.");
      setStep(2);
      return;
    }

    const ageAtMenarche = parseOptionalNumber(form.ageMenarche);

    if (!isNumberInRange(ageAtMenarche, 8, 25)) {
      setStep(2);
      setStatusMessage(
        "Age at Menarche must be between 8 and 25 years old. Leave it blank if unknown."
      );
      return;
    }

    const cycleLength = parseOptionalNumber(form.cycleLength);

    if (
      cycleLength !== null &&
      (cycleLength < 15 || cycleLength > 60)
    ) {
      setStep(2);
      setStatusMessage(
        "Cycle Length must be between 15 and 60 days. Example: 28."
      );
      return;
    }

    const menstruationDuration = parseOptionalNumber(
      form.durationMenstruation
    );

    if (
      menstruationDuration !== null &&
      (menstruationDuration < 1 || menstruationDuration > 15)
    ) {
      setStep(2);
      setStatusMessage(
        "Duration of Menstruation must be between 1 and 15 days. Example: 5."
      );
      return;
    }

    setIsSavingPatient(true);

    let savedPatient = null;
    let savedPersonalInfoId = null;
    let workingCredentials = accessCredentials;
    const optionalWarnings = [];

    try {
      // The displayed ID may become stale if another registration or a
      // previous partial save already used it. Retry with freshly generated
      // credentials whenever Supabase reports a duplicate ID/control number.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const patientResult = await insertPatientRecord(workingCredentials);

        if (!patientResult.error) {
          savedPatient = patientResult.data;
          break;
        }

        if (
          !isDuplicatePatientCredentialError(patientResult.error) ||
          attempt === 4
        ) {
          throw patientResult.error;
        }

        console.warn(
          `Duplicate patient credential detected on attempt ${attempt + 1}. Generating a fresh ID.`,
          patientResult.error
        );

        workingCredentials = await createFreshReservedCredentials();
      }

      if (!savedPatient) {
        throw new Error(
          "Unable to generate a unique patient ID after several attempts."
        );
      }

      setAccessCredentials(workingCredentials);

      const {
        data: savedPersonalInfo,
        error: personalInfoError,
      } = await insertPersonalInfoRecord(savedPatient, workingCredentials);

      if (personalInfoError) {
        console.warn("Patient personal information save failed:", personalInfoError);
        optionalWarnings.push(
          `patient_personal_information: ${personalInfoError.message}`
        );
      } else {
        savedPersonalInfoId = savedPersonalInfo.id;
      }

      const emergencyPayload = savedPersonalInfoId
        ? createEmergencyContactPayload(form, savedPersonalInfoId)
        : null;

      if (emergencyPayload) {
        const { error: emergencyError } = await supabase
          .from("patient_emergency_contact")
          .insert([emergencyPayload]);

        if (emergencyError) {
          console.warn("Emergency contact save failed:", emergencyError);
          optionalWarnings.push(
            `patient_emergency_contact: ${emergencyError.message}`
          );
        }
      }

      const relatedPatientRecords = [
        {
          table: "patient_obstetric_history",
          payload: createObstetricHistoryPayload(form, savedPatient),
        },
        {
          table: "patient_medical_history",
          payload: createMedicalHistoryPayload(form, savedPatient),
        },
        {
          table: "patient_initial_assessment",
          payload: createInitialAssessmentPayload(form, savedPatient),
        },
      ];

      for (const record of relatedPatientRecords) {
        const warning = await saveOptionalPatientRecord(
          record.table,
          record.payload
        );

        if (warning) {
          optionalWarnings.push(warning);
        }
      }

      const { data: patientLoginData, error: patientLoginError } =
        await savePatientLoginCredential(
          createPatientLoginPayload(
            form,
            savedPatient,
            workingCredentials
          )
        );

      if (patientLoginError) {
        console.warn("Patient login credential save failed:", patientLoginError);

        if (!isPatientLoginPolicyError(patientLoginError)) {
          optionalWarnings.push(`patient_login: ${patientLoginError.message}`);
        }
      }

      const savedLoginCredentials = toCredentialEntry(
        patientLoginData || workingCredentials
      );
      const newPatient = mapSupabasePatient(savedPatient);
      const shouldDisplayNewPatient = isActivePatientRow(savedPatient);
      const nextCredentialPool = addCredentialsToPool(
        addCredentialsToPool(credentialPool, savedLoginCredentials),
        newPatient
      );

      setPatients((current) =>
        shouldDisplayNewPatient ? [newPatient, ...current] : current
      );
      setCredentialPool(nextCredentialPool);
      setForm(blankForm);
      setAccessCredentials(createAccessCredentials(nextCredentialPool));
      setStep(1);
      setScreen("list");
      setActiveModal("saved");
      if (optionalWarnings.length) {
        setStatusMessage(
          `Patient saved in Supabase. Some optional details were not saved: ${optionalWarnings.join(
            " | "
          )}`
        );
      }
    } catch (error) {
      console.error("Register patient failed:", error);

      const cleanupErrors = savedPatient?.id
        ? await cleanupPartialRegistration({
            patientRecordId: savedPatient.id,
            personalInfoId: savedPersonalInfoId,
          })
        : [];

      if (cleanupErrors.length) {
        setStatusMessage(
          `Unable to complete registration: ${error.message}. Some partial data could not be removed: ${cleanupErrors.join(
            " | "
          )}`
        );
      } else {
        setStatusMessage(`Unable to complete registration: ${error.message}`);
      }
    } finally {
      setIsSavingPatient(false);
    }
  };

  const closeModal = () => {
    setActiveModal(null);
  };

  const renderStepContent = () => {
    if (step === 1) {
      return (
        <section className="staff-register-card">
          <header>
            <span>
              <Icon icon="solar:document-medicine-linear" aria-hidden="true" />
            </span>
            <h3>1. Basic Information</h3>
          </header>

          <div className="staff-register-grid">
            <InputField
              label="Patient's Name"
              required
              value={form.name}
              onChange={(value) => updateForm("name", value)}
              placeholder="Enter Full Name"
              className="is-wide"
            />
            <InputField
              label="Age"
              required
              value={form.age}
              onChange={(value) => updateForm("age", value)}
            />
            <InputField
              label="Birthdate"
              required
              type="date"
              value={form.birthdate}
              onChange={(value) => updateForm("birthdate", value)}
              icon="solar:calendar-linear"
            />
            <InputField
              label="Home Address"
              required
              value={form.address}
              onChange={(value) => updateForm("address", value)}
              placeholder="House no., Street, Barangay, City/Municipality"
              className="is-full"
            />
            <InputField
              label="Contact Number"
              required
              value={form.contactNumber}
              onChange={(value) => updateForm("contactNumber", value)}
              placeholder="09XXXXXXXXX"
              className="is-half"
            />
            <InputField
              label="Occupation"
              value={form.occupation}
              onChange={(value) => updateForm("occupation", value)}
              className="is-half"
            />
            <InputField
              label="Work Address"
              value={form.workAddress}
              onChange={(value) => updateForm("workAddress", value)}
              className="is-half"
            />
            <InputField
              label="Company"
              value={form.company}
              onChange={(value) => updateForm("company", value)}
              className="is-half"
            />
            <InputField
              label="Work Contact Number"
              value={form.workContactNumber}
              onChange={(value) => updateForm("workContactNumber", value)}
              className="is-half"
            />
            <InputField
              label="Email Address"
              value={form.email}
              onChange={(value) => updateForm("email", value)}
              className="is-half"
            />
            <InputField
              label="Husband/Partner"
              value={form.husbandPartner}
              onChange={(value) => updateForm("husbandPartner", value)}
              className="is-half"
            />
            <InputField
              label="Contact Number"
              value={form.partnerContactNumber}
              onChange={(value) => updateForm("partnerContactNumber", value)}
              className="is-half"
            />
          </div>

          <footer className="staff-register-footer is-end">
            <button type="button" className="staff-next-btn" onClick={() => setStep(2)}>
              Next
              <Icon icon="solar:arrow-right-linear" aria-hidden="true" />
            </button>
          </footer>
        </section>
      );
    }

    if (step === 2) {
      return (
        <section className="staff-register-card">
          <header>
            <span>
              <Icon icon="solar:document-medicine-linear" aria-hidden="true" />
            </span>
            <h3>2. Reproductive & Obstetric History</h3>
          </header>

          <div className="staff-register-grid is-three">
            <InputField
              label="Age at Menarche"
              value={form.ageMenarche}
              onChange={(value) => updateForm("ageMenarche", value)}
              placeholder="Enter age"
            />
            <RadioGroup
              label="Menstrual Pattern"
              value={form.menstrualPattern}
              onChange={(value) => updateForm("menstrualPattern", value)}
              options={["Regular", "Irregular"]}
            />
            <InputField
              label="Cycle Length"
              value={form.cycleLength}
              onChange={(value) => updateForm("cycleLength", value)}
              placeholder="Enter days"
            />
            <InputField
              label="Duration of Menstruation"
              value={form.durationMenstruation}
              onChange={(value) => updateForm("durationMenstruation", value)}
              placeholder="Enter days"
            />
            <RadioGroup
              label="Sexually Active"
              value={form.sexuallyActive}
              onChange={(value) => updateForm("sexuallyActive", value)}
              options={["Yes", "No"]}
            />
            <SelectField
              label="Contraceptive Method Used"
              value={form.contraceptiveMethod}
              onChange={(value) => updateForm("contraceptiveMethod", value)}
            >
              <option value="">Select method</option>
              {contraceptiveMethodOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </SelectField>
            <div className="staff-step2-two-column is-full">
              <InputField
                label="Gravida (G)"
                required
                value={form.gravida}
                onChange={(value) => updateForm("gravida", value)}
                placeholder="Enter number"
              />
              <InputField
                label="Para (P)"
                required
                value={form.para}
                onChange={(value) => updateForm("para", value)}
                placeholder="Enter number"
              />
              <InputField
                label="Last Menstrual Period (LMP)"
                type="date"
                value={form.lmp}
                onChange={(value) => updateForm("lmp", value)}
              />
              <InputField
                label="Estimated Due Date (EDD)"
                type="date"
                value={form.edd}
                onChange={(value) => updateForm("edd", value)}
              />
            </div>
          </div>

          <div className="staff-pregnancy-table-actions">
            <button type="button" onClick={addPregnancyRecord}>
              <Icon icon="solar:add-circle-linear" aria-hidden="true" />
              Add Pregnancy
            </button>
          </div>

          <div className="staff-pregnancy-table-wrap">
            <table className="staff-pregnancy-table">
              <thead>
                <tr>
                  <th>Birthdate</th>
                  <th>Term / Preterm</th>
                  <th>Type of Delivery</th>
                  <th>Place of Delivery</th>
                  <th>Complications</th>
                  <th>NBS Result</th>
                </tr>
              </thead>
              <tbody>
                {form.pregnancyRecords.length ? (
                  form.pregnancyRecords.map((record, index) => (
                    <tr key={`pregnancy-record-${index}`}>
                      <td>
                        <input
                          type="date"
                          value={record.birthdate}
                          onChange={(event) =>
                            updatePregnancyRecord(index, "birthdate", event.target.value)
                          }
                          aria-label="Pregnancy birthdate"
                        />
                      </td>
                      <td>
                        <select
                          value={record.termPreterm}
                          onChange={(event) =>
                            updatePregnancyRecord(index, "termPreterm", event.target.value)
                          }
                          aria-label="Term or preterm"
                        >
                          <option value="">Select</option>
                          <option value="Term">Term</option>
                          <option value="Preterm">Preterm</option>
                          <option value="Post-term">Post-term</option>
                        </select>
                      </td>
                      <td>
                        <select
                          value={record.deliveryType}
                          onChange={(event) =>
                            updatePregnancyRecord(index, "deliveryType", event.target.value)
                          }
                          aria-label="Type of delivery"
                        >
                          <option value="">Select</option>
                          <option value="Normal Spontaneous Vaginal Delivery">
                            Normal Spontaneous Vaginal Delivery
                          </option>
                          <option value="Cesarean Section">Cesarean Section</option>
                          <option value="Assisted Vaginal Delivery">
                            Assisted Vaginal Delivery
                          </option>
                        </select>
                      </td>
                      <td>
                        <input
                          type="text"
                          value={record.deliveryPlace}
                          onChange={(event) =>
                            updatePregnancyRecord(index, "deliveryPlace", event.target.value)
                          }
                          placeholder="Enter place"
                          aria-label="Place of delivery"
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={record.complications}
                          onChange={(event) =>
                            updatePregnancyRecord(index, "complications", event.target.value)
                          }
                          placeholder="None"
                          aria-label="Complications"
                        />
                      </td>
                      <td>
                        <select
                          value={record.nbsResult}
                          onChange={(event) =>
                            updatePregnancyRecord(index, "nbsResult", event.target.value)
                          }
                          aria-label="NBS result"
                        >
                          <option value="">Select</option>
                          <option value="Normal">Normal</option>
                          <option value="Abnormal">Abnormal</option>
                          <option value="Pending">Pending</option>
                          <option value="Not Done">Not Done</option>
                        </select>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan="6">No pregnancy record added yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <footer className="staff-register-footer">
            <button type="button" className="staff-prev-btn" onClick={() => setStep(1)}>
              <Icon icon="solar:arrow-left-linear" aria-hidden="true" />
              Previous
            </button>
            <button type="button" className="staff-next-btn" onClick={() => setStep(3)}>
              Next
              <Icon icon="solar:arrow-right-linear" aria-hidden="true" />
            </button>
          </footer>
        </section>
      );
    }

    if (step === 3) {
      return (
        <section className="staff-register-card">
          <header>
            <span>
              <Icon icon="solar:document-medicine-linear" aria-hidden="true" />
            </span>
            <h3>3. Medical & Family History</h3>
          </header>

          <div className="staff-register-grid">
            <SelectField
              label="Blood Type"
              value={form.bloodType}
              onChange={(value) => updateForm("bloodType", value)}
              className="is-half"
            >
              <option value="">Select blood type</option>
              {bloodTypeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </SelectField>

            <div className="staff-allergy-group is-full">
              <label>Allergies</label>
              <div>
                <SelectField
                  label=""
                  value={form.allergyOne}
                  onChange={(value) => updateForm("allergyOne", value)}
                >
                  <option value="">Enter Allergen</option>
                  {allergyTypeOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  value={form.allergyTwo}
                  onChange={(value) => updateForm("allergyTwo", value)}
                >
                  <option value="">Enter Allergen</option>
                  {allergyTypeOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  value={form.allergyThree}
                  onChange={(value) => updateForm("allergyThree", value)}
                >
                  <option value="">Enter Allergen</option>
                  {allergyTypeOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </SelectField>
                <button type="button" aria-label="Add allergy">
                  <Icon icon="solar:add-circle-linear" aria-hidden="true" />
                </button>
              </div>
            </div>

            <section className="staff-check-section is-full">
              <h4>History of Medical Conditions <span>(Check all that apply)</span></h4>

              <div className="staff-check-columns is-medical">
                <div className="staff-check-column">
                  {["Hypertension", "Diabetes Mellitus", "Asthma", "Kidney Disease"].map((option) => (
                    <CheckboxItem
                      key={option}
                      label={option}
                      checked={form.medicalConditions.includes(option)}
                      onChange={(checked) =>
                        toggleArrayValue("medicalConditions", option, checked)
                      }
                    />
                  ))}
                </div>

                <div className="staff-check-column">
                  {["Thyroid Disorder", "Others"].map((option) => (
                    <CheckboxItem
                      key={option}
                      label={option}
                      checked={form.medicalConditions.includes(option)}
                      onChange={(checked) =>
                        toggleArrayValue("medicalConditions", option, checked)
                      }
                    />
                  ))}

                  <InputField
                    label=""
                    value={form.medicalOther}
                    onChange={(value) => updateForm("medicalOther", value)}
                    placeholder="Specify"
                    className="staff-specify-field"
                  />
                </div>
              </div>
            </section>

            <section className="staff-check-section is-full">
              <h4>Family History <span>(Check all that applies)</span></h4>

              <div className="staff-check-columns is-family">
                <div className="staff-check-column">
                  {["Hypertension", "Diabetes Mellitus", "Asthma", "Tuberculosis"].map((option) => (
                    <CheckboxItem
                      key={option}
                      label={option}
                      checked={form.familyHistory.includes(option)}
                      onChange={(checked) =>
                        toggleArrayValue("familyHistory", option, checked)
                      }
                    />
                  ))}
                </div>

                <div className="staff-check-column">
                  {["Cancer", "Goiter", "Heart Disease", "Twin Pregnancy"].map((option) => (
                    <CheckboxItem
                      key={option}
                      label={option}
                      checked={form.familyHistory.includes(option)}
                      onChange={(checked) =>
                        toggleArrayValue("familyHistory", option, checked)
                      }
                    />
                  ))}
                </div>

                <div className="staff-check-column">
                  <CheckboxItem
                    label="Others"
                    checked={form.familyHistory.includes("Others")}
                    onChange={(checked) =>
                      toggleArrayValue("familyHistory", "Others", checked)
                    }
                  />

                  <InputField
                    label=""
                    value={form.familyOther}
                    onChange={(value) => updateForm("familyOther", value)}
                    placeholder="Specify"
                    className="staff-specify-field"
                  />
                </div>
              </div>
            </section>
          </div>

          <footer className="staff-register-footer">
            <button type="button" className="staff-prev-btn" onClick={() => setStep(2)}>
              <Icon icon="solar:arrow-left-linear" aria-hidden="true" />
              Previous
            </button>
            <button type="button" className="staff-next-btn" onClick={() => setStep(4)}>
              Next
              <Icon icon="solar:arrow-right-linear" aria-hidden="true" />
            </button>
          </footer>
        </section>
      );
    }

    return (
      <section className="staff-register-card">
        <header>
          <span>
            <Icon icon="solar:document-medicine-linear" aria-hidden="true" />
          </span>
          <h3>4. Initial Assessment</h3>
        </header>

        <div className="staff-register-grid is-three">
          <RadioGroup
            label="HPV Vaccination"
            value={form.hpvVaccination}
            onChange={(value) => updateForm("hpvVaccination", value)}
            options={["Yes", "No"]}
          />
          <InputField
            label="Last Pap Smear"
            type="date"
            value={form.lastPapSmear}
            onChange={(value) => updateForm("lastPapSmear", value)}
          />
          <InputField
            label="Others"
            value={form.assessmentOthers}
            onChange={(value) => updateForm("assessmentOthers", value)}
            placeholder="Enter details (if any)"
          />
          <InputField
            label="Height"
            value={form.height}
            onChange={(value) => updateForm("height", value)}
            placeholder="Enter cm"
          />
          <InputField
            label="Weight"
            value={form.weight}
            onChange={(value) => updateForm("weight", value)}
            placeholder="Enter kg"
          />
          <InputField
            label="Blood Pressure"
            value={form.bloodPressure}
            onChange={(value) => updateForm("bloodPressure", value)}
            placeholder="--- / ---"
          />
          <InputField
            label="Temperature"
            value={form.temperature}
            onChange={(value) => updateForm("temperature", value)}
            placeholder="Enter C"
          />
          <InputField
            label="Respiratory Rate"
            value={form.respiratoryRate}
            onChange={(value) => updateForm("respiratoryRate", value)}
            placeholder="Enter /min"
          />
          <InputField
            label="Oxygen Saturation"
            value={form.oxygenSaturation}
            onChange={(value) => updateForm("oxygenSaturation", value)}
            placeholder="Enter %"
          />

          <label className="staff-register-field is-full">
            <span>Remarks</span>
            <textarea
              value={form.remarks}
              onChange={(event) => updateForm("remarks", event.target.value)}
              placeholder="Enter remarks or notes"
            />
          </label>
        </div>

        <footer className="staff-register-footer has-divider">
          <button type="button" className="staff-prev-btn" onClick={() => setStep(3)}>
            <Icon icon="solar:arrow-left-linear" aria-hidden="true" />
            Previous
          </button>
          <button
            type="button"
            className="staff-next-btn"
            onClick={savePatient}
            disabled={isSavingPatient}
          >
            {isSavingPatient ? "Saving..." : "Save Patient Record"}
          </button>
        </footer>
      </section>
    );
  };

  if (screen === "register") {
    return (
      <section className="staff-register-page">
        <div className="staff-register-shell">
          <button type="button" className="staff-back-btn" onClick={backToPatients}>
            <Icon icon="solar:arrow-left-linear" aria-hidden="true" />
            Back to Patients
          </button>

          <div className="staff-register-hero-grid">
            <div className="staff-register-hero-main">
              <div className="staff-register-top">
                <div>
                  <h2>Register New Patient</h2>
                  <p>Fill-out the patient information to create a new record</p>
                </div>
              </div>

              <Stepper currentStep={step} onStepSelect={setStep} />
              {statusMessage ? (
                <p className="staff-patients-status-message">{statusMessage}</p>
              ) : null}
            </div>

            <PatientRegisterSuccessCard />
          </div>

          <div className="staff-register-layout">
            <main className="staff-register-main">
              {renderStepContent()}
            </main>

            <CredentialsPanel credentials={accessCredentials} />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="staff-patients-page">
      <header className="staff-patients-header staff-section-header">
        <div>
          <h2>Patients</h2>
          <p>Manage and view patient information across your practice.</p>
        </div>

        {headerAction}
      </header>

      <div className="staff-patients-actions">
        <label className="staff-patients-search">
          <Icon icon="solar:magnifer-linear" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name or ID"
            aria-label="Search patients by name or ID"
          />
        </label>

        <button type="button" className="staff-register-patient-btn" onClick={openRegister}>
          <Icon icon="solar:add-circle-linear" aria-hidden="true" />
          <span>Register Patient</span>
        </button>
      </div>

      {isLoadingPatients || statusMessage ? (
        <p className="staff-patients-status-message">
          {isLoadingPatients ? "Loading patients from Supabase..." : statusMessage}
        </p>
      ) : null}

      <section className="staff-patients-card" aria-label="Patients table">
        <div className="staff-patients-table-scroll">
          <table className="staff-patients-table">
            <thead>
              <tr>
                <th>
                  <button type="button" onClick={() => requestSort("name")}>
                    Name
                    <Icon icon="solar:sort-vertical-linear" aria-hidden="true" />
                  </button>
                </th>
                <th>
                  <button type="button" onClick={() => requestSort("id")}>
                    Patient ID
                    <Icon icon="solar:sort-vertical-linear" aria-hidden="true" />
                  </button>
                </th>
                <th>
                  <button type="button" onClick={() => requestSort("birthdate")}>
                    Date of Birth
                    <Icon icon="solar:sort-vertical-linear" aria-hidden="true" />
                  </button>
                </th>
                <th>Medical Records</th>
              </tr>
            </thead>

            <tbody>
              {filteredPatients.map((patient) => (
                <tr key={patient.id}>
                  <td>
                    <div className="staff-patient-info-cell">
                      <span className={`staff-patient-avatar avatar-${patient.tone}`}>
                        {patient.initials}
                      </span>

                      <span className="staff-patient-name-wrap">
                        <strong>{patient.name}</strong>
                        <small>
                          {patient.gender} • {patient.age}
                        </small>
                      </span>
                    </div>
                  </td>

                  <td>
                    <span className="staff-patient-id">{patient.id}</span>
                  </td>

                  <td>
                    <span className="staff-patient-date">{patient.birthdate}</span>
                  </td>

                  <td>
                    <button
                      type="button"
                      className="staff-patient-view-btn"
                      onClick={() => setActiveModal("restricted")}
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}

              {!filteredPatients.length ? (
                <tr>
                  <td colSpan="4" className="staff-patients-empty-cell">
                    <Icon icon="solar:magnifer-linear" aria-hidden="true" />
                    <strong>No patients found</strong>
                    <span>Try a different name, ID, or birthdate.</span>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {activeModal ? (
        <div className="staff-patients-modal-backdrop" role="presentation" onClick={closeModal}>
          <section
            className="staff-patients-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="staff-patients-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            {activeModal === "saved" ? (
              <>
                <div className="staff-patients-modal-icon is-success">
                  <Icon icon="solar:check-circle-bold" aria-hidden="true" />
                </div>
                <h3 id="staff-patients-modal-title">Patient Saved</h3>
                <p>The patient record has been added to the patients list.</p>
                <button type="button" onClick={closeModal}>OK</button>
              </>
            ) : (
              <>
                <div className="staff-patients-modal-icon is-warning">
                  <Icon icon="solar:danger-triangle-bold" aria-hidden="true" />
                </div>
                <h3 id="staff-patients-modal-title">Access Restricted</h3>
                <p>You do not have permission to view the medical record of this patient.</p>
                <p>Please contact an authorized medical staff for assistance.</p>
                <button type="button" onClick={closeModal}>OK</button>
              </>
            )}
          </section>
        </div>
      ) : null}
    </section>
  );
}

export default StaffPatientsContent;
