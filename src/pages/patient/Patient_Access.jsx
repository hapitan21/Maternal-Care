import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  buildPatientPendingLinkSearch,
  clearPatientPendingLink,
  resolvePatientPendingLink,
} from "../../lib/patientPendingLink";
import { validatePatientActivation } from "../../lib/patientActivation";
import MaternalCareLogo from "../../components/common/MaternalCareLogo";
import "../../styles/patient-access.css";

function PatientAccess() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const details = useMemo(
    () => resolvePatientPendingLink(searchParams),
    [searchParams]
  );
  const [validationAttempt, setValidationAttempt] = useState(0);
  const [activation, setActivation] = useState({
    status: "checking",
    message: "Validating your patient access link...",
  });
  const query = buildPatientPendingLinkSearch(details);
  const hasDetails = Boolean(details.patientId && details.controlNumber);

  useEffect(() => {
    let active = true;

    const validateScannedDetails = async () => {
      if (!hasDetails) {
        clearPatientPendingLink();
        setActivation({
          status: "missing",
          message: "Invalid patient access link.",
        });
        return;
      }

      setActivation({
        status: "checking",
        message: "Validating your patient access link...",
      });

      const result = await validatePatientActivation(details);
      if (!active) return;

      if (result.valid && result.patientId === details.patientId) {
        navigate(`/patient/create-account${query}`, { replace: true });
        return;
      }

      clearPatientPendingLink();
      setActivation({
        status: result.state || "unknown",
        message: result.message,
      });
    };

    validateScannedDetails();

    return () => {
      active = false;
    };
  }, [details, hasDetails, navigate, query, validationAttempt]);

  const showPatientLogin = activation.status === "used";
  const canRetry = ["pending_registration", "unavailable"].includes(
    activation.status
  );

  return (
    <main className="patient-access-container">
      <section className="patient-access-shell is-landing" aria-label="Patient account activation">
        <div className="patient-access-panel">
          <div className="patient-access-brand maternal-care-brand">
            <MaternalCareLogo variant="access" />
          </div>

          <div className="patient-access-heading">
            <span className="patient-access-eyebrow">Patient account activation</span>
            <h2>
              {activation.status === "checking"
                ? "Verifying your access"
                : showPatientLogin
                  ? "Account already activated"
                  : "Unable to continue"}
            </h2>
            <p>
              {activation.status === "checking"
                ? "Please wait while Maternal Care securely verifies your Patient ID and one-time access code."
                : showPatientLogin
                  ? "Sign in with the Patient account that is already linked to this record."
                  : canRetry
                    ? "Try the secure validation again below."
                    : "Scan the Patient access QR code issued by the clinic again."}
            </p>
          </div>

          <p
            className={`patient-access-message is-${activation.status}`}
            role={activation.status === "checking" ? "status" : "alert"}
            aria-live="polite"
          >
            {activation.status === "checking" ? (
              <Icon icon="solar:refresh-circle-linear" aria-hidden="true" />
            ) : null}
            {activation.message}
          </p>

          <div className="patient-access-actions">
            {showPatientLogin ? (
              <button type="button" onClick={() => navigate("/patient/login")}>
                Patient Login
              </button>
            ) : null}
            {canRetry ? (
              <button
                type="button"
                onClick={() => setValidationAttempt((attempt) => attempt + 1)}
              >
                Try Again
              </button>
            ) : null}
          </div>
        </div>

        <div className="patient-access-hero" aria-hidden="true">
          <img src="/images/login-hero.png" alt="" />
          <div className="patient-access-hero-copy">
            <span>Secure Patient access</span>
            <strong>Your one-time QR code links your new account to the correct existing Patient record.</strong>
          </div>
        </div>
      </section>
    </main>
  );
}

export default PatientAccess;
