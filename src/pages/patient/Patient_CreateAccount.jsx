import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ensurePatientProfile,
  getPatientLinkingErrorMessage,
  getPatientRpcRow,
  normalizePatientAccessValue,
} from "../../lib/patientAuthLinking";
import {
  buildPatientPendingLinkSearch,
  clearPatientPendingLink,
  resolvePatientPendingLink,
} from "../../lib/patientPendingLink";
import { validatePatientActivation } from "../../lib/patientActivation";
import { supabase } from "../../lib/supabaseClient";
import MaternalCareLogo from "../../components/common/MaternalCareLogo";
import {
  PASSWORD_MIN_LENGTH,
  passwordsMatch,
} from "../../lib/passwordSecurity";
import "../../styles/patient-access.css";

const CREATE_ACCOUNT_PASSWORD_REQUIREMENTS = [
  { key: "minLength", label: "At least 12 characters" },
  { key: "uppercase", label: "At least 1 uppercase letter (A–Z)" },
  { key: "number", label: "At least 1 number (0–9)" },
  { key: "special", label: "At least 1 special character" },
];

function getCreateAccountPasswordRequirements(value) {
  const password = String(value || "");

  return {
    minLength: password.length >= PASSWORD_MIN_LENGTH,
    uppercase: /[A-Z]/.test(password),
    number: /\d/.test(password),
    special: /[^A-Za-z0-9\s]/.test(password),
  };
}

function CreateAccountPasswordGuide({ password }) {
  const requirements = getCreateAccountPasswordRequirements(password);
  const completedCount = CREATE_ACCOUNT_PASSWORD_REQUIREMENTS.filter(
    ({ key }) => requirements[key]
  ).length;
  const strengthLabels = ["Weak", "Weak", "Fair", "Good", "Strong"];
  const strength = strengthLabels[completedCount];
  const strengthToken = strength.toLowerCase();

  return (
    <section
      className="patient-create-password-guide"
      aria-labelledby="patient-create-password-guide-title"
    >
      <h3 id="patient-create-password-guide-title">
        Create a strong password
      </h3>

      <div className="patient-create-password-strength-row">
        <div
          className="patient-create-password-strength-meter"
          role="progressbar"
          aria-label="Password strength"
          aria-valuemin="0"
          aria-valuemax="4"
          aria-valuenow={completedCount}
          aria-valuetext={strength}
        >
          {[1, 2, 3, 4].map((level) => (
            <span
              className={
                level <= completedCount ? `is-active is-${strengthToken}` : ""
              }
              key={level}
            />
          ))}
        </div>
        <strong className={`is-${strengthToken}`}>{strength}</strong>
      </div>

      <p>
        Use 12 or more characters with a mix of letters, numbers, and symbols.
      </p>

      <ul aria-label="Password requirements">
        {CREATE_ACCOUNT_PASSWORD_REQUIREMENTS.map(({ key, label }) => {
          const complete = requirements[key];

          return (
            <li className={complete ? "is-complete" : ""} key={key}>
              <Icon
                icon={
                  complete
                    ? "solar:check-circle-bold"
                    : "solar:circle-linear"
                }
                aria-hidden="true"
              />
              <span>{label}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const LEGAL_MODAL_CONTENT = {
  terms: {
    title: "Terms of Service",
    eyebrow: "Patient account agreement",
    placeholder:
      "The complete Terms of Service will be added here before final deployment.",
  },
  privacy: {
    title: "Privacy Policy",
    eyebrow: "Patient privacy information",
    placeholder:
      "The complete Privacy Policy will be added here before final deployment.",
  },
};

function PatientCreateAccount() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const details = useMemo(
    () => resolvePatientPendingLink(searchParams),
    [searchParams]
  );
  const query = buildPatientPendingLinkSearch(details);

  const [form, setForm] = useState({
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [message, setMessage] = useState("");
  const [registeredEmail, setRegisteredEmail] = useState("");
  const [created, setCreated] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState({
    password: false,
    confirm: false,
  });
  const [confirmInteracted, setConfirmInteracted] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [legalModal, setLegalModal] = useState(null);
  const [activation, setActivation] = useState({
    status: "checking",
    message: "Validating Patient access details...",
  });

  useEffect(() => {
    let active = true;

    const validateAccessDetails = async () => {
      const result = await validatePatientActivation(details);
      if (!active) return;

      if (result.valid && result.patientId === details.patientId) {
        const verifiedEmail = normalizePatientAccessValue(result.email).toLowerCase();
        setRegisteredEmail(verifiedEmail);
        setForm((current) => ({ ...current, email: verifiedEmail }));
        setActivation({ status: "valid", message: result.message });
        return;
      }

      setRegisteredEmail("");
      setForm((current) => ({ ...current, email: "" }));
      clearPatientPendingLink();
      setActivation({
        status: result.state || "unknown",
        message: result.message,
      });
    };

    validateAccessDetails();

    return () => {
      active = false;
    };
  }, [details]);

  useEffect(() => {
    if (!legalModal) return undefined;

    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setLegalModal(null);
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [legalModal]);

  const updateForm = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const openLegalModal = (type) => {
    setLegalModal(type);
  };

  const closeLegalModal = () => {
    setLegalModal(null);
  };

  const createAccountPasswordRequirements =
    getCreateAccountPasswordRequirements(form.password);
  const createAccountPasswordValid = Object.values(
    createAccountPasswordRequirements
  ).every(Boolean);
  const passwordMatch = passwordsMatch(form.password, form.confirmPassword);
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    normalizePatientAccessValue(form.email)
  );
  const patientAccessValid = Boolean(
    details.patientId &&
      details.controlNumber &&
      activation.status === "valid"
  );
  const canSubmit =
    patientAccessValid &&
    emailValid &&
    createAccountPasswordValid &&
    passwordMatch &&
    termsAccepted &&
    !isSubmitting &&
    !created;

  const submit = async (event) => {
    event.preventDefault();
    if (isSubmitting || created) return;

    setMessage("");

    if (!details.patientId || !details.controlNumber) {
      setMessage(
        "Patient access details are missing. Return to Patient Access and scan the clinic QR code again."
      );
      return;
    }

    if (!emailValid) {
      setMessage("Enter a valid email address.");
      return;
    }

    if (!createAccountPasswordValid) {
      setMessage("Choose a password that meets all four requirements.");
      return;
    }

    if (!passwordMatch) {
      setMessage("Passwords do not match.");
      return;
    }

    if (!termsAccepted) {
      setMessage(
        "Please review and agree to the Terms of Service and Privacy Policy before creating your account."
      );
      return;
    }

    setIsSubmitting(true);
    const email = normalizePatientAccessValue(form.email).toLowerCase();

    try {
      const activationCheck = await validatePatientActivation(details);
      if (
        !activationCheck.valid ||
        activationCheck.patientId !== details.patientId
      ) {
        clearPatientPendingLink();
        setActivation({
          status: activationCheck.state || "unknown",
          message: activationCheck.message,
        });
        setMessage(activationCheck.message);
        return;
      }

      const verifiedEmail = normalizePatientAccessValue(
        activationCheck.email
      ).toLowerCase();

      if (verifiedEmail && email !== verifiedEmail) {
        setRegisteredEmail(verifiedEmail);
        setForm((current) => ({ ...current, email: verifiedEmail }));
        setMessage(
          "The clinic-registered Patient email was refreshed. Review it, then create the account again."
        );
        return;
      }

      const { data, error } = await supabase.auth.signUp({
        email,
        password: form.password,
        options: { data: { role: "patient", full_name: "Patient" } },
      });

      if (error) throw error;

      if (!data?.user) {
        throw new Error("Unable to create the Patient authentication account.");
      }

      const { data: sessionData } = await supabase.auth.getSession();
      if (!data.session && !sessionData?.session) {
        const loginParams = new URLSearchParams({
          patientId: details.patientId,
          control: details.controlNumber,
          confirmationRequired: "true",
          email,
        });

        navigate(`/patient/login?${loginParams.toString()}`, {
          replace: true,
        });
        return;
      }

      await ensurePatientProfile(data.user, details.patientId);

      const { data: linkData, error: linkError } = await supabase.rpc(
        "link_patient_auth_account",
        {
          p_patient_id: details.patientId,
          p_control_number: details.controlNumber,
        }
      );

      if (linkError) throw linkError;

      const linkedPatient = getPatientRpcRow(linkData);
      if (!linkedPatient?.linked) {
        throw new Error("The Patient record could not be linked.");
      }

      await ensurePatientProfile(data.user, linkedPatient.patient_id);
      clearPatientPendingLink();
      await supabase.auth.signOut();

      setCreated(true);
      setMessage(
        "Patient account created and linked successfully. You can now log in."
      );

      const loginParams = new URLSearchParams({
        accountCreated: "true",
        email,
      });

      navigate(`/patient/login?${loginParams.toString()}`, { replace: true });
    } catch (error) {
      await supabase.auth.signOut().catch(() => null);
      setMessage(
        getPatientLinkingErrorMessage(error) ||
          "Unable to create the Patient account."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const activeLegalContent = legalModal
    ? LEGAL_MODAL_CONTENT[legalModal]
    : null;

  return (
    <main className="patient-access-container">
      <section
        className="patient-access-shell"
        aria-label="Create Patient account"
      >
        <div className="patient-access-panel">
          <div className="patient-access-brand is-compact maternal-care-brand">
            <MaternalCareLogo variant="access" />
          </div>

          <div className="patient-access-heading">
            <span className="patient-access-eyebrow">Secure registration</span>
            <h2>Create your patient account</h2>
            <p>
              Your account will be linked to the patient record issued by the
              clinic.
            </p>
          </div>

          <form className="patient-access-form" onSubmit={submit}>
            <div className="patient-access-field">
              <label htmlFor="patient-create-id">Patient ID</label>
              <div className="patient-access-input-wrap is-readonly">
                <Icon icon="solar:user-id-linear" aria-hidden="true" />
                <input
                  id="patient-create-id"
                  value={details.patientId}
                  readOnly
                />
              </div>
              <p
                className={`patient-activation-validation is-${activation.status}`}
                role={activation.status === "valid" || activation.status === "checking" ? "status" : "alert"}
                aria-live="polite"
              >
                <Icon
                  icon={
                    activation.status === "valid"
                      ? "solar:shield-check-bold-duotone"
                      : activation.status === "checking"
                        ? "solar:refresh-circle-linear"
                        : "solar:danger-circle-bold-duotone"
                  }
                  aria-hidden="true"
                />
                {activation.message}
              </p>
            </div>

            <div className="patient-access-field">
              <label htmlFor="patient-create-email">Email address</label>
              <div
                className={`patient-access-input-wrap ${
                  registeredEmail ? "is-readonly" : ""
                }`}
              >
                <Icon icon="solar:letter-linear" aria-hidden="true" />
                <input
                  id="patient-create-email"
                  type="email"
                  value={form.email}
                  onChange={(event) => updateForm("email", event.target.value)}
                  readOnly={Boolean(registeredEmail)}
                  autoComplete="email"
                  placeholder="you@example.com"
                  required
                />
              </div>
            </div>

            <div className="patient-access-field">
              <label htmlFor="patient-create-password">Password</label>
              <div className="patient-access-input-wrap">
                <Icon icon="solar:lock-password-linear" aria-hidden="true" />
                <input
                  id="patient-create-password"
                  type={passwordVisible.password ? "text" : "password"}
                  value={form.password}
                  onChange={(event) =>
                    updateForm("password", event.target.value)
                  }
                  minLength={PASSWORD_MIN_LENGTH}
                  autoComplete="new-password"
                  placeholder="Create a secure password"
                  required
                />
                <button
                  type="button"
                  className="patient-access-password-toggle"
                  onClick={() =>
                    setPasswordVisible((current) => ({
                      ...current,
                      password: !current.password,
                    }))
                  }
                  aria-label={
                    passwordVisible.password ? "Hide password" : "Show password"
                  }
                  aria-pressed={passwordVisible.password}
                >
                  <Icon
                    icon={
                      passwordVisible.password
                        ? "solar:eye-closed-linear"
                        : "solar:eye-linear"
                    }
                  />
                </button>
              </div>
            </div>

            <CreateAccountPasswordGuide password={form.password} />

            <div className="patient-access-field">
              <label htmlFor="patient-create-confirm">Confirm password</label>
              <div className="patient-access-input-wrap">
                <Icon icon="solar:shield-check-linear" aria-hidden="true" />
                <input
                  id="patient-create-confirm"
                  type={passwordVisible.confirm ? "text" : "password"}
                  value={form.confirmPassword}
                  onChange={(event) => {
                    setConfirmInteracted(true);
                    updateForm("confirmPassword", event.target.value);
                  }}
                  onBlur={() => setConfirmInteracted(true)}
                  minLength={PASSWORD_MIN_LENGTH}
                  autoComplete="new-password"
                  placeholder="Re-enter your password"
                  required
                />
                <button
                  type="button"
                  className="patient-access-password-toggle"
                  onClick={() =>
                    setPasswordVisible((current) => ({
                      ...current,
                      confirm: !current.confirm,
                    }))
                  }
                  aria-label={
                    passwordVisible.confirm
                      ? "Hide confirmation password"
                      : "Show confirmation password"
                  }
                  aria-pressed={passwordVisible.confirm}
                >
                  <Icon
                    icon={
                      passwordVisible.confirm
                        ? "solar:eye-closed-linear"
                        : "solar:eye-linear"
                    }
                  />
                </button>
              </div>
              {confirmInteracted && form.confirmPassword ? (
                <p
                  className={`patient-create-password-match ${
                    passwordMatch ? "is-match" : "is-mismatch"
                  }`}
                  role={passwordMatch ? "status" : "alert"}
                  aria-live="polite"
                >
                  <Icon
                    icon={
                      passwordMatch
                        ? "solar:check-circle-bold"
                        : "solar:danger-circle-bold"
                    }
                    aria-hidden="true"
                  />
                  {passwordMatch
                    ? "Passwords match"
                    : "Passwords do not match"}
                </p>
              ) : null}
            </div>

            <div className="patient-legal-section">
              <p className="patient-legal-copy">
                By creating an account, you agree to the{" "}
                <button
                  type="button"
                  className="patient-legal-link"
                  onClick={() => openLegalModal("terms")}
                >
                  Terms of Service
                </button>{" "}
                and{" "}
                <button
                  type="button"
                  className="patient-legal-link"
                  onClick={() => openLegalModal("privacy")}
                >
                  Privacy Policy
                </button>
                .
              </p>

              <label className="patient-legal-consent">
                <input
                  type="checkbox"
                  checked={termsAccepted}
                  onChange={(event) => setTermsAccepted(event.target.checked)}
                  required
                />
                <span className="patient-legal-checkbox" aria-hidden="true">
                  <Icon icon="solar:check-read-linear" />
                </span>
                <span>
                  I have read and agree to the{" "}
                  <button
                    type="button"
                    className="patient-legal-link"
                    onClick={(event) => {
                      event.preventDefault();
                      openLegalModal("terms");
                    }}
                  >
                    Terms of Service
                  </button>{" "}
                  and{" "}
                  <button
                    type="button"
                    className="patient-legal-link"
                    onClick={(event) => {
                      event.preventDefault();
                      openLegalModal("privacy");
                    }}
                  >
                    Privacy Policy
                  </button>
                  .
                </span>
              </label>
            </div>

            <p className="patient-access-form-note">
              <Icon icon="solar:shield-check-bold-duotone" aria-hidden="true" />
              Your verified one-time QR code securely links this account to your
              existing Patient record.
            </p>

            <button
              type="submit"
              disabled={!canSubmit}
              aria-disabled={!canSubmit}
              title={
                !termsAccepted
                  ? "Agree to the Terms of Service and Privacy Policy to continue."
                  : !patientAccessValid
                    ? "Valid Patient access details are required."
                  : !emailValid
                    ? "Enter a valid email address."
                  : !createAccountPasswordValid || !passwordMatch
                    ? "Choose a password that meets every requirement and confirm it."
                  : undefined
              }
            >
              {isSubmitting ? "Creating account..." : "Create Account"}
            </button>

            <button
              type="button"
              className="patient-access-link-button"
              onClick={() => navigate(`/patient/access${query}`)}
            >
              Back to Patient Access
            </button>
          </form>

          {message ? (
            <p
              className="patient-access-message"
              role={created ? "status" : "alert"}
            >
              {message}
            </p>
          ) : null}

          {created ? (
            <div className="patient-access-result">
              <button
                type="button"
                onClick={() => navigate(`/patient/login${query}`)}
              >
                Go to Patient Login
              </button>
            </div>
          ) : null}
        </div>

        <div className="patient-access-hero" aria-hidden="true">
          <img src="/images/login-hero.png" alt="" />
          <div className="patient-access-hero-copy">
            <span>Private and connected</span>
            <strong>
              Your clinic-issued patient ID keeps your health information
              linked to the right account.
            </strong>
          </div>
        </div>
      </section>

      {activeLegalContent ? (
        <div
          className="patient-legal-modal"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeLegalModal();
            }
          }}
        >
          <section
            className="patient-legal-modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`patient-${legalModal}-title`}
          >
            <header className="patient-legal-modal-header">
              <div>
                <span>{activeLegalContent.eyebrow}</span>
                <h3 id={`patient-${legalModal}-title`}>
                  {activeLegalContent.title}
                </h3>
              </div>

              <button
                type="button"
                className="patient-legal-modal-close"
                onClick={closeLegalModal}
                aria-label={`Close ${activeLegalContent.title}`}
              >
                <Icon icon="solar:close-circle-linear" />
              </button>
            </header>

            <div className="patient-legal-modal-body">
              <p className="patient-legal-last-updated">
                Last updated: To be provided
              </p>

              <div className="patient-legal-placeholder">
                <Icon icon="solar:document-text-linear" aria-hidden="true" />
                <div>
                  <strong>Content placeholder</strong>
                  <p>{activeLegalContent.placeholder}</p>
                </div>
              </div>
            </div>

            <footer className="patient-legal-modal-footer">
              <button type="button" onClick={closeLegalModal}>
                Close
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </main>
  );
}

export default PatientCreateAccount;
