import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { Link, useNavigate } from "react-router-dom";
import MaternalCareLogo from "../../components/common/MaternalCareLogo";
import PasswordSecurityFeedback from "../../components/common/PasswordSecurityFeedback";
import {
  getPasswordValidationMessage,
  PASSWORD_MIN_LENGTH,
  passwordsMatch,
  validatePassword,
} from "../../lib/passwordSecurity";
import { supabase } from "../../lib/supabaseClient";
import "../../styles/forgot-password.css";

const recoverySteps = [
  { key: "request", label: "Email" },
  { key: "verify", label: "Verify" },
  { key: "password", label: "Password" },
];

const initialOtpDigits = ["", "", "", "", "", ""];

function maskEmail(value) {
  const [localPart = "", domain = ""] = String(value || "").split("@");
  if (!localPart || !domain) return value;

  const leading = localPart.slice(0, Math.min(2, localPart.length));
  const trailing = localPart.length > 4 ? localPart.slice(-2) : "";
  const hiddenLength = Math.max(3, localPart.length - leading.length - trailing.length);

  return `${leading}${"*".repeat(hiddenLength)}${trailing}@${domain}`;
}

function getRecoveryErrorMessage(error) {
  const message = `${error?.message || error || ""}`.toLowerCase();

  if (
    message.includes("expired") ||
    message.includes("invalid") ||
    message.includes("token") ||
    message.includes("otp")
  ) {
    return "The verification code is invalid or has expired. Request a new code and try again.";
  }

  return "We could not complete that request. Please try again.";
}

function getRecoveryUrlState() {
  if (typeof window === "undefined") {
    return { recoveryError: "", isRecoveryLink: false };
  }

  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const searchParams = new URLSearchParams(window.location.search);
  const recoveryError =
    hashParams.get("error_description") ||
    searchParams.get("error_description") ||
    hashParams.get("error") ||
    searchParams.get("error") ||
    "";

  return {
    recoveryError,
    isRecoveryLink:
      hashParams.get("type") === "recovery" ||
      searchParams.get("type") === "recovery",
  };
}

function Feedback({ tone, children }) {
  if (!children) return null;

  return (
    <div
      className={`forgot-password-feedback is-${tone}`}
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
    >
      <Icon
        icon={tone === "error" ? "solar:danger-circle-bold-duotone" : "solar:check-circle-bold-duotone"}
        aria-hidden="true"
      />
      <span>{children}</span>
    </div>
  );
}

function PasswordField({
  id,
  label,
  value,
  visible,
  onChange,
  onToggle,
  autoComplete,
  disabled,
}) {
  return (
    <label className="forgot-password-field" htmlFor={id}>
      <span>{label}</span>
      <div className="forgot-password-input-wrap">
        <Icon icon="solar:lock-password-linear" aria-hidden="true" />
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          autoComplete={autoComplete}
          placeholder={`Enter ${label.toLowerCase()}`}
          onChange={onChange}
          disabled={disabled}
          minLength={PASSWORD_MIN_LENGTH}
          required
        />
        <button
          type="button"
          className="forgot-password-password-toggle"
          onClick={onToggle}
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          aria-pressed={visible}
          disabled={disabled}
        >
          <Icon icon={visible ? "solar:eye-closed-linear" : "solar:eye-linear"} />
        </button>
      </div>
    </label>
  );
}

function ForgotPassword() {
  const navigate = useNavigate();
  const otpInputRefs = useRef([]);
  const [email, setEmail] = useState("");
  const [otpDigits, setOtpDigits] = useState(initialOtpDigits);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [newPasswordVisible, setNewPasswordVisible] = useState(false);
  const [confirmPasswordVisible, setConfirmPasswordVisible] = useState(false);
  const [confirmInteracted, setConfirmInteracted] = useState(false);
  const [step, setStep] = useState("request");
  const [cooldown, setCooldown] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [resending, setResending] = useState(false);
  const [feedback, setFeedback] = useState(() => {
    const { recoveryError } = getRecoveryUrlState();
    return recoveryError
      ? {
          tone: "error",
          message: getRecoveryErrorMessage(recoveryError.replace(/\+/g, " ")),
        }
      : { tone: "", message: "" };
  });

  const recoveryRedirectTo = useMemo(() => {
    if (typeof window === "undefined") return undefined;
    return new URL("/forgot-password", window.location.origin).toString();
  }, []);

  const passwordResult = validatePassword(newPassword);
  const passwordMatch = passwordsMatch(newPassword, confirmPassword);
  const activeStepIndex = step === "success"
    ? recoverySteps.length
    : Math.max(0, recoverySteps.findIndex((item) => item.key === step));

  useEffect(() => {
    if (cooldown <= 0) return undefined;

    const timer = window.setTimeout(() => {
      setCooldown((current) => Math.max(0, current - 1));
    }, 1000);

    return () => window.clearTimeout(timer);
  }, [cooldown]);

  useEffect(() => {
    let active = true;
    const { recoveryError, isRecoveryLink } = getRecoveryUrlState();

    const applyRecoverySession = async () => {
      if (!isRecoveryLink || recoveryError) return;

      const {
        data: { session },
        error,
      } = await supabase.auth.getSession();

      if (!active) return;

      if (error || !session) {
        setFeedback({
          tone: "error",
          message: "This recovery link is invalid or has expired. Request a new code and try again.",
        });
        return;
      }

      setEmail(session.user?.email || "");
      setFeedback({ tone: "", message: "" });
      setStep("password");
    };

    applyRecoverySession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event !== "PASSWORD_RECOVERY" || !active) return;

      setEmail(session?.user?.email || "");
      setFeedback({ tone: "", message: "" });
      setStep("password");
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const sendRecoveryCode = async () => {
    return supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: recoveryRedirectTo,
    });
  };

  const handleSendOtp = async (event) => {
    event.preventDefault();
    const normalizedEmail = email.trim();

    if (!normalizedEmail) {
      setFeedback({ tone: "error", message: "Enter your email address." });
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setFeedback({ tone: "error", message: "Enter a valid email address." });
      return;
    }

    try {
      setProcessing(true);
      setFeedback({ tone: "", message: "" });
      const { error } = await sendRecoveryCode();
      if (error) throw error;

      setEmail(normalizedEmail);
      setOtpDigits(initialOtpDigits);
      setCooldown(60);
      setFeedback({
        tone: "success",
        message: "Verification code sent. Check your email.",
      });
      setStep("verify");
    } catch (error) {
      setFeedback({ tone: "error", message: getRecoveryErrorMessage(error) });
    } finally {
      setProcessing(false);
    }
  };

  const handleResendOtp = async () => {
    if (cooldown > 0 || resending) return;

    try {
      setResending(true);
      setFeedback({ tone: "", message: "" });
      const { error } = await sendRecoveryCode();
      if (error) throw error;

      setCooldown(60);
      setFeedback({
        tone: "success",
        message: "A new verification code was sent. Check your email.",
      });
    } catch (error) {
      setFeedback({ tone: "error", message: getRecoveryErrorMessage(error) });
    } finally {
      setResending(false);
    }
  };

  const setOtpFromText = (text, startIndex = 0) => {
    const incomingDigits = text.replace(/\D/g, "").slice(0, 6);
    if (!incomingDigits) return;

    const nextDigits = [...otpDigits];
    incomingDigits.split("").forEach((digit, offset) => {
      const targetIndex = startIndex + offset;
      if (targetIndex < nextDigits.length) nextDigits[targetIndex] = digit;
    });
    setOtpDigits(nextDigits);

    const nextFocusIndex = Math.min(startIndex + incomingDigits.length, 5);
    window.requestAnimationFrame(() => otpInputRefs.current[nextFocusIndex]?.focus());
  };

  const handleOtpChange = (index, value) => {
    const digits = value.replace(/\D/g, "");
    setFeedback({ tone: "", message: "" });

    if (digits.length > 1) {
      setOtpFromText(digits, digits.length === 6 ? 0 : index);
      return;
    }

    const nextDigits = [...otpDigits];
    nextDigits[index] = digits.slice(-1);
    setOtpDigits(nextDigits);

    if (digits && index < 5) {
      otpInputRefs.current[index + 1]?.focus();
    }
  };

  const handleOtpKeyDown = (index, event) => {
    if (event.key === "Backspace") {
      event.preventDefault();
      const nextDigits = [...otpDigits];
      nextDigits[index] = "";
      setOtpDigits(nextDigits);

      if (index > 0) otpInputRefs.current[index - 1]?.focus();
    } else if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      otpInputRefs.current[index - 1]?.focus();
    } else if (event.key === "ArrowRight" && index < 5) {
      event.preventDefault();
      otpInputRefs.current[index + 1]?.focus();
    }
  };

  const handleOtpPaste = (index, event) => {
    const pastedDigits = event.clipboardData.getData("text").replace(/\D/g, "");
    if (!pastedDigits) return;

    event.preventDefault();
    setFeedback({ tone: "", message: "" });
    setOtpFromText(pastedDigits, pastedDigits.length >= 6 ? 0 : index);
  };

  const handleVerifyOtp = async (event) => {
    event.preventDefault();
    const token = otpDigits.join("");

    if (token.length !== 6) {
      setFeedback({ tone: "error", message: "Enter the complete 6-digit verification code." });
      return;
    }

    try {
      setProcessing(true);
      setFeedback({ tone: "", message: "" });
      const { data, error } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token,
        type: "recovery",
      });

      if (error) throw error;
      if (!data.session) throw new Error("Invalid recovery session");

      setOtpDigits(initialOtpDigits);
      setStep("password");
    } catch (error) {
      setFeedback({ tone: "error", message: getRecoveryErrorMessage(error) });
    } finally {
      setProcessing(false);
    }
  };

  const handleUpdatePassword = async (event) => {
    event.preventDefault();

    if (!passwordResult.valid) {
      setFeedback({ tone: "error", message: getPasswordValidationMessage(newPassword) });
      return;
    }

    if (!passwordMatch) {
      setFeedback({ tone: "error", message: "Passwords do not match." });
      return;
    }

    try {
      setProcessing(true);
      setFeedback({ tone: "", message: "" });
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;

      await supabase.auth.signOut();
      setNewPassword("");
      setConfirmPassword("");
      setConfirmInteracted(false);
      setStep("success");
    } catch (error) {
      setFeedback({ tone: "error", message: getRecoveryErrorMessage(error) });
    } finally {
      setProcessing(false);
    }
  };

  const changeEmail = () => {
    setOtpDigits(initialOtpDigits);
    setCooldown(0);
    setFeedback({ tone: "", message: "" });
    setStep("request");
  };

  const content = {
    request: {
      title: "Forgot Password?",
      subtitle: "Enter the email associated with your account and we'll send you a verification code.",
    },
    verify: {
      title: "Verify Your Email",
      subtitle: `We sent a 6-digit verification code to ${maskEmail(email)}.`,
    },
    password: {
      title: "Create New Password",
      subtitle: "Choose a strong password for your Maternal Care account.",
    },
  };

  return (
    <main className="forgot-password-container">
      <section className={`forgot-password-card${step === "success" ? " is-success" : ""}`}>
        <div className="forgot-password-brand" aria-label="Maternal Care">
          <span className="forgot-password-brand-mark" aria-hidden="true">
            <MaternalCareLogo decorative />
          </span>
          <strong>Maternal Care</strong>
        </div>

        {step !== "success" ? (
          <ol className="forgot-password-progress" aria-label="Password recovery progress">
            {recoverySteps.map((item, index) => {
              const completed = index < activeStepIndex;
              const active = index === activeStepIndex;

              return (
                <li
                  className={`${active ? "is-active" : ""}${completed ? " is-complete" : ""}`.trim()}
                  key={item.key}
                  aria-current={active ? "step" : undefined}
                >
                  <span>
                    {completed ? <Icon icon="solar:check-read-linear" /> : index + 1}
                  </span>
                  <small>{item.label}</small>
                </li>
              );
            })}
          </ol>
        ) : null}

        {step === "success" ? (
          <div className="forgot-password-success-state">
            <span className="forgot-password-success-icon">
              <Icon icon="solar:check-circle-bold-duotone" aria-hidden="true" />
            </span>
            <h1>Password Updated</h1>
            <p>
              Your password has been changed successfully. You can now sign in using your new password.
            </p>
            <button type="button" className="forgot-password-primary" onClick={() => navigate("/login")}>
              Back to Login
            </button>
          </div>
        ) : (
          <>
            <header className="forgot-password-heading">
              <h1>{content[step].title}</h1>
              <p>{content[step].subtitle}</p>
            </header>

            <Feedback tone={feedback.tone}>{feedback.message}</Feedback>

            {step === "request" ? (
              <form className="forgot-password-form" onSubmit={handleSendOtp} noValidate>
                <label className="forgot-password-field" htmlFor="recovery-email">
                  <span>Email Address</span>
                  <div className="forgot-password-input-wrap">
                    <Icon icon="solar:letter-linear" aria-hidden="true" />
                    <input
                      id="recovery-email"
                      type="email"
                      value={email}
                      autoComplete="email"
                      placeholder="Enter your email"
                      onChange={(event) => {
                        setEmail(event.target.value);
                        setFeedback({ tone: "", message: "" });
                      }}
                      disabled={processing}
                      required
                    />
                  </div>
                </label>

                <button type="submit" className="forgot-password-primary" disabled={processing}>
                  {processing ? (
                    <><Icon className="is-spinning" icon="solar:refresh-circle-linear" /> Sending...</>
                  ) : (
                    "Send Verification Code"
                  )}
                </button>

                <p className="forgot-password-login-prompt">
                  <span>Remember your password?</span>{" "}
                  <Link to="/login">Log in</Link>
                </p>
              </form>
            ) : null}

            {step === "verify" ? (
              <form className="forgot-password-form" onSubmit={handleVerifyOtp}>
                <fieldset className="forgot-password-otp-fieldset" disabled={processing}>
                  <legend>Verification code</legend>
                  <div className="forgot-password-otp-row">
                    {otpDigits.map((digit, index) => (
                      <input
                        key={index}
                        ref={(element) => { otpInputRefs.current[index] = element; }}
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={1}
                        value={digit}
                        autoComplete={index === 0 ? "one-time-code" : "off"}
                        aria-label={`Verification code digit ${index + 1}`}
                        onChange={(event) => handleOtpChange(index, event.target.value)}
                        onKeyDown={(event) => handleOtpKeyDown(index, event)}
                        onPaste={(event) => handleOtpPaste(index, event)}
                        onFocus={(event) => event.target.select()}
                      />
                    ))}
                  </div>
                </fieldset>

                <button
                  type="submit"
                  className="forgot-password-primary"
                  disabled={processing || otpDigits.some((digit) => !digit)}
                >
                  {processing ? (
                    <><Icon className="is-spinning" icon="solar:refresh-circle-linear" /> Verifying...</>
                  ) : (
                    "Verify Code"
                  )}
                </button>

                <div className="forgot-password-resend-row">
                  <span>Didn&apos;t receive the code?</span>
                  <button
                    type="button"
                    onClick={handleResendOtp}
                    disabled={cooldown > 0 || resending || processing}
                  >
                    {resending
                      ? "Sending..."
                      : cooldown > 0
                        ? `Resend code in ${cooldown}s`
                        : "Resend Code"}
                  </button>
                </div>

                <button type="button" className="forgot-password-text-button" onClick={changeEmail}>
                  Change email
                </button>
              </form>
            ) : null}

            {step === "password" ? (
              <form className="forgot-password-form" onSubmit={handleUpdatePassword}>
                <PasswordField
                  id="recovery-new-password"
                  label="New Password"
                  value={newPassword}
                  visible={newPasswordVisible}
                  onChange={(event) => {
                    setNewPassword(event.target.value);
                    setFeedback({ tone: "", message: "" });
                  }}
                  onToggle={() => setNewPasswordVisible((visible) => !visible)}
                  autoComplete="new-password"
                  disabled={processing}
                />

                <PasswordField
                  id="recovery-confirm-password"
                  label="Confirm New Password"
                  value={confirmPassword}
                  visible={confirmPasswordVisible}
                  onChange={(event) => {
                    setConfirmPassword(event.target.value);
                    setConfirmInteracted(true);
                    setFeedback({ tone: "", message: "" });
                  }}
                  onToggle={() => setConfirmPasswordVisible((visible) => !visible)}
                  autoComplete="new-password"
                  disabled={processing}
                />

                <PasswordSecurityFeedback
                  password={newPassword}
                  confirmPassword={confirmPassword}
                  confirmInteracted={confirmInteracted}
                />

                <button
                  type="submit"
                  className="forgot-password-primary"
                  disabled={processing || !passwordResult.valid || !passwordMatch}
                >
                  {processing ? (
                    <><Icon className="is-spinning" icon="solar:refresh-circle-linear" /> Updating...</>
                  ) : (
                    "Update Password"
                  )}
                </button>
              </form>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}

export default ForgotPassword;
