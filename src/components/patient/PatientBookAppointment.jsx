import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import { PatientPageHeader } from "./PatientPwaUi";
import "../../styles/patientbookappointment.css";

const SERVICES = [
  {
    id: "prenatal",
    title: "Prenatal Check-up",
    databaseTitle: "Follow-up Prenatal Check-up",
    description: "Regular check-up for you and your baby",
    icon: "solar:stethoscope-linear",
  },
  {
    id: "ultrasound",
    title: "Ultrasound Appointment",
    databaseTitle: "Ultrasound Examination",
    description: "Ultrasound scan and monitoring",
    icon: "solar:monitor-camera-linear",
  },
  {
    id: "laboratory",
    title: "Laboratory Test Appointment",
    databaseTitle: "Laboratory Test",
    description: "Required laboratory exams",
    icon: "solar:test-tube-linear",
  },
  {
    id: "high-risk",
    title: "High-Risk Pregnancy Consultation",
    databaseTitle: "High-Risk Pregnancy Consultation",
    description: "Specialist consultation",
    icon: "solar:heart-pulse-linear",
  },
  {
    id: "follow-up",
    title: "Follow-up Consultation",
    databaseTitle: "Follow-up Prenatal Check-up",
    description: "Follow-up on previous visit",
    icon: "solar:clipboard-text-linear",
  },
];

const STEPS = ["Service", "Doctor", "Date & Time", "Review"];
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const TIME_SLOTS = ["08:00", "09:00", "10:00", "13:00", "14:00", "15:00", "16:00"];
const INACTIVE_DOCTOR_STATUSES = new Set([
  "inactive",
  "deactivated",
  "disabled",
  "suspended",
  "archived",
  "deleted",
]);

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(value, amount) {
  const date = new Date(value);
  date.setDate(date.getDate() + amount);
  return date;
}

function addMonths(value, amount) {
  return new Date(value.getFullYear(), value.getMonth() + amount, 1);
}

function toDateKey(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromKey(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function isSameDay(first, second) {
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

function buildMonthDays(monthDate) {
  const first = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const gridStart = addDays(first, -first.getDay());

  return Array.from({ length: 42 }, (_, index) => {
    const date = addDays(gridStart, index);
    return {
      date,
      key: toDateKey(date),
      muted: date.getMonth() !== monthDate.getMonth(),
    };
  });
}

function formatTime(value) {
  const [hours, minutes] = value.split(":").map(Number);
  const date = new Date(2000, 0, 1, hours, minutes);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function getDoctorName(profile, personalById) {
  return (
    personalById.get(profile.id)?.full_name ||
    profile.full_name ||
    profile.email ||
    "Clinic doctor"
  );
}

function getReadableBookingError(error) {
  const message = String(error?.message || "");
  const normalized = message.toLowerCase();

  if (normalized.includes("no patient record is linked")) {
    return "Your patient account is not linked to a patient record yet. Please contact the clinic.";
  }

  if (normalized.includes("selected doctor is not available")) {
    return "The selected doctor is not available. Please choose another doctor.";
  }

  if (normalized.includes("duplicate") || error?.code === "23505") {
    return "That appointment slot is no longer available. Please choose another time.";
  }

  if (error?.code === "42883" || error?.code === "PGRST202") {
    return "The online-booking database function is not installed yet. Please contact the clinic administrator.";
  }

  if (normalized.includes("row-level security") || error?.code === "42501") {
    return "Your request could not be submitted because your account does not have permission to create a booking request.";
  }

  if (normalized.includes("does not exist") || normalized.includes("column")) {
    return `The booking database is not configured correctly: ${message}`;
  }

  return message || "We could not submit your booking request. Please try again.";
}

export default function PatientBookAppointment({ profile }) {
  const navigate = useNavigate();
  const tomorrow = useMemo(() => addDays(startOfDay(new Date()), 1), []);
  const [step, setStep] = useState(1);
  const [serviceId, setServiceId] = useState(SERVICES[0].id);
  const [doctors, setDoctors] = useState([]);
  const [selectedDoctorId, setSelectedDoctorId] = useState("");
  const [isLoadingDoctors, setIsLoadingDoctors] = useState(true);
  const [selectedDate, setSelectedDate] = useState(toDateKey(tomorrow));
  const [calendarMonth, setCalendarMonth] = useState(
    () => new Date(tomorrow.getFullYear(), tomorrow.getMonth(), 1)
  );
  const [selectedTime, setSelectedTime] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submittedAppointmentId, setSubmittedAppointmentId] = useState("");

  useEffect(() => {
    let active = true;

    const loadDoctors = async () => {
      const directoryResult = await supabase.rpc("get_patient_booking_doctors");

      if (!active) return;

      if (!directoryResult.error && Array.isArray(directoryResult.data) && directoryResult.data.length) {
        const nextDoctors = directoryResult.data.map((doctor) => ({
          id: doctor.doctor_id,
          databaseId: doctor.doctor_id,
          name: doctor.doctor_name || "Clinic doctor",
          specialty: doctor.specialty || "Obstetrics and Gynecology",
        }));
        setDoctors(nextDoctors);
        setSelectedDoctorId(nextDoctors[0]?.id || "");
        setIsLoadingDoctors(false);
        return;
      }

      const [profilesResult, personalResult, scheduleResult] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, full_name, email, role, account_status")
          .ilike("role", "doctor"),
        supabase
          .from("doctor_personal_information")
          .select("auth_user_id, full_name"),
        profile?.recordId
          ? supabase
              .from("schedule")
              .select("doctor_id, doctor_name")
              .eq("patient_id", profile.recordId)
              .not("doctor_name", "is", null)
          : Promise.resolve({ data: [], error: null }),
      ]);

      if (!active) return;

      const personalById = new Map(
        (personalResult.error ? [] : personalResult.data || []).map((row) => [
          row.auth_user_id,
          row,
        ])
      );
      const availableDoctors = (profilesResult.error ? [] : profilesResult.data || [])
        .filter((doctor) => {
          const status = String(doctor.account_status || "active").toLowerCase();
          return doctor.id && !INACTIVE_DOCTOR_STATUSES.has(status);
        })
        .map((doctor) => ({
          id: doctor.id,
          name: getDoctorName(doctor, personalById),
          specialty: "Obstetrics and Gynecology",
        }));
      const previousDoctors = (scheduleResult.error ? [] : scheduleResult.data || [])
        .filter((doctor) => doctor.doctor_name)
        .map((doctor) => ({
          id: doctor.doctor_id || `name:${doctor.doctor_name}`,
          databaseId: doctor.doctor_id || null,
          name: doctor.doctor_name,
          specialty: "Obstetrics and Gynecology",
        }));
      const doctorMap = new Map();

      [...availableDoctors, ...previousDoctors].forEach((doctor) => {
        const key = doctor.id || doctor.name.toLowerCase();
        if (!doctorMap.has(key)) doctorMap.set(key, doctor);
      });

      if (!doctorMap.size && profile?.physician && profile.physician !== "Not assigned") {
        doctorMap.set(`name:${profile.physician}`, {
          id: `name:${profile.physician}`,
          databaseId: null,
          name: profile.physician,
          specialty: "Obstetrics and Gynecology",
        });
      }

      if (!doctorMap.size) {
        doctorMap.set("clinic-team", {
          id: "clinic-team",
          databaseId: null,
          name: "Available clinic doctor",
          specialty: "Maternal care team",
        });
      }

      const nextDoctors = Array.from(doctorMap.values()).sort((first, second) =>
        first.name.localeCompare(second.name)
      );
      setDoctors(nextDoctors);
      setSelectedDoctorId((current) => current || nextDoctors[0]?.id || "");
      setIsLoadingDoctors(false);
    };

    loadDoctors();
    return () => {
      active = false;
    };
  }, [profile?.physician, profile?.recordId]);

  const selectedService = SERVICES.find((service) => service.id === serviceId) || SERVICES[0];
  const selectedDoctor = doctors.find((doctor) => doctor.id === selectedDoctorId) || doctors[0];
  const monthDays = useMemo(() => buildMonthDays(calendarMonth), [calendarMonth]);
  const chosenDate = dateFromKey(selectedDate);
  const chosenDateLabel = chosenDate.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const canContinue =
    (step === 1 && Boolean(selectedService)) ||
    (step === 2 && Boolean(selectedDoctor)) ||
    (step === 3 && Boolean(selectedDate && selectedTime));

  const handleDateSelect = (date) => {
    if (startOfDay(date) < startOfDay(tomorrow)) return;
    setSelectedDate(toDateKey(date));
    setCalendarMonth(new Date(date.getFullYear(), date.getMonth(), 1));
    setSelectedTime("");
  };

  const submitBooking = async () => {
    // The RPC gets the patient_id and patient_name from auth.uid(), so this
    // page does not need to insert directly into the request table.
    if (!selectedService || !selectedDoctor || !selectedDate || !selectedTime) {
      setSubmitError("Please complete all booking details before submitting.");
      return;
    }

    const [hours, minutes] = selectedTime.split(":").map(Number);
    const startDate = dateFromKey(selectedDate);
    startDate.setHours(hours, minutes, 0, 0);

    if (Number.isNaN(startDate.getTime())) {
      setSubmitError("Please select a valid appointment date and time.");
      return;
    }

    setIsSubmitting(true);
    setSubmitError("");

    try {
      // Confirm that a patient is actually signed in before calling the RPC.
      const { data: authData, error: authError } = await supabase.auth.getUser();

      if (authError || !authData?.user) {
        setSubmitError("Your session has expired. Please sign in again before booking an appointment.");
        return;
      }

      const selectedDoctorKey = String(selectedDoctor.id || "");
      const doctorId =
        selectedDoctor.databaseId ||
        (selectedDoctorKey.startsWith("name:") || selectedDoctorKey === "clinic-team"
          ? null
          : selectedDoctorKey || null);

      // This calls the Supabase PostgreSQL function. The function resolves the
      // authenticated Patient record and stores a pending row in the
      // same-named public.create_patient_appointment_request table.
      const { data, error } = await supabase.rpc(
        "create_patient_appointment_request",
        {
          p_doctor_id: doctorId,
          p_doctor_name: selectedDoctor.name,
          p_title: selectedService.databaseTitle,
          p_category: selectedService.id,
          p_start_time: startDate.toISOString(),
        }
      );

      if (error) {
        console.error("Patient booking request failed:", error);
        setSubmitError(getReadableBookingError(error));
        return;
      }

      const requestId = data?.request_id || data?.id || data?.schedule_id;

      if (!requestId) {
        console.warn("Booking RPC succeeded but returned no request id:", data);
      }

      setSubmittedAppointmentId(requestId || "submitted");
    } catch (error) {
      console.error("Unexpected patient booking error:", error);
      setSubmitError(
        "We could not submit your booking request. Please check your connection and try again."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  if (submittedAppointmentId) {
    return (
      <section className="pwa-page patient-booking-page">
        <div className="patient-booking-success" role="status">
          <span><Icon icon="solar:calendar-check-bold" /></span>
          <p>Booking request submitted</p>
          <h1>Your appointment request is on its way.</h1>
          <small>
            {selectedService.title} with {selectedDoctor.name} on {chosenDateLabel} at {formatTime(selectedTime)}.
          </small>
          <button type="button" onClick={() => navigate("/patient/appointments", { replace: true })}>
            View my appointments
            <Icon icon="solar:arrow-right-linear" />
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="pwa-page patient-booking-page">
      <PatientPageHeader
        title="Book Appointment"
        subtitle="Fill out the booking request form to schedule your appointment."
        className="patient-booking-title"
      />

      <ol className="patient-booking-stepper" aria-label="Booking progress">
        {STEPS.map((label, index) => {
          const number = index + 1;
          const completed = number < step;
          return (
            <li
              key={label}
              className={`${number === step ? "is-active" : ""} ${completed ? "is-complete" : ""}`}
              aria-current={number === step ? "step" : undefined}
            >
              <span>{completed ? <Icon icon="solar:check-read-linear" /> : number}</span>
              <strong>{label}</strong>
            </li>
          );
        })}
      </ol>

      <div className="patient-booking-card">
        {step === 1 ? (
          <section className="patient-booking-panel" aria-labelledby="booking-service-title">
            <header>
              <h2 id="booking-service-title">1. Select Appointment Type</h2>
              <p>Choose the type of appointment you want to book.</p>
            </header>
            <div className="patient-service-grid">
              {SERVICES.map((service) => (
                <button
                  type="button"
                  key={service.id}
                  className={serviceId === service.id ? "is-selected" : ""}
                  onClick={() => setServiceId(service.id)}
                  aria-pressed={serviceId === service.id}
                >
                  <span className="patient-service-radio" />
                  <span className="patient-service-icon"><Icon icon={service.icon} /></span>
                  <span>
                    <strong>{service.title}</strong>
                    <small>{service.description}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {step === 2 ? (
          <section className="patient-booking-panel" aria-labelledby="booking-doctor-title">
            <header>
              <h2 id="booking-doctor-title">2. Select Doctor</h2>
              <p>Choose your preferred doctor.</p>
            </header>
            <label className="patient-doctor-select">
              <span><Icon icon="solar:user-rounded-linear" /></span>
              <span>
                <strong>{isLoadingDoctors ? "Loading doctors..." : selectedDoctor?.name}</strong>
                <small>{selectedDoctor?.specialty || "Maternal care"}</small>
              </span>
              <select
                value={selectedDoctorId}
                onChange={(event) => setSelectedDoctorId(event.target.value)}
                disabled={isLoadingDoctors}
                aria-label="Select doctor"
              >
                {doctors.map((doctor) => (
                  <option key={doctor.id} value={doctor.id}>{doctor.name}</option>
                ))}
              </select>
              <Icon icon="solar:alt-arrow-down-linear" />
            </label>
            <div className="patient-selected-service">
              <Icon icon="solar:info-circle-bold" />
              <span>
                <small>Selected service</small>
                <strong><Icon icon={selectedService.icon} /> {selectedService.title}</strong>
              </span>
              <button type="button" onClick={() => setStep(1)}>Change</button>
            </div>
          </section>
        ) : null}

        {step === 3 ? (
          <section className="patient-booking-panel" aria-labelledby="booking-date-title">
            <header>
              <h2 id="booking-date-title">3. Select Date and Time</h2>
              <p>Choose your preferred date and time for the appointment.</p>
            </header>
            <div className="patient-date-time-grid">
              <div className="patient-booking-calendar">
                <header>
                  <button type="button" onClick={() => setCalendarMonth((month) => addMonths(month, -1))} aria-label="Previous month">
                    <Icon icon="solar:alt-arrow-left-linear" />
                  </button>
                  <strong>{calendarMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</strong>
                  <button type="button" onClick={() => setCalendarMonth((month) => addMonths(month, 1))} aria-label="Next month">
                    <Icon icon="solar:alt-arrow-right-linear" />
                  </button>
                </header>
                <div className="patient-booking-weekdays">
                  {WEEKDAYS.map((day) => <span key={day}>{day}</span>)}
                </div>
                <div className="patient-booking-days">
                  {monthDays.map(({ date, key, muted }) => {
                    const disabled = startOfDay(date) < startOfDay(tomorrow);
                    return (
                      <button
                        type="button"
                        key={key}
                        className={`${muted ? "is-muted" : ""} ${isSameDay(date, chosenDate) ? "is-selected" : ""}`}
                        disabled={disabled}
                        onClick={() => handleDateSelect(date)}
                        aria-label={date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
                      >
                        {date.getDate()}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="patient-time-slots">
                <header>
                  <h3>Available Time Slots</h3>
                  <p>Select an available appointment time</p>
                </header>
                <div>
                  {TIME_SLOTS.map((time) => (
                    <button
                      type="button"
                      key={time}
                      className={selectedTime === time ? "is-selected" : ""}
                      onClick={() => setSelectedTime(time)}
                    >
                      {formatTime(time)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {step === 4 ? (
          <section className="patient-booking-panel patient-review-panel" aria-labelledby="booking-review-title">
            <header>
              <h2 id="booking-review-title">4. Review Appointment</h2>
              <p>Please review your appointment details before submitting.</p>
            </header>
            <dl>
              <div>
                <dt><Icon icon="solar:calendar-linear" /> Appointment Type</dt>
                <dd>{selectedService.title}</dd>
                <button type="button" onClick={() => setStep(1)}>Change</button>
              </div>
              <div>
                <dt><Icon icon="solar:user-rounded-linear" /> Doctor</dt>
                <dd>{selectedDoctor?.name}</dd>
                <button type="button" onClick={() => setStep(2)}>Change</button>
              </div>
              <div>
                <dt><Icon icon="solar:calendar-linear" /> Date</dt>
                <dd>{chosenDateLabel}</dd>
                <button type="button" onClick={() => setStep(3)}>Change</button>
              </div>
              <div>
                <dt><Icon icon="solar:clock-circle-linear" /> Time</dt>
                <dd>{formatTime(selectedTime)}</dd>
                <button type="button" onClick={() => setStep(3)}>Change</button>
              </div>
            </dl>
            <div className="patient-booking-notice">
              <Icon icon="solar:info-circle-bold" />
              <span>Please make sure all details are correct.<br />You can go back to make changes if needed.</span>
            </div>
            {submitError ? <p className="patient-booking-error" role="alert">{submitError}</p> : null}
          </section>
        ) : null}
      </div>

      <footer className="patient-booking-actions">
        <button
          type="button"
          className="is-secondary"
          onClick={() => step === 1 ? navigate("/patient/appointments") : setStep((current) => current - 1)}
        >
          {step > 1 ? <Icon icon="solar:arrow-left-linear" /> : null}
          {step === 1 ? "Cancel" : "Back"}
        </button>
        {step < 4 ? (
          <button type="button" className="is-primary" disabled={!canContinue} onClick={() => setStep((current) => current + 1)}>
            Next <Icon icon="solar:arrow-right-linear" />
          </button>
        ) : (
          <button type="button" className="is-primary is-submit" disabled={isSubmitting} onClick={submitBooking}>
            <Icon icon="solar:plain-bold" />
            {isSubmitting ? "Submitting..." : "Submit Booking Request"}
          </button>
        )}
      </footer>
    </section>
  );
}
