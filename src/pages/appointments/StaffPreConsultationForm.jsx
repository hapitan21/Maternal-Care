import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Calendar } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import {
  getManilaDateKey,
  getManilaTimeKey,
} from "../../lib/appointmentDate";
import "../../styles/staff-preconsultation.css";

const scheduleColumns =
  "id, maternal_appointment_id, patient_id, doctor_id, patient_name, doctor_name, title, start_time, end_time, status";
const patientColumns =
  "id, patient_id, full_name, age, contact_number, address";

const initialFields = {
  visitDate: "",
  visitTime: "",
  hpvVaccinated: "",
  lastPapSmear: "",
  otherDetails: "",
  height: "",
  weight: "",
  bloodPressure: "",
  temperature: "",
  respiratoryRate: "",
  oxygenSaturation: "",
  remarks: "",
};

const followUpFields = {
  visitDate: "",
  visitTime: "",
  gestationalAge: "",
  expectedDeliveryDate: "",
  pregnancyStatus: "",
  bloodPressure: "",
  temperature: "",
  weight: "",
  fetalHeartRate: "",
};

const pregnancyStatusOptions = ["Low Risk", "Moderate Risk", "High Risk"];

function normalizeVisitType(value) {
  return value === "follow_up" ? "follow_up" : "initial";
}

function isMissingIntakeSupport(error) {
  if (!error) return false;
  const message = `${error.message || ""} ${error.details || ""} ${error.hint || ""}`.toLowerCase();
  return (
    error.code === "42883" ||
    error.code === "42P01" ||
    error.code === "PGRST202" ||
    error.code === "PGRST204" ||
    message.includes("get_staff_visit_intake") ||
    message.includes("save_staff_visit_intake") ||
    message.includes("staff_visit_intake") ||
    message.includes("schema cache")
  );
}

function getErrorMessage(error, fallback) {
  return [error?.message || fallback, error?.code ? `Code: ${error.code}.` : ""]
    .filter(Boolean)
    .join(" ");
}

function getAppointmentDisplayId(appointment) {
  return appointment?.maternal_appointment_id || appointment?.id || "-";
}

function getPatientAge(patient) {
  const age = String(patient?.age ?? "").trim();
  return age ? `${age} years` : "";
}

function toInputDate(value) {
  if (!value) return "";
  return getManilaDateKey(value);
}

function createFormDefaults(visitType, appointment) {
  const base = visitType === "follow_up" ? followUpFields : initialFields;
  return {
    ...base,
    visitDate: toInputDate(appointment?.start_time),
    visitTime: getManilaTimeKey(appointment?.start_time),
    gestationalAge: "",
    expectedDeliveryDate: "",
    pregnancyStatus: "",
  };
}

function parseGestationalAgeToDays(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const match = normalized.match(
    /^(\d{1,2})(?:\s*(?:weeks?|wks?|wk|w))?(?:\s*(?:and\s*)?(\d{1,2})\s*(?:days?|d))?$/
  );

  if (!match) return null;

  const weeks = Number(match[1]);
  const days = Number(match[2] || 0);

  if (
    !Number.isInteger(weeks) ||
    weeks < 0 ||
    weeks > 45 ||
    !Number.isInteger(days) ||
    days < 0 ||
    days > 6
  ) {
    return null;
  }

  return (weeks * 7) + days;
}

function parseDateKeyToUtc(value) {
  const normalized = String(value || "").trim();
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;

  const time = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3])
  );

  return Number.isFinite(time) ? time : null;
}

function progressGestationalAge(value, anchorVisitDate, currentVisitDate) {
  const original = String(value || "").trim();
  const baselineDays = parseGestationalAgeToDays(original);
  const anchorTime = parseDateKeyToUtc(anchorVisitDate);
  const currentTime = parseDateKeyToUtc(currentVisitDate);

  if (
    baselineDays == null ||
    anchorTime == null ||
    currentTime == null ||
    currentTime <= anchorTime
  ) {
    return original;
  }

  const elapsedDays = Math.floor(
    (currentTime - anchorTime) / (24 * 60 * 60 * 1000)
  );

  const totalDays = baselineDays + elapsedDays;
  const weeks = Math.floor(totalDays / 7);
  const days = totalDays % 7;

  return days
    ? `${weeks} weeks ${days} days`
    : `${weeks} weeks`;
}

function buildPreviousDoctorVisitDefaults(record, appointment) {
  // The RPC returns the latest Doctor baseline plus a gestational-age anchor
  // from the earliest completed Doctor visit that has a valid age/date pair.
  const currentVisitDate = getManilaDateKey(appointment?.start_time);
  const gestationalAge = progressGestationalAge(
    record?.gestational_age_anchor || record?.gestational_age,
    record?.gestational_age_anchor_date || record?.source_visit_date,
    currentVisitDate
  );

  return {
    gestationalAge: gestationalAge || String(record?.gestational_age || ""),
    expectedDeliveryDate: String(record?.expected_delivery_date || ""),
    pregnancyStatus: String(record?.pregnancy_status || ""),
  };
}

function normalizeLoadedForm(visitType, appointment, intake, previousRecord = null) {
  const defaults = createFormDefaults(visitType, appointment);
  const baselineDefaults =
    visitType === "follow_up"
      ? buildPreviousDoctorVisitDefaults(previousRecord, appointment)
      : {};
  const data = intake?.intake_data && typeof intake.intake_data === "object"
    ? intake.intake_data
    : {};

  const loaded = {
    ...defaults,
    ...baselineDefaults,
    ...Object.fromEntries(
      Object.keys(defaults).map((key) => [
        key,
        data[key] ?? baselineDefaults[key] ?? defaults[key],
      ])
    ),
  };

  // Gestational age is a calculated pregnancy timeline value. Recalculate it
  // from the Doctor anchor even when an older Staff intake saved a stale age.
  if (visitType === "follow_up" && baselineDefaults.gestationalAge) {
    loaded.gestationalAge = baselineDefaults.gestationalAge;
  }

  return loaded;
}

function trimValue(value) {
  return String(value || "").trim();
}

function parseNumber(value) {
  const parsed = Number(trimValue(value).replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function validateRange(errors, form, key, label, min, max, unit = "") {
  const raw = trimValue(form[key]);
  if (!raw) {
    errors[key] = `${label} is required.`;
    return;
  }

  const value = parseNumber(raw);
  if (value === null || value < min || value > max) {
    errors[key] = `${label} must be ${min}-${max}${unit ? ` ${unit}` : ""}.`;
  }
}

function validateBloodPressure(value) {
  return /^\s*\d{2,3}\s*\/\s*\d{2,3}(?:\s*mmhg)?\s*$/i.test(value);
}

function validateStaffIntake(visitType, form) {
  const errors = {};

  if (!trimValue(form.visitDate)) errors.visitDate = "Date of visit is required.";
  if (!trimValue(form.visitTime)) errors.visitTime = "Time of visit is required.";

  if (visitType === "initial") {
    if (!trimValue(form.hpvVaccinated)) errors.hpvVaccinated = "HPV vaccination status is required.";
    validateRange(errors, form, "height", "Height", 80, 250, "cm");
    validateRange(errors, form, "weight", "Weight", 25, 250, "kg");
    validateRange(errors, form, "temperature", "Temperature", 30, 45, "C");
    validateRange(errors, form, "respiratoryRate", "Respiratory rate", 5, 60, "/min");
    validateRange(errors, form, "oxygenSaturation", "Oxygen saturation", 1, 100, "%");
  } else {
    if (!trimValue(form.gestationalAge)) errors.gestationalAge = "Gestational age is required.";
    if (!trimValue(form.expectedDeliveryDate)) {
      errors.expectedDeliveryDate = "Expected delivery date is required.";
    }
    if (!trimValue(form.pregnancyStatus)) errors.pregnancyStatus = "Pregnancy status is required.";
    validateRange(errors, form, "temperature", "Temperature", 30, 45, "C");
    validateRange(errors, form, "weight", "Weight", 25, 250, "kg");
    validateRange(errors, form, "fetalHeartRate", "Fetal heart rate", 60, 220, "bpm");
  }

  if (!trimValue(form.bloodPressure)) {
    errors.bloodPressure = "Blood pressure is required.";
  } else if (!validateBloodPressure(form.bloodPressure)) {
    errors.bloodPressure = "Use systolic/diastolic format, e.g. 120/80.";
  }

  return errors;
}

function ReadOnlyField({ label, value }) {
  return (
    <label className="staff-preconsult-field">
      <span>{label}</span>
      <input type="text" value={value || ""} readOnly aria-readonly="true" />
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder = "",
  type = "text",
  error = "",
  readOnly = false,
}) {
  return (
    <label className={`staff-preconsult-field${error ? " has-error" : ""}`}>
      <span>{label}</span>
      <input
        type={type}
        value={value || ""}
        placeholder={placeholder}
        readOnly={readOnly}
        disabled={readOnly}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? "true" : "false"}
      />
      {error ? <small>{error}</small> : null}
    </label>
  );
}

function TextAreaField({ label, value, onChange, placeholder, error = "", readOnly = false }) {
  return (
    <label className={`staff-preconsult-field staff-preconsult-field-wide${error ? " has-error" : ""}`}>
      <span>{label}</span>
      <textarea
        value={value || ""}
        placeholder={placeholder}
        readOnly={readOnly}
        disabled={readOnly}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? "true" : "false"}
      />
      {error ? <small>{error}</small> : null}
    </label>
  );
}

function DateField({ label, value, onChange, error = "", readOnly = false }) {
  return (
    <label className={`staff-preconsult-field${error ? " has-error" : ""}`}>
      <span>{label}</span>
      <div className="staff-preconsult-date">
        <input
          type="date"
          value={value || ""}
          readOnly={readOnly}
          disabled={readOnly}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={error ? "true" : "false"}
        />
        <Calendar aria-hidden="true" />
      </div>
      {error ? <small>{error}</small> : null}
    </label>
  );
}

function RadioGroup({ label, value, onChange, options, error = "", readOnly = false }) {
  return (
    <fieldset className={`staff-preconsult-choice-group${error ? " has-error" : ""}`}>
      <legend>{label}</legend>
      <div>
        {options.map((option) => (
          <label key={option}>
            <input
              type="radio"
              checked={value === option}
              disabled={readOnly}
              onChange={() => onChange(option)}
            />
            <span>{option}</span>
          </label>
        ))}
      </div>
      {error ? <small>{error}</small> : null}
    </fieldset>
  );
}

function RiskSelector({ value, onChange, error = "", readOnly = false }) {
  return (
    <fieldset className={`staff-preconsult-risk${error ? " has-error" : ""}`}>
      <legend>Pregnancy Status</legend>
      <div>
        {pregnancyStatusOptions.map((option) => (
          <button
            key={option}
            type="button"
            className={value === option ? "is-active" : ""}
            disabled={readOnly}
            onClick={() => onChange(option)}
          >
            {option}
          </button>
        ))}
      </div>
      {error ? <small>{error}</small> : null}
    </fieldset>
  );
}

export default function StaffPreConsultationForm({ appointmentId, requestedType }) {
  const navigate = useNavigate();
  const requestIdRef = useRef(0);
  const saveLockRef = useRef(false);
  const visitType = normalizeVisitType(requestedType);
  const isFollowUp = visitType === "follow_up";
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [schemaWarning, setSchemaWarning] = useState("");
  const [validationErrors, setValidationErrors] = useState({});
  const [routing, setRouting] = useState(null);
  const [appointment, setAppointment] = useState(null);
  const [patient, setPatient] = useState(null);
  const [intake, setIntake] = useState(null);
  const [previousDoctorRecord, setPreviousDoctorRecord] = useState(null);
  const [form, setForm] = useState(() => ({ ...(isFollowUp ? followUpFields : initialFields) }));

  const loadForm = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError("");
    setMessage("");
    setSchemaWarning("");
    setValidationErrors({});

    const { data: routingData, error: routingError } = await supabase.rpc(
      "get_appointment_visit_form_type",
      { p_appointment_id: appointmentId }
    );

    if (requestIdRef.current !== requestId) return;
    if (routingError) {
      setError(getErrorMessage(routingError, "Unable to determine the visit form type."));
      setLoading(false);
      return;
    }

    const routeResult = Array.isArray(routingData) ? routingData[0] : routingData;
    if (!routeResult?.visit_form_type) {
      setError("The visit-routing RPC did not return a form type.");
      setLoading(false);
      return;
    }

    if (routeResult.visit_form_type !== visitType) {
      const routeSegment = routeResult.visit_form_type === "initial"
        ? "initial-visit"
        : "follow-up";
      navigate(`/staff/appointments/${appointmentId}/${routeSegment}`, { replace: true });
      return;
    }

    const { data: schedule, error: scheduleError } = await supabase
      .from("schedule")
      .select(scheduleColumns)
      .eq("id", appointmentId)
      .maybeSingle();

    if (requestIdRef.current !== requestId) return;
    if (scheduleError || !schedule?.patient_id) {
      setError(getErrorMessage(scheduleError, "The appointment could not be loaded."));
      setLoading(false);
      return;
    }

    const [patientResult, intakeResult, previousRecordResult] = await Promise.all([
      supabase
        .rpc("get_staff_patient_directory")
        .select(patientColumns)
        .eq("id", schedule.patient_id)
        .maybeSingle(),
      supabase.rpc("get_staff_visit_intake", { p_appointment_id: appointmentId }),
      isFollowUp
        ? supabase.rpc("get_staff_followup_baseline", {
            p_appointment_id: appointmentId,
          })
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (requestIdRef.current !== requestId) return;
    if (patientResult.error) {
      setError(getErrorMessage(patientResult.error, "The Patient record could not be loaded."));
      setLoading(false);
      return;
    }

    if (previousRecordResult.error) {
      setError(
        getErrorMessage(
          previousRecordResult.error,
          "Previous Doctor visit baseline could not be loaded for follow-up autofill."
        )
      );
      setLoading(false);
      return;
    }

    let loadedIntake = Array.isArray(intakeResult.data) ? intakeResult.data[0] : intakeResult.data;
    if (intakeResult.error) {
      loadedIntake = null;
      if (isMissingIntakeSupport(intakeResult.error)) {
        setSchemaWarning(
          "Staff intake storage is not installed yet. Manually run supabase_staff_preconsultation_intake.sql before saving."
        );
      } else {
        setError(getErrorMessage(intakeResult.error, "The Staff intake record could not be loaded."));
        setLoading(false);
        return;
      }
    }

    const patientRow = patientResult.data || null;
    const previousRecord = isFollowUp
      ? (Array.isArray(previousRecordResult.data)
          ? previousRecordResult.data[0]
          : previousRecordResult.data) || null
      : null;

    setRouting(routeResult);
    setAppointment(schedule);
    setPatient(patientRow);
    setIntake(loadedIntake || null);
    setPreviousDoctorRecord(previousRecord);
    setForm(normalizeLoadedForm(visitType, schedule, loadedIntake, previousRecord));
    setLoading(false);
  }, [appointmentId, navigate, visitType]);

  useEffect(() => {
    const timer = window.setTimeout(loadForm, 0);
    return () => {
      requestIdRef.current += 1;
      window.clearTimeout(timer);
    };
  }, [loadForm]);

  const appointmentStatus = String(routing?.appointment_status || appointment?.status || "").trim().toLowerCase();
  const isReadOnly = useMemo(
    () => ["completed", "cancelled", "canceled", "cancel", "no_show", "no show"].includes(appointmentStatus),
    [appointmentStatus]
  );

  const updateForm = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
    setValidationErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const saveForm = async () => {
    if (saveLockRef.current || isReadOnly) return;

    const errors = validateStaffIntake(visitType, form);
    setValidationErrors(errors);
    setError("");
    setMessage("");
    if (Object.keys(errors).length) {
      setError("Complete the highlighted fields before saving.");
      return;
    }

    saveLockRef.current = true;
    setSaving(true);

    try {
      const intakeData = {
        ...form,
        appointmentDisplayId: getAppointmentDisplayId(appointment),
        appointmentDate: getManilaDateKey(appointment?.start_time),
        appointmentTime: getManilaTimeKey(appointment?.start_time),
        patientDisplayId: patient?.patient_id || "",
        patientName: patient?.full_name || appointment?.patient_name || "",
        doctorName: appointment?.doctor_name || "",
        staffFormVersion: 1,
      };

      const { data, error: saveError } = await supabase.rpc(
        "save_staff_visit_intake",
        {
          p_appointment_id: appointmentId,
          p_visit_form_type: visitType,
          p_intake_data: intakeData,
        }
      );

      if (saveError) {
        setError(getErrorMessage(saveError, "Unable to save Staff pre-consultation intake."));
        return;
      }

      const savedIntake = Array.isArray(data) ? data[0] : data;
      setIntake(savedIntake || intake);
      setMessage(
        isFollowUp
          ? "Follow-up pre-consultation intake saved. The appointment remains checked in for the Doctor."
          : "Initial visit pre-consultation intake saved. The appointment remains checked in for the Doctor."
      );

      // The Staff intake is complete. Return to the Appointments page while
      // leaving the appointment status unchanged (Checked in) for the Doctor.
      navigate("/staff/appointments", { replace: true });
    } catch (saveError) {
      setError(getErrorMessage(saveError, "Unable to save Staff pre-consultation intake."));
    } finally {
      saveLockRef.current = false;
      setSaving(false);
    }
  };

  if (loading) {
    return <main className="staff-preconsult-state">Loading pre-consultation form...</main>;
  }

  if (error && !appointment) {
    return (
      <main className="staff-preconsult-state" role="alert">
        <p>{error}</p>
        <button type="button" onClick={loadForm}>Retry</button>
        <button type="button" onClick={() => navigate("/staff/appointments")}>
          Back to Appointments
        </button>
      </main>
    );
  }

  const title = isFollowUp ? "Follow-Up Visit Form" : "Initial Visit Form";
  const subtitle = isFollowUp
    ? "Please provide complete information for accurate follow-up care"
    : "Please provide complete information for initial visit";

  return (
    <main className="staff-preconsult-page">
      <header className="staff-preconsult-header">
        <div className="staff-preconsult-title">
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        <aside className="staff-preconsult-appointment-id">
          <span>Appointment ID</span>
          <strong>{getAppointmentDisplayId(appointment)}</strong>
        </aside>
      </header>

      {schemaWarning ? <p className="staff-preconsult-warning">{schemaWarning}</p> : null}
      {error ? <p className="staff-preconsult-message is-error" role="alert">{error}</p> : null}
      {message ? <p className="staff-preconsult-message is-success">{message}</p> : null}
      {intake?.staff_completed_at ? (
        <p className="staff-preconsult-message">
          Saved intake loaded. Saving again updates the Staff intake only while the Doctor record is still open.
        </p>
      ) : null}
      {isFollowUp && !intake?.staff_completed_at && previousDoctorRecord ? (
        <p className="staff-preconsult-message">
          Pregnancy baseline was prefilled from the Patient&apos;s latest completed Doctor visit. Record today&apos;s vital signs as new measurements.
        </p>
      ) : null}

      <section className={`staff-preconsult-top-grid${isFollowUp ? " is-follow-up" : ""}`}>
        <div className="staff-preconsult-card">
          <h2>Patient Information</h2>
          <ReadOnlyField label="Patient ID" value={patient?.patient_id || ""} />
          <ReadOnlyField label="Patient Name" value={patient?.full_name || appointment?.patient_name || ""} />
          <ReadOnlyField label="Age" value={getPatientAge(patient)} />
          <ReadOnlyField label="Contact Number" value={patient?.contact_number || ""} />
          <ReadOnlyField label="Address" value={patient?.address || ""} />
        </div>

        <div className="staff-preconsult-card">
          <h2>Visit Information</h2>
          <DateField
            label="Date of Visit"
            value={form.visitDate}
            onChange={(value) => updateForm("visitDate", value)}
            error={validationErrors.visitDate}
            readOnly={isReadOnly}
          />
          <TextField
            label="Time of Visit"
            type="time"
            value={form.visitTime}
            onChange={(value) => updateForm("visitTime", value)}
            error={validationErrors.visitTime}
            readOnly={isReadOnly}
          />
          <ReadOnlyField label="Visit Type" value={isFollowUp ? "Follow-up Visit" : appointment?.title || "Initial Visit"} />
          <ReadOnlyField label="Attending Physician" value={appointment?.doctor_name || ""} />
        </div>

        {isFollowUp ? (
          <div className="staff-preconsult-card">
            <h2>Pregnancy Status</h2>
            <TextField
              label="Gestational Age"
              value={form.gestationalAge}
              placeholder="Enter gestational age"
              onChange={(value) => updateForm("gestationalAge", value)}
              error={validationErrors.gestationalAge}
              readOnly={isReadOnly}
            />
            <DateField
              label="Expected Delivery Date"
              value={form.expectedDeliveryDate}
              onChange={(value) => updateForm("expectedDeliveryDate", value)}
              error={validationErrors.expectedDeliveryDate}
              readOnly={isReadOnly}
            />
            <RiskSelector
              value={form.pregnancyStatus}
              onChange={(value) => updateForm("pregnancyStatus", value)}
              error={validationErrors.pregnancyStatus}
              readOnly={isReadOnly}
            />
          </div>
        ) : null}
      </section>

      <section className="staff-preconsult-card staff-preconsult-section-card">
        <h2>{isFollowUp ? "Clinical Findings" : "Initial Assessment"}</h2>
        {isFollowUp ? (
          <div className="staff-preconsult-field-grid is-three">
            <TextField label="Blood Pressure" value={form.bloodPressure} placeholder="e.g. 120/80 mmHg" onChange={(value) => updateForm("bloodPressure", value)} error={validationErrors.bloodPressure} readOnly={isReadOnly} />
            <TextField label="Temperature" value={form.temperature} placeholder="e.g. 36.7 C" onChange={(value) => updateForm("temperature", value)} error={validationErrors.temperature} readOnly={isReadOnly} />
            <TextField label="Weight" value={form.weight} placeholder="e.g. 65 kg" onChange={(value) => updateForm("weight", value)} error={validationErrors.weight} readOnly={isReadOnly} />
            <TextField label="Fetal Heart Rate" value={form.fetalHeartRate} placeholder="e.g. 140 bpm" onChange={(value) => updateForm("fetalHeartRate", value)} error={validationErrors.fetalHeartRate} readOnly={isReadOnly} />
          </div>
        ) : (
          <>
            <div className="staff-preconsult-field-grid is-three">
              <RadioGroup
                label="HPV Vaccination"
                value={form.hpvVaccinated}
                options={["Yes", "No"]}
                onChange={(value) => updateForm("hpvVaccinated", value)}
                error={validationErrors.hpvVaccinated}
                readOnly={isReadOnly}
              />
              <DateField
                label="Last Pap Smear"
                value={form.lastPapSmear}
                onChange={(value) => updateForm("lastPapSmear", value)}
                readOnly={isReadOnly}
              />
              <TextField
                label="Others"
                value={form.otherDetails}
                placeholder="Enter details (if any)"
                onChange={(value) => updateForm("otherDetails", value)}
                readOnly={isReadOnly}
              />
              <TextField label="Height" value={form.height} placeholder="Enter cm" onChange={(value) => updateForm("height", value)} error={validationErrors.height} readOnly={isReadOnly} />
              <TextField label="Weight" value={form.weight} placeholder="Enter kg" onChange={(value) => updateForm("weight", value)} error={validationErrors.weight} readOnly={isReadOnly} />
              <TextField label="Blood Pressure" value={form.bloodPressure} placeholder="--- / ---" onChange={(value) => updateForm("bloodPressure", value)} error={validationErrors.bloodPressure} readOnly={isReadOnly} />
              <TextField label="Temperature" value={form.temperature} placeholder="Enter C" onChange={(value) => updateForm("temperature", value)} error={validationErrors.temperature} readOnly={isReadOnly} />
              <TextField label="Respiratory Rate" value={form.respiratoryRate} placeholder="Enter /min" onChange={(value) => updateForm("respiratoryRate", value)} error={validationErrors.respiratoryRate} readOnly={isReadOnly} />
              <TextField label="Oxygen Saturation" value={form.oxygenSaturation} placeholder="Enter %" onChange={(value) => updateForm("oxygenSaturation", value)} error={validationErrors.oxygenSaturation} readOnly={isReadOnly} />
            </div>
            <TextAreaField
              label="Remarks"
              value={form.remarks}
              placeholder="Enter remarks or notes"
              onChange={(value) => updateForm("remarks", value)}
              readOnly={isReadOnly}
            />
          </>
        )}
      </section>

      <footer className="staff-preconsult-actions">
        <button
          type="button"
          className="staff-preconsult-primary"
          disabled={saving || isReadOnly || Boolean(schemaWarning)}
          onClick={saveForm}
        >
          {saving ? "Saving..." : "Save Record"}
        </button>
        <button
          type="button"
          className="staff-preconsult-secondary"
          disabled={saving}
          onClick={() => navigate("/staff/appointments")}
        >
          Cancel
        </button>
      </footer>
    </main>
  );
}
