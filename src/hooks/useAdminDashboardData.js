import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { formatAppointmentDate, formatAppointmentTime, getManilaDateKey } from "../lib/appointmentDate";
import {
  adminAppointmentStatusDefinitions,
  mapAdminAuditActivity,
} from "../lib/adminDashboard";

const emptyTotals = {
  totalUsers: 0,
  patients: 0,
  doctors: 0,
  staff: 0,
  admins: 0,
  totalAppointments: 0,
  pendingAppointments: 0,
  activeFollowupAlerts: 0,
  todaysAppointments: 0,
};

function dateFromKey(dateKey) {
  const [year, month, day] = String(dateKey || "").split("-").map(Number);
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
  return new Date(`${dateKey}T00:00:00+08:00`).toLocaleDateString("en-US", {
    timeZone: "Asia/Manila",
    ...options,
  });
}

function getDateRangeConfig(dateRange) {
  const todayKey = getManilaDateKey(new Date());
  const [year, month] = todayKey.split("-");
  const normalized = ["today", "week", "month", "year"].includes(dateRange) ? dateRange : "month";

  if (normalized === "today") {
    return { key: normalized, label: "Today", startKey: todayKey, endKey: addDays(todayKey, 1), endDate: todayKey, trendMode: "daily", trendLabel: "day" };
  }
  if (normalized === "week") {
    const startKey = mondayForDate(todayKey);
    return { key: normalized, label: "This Week", startKey, endKey: addDays(startKey, 7), endDate: addDays(startKey, 6), trendMode: "daily", trendLabel: "day" };
  }
  if (normalized === "year") {
    const startKey = `${year}-01-01`;
    return { key: normalized, label: "This Year", startKey, endKey: `${Number(year) + 1}-01-01`, endDate: `${year}-12-31`, trendMode: "monthly", trendLabel: "month" };
  }

  const startKey = `${year}-${month}-01`;
  const endKey = addMonths(startKey, 1);
  return { key: "month", label: "This Month", startKey, endKey, endDate: addDays(endKey, -1), trendMode: "weekly", trendLabel: "week" };
}

function createRegistrationBuckets(range) {
  const buckets = [];
  if (range.trendMode === "monthly") {
    for (let key = range.startKey; key < range.endKey; key = addMonths(key, 1)) {
      buckets.push({ key: key.slice(0, 7), label: formatDateKey(key, { month: "short" }), value: 0 });
    }
    return buckets;
  }

  if (range.trendMode === "weekly") {
    for (let key = mondayForDate(range.startKey); key < range.endKey; key = addDays(key, 7)) {
      buckets.push({ key, label: formatDateKey(key, { month: "short", day: "numeric" }), value: 0 });
    }
    return buckets;
  }

  for (let key = range.startKey; key < range.endKey; key = addDays(key, 1)) {
    buckets.push({ key, label: formatDateKey(key, { weekday: range.key === "week" ? "short" : undefined, month: "short", day: "numeric" }), value: 0 });
  }
  return buckets;
}

function mergeRegistrationTrend(rows, range) {
  const values = new Map((rows || []).map((row) => [String(row.key), Number(row.value) || 0]));
  return createRegistrationBuckets(range).map((bucket) => ({ ...bucket, value: values.get(bucket.key) || 0 }));
}

function mapAppointmentOverview(rows) {
  const values = new Map((rows || []).map((row) => [String(row.status), Number(row.value) || 0]));
  const total = adminAppointmentStatusDefinitions.reduce((sum, definition) => sum + (values.get(definition.status) || 0), 0);
  return adminAppointmentStatusDefinitions.map((definition) => {
    const value = values.get(definition.status) || 0;
    return { ...definition, value, percent: total ? Math.round((value / total) * 100) : 0 };
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
      pendingAppointments: Number(totals.pending_appointments) || 0,
      activeFollowupAlerts: Number(totals.active_followup_alerts) || 0,
      todaysAppointments: Number(totals.todays_appointments) || 0,
    },
    appointmentOverview: mapAppointmentOverview(payload?.appointment_overview),
    registrationTrend: mergeRegistrationTrend(payload?.registration_trend, range),
    systemAlerts: Array.isArray(payload?.system_alerts) ? payload.system_alerts : [],
    generatedAt: payload?.generated_at || null,
  };
}

function formatActivityTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "Time unavailable";
  return `${formatAppointmentDate(date)} at ${formatAppointmentTime(date)}`;
}

async function querySummary(range) {
  const { data, error } = await supabase.rpc("get_admin_dashboard_summary", {
    p_start_date: range.startKey,
    p_end_date: range.endDate,
    p_trend_mode: range.trendMode,
  });
  return { data, error };
}

async function queryRecentActivity() {
  const { data, error } = await supabase
    .from("audit_logs")
    .select("id, actor_name, actor_role, module, action, description, created_at")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(8);
  return { data, error };
}

export function useAdminDashboardData(dateRange, enabled = true) {
  const requestIdRef = useRef(0);
  const realtimeTimerRef = useRef(null);
  const range = useMemo(() => getDateRangeConfig(dateRange), [dateRange]);
  const [summary, setSummary] = useState(() => ({
    totals: emptyTotals,
    appointmentOverview: mapAppointmentOverview([]),
    registrationTrend: createRegistrationBuckets(range),
    systemAlerts: [],
    generatedAt: null,
  }));
  const [recentActivities, setRecentActivities] = useState([]);
  const [summaryLoading, setSummaryLoading] = useState(Boolean(enabled));
  const [activityLoading, setActivityLoading] = useState(Boolean(enabled));
  const [summaryError, setSummaryError] = useState(null);
  const [activityError, setActivityError] = useState(null);

  const refresh = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (!enabled) {
      setSummaryLoading(false);
      setActivityLoading(false);
      return;
    }

    setSummaryLoading(true);
    setActivityLoading(true);
    setSummaryError(null);
    setActivityError(null);

    const [summaryResult, activityResult] = await Promise.all([
      querySummary(range),
      queryRecentActivity(),
    ]);
    if (requestIdRef.current !== requestId) return;

    if (summaryResult.error) {
      setSummaryError(summaryResult.error);
    } else {
      setSummary(mapSummary(summaryResult.data, range));
    }
    setSummaryLoading(false);

    if (activityResult.error) {
      setActivityError(activityResult.error);
    } else {
      setRecentActivities((activityResult.data || []).map((row) => mapAdminAuditActivity(row, formatActivityTime)));
    }
    setActivityLoading(false);
  }, [enabled, range]);

  useEffect(() => {
    const initialTimer = window.setTimeout(refresh, 0);
    const pollingTimer = enabled ? window.setInterval(refresh, 60_000) : null;
    const handleFocus = () => refresh();
    const scheduleRefresh = () => {
      window.clearTimeout(realtimeTimerRef.current);
      realtimeTimerRef.current = window.setTimeout(refresh, 250);
    };
    const channel = enabled
      ? supabase
          .channel(`admin-dashboard-${range.key}`)
          .on("postgres_changes", { event: "*", schema: "public", table: "schedule" }, scheduleRefresh)
          .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, scheduleRefresh)
          .on("postgres_changes", { event: "*", schema: "public", table: "audit_logs" }, scheduleRefresh)
          .subscribe()
      : null;
    window.addEventListener("focus", handleFocus);

    return () => {
      requestIdRef.current += 1;
      window.clearTimeout(initialTimer);
      window.clearTimeout(realtimeTimerRef.current);
      if (pollingTimer) window.clearInterval(pollingTimer);
      window.removeEventListener("focus", handleFocus);
      if (channel) supabase.removeChannel(channel);
    };
  }, [enabled, range.key, refresh]);

  return {
    ...summary,
    recentActivities,
    range,
    summaryLoading,
    activityLoading,
    loading: summaryLoading || activityLoading,
    summaryError,
    activityError,
    refresh,
  };
}
