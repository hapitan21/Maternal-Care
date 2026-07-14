import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../lib/supabaseClient";
import "../../styles/doctor-appointments.css";
import "../../styles/staff-appointments.css";

const scheduleTableName = "schedule";
const patientColumns =
  "id, full_name, patient_id, user_id, age, contact_number, address, expected_delivery_date, gestational_age, risk_level";
const scheduleColumns =
  "id, maternal_appointment_id, patient_id, doctor_id, patient_name, doctor_name, title, description, start_time, end_time, status";

const appointmentTabs = ["All", "Pending", "Completed", "Cancelled"];

const statusOptions = [
  { label: "Pending", value: "scheduled" },
  { label: "Completed", value: "completed" },
  { label: "Cancel", value: "cancelled" },
];

const initialAppointmentForm = {
  patient_name: "",
  doctor_name: "Dr. Kempee Vergara",
  title: "",
  description: "",
  appointment_date: "",
  appointment_time: "",
};

const initialRescheduleForm = {
  date: "",
  time: "",
  message: "",
};

function InlineIcon({ name }) {
  const paths = {
    plus: (
      <>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="6.4" />
        <path d="m16 16 4 4" />
      </>
    ),
    calendar: (
      <>
        <rect x="4" y="5" width="16" height="15" rx="3" />
        <path d="M8 3v4M16 3v4M4 10h16" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v5l3 2" />
      </>
    ),
    chevronDown: <path d="m7 10 5 5 5-5" />,
    chevronLeft: <path d="m15 18-6-6 6-6" />,
    chevronRight: <path d="m9 18 6-6-6-6" />,
    close: (
      <>
        <path d="m7 7 10 10" />
        <path d="m17 7-10 10" />
      </>
    ),
    heart: (
      <path
        fill="currentColor"
        stroke="none"
        d="M12 20.4s-7.3-4.5-8.9-9.1C1.9 7.7 4.4 4.8 7.5 4.8c1.8 0 3.3.9 4.5 2.4 1.2-1.5 2.7-2.4 4.5-2.4 3.1 0 5.6 2.9 4.4 6.5C19.3 15.9 12 20.4 12 20.4Z"
      />
    ),
    phone: <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.4 2.1L8.1 9.6a16 16 0 0 0 6.3 6.3l1.2-1.2a2 2 0 0 1 2.1-.4c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2Z" />,
    consultation: (
      <>
        <path
          fill="currentColor"
          stroke="none"
          d="M8.8 4.4h5.5l3.1 3.3v11.1c0 .9-.7 1.7-1.7 1.7H8.8c-.9 0-1.7-.7-1.7-1.7V6.1c0-.9.7-1.7 1.7-1.7Z"
        />
        <path
          fill="rgba(255,255,255,.55)"
          stroke="none"
          d="M14.1 4.8v3.1c0 .5.4.9.9.9h2.8"
        />
      </>
    ),
    education: (
      <>
        <path
          fill="currentColor"
          stroke="none"
          d="M3.6 11.2 12 7.2l8.4 4-8.4 4-5.1-2.4v2.4l5.1 2.4 6.2-3v2.1L12 19.8 5.8 16.9v-4.6l-2.2-1.1Z"
        />
        <path stroke="currentColor" strokeWidth="2" d="M19.5 12.1v3.8" />
      </>
    ),
    reminder: (
      <>
        <path
          fill="currentColor"
          stroke="none"
          d="M18.8 16.5H5.2c.9-.9 1.4-2.2 1.4-4.2V10a5.4 5.4 0 0 1 10.8 0v2.3c0 2 .5 3.3 1.4 4.2Z"
        />
        <path
          fill="currentColor"
          stroke="none"
          d="M14.2 18.1a2.3 2.3 0 0 1-4.4 0h4.4Z"
        />
      </>
    ),
  };

  return (
    <svg className="doctor-appt-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateInputValue(value) {
  const date = value instanceof Date ? value : toDate(value);
  if (!date) return "";

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toTimeInputValue(value) {
  const date = toDate(value);
  if (!date) return "";

  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function formatTableDate(value) {
  const date = toDate(value);
  if (!date) return "-";

  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const year = String(date.getFullYear()).slice(-2);
  return `${month}-${day}-${year}`;
}

function formatTime(value) {
  const date = toDate(value);
  if (!date) return "-";

  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatLongDate(value) {
  const date = toDate(value);
  if (!date) return "";

  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "2-digit",
    year: "numeric",
  });
}

function formatDisplayTime(value) {
  if (!value) return "";
  const [hourValue, minuteValue] = value.split(":");
  const date = new Date();
  date.setHours(Number(hourValue || 0), Number(minuteValue || 0), 0, 0);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatMonthYear(dateValue) {
  const date = toDate(`${dateValue}T00:00:00`) || new Date();

  return date.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function getStatusLabel(status) {
  const normalized = String(status || "scheduled").toLowerCase();

  if (["completed", "checked_in", "checked in"].includes(normalized)) return "Checked in";
  if (normalized === "cancelled" || normalized === "canceled") return "Cancel";
  return "Pending";
}

function getStatusClass(status) {
  const normalized = String(status || "scheduled").toLowerCase();

  if (["completed", "checked_in", "checked in"].includes(normalized)) return "completed";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  return "pending";
}

function statusMatches(schedule, activeTab) {
  const normalized = String(schedule.status || "scheduled").toLowerCase();

  if (activeTab === "All") return true;
  if (activeTab === "Pending") return ["scheduled", "pending", "accepted"].includes(normalized);
  if (activeTab === "Completed") return ["completed", "checked_in", "checked in"].includes(normalized);
  if (activeTab === "Cancelled") return normalized === "cancelled" || normalized === "canceled";

  return true;
}

function searchMatches(schedule, searchTerm) {
  const keyword = searchTerm.trim().toLowerCase();

  if (!keyword) return true;

  return [
    schedule.id,
    schedule.patient_name,
    schedule.title,
    schedule.doctor_name,
    schedule.status,
  ].some((value) => String(value || "").toLowerCase().includes(keyword));
}

function getWeekStart(dateValue) {
  const date = toDate(`${dateValue}T00:00:00`) || new Date();
  const start = new Date(date);
  start.setDate(date.getDate() - date.getDay());
  start.setHours(0, 0, 0, 0);
  return start;
}

function getWeekDays(dateValue) {
  const start = getWeekStart(dateValue);

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);

    return {
      date,
      key: toDateInputValue(date),
      dayName: date.toLocaleDateString("en-US", { weekday: "short" }),
      dayNumber: date.getDate(),
    };
  });
}

function getWeekRangeLabel(dateValue) {
  const days = getWeekDays(dateValue);
  const first = days[0].date;
  const last = days[days.length - 1].date;

  const firstMonth = first.toLocaleDateString("en-US", { month: "long" });
  const lastMonth = last.toLocaleDateString("en-US", { month: "long" });

  if (firstMonth === lastMonth) {
    return `${firstMonth} ${first.getDate()} - ${last.getDate()}, ${last.getFullYear()}`;
  }

  return `${firstMonth} ${first.getDate()} - ${lastMonth} ${last.getDate()}, ${last.getFullYear()}`;
}

function getScheduleCategory(schedule) {
  const keyword = `${schedule.category || ""} ${schedule.title || ""} ${schedule.description || ""}`.toLowerCase();

  if (/education|class|baby talk|session/.test(keyword)) return "education";
  if (/consultation|consult/.test(keyword)) return "consultation";
  if (/reminder|alert/.test(keyword)) return "reminder";
  return "checkup";
}

function getReadableScheduleError(error) {
  if (!error) return "Unknown error.";

  if (error.code === "42501" || /row-level security|permission denied/i.test(error.message)) {
    return "Supabase rejected the request because of table permissions or RLS.";
  }

  if (error.code === "42P01" || /could not find the table|schema cache/i.test(error.message)) {
    return "Supabase cannot find the schedule table.";
  }

  return error.message || error.details || "Failed to save schedule.";
}

function buildAppointmentReminderPayload(schedule, patientRecordId) {
  const scheduleStart = new Date(schedule.start_time);
  const remindAt = new Date(scheduleStart);
  remindAt.setHours(remindAt.getHours() - 24);

  if (Number.isNaN(remindAt.getTime()) || remindAt < new Date()) {
    remindAt.setTime(scheduleStart.getTime());
    remindAt.setHours(remindAt.getHours() - 1);
  }

  return {
    patient_id: patientRecordId,
    schedule_id: schedule.id,
    reminder_type: "appointment",
    title: `${schedule.title || "Appointment"} Reminder`,
    message: `Reminder: ${schedule.patient_name || "Patient"} has ${schedule.title || "an appointment"} scheduled on ${formatLongDate(schedule.start_time)} at ${formatTime(schedule.start_time)}.`,
    remind_at: remindAt.toISOString(),
    status: "pending",
    sent_at: null,
  };
}

function createDoctorFollowUpForm(schedule, patient) {
  return {
    appointmentId: schedule?.id || "",
    patientId: patient?.patient_id || (patient?.id ? String(patient.id).slice(0, 8) : ""),
    patientRecordId: patient?.id || "",
    patientName: patient?.full_name || schedule?.patient_name || "",
    age: patient?.age ? `${patient.age} years` : "",
    contactNumber: patient?.contact_number || "",
    address: patient?.address || "",
    visitDate: toDateInputValue(schedule?.start_time) || toDateInputValue(new Date()),
    visitTime: toTimeInputValue(schedule?.start_time) || "09:00",
    visitType: schedule?.title || "Follow-up Visit",
    attendingPhysician: schedule?.doctor_name || "Dr. Kempee Vergara",
    gestationalAge: patient?.gestational_age || "",
    expectedDeliveryDate: toDateInputValue(patient?.expected_delivery_date),
    pregnancyStatus: patient?.risk_level || "Low Risk",
    bloodPressure: "",
    temperature: "",
    weight: "",
    heartRate: "",
    chiefComplaint: "",
    currentMedications: "",
    allergies: "",
    symptoms: "",
    fundalHeight: "",
    fetalHeartRate: "",
    presentation: "",
    urineProtein: "",
    urineGlucose: "",
    assessment: "",
    treatmentPlan: "",
    followUpDate: "",
    followUpTime: "",
    followUpInstructions: "",
    dangerSigns: "",
    nutritionCounseling: false,
    laboratoryRequest: false,
    ultrasoundRequest: false,
    highRiskReferral: false,
    additionalNotes: "",
  };
}

function ProfileDropdownIcon({ name }) {
  const paths = {
    profile: (
      <>
        <circle cx="12" cy="8" r="3.2" />
        <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
      </>
    ),
    settings: (
      <>
        <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 0 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1A2 2 0 0 1 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.6V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.6h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 0 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1h.1a2 2 0 0 1 0 4H21a1.7 1.7 0 0 0-1.6.9Z" />
      </>
    ),
    logout: (
      <>
        <path d="M10 17 15 12 10 7" />
        <path d="M15 12H3" />
        <path d="M12 3h6a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-6" />
      </>
    ),
  };

  return (
    <svg className="doctor-profile-dropdown-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function DefaultProfileCard() {
  const [isOpen, setIsOpen] = useState(false);
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

  const goToDoctorSection = (section) => {
    setIsOpen(false);
    window.dispatchEvent(new CustomEvent("doctor:navigate", { detail: { section } }));
    window.localStorage.setItem("doctor_active_section", section);
  };

  return (
    <div className={`doctor-appointments-profile-wrap ${isOpen ? "is-open" : ""}`} ref={profileRef}>
      <button
        className="doctor-appointments-profile"
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className="doctor-appointments-profile-avatar">KV</span>

        <span className="doctor-appointments-profile-copy">
          <strong>Kempee Vergara</strong>
          <small>Staff</small>
        </span>

        <span className="doctor-appointments-profile-arrow" aria-hidden="true">
          <InlineIcon name="chevronDown" />
        </span>
      </button>

      {isOpen ? (
        <div className="doctor-top-profile-dropdown" role="menu">
          <div className="doctor-top-profile-dropdown__header">
            <span className="doctor-top-profile-dropdown__avatar">KV</span>
            <span>
              <strong>Kempee Vergara</strong>
              <small>Staff Account</small>
            </span>
          </div>

          <div className="doctor-top-profile-dropdown__divider" />

          <button type="button" role="menuitem" onClick={() => goToDoctorSection("profile")}>
            <ProfileDropdownIcon name="profile" />
            View Profile
          </button>
          <button type="button" role="menuitem" onClick={() => goToDoctorSection("settings")}>
            <ProfileDropdownIcon name="settings" />
            Settings
          </button>
          <button className="is-danger" type="button" role="menuitem" onClick={() => goToDoctorSection("logout")}>
            <ProfileDropdownIcon name="logout" />
            Logout
          </button>
        </div>
      ) : null}
    </div>
  );
}

function DoctorFollowUpField({
  label,
  value,
  onChange,
  placeholder = "",
  type = "text",
}) {
  return (
    <label className="staff-followup-field">
      <span>{label}</span>
      <div className="staff-followup-input-wrap">
        <input
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
      </div>
    </label>
  );
}

function DoctorFollowUpTextarea({
  label,
  value,
  onChange,
  placeholder = "",
}) {
  return (
    <label className="staff-followup-field doctor-followup-field-wide">
      <span>{label}</span>
      <div className="staff-followup-input-wrap doctor-followup-textarea-wrap">
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
      </div>
    </label>
  );
}

function DoctorFollowUpSelect({
  label,
  value,
  onChange,
  options,
}) {
  return (
    <label className="staff-followup-field">
      <span>{label}</span>
      <div className="staff-followup-input-wrap doctor-followup-select-wrap">
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
    </label>
  );
}

function DoctorFollowUpChecklist({ form, onChange }) {
  const items = [
    ["nutritionCounseling", "Nutrition counseling"],
    ["laboratoryRequest", "Laboratory request"],
    ["ultrasoundRequest", "Ultrasound request"],
    ["highRiskReferral", "High-risk referral"],
  ];

  return (
    <section className="staff-followup-card doctor-followup-card-wide">
      <h2>Care Actions</h2>
      <div className="doctor-followup-checklist">
        {items.map(([key, label]) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={Boolean(form[key])}
              onChange={(event) => onChange(key, event.target.checked)}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </section>
  );
}

function DoctorFollowUpVisitForm({
  form,
  onBack,
  onChange,
  onSave,
  saving,
  statusMessage,
}) {
  const riskOptions = ["Low Risk", "Moderate Risk", "High Risk"];
  const presentationOptions = ["", "Cephalic", "Breech", "Transverse", "Not assessed"];
  const currentVisitDate = form.visitDate
    ? formatLongDate(`${form.visitDate}T00:00:00`)
    : "-";

  return (
    <section className="staff-followup-page doctor-followup-page">
      <header className="staff-followup-header">
        <button type="button" className="staff-followup-back" onClick={onBack}>
          <InlineIcon name="chevronLeft" />
          Back to Appointments
        </button>

        <div className="staff-followup-title">
          <h1>Follow-up Visit Form</h1>
          <p>Please provide complete information for accurate follow-up care</p>
        </div>

        <aside className="staff-followup-appointment-id">
          <span>Appointment ID</span>
          <strong>{form.appointmentId || "-"}</strong>
        </aside>
      </header>

      {statusMessage ? (
        <p className="doctor-appointments-status-message staff-followup-message">
          {statusMessage}
        </p>
      ) : null}

      <div className="staff-followup-grid">
        <section className="staff-followup-card">
          <h2>Patient Information</h2>
          <DoctorFollowUpField
            label="Patient ID"
            value={form.patientId}
            onChange={(value) => onChange("patientId", value)}
            placeholder="00-00-01"
          />
          <DoctorFollowUpField
            label="Patient Name"
            value={form.patientName}
            onChange={(value) => onChange("patientName", value)}
            placeholder="Patient name"
          />
          <DoctorFollowUpField
            label="Age"
            value={form.age}
            onChange={(value) => onChange("age", value)}
            placeholder="28 years"
          />
          <DoctorFollowUpField
            label="Contact Number"
            value={form.contactNumber}
            onChange={(value) => onChange("contactNumber", value)}
            placeholder="09XXXXXXXXX"
          />
          <DoctorFollowUpField
            label="Address"
            value={form.address}
            onChange={(value) => onChange("address", value)}
            placeholder="Home address"
          />
        </section>

        <section className="staff-followup-card">
          <h2>Visit Information</h2>
          <DoctorFollowUpField
            label="Date of Visit"
            type="date"
            value={form.visitDate}
            onChange={(value) => onChange("visitDate", value)}
          />
          <DoctorFollowUpField
            label="Time of Visit"
            type="time"
            value={form.visitTime}
            onChange={(value) => onChange("visitTime", value)}
          />
          <DoctorFollowUpField
            label="Visit Type"
            value={form.visitType}
            onChange={(value) => onChange("visitType", value)}
            placeholder="Follow-up Visit"
          />
          <DoctorFollowUpField
            label="Attending Physician"
            value={form.attendingPhysician}
            onChange={(value) => onChange("attendingPhysician", value)}
            placeholder="Dr. Kempee Vergara"
          />
        </section>

        <section className="staff-followup-card">
          <h2>Pregnancy Status</h2>
          <DoctorFollowUpField
            label="Gestational Age"
            value={form.gestationalAge}
            onChange={(value) => onChange("gestationalAge", value)}
            placeholder="28 Weeks 2 Days"
          />
          <DoctorFollowUpField
            label="Expected Delivery Date"
            type="date"
            value={form.expectedDeliveryDate}
            onChange={(value) => onChange("expectedDeliveryDate", value)}
          />

          <div className="staff-followup-risk-group">
            <span>Pregnancy Status</span>
            <div>
              {riskOptions.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={form.pregnancyStatus === option ? "is-active" : ""}
                  onClick={() => onChange("pregnancyStatus", option)}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>

      <section className="staff-followup-card staff-followup-clinical-card">
        <h2>Subjective Information</h2>
        <div className="staff-followup-clinical-grid">
          <DoctorFollowUpTextarea
            label="Chief Complaint"
            value={form.chiefComplaint}
            onChange={(value) => onChange("chiefComplaint", value)}
            placeholder="Reason for follow-up visit"
          />
          <DoctorFollowUpTextarea
            label="Symptoms / Patient Concerns"
            value={form.symptoms}
            onChange={(value) => onChange("symptoms", value)}
            placeholder="Symptoms, concerns, or changes since last visit"
          />
          <DoctorFollowUpField
            label="Current Medications"
            value={form.currentMedications}
            onChange={(value) => onChange("currentMedications", value)}
            placeholder="Prenatal vitamins, supplements, medicines"
          />
          <DoctorFollowUpField
            label="Allergies"
            value={form.allergies}
            onChange={(value) => onChange("allergies", value)}
            placeholder="Known allergies"
          />
        </div>
      </section>

      <section className="staff-followup-card staff-followup-clinical-card">
        <h2>Vital Signs</h2>
        <div className="staff-followup-clinical-grid">
          <DoctorFollowUpField
            label="Blood Pressure"
            value={form.bloodPressure}
            onChange={(value) => onChange("bloodPressure", value)}
            placeholder="e.g. 120/80 mmHg"
          />
          <DoctorFollowUpField
            label="Temperature"
            value={form.temperature}
            onChange={(value) => onChange("temperature", value)}
            placeholder="e.g. 36.7 C"
          />
          <DoctorFollowUpField
            label="Weight"
            value={form.weight}
            onChange={(value) => onChange("weight", value)}
            placeholder="e.g. 65 kg"
          />
          <DoctorFollowUpField
            label="Heart Rate"
            value={form.heartRate}
            onChange={(value) => onChange("heartRate", value)}
            placeholder="e.g. 140 bpm"
          />
        </div>
      </section>

      <section className="staff-followup-card staff-followup-clinical-card">
        <h2>Obstetric Examination</h2>
        <div className="staff-followup-clinical-grid">
          <DoctorFollowUpField
            label="Fundal Height"
            value={form.fundalHeight}
            onChange={(value) => onChange("fundalHeight", value)}
            placeholder="e.g. 28 cm"
          />
          <DoctorFollowUpField
            label="Fetal Heart Rate"
            value={form.fetalHeartRate}
            onChange={(value) => onChange("fetalHeartRate", value)}
            placeholder="e.g. 145 bpm"
          />
          <DoctorFollowUpSelect
            label="Presentation"
            value={form.presentation}
            onChange={(value) => onChange("presentation", value)}
            options={presentationOptions}
          />
          <DoctorFollowUpField
            label="Urine Protein"
            value={form.urineProtein}
            onChange={(value) => onChange("urineProtein", value)}
            placeholder="Negative / Trace / Positive"
          />
          <DoctorFollowUpField
            label="Urine Glucose"
            value={form.urineGlucose}
            onChange={(value) => onChange("urineGlucose", value)}
            placeholder="Negative / Trace / Positive"
          />
        </div>
      </section>

      <section className="staff-followup-card staff-followup-clinical-card">
        <h2>Assessment and Plan</h2>
        <div className="staff-followup-clinical-grid">
          <DoctorFollowUpTextarea
            label="Assessment"
            value={form.assessment}
            onChange={(value) => onChange("assessment", value)}
            placeholder="Clinical assessment and diagnosis"
          />
          <DoctorFollowUpTextarea
            label="Treatment Plan"
            value={form.treatmentPlan}
            onChange={(value) => onChange("treatmentPlan", value)}
            placeholder="Treatment, counseling, medications, and next steps"
          />
        </div>
      </section>

      <div className="staff-followup-grid">
        <section className="staff-followup-card">
          <h2>Follow-up Schedule</h2>
          <DoctorFollowUpField
            label="Next Follow-up Date"
            type="date"
            value={form.followUpDate}
            onChange={(value) => onChange("followUpDate", value)}
          />
          <DoctorFollowUpField
            label="Next Follow-up Time"
            type="time"
            value={form.followUpTime}
            onChange={(value) => onChange("followUpTime", value)}
          />
          <DoctorFollowUpTextarea
            label="Instructions"
            value={form.followUpInstructions}
            onChange={(value) => onChange("followUpInstructions", value)}
            placeholder="Instructions before the next visit"
          />
        </section>

        <section className="staff-followup-card">
          <h2>Risk and Warning Signs</h2>
          <DoctorFollowUpTextarea
            label="Danger Signs Discussed"
            value={form.dangerSigns}
            onChange={(value) => onChange("dangerSigns", value)}
            placeholder="Bleeding, severe headache, fever, reduced fetal movement"
          />
        </section>

        <DoctorFollowUpChecklist form={form} onChange={onChange} />
      </div>

      <section className="staff-followup-card staff-followup-clinical-card">
        <h2>Appointment Summary</h2>
        <div className="doctor-followup-history">
          <div className="doctor-followup-history-row doctor-followup-history-head">
            <span>Date</span>
            <span>Time</span>
            <span>Visit</span>
            <span>Status</span>
          </div>
          <div className="doctor-followup-history-row">
            <span>{currentVisitDate}</span>
            <span>{formatDisplayTime(form.visitTime) || "-"}</span>
            <span>{form.visitType || "Follow-up Visit"}</span>
            <span>Checked in</span>
          </div>
        </div>
      </section>

      <section className="staff-followup-card staff-followup-clinical-card">
        <h2>Additional Notes</h2>
        <DoctorFollowUpTextarea
          label="Doctor Notes"
          value={form.additionalNotes}
          onChange={(value) => onChange("additionalNotes", value)}
          placeholder="Additional observations or reminders"
        />
      </section>

      <footer className="staff-followup-actions">
        <button
          type="button"
          className="staff-followup-save"
          onClick={onSave}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save Record"}
        </button>
        <button type="button" className="staff-followup-cancel" onClick={onBack}>
          Cancel
        </button>
      </footer>
    </section>
  );
}

function StatusDropdown({
  schedule,
  openStatusMenuId,
  setOpenStatusMenuId,
  updatingStatusId,
  onSelectStatus,
  onOpenFollowUp,
}) {
  const isOpen = openStatusMenuId === schedule.id;
  const statusLabel = getStatusLabel(schedule.status);

  return (
    <span className="doctor-appointment-status-cell">
      <button
        className={`doctor-appointment-status doctor-appointment-status--${getStatusClass(schedule.status)}`}
        type="button"
        disabled={updatingStatusId === schedule.id}
        aria-expanded={isOpen}
        onClick={() => {
          setOpenStatusMenuId(isOpen ? "" : schedule.id);
        }}
      >
        <span>{updatingStatusId === schedule.id ? "Updating..." : statusLabel}</span>
        <InlineIcon name="chevronDown" />
      </button>

      {isOpen ? (
        <div className="doctor-appointment-status-menu">
          {statusOptions.map((option) => (
            <button
              className={`doctor-appointment-status-option doctor-appointment-status-option--${option.value}`}
              type="button"
              key={option.value}
              onClick={() => onSelectStatus(schedule, option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

function MiniMonthCalendar({ selectedDate, onSelectDate, onMoveMonth }) {
  const anchor = toDate(`${selectedDate}T00:00:00`) || new Date();
  const firstDay = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = new Date(firstDay);
  start.setDate(firstDay.getDate() - firstDay.getDay());

  const cells = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);

    return {
      key: toDateInputValue(date),
      number: date.getDate(),
      muted: date.getMonth() !== anchor.getMonth(),
      selected: toDateInputValue(date) === selectedDate,
    };
  });

  return (
    <section className="doctor-mini-calendar-card">
      <header>
        <h3>{formatMonthYear(selectedDate)}</h3>

        <div>
          <button type="button" onClick={() => onMoveMonth(-1)} aria-label="Previous month">
            ‹
          </button>
          <button type="button" onClick={() => onMoveMonth(1)} aria-label="Next month">
            ›
          </button>
        </div>
      </header>

      <div className="doctor-mini-calendar-weekdays">
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>

      <div className="doctor-mini-calendar-days">
        {cells.map((cell) => (
          <button
            className={`${cell.muted ? "is-muted" : ""} ${cell.selected ? "is-selected" : ""}`}
            key={cell.key}
            type="button"
            onClick={() => onSelectDate(cell.key)}
          >
            {cell.number}
          </button>
        ))}
      </div>
    </section>
  );
}

function AppointmentCategories() {
  const categories = [
    { label: "Check-up", icon: "heart", className: "is-checkup" },
    { label: "Consultation", icon: "consultation", className: "is-consultation" },
    { label: "Education", icon: "education", className: "is-education" },
    { label: "Reminder", icon: "reminder", className: "is-reminder" },
  ];

  return (
    <section className="doctor-appointment-categories-card">
      <h3>Categories</h3>

      <div>
        {categories.map((category) => (
          <article className={category.className} key={category.label}>
            <span>
              <InlineIcon name={category.icon} />
            </span>
            <strong>{category.label}</strong>
          </article>
        ))}
      </div>
    </section>
  );
}

function FigmaWeekCalendar({
  schedules,
  selectedDate,
  onSelectDate,
  onPreviousWeek,
  onNextWeek,
}) {
  const weekDays = getWeekDays(selectedDate);
  const timeSlots = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
  const startHour = 6;
  const hourHeight = 70;

  const schedulesByDay = useMemo(() => {
    return weekDays.reduce((acc, day) => {
      acc[day.key] = schedules.filter((schedule) => toDateInputValue(schedule.start_time) === day.key);
      return acc;
    }, {});
  }, [schedules, weekDays]);

  return (
    <section className="doctor-calendar-panel">
      <header className="doctor-calendar-header">
        <div className="doctor-calendar-title-group">
          <h2>Calendar</h2>
          <button type="button" onClick={onPreviousWeek} aria-label="Previous week">
            ‹
          </button>
          <button type="button" onClick={onNextWeek} aria-label="Next week">
            ›
          </button>
        </div>

        <strong>{getWeekRangeLabel(selectedDate)}</strong>
      </header>

      <div className="doctor-week-calendar">
        <div className="doctor-week-calendar-days">
          <span className="doctor-week-calendar-time-head">Time</span>

          {weekDays.map((day) => (
            <button
              className={day.key === selectedDate ? "is-selected" : ""}
              type="button"
              key={day.key}
              onClick={() => onSelectDate(day.key)}
            >
              <small>{day.dayName}</small>
              <strong>{day.dayNumber}</strong>
            </button>
          ))}
        </div>

        <div className="doctor-week-calendar-body" style={{ "--hour-height": `${hourHeight}px` }}>
          <div className="doctor-week-calendar-times">
            {timeSlots.map((hour) => (
              <span key={hour}>
                {hour === 12 ? "12 PM" : hour > 12 ? `${hour - 12} PM` : `${hour.toString().padStart(2, "0")} AM`}
              </span>
            ))}
          </div>

          <div className="doctor-week-calendar-grid">
            {weekDays.map((day) => (
              <div className="doctor-week-calendar-day" key={day.key}>
                {timeSlots.map((hour) => (
                  <span className="doctor-week-calendar-line" key={hour} />
                ))}

                {(schedulesByDay[day.key] || []).map((schedule) => {
                  const start = toDate(schedule.start_time);
                  const startMinutes = Math.max(
                    0,
                    ((start?.getHours() || startHour) - startHour) * 60 + (start?.getMinutes() || 0)
                  );
                  const top = (startMinutes / 60) * hourHeight;
                  const height = 66;
                  const category = getScheduleCategory(schedule);

                  return (
                    <article
                      className={`doctor-week-event is-${category}`}
                      key={schedule.id}
                      style={{
                        top: `${top}px`,
                        height: `${height}px`,
                      }}
                    >
                      <strong>{schedule.patient_name}</strong>
                      <span>{formatTime(schedule.start_time)} - {formatTime(schedule.end_time)}</span>
                      <small>{schedule.title}</small>
                    </article>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export function DoctorAppointmentsContent({ embedded = false, headerAction = null }) {
  const [form, setForm] = useState(initialAppointmentForm);
  const [patients, setPatients] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [localDemoSchedules, setLocalDemoSchedules] = useState([]);
  const [activeTab, setActiveTab] = useState("All");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedDate, setSelectedDate] = useState("2026-05-19");
  const [isAdding, setIsAdding] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingPatients, setIsLoadingPatients] = useState(false);
  const [openStatusMenuId, setOpenStatusMenuId] = useState("");
  const [updatingStatusId, setUpdatingStatusId] = useState("");
  const [cancelConfirmationSchedule, setCancelConfirmationSchedule] = useState(null);
  const [rescheduleSchedule, setRescheduleSchedule] = useState(null);
  const [rescheduleForm, setRescheduleForm] = useState(initialRescheduleForm);
  const [followUpSchedule, setFollowUpSchedule] = useState(null);
  const [followUpForm, setFollowUpForm] = useState(() => createDoctorFollowUpForm(null, null));
  const [isSavingFollowUp, setIsSavingFollowUp] = useState(false);

  const displaySchedules = schedules.length > 0 ? schedules : localDemoSchedules;

  const matchingPatients = form.patient_name.trim()
    ? patients
        .filter((patient) => {
          const keyword = form.patient_name.trim().toLowerCase();
          return (
            patient.full_name?.toLowerCase().includes(keyword) ||
            patient.contact_number?.toLowerCase().includes(keyword)
          );
        })
        .slice(0, 6)
    : [];

  const hasExactPatientMatch =
    patients.length === 0 ||
    patients.some(
      (patient) => patient.full_name?.toLowerCase() === form.patient_name.trim().toLowerCase()
    );

  const visibleSchedules = useMemo(
    () =>
      displaySchedules
        .filter((schedule) => statusMatches(schedule, activeTab))
        .filter((schedule) => searchMatches(schedule, searchTerm)),
    [activeTab, displaySchedules, searchTerm]
  );

  const loadAppointments = useCallback(async () => {
    const { data, error } = await supabase
      .from(scheduleTableName)
      .select(scheduleColumns)
      .order("start_time", { ascending: true });

    if (error) {
      console.error("[Doctor Appointment Flow] appointment fetch error:", error);
      setSchedules([]);
      setStatusMessage(
        `Unable to load appointments from Supabase: ${getReadableScheduleError(error)}`
      );
      return;
    }

    const nextSchedules = data ?? [];
    console.info("[Doctor Appointment Flow] returned appointment count:", nextSchedules.length);
    setSchedules(nextSchedules);

    if (nextSchedules.length > 0) {
      setSelectedDate(toDateInputValue(nextSchedules[0].start_time));
    }
  }, []);

  useEffect(() => {
    const loadTimer = window.setTimeout(() => {
      loadAppointments();
    }, 0);

    const channel = supabase
      .channel("doctor-appointments")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: scheduleTableName,
        },
        loadAppointments
      )
      .subscribe();

    return () => {
      window.clearTimeout(loadTimer);
      supabase.removeChannel(channel);
    };
  }, [loadAppointments]);

  useEffect(() => {
    const loadPatients = async () => {
      setIsLoadingPatients(true);

      const { data, error } = await supabase
        .from("patients")
        .select(patientColumns)
        .order("full_name", { ascending: true });

      setIsLoadingPatients(false);

      if (error) {
        console.error(error);
        return;
      }

      setPatients(data ?? []);
    };

    loadPatients();
  }, []);

  const updateFormValue = (field, value) => {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const selectPatient = (patient) => {
    updateFormValue("patient_name", patient.full_name || "");
    setStatusMessage("");
  };

  const updateFollowUpForm = (field, value) => {
    setFollowUpForm((current) => ({ ...current, [field]: value }));
  };

  const openFollowUpForm = async (schedule) => {
    setOpenStatusMenuId("");
    setStatusMessage("");
    setFollowUpSchedule(schedule);

    const localPatient = patients.find(
      (patient) =>
        patient.full_name?.toLowerCase() === String(schedule.patient_name || "").toLowerCase()
    );

    setFollowUpForm(createDoctorFollowUpForm(schedule, localPatient || null));

    if (localPatient || !schedule.patient_name) return;

    const { data, error } = await supabase
      .from("patients")
      .select(patientColumns)
      .ilike("full_name", schedule.patient_name)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn("Doctor follow-up patient lookup failed:", error);
      return;
    }

    if (data) {
      setFollowUpForm(createDoctorFollowUpForm(schedule, data));
    }
  };

  const moveWeek = (direction) => {
    const date = toDate(`${selectedDate}T00:00:00`) || new Date();
    date.setDate(date.getDate() + direction * 7);
    setSelectedDate(toDateInputValue(date));
  };

  const moveMonth = (direction) => {
    const date = toDate(`${selectedDate}T00:00:00`) || new Date();
    date.setMonth(date.getMonth() + direction);
    setSelectedDate(toDateInputValue(date));
  };

  const createAppointment = async (event) => {
    event.preventDefault();
    setStatusMessage("");

    const startDate = new Date(`${form.appointment_date}T${form.appointment_time}`);

    if (Number.isNaN(startDate.getTime())) {
      setStatusMessage("Choose a valid appointment date and time.");
      return;
    }

    if (!form.title.trim()) {
      setStatusMessage("Select an appointment type.");
      return;
    }

    if (!hasExactPatientMatch) {
      setStatusMessage("Select a patient from the search results before creating a schedule.");
      return;
    }

    const selectedPatient = patients.find(
      (patient) =>
        String(patient.full_name || "").trim().toLowerCase() ===
        form.patient_name.trim().toLowerCase()
    );

    if (!selectedPatient?.id) {
      setStatusMessage(
        "The selected patient could not be matched to a registered patient."
      );
      return;
    }

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user?.id) {
      console.error("[Doctor Appointment Flow] authenticated user lookup failed:", userError);
      setStatusMessage(
        "Unable to identify the logged-in account. Please sign in again."
      );
      return;
    }

    console.info("[Doctor Appointment Flow] authenticated user ID:", user.id);

    const { data: currentProfile, error: currentProfileError } = await supabase
      .from("profiles")
      .select("id, full_name, role")
      .eq("id", user.id)
      .maybeSingle();

    if (currentProfileError) {
      console.error("Unable to read the current profile:", currentProfileError);
    }

    const selectedDoctor = {
      id: user.id,
      full_name:
        form.doctor_name.trim() ||
        currentProfile?.full_name ||
        user.user_metadata?.full_name ||
        user.email ||
        "Doctor",
      role: currentProfile?.role || "doctor",
    };

    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);

    console.info("[Doctor Appointment Flow] resolved patient database ID:", selectedPatient.id);
    console.info("[Doctor Appointment Flow] resolved patient auth user ID:", selectedPatient.user_id || null);

    const payload = {
      patient_id: selectedPatient.id,
      doctor_id: selectedDoctor.id,
      patient_name: form.patient_name.trim(),
      doctor_name: form.doctor_name.trim(),
      title: form.title.trim(),
      description: form.description.trim() || null,
      start_time: startDate.toISOString(),
      end_time: endDate.toISOString(),
      status: "scheduled",
    };

    setIsSaving(true);

    const { data, error } = await supabase
      .from(scheduleTableName)
      .insert([payload])
      .select(scheduleColumns)
      .maybeSingle();

    setIsSaving(false);

    if (error) {
      console.error("[Doctor Appointment Flow] appointment insert error:", {
        error,
        payload,
      });
      setStatusMessage(
        `Appointment was not saved: ${getReadableScheduleError(error)}`
      );
      return;
    }

    console.info("[Doctor Appointment Flow] inserted appointment:", {
      id: data?.id,
      patient_id: data?.patient_id,
      status: data?.status,
      start_time: data?.start_time,
    });

    if (data?.id) {
      const reminderPayload = buildAppointmentReminderPayload(
        data,
        selectedPatient.id
      );

      const { error: reminderError } = await supabase
        .from("reminders")
        .insert([reminderPayload]);

      if (reminderError) {
        console.warn("Doctor appointment reminder save failed:", reminderError);
      }
    }

    setSchedules((current) => [data, ...current]);
    setForm(initialAppointmentForm);
    setIsAdding(false);
    setActiveTab("All");
    setSelectedDate(toDateInputValue(payload.start_time));
  };

  const updateScheduleStatus = async (schedule, nextStatus) => {
    setOpenStatusMenuId("");

    if (schedule.isDemo || String(schedule.id).startsWith("local-")) {
      setLocalDemoSchedules((current) =>
        current.map((item) => (item.id === schedule.id ? { ...item, status: nextStatus } : item))
      );
      return;
    }

    setUpdatingStatusId(schedule.id);

    const { error } = await supabase
      .from(scheduleTableName)
      .update({ status: nextStatus })
      .eq("id", schedule.id);

    setUpdatingStatusId("");

    if (error) {
      const message = getReadableScheduleError(error);
      setStatusMessage(message);
      alert(`Failed to update appointment status: ${message}`);
      return;
    }

    setSchedules((current) =>
      current.map((item) => (item.id === schedule.id ? { ...item, status: nextStatus } : item))
    );
  };

  const handleStatusSelect = (schedule, nextStatus) => {
    if (nextStatus === "scheduled") {
      setOpenStatusMenuId("");
      return;
    }

    if (nextStatus === "completed") {
      openFollowUpForm(schedule);
      return;
    }

    if (nextStatus === "cancelled") {
      setCancelConfirmationSchedule(schedule);
      setOpenStatusMenuId("");
      return;
    }

    updateScheduleStatus(schedule, nextStatus);
  };

  const saveFollowUpRecord = async () => {
    if (!followUpSchedule?.id) return;

    setIsSavingFollowUp(true);
    setStatusMessage("");

    if (followUpSchedule.isDemo || String(followUpSchedule.id).startsWith("local-")) {
      setLocalDemoSchedules((current) =>
        current.map((item) =>
          item.id === followUpSchedule.id ? { ...item, status: "completed" } : item
        )
      );
      setFollowUpSchedule(null);
      setFollowUpForm(createDoctorFollowUpForm(null, null));
      setIsSavingFollowUp(false);
      return;
    }

    const { error: statusError } = await supabase
      .from(scheduleTableName)
      .update({ status: "completed" })
      .eq("id", followUpSchedule.id);

    if (statusError) {
      const message = getReadableScheduleError(statusError);
      setStatusMessage(`Unable to complete appointment: ${message}`);
      setIsSavingFollowUp(false);
      return;
    }

    if (followUpForm.patientRecordId) {
      const recordPayload = {
        patient_id: followUpForm.patientRecordId,
        patient_name: followUpForm.patientName || followUpSchedule.patient_name,
        type: followUpForm.visitType || "Follow-up Visit",
        title: "Follow-up Visit",
        notes: "Follow-up visit completed by doctor.",
        uploaded_by: followUpForm.attendingPhysician || "Dr. Kempee Vergara",
        form_data: {
          visitType: followUpForm.visitType || "Follow-up Visit",
          gestationalAge: followUpForm.gestationalAge || "-",
          expectedDeliveryDate: followUpForm.expectedDeliveryDate
            ? formatLongDate(`${followUpForm.expectedDeliveryDate}T00:00:00`)
            : "-",
          doctor: followUpForm.attendingPhysician || "Dr. Kempee Vergara",
          visitDate: followUpForm.visitDate
            ? formatLongDate(`${followUpForm.visitDate}T00:00:00`)
            : "-",
          visitTime: formatDisplayTime(followUpForm.visitTime) || "-",
          pregnancyStatus: followUpForm.pregnancyStatus,
          chiefComplaint: followUpForm.chiefComplaint || "",
          symptoms: followUpForm.symptoms || "",
          currentMedications: followUpForm.currentMedications || "",
          allergies: followUpForm.allergies || "",
          findings: [
            { label: "Blood Pressure", value: followUpForm.bloodPressure || "-" },
            { label: "Temperature", value: followUpForm.temperature || "-" },
            { label: "Weight", value: followUpForm.weight || "-" },
            { label: "Heart Rate", value: followUpForm.heartRate || "-" },
            { label: "Fundal Height", value: followUpForm.fundalHeight || "-" },
            { label: "Fetal Heart Rate", value: followUpForm.fetalHeartRate || "-" },
            { label: "Presentation", value: followUpForm.presentation || "-" },
            { label: "Urine Protein", value: followUpForm.urineProtein || "-" },
            { label: "Urine Glucose", value: followUpForm.urineGlucose || "-" },
          ],
          assessment: followUpForm.assessment || "",
          treatmentPlan: followUpForm.treatmentPlan || "",
          followUpDate: followUpForm.followUpDate
            ? formatLongDate(`${followUpForm.followUpDate}T00:00:00`)
            : "-",
          followUpTime: formatDisplayTime(followUpForm.followUpTime) || "-",
          followUpInstructions: followUpForm.followUpInstructions || "",
          dangerSigns: followUpForm.dangerSigns || "",
          careActions: {
            nutritionCounseling: Boolean(followUpForm.nutritionCounseling),
            laboratoryRequest: Boolean(followUpForm.laboratoryRequest),
            ultrasoundRequest: Boolean(followUpForm.ultrasoundRequest),
            highRiskReferral: Boolean(followUpForm.highRiskReferral),
          },
          additionalNotes: followUpForm.additionalNotes || "",
        },
      };

      const { error: recordError } = await supabase
        .from("medical_records")
        .insert(recordPayload);

      if (recordError) {
        console.warn("Doctor follow-up medical record insert failed:", recordError);
        setStatusMessage(
          `Appointment completed, but the medical record was not saved: ${recordError.message}`
        );
      }
    } else {
      setStatusMessage(
        "Appointment completed, but no matching patient record was found for the follow-up record."
      );
    }

    setSchedules((current) =>
      current.map((item) =>
        item.id === followUpSchedule.id ? { ...item, status: "completed" } : item
      )
    );
    setFollowUpSchedule(null);
    setFollowUpForm(createDoctorFollowUpForm(null, null));
    setIsSavingFollowUp(false);
    await loadAppointments();
  };

  const confirmCancelAppointment = () => {
    if (!cancelConfirmationSchedule) return;

    updateScheduleStatus(cancelConfirmationSchedule, "cancelled");
    setCancelConfirmationSchedule(null);
  };

  const startRescheduleAppointment = () => {
    if (!cancelConfirmationSchedule) return;

    setRescheduleSchedule(cancelConfirmationSchedule);
    setRescheduleForm({
      date: toDateInputValue(cancelConfirmationSchedule.start_time),
      time: toTimeInputValue(cancelConfirmationSchedule.start_time),
      message: cancelConfirmationSchedule.description || "",
    });
    setCancelConfirmationSchedule(null);
  };

  const closeRescheduleModal = () => {
    setRescheduleSchedule(null);
    setRescheduleForm(initialRescheduleForm);
  };

  const saveRescheduleAppointment = async (event) => {
    event.preventDefault();

    if (!rescheduleSchedule) return;

    const startDate = new Date(`${rescheduleForm.date}T${rescheduleForm.time}`);

    if (Number.isNaN(startDate.getTime())) {
      setStatusMessage("Choose a valid reschedule date and time.");
      return;
    }

    const previousStart = toDate(rescheduleSchedule.start_time);
    const previousEnd = toDate(rescheduleSchedule.end_time);
    const duration =
      previousStart && previousEnd && previousEnd > previousStart
        ? previousEnd.getTime() - previousStart.getTime()
        : 60 * 60 * 1000;

    const endDate = new Date(startDate.getTime() + duration);
    const payload = {
      start_time: startDate.toISOString(),
      end_time: endDate.toISOString(),
      description: rescheduleForm.message.trim() || null,
      status: "scheduled",
    };

    if (rescheduleSchedule.isDemo || String(rescheduleSchedule.id).startsWith("local-")) {
      setLocalDemoSchedules((current) =>
        current.map((item) =>
          item.id === rescheduleSchedule.id ? { ...item, ...payload } : item
        )
      );
      setSelectedDate(toDateInputValue(startDate));
      closeRescheduleModal();
      return;
    }

    setUpdatingStatusId(rescheduleSchedule.id);

    const { error } = await supabase
      .from(scheduleTableName)
      .update(payload)
      .eq("id", rescheduleSchedule.id);

    setUpdatingStatusId("");

    if (error) {
      const message = getReadableScheduleError(error);
      setStatusMessage(message);
      alert(`Failed to reschedule appointment: ${message}`);
      return;
    }

    setSchedules((current) =>
      current.map((item) => (item.id === rescheduleSchedule.id ? { ...item, ...payload } : item))
    );
    setSelectedDate(toDateInputValue(startDate));
    closeRescheduleModal();
  };

  if (followUpSchedule) {
    return (
      <DoctorFollowUpVisitForm
        form={followUpForm}
        onBack={() => {
          setFollowUpSchedule(null);
          setStatusMessage("");
        }}
        onChange={updateFollowUpForm}
        onSave={saveFollowUpRecord}
        saving={isSavingFollowUp}
        statusMessage={statusMessage}
      />
    );
  }

  return (
    <main className={`doctor-appointments-page${embedded ? " doctor-appointments-page--embedded" : ""}`}>
      <header className="doctor-appointments-header">
        <div className="doctor-appointments-title-block">
          <h1>Appointments</h1>
          <p>Schedule, monitor, and update patient appointments.</p>

          <nav className="doctor-appointments-tabs" aria-label="Appointment status">
            {appointmentTabs.map((tab) => (
              <button
                className={activeTab === tab ? "is-active" : ""}
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
              >
                {tab}
              </button>
            ))}
          </nav>
        </div>

        {headerAction || <DefaultProfileCard />}
      </header>

      <section className="doctor-appointments-action-row">
        <form
          className="doctor-appointments-search"
          onSubmit={(event) => {
            event.preventDefault();
          }}
        >
          <label>
            <InlineIcon name="search" />
            <input
              type="search"
              placeholder="Search Appointment or ID"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </label>
        </form>

        <button className="doctor-appointments-add" type="button" onClick={() => setIsAdding(true)}>
          <InlineIcon name="plus" />
          <span>Add Appointment</span>
        </button>
      </section>

      {statusMessage ? <p className="doctor-appointments-status-message">{statusMessage}</p> : null}

      <section className="doctor-appointments-table-card" aria-label="Appointments">
        <div className="doctor-appointments-table-scroll">
          <div className="doctor-appointments-table__head">
            <span>Appointment ID</span>
            <span>Name</span>
            <span>Date</span>
            <span>Time</span>
            <span>Status</span>
          </div>

          {visibleSchedules.length > 0 ? (
            visibleSchedules.map((schedule) => (
              <div className="doctor-appointments-row" key={schedule.id}>
                <span>
                  {schedule.maternal_appointment_id ||
                    String(schedule.id).slice(0, 9)}
                </span>
                <span>{schedule.patient_name || "-"}</span>
                <span>{formatTableDate(schedule.start_time)}</span>
                <span>{formatTime(schedule.start_time)}</span>
                <StatusDropdown
                  schedule={schedule}
                  openStatusMenuId={openStatusMenuId}
                  setOpenStatusMenuId={setOpenStatusMenuId}
                  updatingStatusId={updatingStatusId}
                  onSelectStatus={handleStatusSelect}
                  onOpenFollowUp={openFollowUpForm}
                />
              </div>
            ))
          ) : (
            <div className="doctor-appointments-empty">No appointments found.</div>
          )}
        </div>
      </section>

      <section className="doctor-calendar-layout">
        <FigmaWeekCalendar
          schedules={displaySchedules}
          selectedDate={selectedDate}
          onSelectDate={setSelectedDate}
          onPreviousWeek={() => moveWeek(-1)}
          onNextWeek={() => moveWeek(1)}
        />

        <aside className="doctor-calendar-sidebar">
          <MiniMonthCalendar
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            onMoveMonth={moveMonth}
          />

          <AppointmentCategories />
        </aside>
      </section>

      {isAdding
        ? createPortal(
            <div className="appointment-modal-overlay" role="dialog" aria-modal="true">
              <section className="appointment-form-card appointment-add-card">
                <button
                  className="appointment-modal-close"
                  type="button"
                  aria-label="Close add appointment form"
                  onClick={() => {
                    setIsAdding(false);
                    setStatusMessage("");
                  }}
                >
                  <InlineIcon name="close" />
                </button>

                <div className="appointment-form-heading">
                  <h2>Add New Appointment</h2>
                </div>

                <form className="appointment-form-grid" onSubmit={createAppointment}>
                  <label className="appointment-form-field appointment-form-field--wide">
                    <span>
                      Patient Name:
                    </span>

                    <div className="appointment-patient-search">
                      <input
                        type="search"
                        placeholder={isLoadingPatients ? "Loading patients..." : "Enter patient name"}
                        value={form.patient_name}
                        onChange={(event) => updateFormValue("patient_name", event.target.value)}
                        required
                      />

                      {matchingPatients.length > 0 && !hasExactPatientMatch ? (
                        <div className="appointment-patient-results">
                          {matchingPatients.map((patient) => (
                            <button key={patient.id} type="button" onClick={() => selectPatient(patient)}>
                              <strong>{patient.full_name}</strong>
                              <small>{patient.contact_number || "No contact number"}</small>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </label>

                  <label className="appointment-form-field">
                    <span>
                      Select Date:
                    </span>
                    <input
                      type="date"
                      value={form.appointment_date}
                      onChange={(event) => updateFormValue("appointment_date", event.target.value)}
                      required
                    />
                  </label>

                  <label className="appointment-form-field">
                    <span>
                      Select Time:
                    </span>
                    <input
                      type="time"
                      value={form.appointment_time}
                      onChange={(event) => updateFormValue("appointment_time", event.target.value)}
                      required
                    />
                  </label>

                  <label className="appointment-form-field appointment-form-field--wide">
                    <span>
                      Select Type:
                    </span>
                    <select
                      value={form.title}
                      onChange={(event) => updateFormValue("title", event.target.value)}
                      required
                    >
                      <option value="" disabled>
                        Select appointment type
                      </option>
                      <option value="Prenatal Checkup">Prenatal Checkup</option>
                      <option value="Consultation">Consultation</option>
                      <option value="Education">Education</option>
                      <option value="Reminder">Reminder</option>
                      <option value="Follow-up">Follow-up</option>
                    </select>
                  </label>

                  <label className="appointment-form-field appointment-form-field--wide">
                    <span>
                      Message:
                    </span>
                    <textarea
                      rows="3"
                      placeholder="Add additional details..."
                      value={form.description}
                      onChange={(event) => updateFormValue("description", event.target.value)}
                    />
                  </label>

                  {statusMessage ? <p className="appointment-form-message">{statusMessage}</p> : null}

                  <div className="appointment-form-actions">
                    <button
                      className="appointment-add-save"
                      type="submit"
                      disabled={isSaving}
                    >
                      {isSaving ? "Saving..." : "Save"}
                    </button>
                    <button
                      className="appointment-form-cancel appointment-add-cancel"
                      type="button"
                      onClick={() => {
                        setIsAdding(false);
                        setStatusMessage("");
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </section>
            </div>,
            document.body
          )
        : null}

      
      {cancelConfirmationSchedule
        ? createPortal(
            <div className="doctor-appointment-confirm-overlay" role="dialog" aria-modal="true">
              <section className="doctor-appointment-confirm-card">
                <h2>Cancel Appointment</h2>
                <p>Are you sure you want to cancel this appointment?</p>

                <div className="doctor-appointment-confirm-actions">
                  <button type="button" onClick={confirmCancelAppointment}>
                    Yes, Cancel it
                  </button>
                  <button type="button" onClick={startRescheduleAppointment}>
                    Reschedule it
                  </button>
                </div>
              </section>
            </div>,
            document.body
          )
        : null}
      {rescheduleSchedule
        ? createPortal(
            <div className="doctor-appointment-confirm-overlay" role="dialog" aria-modal="true">
              <section className="doctor-appointment-reschedule-card">
                <h2>Reschedule Appointment</h2>

                <form onSubmit={saveRescheduleAppointment}>
                  <label>
                    Select Date:
                    <input
                      type="date"
                      value={rescheduleForm.date}
                      onChange={(event) =>
                        setRescheduleForm((current) => ({ ...current, date: event.target.value }))
                      }
                      required
                    />
                  </label>

                  <label>
                    Select Time:
                    <input
                      type="time"
                      value={rescheduleForm.time}
                      onChange={(event) =>
                        setRescheduleForm((current) => ({ ...current, time: event.target.value }))
                      }
                      required
                    />
                  </label>

                  <label>
                    Message:
                    <input
                      type="text"
                      value={rescheduleForm.message}
                      onChange={(event) =>
                        setRescheduleForm((current) => ({ ...current, message: event.target.value }))
                      }
                    />
                  </label>

                  <div className="doctor-appointment-reschedule-actions">
                    <button
                      className="doctor-appointment-reschedule-save"
                      type="submit"
                      disabled={updatingStatusId === rescheduleSchedule.id}
                    >
                      {updatingStatusId === rescheduleSchedule.id ? "Saving..." : "Save"}
                    </button>
                    <button
                      className="doctor-appointment-reschedule-cancel"
                      type="button"
                      onClick={closeRescheduleModal}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </section>
            </div>,
            document.body
          )
        : null}
    </main>
  );
}

function DoctorAppointments() {
  return <DoctorAppointmentsContent />;
}

export default DoctorAppointments;
