import React from "react";
import { Icon } from "@iconify/react";
import { useNavigate } from "react-router-dom";
import { useAdminAuth } from "../../hooks/useAdminAuth";
import { useAdminDashboardData } from "../../hooks/useAdminDashboardData";
import "../../styles/adminDashboard.css";

const dateRangeOptions = [
  { value: "today", label: "Today" },
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
  { value: "year", label: "This Year" },
];

const adminRoutes = {
  users: "/admin/user-management",
  appointments: "/admin/appointment-overview",
  followups: "/admin/follow-ups",
  reports: "/admin/reports",
  logs: "/admin/audit-logs",
  dashboard: "/admin/dashboard",
};

function getGreeting() {
  const hour = Number(
    new Intl.DateTimeFormat("en-PH", {
      timeZone: "Asia/Manila",
      hour: "numeric",
      hourCycle: "h23",
    }).format(new Date())
  );

  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function MetricCard({ icon, label, value, helper, loading, error }) {
  return (
    <article className="admin-metric-card" aria-label={`${label}: ${error ? "unavailable" : value}. ${helper}`}>
      <span className="admin-metric-icon">
        <Icon icon={icon} />
      </span>
      <div>
        <p>{label}</p>
        {loading ? <span className="admin-skeleton admin-skeleton--number" /> : <strong>{error ? "!" : value}</strong>}
        <small className={error ? "is-error" : ""}>{error || helper}</small>
      </div>
    </article>
  );
}

function PanelError({ message, onRetry }) {
  return (
    <div className="admin-panel-error" role="alert">
      <Icon icon="solar:danger-triangle-linear" aria-hidden="true" />
      <p>{message}</p>
      <button type="button" onClick={onRetry}>Retry</button>
    </div>
  );
}

function getDonutBackground(items) {
  const visible = items.filter((item) => item.value > 0);
  const total = visible.reduce((sum, item) => sum + item.value, 0);
  if (!total) return "conic-gradient(#eef1f8 0 100%)";

  let cursor = 0;
  const stops = visible.map((item) => {
    const start = cursor;
    const end = cursor + (item.value / total) * 100;
    cursor = end;
    return `${item.color} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
  });

  return `conic-gradient(${stops.join(", ")})`;
}

function DonutChart({ items, loading }) {
  const total = items.reduce((sum, item) => sum + item.value, 0);

  return (
    <div className="admin-donut-layout">
      <div
        className="admin-donut"
        style={{ background: loading ? undefined : getDonutBackground(items) }}
        role="img"
        aria-label={`Appointment status chart with ${total} appointments`}
      >
        <span>{loading ? "..." : total}</span>
        <small>Total</small>
      </div>

      <div className="admin-chart-legend">
        {items.map((item) => (
          <p key={item.status}>
            <span style={{ backgroundColor: item.color }} />
            <b>{item.label}</b>
            <strong>{loading ? "..." : `${item.value} (${item.percent}%)`}</strong>
          </p>
        ))}
      </div>
    </div>
  );
}

function getTrendPoints(items) {
  const width = 620;
  const height = 220;
  const padding = 28;
  const maxValue = Math.max(1, ...items.map((item) => item.value));
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;
  const step = items.length > 1 ? usableWidth / (items.length - 1) : 0;

  return items.map((item, index) => {
    const x = padding + step * index;
    const y = padding + usableHeight - (item.value / maxValue) * usableHeight;
    return { ...item, x, y };
  });
}

function TrendChart({ items, loading, rangeLabel }) {
  const points = getTrendPoints(items);
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
  const areaPath = path ? `${path} L592 220 L28 220 Z` : "";
  const hasData = items.some((item) => item.value > 0);
  const labelStep = Math.max(1, Math.ceil(items.length / 8));

  return (
    <div className="admin-trend-wrap">
      <svg className="admin-line-chart" viewBox="0 0 620 260" role="img" aria-label={`User registration trend for ${rangeLabel}. ${items.map((item) => `${item.label}: ${item.value}`).join(", ")}`}>
        <line x1="28" y1="220" x2="592" y2="220" />
        <line x1="28" y1="28" x2="28" y2="220" />
        {!loading && hasData ? <path className="admin-line-chart__fill" d={areaPath} /> : null}
        {!loading && hasData ? <path className="admin-line-chart__line" d={path} /> : null}
        {!loading && hasData
          ? points.map((point) => <circle key={point.key} cx={point.x} cy={point.y} r="4" />)
          : null}
        {points.map((point, index) =>
          index % labelStep === 0 || index === points.length - 1 ? (
            <text key={point.key} x={point.x} y="246" textAnchor="middle">
              {point.label}
            </text>
          ) : null
        )}
      </svg>

      {!loading && !hasData ? <div className="admin-chart-empty">No user registrations in this date range</div> : null}
    </div>
  );
}

function DashboardContent({ identity, dateRange, setDateRange, dashboardData, onNavigate }) {
  const {
    totals,
    appointmentOverview,
    registrationTrend,
    recentActivities,
    systemAlerts,
    range,
    loading,
    summaryLoading,
    activityLoading,
    summaryError,
    activityError,
    refresh,
  } = dashboardData;
  const summaryErrorMessage = summaryError?.code === "PGRST202" || summaryError?.code === "42883"
    ? "The reviewed Admin Dashboard summary RPC must be installed before aggregate metrics can load."
    : summaryError?.message || "Dashboard summary metrics could not be loaded.";
  const metricCards = [
    {
      icon: "solar:users-group-rounded-linear",
      label: "Total Patients",
      value: totals.patients,
      helper: "Registered patient accounts",
    },
    {
      icon: "solar:stethoscope-linear",
      label: "Total Doctors",
      value: totals.doctors,
      helper: "Doctor accounts",
    },
    {
      icon: "solar:user-id-linear",
      label: "Total Staff",
      value: totals.staff,
      helper: "Staff accounts",
    },
    {
      icon: "solar:calendar-date-linear",
      label: "Today's Appointments",
      value: totals.todaysAppointments,
      helper: "Scheduled for today",
    },
  ];

  return (
    <>
      <section className="admin-hero">
        <div>
          <h1>Dashboard</h1>
          <p>{getGreeting()}, {identity.displayName || "Admin"}!</p>
          <span>Here is an overview of clinic activity for {range.label.toLowerCase()}.</span>
        </div>

        <div className="admin-dashboard-controls">
          <label>
            <span className="admin-sr-only">Date Range</span>
            <select value={dateRange} onChange={(event) => setDateRange(event.target.value)}>
              {dateRangeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button className="admin-refresh-btn" type="button" onClick={refresh} disabled={loading} aria-label="Refresh dashboard data" title="Refresh dashboard data">
            <Icon icon="solar:refresh-linear" />
          </button>
        </div>
      </section>

      <section className="admin-metric-grid" aria-label="Admin summary metrics">
        {metricCards.map((card) => (
          <MetricCard key={card.label} {...card} loading={summaryLoading} error={summaryError ? summaryErrorMessage : ""} />
        ))}
      </section>

      <section className="admin-chart-grid">
        <article className="admin-panel admin-panel--overview">
          <header className="admin-panel-header">
            <div>
              <h2>Appointment Overview</h2>
              <p>{range.label} status distribution</p>
            </div>
          </header>
          {summaryError ? (
            <PanelError message={summaryErrorMessage} onRetry={refresh} />
          ) : (
            <DonutChart items={appointmentOverview} loading={summaryLoading} />
          )}
        </article>

        <article className="admin-panel admin-panel--trend">
          <header className="admin-panel-header">
            <div>
              <h2>User Registration Trend</h2>
              <p>{range.label} grouped by {range.trendLabel}</p>
            </div>
          </header>
          {summaryError ? (
            <PanelError message={summaryErrorMessage} onRetry={refresh} />
          ) : (
            <TrendChart items={registrationTrend} loading={summaryLoading} rangeLabel={range.label} />
          )}
        </article>
      </section>

      <section className="admin-lower-grid">
        <article className="admin-panel admin-panel--activity">
          <header className="admin-panel-header">
            <div>
              <h2>Recent Activities</h2>
            </div>
            <button type="button" onClick={() => onNavigate("logs")}>View all</button>
          </header>

          <div className="admin-activity-list">
            {activityLoading ? (
              Array.from({ length: 5 }, (_, index) => (
                <div className="admin-activity-item" key={index}>
                  <span className="admin-skeleton admin-skeleton--circle" />
                  <div>
                    <span className="admin-skeleton" />
                    <span className="admin-skeleton admin-skeleton--short" />
                  </div>
                </div>
              ))
            ) : activityError ? (
              <PanelError message={activityError.message || "Recent audit activity could not be loaded."} onRetry={refresh} />
            ) : recentActivities.length ? (
              recentActivities.map((activity) => (
                <button className="admin-activity-item" type="button" key={activity.id} onClick={() => onNavigate(activity.target)}>
                  <span>
                    <Icon icon={activity.icon} />
                  </span>
                  <div>
                    <strong>{activity.description}</strong>
                    <small>{activity.actor} ({activity.actorRole}) | {activity.timeLabel}</small>
                    <span className="admin-activity-meta">{activity.module} | {activity.action}</span>
                  </div>
                  <Icon icon="solar:alt-arrow-right-linear" />
                </button>
              ))
            ) : (
              <div className="admin-empty">No recent activities</div>
            )}
          </div>
        </article>

        <article className="admin-panel admin-panel--alerts">
          <header className="admin-panel-header">
            <div>
              <h2>System Alerts</h2>
            </div>
          </header>

          <div className="admin-alert-list">
            {summaryLoading ? (
              Array.from({ length: 4 }, (_, index) => (
                <div className="admin-alert-item" key={index}>
                  <span className="admin-skeleton admin-skeleton--circle" />
                  <div>
                    <span className="admin-skeleton" />
                    <span className="admin-skeleton admin-skeleton--short" />
                  </div>
                </div>
              ))
            ) : summaryError ? (
              <PanelError message={summaryErrorMessage} onRetry={refresh} />
            ) : systemAlerts.length ? (
              systemAlerts.map((alert) => (
                <div className="admin-alert-item" key={alert.id}>
                  <span>
                    <Icon icon={alert.icon} />
                  </span>
                  <div>
                    <strong>{alert.count}</strong>
                    <p>{alert.title}</p>
                    <span className={`admin-alert-severity is-${String(alert.severity || "review").toLowerCase()}`}>{alert.severity || "Review"}</span>
                    <small>{alert.detail}</small>
                  </div>
                  <button type="button" onClick={() => onNavigate(alert.target)}>View</button>
                </div>
              ))
            ) : (
              <div className="admin-empty">No active system alerts.</div>
            )}
          </div>
        </article>
      </section>
    </>
  );
}

export default function AdminDashboard() {
  const navigate = useNavigate();
  const { identity, isAdmin } = useAdminAuth();
  const [dateRange, setDateRange] = React.useState("month");
  const dashboardData = useAdminDashboardData(dateRange, isAdmin);

  const navigateAdmin = React.useCallback(
    (page) => {
      navigate(adminRoutes[page] || adminRoutes.dashboard);
    },
    [navigate]
  );

  return (
    <DashboardContent
      identity={identity}
      dateRange={dateRange}
      setDateRange={setDateRange}
      dashboardData={dashboardData}
      onNavigate={navigateAdmin}
    />
  );
}
