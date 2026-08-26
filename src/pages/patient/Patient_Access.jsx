import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  buildPatientPendingLinkSearch,
  clearPatientPendingLink,
  resolvePatientPendingLink,
} from "../../lib/patientPendingLink";
import MaternalCareLogo from "../../components/common/MaternalCareLogo";
import "../../styles/patient-access.css";

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function PatientAccess() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const details = useMemo(
    () => resolvePatientPendingLink(searchParams),
    [searchParams]
  );
  const [controlVisible, setControlVisible] = useState(false);
  const [message, setMessage] = useState("");
  const query = buildPatientPendingLinkSearch(details);
  const hasDetails = Boolean(details.patientId && details.controlNumber);

  const handleCopy = async (label, value) => {
    if (!value) return;
    await copyText(value);
    setMessage(`${label} copied.`);
  };

  const clearDetails = () => {
    clearPatientPendingLink();
    navigate("/patient/access", { replace: true });
  };

  return (
    <main className="patient-access-container">
      <section className="patient-access-shell is-landing" aria-label="Patient access">
        <div className="patient-access-panel">
          <div className="patient-access-brand maternal-care-brand">
            <MaternalCareLogo variant="access" />
          </div>

          <div className="patient-access-heading">
            <span className="patient-access-eyebrow">Clinic invitation</span>
            <h2>Continue to Maternal Care</h2>
            <p>Review your clinic-issued details, then choose how you want to continue.</p>
          </div>

          {hasDetails ? (
            <div className="patient-access-details">
              <section>
                <span>Patient ID</span>
                <strong>{details.patientId}</strong>
                <button type="button" onClick={() => handleCopy("Patient ID", details.patientId)}>
                  <Icon icon="solar:copy-linear" aria-hidden="true" />
                  Copy Patient ID
                </button>
              </section>
              <section>
                <span>One-time control number</span>
                <strong>{controlVisible ? details.controlNumber : "••••-••••-••••"}</strong>
                <div>
                  <button type="button" onClick={() => setControlVisible((value) => !value)}>
                    <Icon icon={controlVisible ? "solar:eye-closed-linear" : "solar:eye-linear"} aria-hidden="true" />
                    {controlVisible ? "Hide" : "Show"}
                  </button>
                  <button type="button" onClick={() => handleCopy("Control number", details.controlNumber)}>
                    <Icon icon="solar:copy-linear" aria-hidden="true" />
                    Copy
                  </button>
                </div>
              </section>
            </div>
          ) : (
            <p className="patient-access-message" role="alert">
              Patient access details are missing. Scan the clinic QR code again or contact the clinic.
            </p>
          )}

          {hasDetails ? (
            <p className="patient-access-notice">
              <Icon icon="solar:shield-warning-linear" aria-hidden="true" />
              Keep this one-time control number private. It securely links your Patient record to your account.
            </p>
          ) : null}

          <div className="patient-access-actions">
            <button type="button" disabled={!hasDetails} onClick={() => navigate(`/patient/create-account${query}`)}>
              Create a New Account
            </button>
            <button type="button" className="is-secondary" disabled={!hasDetails} onClick={() => navigate(`/patient/login${query}`)}>
              I Already Have an Account
            </button>
            {hasDetails ? (
              <button type="button" className="is-link" onClick={clearDetails}>
                Clear Patient Access Details
              </button>
            ) : null}
          </div>
          {message ? <p className="patient-access-toast" role="status">{message}</p> : null}
        </div>

        <div className="patient-access-hero" aria-hidden="true">
          <img src="/images/login-hero.png" alt="" />
          <div className="patient-access-hero-copy">
            <span>Start securely</span>
            <strong>Your clinic invitation connects you to appointments, medical records, and care reminders.</strong>
          </div>
        </div>
      </section>
    </main>
  );
}

export default PatientAccess;
