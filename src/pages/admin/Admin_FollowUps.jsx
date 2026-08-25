import React from "react";
import { Icon } from "@iconify/react";
import { useAdminFollowupOversight } from "../../hooks/useAdminFollowupOversight";
import { useAdminAuth } from "../../hooks/useAdminAuth";
import AdminPageHeader from "../../components/admin/AdminPageHeader";
import {
  ADMIN_FOLLOWUP_PAGE_SIZE,
  adminFollowupEscalationOptions,
  adminFollowupSeverityOptions,
  adminFollowupSortOptions,
  adminFollowupStatusOptions,
  formatAdminFollowupDate,
  formatAdminFollowupDateTime,
  formatAdminFollowupDoctorName,
  formatAdminFollowupEscalation,
  formatAdminFollowupEvent,
  formatAdminFollowupRelativeTime,
  formatAdminFollowupSeverity,
  formatAdminFollowupStatus,
  loadAdminFollowupOversightDetail,
  reassignAdminFollowupDoctor,
} from "../../lib/adminFollowupOversight";
import { recordAuditEvent } from "../../lib/auditLog";
import "../../styles/adminDashboard.css";
import "../../styles/admin-followups.css";

const summaryDefinitions = [
  { key: "activeCases", label: "Active Cases", scope: "Live clinic-wide", icon: "solar:clipboard-list-linear", tone: "active" },
  { key: "dueToday", label: "Due Today", scope: "Live clinic-wide", icon: "solar:clock-circle-linear", tone: "due" },
  { key: "overdue", label: "Overdue", scope: "Live clinic-wide", icon: "solar:danger-triangle-linear", tone: "overdue" },
  { key: "critical", label: "Critical", scope: "Live clinic-wide", icon: "solar:siren-rounded-linear", tone: "critical" },
  { key: "resolved", label: "Resolved", scope: "Selected period", icon: "solar:check-circle-linear", tone: "resolved" },
];

function getInitials(value) {
  return String(value || "Patient")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "PT";
}

function SummaryCard({ definition, value, loading }) {
  return (
    <article className={`admin-followup-summary is-${definition.tone}`}>
      <span aria-hidden="true"><Icon icon={definition.icon} /></span>
      <div>
        <p>{definition.label}</p>
        {loading ? <i className="admin-followup-skeleton is-number" /> : (
          <strong>{value === null ? <span className="admin-followup-unavailable">Not available</span> : value}</strong>
        )}
        <small>{definition.scope}</small>
      </div>
    </article>
  );
}

function FilterSelect({ label, value, onChange, className = "", showLabel = true, children }) {
  return (
    <label className={`admin-followup-filter-field ${className}`.trim()}>
      {showLabel ? <span>{label}</span> : <span aria-hidden="true">&nbsp;</span>}
      <select aria-label={showLabel ? undefined : label} value={value} onChange={onChange}>{children}</select>
    </label>
  );
}

function Badge({ kind, value, children }) {
  return <span className={`admin-followup-badge is-${kind} is-${value}`}>{children}</span>;
}

function DetailValue({ label, value }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function getTimelineDescription(event) {
  if (event.event_type === "doctor_reassigned") {
    return `${formatAdminFollowupDoctorName(event.previous_doctor_name)} to ${formatAdminFollowupDoctorName(event.new_doctor_name)}`;
  }
  const details = [];
  if (event.from_status || event.to_status) {
    details.push(
      `${formatAdminFollowupStatus(event.from_status)} to ${formatAdminFollowupStatus(event.to_status)}`
    );
  }
  if (event.contact_method) {
    details.push(String(event.contact_method).replaceAll("_", " "));
  }
  if (event.next_follow_up_at) {
    details.push(`Scheduled ${formatAdminFollowupDateTime(event.next_follow_up_at)}`);
  }
  return details.join(" | ") || "Activity recorded";
}

function AdminReassignmentDialog({
  detail,
  doctorOptions,
  submitting,
  error,
  onCancel,
  onReassign,
}) {
  const dialogRef = React.useRef(null);
  const firstControlRef = React.useRef(null);
  const [newDoctorId, setNewDoctorId] = React.useState("");
  const [reason, setReason] = React.useState("");
  const availableDoctors = doctorOptions.filter(
    (doctor) => doctor.id !== detail.assigned_doctor_id
  );
  const normalizedReason = reason.trim();
  const reasonValid = normalizedReason.length >= 5 && normalizedReason.length <= 500;

  React.useEffect(() => {
    const restoreFocusTarget = document.activeElement;
    const focusTimer = window.setTimeout(() => firstControlRef.current?.focus(), 0);
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll(
          "button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
        ) || []
      );
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
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleKeyDown);
      window.requestAnimationFrame(() => restoreFocusTarget?.focus());
    };
  }, [onCancel]);

  return (
    <div className="admin-followup-action-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="admin-followup-action-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="admin-followup-action-title"
        aria-describedby="admin-followup-action-description"
      >
        <header>
          <div>
            <p>Administrative control</p>
            <h3 id="admin-followup-action-title">Reassign Doctor</h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            aria-label="Close administrative action"
            title="Close"
          >
            <Icon icon="solar:close-circle-linear" />
          </button>
        </header>

        <div className="admin-followup-action-body">
          <div className="admin-followup-action-patient">
            <span>{getInitials(detail.patient_name)}</span>
            <div><strong>{detail.patient_name}</strong><small>{detail.patient_display_id}</small></div>
          </div>

          <form
            id="admin-followup-reassign-form"
            onSubmit={(event) => {
              event.preventDefault();
              onReassign({ newDoctorId, reason: normalizedReason });
            }}
          >
            <dl>
              <div><dt>Current Doctor</dt><dd>{formatAdminFollowupDoctorName(detail.assigned_doctor_name)}</dd></div>
            </dl>
            <label>
              <span>New Doctor</span>
              <select
                ref={firstControlRef}
                value={newDoctorId}
                onChange={(event) => setNewDoctorId(event.target.value)}
                required
                disabled={submitting}
              >
                <option value="">Select an active Doctor</option>
                {availableDoctors.map((doctor) => (
                  <option key={doctor.id} value={doctor.id}>
                    {formatAdminFollowupDoctorName(doctor.full_name)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Reassignment reason</span>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                minLength={5}
                maxLength={500}
                rows={4}
                required
                disabled={submitting}
                placeholder="Describe the administrative coordination reason."
              />
              <small>{reason.length}/500 characters</small>
            </label>
            <p className="admin-followup-privacy-guidance">
              Do not include diagnosis, medication, dosage, Patient contact details, or other clinical information.
            </p>
            <p id="admin-followup-action-description" className="admin-followup-action-impact">
              This changes the Doctor responsible for future follow-up review. It does not change the Patient&apos;s treatment, medication, adherence record, or current follow-up status.
            </p>
          </form>

          {error ? <p className="admin-followup-action-error" role="alert">{error}</p> : null}
        </div>

        <footer>
          <button type="button" className="is-secondary" onClick={onCancel} disabled={submitting}>Cancel</button>
          <button
            type="submit"
            form="admin-followup-reassign-form"
            className="is-primary"
            disabled={submitting || !newDoctorId || !reasonValid}
          >
            {submitting ? <span className="admin-followup-spinner" /> : <Icon icon="solar:user-speak-linear" />}
            {submitting ? "Saving..." : "Confirm Reassignment"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function AdminFollowupDetailDialog({
  followupId,
  doctorOptions,
  onClose,
  onMutationComplete,
  restoreFocusRef,
}) {
  const closeButtonRef = React.useRef(null);
  const requestIdRef = React.useRef(0);
  const submittingRef = React.useRef(false);
  const reassignmentOpenRef = React.useRef(false);
  const [state, setState] = React.useState({ data: null, loading: true, error: "" });
  const [isReassignmentOpen, setIsReassignmentOpen] = React.useState(false);
  const [management, setManagement] = React.useState({
    submitting: false,
    error: "",
    success: "",
  });

  const loadDetail = React.useCallback(async ({ preserveData = false } = {}) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState((current) => ({
      data: preserveData ? current.data : null,
      loading: !preserveData,
      error: "",
    }));
    try {
      const data = await loadAdminFollowupOversightDetail(followupId);
      if (requestIdRef.current !== requestId) return;
      if (!data) throw new Error("This follow-up could not be found.");
      setState({ data, loading: false, error: "" });
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setState({
        data: null,
        loading: false,
        error: error?.message || "Follow-up detail could not be loaded.",
      });
    }
  }, [followupId]);

  React.useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const restoreFocusTarget = restoreFocusRef.current;
    document.body.style.overflow = "hidden";
    const loadTimer = window.setTimeout(loadDetail, 0);
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const handleDialogKeyDown = (event) => {
      if (event.key === "Escape") {
        if (reassignmentOpenRef.current) return;
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      if (reassignmentOpenRef.current) return;

      const focusable = Array.from(
        document.querySelectorAll(
          ".admin-followup-modal button:not([disabled]), .admin-followup-modal [href], .admin-followup-modal [tabindex]:not([tabindex='-1'])"
        )
      );
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
    window.addEventListener("keydown", handleDialogKeyDown);
    return () => {
      requestIdRef.current += 1;
      window.clearTimeout(loadTimer);
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleDialogKeyDown);
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => restoreFocusTarget?.focus());
    };
  }, [loadDetail, onClose, restoreFocusRef]);

  const detail = state.data;
  const timeline = Array.isArray(detail?.timeline) ? detail.timeline : [];
  const openReassignment = React.useCallback(() => {
    reassignmentOpenRef.current = true;
    setIsReassignmentOpen(true);
    setManagement((current) => ({ ...current, error: "", success: "" }));
  }, []);
  const closeReassignment = React.useCallback(() => {
    if (submittingRef.current) return;
    reassignmentOpenRef.current = false;
    setIsReassignmentOpen(false);
    setManagement((current) => ({ ...current, error: "" }));
  }, []);

  const completeMutation = React.useCallback(async (success) => {
    reassignmentOpenRef.current = false;
    setIsReassignmentOpen(false);
    setManagement({ submitting: false, error: "", success });
    await Promise.all([
      loadDetail({ preserveData: true }),
      Promise.resolve(onMutationComplete()),
    ]);
  }, [loadDetail, onMutationComplete]);

  const handleReassign = React.useCallback(async ({ newDoctorId, reason }) => {
    if (submittingRef.current || !detail) return;
    submittingRef.current = true;
    setManagement({ submitting: true, error: "", success: "" });
    try {
      const result = await reassignAdminFollowupDoctor({
        followupId,
        newDoctorId,
        reason,
        expectedUpdatedAt: detail.updated_at,
      });
      await recordAuditEvent({
        module: "reminder_management",
        action: "reassign",
        entityType: "medication_adherence_followup",
        entityId: followupId,
        description: "Medication follow-up reassigned from one Doctor to another.",
      });
      await completeMutation(
        `Follow-up reassigned to ${formatAdminFollowupDoctorName(result?.new_doctor_name)}.`
      );
    } catch (error) {
      if (error.code === "40001") {
        reassignmentOpenRef.current = false;
        setIsReassignmentOpen(false);
        setManagement({ submitting: false, error: error.message, success: "" });
        await loadDetail({ preserveData: true });
      } else {
        setManagement({ submitting: false, error: error.message, success: "" });
      }
    } finally {
      submittingRef.current = false;
    }
  }, [completeMutation, detail, followupId, loadDetail]);

  return (
    <div
      className="admin-followup-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="admin-followup-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-followup-detail-title"
      >
        <header>
          <div>
            <p>Admin case review</p>
            <h2 id="admin-followup-detail-title">Follow-up Details</h2>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Close follow-up details" title="Close">
            <Icon icon="solar:close-circle-linear" />
          </button>
        </header>

        {state.loading ? (
          <div className="admin-followup-modal-loading" role="status">
            <span className="admin-followup-spinner" />
            Loading follow-up details...
          </div>
        ) : null}

        {state.error ? (
          <div className="admin-followup-modal-error" role="alert">
            <Icon icon="solar:danger-triangle-linear" />
            <span>{state.error}</span>
            <button type="button" onClick={() => loadDetail()}>Retry</button>
          </div>
        ) : null}

        {detail ? (
          <div className="admin-followup-modal-body">
            {management.success ? (
              <p className="admin-followup-management-message is-success" role="status">
                <Icon icon="solar:check-circle-linear" /> {management.success}
              </p>
            ) : null}
            {management.error && !isReassignmentOpen ? (
              <p className="admin-followup-management-message is-error" role="alert">
                <Icon icon="solar:danger-triangle-linear" /> {management.error}
              </p>
            ) : null}
            <section className="admin-followup-detail-heading">
              <span>{getInitials(detail.patient_name)}</span>
              <div>
                <h3>{detail.patient_name}</h3>
                <p>{detail.patient_display_id}</p>
              </div>
              <div className="admin-followup-detail-badges">
                <Badge kind="status" value={detail.status}>{formatAdminFollowupStatus(detail.status)}</Badge>
                <Badge kind="severity" value={detail.severity}>{formatAdminFollowupSeverity(detail.severity)}</Badge>
                <Badge kind="escalation" value={detail.escalation}>{formatAdminFollowupEscalation(detail.escalation)}</Badge>
              </div>
            </section>

            <section className="admin-followup-detail-section admin-followup-assignment">
              <h3>Assignment</h3>
              <div className="admin-followup-assignment-row">
                <dl className="admin-followup-detail-grid">
                  <DetailValue label="Assigned Doctor" value={formatAdminFollowupDoctorName(detail.assigned_doctor_name)} />
                </dl>
                {detail.status === "resolved" ? (
                  <p className="admin-followup-historical-note">
                    This historical case is resolved and cannot be reassigned.
                  </p>
                ) : (
                  <button type="button" className="is-reassign" onClick={openReassignment}>
                    <Icon icon="solar:user-speak-linear" /> Reassign Doctor
                  </button>
                )}
              </div>
            </section>

            <section className="admin-followup-detail-section">
              <h3>Schedule / Monitoring</h3>
              <dl className="admin-followup-detail-grid">
                <DetailValue label="Case created" value={formatAdminFollowupDateTime(detail.created_at)} />
                <DetailValue label="Last updated" value={formatAdminFollowupDateTime(detail.updated_at)} />
                <DetailValue label="Last contacted" value={formatAdminFollowupDateTime(detail.last_contacted_at)} />
                <DetailValue label="Next follow-up" value={formatAdminFollowupDateTime(detail.next_follow_up_at, "Not scheduled")} />
                <DetailValue label="Resolved" value={formatAdminFollowupDateTime(detail.resolved_at, "Not resolved")} />
              </dl>
              {detail.is_snoozed ? (
                <p className="admin-followup-snooze-note">
                  <Icon icon="solar:alarm-sleep-linear" />
                  Alert snoozed until {formatAdminFollowupDateTime(detail.snoozed_until)}
                </p>
              ) : null}
            </section>

            <section className="admin-followup-detail-section">
              <h3>Activity</h3>
              {timeline.length ? (
                <ol className="admin-followup-timeline">
                  {timeline.map((event) => (
                    <li key={event.id}>
                      <span aria-hidden="true"><Icon icon="solar:history-linear" /></span>
                      <div>
                        <strong>{formatAdminFollowupEvent(event.event_type)}</strong>
                        <p>{getTimelineDescription(event)}</p>
                        <small>
                          {event.event_type === "doctor_reassigned" ? "Changed" : "Recorded"} by {event.actor_name || "Clinic user"} | {formatAdminFollowupDateTime(event.created_at)}
                        </small>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : <p className="admin-followup-no-timeline">No privacy-safe activity is available.</p>}
            </section>
          </div>
        ) : null}

        {isReassignmentOpen && detail ? (
          <AdminReassignmentDialog
            detail={detail}
            doctorOptions={doctorOptions}
            submitting={management.submitting}
            error={management.error}
            onCancel={closeReassignment}
            onReassign={handleReassign}
          />
        ) : null}
      </section>
    </div>
  );
}

export default function AdminFollowUps() {
  const { isAdmin } = useAdminAuth();
  const [searchInput, setSearchInput] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [severity, setSeverity] = React.useState("");
  const [escalation, setEscalation] = React.useState("");
  const [doctorId, setDoctorId] = React.useState("");
  const [startDate, setStartDate] = React.useState("");
  const [endDate, setEndDate] = React.useState("");
  const [sort, setSort] = React.useState("most_urgent");
  const [page, setPage] = React.useState(1);
  const [detailId, setDetailId] = React.useState("");
  const detailTriggerRef = React.useRef(null);
  const closeDetail = React.useCallback(() => setDetailId(""), []);
  const dateError = startDate && endDate && startDate > endDate
    ? "Start date must not be after end date."
    : "";

  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(searchInput.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const filters = React.useMemo(() => ({
    search: debouncedSearch,
    status,
    severity,
    escalation,
    doctorId,
    startDate,
    endDate,
    sort,
  }), [debouncedSearch, doctorId, endDate, escalation, severity, sort, startDate, status]);
  const oversight = useAdminFollowupOversight({
    enabled: isAdmin,
    filters,
    page,
    valid: !dateError,
  });

  const updateFilter = (setter) => (event) => {
    setter(event.target.value);
    setPage(1);
  };
  const clearFilters = () => {
    setSearchInput("");
    setDebouncedSearch("");
    setStatus("");
    setSeverity("");
    setEscalation("");
    setDoctorId("");
    setStartDate("");
    setEndDate("");
    setSort("most_urgent");
    setPage(1);
  };
  const openDetail = (event, followupId) => {
    detailTriggerRef.current = event.currentTarget;
    setDetailId(followupId);
  };

  const activeFilterCount = [
    debouncedSearch,
    status,
    severity,
    escalation,
    doctorId,
    startDate || endDate ? "case_created_date" : "",
  ].filter(Boolean).length;
  const pageCount = Math.max(1, Math.ceil(oversight.totalCount / ADMIN_FOLLOWUP_PAGE_SIZE));
  const firstRow = oversight.totalCount ? (page - 1) * ADMIN_FOLLOWUP_PAGE_SIZE + 1 : 0;
  const lastRow = Math.min(page * ADMIN_FOLLOWUP_PAGE_SIZE, oversight.totalCount);
  return (
    <>
        <AdminPageHeader
          className="admin-followup-title"
          title="Medication Follow-up Oversight"
          subtitle="Monitor clinic-wide medication adherence cases, escalation levels, and follow-up progress."
        />

        <section className="admin-followup-summary-grid" aria-label="Follow-up summary">
          {summaryDefinitions.map((definition) => (
            <SummaryCard
              key={definition.key}
              definition={definition}
              value={oversight.summary[definition.key]}
              loading={oversight.loading}
            />
          ))}
        </section>

        <section className="admin-followup-toolbar" aria-label="Follow-up queue controls">
          <div className="admin-followup-filter-primary">
            <label className="admin-followup-search">
              <Icon icon="solar:magnifer-linear" aria-hidden="true" />
              <span className="admin-sr-only">Search by Patient name or Patient ID</span>
              <input
                type="search"
                value={searchInput}
                maxLength={120}
                placeholder="Search Patient name or ID..."
                onChange={(event) => {
                  setSearchInput(event.target.value);
                  setPage(1);
                }}
              />
            </label>
            <FilterSelect className="admin-followup-status-filter" label="Status" value={status} onChange={updateFilter(setStatus)}>
              {adminFollowupStatusOptions.map((option) => <option key={option.value || "all"} value={option.value}>{option.label}</option>)}
            </FilterSelect>
            <FilterSelect className="admin-followup-severity-filter" label="Severity" value={severity} onChange={updateFilter(setSeverity)}>
              {adminFollowupSeverityOptions.map((option) => <option key={option.value || "all"} value={option.value}>{option.label}</option>)}
            </FilterSelect>
            <FilterSelect className="admin-followup-escalation-filter" label="Escalation" value={escalation} onChange={updateFilter(setEscalation)}>
              {adminFollowupEscalationOptions.map((option) => <option key={option.value || "all"} value={option.value}>{option.label}</option>)}
            </FilterSelect>
            <FilterSelect className="admin-followup-doctor-filter" label="Assigned Doctor" value={doctorId} onChange={updateFilter(setDoctorId)}>
              <option value="">All Doctors</option>
              {oversight.summary.doctorOptions.map((doctor) => (
                <option key={doctor.id} value={doctor.id}>{formatAdminFollowupDoctorName(doctor.full_name)}</option>
              ))}
            </FilterSelect>
          </div>

          <div className="admin-followup-filter-secondary">
            <fieldset className="admin-followup-date-filter">
              <legend>Case Created Date</legend>
              <div>
                <label className="admin-followup-filter-field">
                  <span>From</span>
                  <input type="date" value={startDate} onChange={updateFilter(setStartDate)} />
                </label>
                <label className="admin-followup-filter-field">
                  <span>To</span>
                  <input type="date" value={endDate} onChange={updateFilter(setEndDate)} />
                </label>
              </div>
              <small>
                Limits queue cases by creation date. Live cards remain clinic-wide; Resolved uses this range by resolution date.
              </small>
            </fieldset>
            <fieldset className="admin-followup-sort-group">
              <legend>Sort</legend>
              <FilterSelect className="admin-followup-sort-filter" label="Sort" showLabel={false} value={sort} onChange={updateFilter(setSort)}>
                {adminFollowupSortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </FilterSelect>
            </fieldset>
          </div>

          <div className="admin-followup-filter-actions">
            <div className="admin-followup-toolbar-actions">
              <button type="button" className="is-clear" onClick={clearFilters} disabled={!activeFilterCount}>
                <Icon icon="solar:restart-linear" /> Clear Filters
              </button>
              <button type="button" className="is-refresh" onClick={oversight.refresh} disabled={oversight.loading || oversight.refreshing || Boolean(dateError)}>
                <Icon icon="solar:refresh-linear" /> {oversight.refreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
            <p className="admin-followup-filter-count" aria-live="polite">
              {activeFilterCount} active filter{activeFilterCount === 1 ? "" : "s"}
            </p>
          </div>
          {startDate || endDate ? (
            <div className="admin-followup-active-filters" aria-label="Active date filters">
              <span>
                Case Created Date: {startDate ? formatAdminFollowupDate(startDate) : "Any date"}
                {" to "}
                {endDate ? formatAdminFollowupDate(endDate) : "Any date"}
                <button
                  type="button"
                  aria-label="Remove Case Created Date filter"
                  title="Remove Case Created Date filter"
                  onClick={() => {
                    setStartDate("");
                    setEndDate("");
                    setPage(1);
                  }}
                >
                  <Icon icon="solar:close-circle-linear" />
                </button>
              </span>
            </div>
          ) : null}
          {dateError ? <p className="admin-followup-date-error" role="alert">{dateError}</p> : null}
        </section>

        {oversight.error ? (
          <div className="admin-followup-error" role="alert">
            <Icon icon="solar:danger-triangle-linear" />
            <span>{oversight.error}</span>
            <button type="button" onClick={oversight.refresh}>Retry</button>
          </div>
        ) : null}

        <section className="admin-followup-queue" aria-labelledby="admin-followup-queue-title">
          <header>
            <div>
              <h2 id="admin-followup-queue-title">Clinic Follow-up Queue</h2>
              <p>{oversight.totalCount} case{oversight.totalCount === 1 ? "" : "s"} match the current view.</p>
            </div>
            <small>Asia/Manila scheduling</small>
          </header>

          <div className="admin-followup-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Patient</th><th>Patient ID</th><th>Status</th><th>Severity</th>
                  <th>Escalation</th><th>Assigned Doctor</th><th>Case Created</th>
                  <th>Last Contacted</th><th>Next Follow-up</th><th>Timing</th><th><span className="admin-sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {oversight.loading ? Array.from({ length: 8 }, (_, index) => (
                  <tr key={index} className="admin-followup-loading-row"><td colSpan="11"><span className="admin-followup-skeleton" /></td></tr>
                )) : null}
                {!oversight.loading ? oversight.rows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Patient"><div className="admin-followup-person"><span>{getInitials(row.patient_name)}</span><strong>{row.patient_name}</strong></div></td>
                    <td data-label="Patient ID">{row.patient_display_id}</td>
                    <td data-label="Status"><Badge kind="status" value={row.status}>{formatAdminFollowupStatus(row.status)}</Badge></td>
                    <td data-label="Severity"><Badge kind="severity" value={row.severity}>{formatAdminFollowupSeverity(row.severity)}</Badge></td>
                    <td data-label="Escalation">
                      <Badge kind="escalation" value={row.escalation}>{formatAdminFollowupEscalation(row.escalation)}</Badge>
                      {row.is_snoozed ? <small className="admin-followup-row-snoozed">Snoozed</small> : null}
                    </td>
                    <td data-label="Assigned Doctor">{formatAdminFollowupDoctorName(row.assigned_doctor_name)}</td>
                    <td data-label="Case Created">{formatAdminFollowupDateTime(row.created_at)}</td>
                    <td data-label="Last Contacted">{formatAdminFollowupDateTime(row.last_contacted_at)}</td>
                    <td data-label="Next Follow-up">{formatAdminFollowupDateTime(row.next_follow_up_at, "Not scheduled")}</td>
                    <td data-label="Timing"><strong className={`admin-followup-relative is-${row.escalation}`}>{formatAdminFollowupRelativeTime(row)}</strong></td>
                    <td data-label="Action"><button type="button" className="admin-followup-view" onClick={(event) => openDetail(event, row.id)}><Icon icon="solar:eye-linear" /> View</button></td>
                  </tr>
                )) : null}
              </tbody>
            </table>
            {!oversight.loading && !oversight.error && !oversight.rows.length ? (
              <div className="admin-followup-empty">
                <Icon icon="solar:clipboard-remove-linear" />
                <h3>No follow-up cases found</h3>
                <p>Adjust the filters or refresh the queue.</p>
              </div>
            ) : null}
          </div>

          <footer>
            <p>Showing {firstRow}-{lastRow} of {oversight.totalCount}</p>
            <nav aria-label="Follow-up queue pagination">
              <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1 || oversight.loading} aria-label="Previous page"><Icon icon="solar:alt-arrow-left-linear" /></button>
              <span>Page {page} of {pageCount}</span>
              <button type="button" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={page >= pageCount || oversight.loading} aria-label="Next page"><Icon icon="solar:alt-arrow-right-linear" /></button>
            </nav>
          </footer>
        </section>

      {detailId ? (
        <AdminFollowupDetailDialog
          followupId={detailId}
          doctorOptions={oversight.summary.doctorOptions}
          onClose={closeDetail}
          onMutationComplete={oversight.refresh}
          restoreFocusRef={detailTriggerRef}
        />
      ) : null}
    </>
  );
}
