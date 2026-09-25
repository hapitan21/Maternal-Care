import { Component, lazy, Suspense } from "react";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";

import Login from "./pages/auth/login";
import ForgotPassword from "./pages/auth/forgot-password";

import { AdminAuthProvider } from "./context/AdminAuthContext.jsx";

import { useAuthenticatedStaff } from "./hooks/useAuthenticatedStaff";
import { useDoctorRouteAuthorization } from "./hooks/useDoctorRouteAuthorization";

const AdminLayout = lazy(() => import("./components/admin/AdminLayout"));
const AdminDashboard = lazy(() => import("./pages/admin/AdminDashboard"));
const AdminAppointmentOverview = lazy(() =>
  import("./pages/admin/AdminAppointmentOverview")
);
const AdminAuditLogs = lazy(() => import("./pages/admin/AdminAuditLogs"));
const AdminReports = lazy(() => import("./pages/admin/AdminReports"));
const AdminAppointmentSummaryReport = lazy(() =>
  import("./pages/admin/AdminReports").then((module) => ({
    default: module.AdminAppointmentSummaryReport,
  }))
);
const AdminPatientSummaryReport = lazy(() =>
  import("./pages/admin/AdminReports").then((module) => ({
    default: module.AdminPatientSummaryReport,
  }))
);
const AdminRegistrationAppointmentTrendsReport = lazy(() =>
  import("./pages/admin/AdminReports").then((module) => ({
    default: module.AdminRegistrationAppointmentTrendsReport,
  }))
);
const AdminUserManagement = lazy(() =>
  import("./pages/admin/AdminUserManagement")
);
const AdminPatientProfile = lazy(() =>
  import("./pages/admin/AdminPatientProfile")
);
const AdminUserDetails = lazy(() => import("./pages/admin/AdminUserDetails"));
const AdminNotFound = lazy(() => import("./pages/admin/AdminNotFound"));
const AdminProfile = lazy(() => import("./pages/admin/AdminProfile"));
const AdminSystemSettings = lazy(() =>
  import("./pages/admin/AdminSystemSettings")
);

const DoctorDashboard = lazy(() => import("./pages/doctor/Doctor_Dashboard"));
const StaffDashboard = lazy(() => import("./pages/staff/StaffDashboard"));
const PatientAccess = lazy(() => import("./pages/patient/Patient_Access"));
const PatientCreateAccount = lazy(() =>
  import("./pages/patient/Patient_CreateAccount")
);
const PatientLogin = lazy(() => import("./pages/patient/Patient_Login"));
const PatientPWA = lazy(() => import("./pages/patient/Patient_PWA"));


function RouteLoadingFallback() {
  return (
    <main className="app-route-loading" role="status" aria-live="polite">
      <span aria-hidden="true" />
      <p>Loading your workspace...</p>
    </main>
  );
}

function DoctorAuthorizationLoadingFallback() {
  return (
    <main className="app-route-loading" role="status" aria-live="polite">
      <span aria-hidden="true" />
      <p>Checking Doctor account access...</p>
    </main>
  );
}

function ApplicationNotFound() {
  return (
    <main className="app-error-fallback app-not-found">
      <section>
        <span aria-hidden="true">?</span>
        <h1>Page not found</h1>
        <p>The page you opened does not exist or is no longer available.</p>
        <div>
          <Link to="/login">Return to login</Link>
        </div>
      </section>
    </main>
  );
}


class ApplicationErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Application route failed to load:", error, info);
  }

  componentDidUpdate(prevProps) {
    if (
      this.state.error &&
      prevProps.resetKey !== this.props.resetKey
    ) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <main className="app-error-fallback" role="alert">
          <section>
            <span aria-hidden="true">!</span>
            <h1>We could not open this workspace</h1>
            <p>
              Check your connection and try loading the page again. Your saved
              information has not been changed.
            </p>
            {import.meta.env.DEV ? <pre>{this.state.error.message}</pre> : null}
            <div>
              <button type="button" onClick={() => window.location.reload()}>
                Try again
              </button>
              <a href="/login">Return to login</a>
            </div>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

function RouteAwareApplicationErrorBoundary({ children }) {
  const location = useLocation();
  const routeKey = `${location.pathname}${location.search}`;

  return (
    <ApplicationErrorBoundary resetKey={routeKey}>
      {children}
    </ApplicationErrorBoundary>
  );
}


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
   * Initial login / first page load:
   * no Doctor has been successfully authorized yet.
   */
  if (doctorAccess.loading && !doctorAccess.authorized) {
    return <DoctorAuthorizationLoadingFallback />;
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
  if (!doctorAccess.user?.id) {
    return <DoctorAuthorizationLoadingFallback />;
  }

  /*
   * Keep DoctorDashboard mounted during temporary background
   * authorization/revalidation checks.
   */
  return (
    <DoctorErrorBoundary>
      <DoctorDashboard key={doctorAccess.user.id} />
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
   * Initial login / direct first load:
   * show the authorization screen only before Staff has ever passed
   * authorization in this mounted route.
   */
  if (staffAccess.loading && !staffAccess.identity) {
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
  if (!staffAccess.identity) {
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

  return (
    <StaffDashboard
      key={staffAccess.identity.authUser.id}
      staffIdentity={staffAccess.identity}
    />
  );
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
      <RouteAwareApplicationErrorBoundary>
        <Suspense fallback={<RouteLoadingFallback />}>
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
            element={<AdminProfile />}
          />

          <Route
            path="*"
            element={<AdminNotFound />}
          />
        </Route>


        {/* =====================================================
            DOCTOR
            ===================================================== */}

        {/*
         * Keep the Doctor workspace on one persistent route branch.
         * Doctor_Dashboard already reads location.pathname/search and
         * renders the correct internal section, so separate sibling
         * routes only create unnecessary remount opportunities.
         */}
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

        <Route
          path="*"
          element={<ApplicationNotFound />}
        />

          </Routes>
        </Suspense>
      </RouteAwareApplicationErrorBoundary>
    </BrowserRouter>
  );
}

export default App;
