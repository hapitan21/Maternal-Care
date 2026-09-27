import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { supabase } from "../lib/supabaseClient";
import {
  formatAppointmentDate,
  formatAppointmentTime,
  getManilaDateKey,
} from "../lib/appointmentDate";
import {
  adminAppointmentStatusDefinitions,
  mapAdminAuditActivity,
} from "../lib/adminDashboard";
import {
  getAdminWorkspaceSnapshot,
  setAdminWorkspaceSnapshot,
} from "../lib/adminWorkspaceSnapshots";

const dashboardSnapshotNamespace = "dashboard";

const supportedAdminAlertTargets = new Set([
  "users",
  "appointments",
  "reports",
  "logs",
  "dashboard",
]);

const emptyTotals = {
  totalUsers: 0,
  patients: 0,
  doctors: 0,
  staff: 0,
  admins: 0,
  totalAppointments: 0,
  pendingAppointments: 0,
  todaysAppointments: 0,
};

function dateFromKey(dateKey) {
  const [year, month, day] = String(dateKey || "")
    .split("-")
    .map(Number);

  return new Date(Date.UTC(year, month - 1, day));
}

function dateKeyFromDate(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function addDays(dateKey, days) {
  const date = dateFromKey(dateKey);
  date.setUTCDate(date.getUTCDate() + days);

  return dateKeyFromDate(date);
}

function addMonths(dateKey, months) {
  const date = dateFromKey(dateKey);
  date.setUTCMonth(date.getUTCMonth() + months);

  return dateKeyFromDate(date);
}

function mondayForDate(dateKey) {
  const date = dateFromKey(dateKey);
  const weekday = date.getUTCDay();

  return addDays(dateKey, weekday === 0 ? -6 : 1 - weekday);
}

function formatDateKey(dateKey, options) {
  return new Date(`${dateKey}T00:00:00+08:00`).toLocaleDateString(
    "en-US",
    {
      timeZone: "Asia/Manila",
      ...options,
    }
  );
}

function getDateRangeConfig(dateRange) {
  const todayKey = getManilaDateKey(new Date());
  const [year, month] = todayKey.split("-");

  const normalized = ["today", "week", "month", "year"].includes(
    dateRange
  )
    ? dateRange
    : "month";

  if (normalized === "today") {
    return {
      key: normalized,
      label: "Today",
      startKey: todayKey,
      endKey: addDays(todayKey, 1),
      endDate: todayKey,
      trendMode: "daily",
      trendLabel: "day",
    };
  }

  if (normalized === "week") {
    const startKey = mondayForDate(todayKey);

    return {
      key: normalized,
      label: "This Week",
      startKey,
      endKey: addDays(startKey, 7),
      endDate: addDays(startKey, 6),
      trendMode: "daily",
      trendLabel: "day",
    };
  }

  if (normalized === "year") {
    const startKey = `${year}-01-01`;

    return {
      key: normalized,
      label: "This Year",
      startKey,
      endKey: `${Number(year) + 1}-01-01`,
      endDate: `${year}-12-31`,
      trendMode: "monthly",
      trendLabel: "month",
    };
  }

  const startKey = `${year}-${month}-01`;
  const endKey = addMonths(startKey, 1);

  return {
    key: "month",
    label: "This Month",
    startKey,
    endKey,
    endDate: addDays(endKey, -1),
    trendMode: "weekly",
    trendLabel: "week",
  };
}

function createRegistrationBuckets(range) {
  const buckets = [];

  if (range.trendMode === "monthly") {
    for (
      let key = range.startKey;
      key < range.endKey;
      key = addMonths(key, 1)
    ) {
      buckets.push({
        key: key.slice(0, 7),
        label: formatDateKey(key, {
          month: "short",
        }),
        value: 0,
      });
    }

    return buckets;
  }

  if (range.trendMode === "weekly") {
    for (
      let key = mondayForDate(range.startKey);
      key < range.endKey;
      key = addDays(key, 7)
    ) {
      buckets.push({
        key,
        label: formatDateKey(key, {
          month: "short",
          day: "numeric",
        }),
        value: 0,
      });
    }

    return buckets;
  }

  for (
    let key = range.startKey;
    key < range.endKey;
    key = addDays(key, 1)
  ) {
    buckets.push({
      key,
      label: formatDateKey(key, {
        weekday: range.key === "week" ? "short" : undefined,
        month: "short",
        day: "numeric",
      }),
      value: 0,
    });
  }

  return buckets;
}

function mergeRegistrationTrend(rows, range) {
  const values = new Map(
    (rows || []).map((row) => [
      String(row.key),
      Number(row.value) || 0,
    ])
  );

  return createRegistrationBuckets(range).map((bucket) => ({
    ...bucket,
    value: values.get(bucket.key) || 0,
  }));
}

function mapAppointmentOverview(rows) {
  const values = new Map(
    (rows || []).map((row) => [
      String(row.status),
      Number(row.value) || 0,
    ])
  );

  const total = adminAppointmentStatusDefinitions.reduce(
    (sum, definition) =>
      sum + (values.get(definition.status) || 0),
    0
  );

  return adminAppointmentStatusDefinitions.map((definition) => {
    const value = values.get(definition.status) || 0;

    return {
      ...definition,
      value,
      percent: total
        ? Math.round((value / total) * 100)
        : 0,
    };
  });
}

function mapSummary(payload, range) {
  const totals = payload?.totals || {};

  return {
    totals: {
      totalUsers: Number(totals.total_users) || 0,
      patients: Number(totals.patients) || 0,
      doctors: Number(totals.doctors) || 0,
      staff: Number(totals.staff) || 0,
      admins: Number(totals.admins) || 0,
      totalAppointments: Number(totals.total_appointments) || 0,
      pendingAppointments:
        Number(totals.pending_appointments) || 0,
      todaysAppointments:
        Number(totals.todays_appointments) || 0,
    },

    appointmentOverview: mapAppointmentOverview(
      payload?.appointment_overview
    ),

    registrationTrend: mergeRegistrationTrend(
      payload?.registration_trend,
      range
    ),

    systemAlerts: Array.isArray(payload?.system_alerts)
      ? payload.system_alerts.filter((alert) =>
          supportedAdminAlertTargets.has(alert?.target)
        )
      : [],

    generatedAt: payload?.generated_at || null,
  };
}

function formatActivityTime(value) {
  const date = value ? new Date(value) : null;

  if (!date || Number.isNaN(date.getTime())) {
    return "Time unavailable";
  }

  return `${formatAppointmentDate(
    date
  )} at ${formatAppointmentTime(date)}`;
}

async function querySummary(range) {
  const { data, error } = await supabase.rpc(
    "get_admin_dashboard_summary",
    {
      p_start_date: range.startKey,
      p_end_date: range.endDate,
      p_trend_mode: range.trendMode,
    }
  );

  return { data, error };
}

async function queryRecentActivity() {
  const { data, error } = await supabase
    .from("audit_logs")
    .select(
      "id, actor_name, actor_role, module, action, description, created_at"
    )
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(8);

  return { data, error };
}

function createEmptySummary(range) {
  return {
    totals: emptyTotals,
    appointmentOverview: mapAppointmentOverview([]),
    registrationTrend: createRegistrationBuckets(range),
    systemAlerts: [],
    generatedAt: null,
  };
}

function hasSnapshotValue(snapshot, key) {
  return Boolean(
    snapshot &&
      Object.prototype.hasOwnProperty.call(snapshot, key)
  );
}

export function useAdminDashboardData(
  dateRange,
  enabled = true,
  adminId = ""
) {
  const requestIdRef = useRef(0);
  const realtimeTimerRef = useRef(null);
  const refreshPromiseRef = useRef(null);

  const range = useMemo(
    () => getDateRangeConfig(dateRange),
    [dateRange]
  );

  const snapshotKey =
    `${range.key}:${range.startKey}:${range.endDate}`;

  const stateKey = `${adminId}:${snapshotKey}`;

  const initialSnapshot = getAdminWorkspaceSnapshot(
    dashboardSnapshotNamespace,
    adminId,
    snapshotKey
  );

  const initialHasSummary = hasSnapshotValue(
    initialSnapshot,
    "summary"
  );

  const initialHasActivities = hasSnapshotValue(
    initialSnapshot,
    "recentActivities"
  );

  const [summaryState, setSummaryState] = useState(() => ({
    data: initialHasSummary
      ? initialSnapshot.summary
      : createEmptySummary(range),
    snapshotKey: stateKey,
    loading: Boolean(enabled && !initialHasSummary),
    error: null,
  }));

  const [activityState, setActivityState] = useState(() => ({
    data: initialHasActivities
      ? initialSnapshot.recentActivities
      : [],
    snapshotKey: stateKey,
    loading: Boolean(enabled && !initialHasActivities),
    error: null,
  }));

  const refresh = useCallback(
    ({ force = false } = {}) => {
      const refreshKey =
        `${adminId}:${enabled ? "enabled" : "disabled"}:${snapshotKey}`;

      if (
        !force &&
        refreshPromiseRef.current?.key === refreshKey
      ) {
        return refreshPromiseRef.current.promise;
      }

      const refreshPromise = (async () => {
        const requestId = requestIdRef.current + 1;
        requestIdRef.current = requestId;

        if (!enabled || !adminId) {
          setSummaryState((current) => ({
            ...current,
            loading: false,
          }));

          setActivityState((current) => ({
            ...current,
            loading: false,
          }));

          return;
        }

        const cachedSnapshot = getAdminWorkspaceSnapshot(
          dashboardSnapshotNamespace,
          adminId,
          snapshotKey
        );

        const hasCachedSummary = hasSnapshotValue(
          cachedSnapshot,
          "summary"
        );

        const hasCachedActivities = hasSnapshotValue(
          cachedSnapshot,
          "recentActivities"
        );

        setSummaryState({
          data: hasCachedSummary
            ? cachedSnapshot.summary
            : createEmptySummary(range),
          snapshotKey: stateKey,
          loading: !hasCachedSummary,
          error: null,
        });

        setActivityState({
          data: hasCachedActivities
            ? cachedSnapshot.recentActivities
            : [],
          snapshotKey: stateKey,
          loading: !hasCachedActivities,
          error: null,
        });

        let summaryResult;
        let activityResult;

        try {
          [summaryResult, activityResult] = await Promise.all([
            querySummary(range),
            queryRecentActivity(),
          ]);
        } catch (unexpectedError) {
          if (requestIdRef.current !== requestId) {
            return;
          }

          setSummaryState((current) => ({
            ...current,
            loading: false,
            error: hasCachedSummary
              ? null
              : unexpectedError,
          }));

          setActivityState((current) => ({
            ...current,
            loading: false,
            error: hasCachedActivities
              ? null
              : unexpectedError,
          }));

          return;
        }

        if (requestIdRef.current !== requestId) {
          return;
        }

        if (summaryResult.error) {
          setSummaryState((current) => ({
            ...current,
            loading: false,
            error: hasCachedSummary
              ? null
              : summaryResult.error,
          }));
        } else {
          const nextSummary = mapSummary(
            summaryResult.data,
            range
          );

          setSummaryState({
            data: nextSummary,
            snapshotKey: stateKey,
            loading: false,
            error: null,
          });

          setAdminWorkspaceSnapshot(
            dashboardSnapshotNamespace,
            adminId,
            snapshotKey,
            {
              ...cachedSnapshot,
              summary: nextSummary,
            }
          );
        }

        if (activityResult.error) {
          setActivityState((current) => ({
            ...current,
            loading: false,
            error: hasCachedActivities
              ? null
              : activityResult.error,
          }));
        } else {
          const nextActivities = (
            activityResult.data || []
          ).map((row) =>
            mapAdminAuditActivity(
              row,
              formatActivityTime
            )
          );

          setActivityState({
            data: nextActivities,
            snapshotKey: stateKey,
            loading: false,
            error: null,
          });

          const latestSnapshot =
            getAdminWorkspaceSnapshot(
              dashboardSnapshotNamespace,
              adminId,
              snapshotKey
            );

          setAdminWorkspaceSnapshot(
            dashboardSnapshotNamespace,
            adminId,
            snapshotKey,
            {
              ...latestSnapshot,
              recentActivities: nextActivities,
            }
          );
        }
      })();

      refreshPromiseRef.current = {
        key: refreshKey,
        promise: refreshPromise,
      };

      return refreshPromise.finally(() => {
        if (
          refreshPromiseRef.current?.promise ===
          refreshPromise
        ) {
          refreshPromiseRef.current = null;
        }
      });
    },
    [
      adminId,
      enabled,
      range,
      snapshotKey,
      stateKey,
    ]
  );

  useEffect(() => {
    let realtimeActive = true;
    let scheduleRefreshInFlight = false;
    let scheduleRefreshTrailing = false;

    const initialTimer = window.setTimeout(
      refresh,
      0
    );

    /*
     * Safety fallback only.
     *
     * Broadcast is the primary appointment update path.
     * Polling guarantees eventual consistency if the client temporarily
     * loses its Realtime connection.
     */
    const pollingTimer = enabled
      ? window.setInterval(() => {
          void refresh();
        }, 60_000)
      : null;

    /*
     * Focus refresh remains a second safety fallback.
     */
    const handleFocus = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };

    /*
     * Perform one authoritative Dashboard refresh at a time.
     *
     * Multiple schedule changes received while a request is running are
     * coalesced into one trailing refresh.
     */
    const scheduleRefresh = () => {
      if (!realtimeActive) {
        return;
      }

      if (scheduleRefreshInFlight) {
        scheduleRefreshTrailing = true;
        return;
      }

      scheduleRefreshInFlight = true;

      void refresh({
        force: true,
      })
        .catch(() => {
          // Existing Dashboard error state owns refresh failures.
        })
        .finally(() => {
          scheduleRefreshInFlight = false;

          if (
            !realtimeActive ||
            !scheduleRefreshTrailing
          ) {
            return;
          }

          scheduleRefreshTrailing = false;

          scheduleRefresh();
        });
    };

    /*
     * Profiles retain their existing background Postgres Changes refresh.
     */
    const backgroundRefresh = () => {
      window.clearTimeout(
        realtimeTimerRef.current
      );

      realtimeTimerRef.current =
        window.setTimeout(() => {
          void refresh();
        }, 250);
    };

    /*
     * Primary schedule update path.
     *
     * The database trigger broadcasts:
     *
     *   topic: admin:schedule
     *   event: schedule_changed
     *   private: true
     *
     * No Patient information is transmitted in the Broadcast payload.
     * The event only tells the Admin client to perform an authoritative
     * Dashboard refresh.
     */
    const scheduleBroadcastChannel =
      enabled && adminId
        ? supabase
            .channel("admin:schedule", {
              config: {
                private: true,
              },
            })
            .on(
              "broadcast",
              {
                event: "schedule_changed",
              },
              scheduleRefresh
            )
            .subscribe((status) => {
              if (
                status === "SUBSCRIBED" &&
                realtimeActive
              ) {
                /*
                 * Broadcast does not replay events missed while disconnected.
                 * Revalidate once after each successful subscription or
                 * reconnection.
                 */
                scheduleRefresh();
              }
            })
        : null;

    /*
     * Primary audit-log update path.
     *
     * The database trigger broadcasts only an invalidation operation:
     *
     *   topic: admin:audit-logs
     *   event: audit_log_changed
     *   private: true
     *
     * Reuse the existing authoritative in-flight/trailing refresh so
     * schedule and audit invalidations cannot create competing fetches.
     */
    const auditLogBroadcastChannel =
      enabled && adminId
        ? supabase
            .channel("admin:audit-logs", {
              config: {
                private: true,
              },
            })
            .on(
              "broadcast",
              {
                event: "audit_log_changed",
              },
              scheduleRefresh
            )
            .subscribe((status) => {
              if (
                status === "SUBSCRIBED" &&
                realtimeActive
              ) {
                /*
                 * Recover audit events missed while disconnected by
                 * performing one authoritative catch-up refresh.
                 */
                scheduleRefresh();
              }
            })
        : null;

    /*
     * Non-Broadcast Dashboard background refresh signals.
     *
     * Schedule and audit logs are intentionally excluded because their
     * mutations now use the private Database Broadcast channels above.
     */
    const backgroundChannel =
      enabled && adminId
        ? supabase
            .channel(
              `admin-dashboard-background-${adminId}-${range.key}`
            )
            .on(
              "postgres_changes",
              {
                event: "*",
                schema: "public",
                table: "profiles",
              },
              backgroundRefresh
            )
            .subscribe()
        : null;

    window.addEventListener(
      "focus",
      handleFocus
    );

    return () => {
      realtimeActive = false;
      scheduleRefreshTrailing = false;

      requestIdRef.current += 1;
      refreshPromiseRef.current = null;

      window.clearTimeout(initialTimer);

      window.clearTimeout(
        realtimeTimerRef.current
      );

      if (pollingTimer) {
        window.clearInterval(
          pollingTimer
        );
      }

      window.removeEventListener(
        "focus",
        handleFocus
      );

      if (scheduleBroadcastChannel) {
        supabase.removeChannel(
          scheduleBroadcastChannel
        );
      }

      if (auditLogBroadcastChannel) {
        supabase.removeChannel(
          auditLogBroadcastChannel
        );
      }

      if (backgroundChannel) {
        supabase.removeChannel(
          backgroundChannel
        );
      }
    };
  }, [
    adminId,
    enabled,
    range.endDate,
    range.key,
    range.label,
    range.startKey,
    refresh,
  ]);

  const renderSnapshot =
    getAdminWorkspaceSnapshot(
      dashboardSnapshotNamespace,
      adminId,
      snapshotKey
    );

  const renderHasSummary =
    hasSnapshotValue(
      renderSnapshot,
      "summary"
    );

  const renderHasActivities =
    hasSnapshotValue(
      renderSnapshot,
      "recentActivities"
    );

  const summaryMatches =
    summaryState.snapshotKey === stateKey;

  const activitiesMatch =
    activityState.snapshotKey === stateKey;

  const summary = summaryMatches
    ? summaryState.data
    : renderHasSummary
      ? renderSnapshot.summary
      : createEmptySummary(range);

  const recentActivities =
    activitiesMatch
      ? activityState.data
      : renderHasActivities
        ? renderSnapshot.recentActivities
        : [];

  const summaryLoading =
    summaryMatches
      ? summaryState.loading
      : Boolean(
          enabled &&
            adminId &&
            !renderHasSummary
        );

  const activityLoading =
    activitiesMatch
      ? activityState.loading
      : Boolean(
          enabled &&
            adminId &&
            !renderHasActivities
        );

  const summaryError =
    summaryMatches
      ? summaryState.error
      : null;

  const activityError =
    activitiesMatch
      ? activityState.error
      : null;

  return {
    ...summary,

    recentActivities,
    range,

    summaryLoading,
    activityLoading,

    loading:
      summaryLoading ||
      activityLoading,

    summaryError,
    activityError,

    refresh,
  };
}
