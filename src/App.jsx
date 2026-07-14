import { BrowserRouter, Route, Routes } from "react-router-dom";

import Login from "./pages/auth/login";
import ForgotPassword from "./pages/auth/forgot-password";

import AdminDashboard from "./pages/admin/AdminDashboard";
import DoctorDashboard from "./pages/doctor/Doctor_Dashboard";
import PatientAccess from "./pages/patient/Patient_Access";
import PatientPWA from "./pages/patient/Patient_PWA";
import StaffDashboard from "./pages/staff/StaffDashboard";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Login />} />
        <Route path="/login" element={<Login />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />

        <Route path="/admin" element={<AdminDashboard />} />
        <Route path="/doctor" element={<DoctorDashboard />} />
        <Route path="/doctor/profile" element={<DoctorDashboard />} />
        <Route path="/doctor/settings" element={<DoctorDashboard />} />
        <Route path="/doctor/appointments" element={<DoctorDashboard />} />
        <Route path="/staff" element={<StaffDashboard />} />
        <Route path="/staff/patients" element={<StaffDashboard />} />
        <Route path="/staff/patients/:patientId" element={<StaffDashboard />} />
        <Route path="/staff/appointments" element={<StaffDashboard />} />
        <Route path="/staff/reminders" element={<StaffDashboard />} />
        <Route path="/staff/profile" element={<StaffDashboard />} />
        <Route path="/staff/settings" element={<StaffDashboard />} />
         <Route
          path="/staff/*"
          element={<StaffDashboard />}
        />
        <Route path="/patient/access" element={<PatientAccess />} />
        <Route path="/patient/*" element={<PatientPWA />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
