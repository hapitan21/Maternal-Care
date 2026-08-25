import React from "react";
import { Icon } from "@iconify/react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAdminAuth } from "../../hooks/useAdminAuth";
import AdminPageState from "./AdminPageState";
import AdminProfileDropdown from "./AdminProfileDropdown";
import AdminSidebar from "./AdminSidebar";
import "../../styles/adminLayout.css";

const roleRoutes = { doctor: "/doctor", staff: "/staff", patient: "/patient" };
const drawerId = "admin-navigation-drawer";

function getSectionClasses(pathname) {
  if (pathname === "/admin/dashboard") return { shell: "admin-dashboard-shell", main: "admin-dashboard-main" };
  if (pathname.includes("/user-management")) return { shell: "", main: "" };
  if (pathname.includes("/appointment-overview")) return { shell: "admin-appointment-shell", main: "admin-appointment-main" };
  if (pathname.includes("/follow-ups")) return { shell: "admin-followup-shell", main: "admin-followup-main" };
  if (pathname.includes("/reports")) return { shell: "admin-reports-shell", main: "admin-reports-main" };
  if (pathname.includes("/audit-logs")) return { shell: "admin-audit-shell", main: "admin-audit-main" };
  return { shell: "", main: "" };
}

export default function AdminLayout() {
  const location = useLocation();
  const { loading, error, refreshProfile } = useAdminAuth();
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const menuButtonRef = React.useRef(null);
  const sectionClasses = getSectionClasses(location.pathname);

  const closeSidebar = React.useCallback((restoreFocus = false) => {
    setSidebarOpen(false);
    if (restoreFocus) window.setTimeout(() => menuButtonRef.current?.focus(), 0);
  }, []);

  React.useEffect(() => {
    if (!sidebarOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") closeSidebar(true);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeSidebar, sidebarOpen]);

  if (loading) return <AdminPageState />;

  if (error?.code === "admin_not_authenticated") {
    const intendedRoute = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/login?next=${encodeURIComponent(intendedRoute)}`} replace />;
  }
  if (error?.code === "admin_account_inactive") {
    return <Navigate to="/login?reason=admin_inactive" replace />;
  }
  if (error?.code === "admin_role_mismatch") {
    return <Navigate to={roleRoutes[error.role] || "/login"} replace />;
  }
  if (error) {
    return <AdminPageState type="error" message={error.message || "Admin access could not be verified."} onRetry={refreshProfile} />;
  }

  return (
    <div className={`admin-shell ${sectionClasses.shell}`.trim()}>
      <AdminSidebar
        open={sidebarOpen}
        onClose={() => closeSidebar(false)}
        onDismiss={() => closeSidebar(true)}
        drawerId={drawerId}
      />
      <main className={`admin-main ${sectionClasses.main}`.trim()}>
        <header className="admin-topbar admin-layout-topbar">
          <button
            ref={menuButtonRef}
            className="admin-menu-toggle"
            type="button"
            aria-label={sidebarOpen ? "Close Admin navigation" : "Open Admin navigation"}
            aria-controls={drawerId}
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen((current) => !current)}
          >
            <Icon icon={sidebarOpen ? "solar:close-circle-linear" : "solar:hamburger-menu-linear"} aria-hidden="true" />
          </button>
          <AdminProfileDropdown />
        </header>
        <div className="admin-page-content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
