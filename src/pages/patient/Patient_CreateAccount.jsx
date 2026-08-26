import { useMemo, useState } from "react";
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
import { supabase } from "../../lib/supabaseClient";
import MaternalCareLogo from "../../components/common/MaternalCareLogo";
import "../../styles/patient-access.css";

function PatientCreateAccount() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const details = useMemo(
    () => resolvePatientPendingLink(searchParams),
    [searchParams]
  );
  const query = buildPatientPendingLinkSearch(details);
  const [form, setForm] = useState({ email: "", password: "", confirmPassword: "" });
  const [message, setMessage] = useState("");
  const [created, setCreated] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState({ password: false, confirm: false });

  const updateForm = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const submit = async (event) => {
    event.preventDefault();
    if (isSubmitting || created) return;

    setMessage("");

    if (!details.patientId || !details.controlNumber) {
      setMessage("Patient access details are missing. Return to Patient Access and scan the clinic QR code again.");
      return;
    }
    if (form.password !== form.confirmPassword) {
      setMessage("Passwords do not match.");
      return;
    }

    setIsSubmitting(true);
    const email = normalizePatientAccessValue(form.email).toLowerCase();

    try {
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
        throw new Error(
          "Patient account created, but email confirmation is required before secure Patient linking. Confirm the email, then log in from Patient Login."
        );
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
      setMessage("Patient account created successfully. Your account is pending Admin activation.");
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

  return (
    <main className="patient-access-container">
      <section className="patient-access-shell" aria-label="Create Patient account">
        <div className="patient-access-panel">
          <div className="patient-access-brand is-compact maternal-care-brand">
            <MaternalCareLogo variant="access" />
          </div>

          <div className="patient-access-heading">
            <span className="patient-access-eyebrow">Secure registration</span>
            <h2>Create your patient account</h2>
            <p>Your account will be linked to the patient record issued by the clinic.</p>
          </div>

          <form className="patient-access-form" onSubmit={submit}>
            <div className="patient-access-field">
              <label htmlFor="patient-create-id">Patient ID</label>
              <div className="patient-access-input-wrap is-readonly">
                <Icon icon="solar:user-id-linear" aria-hidden="true" />
                <input id="patient-create-id" value={details.patientId} readOnly />
              </div>
            </div>
            <div className="patient-access-field">
              <label htmlFor="patient-create-email">Email address</label>
              <div className="patient-access-input-wrap">
                <Icon icon="solar:letter-linear" aria-hidden="true" />
                <input id="patient-create-email" type="email" value={form.email} onChange={(event) => updateForm("email", event.target.value)} autoComplete="email" placeholder="you@example.com" required />
              </div>
            </div>
            <div className="patient-access-field">
              <label htmlFor="patient-create-password">Password</label>
              <div className="patient-access-input-wrap">
                <Icon icon="solar:lock-password-linear" aria-hidden="true" />
                <input id="patient-create-password" type={passwordVisible.password ? "text" : "password"} value={form.password} onChange={(event) => updateForm("password", event.target.value)} minLength={6} autoComplete="new-password" placeholder="At least 6 characters" required />
                <button type="button" className="patient-access-password-toggle" onClick={() => setPasswordVisible((current) => ({ ...current, password: !current.password }))} aria-label={passwordVisible.password ? "Hide password" : "Show password"} aria-pressed={passwordVisible.password}>
                  <Icon icon={passwordVisible.password ? "solar:eye-closed-linear" : "solar:eye-linear"} />
                </button>
              </div>
            </div>
            <div className="patient-access-field">
              <label htmlFor="patient-create-confirm">Confirm password</label>
              <div className="patient-access-input-wrap">
                <Icon icon="solar:shield-check-linear" aria-hidden="true" />
                <input id="patient-create-confirm" type={passwordVisible.confirm ? "text" : "password"} value={form.confirmPassword} onChange={(event) => updateForm("confirmPassword", event.target.value)} minLength={6} autoComplete="new-password" placeholder="Re-enter your password" required />
                <button type="button" className="patient-access-password-toggle" onClick={() => setPasswordVisible((current) => ({ ...current, confirm: !current.confirm }))} aria-label={passwordVisible.confirm ? "Hide confirmation password" : "Show confirmation password"} aria-pressed={passwordVisible.confirm}>
                  <Icon icon={passwordVisible.confirm ? "solar:eye-closed-linear" : "solar:eye-linear"} />
                </button>
              </div>
            </div>
            <p className="patient-access-form-note">
              <Icon icon="solar:shield-check-bold-duotone" aria-hidden="true" />
              Your account needs clinic activation before dashboard access.
            </p>
            <button type="submit" disabled={isSubmitting || created}>
              {isSubmitting ? "Creating account..." : "Create Account"}
            </button>
            <button type="button" className="patient-access-link-button" onClick={() => navigate(`/patient/access${query}`)}>Back to Patient Access</button>
          </form>

          {message ? <p className="patient-access-message" role={created ? "status" : "alert"}>{message}</p> : null}
          {created ? (
            <div className="patient-access-result">
              <button type="button" onClick={() => navigate(`/patient/login${query}`)}>Go to Patient Login</button>
            </div>
          ) : null}
        </div>
        <div className="patient-access-hero" aria-hidden="true">
          <img src="/images/login-hero.png" alt="" />
          <div className="patient-access-hero-copy">
            <span>Private and connected</span>
            <strong>Your clinic-issued patient ID keeps your health information linked to the right account.</strong>
          </div>
        </div>
      </section>
    </main>
  );
}

export default PatientCreateAccount;
