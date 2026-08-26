import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { isClinicAccountInactive } from "../../lib/clinicAccountStatus";
import {
  normalizePatientAccountStatus,
  patientAccountStatuses,
} from "../../lib/patientAccountStatus";
import { supabase } from "../../lib/supabaseClient";
import { recordAuditEvent } from "../../lib/auditLog";
import MaternalCareLogo from "../../components/common/MaternalCareLogo";
import "../../styles/login.css";
import "../../styles/patient-access.css";

const roleRoutes = {
  admin: "/admin",
  staff: "/staff",
  patient: "/patient",
  doctor: "/doctor",
};

const SESSION_CLEAR_TIMEOUT_MS = 8000;
const inactiveDoctorMessage =
  "Your Doctor account has been deactivated. Please contact the administrator.";
const inactiveStaffMessage =
  "Your Staff account has been deactivated. Please contact the system administrator.";

async function signOutWithTimeout() {
  return Promise.race([
    supabase.auth.signOut(),
    new Promise((_, reject) => {
      window.setTimeout(
        () => reject(new Error("Sign out timed out.")),
        SESSION_CLEAR_TIMEOUT_MS
      );
    }),
  ]);
}

function getRoleRoute(role, nextPath = "") {
  const normalizedRole = String(role || "").trim().toLowerCase();
  const defaultRoute = roleRoutes[normalizedRole];

  if (!defaultRoute) {
    return null;
  }

  // Only allow a next path belonging to the authenticated user's role.
  if (
    nextPath &&
    nextPath.startsWith("/") &&
    nextPath.startsWith(defaultRoute)
  ) {
    return nextPath;
  }

  return defaultRoute;
}

async function getAuthenticatedRoleRoute(role, user, nextPath = "") {
  const normalizedRole = String(role || "").trim().toLowerCase();
  if (normalizedRole !== "patient") return getRoleRoute(role, nextPath);

  const { data, error } = await supabase.rpc(
    "get_current_patient_account_status"
  );

  if (error) {
    if (import.meta.env.DEV) {
      console.info("[Patient Login] Link status RPC unavailable or failed:", {
        authenticatedUserId: user?.id || null,
        errorCode: error.code || null,
      });
    }
    return "/patient/access";
  }

  const patient = Array.isArray(data) ? data[0] || null : data || null;
  const normalizedStatus = patient
    ? normalizePatientAccountStatus(patient.account_status)
    : "unlinked";

  if (import.meta.env.DEV) {
    console.info("[Patient Login] Account route resolved:", {
      authenticatedUserId: user?.id || null,
      matchingPatientsUserIdRowFound: Boolean(patient),
      selectedPatientInternalId: patient?.id || null,
      normalizedAccountStatus: normalizedStatus,
      redirectDestination:
        normalizedStatus === patientAccountStatuses.active
          ? "/patient/dashboard"
          : "/patient/access",
    });
  }

  if (normalizedStatus !== patientAccountStatuses.active) {
    const blockedError = new Error(
      normalizedStatus === patientAccountStatuses.inactive
        ? "Your Patient account is inactive. Please contact the clinic."
        : "Your Patient account is pending Admin activation."
    );
    blockedError.code = "patient_account_blocked";
    throw blockedError;
  }

  if (nextPath.startsWith("/patient") && nextPath !== "/patient/access") {
    return nextPath;
  }

  return "/patient/dashboard";
}

function isSchemaColumnError(error) {
  if (!error) return false;

  const message = `${error.message || ""} ${error.details || ""}`.toLowerCase();

  return (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    message.includes("schema cache") ||
    message.includes("could not find") ||
    message.includes("column")
  );
}

async function getUserRole(user) {
  if (!user?.id) {
    throw new Error("Authenticated user was not found.");
  }

  let { data: profile, error } = await supabase
    .from("profiles")
    .select("role, account_status")
    .eq("id", user.id)
    .maybeSingle();

  if (error && isSchemaColumnError(error)) {
    const legacyResult = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    profile = legacyResult.data;
    error = legacyResult.error;
  }

  if (error) {
    throw error;
  }

  if (!profile?.role) {
    throw new Error(
      "No account role is connected to this user. Please contact the administrator."
    );
  }

  if (
    String(profile.role || "").trim().toLowerCase() === "doctor" &&
    isClinicAccountInactive(profile.account_status)
  ) {
    const inactiveError = new Error(inactiveDoctorMessage);
    inactiveError.code = "doctor_account_inactive";
    throw inactiveError;
  }

  if (
    String(profile.role || "").trim().toLowerCase() === "staff" &&
    isClinicAccountInactive(profile.account_status)
  ) {
    const inactiveError = new Error(inactiveStaffMessage);
    inactiveError.code = "staff_account_inactive";
    throw inactiveError;
  }

  return profile.role;
}

function getLoginErrorMessage(error) {
  const message = String(error?.message || "").toLowerCase();

  if (message.includes("invalid login credentials")) {
    return "Invalid email or password. Please check your login details and try again.";
  }

  if (message.includes("email not confirmed")) {
    return "Please verify your email address before logging in.";
  }

  if (
    message.includes("rate limit") ||
    message.includes("too many requests")
  ) {
    return "Too many login attempts. Please wait a moment and try again.";
  }

  return error?.message || "Unable to log in. Please try again.";
}

function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const nextPath = searchParams.get("next") || "";
  const initialReason =
    searchParams.get("reason") === "staff_inactive"
      ? inactiveStaffMessage
      : searchParams.get("reason") || "";
  const shouldSkipSessionCheck =
    searchParams.get("logout") === "1" ||
    searchParams.get("emailChanged") === "1";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [loginError, setLoginError] = useState(initialReason);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [canResendVerification, setCanResendVerification] =
    useState(false);
  const [isResendingVerification, setIsResendingVerification] =
    useState(false);
  const [verificationMessage, setVerificationMessage] =
    useState("");

  useEffect(() => {
    let active = true;

    if (shouldSkipSessionCheck) {
      signOutWithTimeout()
        .catch((error) => {
          console.error("Login session cleanup failed:", error);
        })
        .finally(() => {
          if (active) {
            setCheckingSession(false);
          }
        });

      return () => {
        active = false;
      };
    }

    const redirectSignedInUser = async () => {
      try {
        const {
          data: { user },
          error,
        } = await supabase.auth.getUser();

        if (!active) return;

        if (error || !user) {
          setCheckingSession(false);
          return;
        }

        const role = await getUserRole(user);
        const redirectPath = await getAuthenticatedRoleRoute(
          role,
          user,
          nextPath
        );

        if (!redirectPath) {
          await supabase.auth.signOut();

          if (active) {
            setLoginError("Invalid account role.");
            setCheckingSession(false);
          }

          return;
        }

        navigate(redirectPath, { replace: true });
      } catch (error) {
        console.error("Session profile lookup failed:", error);

        if (
          error?.code === "staff_account_inactive" ||
          error?.code === "doctor_account_inactive" ||
          error?.code === "patient_account_blocked"
        ) {
          await signOutWithTimeout().catch(() => null);
        }

        if (active) {
          setLoginError(
            error?.message ||
              "Unable to load your account. Please log in again."
          );
          setCheckingSession(false);
        }
      }
    };

    redirectSignedInUser();

    return () => {
      active = false;
    };
  }, [navigate, nextPath, shouldSkipSessionCheck]);

  const handleLogin = async (event) => {
    event.preventDefault();

    if (isLoggingIn) return;

    const loginEmail = email.trim().toLowerCase();

    setLoginError("");
    setVerificationMessage("");
    setCanResendVerification(false);

    if (!loginEmail || !password) {
      setLoginError("Please enter your email and password.");
      return;
    }

    setIsLoggingIn(true);

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: loginEmail,
        password,
      });

      if (error) {
        setPassword("");
        const nextError = getLoginErrorMessage(error);

        setLoginError(nextError);
        setCanResendVerification(
          String(error.message || "")
            .toLowerCase()
            .includes("email not confirmed")
        );
        return;
      }

      if (!data?.user) {
        setLoginError("Unable to retrieve the authenticated account.");
        return;
      }

      let role;

      try {
        role = await getUserRole(data.user);
      } catch (profileError) {
        await supabase.auth.signOut();

        setLoginError(
          profileError?.message ||
            "Your account profile could not be loaded."
        );

        return;
      }

      const redirectPath = await getAuthenticatedRoleRoute(
        role,
        data.user,
        nextPath
      );

      if (!redirectPath) {
        await supabase.auth.signOut();
        setLoginError("Invalid account role.");
        return;
      }

      await recordAuditEvent({
        module: "authentication",
        action: "login",
        entityType: "auth_user",
        entityId: data.user.id,
        description: "User logged in.",
      });
      navigate(redirectPath, { replace: true });
    } catch (error) {
      console.error("Login failed:", error);
      if (error?.code === "patient_account_blocked") {
        await signOutWithTimeout().catch(() => null);
        setLoginError(error.message);
      } else {
        setLoginError("Unable to log in. Please try again.");
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const resendVerificationEmail = async () => {
    const loginEmail = email.trim().toLowerCase();

    setLoginError("");
    setVerificationMessage("");

    if (!loginEmail) {
      setLoginError("Enter your email address first.");
      return;
    }

    setIsResendingVerification(true);

    try {
      const { error } = await supabase.auth.resend({
        type: "signup",
        email: loginEmail,
      });

      if (error) {
        throw error;
      }

      setCanResendVerification(false);
      setVerificationMessage(
        "Verification email sent. Please check your inbox or spam folder."
      );
    } catch (error) {
      console.error("Verification email resend failed:", error);

      const message = String(error?.message || "").toLowerCase();

      if (
        message.includes("rate limit") ||
        message.includes("too many")
      ) {
        setLoginError(
          "Too many verification emails were requested. Please wait before trying again."
        );
      } else {
        setLoginError(
          error?.message ||
            "Unable to send the verification email. Check the email in Supabase Authentication > Users."
        );
      }
    } finally {
      setIsResendingVerification(false);
    }
  };

  if (checkingSession) {
    return (
      <div className="login-container login-opening">
        <div
          className="login-opening-card"
          role="status"
          aria-live="polite"
        >
          <MaternalCareLogo decorative variant="status" />

          <span>Opening Maternal Care</span>
        </div>
      </div>
    );
  }

  return (
    <main className="patient-access-container patient-login-container clinic-login-container">
      <section
        className="patient-access-shell patient-login-shell clinic-login-shell"
        aria-label="Maternal Care login"
      >
        <form
          className="patient-access-panel clinic-login-panel"
          onSubmit={handleLogin}
          noValidate
        >
          <div className="patient-access-brand is-compact maternal-care-brand">
            <MaternalCareLogo variant="access" />
          </div>

          <div className="patient-access-heading">
            <h2>Login</h2>
            <p>
              Use the email and password connected to your Maternal Care account.
            </p>
          </div>

          <div className="patient-access-form clinic-login-form">
            <div className="patient-access-field">
              <label htmlFor="login-email">Email address</label>
              <div className="patient-access-input-wrap">
                <Icon icon="solar:letter-linear" aria-hidden="true" />
                <input
                  id="login-email"
                  type="email"
                  value={email}
                  autoComplete="email"
                  inputMode="email"
                  placeholder="you@example.com"
                  disabled={isLoggingIn}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setLoginError("");
                    setVerificationMessage("");
                    setCanResendVerification(false);
                  }}
                  required
                />
              </div>
            </div>

            <div className="patient-access-field">
              <label htmlFor="login-password">Password</label>
              <div className="patient-access-input-wrap">
                <Icon icon="solar:lock-password-linear" aria-hidden="true" />
                <input
                  id="login-password"
                  type={passwordVisible ? "text" : "password"}
                  value={password}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  disabled={isLoggingIn}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setLoginError("");
                    setVerificationMessage("");
                  }}
                  required
                />
                <button
                  type="button"
                  className="patient-access-password-toggle"
                  onClick={() => setPasswordVisible((visible) => !visible)}
                  aria-label={passwordVisible ? "Hide password" : "Show password"}
                  aria-pressed={passwordVisible}
                  disabled={isLoggingIn}
                >
                  <Icon
                    icon={
                      passwordVisible
                        ? "solar:eye-closed-linear"
                        : "solar:eye-linear"
                    }
                  />
                </button>
              </div>
            </div>

            {loginError ? (
              <p
                className="login-error-message"
                role="alert"
                aria-live="assertive"
              >
                {loginError}
              </p>
            ) : null}

            {verificationMessage ? (
              <p
                className="login-success-message"
                role="status"
                aria-live="polite"
              >
                {verificationMessage}
              </p>
            ) : null}

            {canResendVerification ? (
              <button
                type="button"
                className="login-secondary-btn"
                onClick={resendVerificationEmail}
                disabled={isResendingVerification || isLoggingIn}
              >
                {isResendingVerification
                  ? "Sending..."
                  : "Resend verification email"}
              </button>
            ) : null}

            <button
              type="submit"
              disabled={isLoggingIn}
            >
              {isLoggingIn ? "Logging in..." : "Login"}
            </button>

            <Link
              to="/forgot-password"
              className="patient-access-link-button clinic-login-link"
            >
              Forgot Password
            </Link>
          </div>
        </form>

        <div className="patient-access-hero" aria-hidden="true">
          <img
            src="/images/login-hero.png"
            alt=""
          />

          <div className="patient-access-hero-copy">
            <span>Care coordination, in one place</span>
            <strong>
              Patients, appointments, and clinical workflows—always within reach.
            </strong>
          </div>
        </div>
      </section>
    </main>
  );
}

export default Login;
