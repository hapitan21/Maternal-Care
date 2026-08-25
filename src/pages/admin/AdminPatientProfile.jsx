import React from "react";
import { Icon } from "@iconify/react";
import { Link, useParams } from "react-router-dom";
import AdminAccountStatusDialog from "../../components/admin/AdminAccountStatusDialog";
import AdminPageHeader from "../../components/admin/AdminPageHeader";
import { useAdminUserManagement } from "../../hooks/useAdminUserManagement";
import { supabase } from "../../lib/supabaseClient";
import "../../styles/adminPatientProfile.css";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INACTIVE_STATUSES = new Set([
  "inactive",
  "deactivated",
  "suspended",
  "disabled",
  "blocked",
]);

const TEMPORARY_STATUSES = new Set([
  "pending",
  "pending_activation",
  "pending_registration",
  "for_activation",
  "awaiting_activation",
  "temporary",
  "not_linked",
]);

const patientColumns = [
  "id",
  "full_name",
  "patient_id",
  "control_number",
  "date_of_birth",
  "age",
  "email",
  "contact_number",
  "address",
  "blood_type",
  "expected_delivery_date",
  "gestational_age",
  "created_at",
  "updated_at",
  "activated_at",
].join(", ");

const personalColumns = [
  "id",
  "patient_record_id",
  "full_name",
  "gender",
  "birthdate",
  "age",
  "nationality",
  "email",
  "address",
  "blood_type",
  "civil_status",
  "contact_number",
  "updated_at",
].join(", ");

function cleanText(value) {
  return String(value ?? "").trim();
}

function present(value, fallback = "Not recorded") {
  const text = cleanText(value);
  return text || fallback;
}

function firstPresent(...values) {
  return values.find((value) => cleanText(value)) ?? "";
}

function normalizeStatus(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function formatDate(value, fallback = "Not recorded") {
  if (!value) return fallback;
  const text = cleanText(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T00:00:00+08:00`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function formatDateTime(value, fallback = "Never") {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function getAge(birthdate, savedAge) {
  const numericAge = Number(savedAge);
  if (!birthdate) return Number.isFinite(numericAge) && numericAge >= 0 ? numericAge : null;
  const text = cleanText(birthdate);
  const birth = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T00:00:00+08:00`)
    : new Date(birthdate);
  if (Number.isNaN(birth.getTime()) || birth > new Date()) {
    return Number.isFinite(numericAge) && numericAge >= 0 ? numericAge : null;
  }
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const monthDifference = today.getMonth() - birth.getMonth();
  if (monthDifference < 0 || (monthDifference === 0 && today.getDate() < birth.getDate())) age -= 1;
  return age >= 0 ? age : null;
}

function formatAge(value) {
  return Number.isFinite(value) ? `${value} years old` : "Not recorded";
}

function formatPregnancyWeek(value, dueDate) {
  const direct = cleanText(value);
  if (direct) return /week/i.test(direct) ? direct : `${direct} Weeks`;
  if (!dueDate) return "Not recorded";
  const delivery = new Date(dueDate);
  if (Number.isNaN(delivery.getTime())) return "Not recorded";
  const weeks = 40 - Math.floor((delivery.getTime() - Date.now()) / 604800000);
  return weeks >= 0 && weeks <= 42 ? `${weeks} Weeks` : "Not recorded";
}

function initials(name) {
  return cleanText(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "PT";
}

function getAccountState(value) {
  const status = normalizeStatus(value);
  if (status === "active") return "active";
  if (INACTIVE_STATUSES.has(status)) return "inactive";
  if (TEMPORARY_STATUSES.has(status)) return "temporary";
  return "temporary";
}

function getAccountCopy(accountState) {
  if (accountState === "active") {
    return {
      title: "This account is verified and active.",
      detail: "The patient can access the system.",
      footer: "The patient's account is currently active.",
      action: "deactivate",
      actionLabel: "Deactivate Account",
      icon: "solar:verified-check-bold",
    };
  }
  if (accountState === "inactive") {
    return {
      title: "This account is deactivated.",
      detail: "The patient cannot access the system.",
      footer: "The patient's account is currently deactivated.",
      action: "reactivate",
      actionLabel: "Reactivate Account",
      icon: "solar:info-circle-bold",
    };
  }
  return {
    title: "This account is pending activation.",
    detail: "Activate the account to give full access to the patient.",
    footer: "Activate the account after verifying the patient's information.",
    action: "activate",
    actionLabel: "Activate Account",
    icon: "solar:info-circle-bold",
  };
}

function getConfirmationCopy(action) {
  if (action === "deactivate") {
    return {
      title: "Deactivate Account",
      description: "This will disable the patient's access to the system.\nThey will not be able to log in.",
      question: "Are you sure you want to deactivate this account?",
      activateLabel: "Reactivate",
    };
  }
  if (action === "reactivate") {
    return {
      title: "Reactivate Account",
      description: "This will reactivate the patient's account and restore their access to the system.",
      question: "Are you sure you want to reactivate this account?",
      activateLabel: "Reactivate",
    };
  }
  return {
    title: "Activate Patient Account",
    description: "This will activate the patient's account and grant them full access to the system.",
    question: "Are you sure you want to activate this account?",
    activateLabel: "Activate",
  };
}

async function readOptionalRow(label, query) {
  try {
    const { data, error } = await query;
    if (error) {
      if (import.meta.env.DEV) console.warn(`Admin Patient Profile ${label} unavailable:`, error.message);
      return null;
    }
    return data || null;
  } catch (error) {
    if (import.meta.env.DEV) console.warn(`Admin Patient Profile ${label} unavailable:`, error?.message || error);
    return null;
  }
}

async function loadSupportingPatientData(patientId) {
  const [patient, personal, obstetric] = await Promise.all([
    readOptionalRow(
      "Patient record",
      supabase.from("patients").select(patientColumns).eq("id", patientId).maybeSingle()
    ),
    readOptionalRow(
      "personal information",
      supabase
        .from("patient_personal_information")
        .select(personalColumns)
        .eq("patient_record_id", patientId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    ),
    readOptionalRow(
      "pregnancy information",
      supabase
        .from("patient_obstetric_history")
        .select("gravida, para, last_menstrual_period, expected_delivery_date, updated_at")
        .eq("patient_id", patientId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    ),
  ]);

  const emergency = personal?.id
    ? await readOptionalRow(
        "emergency contact",
        supabase
          .from("patient_emergency_contact")
          .select("id, patient_id, contact_person, relationship, contact_number, created_at")
          .eq("patient_id", personal.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      )
    : null;

  return {
    patient,
    personal,
    obstetric,
    emergency,
  };
}

function StatusBadge({ state, children }) {
  return <span className={`admin-patient-status is-${state}`}>{children}</span>;
}

function Avatar({ name, url, size = "large" }) {
  return (
    <span className={`admin-patient-avatar is-${size}`} aria-hidden="true">
      {url ? <img src={url} alt="" /> : initials(name)}
    </span>
  );
}

function ContactItem({ icon, value }) {
  return (
    <div className="admin-patient-contact-item">
      <span><Icon icon={icon} aria-hidden="true" /></span>
      <p>{present(value)}</p>
    </div>
  );
}

function DetailColumn({ fields }) {
  return (
    <dl className="admin-patient-detail-column">
      {fields.map(({ label, value, node }) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{node || present(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function PatientSection({ icon, title, children, className = "" }) {
  return (
    <section className={`admin-patient-section ${className}`.trim()}>
      <header>
        <span><Icon icon={icon} aria-hidden="true" /></span>
        <h2>{title}</h2>
      </header>
      {children}
    </section>
  );
}

function PageState({ type, message, onRetry }) {
  const isLoading = type === "loading";
  return (
    <section className={`admin-patient-page-state is-${type}`} role={isLoading ? "status" : "alert"}>
      <Icon icon={isLoading ? "solar:refresh-circle-linear" : type === "not-found" ? "solar:user-cross-linear" : "solar:danger-triangle-linear"} aria-hidden="true" />
      <h2>{isLoading ? "Loading Patient Profile" : type === "not-found" ? "Patient account not found" : "Unable to load Patient Profile"}</h2>
      <p>{message}</p>
      <div>
        {onRetry ? <button type="button" onClick={onRetry}>Try Again</button> : null}
        <Link to="/admin/user-management">Back to User Management</Link>
      </div>
    </section>
  );
}

export default function AdminPatientProfile() {
  const { id } = useParams();
  const { loadDetails, updateAccountStatus, saving } = useAdminUserManagement({
    enabled: false,
    activeTab: "patients",
  });
  const [profile, setProfile] = React.useState(null);
  const [pageState, setPageState] = React.useState("loading");
  const [error, setError] = React.useState("");
  const [success, setSuccess] = React.useState("");
  const [confirmState, setConfirmState] = React.useState(null);
  const [modalError, setModalError] = React.useState("");
  const requestRef = React.useRef(0);

  const loadProfile = React.useCallback(async ({ showLoading = true } = {}) => {
    const requestId = ++requestRef.current;
    if (showLoading) {
      setProfile(null);
      setPageState("loading");
    }
    setError("");

    if (!UUID_PATTERN.test(id || "")) {
      if (requestId === requestRef.current) {
        setError("The requested Patient account does not exist.");
        setPageState("not-found");
      }
      return;
    }

    const baseResult = await loadDetails("patient", id);
    if (requestId !== requestRef.current) return;
    if (!baseResult.ok) {
      const message = baseResult.error || "The Patient account could not be loaded.";
      setError(message);
      setPageState(message.toLowerCase().includes("not found") ? "not-found" : "error");
      return;
    }
    if (
      !baseResult.detail?.id
      || baseResult.detail.type !== "patient"
      || cleanText(baseResult.detail.id).toLowerCase() !== cleanText(id).toLowerCase()
    ) {
      setError("The requested Patient account does not exist.");
      setPageState("not-found");
      return;
    }

    const supporting = await loadSupportingPatientData(id);
    if (requestId !== requestRef.current) return;
    setProfile({ detail: baseResult.detail, ...supporting });
    setPageState("ready");
  }, [id, loadDetails]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => loadProfile(), 0);
    return () => {
      requestRef.current += 1;
      window.clearTimeout(timer);
    };
  }, [loadProfile]);

  const detail = profile?.detail || null;
  const patient = profile?.patient || null;
  const personal = profile?.personal || null;
  const obstetric = profile?.obstetric || null;
  const emergency = profile?.emergency || null;
  const accountState = getAccountState(detail?.account_status);
  const accountCopy = getAccountCopy(accountState);
  const fullName = present(firstPresent(personal?.full_name, detail?.full_name, patient?.full_name));
  const patientId = present(firstPresent(detail?.display_id, patient?.patient_id, patient?.control_number));
  const birthdate = firstPresent(personal?.birthdate, patient?.date_of_birth);
  const age = getAge(birthdate, firstPresent(personal?.age, patient?.age));
  const gender = present(personal?.gender);
  const civilStatus = present(personal?.civil_status);
  const nationality = present(personal?.nationality);
  const email = present(firstPresent(detail?.email, personal?.email, patient?.email));
  const contactNumber = present(firstPresent(personal?.contact_number, detail?.contact_number, patient?.contact_number));
  const address = present(firstPresent(personal?.address, patient?.address));
  const bloodType = present(firstPresent(personal?.blood_type, patient?.blood_type));
  const dueDate = firstPresent(obstetric?.expected_delivery_date, patient?.expected_delivery_date);
  const pregnancyWeek = formatPregnancyWeek(patient?.gestational_age, dueDate);
  const avatarUrl = firstPresent(detail?.avatar_url, patient?.avatar_url, personal?.avatar_url);
  const statusActionAvailable = detail?.link_status === "linked";
  const registrationStatus = present(detail?.record_status);

  const openStatusAction = () => {
    if (!detail || !statusActionAvailable) return;

    const currentAccountState = getAccountState(detail.account_status);
    const currentAccountCopy = getAccountCopy(currentAccountState);

    setModalError("");
    setConfirmState({
      action: currentAccountCopy.action,
      type: "patient",
      account: {
        id: detail.id,
        name: fullName,
        accountStatus: normalizeStatus(detail.account_status),
        linkStatus: detail.link_status,
        avatarUrl,
      },
    });
  };

  const closeConfirm = React.useCallback(() => {
    if (saving) return;
    setConfirmState(null);
    setModalError("");
  }, [saving]);

  const confirmStatusAction = async () => {
    if (!confirmState || saving) return;
    setModalError("");
    const result = await updateAccountStatus("patient", confirmState.account, confirmState.action);
    if (!result.ok) {
      setModalError(result.error || "Unable to change Patient account access.");
      return;
    }

    const nextStatus = confirmState.action === "deactivate" ? "inactive" : "active";
    const actionLabel = confirmState.action === "deactivate" ? "deactivated" : "activated";
    setProfile((current) => current ? {
      ...current,
      detail: { ...current.detail, account_status: nextStatus },
    } : current);
    setSuccess(`${confirmState.account.name} was ${actionLabel}.`);
    setConfirmState(null);
    await loadProfile({ showLoading: false });
  };

  const confirmationCopy = getConfirmationCopy(confirmState?.action);
  const personalLeft = [
    { label: "Full Name", value: fullName },
    { label: "Birthdate", value: formatDate(birthdate) },
    { label: "Age", value: formatAge(age) },
    { label: "Gender", value: gender },
    { label: "Nationality", value: nationality },
  ];
  const personalRight = [
    { label: "Civil Status", value: civilStatus },
    { label: "Address", value: address },
    { label: "Contact Number", value: contactNumber },
    { label: "Email Address", value: email },
    { label: "Blood Type", value: bloodType },
  ];
  const pregnancyLeft = [
    { label: "Gravida (G)", value: obstetric?.gravida },
    { label: "Para (P)", value: obstetric?.para },
    { label: "Last Menstrual Period", value: formatDate(obstetric?.last_menstrual_period) },
  ];
  const pregnancyRight = [
    { label: "Estimated Due Date", value: formatDate(dueDate) },
    { label: "Gestational Age", value: pregnancyWeek },
  ];
  const accountLeft = [
    { label: "Account Status", node: <StatusBadge state={accountState}>{accountState}</StatusBadge> },
    { label: "Registration Status", node: <StatusBadge state="registration">{registrationStatus}</StatusBadge> },
  ];
  const accountRight = [
    { label: "Date Created", value: formatDate(firstPresent(detail?.created_at, patient?.created_at)) },
    { label: "Date Activated", value: formatDate(firstPresent(patient?.activated_at, detail?.activated_at), "Not yet activated") },
    { label: "Last Updated", value: formatDate(firstPresent(patient?.updated_at, personal?.updated_at)) },
    { label: "Last Login", value: formatDateTime(firstPresent(detail?.last_login_at, detail?.last_sign_in_at), "Never") },
  ];

  return (
    <div className="admin-patient-page">
      <nav className="admin-patient-breadcrumbs" aria-label="Breadcrumb">
        <Link to="/admin/user-management"><Icon icon="solar:arrow-left-linear" aria-hidden="true" />User Management</Link>
        <Icon icon="solar:alt-arrow-right-linear" aria-hidden="true" />
        <span>Patient Accounts</span>
        <Icon icon="solar:alt-arrow-right-linear" aria-hidden="true" />
        <strong aria-current="page">{detail ? fullName : "Patient Account"}</strong>
      </nav>

      <AdminPageHeader className="admin-patient-heading" title="Patient Profile" subtitle="View Patient Profile" />

      {pageState === "loading" ? <PageState type="loading" message="Retrieving the selected Patient account…" /> : null}
      {pageState === "error" ? <PageState type="error" message={error} onRetry={() => loadProfile()} /> : null}
      {pageState === "not-found" ? <PageState type="not-found" message={error} /> : null}

      {pageState === "ready" && detail ? (
        <>
          {success ? (
            <div className="admin-patient-success" role="status">
              <Icon icon="solar:check-circle-bold" aria-hidden="true" />
              <span>{success}</span>
              <button type="button" onClick={() => setSuccess("")}>Dismiss</button>
            </div>
          ) : null}

          <section className="admin-patient-hero">
            <Avatar name={fullName} url={avatarUrl} />
            <div className="admin-patient-hero-main">
              <div className="admin-patient-name-row">
                <h2>{fullName}</h2>
                <StatusBadge state={accountState}>{accountState}</StatusBadge>
              </div>
              <p className="admin-patient-id">Patient ID: <strong>{patientId}</strong></p>
              <div className={`admin-patient-access is-${accountState}`}>
                <Icon icon={accountCopy.icon} aria-hidden="true" />
                <div><strong>{accountCopy.title}</strong><p>{accountCopy.detail}</p></div>
                {statusActionAvailable ? (
                  <button
                    type="button"
                    className={accountCopy.action === "deactivate" ? "is-danger" : "is-success"}
                    onClick={openStatusAction}
                  >
                    {accountCopy.actionLabel}
                  </button>
                ) : null}
              </div>
              {!statusActionAvailable ? (
                <p className="admin-patient-action-unavailable">This Patient needs a linked login account before access can be activated.</p>
              ) : null}
            </div>
            <aside className="admin-patient-contacts" aria-label="Patient contact information">
              <ContactItem icon="solar:letter-linear" value={email} />
              <ContactItem icon="solar:phone-calling-linear" value={contactNumber} />
            </aside>
          </section>

          <div className="admin-patient-sections">
            <PatientSection icon="solar:user-linear" title="Personal Information">
              <div className="admin-patient-two-column">
                <DetailColumn fields={personalLeft} />
                <DetailColumn fields={personalRight} />
              </div>
            </PatientSection>

            <PatientSection icon="solar:heart-linear" title="Pregnancy Information">
              <div className="admin-patient-two-column">
                <DetailColumn fields={pregnancyLeft} />
                <DetailColumn fields={pregnancyRight} />
              </div>
            </PatientSection>

            <PatientSection icon="solar:user-heart-linear" title="Emergency Contact">
              {emergency ? (
                <dl className="admin-patient-emergency-grid">
                  <div><dt>Contact Person</dt><dd>{present(emergency.contact_person)}</dd></div>
                  <div><dt>Relationship</dt><dd>{present(emergency.relationship)}</dd></div>
                  <div><dt>Contact Number</dt><dd>{present(emergency.contact_number)}</dd></div>
                </dl>
              ) : (
                <p className="admin-patient-empty">No emergency contact recorded.</p>
              )}
            </PatientSection>

            <PatientSection icon="solar:clock-circle-linear" title="Account Information" className="admin-patient-account-section">
              <div className="admin-patient-two-column admin-patient-account-grid">
                <DetailColumn fields={accountLeft} />
                <DetailColumn fields={accountRight} />
              </div>
              <footer className={`admin-patient-account-footer is-${accountState}`}>{accountCopy.footer}</footer>
            </PatientSection>

            <aside className="admin-patient-medical-notice">
              <Icon icon="solar:medical-kit-linear" aria-hidden="true" />
              <p><strong>NOTE:</strong> Medical records and clinical information are available only to authorized medical personnel.</p>
            </aside>
          </div>
        </>
      ) : null}

      {confirmState ? (
        <AdminAccountStatusDialog
          state={confirmState}
          saving={saving}
          error={modalError}
          onCancel={closeConfirm}
          onConfirm={confirmStatusAction}
          activateLabel={confirmationCopy.activateLabel}
          title={confirmationCopy.title}
          description={confirmationCopy.description}
          question={confirmationCopy.question}
          statusLabel={accountState}
          showClose
        />
      ) : null}
    </div>
  );
}
