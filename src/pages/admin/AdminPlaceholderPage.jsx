import { Icon } from "@iconify/react";
import { useAdminAuth } from "../../hooks/useAdminAuth";

export default function AdminPlaceholderPage() {
  const { identity } = useAdminAuth();

  return (
    <section className="admin-placeholder-panel">
      <span><Icon icon="solar:user-id-linear" aria-hidden="true" /></span>
      <h1>Admin Profile</h1>
      <p>This route is reserved for authenticated Admin profile details.</p>
      <dl>
        <div><dt>Name</dt><dd>{identity?.displayName || "Admin profile not found"}</dd></div>
        <div><dt>Email</dt><dd>{identity?.email || "Not recorded"}</dd></div>
        <div><dt>Role</dt><dd>System Admin</dd></div>
      </dl>
    </section>
  );
}
