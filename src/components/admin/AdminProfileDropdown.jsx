import React from "react";
import { Icon } from "@iconify/react";
import { useNavigate } from "react-router-dom";
import { useAdminAuth } from "../../hooks/useAdminAuth";

function getInitials(name) {
  const parts = String(name || "Admin").trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join("") || "AD";
}

function AdminAvatar({ identity, size = "normal" }) {
  return (
    <span className={`admin-avatar admin-avatar--${size}`} aria-hidden="true">
      {identity?.avatarUrl ? <img src={identity.avatarUrl} alt="" /> : getInitials(identity?.displayName)}
    </span>
  );
}

export default function AdminProfileDropdown() {
  const navigate = useNavigate();
  const { identity, logout } = useAdminAuth();
  const [open, setOpen] = React.useState(false);
  const [logoutError, setLogoutError] = React.useState("");
  const menuRef = React.useRef(null);
  const triggerRef = React.useRef(null);

  const closeMenu = React.useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  React.useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event) => {
      if (!menuRef.current?.contains(event.target)) closeMenu(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") closeMenu(true);
    };

    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeMenu, open]);

  const chooseRoute = (path) => {
    closeMenu(false);
    navigate(path);
  };

  const handleLogout = async () => {
    closeMenu(false);
    setLogoutError("");
    try {
      await logout();
    } catch (error) {
      console.error("Admin logout failed:", error);
      setLogoutError("Logout could not be completed. Please retry.");
    }
  };

  return (
    <div className={`admin-profile-menu ${open ? "is-open" : ""}`} ref={menuRef}>
      <button
        ref={triggerRef}
        className="admin-profile-card"
        type="button"
        aria-label="Open Admin account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <AdminAvatar identity={identity} />
        <span>
          <strong>{identity?.displayName || "Admin"}</strong>
          <small>System Admin</small>
        </span>
        <Icon icon={open ? "ri:arrow-drop-up-line" : "ri:arrow-drop-down-line"} aria-hidden="true" />
      </button>

      {open ? (
        <div className="admin-profile-dropdown" role="menu" aria-label="Admin account">
          <div className="admin-profile-dropdown__header">
            <AdminAvatar identity={identity} size="large" />
            <span>
              <strong>{identity?.displayName || "Admin profile not found"}</strong>
              <small>{identity?.email || "No email recorded"}</small>
            </span>
          </div>
          <button type="button" role="menuitem" onClick={() => chooseRoute("/admin/profile")}>
            <Icon icon="solar:user-id-linear" aria-hidden="true" /> View Profile
          </button>
          <button type="button" role="menuitem" onClick={() => chooseRoute("/admin/system-settings")}>
            <Icon icon="solar:settings-linear" aria-hidden="true" /> Settings
          </button>
          <button className="is-danger" type="button" role="menuitem" onClick={handleLogout}>
            <Icon icon="solar:logout-2-linear" aria-hidden="true" /> Logout
          </button>
        </div>
      ) : null}
      {logoutError ? <p className="admin-profile-error" role="alert">{logoutError}</p> : null}
    </div>
  );
}
