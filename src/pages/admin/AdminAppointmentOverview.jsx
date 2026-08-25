import React from "react";
import { Icon } from "@iconify/react";
import { useAdminAppointmentOverview } from "../../hooks/useAdminAppointmentOverview";
import { useAdminAuth } from "../../hooks/useAdminAuth";
import AdminPageHeader from "../../components/admin/AdminPageHeader";
import {
  appointmentOverviewStatuses,
  formatAppointmentDate,
  getManilaDateKey,
  toManilaISOString,
} from "../../lib/appointmentDate";
import "../../styles/adminDashboard.css";
import "../../styles/adminAppointmentOverview.css";

const PAGE_SIZE = 5;

const statusOptions = [
  { value: "all", label: "All" },
  { value: appointmentOverviewStatuses.completed, label: "Completed" },
  { value: appointmentOverviewStatuses.upcoming, label: "Upcoming" },
  { value: appointmentOverviewStatuses.canceled, label: "Canceled" },
  { value: appointmentOverviewStatuses.missed, label: "Missed" },
];

const timeOptions = [
  { value: "all", label: "All" },
  { value: "morning", label: "Morning" },
  { value: "afternoon", label: "Afternoon" },
  { value: "evening", label: "Evening" },
];

const summaryDefinitions = [
  {
    key: "total",
    label: "Total Appointments",
    icon: "solar:calendar-mark-linear",
    helper: "All appointments for the day",
  },
  {
    key: appointmentOverviewStatuses.completed,
    label: "Completed",
    icon: "solar:check-circle-linear",
  },
  {
    key: appointmentOverviewStatuses.upcoming,
    label: "Upcoming",
    icon: "solar:clock-circle-linear",
  },
  {
    key: appointmentOverviewStatuses.canceled,
    label: "Canceled",
    icon: "solar:close-circle-linear",
  },
  {
    key: appointmentOverviewStatuses.missed,
    label: "Missed",
    icon: "solar:danger-circle-linear",
  },
];

function cleanText(value) {
  return String(value || "").trim();
}

function getInitials(name) {
  return (
    cleanText(name)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("") || "PT"
  );
}

function getDateParts(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cleanText(dateKey));
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]) - 1,
    day: Number(match[3]),
  };
}

function toDateKey(year, monthIndex, day) {
  const date = new Date(year, monthIndex, day, 12, 0, 0);
  const nextYear = date.getFullYear();
  const nextMonth = String(date.getMonth() + 1).padStart(2, "0");
  const nextDay = String(date.getDate()).padStart(2, "0");
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

function getCalendarDays(monthDate) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstWeekday = new Date(year, month, 1, 12).getDay();

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(year, month, index - firstWeekday + 1, 12);
    return {
      key: toDateKey(date.getFullYear(), date.getMonth(), date.getDate()),
      day: date.getDate(),
      inMonth: date.getMonth() === month,
    };
  });
}

function matchesTimeFilter(timeKey, filter) {
  if (filter === "all") return true;
  const hour = Number(cleanText(timeKey).split(":")[0]);
  if (!Number.isFinite(hour)) return false;
  if (filter === "morning") return hour < 12;
  if (filter === "afternoon") return hour >= 12 && hour < 17;
  return hour >= 17;
}

function SummaryCard({ definition, value, total, loading }) {
  const percentage = total ? ((value / total) * 100).toFixed(2) : "0.00";
  const helper =
    definition.helper || `${percentage}% of total`;

  return (
    <article className={`admin-appointment-summary admin-appointment-summary--${definition.key}`}>
      <span className="admin-appointment-summary__icon">
        <Icon icon={definition.icon} />
      </span>
      <div>
        <p>{definition.label}</p>
        {loading ? (
          <span className="admin-skeleton admin-skeleton--number" />
        ) : (
          <strong>{value}</strong>
        )}
        <small>{helper}</small>
      </div>
    </article>
  );
}

function FilterSelect({ label, value, onChange, children }) {
  return (
    <label className="admin-appointment-filter-select">
      <span>{label}</span>
      <select value={value} onChange={onChange}>
        {children}
      </select>
    </label>
  );
}

function AppointmentCalendar({ monthDate, selectedDateKey, onChangeMonth, onSelectDate }) {
  const todayKey = getManilaDateKey(new Date());
  const monthLabel = monthDate.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
  const days = React.useMemo(() => getCalendarDays(monthDate), [monthDate]);

  return (
    <section className="admin-appointment-calendar" aria-label="Appointment calendar">
      <header>
        <h2>Calendar</h2>
        <div>
          <button type="button" onClick={() => onChangeMonth(-1)} aria-label="Previous month">
            <Icon icon="solar:alt-arrow-left-linear" />
          </button>
          <strong>{monthLabel}</strong>
          <button type="button" onClick={() => onChangeMonth(1)} aria-label="Next month">
            <Icon icon="solar:alt-arrow-right-linear" />
          </button>
        </div>
      </header>

      <div className="admin-appointment-calendar__weekdays" aria-hidden="true">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="admin-appointment-calendar__days">
        {days.map((date) => (
          <button
            key={date.key}
            className={[
              date.inMonth ? "" : "is-outside",
              date.key === selectedDateKey ? "is-selected" : "",
              date.key === todayKey ? "is-today" : "",
            ].filter(Boolean).join(" ")}
            type="button"
            onClick={() => onSelectDate(date.key)}
            aria-label={`View appointments for ${date.key}`}
            aria-pressed={date.key === selectedDateKey}
            aria-selected={date.key === selectedDateKey}
          >
            {date.day}
          </button>
        ))}
      </div>
    </section>
  );
}

function StatusBadge({ appointment }) {
  return (
    <span className={`admin-appointment-status admin-appointment-status--${appointment.status}`}>
      {appointment.statusLabel}
    </span>
  );
}

function Pagination({ page, pageCount, onChange }) {
  if (pageCount <= 1) return null;
  const start = Math.max(1, Math.min(page - 2, pageCount - 4));
  const pages = Array.from(
    { length: Math.min(5, pageCount) },
    (_, index) => start + index
  );

  return (
    <nav className="admin-appointment-pagination" aria-label="Appointment table pages">
      <button type="button" onClick={() => onChange(page - 1)} disabled={page === 1} aria-label="Previous page">
        <Icon icon="solar:alt-arrow-left-linear" />
      </button>
      {pages.map((pageNumber) => (
        <button
          key={pageNumber}
          className={pageNumber === page ? "is-active" : ""}
          type="button"
          onClick={() => onChange(pageNumber)}
          aria-current={pageNumber === page ? "page" : undefined}
        >
          {pageNumber}
        </button>
      ))}
      <button type="button" onClick={() => onChange(page + 1)} disabled={page === pageCount} aria-label="Next page">
        <Icon icon="solar:alt-arrow-right-linear" />
      </button>
    </nav>
  );
}

export default function AdminAppointmentOverview() {
  const { isAdmin } = useAdminAuth();
  const [selectedDateKey, setSelectedDateKey] = React.useState(() => getManilaDateKey(new Date()));
  const initialDateParts = getDateParts(selectedDateKey);
  const [calendarMonth, setCalendarMonth] = React.useState(
    () => new Date(initialDateParts.year, initialDateParts.month, 1, 12)
  );
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [doctorFilter, setDoctorFilter] = React.useState("all");
  const [timeFilter, setTimeFilter] = React.useState("all");
  const [page, setPage] = React.useState(1);
  const { appointments, loading, error, refresh } = useAdminAppointmentOverview(
    selectedDateKey,
    isAdmin
  );

  const doctorOptions = React.useMemo(() => {
    const byKey = new Map();
    appointments.forEach((appointment) => {
      if (!byKey.has(appointment.doctorFilterKey)) {
        byKey.set(appointment.doctorFilterKey, appointment.doctorName);
      }
    });
    return Array.from(byKey, ([value, label]) => ({ value, label })).sort((first, second) =>
      first.label.localeCompare(second.label)
    );
  }, [appointments]);

  const filteredAppointments = React.useMemo(() => {
    const searchValue = cleanText(search).toLowerCase();
    return appointments.filter((appointment) => {
      if (searchValue && !appointment.searchText.includes(searchValue)) return false;
      if (statusFilter !== "all" && appointment.status !== statusFilter) return false;
      if (doctorFilter !== "all" && appointment.doctorFilterKey !== doctorFilter) return false;
      return matchesTimeFilter(appointment.timeKey, timeFilter);
    });
  }, [appointments, doctorFilter, search, statusFilter, timeFilter]);

  const summaryCounts = React.useMemo(() => {
    const counts = {
      total: appointments.length,
      [appointmentOverviewStatuses.completed]: 0,
      [appointmentOverviewStatuses.upcoming]: 0,
      [appointmentOverviewStatuses.canceled]: 0,
      [appointmentOverviewStatuses.missed]: 0,
    };
    appointments.forEach((appointment) => {
      if (Object.hasOwn(counts, appointment.status)) counts[appointment.status] += 1;
    });
    return counts;
  }, [appointments]);

  const pageCount = Math.max(1, Math.ceil(filteredAppointments.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visibleAppointments = filteredAppointments.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE
  );
  const selectedDateLabel = formatAppointmentDate(
    toManilaISOString(selectedDateKey, "12:00")
  );
  const firstVisible = filteredAppointments.length ? (safePage - 1) * PAGE_SIZE + 1 : 0;
  const lastVisible = Math.min(safePage * PAGE_SIZE, filteredAppointments.length);

  const selectDate = (dateKey) => {
    const parts = getDateParts(dateKey);
    if (!parts) return;
    setSelectedDateKey(dateKey);
    setCalendarMonth(new Date(parts.year, parts.month, 1, 12));
    setPage(1);
  };

  const updateFilter = (setter) => (event) => {
    setter(event.target.value);
    setPage(1);
  };

  const clearFilters = () => {
    setSearch("");
    setStatusFilter("all");
    setDoctorFilter("all");
    setTimeFilter("all");
    setPage(1);
  };

  const changeMonth = (offset) => {
    setCalendarMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1, 12));
  };

  return (
    <>
        <AdminPageHeader
          className="admin-appointment-title"
          title="Appointment Overview"
          subtitle="Monitor and manage Patient appointments."
        />

        <section className="admin-appointment-summary-grid" aria-label="Appointment status summary">
          {summaryDefinitions.map((definition) => (
            <SummaryCard
              key={definition.key}
              definition={definition}
              value={summaryCounts[definition.key]}
              total={summaryCounts.total}
              loading={loading}
            />
          ))}
        </section>

        <section className="admin-appointment-filters" aria-label="Filter appointments">
          <label className="admin-appointment-search">
            <Icon icon="solar:magnifer-linear" />
            <span className="admin-sr-only">Search appointments</span>
            <input
              type="search"
              value={search}
              placeholder="Search appointment ID, patient, or doctor..."
              onChange={updateFilter(setSearch)}
            />
          </label>
          <FilterSelect label="Status" value={statusFilter} onChange={updateFilter(setStatusFilter)}>
            {statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </FilterSelect>
          <FilterSelect label="Doctor" value={doctorFilter} onChange={updateFilter(setDoctorFilter)}>
            <option value="all">All</option>
            {doctorOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </FilterSelect>
          <FilterSelect label="Time" value={timeFilter} onChange={updateFilter(setTimeFilter)}>
            {timeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </FilterSelect>
          <button className="admin-appointment-clear" type="button" onClick={clearFilters}>
            <Icon icon="solar:restart-linear" />
            Clear Filters
          </button>
        </section>

        <div className="admin-appointment-layout">
          <aside className="admin-appointment-calendar-column">
            <AppointmentCalendar
              monthDate={calendarMonth}
              selectedDateKey={selectedDateKey}
              onChangeMonth={changeMonth}
              onSelectDate={selectDate}
            />
            <div className="admin-appointment-date-note">
              <Icon icon="solar:info-circle-linear" />
              <p>You are viewing appointments for <strong>{selectedDateLabel}</strong></p>
            </div>
          </aside>

          <section className="admin-appointment-table-card" aria-labelledby="appointment-table-title">
            <header>
              <h2 id="appointment-table-title">
                Appointments for {selectedDateLabel} ({appointments.length})
              </h2>
            </header>

            {error ? (
              <div className="admin-appointment-message" role="alert">
                <Icon icon="solar:danger-triangle-linear" />
                <div>
                  <strong>Unable to load appointment information. Please try again.</strong>
                  <p>{error.message || "Check the connection and try again."}</p>
                </div>
                <button type="button" onClick={refresh}>Retry</button>
              </div>
            ) : (
              <div className="admin-appointment-table-wrap">
                {loading ? <span className="admin-sr-only" role="status">Loading appointment overview...</span> : null}
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Patient</th>
                      <th>Doctor</th>
                      <th>Appointment Type</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading
                      ? Array.from({ length: PAGE_SIZE }, (_, index) => (
                          <tr className="admin-appointment-loading-row" key={index}>
                            <td colSpan="5"><span className="admin-skeleton" /></td>
                          </tr>
                        ))
                      : visibleAppointments.map((appointment) => (
                          <tr key={appointment.id}>
                            <td><strong>{appointment.timeLabel}</strong></td>
                            <td>
                              <div className="admin-appointment-person">
                                <span>{getInitials(appointment.patientName)}</span>
                                <div>
                                  <strong>{appointment.patientName}</strong>
                                  <small>{appointment.patientDisplayId}</small>
                                </div>
                              </div>
                            </td>
                            <td>
                              <div className="admin-appointment-doctor">
                                <strong>{appointment.doctorName}</strong>
                                <small>{appointment.doctorSpecialization}</small>
                              </div>
                            </td>
                            <td>{appointment.appointmentType}</td>
                            <td><StatusBadge appointment={appointment} /></td>
                          </tr>
                        ))}
                  </tbody>
                </table>
                {!loading && !visibleAppointments.length ? (
                  <div className="admin-appointment-empty">
                    <Icon icon="solar:calendar-search-linear" />
                    <strong>No appointments found</strong>
                    <p>There are no appointments matching this date and filter set.</p>
                  </div>
                ) : null}
              </div>
            )}

            {!error && !loading ? (
              <footer>
                <p>
                  Showing {firstVisible} to {lastVisible} of {filteredAppointments.length} appointments
                </p>
                <Pagination page={safePage} pageCount={pageCount} onChange={setPage} />
              </footer>
            ) : null}
          </section>
        </div>
    </>
  );
}
