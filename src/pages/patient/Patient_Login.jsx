import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { useNavigate, useSearchParams } from "react-router-dom";

import {
  ensurePatientProfile,
  getCurrentPatientAccountStatus,
  getPatientAccountMessage,
  getPatientLinkingErrorMessage,
  getPatientRpcRow,
  isMissingPatientAuthSession,
  normalizePatientAccessValue,
} from "../../lib/patientAuthLinking";

import {
  normalizePatientAccountStatus,
  patientAccountStatuses,
} from "../../lib/patientAccountStatus";

import {
  buildPatientPendingLinkSearch,
  clearPatientPendingLink,
  resolvePatientPendingLink,
} from "../../lib/patientPendingLink";

import { supabase } from "../../lib/supabaseClient";
import MaternalCareLogo from "../../components/common/MaternalCareLogo";

import "../../styles/patient-access.css";

function PatientLogin() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const details = useMemo(
    () => resolvePatientPendingLink(searchParams),
    [searchParams]
  );

  const query = buildPatientPendingLinkSearch(details);

  const initialEmail = normalizePatientAccessValue(
    searchParams.get("email")
  ).toLowerCase();

  const accountCreated = searchParams.get("accountCreated") === "true";
  const confirmationRequired =
    searchParams.get("confirmationRequired") === "true";

  const hasDetails = Boolean(
    details.patientId && details.controlNumber
  );

  const [form, setForm] = useState({
    email: initialEmail,
    password: "",
  });

  const [message, setMessage] = useState(
    confirmationRequired
      ? "Patient account created. Confirm your email, then log in here to finish securely linking your Patient record."
      : accountCreated
      ? "Patient account created successfully. Log in to open your Patient dashboard."
      : ""
  );
  const [messageTone, setMessageTone] = useState(
    accountCreated || confirmationRequired ? "notice" : "error"
  );

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);

  const submit = async (event) => {
    event.preventDefault();

    setMessage("");
    setMessageTone("error");
    setIsSubmitting(true);

    try {
      // ============================================================
      // 1. Authenticate Patient
      // ============================================================
      const { data, error } = await supabase.auth.signInWithPassword({
        email: normalizePatientAccessValue(form.email).toLowerCase(),
        password: form.password,
      });

      if (error) {
        throw error;
      }

      if (!data?.user?.id) {
        throw new Error(
          "Unable to identify the authenticated Patient account."
        );
      }

      // ============================================================
      // 2. Check whether this Auth account is already linked
      //
      // IMPORTANT:
      // Do NOT call:
      //
      // ensurePatientProfile(data.user, null)
      //
      // because that could overwrite profiles.patient_id with null.
      // ============================================================
      const current = await getCurrentPatientAccountStatus();

      // ============================================================
      // 3. Existing linked Patient
      // ============================================================
      if (current.patient) {
        const linkedPatientId = normalizePatientAccessValue(
          current.patient.patient_id
        );

        // Repair / preserve profiles.patient_id using the canonical
        // Patient record returned by the secure RPC.
        if (linkedPatientId) {
          await ensurePatientProfile(
            data.user,
            linkedPatientId
          );
        }

        // ----------------------------------------------------------
        // Active Patient → allow access
        // ----------------------------------------------------------
        if (current.status === patientAccountStatuses.active) {
          clearPatientPendingLink();

          navigate("/patient/dashboard", {
            replace: true,
          });

          return;
        }

        // ----------------------------------------------------------
        // Linked but Pending / Inactive / Archived
        // ----------------------------------------------------------
        clearPatientPendingLink();

        await supabase.auth.signOut();

        setMessage(
          getPatientAccountMessage(current.status)
        );
        setMessageTone(
          current.status === patientAccountStatuses.pending ? "notice" : "error"
        );

        return;
      }

      // ============================================================
      // 4. Auth account is not linked yet
      //
      // It must have Patient ID + one-time control number from
      // Patient Access / QR code.
      // ============================================================
      if (
        !details.patientId ||
        !details.controlNumber
      ) {
        await supabase.auth.signOut();

        setMessage(
          "No Patient record is linked to this account. Return to Patient Access and scan the clinic QR code."
        );
        setMessageTone("error");

        return;
      }

      // ============================================================
      // 5. Securely link Auth account to Patient record
      // ============================================================
      const {
        data: linkData,
        error: linkError,
      } = await supabase.rpc(
        "link_patient_auth_account",
        {
          p_patient_id: details.patientId,
          p_control_number: details.controlNumber,
        }
      );

      if (linkError) {
        throw linkError;
      }

      const linkedPatient = getPatientRpcRow(linkData);

      if (!linkedPatient?.linked) {
        throw new Error(
          "The Patient record could not be linked."
        );
      }

      const linkedPatientId = normalizePatientAccessValue(
        linkedPatient.patient_id
      );

      if (!linkedPatientId) {
        throw new Error(
          "The linked Patient record did not return a Patient ID."
        );
      }

      // ============================================================
      // 6. Synchronize profiles.patient_id
      // ============================================================
      await ensurePatientProfile(
        data.user,
        linkedPatientId
      );

      clearPatientPendingLink();

      if (
        normalizePatientAccountStatus(linkedPatient.account_status) ===
        patientAccountStatuses.active
      ) {
        navigate("/patient/dashboard", {
          replace: true,
        });
        return;
      }

      await supabase.auth.signOut();

      setMessage(
        "Your Patient account is pending Admin activation."
      );
      setMessageTone("notice");
    } catch (error) {
      if (isMissingPatientAuthSession(error)) {
        setMessage(
          "Your session has expired. Log in again to continue."
        );
      } else {
        setMessage(
          getPatientLinkingErrorMessage(error)
        );
      }
      setMessageTone("error");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="patient-access-container patient-login-container">
      <section
        className="patient-access-shell patient-login-shell"
        aria-label="Patient login"
      >
        <div className="patient-access-panel">
          <div className="patient-access-brand is-compact maternal-care-brand">
            <MaternalCareLogo variant="access" />
          </div>

          <div className="patient-access-heading">
            <span className="patient-access-eyebrow">Welcome back</span>
            <h2>Login to your patient account</h2>
            <p>Use the email and password connected to your Maternal Care record.</p>
          </div>

          <form
            className="patient-access-form"
            onSubmit={submit}
          >
            <div className="patient-access-field">
              <label htmlFor="patient-login-email">Email address</label>
              <div className="patient-access-input-wrap">
                <Icon icon="solar:letter-linear" aria-hidden="true" />
                <input
                  id="patient-login-email"
                  type="email"
                  value={form.email}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      email: event.target.value,
                    }))
                  }
                  autoComplete="email"
                  placeholder="you@example.com"
                  required
                />
              </div>
            </div>

            <div className="patient-access-field">
              <label htmlFor="patient-login-password">Password</label>
              <div className="patient-access-input-wrap">
                <Icon icon="solar:lock-password-linear" aria-hidden="true" />
                <input
                  id="patient-login-password"
                  type={passwordVisible ? "text" : "password"}
                  value={form.password}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      password: event.target.value,
                    }))
                  }
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  required
                />
                <button
                  type="button"
                  className="patient-access-password-toggle"
                  onClick={() => setPasswordVisible((visible) => !visible)}
                  aria-label={passwordVisible ? "Hide password" : "Show password"}
                  aria-pressed={passwordVisible}
                >
                  <Icon icon={passwordVisible ? "solar:eye-closed-linear" : "solar:eye-linear"} />
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
            >
              {isSubmitting
                ? "Logging in..."
                : "Login"}
            </button>

            <button
              type="button"
              className="patient-access-link-button"
              onClick={() =>
                navigate("/forgot-password")
              }
            >
              Forgot Password
            </button>

            {hasDetails ? (
              <>
                <button
                  type="button"
                  className="patient-access-link-button"
                  onClick={() =>
                    navigate(
                      `/patient/create-account${query}`
                    )
                  }
                >
                  Create Patient Account
                </button>

                <button
                  type="button"
                  className="patient-access-link-button"
                  onClick={() =>
                    navigate(
                      `/patient/access${query}`
                    )
                  }
                >
                  Back to Patient Access
                </button>
              </>
            ) : null}
          </form>

          {message ? (
            <p
              className={`patient-access-message is-${messageTone}`}
              role="status"
            >
              {message}
            </p>
          ) : null}
        </div>

        <div
          className="patient-access-hero"
          aria-hidden="true"
        >
          <img
            src="/images/login-hero.png"
            alt=""
          />
          <div className="patient-access-hero-copy">
            <span>Your care, in one place</span>
            <strong>Appointments, medical records, and reminders—always within reach.</strong>
          </div>
        </div>
      </section>
    </main>
  );
}

export default PatientLogin;
