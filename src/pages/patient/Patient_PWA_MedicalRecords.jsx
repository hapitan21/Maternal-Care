import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { supabase } from "../../lib/supabaseClient";
import { PatientPageHeader } from "../../components/patient/PatientPwaUi";
import "../../styles/patient-PWA-medicalrecords.css";

const medicalRecordColumns =
  "id, patient_id, schedule_id, doctor_id, patient_name, type, title, notes, file_name, file_type, file_data_url, form_data, uploaded_at, uploaded_by";

const findingUnits = {
  "blood pressure": "mmHg",
  weight: "kg",
  temperature: "C",
  temp: "C",
  "heart rate": "bpm",
  height: "cm",
  bmi: "kg/m2",
  "fundal height": "cm",
  "fetal heart rate": "bpm",
};

function getFormData(row) {
  return row?.form_data && typeof row.form_data === "object" ? row.form_data : {};
}

function cleanRecordValue(value) {
  if (value === null || value === undefined || typeof value === "object") return "";
  const clean = String(value).trim();
  return clean && clean !== "-" ? clean : "";
}

function toList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }

  if (!value) return [];

  return String(value)
    .split(/\r?\n|;/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinValues(values, fallback = "-") {
  const cleanValues = values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return cleanValues.length ? cleanValues.join(", ") : fallback;
}

function formatYesNo(value) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "-";
}

function normalizeDateSource(value, fallback) {
  return value || fallback || "";
}

function toValidDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatLongDate(value, fallback = "-") {
  if (!value) return fallback;
  const date = toValidDate(value);

  if (!date) {
    return String(value);
  }

  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatDayTime(dateValue, timeValue) {
  const date = toValidDate(dateValue);
  const day = date
    ? date.toLocaleDateString("en-US", { weekday: "long" })
    : "Visit";

  if (timeValue) {
    return `${day} - ${timeValue}`;
  }

  if (!date) return day;

  return `${day} - ${date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function normalizeFinding(item) {
  if (typeof item === "string") {
    return {
      label: item,
      value: "-",
      unit: "",
    };
  }

  const label = item?.label || item?.name || "Finding";
  const rawValue = item?.value ?? item?.result ?? "-";
  const normalizedLabel = String(label).trim().toLowerCase();

  return {
    label,
    value: String(rawValue || "-"),
    unit: item?.unit || findingUnits[normalizedLabel] || "",
  };
}

function normalizeFindings(formData) {
  const clinicalFindings =
    formData.clinicalFindings && typeof formData.clinicalFindings === "object"
      ? formData.clinicalFindings
      : {};

  if (Array.isArray(formData.findings) && formData.findings.length) {
    return formData.findings.map(normalizeFinding);
  }

  return [
    { label: "Blood Pressure", value: clinicalFindings.bloodPressure || formData.bloodPressure || "-", unit: "mmHg" },
    { label: "Weight", value: clinicalFindings.weight || formData.weight || "-", unit: "kg" },
    { label: "Temp", value: clinicalFindings.temperature || formData.temperature || "-", unit: "C" },
    { label: "Heart Rate", value: clinicalFindings.heartRate || formData.heartRate || "-", unit: "bpm" },
    { label: "Height", value: clinicalFindings.height || formData.height || "-", unit: "cm" },
    { label: "BMI", value: clinicalFindings.bmi || formData.bmi || "-", unit: "kg/m2" },
    { label: "Fetal Heart Rate", value: clinicalFindings.fetalHeartRate || formData.fetalHeartRate || "-", unit: "bpm" },
    { label: "Fundal Height", value: clinicalFindings.fundalHeight || formData.fundalHeight || "-", unit: "cm" },
  ];
}

function normalizeAssessment(formData, row) {
  const values = [
    ...toList(formData.assessment),
    ...toList(formData.symptoms),
    ...toList(formData.dangerSigns),
    ...toList(formData.additionalNotes),
  ];

  if (values.length) return values;

  return toList(row.notes || row.title || "No assessment recorded.");
}

function normalizeTreatment(formData) {
  const values = [
    ...toList(formData.treatment),
    ...toList(formData.treatmentPlan),
    ...toList(formData.followUpInstructions),
  ];

  return values.length ? values : ["No treatment plan recorded."];
}

function normalizeObstetric(formData) {
  const obstetric = Array.isArray(formData.obstetric) ? formData.obstetric : [];
  const pregnancyStatus =
    formData.pregnancyStatus && typeof formData.pregnancyStatus === "object"
      ? formData.pregnancyStatus
      : {};

  if (obstetric.length) {
    return obstetric.map((item) => ({
      label: item.label || item.name || "Information",
      value: item.value || "-",
      wide: Boolean(item.wide),
    }));
  }

  return [
    {
      label: "Gestational Age",
      value: pregnancyStatus.gestationalAge || formData.gestationalAge || "-",
    },
    {
      label: "Pregnancy Status",
      value: pregnancyStatus.riskLevel || cleanRecordValue(formData.pregnancyStatus) || "-",
    },
    {
      label: "Expected Delivery Date",
      value: pregnancyStatus.expectedDeliveryDate || formData.expectedDeliveryDate || "-",
      wide: true,
    },
    {
      label: "Follow-up Date",
      value: formData.followUpDate || "-",
      wide: true,
    },
  ];
}

function getAttachmentMeta(row) {
  if (!row.file_name) {
    return null;
  }

  return {
    name: row.file_name,
    type: row.file_type || "File",
    url: row.file_data_url || "",
  };
}

function mapMedicalRecord(row) {
  const formData = getFormData(row);
  const visitDate = normalizeDateSource(formData.visitDate, row.uploaded_at);
  const displayDate = formatLongDate(visitDate);
  const dayTime = formatDayTime(visitDate || row.uploaded_at, formData.visitTime);
  const complaint =
    formData.chiefComplaint ||
    formData.complaint ||
    row.notes ||
    row.title ||
    "No chief complaint recorded.";
  const diagnosis =
    formData.diagnosis ||
    formData.assessment ||
    row.title ||
    row.type ||
    "Medical Record";

  const appointmentReference = formatAppointmentReference(
    formData.displayAppointmentId ||
      formData.appointmentId ||
      formData.maternalAppointmentId ||
      ""
  );

  return {
    id: row.id,
    date: displayDate,
    dayTime,
    visitType: formData.visitType || row.type || row.title || "Medical Record",
    gestationalAge: formData.gestationalAge || "Not recorded",
    doctor: formData.doctor || row.uploaded_by || "Doctor not recorded",
    appointmentReference,
    createdDate: formatLongDate(row.uploaded_at, "Not recorded"),
    updatedDate: formData.updatedAt || "Not recorded",
    recordStatus: formatStatusLabel(formData.recordStatus || formData.status),
    complaint,
    symptoms: formData.symptoms || "Not recorded",
    findings: normalizeFindings(formData),
    assessment: normalizeAssessment(formData, row),
    obstetric: normalizeObstetric(formData),
    treatment: normalizeTreatment(formData),
    diagnosis,
    prescriptions: toList(formData.prescriptions),
    diagnosticResults: toList(formData.diagnosticResults),
    attachment: getAttachmentMeta(row),
    sortTime: toValidDate(visitDate || row.uploaded_at)?.getTime() || 0,
  };
}

function formatAppointmentReference(value) {
  const text = String(value || "").trim();
  if (!text) return "No appointment reference";

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
    return text.slice(0, 8);
  }

  return text.length > 24 ? text.slice(0, 8) : text;
}

function formatStatusLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "Not recorded";

  return text
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function hasMeaningfulRecordValue(value) {
  const text = String(value || "").trim();
  return Boolean(
    text &&
      !["not recorded", "no appointment reference", "n/a", "not provided"].includes(
        text.toLowerCase()
      )
  );
}

function mapRegistrationMedicalRecord(patient, obstetric, medicalHistory, assessment) {
  const createdAt =
    assessment?.updated_at ||
    obstetric?.updated_at ||
    medicalHistory?.updated_at ||
    patient?.created_at ||
    new Date().toISOString();
  const findings = [
    {
      label: "Blood Pressure",
      value: assessment?.blood_pressure || "-",
      unit: "mmHg",
    },
    {
      label: "Weight",
      value: assessment?.weight_kg || "-",
      unit: "kg",
    },
    {
      label: "Temp",
      value: assessment?.temperature_celsius || "-",
      unit: "C",
    },
    {
      label: "Resp. Rate",
      value: assessment?.respiratory_rate || "-",
      unit: "breaths/min",
    },
    {
      label: "Oxygen Saturation",
      value: assessment?.oxygen_saturation || "-",
      unit: "%",
    },
    {
      label: "Blood Type",
      value: patient?.blood_type || "-",
      unit: "",
    },
  ];
  const assessmentItems = [
    patient?.medical_notes,
    assessment?.assessment_others,
    assessment?.remarks,
    medicalHistory?.other_medical_condition
      ? `Other medical condition: ${medicalHistory.other_medical_condition}`
      : "",
    medicalHistory?.other_family_history
      ? `Other family history: ${medicalHistory.other_family_history}`
      : "",
  ];
  const allergies = joinValues(
    [medicalHistory?.allergies, patient?.allergies],
    ""
  );
  const conditions = joinValues(
    [medicalHistory?.medical_conditions, patient?.chronic_illness],
    ""
  );
  const familyHistory = joinValues([medicalHistory?.family_history], "");
  const treatment = [
    allergies ? `Allergies: ${allergies}` : "",
    conditions ? `Medical conditions: ${conditions}` : "",
    familyHistory ? `Family history: ${familyHistory}` : "",
    "Continue clinic follow-up and prescribed prenatal care.",
  ].filter(Boolean);

  return {
    id: `registration-${patient.id}`,
    date: formatLongDate(createdAt),
    dayTime: formatDayTime(createdAt),
    visitType: "Patient Registration Summary",
    gestationalAge: patient?.gestational_age || "Not recorded",
    doctor: "Doctor not recorded",
    appointmentReference: "No appointment reference",
    createdDate: formatLongDate(createdAt, "Not recorded"),
    updatedDate: "Not recorded",
    recordStatus: "Not recorded",
    complaint:
      assessment?.remarks ||
      assessment?.assessment_others ||
      patient?.medical_notes ||
      "Patient registration and initial maternal health assessment.",
    symptoms: "Not recorded",
    findings,
    assessment: toList(assessmentItems.join("\n")).length
      ? toList(assessmentItems.join("\n"))
      : ["Registered patient profile and baseline maternal care information."],
    obstetric: [
      {
        label: "Gravida / Para",
        value: `G${obstetric?.gravida ?? "-"} / P${obstetric?.para ?? "-"}`,
      },
      {
        label: "Last Menstrual Period",
        value: formatLongDate(obstetric?.last_menstrual_period, "-"),
      },
      {
        label: "Expected Delivery Date",
        value: formatLongDate(
          obstetric?.expected_delivery_date || patient?.expected_delivery_date,
          "-"
        ),
        wide: true,
      },
      {
        label: "Contraceptive Method",
        value: obstetric?.contraceptive_method || "-",
        wide: true,
      },
      {
        label: "Sexually Active",
        value: formatYesNo(obstetric?.sexually_active),
      },
      {
        label: "Menstrual Pattern",
        value: obstetric?.menstrual_pattern || "-",
      },
    ],
    treatment,
    diagnosis: patient?.trimester || patient?.status || "Registered Maternal Care Patient",
    attachment: null,
    prescriptions: [],
    diagnosticResults: [],
    sortTime: toValidDate(createdAt)?.getTime() || 0,
  };
}

async function loadPatientRow() {
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData?.user?.id) {
    if (authError) console.warn("Patient medical record authentication lookup failed:", authError);
    return null;
  }

  const { data, error } = await supabase
    .rpc("get_patient_own_record")
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("Patient medical record patient-user lookup failed:", error);
    return null;
  }

  return data || null;
}

async function loadPatientDetailRow(table, patientId) {
  if (!patientId) return null;

  const { data, error } = await supabase
    .from(table)
    .select("*")
    .eq("patient_id", patientId)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn(`Patient medical record ${table} lookup failed:`, error);
    return null;
  }

  return data || null;
}

export default function PatientPWAMedicalRecords({ profile }) {
  const [query, setQuery] = useState("");
  const [patientRecords, setPatientRecords] = useState([]);
  const [selectedRecordId, setSelectedRecordId] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let active = true;

    const loadRecords = async () => {
      setIsLoading(true);
      setLoadError("");

      const patient = await loadPatientRow();
      const { data, error } = patient?.id
        ? await supabase
            .from("medical_records")
            .select(medicalRecordColumns)
            .eq("patient_id", patient.id)
            .order("uploaded_at", { ascending: false })
        : { data: [], error: null };
      const [obstetric, medicalHistory, initialAssessment] = patient?.id
        ? await Promise.all([
            loadPatientDetailRow("patient_obstetric_history", patient.id),
            loadPatientDetailRow("patient_medical_history", patient.id),
            loadPatientDetailRow("patient_initial_assessment", patient.id),
          ])
        : [null, null, null];

      if (!active) return;

      setIsLoading(false);

      if (error) {
        console.error("Patient medical records load failed:", error);
        setLoadError(`Formal medical records could not be loaded: ${error.message}`);
      }

      const formalRecords = error ? [] : (data || []);
      const mappedRecords = formalRecords.map(mapMedicalRecord);
      const registrationRecord = patient
        ? mapRegistrationMedicalRecord(
            patient,
            obstetric,
            medicalHistory,
            initialAssessment
          )
        : null;
      const nextRecords = [
        ...mappedRecords,
        ...(registrationRecord ? [registrationRecord] : []),
      ].sort((first, second) => second.sortTime - first.sortTime);

      setPatientRecords(nextRecords);
      setSelectedRecordId((current) =>
        current && nextRecords.some((record) => record.id === current)
          ? current
          : nextRecords[0]?.id || ""
      );
    };

    loadRecords();

    const channel = supabase
      .channel("patient-pwa-medical-records")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "medical_records" },
        loadRecords
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "patients" },
        loadRecords
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "patient_obstetric_history" },
        loadRecords
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "patient_medical_history" },
        loadRecords
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "patient_initial_assessment" },
        loadRecords
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [profile]);

  const filteredRecords = useMemo(() => {
    const value = query.trim().toLowerCase();

    if (!value) return patientRecords;

    return patientRecords.filter((record) =>
      [
        record.date,
        record.dayTime,
        record.visitType,
        record.gestationalAge,
        record.doctor,
        record.complaint,
        record.diagnosis,
      ]
        .join(" ")
        .toLowerCase()
        .includes(value)
    );
  }, [patientRecords, query]);

  const selectedRecord = useMemo(() => {
    return (
      filteredRecords.find((record) => record.id === selectedRecordId) ||
      filteredRecords[0] ||
      null
    );
  }, [filteredRecords, selectedRecordId]);

  return (
    <section className="pwa-page pwa-medical-page">
      <PatientPageHeader
        title="My Medical Record"
        subtitle="Review visit summaries, clinical findings, and care plans from your clinic."
        className="pwa-medical-title"
      />

      <label className="pwa-medical-search" aria-label="Search medical records">
        <Icon icon="solar:magnifer-linear" />
        <input
          type="search"
          placeholder={isLoading ? "Loading records..." : "Search medical records..."}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          disabled={isLoading}
        />
      </label>

      {loadError ? (
        <p className="pwa-medical-alert">{loadError}</p>
      ) : null}

      {filteredRecords.length > 1 ? (
        <div className="pwa-medical-record-tabs" aria-label="Medical record list">
          {filteredRecords.map((record) => (
            <button
              key={record.id}
              type="button"
              className={record.id === selectedRecord?.id ? "is-active" : ""}
              onClick={() => setSelectedRecordId(record.id)}
              title={record.visitType}
              aria-label={`${record.date}, ${record.visitType}`}
            >
              <span>{record.date}</span>
              <strong>{record.visitType}</strong>
            </button>
          ))}
        </div>
      ) : null}

      {!selectedRecord ? (
        <section
          className={`pwa-medical-empty ${isLoading ? "is-loading" : ""}`}
          aria-busy={isLoading}
          role="status"
        >
          <span aria-hidden="true">
            <Icon
              icon={isLoading ? "solar:refresh-circle-bold" : "solar:folder-open-linear"}
            />
          </span>
          <div>
            <h2>
              {isLoading
                ? "Loading medical records"
                : patientRecords.length
                  ? "No matching medical record found"
                  : "No medical records available yet"}
            </h2>
            <p>
              {isLoading
                ? "Checking your latest clinic records."
                : patientRecords.length
                  ? "Try searching by visit date, doctor, visit type, or diagnosis."
                  : "Completed consultations will appear here once your clinic publishes them."}
            </p>
          </div>
        </section>
      ) : (
        <MedicalRecordCard record={selectedRecord} />
      )}
    </section>
  );
}

function MedicalRecordCard({ record }) {
  return (
    <section className="pwa-medical-card">
      <aside className="pwa-medical-side">
        <div className="pwa-medical-record-date">
          <div>
            <h2>
              <Icon icon="solar:calendar-linear" />
              {record.date}
            </h2>
            <p>{record.dayTime}</p>
          </div>
          <mark>{record.recordStatus}</mark>
        </div>

        <div className="pwa-medical-primary-meta">
          <MedicalMeta
            icon="solar:camera-bold-duotone"
            label="Visit Type"
            value={record.visitType}
            tone="pink"
          />
          <MedicalMeta
            icon="solar:clock-circle-bold-duotone"
            label="Gestational Age"
            value={record.gestationalAge}
            tone="blue"
          />
          <MedicalMeta
            icon="solar:user-rounded-bold-duotone"
            label="Doctor"
            value={record.doctor}
            tone="violet"
          />
        </div>

        <details className="pwa-medical-secondary-meta">
          <summary>
            <span>Record details</span>
            <Icon icon="solar:alt-arrow-down-linear" aria-hidden="true" />
          </summary>
          <div>
            <MedicalMeta
              icon="solar:calendar-mark-bold-duotone"
              label="Appointment Reference"
              value={record.appointmentReference}
              tone="pink"
            />
            <MedicalMeta
              icon="solar:document-add-bold-duotone"
              label="Created"
              value={record.createdDate}
              tone="blue"
            />
            <MedicalMeta
              icon="solar:refresh-circle-bold-duotone"
              label="Last Updated"
              value={record.updatedDate}
              tone="violet"
            />
          </div>
        </details>
      </aside>

      <article className="pwa-medical-body">
        <header className="pwa-medical-body-header">
          <span>Visit summary</span>
          <h2>{record.visitType}</h2>
          <p>{record.doctor} · {record.gestationalAge}</p>
        </header>

        <div className="pwa-medical-top-grid">
          <section className="pwa-record-section pwa-chief-section">
            <SectionTitle title="Chief Complaint" />
            <p>{record.complaint}</p>
            <h3>Symptoms / Concerns</h3>
            <p>{record.symptoms}</p>
          </section>

          <section className="pwa-record-section pwa-findings-section">
            <SectionTitle title="Clinical Findings" />
            <div className="pwa-findings-grid">
              {record.findings.map((item) => (
                <div key={`${item.label}-${item.value}`}>
                  <small>{item.label}</small>
                  <strong>{item.value}</strong>
                  <span>{item.unit}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="pwa-record-section pwa-assessment-section">
            <SectionTitle title="Assessment" />
            <ul className="pwa-assessment-list">
              {record.assessment.map((item) => (
                <li key={item}>
                  <Icon icon="solar:check-circle-bold" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="pwa-record-divider" />

        <div className="pwa-medical-bottom-grid">
          <section className="pwa-record-section">
            <h3>Obstetric Information</h3>
            <div className="pwa-obstetric-grid">
              {record.obstetric.map((item) => (
                <div key={item.label} className={item.wide ? "is-wide" : ""}>
                  <small>{item.label}</small>
                  <strong>{item.value}</strong>
                </div>
              ))}
            </div>

            <h3 className="pwa-diagnosis-title">Diagnosis</h3>
            <div className="pwa-diagnosis-box">{record.diagnosis}</div>
          </section>

          <section className="pwa-record-section">
            <h3>Plan / Treatment</h3>
            <ul className="pwa-treatment-list">
              {record.treatment.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>

            {record.prescriptions.length ? (
              <>
                <h3>Prescriptions</h3>
                <ul className="pwa-treatment-list">
                  {record.prescriptions.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </>
            ) : null}

            {record.diagnosticResults.length ? (
              <>
                <h3>Diagnostic Results</h3>
                <ul className="pwa-treatment-list">
                  {record.diagnosticResults.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </>
            ) : null}

            {record.attachment ? (
              <>
                <h3 className="pwa-attachment-title">Attachments (1)</h3>
                {record.attachment.url ? (
                  <a
                    className="pwa-attachment-card"
                    href={record.attachment.url}
                    download={record.attachment.name}
                  >
                    <span>
                      <Icon icon="solar:file-text-bold-duotone" />
                    </span>
                    <strong>
                      {record.attachment.name}
                      <small>{record.attachment.type}</small>
                    </strong>
                    <Icon icon="solar:download-minimalistic-linear" />
                  </a>
                ) : (
                  <div
                    className="pwa-attachment-card"
                    aria-disabled="true"
                  >
                    <span>
                      <Icon icon="solar:file-text-bold-duotone" />
                    </span>
                    <strong>
                      {record.attachment.name}
                      <small>{record.attachment.type}</small>
                    </strong>
                    <Icon icon="solar:file-check-linear" />
                  </div>
                )}
              </>
            ) : null}
          </section>
        </div>
      </article>
    </section>
  );
}

function MedicalMeta({ icon, label, value, tone }) {
  return (
    <div className={`pwa-medical-meta is-${tone} ${
      hasMeaningfulRecordValue(value) ? "" : "is-empty"
    }`}>
      <span>
        <Icon icon={icon} />
      </span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function SectionTitle({ title }) {
  return (
    <h3 className="pwa-dot-title">
      <span />
      {title}
    </h3>
  );
}
