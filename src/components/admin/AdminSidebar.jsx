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
      { label: "Medication Follow-ups", icon: "solar:clipboard-heart-linear", path: "/admin/follow-ups" },
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
  return (
    <>
      <aside id={drawerId} className={`admin-sidebar ${open ? "is-open" : ""}`} aria-label="Admin workspace">
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
