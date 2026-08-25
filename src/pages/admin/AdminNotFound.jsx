import { Icon } from "@iconify/react";
import { Link } from "react-router-dom";
import "../../styles/adminDashboard.css";

export default function AdminNotFound() {
  return (
    <section className="admin-placeholder-panel" role="status">
      <span><Icon icon="solar:map-point-remove-linear" aria-hidden="true" /></span>
      <h1>Admin page not found</h1>
      <p>The requested Admin page does not exist or is no longer available.</p>
      <Link className="admin-placeholder-link" to="/admin/dashboard">Return to Dashboard</Link>
    </section>
  );
}
