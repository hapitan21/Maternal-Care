import React from "react";
import { Icon } from "@iconify/react";
import { supabase } from "../../lib/supabaseClient";
import "../../styles/medical_records.css";

const patientSelectColumns =
  "id, full_name, date_of_birth, age, address, contact_number, expected_delivery_date, gestational_age, trimester, risk_level, allergies, chronic_illness, current_medications, blood_type, medical_notes, status, created_at";
const medicalRecordColumns =
  "id, patient_id, patient_name, type, title, notes, file_name, file_type, file_data_url, form_data, uploaded_at, uploaded_by";

function formatPatientId(patientId) {
  return patientId ? String(patientId).slice(0, 8) : "-";
}

function formatPatientDate(value, fallback = "-") {
  if (!value) return fallback;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "2-digit",
    year: "numeric",
  });
}

function getPatientInitials(name) {
  const initials = String(name || "Patient")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

  return initials || "PT";
}

function normalizeRecordList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return String(value).split(/\r?\n|;/).map((item) => item.trim()).filter(Boolean);
}

function mapSupabaseMedicalRecord(row, patient) {
  const formData = row.form_data && typeof row.form_data === "object" ? row.form_data : {};
  const uploadedAt = row.uploaded_at ? new Date(row.uploaded_at) : new Date();
  const validDate = Number.isNaN(uploadedAt.getTime()) ? new Date() : uploadedAt;

  return {
    id: row.id,
    date: validDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
    day: validDate.toLocaleDateString("en-US", { weekday: "long" }),
    time: validDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
    visitType: formData.visitType || row.type || "Medical Record",
    gestationalAge: formData.gestationalAge || patient?.gestational_age || "-",
    doctor: formData.doctor || row.uploaded_by || "Doctor",
    complaint: formData.complaint || row.notes || row.title || "Medical record entry",
    assessment: normalizeRecordList(formData.assessment),
    findings: Array.isArray(formData.findings) ? formData.findings : [],
    obstetric: Array.isArray(formData.obstetric) ? formData.obstetric : null,
    diagnosis: formData.diagnosis || row.title || row.type || "Medical Record",
    treatment: normalizeRecordList(formData.treatment),
    attachment: row.file_name || "",
    fileDataUrl: row.file_data_url || "",
  };
}

const patientDetailsLeft = [
  {
    icon: "mingcute:calendar-line",
    label: "Birthdate",
    value: "January 01, 1990",
  },
  {
    icon: "mi:call",
    label: "Contact Number",
    value: "0998 765 4321",
  },
  {
    icon: "ic:outline-email",
    label: "Email",
    value: "maria.makiling@gmail.com",
  },
];

const patientDetailsRight = [
  {
    icon: "material-symbols:home-outline-rounded",
    label: "Address",
    value: "Mount Makiling",
  },
  {
    icon: "mdi:blood-outline",
    label: "Blood Type",
    value: "O+",
  },
  {
    icon: "ci:heart-01",
    label: "Marital Status",
    value: "Married",
  },
];

const tabs = [
  "Overview",
  "Prenatal History",
  "Appointments",
  "Medical Record",
  "Laboratory Results",
  "Prescriptions",
  "Pregnancy Tracking",
];

const pregnancyStats = [
  {
    icon: "ph:heartbeat",
    title: "Fetal Heart rate",
    value: "148 bmp",
    date: "(April 19, 2026)",
    className: "purple",
  },
  {
    icon: "solar:ruler-broken",
    title: "Fundal Height",
    value: "28 cm",
    date: "(April 19, 2026)",
    className: "pink",
  },
  {
    icon: "glyphs:baby-outline",
    title: "Baby Position",
    value: "Cephalic",
    date: "(April 19, 2026)",
    className: "yellow",
    iconClass: "mr-baby-position-icon",
  },
  {
    icon: "icon-park-outline:baby-feet",
    title: "Movement",
    value: "Active",
    date: "(April 19, 2026)",
    className: "green",
  },
];

const vitalSigns = [
  ["Blood Pressure", "120/80 mmHg"],
  ["Heart Rate", "72 bpm"],
  ["Weight", "65 kg"],
  ["Temperature", "36.7 C"],
];

const obstetricStats = [
  ["Gravida", "2"],
  ["Para", "1"],
  ["Abortion/ Miscarriage", "0"],
  ["Living Children", "1"],
  ["Multiple Pregnancy", "No"],
];

const pregnancyHistoryRows = [
  ["1", "2022", "Full Term", "Normal", "3.1 kg", "None"],
  ["2", "Current", "On going", "-", "-", "-"],
];

const currentPregnancyDetails = [
  [
    ["Last Menstrual Period", "March 10, 2025"],
    ["Expected Delivery Date", "December 15, 2026"],
    ["Gestational Age", "28 Weeks"],
  ],
  [
    ["Pregnancy Number", "Second Pregnancy"],
    ["Risk Classification", <span className="mr-low-risk-badge">Low Risk</span>],
  ],
];

const maternalConditions = [
  ["Hypertension", true],
  ["Anemia", true],
  ["Kidney Disease", false],
  ["Mental Health Condition", false],
  ["Diabetes", false],
  ["Heart Disease", false],
  ["Tuberculosis", false],
  ["Asthma", false],
  ["Thyroid Disorder", false],
  ["Epilepsy", false],
];

const familyMedicalHistoryRows = [
  ["Hypertension", "Yes", "No"],
  ["Diabetes", "Yes", "No"],
  ["Heart Disease", "Yes", "No"],
  ["Twins/ Multiple Birth", "Yes", "No"],
  ["Genetic Disorder", "Yes", "No"],
];

const allergyRows = [
  ["Medication", "Penicillin", "Skin Rash"],
  ["Food", "Seafood", "Mild Allergy"],
  ["Environmental", "Dust", "Sneezing"],
];

const lifestyleDetails = [
  [
    ["Smoker", "No"],
    ["Alcohol Use", "No"],
    ["Drug Use", "No"],
  ],
  [
    ["Occupation", "Teacher"],
    ["Physical Activity", "Moderate"],
    ["Diet", "Balance"],
  ],
];

const medicationSupplementRows = [
  ["Prenatal Vitamins", "1 tablet", "Once daily", "Continue"],
  ["Iron Supplement", "1 tablet", "Once daily", "Take after meals"],
  ["Folic Acid", "400 mcg", "Once daily", "Completed first trimester"],
];

const prenatalVisitRows = [
  [
    "04-01-2025",
    "20 Weeks",
    "60 kg",
    "120/80 mmHg",
    "145 bpm",
    "Initial prenatal Check up",
  ],
  [
    "05-01-2025",
    "24 Weeks",
    "63 kg",
    "118/78 mmHg",
    "148 bpm",
    "Prenatal Check up",
  ],
];

const appointmentSummary = [
  {
    label: "Total Visits",
    value: "8",
    note: "All time",
    icon: "mingcute:calendar-line",
    iconClass: "is-calendar",
    tone: "purple",
  },
  {
    label: "Completed",
    value: "3",
    note: "25%",
    icon: "simple-line-icons:check",
    iconClass: "is-check",
    tone: "pink",
  },
  {
    label: "Upcoming",
    value: "5",
    note: "75%",
    icon: "tabler:clock",
    iconClass: "is-clock",
    tone: "yellow",
  },
  {
    label: "Missed / Cancelled",
    value: "0",
    note: "0%",
    icon: "charm:circle-cross",
    iconClass: "is-close",
    tone: "green",
  },
  {
    label: "Attendance Rate",
    value: "100",
    note: "100%",
    icon: "streamline-ultimate:presentation-board-graph",
    iconClass: "is-attendance",
    tone: "blue",
  },
];

const prenatalAppointmentTimeline = [
  { week: "Week 12", title: "Initial Prenatal Check-up", date: "April 1, 2025", status: "Completed" },
  { week: "Week 20", title: "Anatomy Scan", date: "May 1, 2025", status: "Completed" },
  { week: "Week 24", title: "Prenatal Visit", date: "May 15, 2025", status: "Completed" },
  { week: "Week 28", status: "Upcoming" },
  { week: "Week 32", status: "Upcoming" },
  { week: "Week 36", status: "Upcoming" },
  { week: "Week 40", title: "Delivery Preparation", date: "December 15, 2026", status: "Upcoming" },
];

const appointmentHistoryRows = [
  ["4-01-25", "9:00 AM", "12 Weeks", "Dr. Kempee Vergara", "Initial Prenatal Check-up", "Completed"],
  ["5-01-25", "9:00 AM", "20 Weeks", "Dr. Kempee Vergara", "Prenatal Check-up", "Completed"],
];

const laboratoryResultRows = [
  {
    id: "hbsag-april-2025",
    dateCollected: "April 1, 2025",
    gestationalAge: "12 weeks GPA",
    test: "Hepatitis B Surface Antigen (HBsAG)",
    status: "Normal",
    statusTone: "normal",
    orderedBy: "Dr. Kempee Vergara",
    fileName: "HBsAg.pdf",
    fileMeta: "PDF 185KB",
  },
  {
    id: "blood-type-april-2025",
    dateCollected: "April 1, 2025",
    gestationalAge: "12 weeks GPA",
    test: "Blood type and RH",
    status: "-",
    statusTone: "pending",
    orderedBy: "Dr. Kempee Vergara",
    fileName: "Blood Type and RH.pdf",
    fileMeta: "PDF 185KB",
  },
];

const prescriptionEntries = [
  {
    id: "RX-2025-001",
    doctor: "Dr. Kempee Vergara",
    date: "April 1, 2025",
    medications: [
      { medication: "Folic Acid", dosage: "400 mcg", frequency: "Once Daily", duration: "90 days" },
      { medication: "Prenatal Vitamins", dosage: "1 tablet", frequency: "Once Daily", duration: "90 days" },
    ],
    instructions: "Take after breakfast.",
    fileName: "Prescription #RX-2025-001.pdf",
    fileMeta: "PDF 185KB",
  },
];

const pregnancyTrackingMilestones = [
  {
    week: 8,
    title: "Pregnancy Confirmed",
    description: "First prenatal assessment completed",
    image: "/images/leaf.png",
  },
  {
    week: 10,
    title: "Heartbeat Detected",
    description: "Strong fetal heartbeat observed.",
    image: "/images/heart.png",
  },
  {
    week: 12,
    title: "First Trimester Completed",
    description: "Reduced risk of early pregnancy complications.",
    image: "/images/flower.png",
  },
  {
    week: 18,
    title: "First Baby Movements Felt",
    description: "Mother reports feeling baby move.",
    image: "/images/feet.png",
  },
  {
    week: 20,
    title: "Anatomy Development Completed",
    description: "Major organs and structures formed.",
    image: "/images/brain.png",
  },
  {
    week: 28,
    title: "Entered Third Trimester",
    description: "Baby continues rapid growth and weight gain.",
    image: "/images/kilo.png",
  },
  {
    week: 34,
    title: "Lung Development",
    description: "Baby's lungs are maturing and strengthening.",
    image: "/images/lung.png",
  },
  {
    week: 37,
    title: "Full-Term Pregnancy",
    description: "Baby is considered full-term and ready anytime.",
    image: "/images/head.png",
  },
  {
    week: 40,
    title: "Expected Delivery",
    description: "Little one is expected to arrive soon!",
    image: "/images/gift.png",
  },
];

const babyDevelopmentDetails = [
  ["Estimated Weight", "1.1 kg"],
  ["Estimated Length", "48 cm"],
  ["Position", "Cephalic"],
  ["Fetal Heart Rate", "148 bpm"],
  ["Movement", "Active"],
];

const maternalProgressDetails = [
  ["Pre-pregnancy Weight", "58 kg"],
  ["Current Weight", "65 kg"],
  ["Total Weight Gain", "+7 kg"],
  ["BMI", "25.4 kg/m2"],
  ["Blood Pressure (Latest)", "120/80 mmHg"],
];

const medicalRecordEntries = [
  {
    id: "record-april-2025",
    date: "April 1, 2025",
    day: "Tuesday",
    time: "9:00 AM",
    visitType: "Initial Prenatal Check-up",
    gestationalAge: "12 Weeks",
    doctor: "Dr. Kempee Vergara",
    complaint: "Missed menstrual period and positive pregnancy test. Patient presents for initial prenatal consultation.",
    assessment: [
      "Confirmed intrauterine pregnancy.",
      "First prenatal visit completed.",
      "No vaginal bleeding.",
      "No abdominal pain.",
      "Patient reports mild nausea and occasional fatigue.",
    ],
    findings: [
      ["Blood Pressure", "120/80", "mmHg"],
      ["Weight", "65", "kg"],
      ["Temperature", "36.7", "C"],
      ["Heart Rate", "148", "bpm"],
      ["Height", "160", "cm"],
      ["BMI", "65", "22.7"],
    ],
    obstetric: [
      ["Gravida", "G2"],
      ["Last Menstrual Period", "March 13, 2025"],
      ["Pregnancy Type", "Singleton Pregnancy"],
      ["Para", "P1"],
      ["Expected Delivery Date", "December 15, 2026"],
    ],
    diagnosis: "Normal Early Intrauterine Pregnancy",
    treatment: [
      "Start Folic Acid 400 mcg daily",
      "Begin Prenatal Vitamins",
      "Request baseline laboratory tests",
      "CBC",
      "Urinalysis",
      "Blood Typing Test",
      "Hepatitis B Screening",
      "HIV Screening",
    ],
    attachment: "Pregnancy Confirmation Report.pdf",
  },
  {
    id: "record-may-2025",
    date: "May 1, 2025",
    day: "Thursday",
    time: "9:00 AM",
    visitType: "Prenatal Check-up",
    gestationalAge: "20 Weeks",
    doctor: "Dr. Kempee Vergara",
    complaint: "Routine prenatal consultation",
    assessment: [
      "Mild anemia observed.",
      "Patient reports occasional fatigue.",
      "No dizziness or shortness of breath.",
      "Mother and fetus are stable.",
    ],
    findings: [
      ["Blood Pressure", "118/78", "mmHg"],
      ["Weight", "67", "kg"],
      ["Temperature", "36.6", "C"],
      ["Fetal Heart Rate", "145", "bpm"],
      ["Fundal Height", "24", "cm"],
      ["Fetal Position", "Cephalic", ""],
    ],
    diagnosis: "Mild Anemia",
    treatment: [
      "Start Iron Supplement",
      "Increase intake of iron-rich food",
      "Repeat CBC after 4 weeks",
      "Return after 2 weeks for follow-up",
    ],
    attachment: "CBC Result.pdf",
  },
];

function InfoRow({ icon, label, value }) {
  return (
    <div className="mr-info-row">
      <Icon icon={icon} className="mr-info-icon" />
      <span className="mr-info-label">{label}</span>
      <span className="mr-info-value">{value}</span>
    </div>
  );
}

function SectionHeader({ icon, title, subtitle, action }) {
  return (
    <div className="mr-section-header">
      <div className="mr-section-title-wrap">
        <div className="mr-icon-badge">
          <Icon icon={icon} />
        </div>

        <div className="mr-section-title-text">
          <h3>{title}</h3>
          {subtitle && <span>{subtitle}</span>}
        </div>
      </div>

      {action && <button className="mr-link-btn">{action}</button>}
    </div>
  );
}

function MedicalRecordTable({ columns, rows, narrow = false, wide = false }) {
  const tableClassName = [
    "mr-prenatal-table",
    narrow ? "mr-prenatal-table--narrow" : "",
    wide ? "mr-prenatal-table--wide" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="mr-prenatal-table-wrap">
      <table className={tableClassName}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>

        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${row[0]}-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${cell}-${cellIndex}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PrenatalSection({ number, title, children }) {
  return (
    <article className="mr-card mr-prenatal-card">
      <h3 className="mr-prenatal-title">
        {number}. {title}
      </h3>

      <hr className="mr-prenatal-rule" />

      {children}
    </article>
  );
}

function OverviewPanel() {
  return (
    <div className="mr-panel-grid">
      <div className="mr-overview-left">
        <article className="mr-card mr-last-visit-card">
          <SectionHeader icon="solar:stethoscope-broken" title="Last Visit" />

          <div className="mr-card-body">
            <div className="mr-record-row">
              <strong>Date:</strong>
              <span>April 19, 2025</span>
            </div>

            <div className="mr-record-row">
              <strong>Doctor:</strong>
              <span>Dr. Kempee Vergara</span>
            </div>

            <div className="mr-record-stack">
              <strong>Assessment:</strong>
              <span>Health Pregnancy Progression</span>
            </div>
          </div>

          <button className="mr-outline-btn">View Full Record</button>
        </article>

        <article className="mr-card mr-vitals-card">
          <SectionHeader
            icon="mdi:clipboard-vitals-outline"
            title="Vital Signs"
            subtitle="(Latest)"
          />

          <div className="mr-card-body">
            {vitalSigns.map(([label, value]) => (
              <div className="mr-record-row" key={label}>
                <strong>{label}</strong>
                <span>{value}</span>
              </div>
            ))}
          </div>

          <button className="mr-outline-btn">View All Vital Signs</button>
        </article>
      </div>

      <div className="mr-overview-right">
        <article className="mr-card mr-progress-card">
          <div className="mr-progress-header">
            <h3>Pregnancy Progress</h3>
            <strong>28 of 40 weeks</strong>
          </div>

          <div className="mr-progress-bar">
            <span />
          </div>

          <div className="mr-stat-grid">
            {pregnancyStats.map((stat) => (
              <div
                key={stat.title}
                className={`mr-stat-card ${stat.className}`}
              >
                <div className={`mr-stat-icon ${stat.iconClass || ""}`}>
                  <Icon icon={stat.icon} />
                </div>

                <div>
                  <p>{stat.title}</p>
                  <strong>{stat.value}</strong>
                  <span>{stat.date}</span>
                </div>
              </div>
            ))}
          </div>
        </article>

        <div className="mr-overview-bottom">
          <article className="mr-card mr-schedule-card">
            <SectionHeader
              icon="solar:calendar-mark-bold"
              title="Next Schedule"
              action="View All"
            />

            <div className="mr-schedule-content">
              <Icon icon="ph:dot-fill" className="mr-dot-icon" />

              <div>
                <strong>Next Prenatal Visit</strong>
                <span>June 1, 2026 (9:00 am)</span>
              </div>
            </div>
          </article>

          <article className="mr-card mr-notes-card">
            <SectionHeader icon="solar:clipboard-list-bold" title="Notes" />

            <div className="mr-notes-text">
              <p>
                <strong>Chief Complaint:</strong>
                Routine prenatal check-up
              </p>

              <p>
                <strong>Assessment:</strong>
                Pregnancy progressing normally.
              </p>

              <p>
                <strong>Plan:</strong>
                Continue prenatal vitamins. Monitor fetal movement. Return
                after 2 weeks.
              </p>
            </div>

            <span className="mr-last-updated">
              Last Updated: April 19, 2026
            </span>
          </article>
        </div>
      </div>
    </div>
  );
}

function PrenatalHistoryPanel() {
  return (
    <div
      className="mr-prenatal-scroll"
      tabIndex={0}
      aria-label="Prenatal history sections"
    >
      <PrenatalSection number="1" title="Obstetric History">
        <div className="mr-obstetric-stats">
          {obstetricStats.map(([label, value]) => (
            <div className="mr-obstetric-stat" key={label}>
              <strong>{label}</strong>
              <span>{value}</span>
            </div>
          ))}
        </div>

        <h4 className="mr-prenatal-subtitle">Pregnancy History</h4>

        <MedicalRecordTable
          columns={[
            "Pregnancy Number",
            "Year",
            "Outcome",
            "Delivery Type",
            "Birth weight",
            "Complications",
          ]}
          rows={pregnancyHistoryRows}
          wide
        />
      </PrenatalSection>

      <PrenatalSection number="2" title="Current Pregnancy Information">
        <div className="mr-prenatal-info-grid">
          {currentPregnancyDetails.map((column, index) => (
            <div className="mr-prenatal-info-column" key={index}>
              {column.map(([label, value]) => (
                <div className="mr-prenatal-info-row" key={label}>
                  <strong>{label}</strong>
                  <span>{value}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </PrenatalSection>

      <PrenatalSection number="3" title="Maternal Medical Conditions">
        <div className="mr-condition-grid">
          {maternalConditions.map(([label, checked]) => (
            <div className="mr-condition-item" key={label}>
              <span className="mr-condition-box">
                {checked && <Icon icon="mdi:check" />}
              </span>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </PrenatalSection>

      <PrenatalSection number="4" title="Family Medical History">
        <MedicalRecordTable
          columns={["Condition", "Mother", "Father"]}
          rows={familyMedicalHistoryRows}
          narrow
        />
      </PrenatalSection>

      <PrenatalSection number="5" title="Allergies">
        <MedicalRecordTable
          columns={["Type", "Allergen", "Reaction"]}
          rows={allergyRows}
          narrow
        />
      </PrenatalSection>

      <PrenatalSection number="6" title="Lifestyle Assessment">
        <div className="mr-prenatal-info-grid">
          {lifestyleDetails.map((column, index) => (
            <div className="mr-prenatal-info-column" key={index}>
              {column.map(([label, value]) => (
                <div className="mr-prenatal-info-row" key={label}>
                  <strong>{label}</strong>
                  <span>{value}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </PrenatalSection>

      <PrenatalSection number="7" title="Medications & Supplements">
        <MedicalRecordTable
          columns={["Medication", "Dosage", "Frequency", "Notes"]}
          rows={medicationSupplementRows}
          narrow
        />
      </PrenatalSection>

      <PrenatalSection number="8" title="Prenatal Visit History">
        <MedicalRecordTable
          columns={[
            "Date",
            "Gestational Age",
            "Weight",
            "Blood Pressure",
            "Fetal Heart Rate",
            "Notes",
          ]}
          rows={prenatalVisitRows}
          wide
        />
      </PrenatalSection>
    </div>
  );
}

function AppointmentsPanel() {
  const historyRef = React.useRef(null);

  return (
    <div className="mr-appointments-panel">
      <section className="mr-appointment-summary" aria-label="Appointment summary">
        {appointmentSummary.map((item) => (
          <article
            className={`mr-appointment-summary-card ${item.tone}`}
            key={item.label}
            aria-label={`${item.label}: ${item.value} ${item.note}`}
          >
            <span className={`mr-appointment-summary-icon ${item.iconClass || ""}`}>
              <Icon icon={item.icon} />
            </span>

            <div className="mr-appointment-summary-content">
              <p>{item.label}</p>
              <strong>{item.value}</strong>
              <small>{item.note}</small>
            </div>
          </article>
        ))}
      </section>

      <div className="mr-appointment-feature-grid">
        <section className="mr-card mr-upcoming-appointments-card">
          <header className="mr-appointment-section-header">
            <h3>Upcoming Appointments</h3>
            <button type="button" onClick={() => historyRef.current?.scrollIntoView({ behavior: "smooth" })}>
              View All
            </button>
          </header>

          <article className="mr-next-appointment">
            <span><Icon icon="solar:calendar-bold" /></span>
            <div>
              <strong>Next Prenatal Visit</strong>
              <p>June 1, 2026 (Monday)</p>
              <small>Dr. Kempee Vergara</small>
            </div>
            <time><Icon icon="solar:clock-circle-linear" />9:00 AM</time>
          </article>
        </section>

        <section className="mr-card mr-appointment-timeline-card">
          <header className="mr-appointment-section-header">
            <h3>Prenatal Appointment Timeline</h3>
          </header>

          <div className="mr-appointment-timeline" tabIndex={0}>
            {prenatalAppointmentTimeline.map((item) => (
              <article className={item.status === "Completed" ? "is-completed" : "is-upcoming"} key={item.week}>
                <span className="mr-appointment-timeline-marker">
                  {item.status === "Completed" ? <Icon icon="mdi:check" /> : null}
                </span>
                <div>
                  <strong>{item.week}</strong>
                  {item.title ? <p>{item.title}</p> : null}
                  {item.date ? <small>{item.date}</small> : null}
                </div>
                <mark>{item.status}</mark>
              </article>
            ))}
          </div>
        </section>
      </div>

      <section className="mr-card mr-appointment-history-card" ref={historyRef}>
        <h3>Appointment History</h3>
        <div className="mr-appointment-history-wrap">
          <table className="mr-appointment-history-table">
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
              {appointmentHistoryRows.map((row) => (
                <tr key={`${row[0]}-${row[2]}`}>
                  {row.slice(0, -1).map((cell) => <td key={cell}>{cell}</td>)}
                  <td><mark>{row[row.length - 1]}</mark></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function LaboratoryResultsPanel() {
  const [query, setQuery] = React.useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredResults = laboratoryResultRows.filter((result) =>
    [
      result.dateCollected,
      result.gestationalAge,
      result.test,
      result.status,
      result.orderedBy,
      result.fileName,
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery)
  );

  return (
    <div className="mr-laboratory-panel">
      <label className="mr-laboratory-search">
        <Icon icon="solar:magnifer-linear" />
        <input
          type="search"
          placeholder="Search Laboratory Results...."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <div className="mr-laboratory-table-wrap">
        <div className="mr-laboratory-table" role="table" aria-label="Laboratory results">
          <div className="mr-laboratory-head" role="row">
            <span role="columnheader">Date Collected</span>
            <span role="columnheader">Test</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Ordered By</span>
            <span role="columnheader">Actions</span>
          </div>

          {filteredResults.length > 0 ? filteredResults.map((result) => (
            <div className="mr-laboratory-row" role="row" key={result.id}>
              <span className="mr-laboratory-date" role="cell">
                <strong>{result.dateCollected}</strong>
                <small>({result.gestationalAge})</small>
              </span>
              <span role="cell">{result.test}</span>
              <span role="cell">
                <mark className={`is-${result.statusTone}`}>{result.status}</mark>
              </span>
              <span role="cell">{result.orderedBy}</span>
              <span role="cell">
                <button className="mr-laboratory-file" type="button" title={`Download ${result.fileName}`}>
                  <Icon icon="akar-icons:file" />
                  <span>
                    <strong>{result.fileName}</strong>
                    <small>{result.fileMeta}</small>
                  </span>
                  <Icon icon="material-symbols:download-rounded" />
                </button>
              </span>
            </div>
          )) : (
            <div className="mr-laboratory-empty">
              <Icon icon="solar:test-tube-linear" />
              <p>No laboratory results match your search.</p>
            </div>
          )}
        </div>
      </div>

      <p className="mr-laboratory-count">
        Showing {filteredResults.length} of {laboratoryResultRows.length} Laboratory results
      </p>
    </div>
  );
}

function PrescriptionsPanel() {
  const [query, setQuery] = React.useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredPrescriptions = prescriptionEntries.filter((prescription) =>
    [
      prescription.id,
      prescription.doctor,
      prescription.date,
      prescription.instructions,
      prescription.fileName,
      ...prescription.medications.flatMap((medication) => Object.values(medication)),
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery)
  );

  return (
    <div className="mr-prescriptions-panel">
      <label className="mr-prescriptions-search">
        <Icon icon="solar:magnifer-linear" />
        <input
          type="search"
          placeholder="Search Prescriptions...."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <div className="mr-prescription-list">
        {filteredPrescriptions.length > 0 ? filteredPrescriptions.map((prescription) => (
          <article className="mr-prescription-card" key={prescription.id}>
            <header className="mr-prescription-header">
              <span className="mr-prescription-icon">
                <Icon icon="material-symbols:prescriptions-outline" />
              </span>
              <div className="mr-prescription-title">
                <h3>Prescription #{prescription.id}</h3>
                <p>{prescription.doctor}</p>
              </div>
              <time>
                <Icon icon="mingcute:calendar-line" />
                {prescription.date}
              </time>
            </header>

            <div className="mr-prescription-table-wrap">
              <div className="mr-prescription-table" role="table" aria-label={`Prescription ${prescription.id}`}>
                <div className="mr-prescription-head" role="row">
                  <span role="columnheader">Medication</span>
                  <span role="columnheader">Dosage</span>
                  <span role="columnheader">Frequency</span>
                  <span role="columnheader">Duration</span>
                </div>

                {prescription.medications.map((medication) => (
                  <div className="mr-prescription-row" role="row" key={medication.medication}>
                    <span role="cell">{medication.medication}</span>
                    <span role="cell">{medication.dosage}</span>
                    <span role="cell">{medication.frequency}</span>
                    <span role="cell">{medication.duration}</span>
                  </div>
                ))}
              </div>
            </div>

            <section className="mr-prescription-instructions">
              <h4>Instructions:</h4>
              <p>{prescription.instructions}</p>
            </section>

            <footer className="mr-prescription-footer">
              <div className="mr-prescription-file">
                <Icon icon="akar-icons:file" />
                <span>
                  <strong>{prescription.fileName}</strong>
                  <small>{prescription.fileMeta}</small>
                </span>
              </div>
              <button type="button" title={`Download ${prescription.fileName}`}>
                <Icon icon="material-symbols:download-rounded" />
                Download
              </button>
            </footer>
          </article>
        )) : (
          <div className="mr-prescription-empty">
            <Icon icon="material-symbols:prescriptions-outline" />
            <p>No prescriptions match your search.</p>
          </div>
        )}
      </div>

      <p className="mr-prescription-count">
        Showing {filteredPrescriptions.length} of {prescriptionEntries.length} Prescriptions
      </p>
    </div>
  );
}

function PregnancyTrackingPanel({ patient }) {
  const expectedDeliveryDate = formatPatientDate(
    patient?.expected_delivery_date,
    "December 15, 2026"
  );
  const riskLevel = patient?.risk_level || "Low Risk";

  return (
    <div className="mr-pregnancy-tracking-panel">
      <section className="mr-card mr-tracking-progress-card">
        <div className="mr-tracking-progress-visual">
          <div
            className="mr-tracking-progress-ring"
            role="img"
            aria-label="Pregnancy progress: week 28 of 40, 70 percent complete"
          >
            <div className="mr-tracking-progress-ring__content">
              <span>WEEK</span>
              <strong>28</strong>
              <span>OF 40</span>
            </div>
          </div>
        </div>

        <div className="mr-tracking-progress-content">
          <h3>Current Pregnancy Progress</h3>
          <div className="mr-tracking-trimester">
            <span className="mr-tracking-trimester-icon">
              <Icon icon="healthicons:pregnant" />
            </span>
            <div>
              <strong>The Patient is in her 3rd Trimester</strong>
              <p>12 weeks to go!</p>
            </div>
          </div>

          <div className="mr-tracking-progress-bar" aria-hidden="true">
            <span>70%</span>
          </div>

          <div className="mr-tracking-progress-meta">
            <div>
              <span className="mr-tracking-meta-icon">
                <Icon icon="mingcute:calendar-line" />
              </span>
              <span>
                <small>Expected Delivery Date</small>
                <strong>{expectedDeliveryDate}</strong>
              </span>
            </div>
            <div>
              <span className="mr-tracking-meta-icon">
                <Icon icon="material-symbols:shield-outline-rounded" />
              </span>
              <span>
                <small>Pregnancy Status</small>
                <mark>{riskLevel}</mark>
              </span>
            </div>
          </div>
        </div>

        <img
          className="mr-tracking-progress-image"
          src="/images/preggy.png"
          alt=""
          aria-hidden="true"
        />
      </section>

      <div className="mr-tracking-detail-grid">
        <section className="mr-card mr-tracking-detail-card">
          <header>
            <div>
              <span className="mr-tracking-detail-icon">
                <Icon icon="glyphs:baby-outline" />
              </span>
              <h3>Baby Development</h3>
            </div>
            <Icon className="mr-tracking-card-illustration" icon="icon-park-outline:baby-feet" />
          </header>

          <div className="mr-tracking-baby-body">
            <dl>
              {babyDevelopmentDetails.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <img
              className="mr-tracking-baby-image"
              src="/images/babys.png"
              alt=""
              aria-hidden="true"
            />
          </div>

          <footer>
            <span><Icon icon="line-md:heart" /></span>
            <strong>The baby is about the size of a large eggplant.</strong>
          </footer>
        </section>

        <section className="mr-card mr-tracking-detail-card">
          <header>
            <div>
              <span className="mr-tracking-detail-icon">
                <Icon icon="healthicons:pregnant" />
              </span>
              <h3>Maternal Progress</h3>
            </div>
            <Icon className="mr-tracking-card-illustration" icon="solar:health-bold-duotone" />
          </header>

          <dl>
            {maternalProgressDetails.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>

          <footer>
            <span><Icon icon="line-md:heart" /></span>
            <strong>Mother and baby are progressing well.</strong>
          </footer>
        </section>
      </div>

      <section className="mr-card mr-pregnancy-journey-card">
        <header>
          <div>
            <span className="mr-tracking-detail-icon">
              <Icon icon="solar:calendar-mark-bold-duotone" />
            </span>
            <h3>Pregnancy Journey</h3>
          </div>
          <span>Week 28 of 40</span>
        </header>

        <div className="mr-pregnancy-journey">
          {pregnancyTrackingMilestones.map((milestone) => {
            const isCompleted = milestone.week <= 28;
            const isCurrent = milestone.week === 28;

            return (
              <article
                className={[
                  "mr-pregnancy-milestone",
                  isCompleted ? "is-completed" : "is-upcoming",
                  isCurrent ? "is-current" : "",
                ].filter(Boolean).join(" ")}
                key={milestone.week}
                aria-current={isCurrent ? "step" : undefined}
              >
                <span className="mr-pregnancy-milestone-image">
                  <img src={milestone.image} alt="" aria-hidden="true" />
                </span>
                <span className="mr-pregnancy-milestone-status">
                  {isCompleted ? <Icon icon="icon-park-solid:check-one" /> : milestone.week}
                </span>
                <div>
                  <small>Week {milestone.week}</small>
                  <strong>{milestone.title}</strong>
                  <p>{milestone.description}</p>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function MedicalRecordChecklist({ items }) {
  return (
    <ul className="mr-medical-checklist">
      {items.map((item, index) => (
        <li className={index > 2 && items.length > 5 ? "is-subitem" : ""} key={item}>
          <Icon icon={index > 2 && items.length > 5 ? "mdi:circle-small" : "material-symbols:check-rounded"} />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function MedicalRecordEntry({ record, isPrimary = false }) {
  return (
    <article className={`mr-medical-entry ${isPrimary ? "mr-medical-entry--primary" : "mr-medical-entry--secondary"}`}>
      <aside className="mr-medical-entry-meta">
        <header>
          <span className="mr-medical-meta-icon">
            <Icon icon="mingcute:calendar-line" />
          </span>
          <div>
            <h3>{record.date}</h3>
            <p>{record.day}<span aria-hidden="true">•</span>{record.time}</p>
          </div>
        </header>

        <dl>
          <div>
            <Icon className="mr-medical-detail-icon" icon="streamline-ultimate:doctor-home-visit-1" />
            <dt>Visit Type</dt>
            <dd>{record.visitType}</dd>
          </div>
          <div>
            <Icon className="mr-medical-detail-icon" icon="tabler:clock" />
            <dt>Gestational Age</dt>
            <dd>{record.gestationalAge}</dd>
          </div>
          <div>
            <Icon className="mr-medical-detail-icon" icon="healthicons:doctor-outline-24px" />
            <dt>Doctor</dt>
            <dd>{record.doctor}</dd>
          </div>
        </dl>
      </aside>

      <div className="mr-medical-entry-content">
        <div className="mr-medical-two-column mr-medical-section">
          <section>
            <h4>Chief Complaint</h4>
            <p>{record.complaint}</p>
          </section>
          <section>
            <h4>Assessment</h4>
            {record.assessment.length > 0 ? (
              <MedicalRecordChecklist items={record.assessment} />
            ) : (
              <p>No assessment details recorded.</p>
            )}
          </section>
        </div>

        {record.findings.length > 0 ? (
          <section className="mr-medical-section">
            <h4>Clinical Findings</h4>
            <div className="mr-medical-findings">
              {record.findings.map(([label, value, unit]) => (
                <div key={label}>
                  <small>{label}</small>
                  <strong>{value}</strong>
                  {unit ? <span>{unit}</span> : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {record.obstetric ? (
          <section className="mr-medical-section">
            <h4>Obstetric Information</h4>
            <dl className="mr-medical-obstetric">
              {record.obstetric.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        <div className="mr-medical-two-column mr-medical-section mr-medical-plan-row">
          <section>
            <h4>Diagnosis</h4>
            <p>{record.diagnosis}</p>
          </section>
          <section>
            <h4>Plan / Treatment</h4>
            {record.treatment.length > 0 ? (
              <MedicalRecordChecklist items={record.treatment} />
            ) : (
              <p>No treatment plan recorded.</p>
            )}
          </section>
        </div>

        {record.attachment ? (
          <section className="mr-medical-attachments">
            <h4>Attachments (1)</h4>
            <a href={record.fileDataUrl || undefined} download={record.attachment}>
              <Icon icon="akar-icons:file" />
              <span>
                <strong>{record.attachment}</strong>
                <small>Medical attachment</small>
              </span>
              <Icon icon="material-symbols:download-rounded" />
            </a>
          </section>
        ) : null}
      </div>
    </article>
  );
}

function MedicalRecordsPanel({ records, isLoading, message }) {
  const [query, setQuery] = React.useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredRecords = records.filter((record) =>
    [record.date, record.visitType, record.doctor, record.complaint, record.diagnosis]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery)
  );

  return (
    <div className="mr-medical-records-panel">
      <label className="mr-medical-search">
        <Icon icon="solar:magnifer-linear" />
        <input
          type="search"
          placeholder="Search medical records..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      {message ? <p className="mr-medical-load-message">{message}</p> : null}

      <div className="mr-medical-record-list">
        {isLoading ? (
          <div className="mr-medical-no-results">
            <Icon icon="eos-icons:loading" />
            <p>Loading medical records...</p>
          </div>
        ) : filteredRecords.length > 0 ? (
          filteredRecords.map((record, index) => (
            <MedicalRecordEntry record={record} isPrimary={index === 0} key={record.id} />
          ))
        ) : (
          <div className="mr-medical-no-results">
            <Icon icon="solar:document-text-linear" />
            <p>{normalizedQuery ? "No medical records match your search." : "No medical records saved for this patient."}</p>
          </div>
        )}
      </div>

      <p className="mr-medical-record-count">
        Showing {filteredRecords.length} of {records.length} medical records
      </p>
    </div>
  );
}

export default function Doctor_Medical_Records({ initialPatient = null, onBackToPatients = null }) {
  const [activeTab, setActiveTab] = React.useState("Overview");
  const [patient, setPatient] = React.useState(initialPatient);
  const [patientProfile, setPatientProfile] = React.useState(null);
  const [medicalRecords, setMedicalRecords] = React.useState([]);
  const [isLoadingPatient, setIsLoadingPatient] = React.useState(Boolean(initialPatient?.id));
  const [isLoadingRecords, setIsLoadingRecords] = React.useState(Boolean(initialPatient?.id));
  const [recordMessage, setRecordMessage] = React.useState("");
  const [isRecordFormOpen, setIsRecordFormOpen] = React.useState(false);
  const [isSavingRecord, setIsSavingRecord] = React.useState(false);
  const [recordForm, setRecordForm] = React.useState({
    title: "",
    type: "Electronic Medical Record",
    notes: "",
    assessment: "",
    diagnosis: "",
    treatment: "",
  });
  const pageRef = React.useRef(null);

  const loadMedicalRecords = React.useCallback(async (selectedPatient) => {
    if (!selectedPatient?.id) {
      setMedicalRecords([]);
      setIsLoadingRecords(false);
      return;
    }

    setIsLoadingRecords(true);
    setRecordMessage("");

    let { data, error } = await supabase
      .from("medical_records")
      .select(medicalRecordColumns)
      .eq("patient_id", selectedPatient.id)
      .order("uploaded_at", { ascending: false });

    if (!error && (!data || data.length === 0) && selectedPatient.full_name) {
      const nameResult = await supabase
        .from("medical_records")
        .select(medicalRecordColumns)
        .ilike("patient_name", selectedPatient.full_name)
        .order("uploaded_at", { ascending: false });

      data = nameResult.data;
      error = nameResult.error;
    }

    if (error) {
      setMedicalRecords([]);
      setRecordMessage(`Unable to load Supabase medical records: ${error.message}`);
      setIsLoadingRecords(false);
      return;
    }

    setMedicalRecords((data ?? []).map((row) => mapSupabaseMedicalRecord(row, selectedPatient)));
    setIsLoadingRecords(false);
  }, []);

  React.useEffect(() => {
    const loadPatient = async () => {
      if (!initialPatient?.id) {
        setPatient(initialPatient);
        setIsLoadingPatient(false);
        return;
      }

      setIsLoadingPatient(true);
      const { data, error } = await supabase
        .from("patients")
        .select(patientSelectColumns)
        .eq("id", initialPatient.id)
        .maybeSingle();

      const selectedPatient = error || !data ? initialPatient : data;
      setPatient(selectedPatient);
      setIsLoadingPatient(false);
      await loadMedicalRecords(selectedPatient);

      if (selectedPatient?.full_name) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("full_name, email, civil_status")
          .ilike("full_name", selectedPatient.full_name)
          .limit(1)
          .maybeSingle();

        setPatientProfile(profile ?? null);
      }
    };

    loadPatient();
  }, [initialPatient, loadMedicalRecords]);

  const handleRecordFormChange = (event) => {
    const { name, value } = event.target;
    setRecordForm((current) => ({ ...current, [name]: value }));
  };

  const saveMedicalRecord = async (event) => {
    event.preventDefault();

    if (!patient?.id || !recordForm.title.trim()) {
      setRecordMessage("Select a patient and enter a record title.");
      return;
    }

    setIsSavingRecord(true);
    setRecordMessage("");

    const { data: authData } = await supabase.auth.getUser();
    const user = authData?.user;
    let uploadedBy = user?.user_metadata?.full_name || user?.email || "Doctor";

    if (user?.id) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", user.id)
        .maybeSingle();
      uploadedBy = profile?.full_name || uploadedBy;
    }

    const payload = {
      patient_id: patient.id,
      patient_name: patient.full_name,
      type: recordForm.type,
      title: recordForm.title.trim(),
      notes: recordForm.notes.trim() || null,
      uploaded_by: uploadedBy,
      form_data: {
        visitType: recordForm.type,
        gestationalAge: patient.gestational_age || "-",
        doctor: uploadedBy,
        complaint: recordForm.notes.trim(),
        assessment: normalizeRecordList(recordForm.assessment),
        diagnosis: recordForm.diagnosis.trim(),
        treatment: normalizeRecordList(recordForm.treatment),
      },
    };

    const { error } = await supabase.from("medical_records").insert(payload);
    setIsSavingRecord(false);

    if (error) {
      setRecordMessage(`Unable to save to Supabase: ${error.message}`);
      return;
    }

    setRecordForm({
      title: "",
      type: "Electronic Medical Record",
      notes: "",
      assessment: "",
      diagnosis: "",
      treatment: "",
    });
    setIsRecordFormOpen(false);
    setActiveTab("Medical Record");
    await loadMedicalRecords(patient);
    setRecordMessage("Medical record saved to Supabase.");
  };

  const patientDetailsLeft = [
    { icon: "mingcute:calendar-line", label: "Birthdate", value: formatPatientDate(patient?.date_of_birth) },
    { icon: "mi:call", label: "Contact Number", value: patient?.contact_number || "-" },
    { icon: "ic:outline-email", label: "Email", value: patientProfile?.email || "-" },
  ];

  const patientDetailsRight = [
    { icon: "material-symbols:home-outline-rounded", label: "Address", value: patient?.address || "-" },
    { icon: "mdi:blood-outline", label: "Blood Type", value: patient?.blood_type || "-" },
    { icon: "ci:heart-01", label: "Marital Status", value: patientProfile?.civil_status || "-" },
  ];

  const handleBackToPatients = () => {
    pageRef.current?.scrollTo({ top: 0, behavior: "smooth" });

    window.setTimeout(() => {
      if (typeof onBackToPatients === "function") {
        onBackToPatients();
        return;
      }

      window.history.back();
    }, 120);
  };

  return (
    <main className="medical-records-page" ref={pageRef}>
      <div className="medical-records-content">
        <div className="mr-top-row">
          <button
            className="mr-back-btn"
            type="button"
            onClick={handleBackToPatients}
          >
            <Icon icon="ion:arrow-back-outline" />
            Back to patients
          </button>

          <button className="mr-edit-btn" type="button" onClick={() => setIsRecordFormOpen(true)}>
            Add Medical Record
          </button>
        </div>

        <header className="mr-page-header">
          <h1>Medical Record</h1>
          <p>View and manage patient medical information</p>
        </header>

        <section className="mr-patient-card">
          <div className="mr-patient-main">
            <div className="mr-avatar">{getPatientInitials(patient?.full_name)}</div>

            <div className="mr-patient-info">
              <div className="mr-name-row">
                <h2>{isLoadingPatient ? "Loading patient..." : patient?.full_name || "Patient Record"}</h2>
                <span className="mr-status">{patient?.status || "Active Patient"}</span>
              </div>

              <p className="mr-patient-id">Patient ID: {formatPatientId(patient?.id)}</p>

              <div className="mr-details-grid">
                <div className="mr-details-column">
                  {patientDetailsLeft.map((item) => (
                    <InfoRow key={item.label} {...item} />
                  ))}
                </div>

                <div className="mr-divider" />

                <div className="mr-details-column">
                  {patientDetailsRight.map((item) => (
                    <InfoRow key={item.label} {...item} />
                  ))}
                </div>
              </div>
            </div>
          </div>

          <aside className="mr-pregnancy-box">
            <h3>Current Pregnancy</h3>

            <div className="mr-pregnancy-list">
              <div>
                <strong>Pregnancy number</strong>
                <span>G2P1</span>
              </div>

              <div>
                <strong>Gestational Age</strong>
                <span>{patient?.gestational_age || "-"}</span>
              </div>

              <div>
                <strong>Expected Delivery Date</strong>
                <span>{formatPatientDate(patient?.expected_delivery_date)}</span>
              </div>

              <div>
                <strong>Risk Level</strong>
                <span className="mr-risk">{patient?.risk_level || "Not set"}</span>
              </div>
            </div>
          </aside>
        </section>

        <section className={`mr-record-panel${activeTab === "Medical Record" ? " mr-record-panel--medical" : ""}`}>
          <nav className="mr-tabs">
            {tabs.map((tab) => (
              <button
                key={tab}
                type="button"
                className={`mr-tab ${activeTab === tab ? "active" : ""}`}
                onClick={() => setActiveTab(tab)}
              >
                {tab}
              </button>
            ))}
          </nav>

          {activeTab === "Overview" && <OverviewPanel />}

          {activeTab === "Prenatal History" && <PrenatalHistoryPanel />}

          {activeTab === "Appointments" && <AppointmentsPanel />}

          {activeTab === "Laboratory Results" && <LaboratoryResultsPanel />}

          {activeTab === "Prescriptions" && <PrescriptionsPanel />}

          {activeTab === "Pregnancy Tracking" && (
            <PregnancyTrackingPanel patient={patient} />
          )}

          {activeTab === "Medical Record" && (
            <MedicalRecordsPanel
              records={medicalRecords}
              isLoading={isLoadingRecords}
              message={recordMessage}
            />
          )}

          {activeTab !== "Overview" && activeTab !== "Prenatal History" && activeTab !== "Appointments" && activeTab !== "Laboratory Results" && activeTab !== "Prescriptions" && activeTab !== "Pregnancy Tracking" && activeTab !== "Medical Record" && (
            <div className="mr-empty-tab">
              No records available for {activeTab}.
            </div>
          )}
        </section>
      </div>

      {isRecordFormOpen ? (
        <div className="mr-record-modal" role="dialog" aria-modal="true" aria-labelledby="mr-record-form-title">
          <form className="mr-record-form" onSubmit={saveMedicalRecord}>
            <header>
              <div>
                <h2 id="mr-record-form-title">Add Medical Record</h2>
                <p>Save a medical entry for {patient?.full_name || "this patient"} in Supabase.</p>
              </div>
              <button type="button" aria-label="Close" onClick={() => setIsRecordFormOpen(false)}>
                <Icon icon="material-symbols:close-rounded" />
              </button>
            </header>

            <div className="mr-record-form-grid">
              <label>
                Record Title
                <input
                  name="title"
                  type="text"
                  required
                  value={recordForm.title}
                  onChange={handleRecordFormChange}
                  placeholder="e.g. Prenatal consultation"
                />
              </label>

              <label>
                Record Type
                <select name="type" value={recordForm.type} onChange={handleRecordFormChange}>
                  <option>Electronic Medical Record</option>
                  <option>Prenatal Check-up</option>
                  <option>Laboratory Result</option>
                  <option>Ultrasound Findings</option>
                  <option>Prescription</option>
                </select>
              </label>

              <label className="mr-record-form-wide">
                Chief Complaint / Notes
                <textarea name="notes" value={recordForm.notes} onChange={handleRecordFormChange} />
              </label>

              <label>
                Assessment
                <textarea
                  name="assessment"
                  value={recordForm.assessment}
                  onChange={handleRecordFormChange}
                  placeholder="One item per line"
                />
              </label>

              <label>
                Plan / Treatment
                <textarea
                  name="treatment"
                  value={recordForm.treatment}
                  onChange={handleRecordFormChange}
                  placeholder="One item per line"
                />
              </label>

              <label className="mr-record-form-wide">
                Diagnosis
                <input name="diagnosis" type="text" value={recordForm.diagnosis} onChange={handleRecordFormChange} />
              </label>
            </div>

            {recordMessage ? <p className="mr-record-form-message">{recordMessage}</p> : null}

            <div className="mr-record-form-actions">
              <button type="submit" disabled={isSavingRecord}>
                {isSavingRecord ? "Saving..." : "Save to Supabase"}
              </button>
              <button type="button" onClick={() => setIsRecordFormOpen(false)}>Cancel</button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}
