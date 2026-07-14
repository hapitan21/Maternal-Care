import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import "../../styles/patient-access.css";

const patientSelectColumns =
  "id, full_name, patient_id, control_number, control_used_at, user_id, email, date_of_birth, age, address, contact_number, status";
const patientLoginSelectColumns =
  "id, patient_record_id, full_name, patient_id, control_number, control_used_at, user_id, email, date_of_birth, age, address, contact_number, status";
const patientSessionStorageKey = "maternal_patient_session";

function normalize(value) {
  return String(value || "").trim();
}

function getAccessStep(searchParams, initialControl) {
  const mode = searchParams.get("mode");

  if (mode === "login") return "login";
  return initialControl ? "access" : "access";
}

function isMissingRpcFunctionError(error) {
  if (!error) return false;

  const message = `${error.message || ""} ${error.details || ""}`.toLowerCase();

  return (
    error.code === "42883" ||
    error.code === "PGRST202" ||
    message.includes("could not find the function") ||
    message.includes("schema cache")
  );
}

function isMissingPatientLoginTableError(error) {
  if (!error) return false;

  const message = `${error.message || ""} ${error.details || ""}`.toLowerCase();

  return (
    error.code === "42P01" ||
    error.code === "42703" ||
    error.code === "PGRST200" ||
    error.code === "PGRST204" ||
    error.code === "PGRST205" ||
    message.includes("patient_login") ||
    message.includes("could not find the table") ||
    message.includes("could not find the column") ||
    message.includes("schema cache")
  );
}

function isTypeMismatchError(error) {
  if (!error) return false;

  const message = `${error.message || ""} ${error.details || ""}`.toLowerCase();

  return (
    error.code === "22P02" ||
    message.includes("invalid input syntax for type bigint") ||
    message.includes("invalid input syntax for type integer")
  );
}

function normalizeAccessRecord(row, sourceTable) {
  if (!row) return null;

  return {
    ...row,
    source_table: sourceTable,
    patient_record_id: row.patient_record_id || null,
  };
}

function rememberPatientSession(patient, user, email) {
  const patientRecordId =
    patient.patient_record_id ||
    (patient.source_table === "patients" ? patient.id : null);

  if (!patientRecordId && !patient.patient_id) return;

  window.localStorage.setItem(
    patientSessionStorageKey,
    JSON.stringify({
      userId: user?.id || patient.user_id || "",
      recordId: patientRecordId || "",
      patientId: patient.patient_id || "",
      email: email || patient.email || user?.email || "",
      displayName: patient.full_name || "Patient",
    })
  );
}

async function findPatientByAccess(patientId, controlNumber) {
  const cleanPatientId = normalize(patientId);
  const cleanControl = normalize(controlNumber);

  const { data: loginRpcData, error: loginRpcError } = await supabase.rpc("get_patient_login_access_record", {
    login_patient_id: cleanPatientId || null,
    login_control_number: cleanControl,
  });

  if (!loginRpcError && Array.isArray(loginRpcData) && loginRpcData[0]) {
    return normalizeAccessRecord(loginRpcData[0], "patient_login");
  }

  if (loginRpcError && !isMissingRpcFunctionError(loginRpcError)) {
    throw loginRpcError;
  }

  let patientLoginQuery = supabase
    .from("patient_login")
    .select(patientLoginSelectColumns)
    .eq("control_number", cleanControl);

  if (cleanPatientId) {
    patientLoginQuery = patientLoginQuery.eq("patient_id", cleanPatientId);
  }

  const { data: loginData, error: loginError } = await patientLoginQuery
    .limit(1)
    .maybeSingle();

  if (loginError && !isMissingPatientLoginTableError(loginError)) {
    throw loginError;
  }

  if (loginData) {
    return normalizeAccessRecord(loginData, "patient_login");
  }

  let query = supabase
    .from("patients")
    .select(patientSelectColumns)
    .eq("control_number", cleanControl);

  if (cleanPatientId) {
    query = query.eq("patient_id", cleanPatientId);
  }

  const { data, error } = await query.limit(1).maybeSingle();

  if (error) throw error;
  return normalizeAccessRecord(data, "patients");
}

async function getPatientRole(user) {
  if (user.email) {
    const { data, error } = await supabase
      .from("profiles")
      .select("role")
      .eq("email", user.email)
      .maybeSingle();

    if (!error) return data?.role?.toLowerCase() || "";

    if (isTypeMismatchError(error)) {
      console.warn("Patient role lookup skipped because profiles schema rejected the lookup:", error);
      return "";
    }
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    if (isTypeMismatchError(error)) {
      console.warn("Patient role lookup skipped because profiles.id is not a UUID column:", error);
      return "";
    }

    throw error;
  }

  return data?.role?.toLowerCase() || "";
}

function createPersonalInfoPayload(patient, user, email) {
  const patientRecordId = patient.patient_record_id || (patient.source_table === "patients" ? patient.id : null);

  return {
    user_id: user.id,
    patient_record_id: patientRecordId,
    patient_code: patient.patient_id,
    full_name: patient.full_name || "Patient",
    email,
    birthdate: patient.date_of_birth || null,
    age: patient.age || null,
    address: patient.address || null,
    contact_number: patient.contact_number || null,
    updated_at: new Date().toISOString(),
  };
}

async function markPatientAccessActivated(patient, user, email) {
  const activatedAt = new Date().toISOString();

  if (patient.source_table === "patient_login") {
    const payload = {
      user_id: user.id,
      email,
      control_used_at: activatedAt,
      status: "Active",
      screen_key: "login",
      sort_order: 3,
    };

    const { error } = await supabase
      .from("patient_login")
      .update(payload)
      .eq("id", patient.id);

    if (error && isMissingPatientLoginTableError(error)) {
      const { error: retryError } = await supabase
        .from("patient_login")
        .update({
          user_id: user.id,
          email,
          control_used_at: activatedAt,
          status: "Active",
        })
        .eq("id", patient.id);

      if (retryError) throw retryError;
    } else if (error) {
      console.warn("Patient login activation update failed:", error);
    }
  }

  const patientRecordId = patient.patient_record_id || (patient.source_table === "patients" ? patient.id : null);

  if (patientRecordId) {
    const { error } = await supabase
      .from("patients")
      .update({
        user_id: user.id,
        email,
        control_used_at: activatedAt,
        status: "Active",
      })
      .eq("id", patientRecordId);

    if (error) {
      console.warn("Patient record activation by id failed:", error);

      const { error: fallbackError } = await supabase
        .from("patients")
        .update({
          user_id: user.id,
          email,
          control_used_at: activatedAt,
          status: "Active",
        })
        .eq("patient_id", patient.patient_id)
        .eq("control_number", patient.control_number);

      if (fallbackError) {
        console.warn("Patient record activation fallback failed:", fallbackError);
      }
    }
  }
}

function PatientAccess() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialControl = searchParams.get("control") || "";
  const initialPatientId = searchParams.get("patientId") || "";

  const [step, setStep] = useState(() => getAccessStep(searchParams, initialControl));
  const [controlNumber, setControlNumber] = useState(initialControl);
  const [activePatient, setActivePatient] = useState(null);
  const [accountForm, setAccountForm] = useState({
    patientId: initialPatientId,
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [loginForm, setLoginForm] = useState({
    email: "",
    password: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  const updateAccountForm = (field, value) => {
    setAccountForm((current) => ({ ...current, [field]: value }));
  };

  const updateLoginForm = (field, value) => {
    setLoginForm((current) => ({ ...current, [field]: value }));
  };

  const submitControlNumber = async (event) => {
    event.preventDefault();
    setMessage("");

    if (!normalize(controlNumber)) {
      setMessage("Please enter your control number.");
      return;
    }

    setIsSubmitting(true);

    try {
      const patient = await findPatientByAccess(accountForm.patientId, controlNumber);

      if (!patient) {
        setMessage("The control number does not match an active patient record.");
        return;
      }

      setActivePatient(patient);
      setAccountForm((current) => ({
        ...current,
        patientId: patient.patient_id || current.patientId,
        email: patient.email || current.email,
      }));

      if (patient.user_id || patient.control_used_at) {
        setMessage("This patient account is already activated. Please log in.");
        setLoginForm((current) => ({ ...current, email: patient.email || current.email }));
        setStep("login");
        return;
      }

      setStep("create");
    } catch (error) {
      console.error("Patient access lookup failed:", error);
      setMessage(`Patient access is not ready: ${error.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const createAccount = async (event) => {
    event.preventDefault();
    setMessage("");

    if (!normalize(accountForm.patientId)) {
      setMessage("Please enter your patient ID.");
      return;
    }

    if (accountForm.password !== accountForm.confirmPassword) {
      setMessage("Passwords do not match.");
      return;
    }

    setIsSubmitting(true);

    try {
      const patient =
        activePatient ||
        (await findPatientByAccess(accountForm.patientId, controlNumber));

      if (!patient) {
        setMessage("Patient record not found. Check your patient ID and control number.");
        return;
      }

      if (patient.user_id || patient.control_used_at) {
        setMessage("This patient account is already activated. Please log in.");
        setStep("login");
        return;
      }

      const email = normalize(accountForm.email);
      const { data, error } = await supabase.auth.signUp({
        email,
        password: accountForm.password,
        options: {
          data: {
            role: "patient",
            full_name: patient.full_name,
            patient_id: patient.patient_id,
            control_number: controlNumber,
          },
        },
      });

      if (error) throw error;

      const user = data.user;

      if (!user) {
        setMessage("Account created. Please log in after confirming your email.");
        setLoginForm({ email, password: "" });
        setStep("login");
        return;
      }

      const profilePayload = {
        id: user.id,
        full_name: patient.full_name || "Patient",
        email,
        role: "patient",
        patient_id: patient.patient_id,
        control_number: controlNumber,
      };

      const { error: profileError } = await supabase
        .from("profiles")
        .upsert([profilePayload], { onConflict: "id" });

      if (profileError) {
        console.warn("Patient profile sync failed:", profileError);

        if (isTypeMismatchError(profileError)) {
          const { error: emailProfileError } = await supabase
            .from("profiles")
            .upsert(
              [
                {
                  full_name: patient.full_name || "Patient",
                  email,
                  role: "patient",
                  patient_id: patient.patient_id,
                  control_number: controlNumber,
                },
              ],
              { onConflict: "email" }
            );

          if (emailProfileError) {
            console.warn("Patient profile email sync failed:", emailProfileError);
          }
        }
      }

      await markPatientAccessActivated(patient, user, email);

      const { error: personalInfoError } = await supabase
        .from("patient_personal_information")
        .upsert([createPersonalInfoPayload(patient, user, email)], {
          onConflict: "user_id",
        });

      if (personalInfoError) {
        console.warn("Patient personal information sync failed:", personalInfoError);

        if (isTypeMismatchError(personalInfoError)) {
          const { error: retryPersonalInfoError } = await supabase
            .from("patient_personal_information")
            .upsert(
              [
                {
                  patient_code: patient.patient_id,
                  full_name: patient.full_name || "Patient",
                  email,
                  birthdate: patient.date_of_birth || null,
                  age: patient.age || null,
                  address: patient.address || null,
                  contact_number: patient.contact_number || null,
                  updated_at: new Date().toISOString(),
                },
              ],
              { onConflict: "patient_code" }
            );

          if (retryPersonalInfoError) {
            console.warn("Patient personal information retry failed:", retryPersonalInfoError);
          }
        }
      }

      if (data.session) {
        await supabase.auth.signOut();
      }

      setMessage("Account created. Please log in to continue.");
      setLoginForm({ email, password: "" });
      setStep("login");
    } catch (error) {
      console.error("Patient account creation failed:", error);
      setMessage(error.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const loginPatient = async (event) => {
    event.preventDefault();
    setMessage("");
    setIsSubmitting(true);

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: normalize(loginForm.email),
        password: loginForm.password,
      });

      if (error) throw error;

      const role = await getPatientRole(data.user);

      if (role && role !== "patient") {
        await supabase.auth.signOut();
        setMessage("This login is not a patient account.");
        return;
      }

      const email = normalize(loginForm.email);
      const { data: profileRow } = await supabase
        .from("profiles")
        .select("patient_id, full_name, email")
        .or(`id.eq.${data.user.id},email.eq.${email}`)
        .maybeSingle();
      let patientQuery = supabase
        .from("patients")
        .select(patientSelectColumns)
        .eq("user_id", data.user.id);
      let { data: patientRow } = await patientQuery.limit(1).maybeSingle();

      if (!patientRow && profileRow?.patient_id) {
        const result = await supabase
          .from("patients")
          .select(patientSelectColumns)
          .eq("patient_id", profileRow.patient_id)
          .limit(1)
          .maybeSingle();
        patientRow = result.data || null;
      }

      if (!patientRow && email) {
        const result = await supabase
          .from("patients")
          .select(patientSelectColumns)
          .eq("email", email)
          .limit(1)
          .maybeSingle();
        patientRow = result.data || null;
      }

      if (patientRow) {
        rememberPatientSession(
          normalizeAccessRecord(patientRow, "patients"),
          data.user,
          email
        );
      } else if (profileRow?.patient_id) {
        rememberPatientSession(
          normalizeAccessRecord(
            {
              patient_id: profileRow.patient_id,
              full_name: profileRow.full_name,
              email: profileRow.email || email,
              user_id: data.user.id,
            },
            "patient_login"
          ),
          data.user,
          email
        );
      }

      navigate("/patient", { replace: true });
    } catch (error) {
      console.error("Patient login failed:", error);
      setMessage(error.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderForm = () => {
    if (step === "create") {
      return (
        <form className="patient-access-form" onSubmit={createAccount}>
          <label>
            Patient ID:
            <input
              type="text"
              value={accountForm.patientId}
              onChange={(event) => updateAccountForm("patientId", event.target.value)}
              required
            />
          </label>
          <label>
            Email:
            <input
              type="email"
              value={accountForm.email}
              onChange={(event) => updateAccountForm("email", event.target.value)}
              required
            />
          </label>
          <label>
            Password:
            <input
              type="password"
              value={accountForm.password}
              onChange={(event) => updateAccountForm("password", event.target.value)}
              minLength={6}
              required
            />
          </label>
          <label>
            Confirm Password:
            <input
              type="password"
              value={accountForm.confirmPassword}
              onChange={(event) => updateAccountForm("confirmPassword", event.target.value)}
              minLength={6}
              required
            />
          </label>
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Creating Account..." : "Create Account"}
          </button>
        </form>
      );
    }

    if (step === "login") {
      return (
        <form className="patient-access-form" onSubmit={loginPatient}>
          <label>
            Email:
            <input
              type="email"
              value={loginForm.email}
              onChange={(event) => updateLoginForm("email", event.target.value)}
              required
            />
          </label>
          <label>
            Password:
            <input
              type="password"
              value={loginForm.password}
              onChange={(event) => updateLoginForm("password", event.target.value)}
              required
            />
          </label>
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Logging in..." : "Login"}
          </button>
          <button
            type="button"
            className="patient-access-link-button"
            onClick={() => navigate("/forgot-password")}
          >
            Forgot Password?
          </button>
        </form>
      );
    }

    return (
      <form className="patient-access-form" onSubmit={submitControlNumber}>
        <label>
          Enter Control Number:
          <input
            type="text"
            value={controlNumber}
            onChange={(event) => setControlNumber(event.target.value)}
            autoComplete="one-time-code"
            required
          />
        </label>
        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Checking..." : "Submit"}
        </button>
      </form>
    );
  };

  return (
    <div className="patient-access-container">
      <section className="patient-access-shell" aria-label="Patient access">
        <div className="patient-access-panel">
          <div className="patient-access-brand">
            <img src="/images/maternal-care-logo.png" alt="Maternal Care logo" />
            <h1>Maternal Care</h1>
            <p>Reminder &amp; Appointment<br />Management System</p>
          </div>

          {renderForm()}

          {message ? (
            <p className="patient-access-message" role="status">
              {message}
            </p>
          ) : null}
        </div>

        <div className="patient-access-hero" aria-hidden="true">
          <img src="/images/login-hero.png" alt="" />
        </div>
      </section>
    </div>
  );
}

export default PatientAccess;
