import { useState } from "react";
import { Icon } from "@iconify/react";
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
  const [activeTab, setActiveTab] = useState("personal");
  const personal = doctorIdentity?.personalInformation;
  const professional = doctorIdentity?.professionalInformation;
  const identityProfile = doctorIdentity?.profile;
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
      label: "Practice Location",
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
      icon: "solar:woman-linear",
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

  const initials = getDoctorInitials(profile.displayName);

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
        <div className="doctor-profile-main-photo-wrap">
          <div className="doctor-profile-main-photo">
            {initials}
          </div>
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
        </>
      ) : null}
    </section>
  );
}

export default DoctorViewProfileContent;
