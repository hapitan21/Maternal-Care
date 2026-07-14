import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((current) => ({
      ...current,
      [name]: value,
    }));
  };

  const handleRegister = async (e) => {
    e.preventDefault();

    if (form.password !== form.confirmPassword) {
      alert("Passwords do not match.");
      return;
    }

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

          <input
            type="password"
            name="password"
            placeholder="Password"
            className="register-input"
            value={form.password}
            onChange={handleChange}
            required
          />

          <input
            type="password"
            name="confirmPassword"
            placeholder="Confirm Password"
            className="register-input"
            value={form.confirmPassword}
            onChange={handleChange}
            required
          />
        </div>

        <button type="submit" className="register-btn">
          Register
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
