import React from "react";
import { Icon } from "@iconify/react";
import { NavLink } from "react-router-dom";

const navGroups = [
  {
    label: "Main",
    items: [{ label: "Dashboard", icon: "solar:widget-2-bold", path: "/admin/dashboard", end: true }],
  },
  {
    label: "Management",
    items: [
      { label: "User Management", icon: "solar:users-group-rounded-bold", path: "/admin/user-management" },
      { label: "Appointment Overview", icon: "solar:calendar-mark-linear", path: "/admin/appointment-overview" },
    ],
  },
  {
    label: "Reports & Logs",
    items: [
      { label: "Reports", icon: "solar:chart-2-linear", path: "/admin/reports" },
      { label: "Audit Logs", icon: "solar:clipboard-list-linear", path: "/admin/audit-logs", end: true },
    ],
  },
  {
    label: "System",
    items: [{ label: "System Settings", icon: "solar:settings-linear", path: "/admin/system-settings", end: true }],
  },
];

export default function AdminSidebar({ open, onClose, onDismiss, drawerId }) {
  const sidebarRef = React.useRef(null);

  React.useEffect(() => {
    if (!open || !sidebarRef.current) return undefined;

    const sidebar = sidebarRef.current;
    const getFocusable = () => [
      ...sidebar.querySelectorAll(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ),
    ];
    const focusTimer = window.setTimeout(() => getFocusable()[0]?.focus(), 0);

    const containFocus = (event) => {
      if (event.key !== "Tab") return;
      const focusable = getFocusable();
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", containFocus);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", containFocus);
    };
  }, [open]);

  return (
    <>
      <aside
        ref={sidebarRef}
        id={drawerId}
        className={`admin-sidebar ${open ? "is-open" : ""}`}
        aria-label="Admin workspace"
        aria-modal={open ? "true" : undefined}
        role={open ? "dialog" : undefined}
      >
        <div className="admin-brand">
          <span><Icon icon="solar:health-bold" aria-hidden="true" /></span>
          <div>
            <strong>Maternal Care</strong>
            <small>Reminder &amp; Management</small>
          </div>
        </div>

        <nav className="admin-nav" aria-label="Admin navigation">
          {navGroups.map((group) => (
            <div className="admin-nav-group" key={group.label}>
              <p>{group.label}</p>
              {group.items.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.end}
                  className={({ isActive }) => (isActive ? "is-active" : undefined)}
                  onClick={onClose}
                >
                  <Icon icon={item.icon} aria-hidden="true" />
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      {open ? (
        <button className="admin-sidebar-backdrop" type="button" aria-label="Close Admin navigation" onClick={onDismiss} />
      ) : null}
    </>
  );
}
