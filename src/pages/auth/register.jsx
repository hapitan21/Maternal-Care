import { useState } from "react";
import { Icon } from "@iconify/react";
import { Link, useNavigate } from "react-router-dom";
import PasswordSecurityFeedback from "../../components/common/PasswordSecurityFeedback";
import {
  getPasswordValidationMessage,
  PASSWORD_MIN_LENGTH,
  passwordsMatch,
  validatePassword,
} from "../../lib/passwordSecurity";
import { supabase } from "../../lib/supabaseClient";
import "../../styles/register.css";

function Register() {
  const navigate = useNavigate();

  const [form, setForm] = useState({
    fullName: "",
    email: "",
    dateOfBirth: "",
    age: "",
    address: "",
    civilStatus: "",
    contactNumber: "",
    password: "",
    confirmPassword: "",
  });
  const [passwordVisible, setPasswordVisible] = useState({
    password: false,
    confirmPassword: false,
  });
  const [confirmInteracted, setConfirmInteracted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const passwordResult = validatePassword(form.password);
  const passwordMatch = passwordsMatch(form.password, form.confirmPassword);
  const canSubmit = passwordResult.valid && passwordMatch && !isSubmitting;

  const handleChange = (e) => {
    const { name, value } = e.target;
    if (name === "confirmPassword") setConfirmInteracted(true);
    setForm((current) => ({
      ...current,
      [name]: value,
    }));
  };

  const handleRegister = async (e) => {
    e.preventDefault();

    if (isSubmitting) return;

    if (!passwordResult.valid) {
      alert(getPasswordValidationMessage(form.password));
      return;
    }

    if (!passwordMatch) {
      alert("Passwords do not match.");
      return;
    }

    setIsSubmitting(true);

    try {
      const { data, error } = await supabase.auth.signUp({
        email: form.email,
        password: form.password,
        options: {
          data: {
            full_name: form.fullName,
            date_of_birth: form.dateOfBirth,
            age: form.age,
            address: form.address,
            civil_status: form.civilStatus,
            contact_number: form.contactNumber,
          },
        },
      });

      if (error) {
        alert(error.message);
        return;
      }

      const user = data.user;

      if (user) {
        const profilePayload = {
          id: user.id,
          full_name: form.fullName,
          email: form.email,
          role: "patient",
          date_of_birth: form.dateOfBirth || null,
          age: form.age ? Number(form.age) : null,
          address: form.address || null,
          civil_status: form.civilStatus || null,
          contact_number: form.contactNumber || null,
        };

        const { error: profileError } = await supabase.from("profiles").insert([
          profilePayload,
        ]);

        if (profileError) {
          const { error: fallbackError } = await supabase.from("profiles").insert([
            {
              id: user.id,
              full_name: form.fullName,
              email: form.email,
              role: "patient",
            },
          ]);

          if (fallbackError) {
            alert(fallbackError.message);
            return;
          }
        }

        await supabase.from("patients").insert([
          {
            full_name: form.fullName,
            date_of_birth: form.dateOfBirth || null,
            age: form.age ? Number(form.age) : null,
            address: form.address || null,
            contact_number: form.contactNumber || null,
            status: "Active",
          },
        ]);
      }

      alert("Registration successful!");
      navigate("/");
    } catch (error) {
      alert(error?.message || "Unable to complete registration. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="register-container">
      <form className="register-card" onSubmit={handleRegister}>
        <h1 className="register-title">Maternal Care</h1>

        <p className="register-subtitle">Create your account</p>

        <div className="register-grid">
          <input
            type="text"
            name="fullName"
            placeholder="Full Name"
            className="register-input"
            value={form.fullName}
            onChange={handleChange}
            required
          />

          <input
            type="email"
            name="email"
            placeholder="Email"
            className="register-input"
            value={form.email}
            onChange={handleChange}
            required
          />

          <input
            type="date"
            name="dateOfBirth"
            placeholder="Date of Birth"
            className="register-input"
            value={form.dateOfBirth}
            onChange={handleChange}
            required
          />

          <input
            type="number"
            name="age"
            placeholder="Age"
            className="register-input"
            min="1"
            value={form.age}
            onChange={handleChange}
            required
          />

          <input
            type="text"
            name="address"
            placeholder="Address"
            className="register-input register-input--wide"
            value={form.address}
            onChange={handleChange}
            required
          />

          <select
            name="civilStatus"
            className="register-input"
            value={form.civilStatus}
            onChange={handleChange}
            required
          >
            <option value="">Civil Status</option>
            <option value="Single">Single</option>
            <option value="Married">Married</option>
            <option value="Widowed">Widowed</option>
            <option value="Separated">Separated</option>
          </select>

          <input
            type="text"
            name="contactNumber"
            placeholder="Contact Number"
            className="register-input"
            value={form.contactNumber}
            onChange={handleChange}
            required
          />

          {["password", "confirmPassword"].map((field) => {
            const label = field === "password" ? "Password" : "Confirm Password";
            return (
              <label className="register-password-field" key={field}>
                <span>{label}</span>
                <div>
                  <input
                    type={passwordVisible[field] ? "text" : "password"}
                    name={field}
                    placeholder={label}
                    className="register-input"
                    value={form[field]}
                    onChange={handleChange}
                    onBlur={() => {
                      if (field === "confirmPassword") setConfirmInteracted(true);
                    }}
                    autoComplete="new-password"
                    minLength={PASSWORD_MIN_LENGTH}
                    required
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setPasswordVisible((current) => ({
                        ...current,
                        [field]: !current[field],
                      }))
                    }
                    aria-label={`${passwordVisible[field] ? "Hide" : "Show"} ${label.toLowerCase()}`}
                    aria-pressed={passwordVisible[field]}
                  >
                    <Icon
                      icon={passwordVisible[field] ? "solar:eye-closed-linear" : "solar:eye-linear"}
                      aria-hidden="true"
                    />
                  </button>
                </div>
              </label>
            );
          })}

          <PasswordSecurityFeedback
            className="register-password-security"
            password={form.password}
            confirmPassword={form.confirmPassword}
            confirmInteracted={confirmInteracted}
          />
        </div>

        <button type="submit" className="register-btn" disabled={!canSubmit}>
          {isSubmitting ? "Registering..." : "Register"}
        </button>

        <p className="login-text">
          Already have an account?{" "}
          <Link to="/" style={{ color: "#ff4d73" }}>
            Login here
          </Link>
        </p>
      </form>
    </div>
  );
}

export default Register;
