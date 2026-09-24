import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "@iconify/react";
import ProfilePictureActions from "../../components/common/ProfilePictureActions";
import ProfileAvatarContent from "../../components/common/ProfileAvatarContent";
import { supabase } from "../../lib/supabaseClient";
import {
  classifyAppointment,
  normalizeAppointmentStatus,
} from "../../lib/appointmentDate";
import {
  clinicAccountStatuses,
  normalizeClinicAccountStatus,
} from "../../lib/clinicAccountStatus";
import "../../styles/doctor-viewprofile.css";

function getDoctorInitials(name) {
  const initials = String(name || "Doctor")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

  return initials || "DR";
}

function formatProfileDate(value) {
  if (!value) return "Not provided";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(value);

  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function recordedValue(value, fallback = "Not provided") {
  if (value === null || value === undefined) return fallback;
  return String(value).trim() || fallback;
}

function formatProfileLabel(value, fallback = "Not provided") {
  const normalized = recordedValue(value, "");
  if (!normalized) return fallback;

  return normalized
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function getAccountStatusPresentation(value) {
  const recordedStatus = recordedValue(value, "");

  if (!recordedStatus) {
    return { label: "Not provided", tone: "unknown" };
  }

  const normalizedStatus = normalizeClinicAccountStatus(recordedStatus);

  return {
    label:
      normalizedStatus === clinicAccountStatuses.inactive
        ? "Inactive"
        : "Active",
    tone: normalizedStatus,
  };
}


const emptyAppointmentSummary = {
  cancelled: 0,
  today: 0,
  pending: 0,
  completed: 0,
};

const appointmentSummaryCards = [
  {
    key: "cancelled",
    label: "Cancelled",
    icon: "solar:calendar-mark-linear",
    path: "/doctor/appointments?status=cancelled",
  },
  {
    key: "today",
    label: "Today's",
    icon: "solar:calendar-date-linear",
    path: "/doctor/appointments?scope=today",
  },
  {
    key: "pending",
    label: "Pending",
    icon: "solar:clock-circle-linear",
    path: "/doctor/appointments?status=pending",
  },
  {
    key: "completed",
    label: "Completed",
    icon: "solar:check-circle-linear",
    path: "/doctor/appointments?status=completed",
  },
];

const appointmentSummaryPeriods = [
  { value: "this-month", label: "This month" },
  { value: "last-month", label: "Last month" },
  { value: "all-time", label: "All time" },
];

function getAppointmentSummaryRange(period) {
  if (period === "all-time") {
    return null;
  }

  const now = new Date();
  const monthOffset = period === "last-month" ? -1 : 0;
  const start = new Date(
    now.getFullYear(),
    now.getMonth() + monthOffset,
    1
  );
  const end = new Date(
    now.getFullYear(),
    now.getMonth() + monthOffset + 1,
    1
  );

  return {
    start: start.getTime(),
    end: end.getTime(),
  };
}

function isAppointmentInSummaryPeriod(appointment, period) {
  const range = getAppointmentSummaryRange(period);
  if (!range) return true;

  const appointmentTime = new Date(appointment?.start_time || "").getTime();

  return (
    Number.isFinite(appointmentTime) &&
    appointmentTime >= range.start &&
    appointmentTime < range.end
  );
}

function ProfileInfoRow({ item }) {
  return (
    <div className="doctor-profile-info-row">
      <div className="doctor-profile-row-icon">
        <Icon icon={item.icon} />
      </div>

      <div className="doctor-profile-row-text">
        <span>{item.label}</span>
        <strong>{item.value}</strong>
      </div>
    </div>
  );
}

function ProfileDetailRow({ item }) {
  return (
    <div className="doctor-profile-detail-row">
      <span>{item.label}</span>
      <strong>{item.value}</strong>
    </div>
  );
}

function DoctorViewProfileContent({ doctorIdentity = null, headerAction = null }) {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState("personal");
  const [avatarOverride, setAvatarOverride] = useState(null);
  const [appointmentSummaryPeriod, setAppointmentSummaryPeriod] =
    useState("this-month");
  const [appointmentSummary, setAppointmentSummary] = useState(
    emptyAppointmentSummary
  );
  const [appointmentSummaryMessage, setAppointmentSummaryMessage] =
    useState("");
  const personal = doctorIdentity?.personalInformation;
  const professional = doctorIdentity?.professionalInformation;
  const identityProfile = doctorIdentity?.profile;
  const authenticatedDoctorId = identityProfile?.id || "";
  const accountStatus = getAccountStatusPresentation(
    identityProfile?.account_status
  );
  const profile = {
    id: identityProfile?.id || "",
    displayName: recordedValue(doctorIdentity?.doctorDisplayName),
    roleLabel: formatProfileLabel(identityProfile?.role || doctorIdentity?.role),
  };
  const contactDetails = [
    {
      icon: "solar:letter-linear",
      label: "Email Address",
      value: recordedValue(doctorIdentity?.doctorEmail),
    },
    {
      icon: "solar:phone-linear",
      label: "Phone Number",
      value: recordedValue(doctorIdentity?.doctorContactNumber),
    },
    {
      icon: "solar:map-point-linear",
      label: "Location",
      value: recordedValue(
        [professional?.clinic_hospital_name, professional?.clinic_address]
          .filter(Boolean)
          .join(", "),
        "Not provided"
      ),
    },
  ];
  const personalInfo = [
    {
      icon: "solar:user-rounded-linear",
      label: "Full Name",
      value: recordedValue(doctorIdentity?.doctorDisplayName),
    },
    {
      icon:
        String(personal?.gender || "").trim().toLowerCase() === "male"
          ? "mdi:gender-male"
          : String(personal?.gender || "").trim().toLowerCase() === "female"
            ? "mdi:gender-female"
            : "mdi:gender-male-female",
      label: "Gender",
      value: recordedValue(personal?.gender),
    },
    {
      icon: "solar:calendar-linear",
      label: "Birthdate",
      value: formatProfileDate(personal?.birthdate),
    },
    {
      icon: "solar:flag-linear",
      label: "Nationality",
      value: recordedValue(personal?.nationality),
    },
  ];
  const personalContactInfo = [
    {
      icon: "solar:heart-linear",
      label: "Civil Status",
      value: recordedValue(personal?.civil_status),
    },
    {
      icon: "solar:letter-linear",
      label: "Email Address",
      value: recordedValue(doctorIdentity?.doctorEmail),
    },
    {
      icon: "solar:phone-linear",
      label: "Contact Number",
      value: recordedValue(doctorIdentity?.doctorContactNumber),
    },
  ];
  const professionalInfo = [
    { label: "Doctor ID", value: recordedValue(professional?.doctor_code) },
    { label: "License Number", value: recordedValue(professional?.license_number) },
    {
      label: "Board Certification",
      value: recordedValue(professional?.board_certification),
    },
    {
      label: "Years of Experience",
      value:
        personal?.years_of_experience === null ||
        personal?.years_of_experience === undefined
          ? "Not provided"
          : `${personal.years_of_experience} ${
              Number(personal.years_of_experience) === 1 ? "Year" : "Years"
            }`,
    },
    {
      label: "Hospital/Clinic",
      value: recordedValue(professional?.clinic_hospital_name),
    },
    { label: "Clinic Address", value: recordedValue(professional?.clinic_address) },
  ];
  const professionalColumns = [
    professionalInfo.slice(0, 3),
    professionalInfo.slice(3),
  ];

  useEffect(() => {
    if (!authenticatedDoctorId) {
      return undefined;
    }

    let active = true;

    const loadAppointmentSummary = async () => {
      const { data, error } = await supabase
        .from("schedule")
        .select("id, start_time, status")
        .eq("doctor_id", authenticatedDoctorId)
        .order("start_time", { ascending: true });

      if (!active) return;

      if (error) {
        if (import.meta.env.DEV) {
          console.warn(
            "Unable to load Doctor appointment summary:",
            error.message
          );
        }

        setAppointmentSummaryMessage(
          "Appointment summary could not be refreshed."
        );
        return;
      }

      setAppointmentSummaryMessage("");

      const rows = data || [];
      const nextSummary = rows.reduce(
        (summary, appointment) => {
          const status = normalizeAppointmentStatus(
            appointment?.status
          );
          const isInSelectedPeriod = isAppointmentInSummaryPeriod(
            appointment,
            appointmentSummaryPeriod
          );

          /*
           * "Today's" is intentionally always today's live count.
           * The selected period controls Cancelled / Pending / Completed.
           */
          if (classifyAppointment(appointment).isToday) {
            summary.today += 1;
          }

          if (!isInSelectedPeriod) {
            return summary;
          }

          if (status === "cancelled" || status === "canceled") {
            summary.cancelled += 1;
          }

          if (status === "pending" || status === "scheduled") {
            summary.pending += 1;
          }

          if (status === "completed") {
            summary.completed += 1;
          }

          return summary;
        },
        { ...emptyAppointmentSummary }
      );

      setAppointmentSummary(nextSummary);
    };

    const refresh = () => {
      void loadAppointmentSummary();
    };

    refresh();

    const scheduleChannel = supabase
      .channel(
        `doctor-profile-summary-${authenticatedDoctorId}-${appointmentSummaryPeriod}`
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "schedule",
          filter: `doctor_id=eq.${authenticatedDoctorId}`,
        },
        refresh
      )
      .subscribe();

    const handleWindowFocus = () => refresh();
    window.addEventListener("focus", handleWindowFocus);

    return () => {
      active = false;
      window.removeEventListener("focus", handleWindowFocus);
      supabase.removeChannel(scheduleChannel);
    };
  }, [authenticatedDoctorId, appointmentSummaryPeriod]);

  const initials = getDoctorInitials(profile.displayName);
  const avatarUrl = avatarOverride ?? doctorIdentity?.avatarUrl ?? "";

  return (
    <section className="doctor-profile-page">
      <header className="doctor-profile-page-header">
        <div className="doctor-page-title-block">
          <h2>Profile</h2>
          <p>View doctor account information and professional details.</p>
        </div>

        {headerAction ?? null}
      </header>

      {doctorIdentity?.loading ? (
        <p className="doctor-profile-load-state" role="status">
          Loading Doctor profile...
        </p>
      ) : null}

      {doctorIdentity?.error ? (
        <p className="doctor-profile-load-state is-error" role="alert">
          {doctorIdentity.error.message}
        </p>
      ) : null}

      {!doctorIdentity?.loading && !doctorIdentity?.error && !profile.id ? (
        <p className="doctor-profile-load-state" role="status">
          Doctor profile information is unavailable.
        </p>
      ) : null}

      {!doctorIdentity?.loading && !doctorIdentity?.error && profile.id ? (
        <>
      <section className="doctor-profile-hero-card">
        <div className="profile-picture-editor doctor-profile-picture-editor">
          <div className="doctor-profile-main-photo-wrap">
            <div className="doctor-profile-main-photo">
              <ProfileAvatarContent
                src={avatarUrl}
                alt={`${profile.displayName} profile`}
                fallback={initials}
              />
            </div>
          </div>

          <ProfilePictureActions
            avatarUrl={avatarUrl}
            disabled={doctorIdentity?.loading}
            onChange={(nextAvatarUrl) => setAvatarOverride(nextAvatarUrl)}
          />
        </div>

        <div className="doctor-profile-main-info">
          <div className="doctor-profile-name-line">
            <h3>{profile.displayName}</h3>

            <span className={`doctor-profile-status is-${accountStatus.tone}`}>
              <span />
              {accountStatus.label}
            </span>
          </div>

          <p>{profile.roleLabel}</p>
          <span>
            License No.: {recordedValue(professional?.license_number)}
          </span>
        </div>

        <div className="doctor-profile-contact-list">
          {contactDetails.map((item) => (
            <div className="doctor-profile-contact-item" key={item.label}>
              <div className="doctor-profile-contact-icon">
                <Icon icon={item.icon} />
              </div>

              <div>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="doctor-profile-tabs-card">
        <div className="doctor-profile-tabs" role="tablist" aria-label="Profile information">
          <button
            type="button"
            className={activeTab === "personal" ? "active" : ""}
            role="tab"
            aria-selected={activeTab === "personal"}
            onClick={() => setActiveTab("personal")}
          >
            Personal Information
          </button>

          <button
            type="button"
            className={activeTab === "professional" ? "active" : ""}
            role="tab"
            aria-selected={activeTab === "professional"}
            onClick={() => setActiveTab("professional")}
          >
            Professional Information
          </button>
        </div>

        <div className="doctor-profile-tab-content" key={activeTab} role="tabpanel">
          {activeTab === "personal" ? (
            <>
              <div className="doctor-profile-info-column">
                {personalInfo.map((item) => (
                  <ProfileInfoRow item={item} key={item.label} />
                ))}
              </div>

              <div className="doctor-profile-info-column">
                {personalContactInfo.map((item) => (
                  <ProfileInfoRow item={item} key={item.label} />
                ))}
              </div>
            </>
          ) : (
            professionalColumns.map((column, index) => (
              <div className="doctor-profile-detail-column" key={`professional-${index}`}>
                {column.map((item) => (
                  <ProfileDetailRow item={item} key={item.label} />
                ))}
              </div>
            ))
          )}
        </div>
      </section>

      <section
        className="doctor-profile-summary"
        aria-labelledby="doctor-appointment-summary-title"
      >
        <div className="doctor-profile-summary-header">
          <div>
            <Icon icon="solar:chart-square-bold" aria-hidden="true" />
            <h3 id="doctor-appointment-summary-title">
              Appointment Summary
            </h3>
          </div>

          <label className="doctor-profile-summary-period">
            <span className="doctor-profile-summary-period-label">
              Summary period
            </span>

            <select
              value={appointmentSummaryPeriod}
              onChange={(event) =>
                setAppointmentSummaryPeriod(event.target.value)
              }
              aria-label="Appointment summary period"
            >
              {appointmentSummaryPeriods.map((period) => (
                <option value={period.value} key={period.value}>
                  {period.label}
                </option>
              ))}
            </select>

            <Icon icon="solar:alt-arrow-down-linear" aria-hidden="true" />
          </label>
        </div>

        {appointmentSummaryMessage ? (
          <p className="doctor-profile-summary-message" role="status">
            {appointmentSummaryMessage}
          </p>
        ) : null}

        <div className="doctor-profile-summary-grid">
          {appointmentSummaryCards.map((card) => (
            <button
              className="doctor-profile-summary-card"
              type="button"
              key={card.key}
              onClick={() => navigate(card.path)}
              aria-label={`Open ${card.label} appointments`}
            >
              <div className="doctor-profile-summary-icon">
                <Icon icon={card.icon} aria-hidden="true" />
              </div>

              <div>
                <span>{card.label}</span>
                <strong>{appointmentSummary[card.key]}</strong>
              </div>
            </button>
          ))}
        </div>
      </section>
        </>
      ) : null}
    </section>
  );
}

export default DoctorViewProfileContent;
