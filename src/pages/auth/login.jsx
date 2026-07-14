import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import "../../styles/login.css";

const roleRoutes = {
  admin: "/admin",
  staff: "/staff",
  patient: "/patient",
  doctor: "/doctor",
};

const SESSION_CLEAR_TIMEOUT_MS = 8000;

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

async function getUserRole(user) {
  if (!user?.id) {
    throw new Error("Authenticated user was not found.");
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!profile?.role) {
    throw new Error(
      "No account role is connected to this user. Please contact the administrator."
    );
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
  const shouldSkipSessionCheck =
    searchParams.get("logout") === "1" ||
    searchParams.get("emailChanged") === "1";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [checkingSession, setCheckingSession] = useState(true);
  const [loginError, setLoginError] = useState("");
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
        const redirectPath = getRoleRoute(role, nextPath);

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

      const redirectPath = getRoleRoute(role, nextPath);

      if (!redirectPath) {
        await supabase.auth.signOut();
        setLoginError("Invalid account role.");
        return;
      }

      navigate(redirectPath, { replace: true });
    } catch (error) {
      console.error("Login failed:", error);
      setLoginError("Unable to log in. Please try again.");
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
          <img
            className="login-logo"
            src="/images/maternal-care-logo.png"
            alt=""
          />

          <span>Opening Maternal Care</span>
        </div>
      </div>
    );
  }

  return (
    <div className="login-container">
      <section
        className="login-shell"
        aria-label="Maternal Care login"
      >
        <form
          className="login-panel"
          onSubmit={handleLogin}
          noValidate
        >
          <div className="login-brand">
            <img
              className="login-logo"
              src="/images/maternal-care-logo.png"
              alt="Maternal Care logo"
            />

            <h1>Maternal Care</h1>

            <p>
              Reminder &amp; Appointment
              <br />
              Management System
            </p>
          </div>

          <div className="login-fields">
            <label htmlFor="login-email">
              Email:
              <input
                id="login-email"
                type="email"
                value={email}
                autoComplete="email"
                inputMode="email"
                disabled={isLoggingIn}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setLoginError("");
                  setVerificationMessage("");
                  setCanResendVerification(false);
                }}
                required
              />
            </label>

            <label htmlFor="login-password">
              Password:
              <input
                id="login-password"
                type="password"
                value={password}
                autoComplete="current-password"
                disabled={isLoggingIn}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setLoginError("");
                  setVerificationMessage("");
                }}
                required
              />
            </label>

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
              className="login-btn"
              disabled={isLoggingIn}
            >
              {isLoggingIn ? "Logging in..." : "Login"}
            </button>

            <Link
              to="/forgot-password"
              className="forgot-password-link"
            >
              Forgot Password?
            </Link>
          </div>
        </form>

        <div className="login-hero" aria-hidden="true">
          <img
            className="login-illustration"
            src="/images/login-hero.png"
            alt=""
          />
        </div>
      </section>
    </div>
  );
}

export default Login;
