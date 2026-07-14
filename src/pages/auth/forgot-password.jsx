import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import "../../styles/forgot-password.css";

function ForgotPassword() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [step, setStep] = useState("request");
  const [cooldown, setCooldown] = useState(0);

  React.useEffect(() => {
    if (cooldown <= 0) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setCooldown((current) => current - 1);
    }, 1000);

    return () => window.clearTimeout(timer);
  }, [cooldown]);

  React.useEffect(() => {
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const isRecoveryLink = hashParams.get("type") === "recovery";

    const applyRecoveryState = async () => {
      if (!isRecoveryLink) {
        return;
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();

      setEmail(session?.user?.email ?? "");
      setStep("recovery");
    };

    applyRecoveryState();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event !== "PASSWORD_RECOVERY") {
        return;
      }

      setEmail(session?.user?.email ?? "");
      setStep("recovery");
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const recoveryRedirectTo = React.useMemo(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    return new URL("/forgot-password", window.location.origin).toString();
  }, []);

  const handleSendOtp = async (e) => {
    e.preventDefault();

    if (!email) {
      alert("Enter your email first.");
      return;
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: recoveryRedirectTo,
    });

    if (error) {
      alert(error.message);
      return;
    }

    setStep("verify");
    setCooldown(60);
    alert("Recovery email sent. Use the 6-digit code if shown in the email, or open the reset link to continue here.");
  };

  const handleResendOtp = async () => {
    if (!email) {
      alert("Enter your email first.");
      return;
    }

    if (cooldown > 0) {
      return;
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: recoveryRedirectTo,
    });

    if (error) {
      alert(error.message);
      return;
    }

    setCooldown(60);
    alert("Recovery email sent again.");
  };

  const handleUpdatePassword = async (e) => {
    e.preventDefault();

    if (!newPassword) {
      alert("Enter your new password.");
      return;
    }

    if (step === "verify") {
      if (!email || !otp) {
        alert("Complete the email, OTP, and new password fields.");
        return;
      }

      const { error: verifyError } = await supabase.auth.verifyOtp({
        email,
        token: otp,
        type: "recovery",
      });

      if (verifyError) {
        alert(verifyError.message);
        return;
      }
    }

    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (updateError) {
      alert(updateError.message);
      return;
    }

    await supabase.auth.signOut();
    alert("Password updated successfully. You can now log in.");
    navigate("/login");
  };

  return (
    <div className="forgot-password-container">
      <form className="forgot-password-card" onSubmit={step === "request" ? handleSendOtp : handleUpdatePassword}>
        <h1 className="forgot-password-title">Maternal Care</h1>
        <p className="forgot-password-subtitle">
          {step === "request"
            ? "Reset your password"
            : step === "recovery"
              ? "Set your new password"
              : "Enter your OTP and new password"}
        </p>

        <input
          type="email"
          placeholder="Email"
          className="forgot-password-input forgot-password-input--email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        {step !== "request" ? (
          <>
            {step === "verify" ? (
              <input
                type="text"
                placeholder="OTP Code"
                className="forgot-password-input forgot-password-input--otp"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                required
              />
            ) : null}

            <input
              type="password"
              placeholder="New Password"
              className="forgot-password-input forgot-password-input--password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />

            {step === "verify" ? (
              <div className="forgot-password-resend-row">
                <span className="forgot-password-resend-text">
                  Didn&apos;t receive the code?
                </span>
                <button
                  type="button"
                  className="forgot-password-resend-btn"
                  onClick={handleResendOtp}
                  disabled={cooldown > 0}
                >
                  {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
                </button>
              </div>
            ) : null}
          </>
        ) : null}

        <button type="submit" className="forgot-password-btn">
          {step === "request" ? "Send OTP" : "Update Password"}
        </button>

        <p className="forgot-password-footer">
          <Link to="/login">Back to login</Link>
        </p>
      </form>
    </div>
  );
}

export default ForgotPassword;
