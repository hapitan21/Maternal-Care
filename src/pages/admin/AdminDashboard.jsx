import React from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import "../../styles/adminDashboard.css";

const scheduleTableName = "schedule";
const adminProfilePhoto = "/images/doctor-kempee-profile.svg";

const navGroups = [
  {
    label: "",
    items: [{ key: "dashboard", label: "Dashboard", icon: "dashboard" }],
  },
  {
    label: "Management",
    items: [
      { key: "users", label: "User Management", icon: "users" },
      { key: "clinic", label: "Clinic Management", icon: "clinic" },
      { key: "appointments", label: "Appointment Overview", icon: "calendar" },
    ],
  },
  {
    label: "Reports & Logs",
    items: [
      { key: "reports", label: "Reports", icon: "chart" },
      { key: "logs", label: "Audit Logs", icon: "logs" },
    ],
  },
  {
    label: "System",
    items: [{ key: "settings", label: "System Settings", icon: "settings" }],
  },
];

const statusColors = {
  completed: "#ff2f80",
  pending: "#ffc8d9",
  scheduled: "#ffc8d9",
  cancelled: "#ff8fae",
  canceled: "#ff8fae",
  rescheduled: "#ffe88a",
  missed: "#2f3a5f",
};

function AdminIcon({ name }) {
  const icons = {
    logo: (
      <>
        <path d="M12 3.5c-4.1 0-7.4 3.3-7.4 7.4 0 5.5 5.7 9.5 6.5 10 .5.4 1.3.4 1.8 0 .8-.5 6.5-4.5 6.5-10 0-4.1-3.3-7.4-7.4-7.4Z" />
        <path d="M9.7 11.5h4.6M12 9.2v4.6" />
      </>
    ),
    dashboard: (
      <>
        <rect x="4" y="4" width="7" height="7" rx="1.8" />
        <rect x="13" y="4" width="7" height="7" rx="1.8" />
        <rect x="4" y="13" width="7" height="7" rx="1.8" />
        <rect x="13" y="13" width="7" height="7" rx="1.8" />
      </>
    ),
    users: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3.8 19a5.2 5.2 0 0 1 10.4 0" />
        <circle cx="17" cy="10" r="2.4" />
        <path d="M15 19a4.4 4.4 0 0 1 5.2-4.3" />
      </>
    ),
    patient: (
      <>
        <circle cx="12" cy="7.5" r="3.2" />
        <path d="M5 20a7 7 0 0 1 14 0" />
      </>
    ),
    clinic: (
      <>
        <path d="M4.5 20.5V6A1.5 1.5 0 0 1 6 4.5h8A1.5 1.5 0 0 1 15.5 6v14.5" />
        <path d="M15.5 9.5H19a1.5 1.5 0 0 1 1.5 1.5v9.5M3 20.5h18M8 9h3M8 13h3M8 17h3" />
      </>
    ),
    calendar: (
      <>
        <rect x="4.5" y="6.5" width="15" height="13.5" rx="2" />
        <path d="M8 4v4M16 4v4M4.5 10.5h15" />
      </>
    ),
    bell: (
      <>
        <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z" />
        <path d="M10 21h4" />
      </>
    ),
    chart: (
      <>
        <path d="M4 19.5h16" />
        <path d="M6.5 16.5v-5" />
        <path d="M11.5 16.5v-9" />
        <path d="M16.5 16.5v-12" />
      </>
    ),
    logs: (
      <>
        <path d="M6 4h12v16H6z" />
        <path d="M9 8h6M9 12h6M9 16h4" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2a2 2 0 0 1-4 0V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 0 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H2.8a2 2 0 0 1 0-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1A2 2 0 0 1 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 .9-1.6v-.2a2 2 0 0 1 4 0V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 0 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6.9h.2a2 2 0 0 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z" />
      </>
    ),
    logout: (
      <>
        <path d="M14 4H7a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h7" />
        <path d="M10 12h10M17 8l4 4-4 4" />
      </>
    ),
    chevron: <path d="m9 18 6-6-6-6" />,
    warning: (
      <>
        <path d="M12 3 21 20H3L12 3Z" />
        <path d="M12 9v5M12 17h.01" />
      </>
    ),
  };

  return (
    <svg
      className="admin-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {icons[name]}
    </svg>
  );
}

function getTodayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(start.getDate() + 1);

  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function formatTime(value) {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatName(value, fallback = "Admin") {
  return String(value || "").trim() || fallback;
}

function normalizeStatus(status) {
  const value = String(status || "scheduled").trim().toLowerCase();
  if (value === "cancelled") return "cancelled";
  if (value === "canceled") return "cancelled";
  if (value === "accepted") return "pending";
  if (value === "scheduled") return "pending";
  return value || "pending";
}

function toStatusLabel(status) {
  const value = normalizeStatus(status);
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function getRecentTime(row) {
  return (
    row.created_at ||
    row.updated_at ||
    row.uploaded_at ||
    row.start_time ||
    new Date().toISOString()
  );
}

function createTrend(scheduleRows) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date();
    day.setDate(day.getDate() - (6 - index));
    day.setHours(0, 0, 0, 0);
    return {
      key: day.toISOString().slice(0, 10),
      label: day.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      value: 0,
    };
  });

  (scheduleRows || []).forEach((row) => {
    const dateKey = String(row.start_time || row.created_at || "").slice(0, 10);
    const item = days.find((day) => day.key === dateKey);
    if (item) item.value += 1;
  });

  return days;
}

function createTrendPath(trend) {
  const width = 360;
  const height = 150;
  const maxValue = Math.max(1, ...trend.map((item) => item.value));
  const step = width / Math.max(1, trend.length - 1);

  return trend
    .map((item, index) => {
      const x = index * step;
      const y = height - (item.value / maxValue) * 110 - 20;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function buildAppointmentOverview(scheduleRows) {
  const total = Math.max(1, scheduleRows.length);
  const counts = scheduleRows.reduce((map, row) => {
    const status = normalizeStatus(row.status);
    map[status] = (map[status] || 0) + 1;
    return map;
  }, {});

  return ["completed", "pending", "cancelled", "rescheduled", "missed"].map(
    (status) => ({
      status,
      label: toStatusLabel(status),
      value: counts[status] || 0,
      percent: Math.round(((counts[status] || 0) / total) * 100),
      color: statusColors[status] || "#ff2f80",
    })
  );
}

async function safeCount(table, queryBuilder = null) {
  const query = supabase.from(table).select("id", { count: "exact", head: true });
  const result = await (queryBuilder ? queryBuilder(query) : query);

  return {
    count: result.error ? 0 : result.count ?? 0,
    error: result.error,
  };
}

function AdminDashboard() {
  const navigate = useNavigate();
  const [activePanel, setActivePanel] = React.useState("dashboard");
  const [adminProfile, setAdminProfile] = React.useState({
    name: "Admin",
    email: "System Admin",
  });
  const [stats, setStats] = React.useState({
    totalPatients: 0,
    totalDoctors: 0,
    totalStaff: 0,
    todaysAppointments: 0,
    remindersSent: 0,
  });
  const [appointmentOverview, setAppointmentOverview] = React.useState([]);
  const [appointmentTrend, setAppointmentTrend] = React.useState([]);
  const [recentActivities, setRecentActivities] = React.useState([]);
  const [systemAlerts, setSystemAlerts] = React.useState([]);
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    let active = true;

    const loadAdminData = async () => {
      setIsLoading(true);

      const todayRange = getTodayRange();
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      const profileQuery = user?.id
        ? supabase
            .from("profiles")
            .select("id, full_name, email, role")
            .eq("id", user.id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null });

      const [
        currentProfileResult,
        patientCount,
        doctorCount,
        staffCount,
        todaysAppointmentCount,
        remindersCount,
        medicationRemindersCount,
        scheduleResult,
        recentProfilesResult,
        recentPatientsResult,
        recentRecordsResult,
      ] = await Promise.all([
        profileQuery,
        safeCount("patients", (query) => query.ilike("status", "active")),
        safeCount("profiles", (query) => query.eq("role", "doctor")),
        safeCount("profiles", (query) => query.eq("role", "staff")),
        safeCount(scheduleTableName, (query) =>
          query.gte("start_time", todayRange.start).lt("start_time", todayRange.end)
        ),
        safeCount("reminders"),
        safeCount("medication_reminders"),
        supabase
          .from(scheduleTableName)
          .select("id, patient_name, doctor_name, status, start_time, created_at")
          .order("start_time", { ascending: false })
          .limit(160),
        supabase
          .from("profiles")
          .select("id, full_name, email, role, created_at")
          .order("created_at", { ascending: false })
          .limit(5),
        supabase
          .from("patients")
          .select("id, full_name, created_at, status")
          .order("created_at", { ascending: false })
          .limit(5),
        supabase
          .from("medical_records")
          .select("id, patient_name, title, type, uploaded_at, uploaded_by")
          .order("uploaded_at", { ascending: false })
          .limit(5),
      ]);

      if (!active) return;

      const profile = currentProfileResult.data || {};
      setAdminProfile({
        name:
          formatName(profile.full_name, "") ||
          formatName(user?.user_metadata?.full_name, "") ||
          "Admin",
        email: profile.email || user?.email || "System Admin",
      });

      const scheduleRows = scheduleResult.error ? [] : scheduleResult.data || [];

      setStats({
        totalPatients: patientCount.count,
        totalDoctors: doctorCount.count,
        totalStaff: staffCount.count,
        todaysAppointments: todaysAppointmentCount.count,
        remindersSent: remindersCount.count + medicationRemindersCount.count,
      });

      setAppointmentOverview(buildAppointmentOverview(scheduleRows));
      setAppointmentTrend(createTrend(scheduleRows));

      const activities = [
        ...(recentPatientsResult.data || []).map((item) => ({
          id: `patient-${item.id}`,
          icon: "patient",
          title: `Staff registered ${item.full_name || "a new patient"}.`,
          time: item.created_at,
        })),
        ...(recentProfilesResult.data || []).map((item) => ({
          id: `profile-${item.id}`,
          icon: "users",
          title: `${item.full_name || item.email || "A user"} joined as ${item.role || "user"}.`,
          time: item.created_at,
        })),
        ...(recentRecordsResult.data || []).map((item) => ({
          id: `record-${item.id}`,
          icon: "logs",
          title: `${item.uploaded_by || "Doctor"} uploaded ${item.title || item.type || "a record"} for ${item.patient_name || "a patient"}.`,
          time: item.uploaded_at,
        })),
      ]
        .filter((item) => item.time)
        .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
        .slice(0, 5);

      setRecentActivities(activities);

      const pendingCount = scheduleRows.filter((row) =>
        ["pending", "scheduled", "accepted"].includes(
          String(row.status || "").toLowerCase()
        )
      ).length;

      const alerts = [];
      if (pendingCount > 0) {
        alerts.push({
          id: "pending-appointments",
          tone: "warning",
          title: `${pendingCount} patient appointment${pendingCount === 1 ? "" : "s"} pending.`,
          detail: "Review and approve pending appointment requests.",
        });
      }

      if (todaysAppointmentCount.count > 0) {
        alerts.push({
          id: "today-appointments",
          tone: "calendar",
          title: `${todaysAppointmentCount.count} appointment${todaysAppointmentCount.count === 1 ? "" : "s"} for today.`,
          detail: "Review the clinic schedule.",
        });
      }

      [
        userError,
        currentProfileResult.error,
        patientCount.error,
        doctorCount.error,
        staffCount.error,
        todaysAppointmentCount.error,
        remindersCount.error,
        medicationRemindersCount.error,
        scheduleResult.error,
        recentProfilesResult.error,
        recentPatientsResult.error,
        recentRecordsResult.error,
      ]
        .filter(Boolean)
        .slice(0, 4)
        .forEach((error, index) => {
          alerts.push({
            id: `load-error-${index}`,
            tone: "warning",
            title: "Some admin data could not be loaded.",
            detail: error.message,
          });
        });

      setSystemAlerts(alerts);
      setIsLoading(false);
    };

    loadAdminData();

    const scheduleChannel = supabase
      .channel("admin-dashboard-schedule")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: scheduleTableName },
        loadAdminData
      )
      .subscribe();

    const patientsChannel = supabase
      .channel("admin-dashboard-patients")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "patients" },
        loadAdminData
      )
      .subscribe();

    const profilesChannel = supabase
      .channel("admin-dashboard-profiles")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "profiles" },
        loadAdminData
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(scheduleChannel);
      supabase.removeChannel(patientsChannel);
      supabase.removeChannel(profilesChannel);
    };
  }, []);

  const handleLogout = async () => {
    const { error } = await supabase.auth.signOut();

    if (error) {
      alert(error.message);
      return;
    }

    navigate("/login?logout=1", { replace: true });
  };

  const statCards = [
    {
      key: "totalPatients",
      label: "Total Patients",
      value: stats.totalPatients,
      helper: "from last month",
      icon: "patient",
      delta: "+12%",
    },
    {
      key: "totalDoctors",
      label: "Total Doctors",
      value: stats.totalDoctors,
      helper: "No change",
      icon: "users",
    },
    {
      key: "totalStaff",
      label: "Total Staff",
      value: stats.totalStaff,
      helper: "No change",
      icon: "clinic",
    },
    {
      key: "todaysAppointments",
      label: "Today's Appointments",
      value: stats.todaysAppointments,
      helper: "View details",
      icon: "calendar",
      action: true,
    },
    {
      key: "remindersSent",
      label: "Reminders Sent",
      value: stats.remindersSent,
      helper: "this month",
      icon: "bell",
    },
  ];

  const donutSegments = appointmentOverview
    .filter((item) => item.value > 0)
    .map((item) => item.percent)
    .join(" ");
  const trendPath = createTrendPath(appointmentTrend);

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div>
          <div className="admin-brand">
            <span>
              <AdminIcon name="logo" />
            </span>
            <div>
              <h1>Maternal Care</h1>
              <p>Reminder &amp; Management</p>
            </div>
          </div>

          <nav className="admin-nav" aria-label="Admin navigation">
            {navGroups.map((group) => (
              <div className="admin-nav-group" key={group.label || "main"}>
                {group.label ? <p>{group.label}</p> : null}
                {group.items.map((item) => (
                  <button
                    key={item.key}
                    className={activePanel === item.key ? "is-active" : ""}
                    type="button"
                    onClick={() => setActivePanel(item.key)}
                  >
                    <AdminIcon name={item.icon} />
                    <span>{item.label}</span>
                    {["users", "reports"].includes(item.key) ? (
                      <AdminIcon name="chevron" />
                    ) : null}
                  </button>
                ))}
              </div>
            ))}
          </nav>
        </div>

        <button className="admin-logout" type="button" onClick={handleLogout}>
          <AdminIcon name="logout" />
          <span>Logout</span>
        </button>
      </aside>

      <main className="admin-main">
        <header className="admin-topbar">
          <div />

          <button className="admin-profile-card" type="button">
            <img src={adminProfilePhoto} alt="" />
            <span>
              <strong>{adminProfile.name}</strong>
              <small>{adminProfile.email}</small>
            </span>
            <AdminIcon name="chevron" />
          </button>
        </header>

        {activePanel === "dashboard" ? (
          <>
            <section className="admin-welcome">
              <h1>Good morning, {adminProfile.name}!</h1>
              <p>Here's an overview of today's clinic activity.</p>
            </section>

            <section className="admin-stats-grid">
              {statCards.map((stat) => (
                <article className="admin-stat-card" key={stat.key}>
                  <span className="admin-stat-card__icon">
                    <AdminIcon name={stat.icon} />
                  </span>
                  <div>
                    <p>{stat.label}</p>
                    <strong>{isLoading ? "..." : stat.value}</strong>
                    <small className={stat.delta ? "is-positive" : ""}>
                      {stat.delta ? `${stat.delta} ` : null}
                      {stat.helper}
                      {stat.action ? " ->" : ""}
                    </small>
                  </div>
                </article>
              ))}
            </section>

            <section className="admin-dashboard-grid">
              <article className="admin-panel admin-panel--chart">
                <header>
                  <h2>Appointments Overview</h2>
                </header>

                <div className="admin-donut-layout">
                  <div
                    className="admin-donut"
                    style={{ "--segments": donutSegments || "100" }}
                    aria-hidden="true"
                  />
                  <div className="admin-chart-legend">
                    {appointmentOverview.map((item) => (
                      <p key={item.status}>
                        <span style={{ backgroundColor: item.color }} />
                        <b>{item.label}</b>
                        <strong>{item.value} ({item.percent}%)</strong>
                      </p>
                    ))}
                  </div>
                </div>
              </article>

              <article className="admin-panel admin-panel--line">
                <header>
                  <h2>Appointment Trends</h2>
                </header>

                <svg className="admin-line-chart" viewBox="0 0 360 170" role="img" aria-label="Appointment trend chart">
                  <path className="admin-line-chart__fill" d={`${trendPath} L360 170 L0 170 Z`} />
                  <path className="admin-line-chart__line" d={trendPath} />
                </svg>
              </article>

              <article className="admin-panel admin-panel--activity">
                <header>
                  <h2>Recent Activities</h2>
                </header>

                <div className="admin-activity-list">
                  {recentActivities.length ? (
                    recentActivities.map((activity) => (
                      <div className="admin-activity-item" key={activity.id}>
                        <span>
                          <AdminIcon name={activity.icon} />
                        </span>
                        <p>{activity.title}</p>
                        <small>{formatTime(activity.time)}</small>
                      </div>
                    ))
                  ) : (
                    <div className="admin-empty">No recent activity yet.</div>
                  )}
                </div>

                <button className="admin-text-action" type="button" onClick={() => setActivePanel("logs")}>
                  {"View all activities ->"}
                </button>
              </article>

              <article className="admin-panel admin-panel--alerts">
                <header>
                  <h2>System Alerts</h2>
                </header>

                <div className="admin-alert-list">
                  {systemAlerts.length ? (
                    systemAlerts.map((alert) => (
                      <div className="admin-alert-item" key={alert.id}>
                        <span className={`is-${alert.tone}`}>
                          <AdminIcon name={alert.tone === "calendar" ? "calendar" : "warning"} />
                        </span>
                        <div>
                          <strong>{alert.title}</strong>
                          <p>{alert.detail}</p>
                        </div>
                        <button type="button">{"View ->"}</button>
                      </div>
                    ))
                  ) : (
                    <div className="admin-empty">No system alerts.</div>
                  )}
                </div>

                <button className="admin-text-action" type="button">
                  {"View all alerts ->"}
                </button>
              </article>
            </section>
          </>
        ) : (
          <section className="admin-placeholder-panel">
            <AdminIcon
              name={
                navGroups.flatMap((group) => group.items).find((item) => item.key === activePanel)?.icon ||
                "dashboard"
              }
            />
            <h1>
              {navGroups.flatMap((group) => group.items).find((item) => item.key === activePanel)?.label ||
                "Admin"}
            </h1>
            <p>This admin section is ready for detailed tables and controls.</p>
          </section>
        )}
      </main>
    </div>
  );
}

export default AdminDashboard;
