import { useCallback, useEffect, useRef, useState } from "react";
import {
  ADMIN_FOLLOWUP_PAGE_SIZE,
  loadAdminFollowupOversightQueue,
  loadAdminFollowupOversightSummary,
} from "../lib/adminFollowupOversight";

const emptySummary = Object.freeze({
  activeCases: null,
  dueToday: null,
  overdue: null,
  critical: null,
  resolved: null,
  doctorOptions: [],
  generatedAt: null,
});

export function useAdminFollowupOversight({ enabled, filters, page, valid = true }) {
  const mountedRef = useRef(true);
  const summaryRequestIdRef = useRef(0);
  const queueRequestIdRef = useRef(0);
  const summaryLoaderRef = useRef(null);
  const queueLoaderRef = useRef(null);
  const [summaryState, setSummaryState] = useState({
    data: emptySummary,
    loading: Boolean(enabled),
    error: "",
  });
  const [queueState, setQueueState] = useState({
    rows: [],
    totalCount: 0,
    generatedAt: null,
    loading: Boolean(enabled),
    error: "",
  });
  const [refreshing, setRefreshing] = useState(false);
  const { startDate, endDate } = filters;

  const loadSummary = useCallback(async ({ manual = false } = {}) => {
    if (!enabled) {
      setSummaryState({ data: emptySummary, loading: false, error: "" });
      return;
    }
    if (!valid) {
      setSummaryState((current) => ({ ...current, loading: false }));
      return;
    }

    const requestId = summaryRequestIdRef.current + 1;
    summaryRequestIdRef.current = requestId;
    setSummaryState((current) => ({ ...current, loading: !manual, error: "" }));

    try {
      const summary = await loadAdminFollowupOversightSummary({
        resolvedStartDate: startDate,
        resolvedEndDate: endDate,
      });
      if (!mountedRef.current || summaryRequestIdRef.current !== requestId) return;
      setSummaryState({ data: summary, loading: false, error: "" });
    } catch (error) {
      if (!mountedRef.current || summaryRequestIdRef.current !== requestId) return;
      setSummaryState((current) => ({
        ...current,
        loading: false,
        error: error?.message || "Medication follow-up summary could not be loaded.",
      }));
    }
  }, [enabled, endDate, startDate, valid]);

  const loadQueue = useCallback(async ({ manual = false } = {}) => {
    if (!enabled) {
      setQueueState({ rows: [], totalCount: 0, generatedAt: null, loading: false, error: "" });
      return;
    }
    if (!valid) {
      setQueueState((current) => ({ ...current, loading: false }));
      return;
    }

    const requestId = queueRequestIdRef.current + 1;
    queueRequestIdRef.current = requestId;
    setQueueState((current) => ({ ...current, loading: !manual, error: "" }));

    try {
      const queue = await loadAdminFollowupOversightQueue({
        ...filters,
        limit: ADMIN_FOLLOWUP_PAGE_SIZE,
        offset: (page - 1) * ADMIN_FOLLOWUP_PAGE_SIZE,
      });
      if (!mountedRef.current || queueRequestIdRef.current !== requestId) return;
      setQueueState({
        rows: queue.rows,
        totalCount: queue.totalCount,
        generatedAt: queue.generatedAt,
        loading: false,
        error: "",
      });
    } catch (error) {
      if (!mountedRef.current || queueRequestIdRef.current !== requestId) return;
      setQueueState({
        rows: [],
        totalCount: 0,
        generatedAt: null,
        loading: false,
        error: error?.message || "Medication follow-up queue could not be loaded.",
      });
    }
  }, [enabled, filters, page, valid]);

  useEffect(() => {
    summaryLoaderRef.current = loadSummary;
  }, [loadSummary]);

  useEffect(() => {
    queueLoaderRef.current = loadQueue;
  }, [loadQueue]);

  useEffect(() => {
    const timer = window.setTimeout(loadSummary, 0);
    return () => {
      window.clearTimeout(timer);
      summaryRequestIdRef.current += 1;
    };
  }, [loadSummary]);

  useEffect(() => {
    const timer = window.setTimeout(loadQueue, 0);
    return () => {
      window.clearTimeout(timer);
      queueRequestIdRef.current += 1;
    };
  }, [loadQueue]);

  useEffect(() => {
    if (!enabled || !valid) return undefined;
    const refreshCurrentData = () => Promise.all([
      summaryLoaderRef.current?.(),
      queueLoaderRef.current?.(),
    ]);
    const pollingTimer = window.setInterval(refreshCurrentData, 60_000);
    window.addEventListener("focus", refreshCurrentData);
    return () => {
      window.clearInterval(pollingTimer);
      window.removeEventListener("focus", refreshCurrentData);
    };
  }, [enabled, valid]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      summaryRequestIdRef.current += 1;
      queueRequestIdRef.current += 1;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled || !valid) return;
    setRefreshing(true);
    try {
      await Promise.all([
        loadSummary({ manual: true }),
        loadQueue({ manual: true }),
      ]);
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }, [enabled, loadQueue, loadSummary, valid]);

  return {
    summary: summaryState.data,
    rows: queueState.rows,
    totalCount: queueState.totalCount,
    generatedAt: queueState.generatedAt || summaryState.data.generatedAt,
    loading: summaryState.loading || queueState.loading,
    summaryLoading: summaryState.loading,
    queueLoading: queueState.loading,
    refreshing,
    error: queueState.error || summaryState.error,
    refresh,
  };
}
