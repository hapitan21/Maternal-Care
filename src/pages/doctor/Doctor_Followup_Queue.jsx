import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "@iconify/react";
import { useSearchParams } from "react-router-dom";
import {
  ClinicalWorkflowHeader,
  ClinicalWorkflowSearch,
} from "../../components/clinical/ClinicalWorkflowUi";
import MedicationAdherenceFollowupModal from "../../components/doctor/MedicationAdherenceFollowupModal";
import {
  loadAssignedMedicationAdherenceFollowupQueue,
} from "../../lib/medicationAdherenceFollowupApi";
import {
  canTransitionMedicationAdherenceFollowup,
  formatMedicationFollowupDateTime,
} from "../../lib/medicationAdherenceFollowups";
import {
  MEDICATION_FOLLOWUP_QUEUE_MAX_CASES,
  MEDICATION_FOLLOWUP_QUEUE_PAGE_SIZE,
  buildMedicationFollowupQueueItems,
  filterAndSortMedicationFollowupQueue,
} from "../../lib/medicationFollowupQueue";
import {
  findAssignedDoctorFollowup,
  getSafeDoctorFollowupId,
} from "../../lib/doctorNotifications";
import "../../styles/doctor-followup-queue.css";

function getPatientInitials(name) {
  return String(name || "Patient")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "PT";
}

function formatAdherenceRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate)) return "Not recorded";
  return `${Math.round(rate)}%`;
}

function getSimpleStatus(item) {
  if (item.category === "overdue") {
    return {
      label: "Overdue",
      className: "is-overdue",
      detail: item.escalation?.relativeText || "Follow-up is overdue",
    };
  }

  if (item.category === "due_today") {
    return {
      label: "Due Today",
      className: "is-due-today",
      detail: item.escalation?.relativeText || "Follow-up is due today",
    };
  }

  if (item.category === "upcoming") {
    return {
      label: "Upcoming",
      className: "is-upcoming",
      detail: item.escalation?.relativeText || "Follow-up is scheduled",
    };
  }

  return {
    label: "Needs Schedule",
    className: "is-unscheduled",
    detail: "No follow-up date has been scheduled",
  };
}

function FollowupCard({
  item,
  onOpen,
}) {
  const { followup } = item;
  const status = getSimpleStatus(item);

  const canMarkContacted = canTransitionMedicationAdherenceFollowup(
    followup.status,
    "contacted"
  );

  const canResolve = canTransitionMedicationAdherenceFollowup(
    followup.status,
    "resolved"
  );

  return (
    <article className={`doctor-followup-simple-card clinical-workflow-card ${status.className}`}>
      <header className="doctor-followup-simple-card-header">
        <div className="doctor-followup-simple-patient">
          <span className="doctor-followup-simple-avatar" aria-hidden="true">
            {getPatientInitials(item.patientName)}
          </span>

          <div>
            <h2>{item.patientName}</h2>
            <p>{item.patientDisplayId}</p>
          </div>
        </div>

        <span className={`doctor-followup-simple-status ${status.className}`}>
          {status.label}
        </span>
      </header>

      <div className="doctor-followup-simple-details">
        <div>
          <span>Adherence Rate</span>
          <strong>{formatAdherenceRate(followup.adherence_rate_snapshot)}</strong>
        </div>

        <div>
          <span>Missed Doses</span>
          <strong>{followup.missed_count_snapshot ?? 0}</strong>
        </div>

        <div>
          <span>Next Follow-up</span>
          <strong>
            {formatMedicationFollowupDateTime(
              followup.next_follow_up_at,
              "Not scheduled"
            )}
          </strong>
        </div>

        <div>
          <span>Last Contact</span>
          <strong>
            {formatMedicationFollowupDateTime(
              followup.last_contacted_at,
              "Not recorded"
            )}
          </strong>
        </div>

      </div>

      <p className={`doctor-followup-simple-due ${status.className}`}>
        <Icon icon="solar:clock-circle-linear" aria-hidden="true" />
        {status.detail}
      </p>

      <footer className="doctor-followup-simple-actions">
        <button
          type="button"
          className="is-primary"
          onClick={() => onOpen(item, "")}
        >
          <Icon icon="solar:eye-linear" aria-hidden="true" />
          Review Details
        </button>

        <button
          type="button"
          disabled={!canMarkContacted}
          onClick={() => onOpen(item, "contacted")}
        >
          <Icon icon="solar:user-check-linear" aria-hidden="true" />
          {followup.status === "contacted"
            ? "Patient Contacted"
            : "Mark Contacted"}
        </button>

        <button
          type="button"
          onClick={() => onOpen(item, "schedule")}
        >
          <Icon icon="solar:calendar-add-linear" aria-hidden="true" />
          {followup.next_follow_up_at ? "Reschedule" : "Schedule"}
        </button>

        {canResolve ? (
          <button
            type="button"
            className="is-resolve"
            onClick={() => onOpen(item, "resolve")}
          >
            <Icon icon="solar:check-circle-linear" aria-hidden="true" />
            Resolve
          </button>
        ) : null}
      </footer>
    </article>
  );
}

export default function DoctorFollowupQueue({
  doctorIdentity,
  doctorName,
  onAttentionChanged,
}) {
  const [searchParams, setSearchParams] = useSearchParams();

  const [dataset, setDataset] = useState({
    followups: [],
    patients: [],
    events: [],
    controlEventsLimited: false,
    generatedAt: "",
  });

  const [loadStatus, setLoadStatus] = useState("loading");
  const [search, setSearch] = useState("");
  const [selectedFollowup, setSelectedFollowup] = useState(null);
  const [visibleCount, setVisibleCount] = useState(
    MEDICATION_FOLLOWUP_QUEUE_PAGE_SIZE
  );
  const [now, setNow] = useState(() => new Date());

  const requestInFlightRef = useRef(false);
  const requestIdRef = useRef(0);
  const pendingFollowupActionRef = useRef(null);

  const doctorId = doctorIdentity.profile?.id || "";

  const requestedFollowupId = String(
    searchParams.get("followupId") || ""
  ).trim();

  const routedFollowupId = getSafeDoctorFollowupId(requestedFollowupId);

  const updateSearch = (value) => {
    setSearch(value);
    setVisibleCount(MEDICATION_FOLLOWUP_QUEUE_PAGE_SIZE);
  };

  const loadQueue = useCallback(async () => {
    if (!doctorId || requestInFlightRef.current) return;

    requestInFlightRef.current = true;

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setLoadStatus((current) =>
      current === "ready" ? "refreshing" : "loading"
    );

    try {
      const nextDataset =
        await loadAssignedMedicationAdherenceFollowupQueue(doctorId);

      if (requestIdRef.current !== requestId) return;

      setDataset(nextDataset);
      setNow(new Date());
      setLoadStatus("ready");
    } catch (error) {
      console.error("Doctor follow-up queue load failed.", {
        name: error?.name || "unknown",
      });

      if (requestIdRef.current === requestId) {
        setLoadStatus("error");
      }
    } finally {
      requestInFlightRef.current = false;
    }
  }, [doctorId]);

  useEffect(() => {
    if (!doctorId) return undefined;

    const initialLoadTimer = window.setTimeout(loadQueue, 0);

    /*
     * Keep the currently rendered page visible and silently refresh
     * follow-up data when the browser regains focus.
     */
    const handleFocus = () => loadQueue();
    window.addEventListener("focus", handleFocus);

    return () => {
      window.clearTimeout(initialLoadTimer);
      window.removeEventListener("focus", handleFocus);
    };
  }, [doctorId, loadQueue]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const queueItems = useMemo(
    () =>
      buildMedicationFollowupQueueItems({
        followups: dataset.followups,
        patients: dataset.patients,
        events: dataset.events,
        doctorName,
        now,
      }),
    [
      dataset.events,
      dataset.followups,
      dataset.patients,
      doctorName,
      now,
    ]
  );

  /*
   * Keep the existing priority order internally, but expose only
   * one understandable search field to the Doctor.
   */
  const filteredItems = useMemo(
    () =>
      filterAndSortMedicationFollowupQueue(queueItems, {
        category: "all",
        status: "all",
        severity: "all",
        escalation: "all",
        search,
        sort: "priority",
      }),
    [queueItems, search]
  );

  useEffect(() => {
    if (loadStatus !== "ready") return;

    const syncTimer = window.setTimeout(() => {
      if (!requestedFollowupId) {
        setSelectedFollowup(null);
        return;
      }

      if (!routedFollowupId) {
        setSelectedFollowup(null);
        return;
      }

      const target = findAssignedDoctorFollowup(
        queueItems,
        routedFollowupId,
        doctorId
      );

      if (!target) {
        setSelectedFollowup(null);
        return;
      }

      setSelectedFollowup((current) => {
        const pendingAction =
          pendingFollowupActionRef.current?.followupId === target.id
            ? pendingFollowupActionRef.current.initialAction
            : "";

        pendingFollowupActionRef.current = null;

        return current?.item?.id === target.id
          ? { ...current, item: target }
          : {
              item: target,
              initialAction: pendingAction,
            };
      });
    }, 0);

    return () => window.clearTimeout(syncTimer);
  }, [
    doctorId,
    loadStatus,
    queueItems,
    requestedFollowupId,
    routedFollowupId,
  ]);

  const visibleItems = filteredItems.slice(0, visibleCount);

  const handleQueueChanged = useCallback(async () => {
    await Promise.all([
      loadQueue(),
      onAttentionChanged?.(),
    ]);
  }, [loadQueue, onAttentionChanged]);

  const handleOpenFollowup = useCallback(
    (item, initialAction) => {
      pendingFollowupActionRef.current = {
        followupId: item.followup.id,
        initialAction,
      };

      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.set("followupId", item.followup.id);
          return next;
        },
        { replace: true }
      );

      Promise.resolve(onAttentionChanged?.()).catch(() => {});
    },
    [onAttentionChanged, setSearchParams]
  );

  const closeRoutedFollowup = useCallback(() => {
    pendingFollowupActionRef.current = null;
    setSelectedFollowup(null);

    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("followupId");
        return next;
      },
      { replace: true }
    );
  }, [setSearchParams]);

  const identityError =
    !doctorIdentity.loading &&
    (doctorIdentity.error || !doctorId);

  const showInitialLoading =
    doctorIdentity.loading ||
    (Boolean(doctorId) &&
      loadStatus === "loading" &&
      !dataset.followups.length);

  const showError =
    Boolean(identityError) ||
    (loadStatus === "error" && !dataset.followups.length);

  return (
    <section
      className="doctor-followup-queue-page doctor-followup-queue-page--simple clinical-workflow clinical-workflow--followups"
      aria-labelledby="doctor-followup-queue-title"
    >
      <ClinicalWorkflowHeader
        title="Medication Follow-ups"
        subtitle="Review adherence risks, contact patients, and schedule the next action."
        titleId="doctor-followup-queue-title"
        className="doctor-followup-simple-header"
      />

      <ClinicalWorkflowSearch
        className="doctor-followup-simple-search"
        value={search}
        onChange={updateSearch}
        onClear={() => updateSearch("")}
        placeholder="Search patient name or patient ID"
        ariaLabel="Search patient name or patient ID"
      />

      {showInitialLoading ? (
        <div
          className="doctor-followup-queue-loading"
          role="status"
          aria-live="polite"
        >
          <span aria-hidden="true" />
          <p>Loading medication follow-ups...</p>
        </div>
      ) : showError ? (
        <div className="doctor-followup-queue-error" role="alert">
          <Icon icon="solar:danger-circle-linear" aria-hidden="true" />

          <div>
            <h2>Medication follow-ups could not be loaded.</h2>
            <p>Please try again. No medication follow-up information was changed.</p>
          </div>

          <button type="button" onClick={() => loadQueue()}>
            Retry
          </button>
        </div>
      ) : (
        <>
          <div className="doctor-followup-simple-results-heading">
            <div>
              <h2>Patients Requiring Attention</h2>
              <p>
                {filteredItems.length
                  ? `${filteredItems.length} medication follow-up${
                      filteredItems.length === 1 ? "" : "s"
                    } found.`
                  : "No active medication follow-ups found."}
              </p>
            </div>

            {loadStatus === "refreshing" ? (
              <span>Updating...</span>
            ) : null}
          </div>

          {visibleItems.length ? (
            <div className="doctor-followup-simple-list">
              {visibleItems.map((item) => (
                <FollowupCard
                  key={item.id}
                  item={item}
                  onOpen={handleOpenFollowup}
                />
              ))}
            </div>
          ) : (
            <div className="doctor-followup-queue-empty">
              <Icon
                icon="solar:clipboard-check-linear"
                aria-hidden="true"
              />

              <h2>
                {search.trim()
                  ? "No Patients match your search."
                  : "No active medication follow-ups."}
              </h2>

              {search.trim() ? (
                <button
                  type="button"
                  onClick={() => updateSearch("")}
                >
                  Clear Search
                </button>
              ) : null}
            </div>
          )}

          {visibleCount < filteredItems.length ? (
            <div className="doctor-followup-queue-load-more">
              <button
                type="button"
                onClick={() =>
                  setVisibleCount(
                    (current) =>
                      current + MEDICATION_FOLLOWUP_QUEUE_PAGE_SIZE
                  )
                }
              >
                Load More
              </button>
            </div>
          ) : null}

          {dataset.followups.length >= MEDICATION_FOLLOWUP_QUEUE_MAX_CASES ? (
            <p className="doctor-followup-simple-limit-note">
              Showing the most recent assigned medication follow-ups.
            </p>
          ) : null}
        </>
      )}

      {selectedFollowup ? (
        <MedicationAdherenceFollowupModal
          patient={selectedFollowup.item.patient}
          liveAlert={null}
          followup={selectedFollowup.item.followup}
          initialAction={selectedFollowup.initialAction}
          onClose={closeRoutedFollowup}
          onChanged={handleQueueChanged}
        />
      ) : null}
    </section>
  );
}
