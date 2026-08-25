import { Component, useEffect, useState } from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";

import Login from "./pages/auth/login";
import ForgotPassword from "./pages/auth/forgot-password";

import AdminDashboard from "./pages/admin/AdminDashboard";
import AdminAppointmentOverview from "./pages/admin/AdminAppointmentOverview";
import AdminAuditLogs from "./pages/admin/AdminAuditLogs";
import AdminFollowUps from "./pages/admin/Admin_FollowUps";
import AdminReports, {
  AdminAppointmentSummaryReport,
  AdminPatientSummaryReport,
  AdminRegistrationAppointmentTrendsReport,
} from "./pages/admin/AdminReports";
import AdminUserManagement from "./pages/admin/AdminUserManagement";
import AdminPatientProfile from "./pages/admin/AdminPatientProfile";
import AdminUserDetails from "./pages/admin/AdminUserDetails";
import AdminNotFound from "./pages/admin/AdminNotFound";
import AdminPlaceholderPage from "./pages/admin/AdminPlaceholderPage";
import AdminSystemSettings from "./pages/admin/AdminSystemSettings";
import AdminLayout from "./components/admin/AdminLayout";
import { AdminAuthProvider } from "./context/AdminAuthContext.jsx";

import DoctorDashboard from "./pages/doctor/Doctor_Dashboard";

import PatientAccess from "./pages/patient/Patient_Access";
import PatientCreateAccount from "./pages/patient/Patient_CreateAccount";
import PatientLogin from "./pages/patient/Patient_Login";
import PatientPWA from "./pages/patient/Patient_PWA";

import StaffDashboard from "./pages/staff/StaffDashboard";

import { useAuthenticatedStaff } from "./hooks/useAuthenticatedStaff";
import { useDoctorRouteAuthorization } from "./hooks/useDoctorRouteAuthorization";


/* ============================================================
   DOCTOR ERROR BOUNDARY
   ============================================================ */

class DoctorErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Doctor page crashed:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="doctor-error-fallback" role="alert">
          <h1>Doctor page could not load</h1>

          <p>
            The Doctor workspace hit a runtime error. Refresh the page or return
            to the dashboard.
          </p>

          {import.meta.env.DEV ? (
            <pre>{this.state.error.message}</pre>
          ) : null}

          <a href="/doctor/dashboard">Open Doctor Dashboard</a>
        </main>
      );
    }

    return this.props.children;
  }
}


/* ============================================================
   PATIENT ERROR BOUNDARY
   ============================================================ */

class PatientErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Patient application crashed:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="patient-error-fallback" role="alert">
          <section>
            <h1>Unable to open the Patient application.</h1>

            <p>The Patient workspace hit a runtime error.</p>

            {import.meta.env.DEV ? (
              <pre>{this.state.error.message}</pre>
            ) : null}

            <div>
              <button
                type="button"
                onClick={() => window.location.reload()}
              >
                Reload
              </button>

              <a href="/patient/login">
                Return to Patient Login
              </a>
            </div>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}


/* ============================================================
   DOCTOR ROUTE
   ============================================================ */

function DoctorRoute() {
  const doctorAccess = useDoctorRouteAuthorization();

  /*
   * Remember the last Doctor that completed authorization successfully.
   *
   * During short background authorization checks caused by browser focus,
   * tab switching, screenshots, token refresh, etc., we keep the Doctor
   * workspace mounted instead of replacing it with a loading screen.
   */
  const [lastAuthorizedDoctorId, setLastAuthorizedDoctorId] = useState(null);

  useEffect(() => {
    if (
      !doctorAccess.loading &&
      doctorAccess.authorized &&
      doctorAccess.user?.id
    ) {
      setLastAuthorizedDoctorId((current) =>
        current === doctorAccess.user.id
          ? current
          : doctorAccess.user.id
      );

      return;
    }

    /*
     * Only clear remembered authorization after the authorization check
     * has actually finished and the Doctor is no longer authorized.
     */
    if (!doctorAccess.loading && !doctorAccess.authorized) {
      setLastAuthorizedDoctorId(null);
    }
  }, [
    doctorAccess.loading,
    doctorAccess.authorized,
    doctorAccess.user?.id,
  ]);

  /*
   * Prefer the currently authorized user. During a temporary background
   * revalidation where user may briefly be unavailable, keep using the
   * last successfully-authorized Doctor ID.
   */
  const effectiveDoctorId =
    doctorAccess.user?.id ||
    lastAuthorizedDoctorId;

  /*
   * Initial login / first page load:
   * no Doctor has been successfully authorized yet.
   */
  if (doctorAccess.loading && !effectiveDoctorId) {
    return (
      <main
        className="admin-auth-state"
        role="status"
        aria-live="polite"
      >
        <p>Checking Doctor account access...</p>
      </main>
    );
  }

  /*
   * Authorization has finished and failed.
   * Keep the existing secure redirect behavior.
   */
  if (!doctorAccess.loading && !doctorAccess.authorized) {
    return (
      <Navigate
        to={doctorAccess.redirectTo || "/login"}
        replace
      />
    );
  }

  /*
   * Safety fallback: never mount the Doctor workspace without a known
   * successfully-authorized Doctor ID.
   */
  if (!effectiveDoctorId) {
    return (
      <main
        className="admin-auth-state"
        role="status"
        aria-live="polite"
      >
        <p>Checking Doctor account access...</p>
      </main>
    );
  }

  /*
   * Keep DoctorDashboard mounted during temporary background
   * authorization/revalidation checks.
   */
  return (
    <DoctorErrorBoundary>
      <DoctorDashboard key={effectiveDoctorId} />
    </DoctorErrorBoundary>
  );
}


/* ============================================================
   PATIENT ROUTE
   ============================================================ */

function PatientRoute() {
  return (
    <PatientErrorBoundary>
      <PatientPWA />
    </PatientErrorBoundary>
  );
}


/* ============================================================
   STAFF ROUTE
   ============================================================ */

function StaffRoute() {
  const location = useLocation();
  const staffAccess = useAuthenticatedStaff();

  /*
   * Remember whether this mounted StaffRoute has already completed
   * a successful Staff authorization check.
   *
   * Supabase can briefly revalidate the session when the browser tab
   * regains focus, after taking a screenshot, or during token refresh.
   * During that short background check, keep StaffDashboard mounted
   * instead of replacing it with "Checking Staff account access...".
   */
  const [hasAuthorizedStaff, setHasAuthorizedStaff] = useState(false);

  useEffect(() => {
    if (!staffAccess.loading && !staffAccess.error) {
      setHasAuthorizedStaff(true);
      return;
    }

    /*
     * Only forget the previously-authorized Staff session after
     * revalidation has actually completed with an error.
     */
    if (!staffAccess.loading && staffAccess.error) {
      setHasAuthorizedStaff(false);
    }
  }, [staffAccess.loading, staffAccess.error]);

  /*
   * Initial login / direct first load:
   * show the authorization screen only before Staff has ever passed
   * authorization in this mounted route.
   */
  if (staffAccess.loading && !hasAuthorizedStaff) {
    return (
      <main
        className="admin-auth-state"
        role="status"
        aria-live="polite"
      >
        <p>Checking Staff account access...</p>
      </main>
    );
  }

  /*
   * Redirect only after the authorization check has finished.
   * Never redirect from a temporary loading/revalidation state.
   */
  if (!staffAccess.loading && staffAccess.error) {
    if (staffAccess.error.code === "staff_account_inactive") {
      return (
        <Navigate
          to="/login?reason=staff_inactive"
          replace
        />
      );
    }

    if (staffAccess.error.code === "staff_role_mismatch") {
      const roleRoute = {
        admin: "/admin",
        doctor: "/doctor",
        patient: "/patient",
      }[staffAccess.error.role];

      return (
        <Navigate
          to={roleRoute || "/login"}
          replace
        />
      );
    }

    return (
      <Navigate
        to={`/login?next=${encodeURIComponent(location.pathname)}`}
        replace
      />
    );
  }

  /*
   * Safety fallback for the very first unresolved render only.
   * After successful authorization, StaffDashboard stays mounted while
   * Supabase performs background revalidation.
   */
  if (!hasAuthorizedStaff && staffAccess.loading) {
    return (
      <main
        className="admin-auth-state"
        role="status"
        aria-live="polite"
      >
        <p>Checking Staff account access...</p>
      </main>
    );
  }

  return <StaffDashboard />;
}


/* ============================================================
   ADMIN REDIRECT
   ============================================================ */

function AdminRedirect({ to }) {
  const location = useLocation();

  return (
    <Navigate
      to={{
        pathname: to,
        search: location.search,
        hash: location.hash,
      }}
      replace
    />
  );
}


/* ============================================================
   APPLICATION
   ============================================================ */

function App() {
  return (
    <BrowserRouter>
      <Routes>

        {/* =====================================================
            AUTH
            ===================================================== */}

        <Route
          path="/"
          element={<Login />}
        />

        <Route
          path="/login"
          element={<Login />}
        />

        <Route
          path="/forgot-password"
          element={<ForgotPassword />}
        />


        {/* =====================================================
            ADMIN
            ===================================================== */}

        <Route
          path="/admin"
          element={
            <AdminAuthProvider>
              <AdminLayout />
            </AdminAuthProvider>
          }
        >
          <Route
            index
            element={<AdminRedirect to="/admin/dashboard" />}
          />

          <Route
            path="dashboard"
            element={<AdminDashboard />}
          />

          <Route
            path="user-management"
            element={<AdminUserManagement />}
          />

          <Route
            path="user-management/patient/:id"
            element={<AdminPatientProfile />}
          />

          <Route
            path="user-management/doctor/:id"
            element={<AdminUserDetails userType="doctor" />}
          />

          <Route
            path="user-management/staff/:id"
            element={<AdminUserDetails userType="staff" />}
          />

          <Route
            path="users"
            element={
              <AdminRedirect to="/admin/user-management" />
            }
          />

          <Route
            path="appointment-overview"
            element={<AdminAppointmentOverview />}
          />

          <Route
            path="appointments"
            element={
              <AdminRedirect to="/admin/appointment-overview" />
            }
          />

          <Route
            path="follow-ups"
            element={<AdminFollowUps />}
          />

          <Route
            path="reports"
            element={<AdminReports />}
          />

          <Route
            path="reports/appointment-summary"
            element={<AdminAppointmentSummaryReport />}
          />

          <Route
            path="reports/patient-summary"
            element={<AdminPatientSummaryReport />}
          />

          <Route
            path="reports/doctor-appointments"
            element={
              <AdminRedirect to="/admin/reports/appointment-summary" />
            }
          />

          <Route
            path="reports/monthly-trends"
            element={<AdminRegistrationAppointmentTrendsReport />}
          />

          <Route
            path="audit-logs"
            element={<AdminAuditLogs />}
          />

          <Route
            path="logs"
            element={
              <AdminRedirect to="/admin/audit-logs" />
            }
          />

          <Route
            path="system-settings"
            element={<AdminSystemSettings />}
          />

          <Route
            path="settings"
            element={
              <AdminRedirect to="/admin/system-settings" />
            }
          />

          <Route
            path="profile"
            element={<AdminPlaceholderPage page="profile" />}
          />

          <Route
            path="*"
            element={<AdminNotFound />}
          />
        </Route>


        {/* =====================================================
            DOCTOR
            ===================================================== */}

        <Route
          path="/doctor"
          element={<DoctorRoute />}
        />

        <Route
          path="/doctor/dashboard"
          element={<DoctorRoute />}
        />

        <Route
          path="/doctor/patients"
          element={<DoctorRoute />}
        />

        <Route
          path="/doctor/appointments"
          element={<DoctorRoute />}
        />

        <Route
          path="/doctor/appointments/:appointmentId/initial-visit"
          element={<DoctorRoute />}
        />

        <Route
          path="/doctor/appointments/:appointmentId/follow-up"
          element={<DoctorRoute />}
        />

        <Route
          path="/doctor/reminders"
          element={<DoctorRoute />}
        />

        <Route
          path="/doctor/follow-ups"
          element={<DoctorRoute />}
        />

        <Route
          path="/doctor/profile"
          element={<DoctorRoute />}
        />

        <Route
          path="/doctor/settings"
          element={<DoctorRoute />}
        />

        <Route
          path="/doctor/*"
          element={<DoctorRoute />}
        />


        {/* =====================================================
            STAFF
            ===================================================== */}

        <Route
          path="/staff"
          element={<StaffRoute />}
        />

        <Route
          path="/staff/patients"
          element={<StaffRoute />}
        />

        <Route
          path="/staff/patients/new"
          element={<StaffRoute />}
        />

        <Route
          path="/staff/patients/new/select-slot"
          element={<StaffRoute />}
        />

        <Route
          path="/staff/patients/new/register"
          element={<StaffRoute />}
        />

        <Route
          path="/staff/patients/:patientId"
          element={<StaffRoute />}
        />

        <Route
          path="/staff/appointments"
          element={<StaffRoute />}
        />

        <Route
          path="/staff/appointments/:appointmentId/initial-visit"
          element={<StaffRoute />}
        />

        <Route
          path="/staff/appointments/:appointmentId/follow-up"
          element={<StaffRoute />}
        />

        <Route
          path="/staff/reminders"
          element={<StaffRoute />}
        />

        <Route
          path="/staff/profile"
          element={<StaffRoute />}
        />

        <Route
          path="/staff/settings"
          element={<StaffRoute />}
        />

        <Route
          path="/staff/*"
          element={<StaffRoute />}
        />


        {/* =====================================================
            PATIENT
            ===================================================== */}

        <Route
          path="/patient/access"
          element={<PatientAccess />}
        />

        <Route
          path="/patient/create-account"
          element={<PatientCreateAccount />}
        />

        <Route
          path="/patient/login"
          element={<PatientLogin />}
        />

        <Route
          path="/patient"
          element={<PatientRoute />}
        />

        <Route
          path="/patient/*"
          element={<PatientRoute />}
        />

      </Routes>
    </BrowserRouter>
  );
}

export default App;
