import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearAdminWorkspaceSnapshots,
  getAdminWorkspaceSnapshot,
  setAdminWorkspaceSnapshot,
} from "../lib/adminWorkspaceSnapshots";
import { isMissingAuditInfrastructure } from "../lib/auditLog";
import { supabase } from "../lib/supabaseClient";

const PAGE_SIZE = 10;
const ANALYTICS_LIMIT = 5000;
const auditPageSnapshotNamespace = "audit-logs-page";
const auditAnalyticsSnapshotNamespace = "audit-logs-analytics";
const auditActorsSnapshotNamespace = "audit-logs-actors";
const pageColumns =
  "id, actor_user_id, actor_name, actor_role, module, action, status, entity_type, entity_id, description, ip_address, created_at, request_id, audit_source:metadata->>event_source, previous_status:metadata->>previous_status, new_status:metadata->>new_status";
function clearAuditSnapshots(adminId) {
  for (const namespace of [auditPageSnapshotNamespace, auditAnalyticsSnapshotNamespace, auditActorsSnapshotNamespace]) {
    clearAdminWorkspaceSnapshots(namespace, adminId);
  }
}

function getErrorFingerprint(error) {
  return [error?.code, error?.message, error?.details, error?.hint]
    .map((value) => String(value || ""))
    .join("|");
}

function logLoadError(error, lastLoggedErrorRef) {
  if (!import.meta.env.DEV || !error) return;
  const fingerprint = getErrorFingerprint(error);
  if (lastLoggedErrorRef.current === fingerprint) return;
  lastLoggedErrorRef.current = fingerprint;
  console.error("Admin audit logs query failed:", {
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint,
  });
}

function applyFilters(query, filters) {
  let next = query
    .gte("created_at", filters.startIso)
    .lt("created_at", filters.endIso);

  if (filters.user !== "all") next = next.eq("actor_user_id", filters.user);
  if (filters.role && filters.role !== "all") next = next.eq("actor_role", filters.role);
  if (filters.module !== "all") next = next.eq("module", filters.module);
  if (filters.action !== "all") next = next.eq("action", filters.action);
  if (filters.status && filters.status !== "all") next = next.eq("status", filters.status);
  return next;
}

function createQueryState(extra = {}) {
  return {
    loading: false,
    error: null,
    migrationRequired: false,
    stale: false,
    refreshing: false,
    hasSnapshot: false,
    ...extra,
  };
}

async function queryAuditPage(filters, offset) {
  const rows = [];
  let count = 0;
  let includeOrigin = true;
  // Fill the requested page even if PostgREST caps each response below PAGE_SIZE.
  while (rows.length < PAGE_SIZE) {
    const result = await applyFilters(supabase.from("audit_logs")
      .select(includeOrigin ? `${pageColumns}, event_origin` : pageColumns, { count: "exact" })
      .order("created_at", { ascending: false }).order("id", { ascending: false })
      .range(offset + rows.length, offset + PAGE_SIZE - 1), filters);
    if (result.error) {
      // Production has 15 columns; staging adds event_origin. Retry only this
      // optional-column read, never authorization/network errors or audit writes.
      if (includeOrigin && ["42703", "PGRST204"].includes(result.error.code)
          && /\bevent_origin\b/i.test(result.error.message || "")) {
        includeOrigin = false;
        continue;
      }
      throw result.error;
    }
    if (!Array.isArray(result.data) || !Number.isInteger(result.count) || result.count < 0) {
      throw new Error("The audit page response could not be verified.");
    }
    count = result.count;
    if (!result.data.length) {
      if (offset + rows.length < count) throw new Error("The audit page response was incomplete.");
      break;
    }
    rows.push(...result.data.slice(0, PAGE_SIZE - rows.length));
    if (offset + rows.length >= count) break;
  }
  return { data: rows, count };
}

export function useAdminAuditLogs(filters, enabled, adminId = "") {
  const { startIso, endIso, user, role = "all", module, action, status = "all", page } = filters;
  const pageRequestIdRef = useRef(0);
  const analyticsRequestIdRef = useRef(0);
  const actorRequestIdRef = useRef(0);
  const pageMissingRef = useRef(false);
  const analyticsMissingRef = useRef(false);
  const actorMissingRef = useRef(false);
  const lastLoggedErrorRef = useRef("");
  const refreshInFlightRef = useRef(null);
  const authorizationFailureRef = useRef(null);
  const [authorizationFailure, setAuthorizationFailure] = useState(null);
  const [updatesAvailable, setUpdatesAvailable] = useState(false);
  const [realtimeError, setRealtimeError] = useState("");

  const filterKey = useMemo(
    () => JSON.stringify([startIso, endIso, user, role, module, action, status]),
    [action, endIso, module, role, startIso, status, user]
  );
  const analyticsFilters = useMemo(() => ({ startIso, endIso, user, role, module, action, status }), [
    action,
    endIso,
    module,
    role,
    startIso,
    status,
    user,
  ]);
  const pageSnapshotKey = `${filterKey}|page:${page}`;
  const actorSnapshotKey = `${startIso}|${endIso}`;
  const pageStateKey = `${adminId}:${pageSnapshotKey}`;
  const analyticsStateKey = `${adminId}:${filterKey}`;
  const actorStateKey = `${adminId}:${actorSnapshotKey}`;
  const initialPageSnapshot = getAdminWorkspaceSnapshot(
    auditPageSnapshotNamespace,
    adminId,
    pageSnapshotKey
  );
  const initialAnalyticsSnapshot = getAdminWorkspaceSnapshot(
    auditAnalyticsSnapshotNamespace,
    adminId,
    filterKey
  );
  const initialActorSnapshot = getAdminWorkspaceSnapshot(
    auditActorsSnapshotNamespace,
    adminId,
    actorSnapshotKey
  );

  const [pageState, setPageState] = useState(() => createQueryState({
    rows: initialPageSnapshot?.rows || [],
    count: initialPageSnapshot?.count || 0,
    filterKey: initialPageSnapshot ? filterKey : "",
    snapshotKey: pageStateKey,
    loading: Boolean(enabled && adminId && !initialPageSnapshot),
    stale: Boolean(initialPageSnapshot),
    hasSnapshot: Boolean(initialPageSnapshot),
  }));
  const [analyticsState, setAnalyticsState] = useState(() => createQueryState({
    rows: initialAnalyticsSnapshot?.rows || [],
    filterKey: initialAnalyticsSnapshot ? filterKey : "",
    snapshotKey: analyticsStateKey,
    loading: Boolean(enabled && adminId && !initialAnalyticsSnapshot),
    stale: Boolean(initialAnalyticsSnapshot),
    hasSnapshot: Boolean(initialAnalyticsSnapshot),
  }));
  const [actorState, setActorState] = useState(() => createQueryState({
    rows: initialActorSnapshot?.rows || [],
    snapshotKey: actorStateKey,
    loading: Boolean(enabled && adminId && !initialActorSnapshot),
    stale: Boolean(initialActorSnapshot),
    hasSnapshot: Boolean(initialActorSnapshot),
  }));

  const loadPage = useCallback(async ({ force = false } = {}) => {
    if (!enabled || !adminId || !startIso || !endIso) return;
    if (pageMissingRef.current && !force) {
      setPageState((current) => ({
        ...current,
        filterKey,
        snapshotKey: pageStateKey,
        loading: false,
      }));
      return;
    }

    const requestId = pageRequestIdRef.current + 1;
    pageRequestIdRef.current = requestId;
    const cachedSnapshot = getAdminWorkspaceSnapshot(
      auditPageSnapshotNamespace,
      adminId,
      pageSnapshotKey
    );
    setPageState(createQueryState({
      rows: cachedSnapshot?.rows || [],
      count: cachedSnapshot?.count || 0,
      filterKey: cachedSnapshot ? filterKey : "",
      snapshotKey: pageStateKey,
      loading: !cachedSnapshot,
      refreshing: true,
      stale: Boolean(cachedSnapshot),
      hasSnapshot: Boolean(cachedSnapshot),
    }));

    const offset = (page - 1) * PAGE_SIZE;
    try {
      const { data, count } = await queryAuditPage(analyticsFilters, offset);
      if (pageRequestIdRef.current !== requestId) return;

      pageMissingRef.current = false;
      lastLoggedErrorRef.current = "";
      // Empty RLS results are valid, but must not leave older pages available from cache.
      if (count === 0) clearAuditSnapshots(adminId);
      const nextSnapshot = { rows: data || [], count: count || 0 };
      if (authorizationFailureRef.current?.adminId !== adminId) setAdminWorkspaceSnapshot(
        auditPageSnapshotNamespace,
        adminId,
        pageSnapshotKey,
        nextSnapshot
      );
      setPageState(createQueryState({
        ...nextSnapshot,
        hasSnapshot: true,
        filterKey,
        snapshotKey: pageStateKey,
      }));
      return true;
    } catch (error) {
      if (pageRequestIdRef.current !== requestId) return;
      const migrationRequired = isMissingAuditInfrastructure(error);
      pageMissingRef.current = migrationRequired;
      logLoadError(error, lastLoggedErrorRef);
      if (["42501", "PGRST301", "PGRST302", "PGRST303"].includes(error?.code)) {
        authorizationFailureRef.current = { adminId, error };
        setAuthorizationFailure(authorizationFailureRef.current);
        clearAuditSnapshots(adminId);
      }
      const usableCache = !["42501", "PGRST301", "PGRST302", "PGRST303"].includes(error?.code) && cachedSnapshot;
      setPageState(usableCache
        ? createQueryState({
            ...cachedSnapshot,
            error,
            migrationRequired,
            stale: true,
            hasSnapshot: true,
            filterKey,
            snapshotKey: pageStateKey,
          })
        : createQueryState({
            rows: [],
            count: 0,
            filterKey,
            snapshotKey: pageStateKey,
            error,
            migrationRequired,
          }));
    }
  }, [adminId, analyticsFilters, enabled, endIso, filterKey, page, pageSnapshotKey, pageStateKey, startIso]);

  const loadAnalytics = useCallback(async ({ force = false } = {}) => {
    if (!enabled || !adminId || !startIso || !endIso) return;
    if (analyticsMissingRef.current && !force) {
      setAnalyticsState((current) => ({
        ...current,
        filterKey,
        snapshotKey: analyticsStateKey,
        loading: false,
      }));
      return;
    }

    const requestId = analyticsRequestIdRef.current + 1;
    analyticsRequestIdRef.current = requestId;
    const cachedSnapshot = getAdminWorkspaceSnapshot(
      auditAnalyticsSnapshotNamespace,
      adminId,
      filterKey
    );
    setAnalyticsState(createQueryState({
      rows: cachedSnapshot?.rows || [],
      filterKey: cachedSnapshot ? filterKey : "",
      snapshotKey: analyticsStateKey,
      loading: !cachedSnapshot,
      refreshing: true,
      stale: Boolean(cachedSnapshot),
      hasSnapshot: Boolean(cachedSnapshot),
    }));

    const query = applyFilters(
      supabase
        .from("audit_logs")
        .select("id, actor_user_id, actor_name, actor_role, module, action, status, created_at")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(ANALYTICS_LIMIT),
      analyticsFilters
    );

    try {
      const { data, error } = await query;
      if (error) throw error;
      if (analyticsRequestIdRef.current !== requestId) return;

      analyticsMissingRef.current = false;
      lastLoggedErrorRef.current = "";
      const nextSnapshot = { rows: data || [] };
      if (authorizationFailureRef.current?.adminId !== adminId) setAdminWorkspaceSnapshot(
        auditAnalyticsSnapshotNamespace,
        adminId,
        filterKey,
        nextSnapshot
      );
      setAnalyticsState(createQueryState({
        ...nextSnapshot,
        hasSnapshot: true,
        filterKey,
        snapshotKey: analyticsStateKey,
      }));
      return true;
    } catch (error) {
      if (analyticsRequestIdRef.current !== requestId) return;
      const migrationRequired = isMissingAuditInfrastructure(error);
      analyticsMissingRef.current = migrationRequired;
      logLoadError(error, lastLoggedErrorRef);
      if (["42501", "PGRST301", "PGRST302", "PGRST303"].includes(error?.code)) {
        authorizationFailureRef.current = { adminId, error };
        setAuthorizationFailure(authorizationFailureRef.current);
        clearAuditSnapshots(adminId);
      }
      const usableCache = !["42501", "PGRST301", "PGRST302", "PGRST303"].includes(error?.code) && cachedSnapshot;
      setAnalyticsState(usableCache
        ? createQueryState({
            ...cachedSnapshot,
            error,
            migrationRequired,
            stale: true,
            hasSnapshot: true,
            filterKey,
            snapshotKey: analyticsStateKey,
          })
        : createQueryState({
            rows: [],
            filterKey,
            snapshotKey: analyticsStateKey,
            error,
            migrationRequired,
          }));
    }
  }, [adminId, analyticsFilters, analyticsStateKey, enabled, endIso, filterKey, startIso]);

  const loadActors = useCallback(async ({ force = false } = {}) => {
    if (!enabled || !adminId || !startIso || !endIso) return;
    if (actorMissingRef.current && !force) {
      setActorState((current) => ({
        ...current,
        snapshotKey: actorStateKey,
        loading: false,
      }));
      return;
    }

    const requestId = actorRequestIdRef.current + 1;
    actorRequestIdRef.current = requestId;
    const cachedSnapshot = getAdminWorkspaceSnapshot(
      auditActorsSnapshotNamespace,
      adminId,
      actorSnapshotKey
    );
    setActorState(createQueryState({
      rows: cachedSnapshot?.rows || [],
      snapshotKey: actorStateKey,
      loading: !cachedSnapshot,
      refreshing: true,
      stale: Boolean(cachedSnapshot),
      hasSnapshot: Boolean(cachedSnapshot),
    }));

    try {
      const { data, count, error } = await supabase
        .from("audit_logs")
        .select("actor_user_id, actor_name, actor_role", { count: "exact" })
        .gte("created_at", startIso)
        .lt("created_at", endIso)
        .not("actor_user_id", "is", null)
        .order("actor_name", { ascending: true })
        .limit(ANALYTICS_LIMIT);
      if (error) throw error;
      if (actorRequestIdRef.current !== requestId) return;

      actorMissingRef.current = false;
      lastLoggedErrorRef.current = "";
      const nextSnapshot = { rows: data || [], count: count || 0 };
      if (authorizationFailureRef.current?.adminId !== adminId) setAdminWorkspaceSnapshot(
        auditActorsSnapshotNamespace,
        adminId,
        actorSnapshotKey,
        nextSnapshot
      );
      setActorState(createQueryState({
        ...nextSnapshot,
        hasSnapshot: true,
        snapshotKey: actorStateKey,
      }));
      return true;
    } catch (error) {
      if (actorRequestIdRef.current !== requestId) return;
      const migrationRequired = isMissingAuditInfrastructure(error);
      actorMissingRef.current = migrationRequired;
      logLoadError(error, lastLoggedErrorRef);
      if (["42501", "PGRST301", "PGRST302", "PGRST303"].includes(error?.code)) {
        authorizationFailureRef.current = { adminId, error };
        setAuthorizationFailure(authorizationFailureRef.current);
        clearAuditSnapshots(adminId);
      }
      const usableCache = !["42501", "PGRST301", "PGRST302", "PGRST303"].includes(error?.code) && cachedSnapshot;
      setActorState(usableCache
        ? createQueryState({
            ...cachedSnapshot,
            error,
            migrationRequired,
            stale: true,
            hasSnapshot: true,
            snapshotKey: actorStateKey,
          })
        : createQueryState({
            rows: [],
            snapshotKey: actorStateKey,
            error,
            migrationRequired,
          }));
    }
  }, [actorSnapshotKey, actorStateKey, adminId, enabled, endIso, startIso]);

  useEffect(() => {
    pageMissingRef.current = false;
    analyticsMissingRef.current = false;
    actorMissingRef.current = false;
    lastLoggedErrorRef.current = "";
  }, [adminId]);

  useEffect(() => {
    const timer = window.setTimeout(() => loadPage(), 0);
    return () => {
      window.clearTimeout(timer);
      pageRequestIdRef.current += 1;
    };
  }, [loadPage]);

  useEffect(() => {
    const timer = window.setTimeout(() => loadAnalytics(), 0);
    return () => {
      window.clearTimeout(timer);
      analyticsRequestIdRef.current += 1;
    };
  }, [loadAnalytics]);

  useEffect(() => {
    const timer = window.setTimeout(() => loadActors(), 0);
    return () => {
      window.clearTimeout(timer);
      actorRequestIdRef.current += 1;
    };
  }, [loadActors]);

  const refresh = useCallback(function refreshAudit() {
    setUpdatesAvailable(false);
    const current = refreshInFlightRef.current;
    if (current?.key === pageStateKey) {
      current.pending = true;
      return current.promise;
    }
    const work = { key: pageStateKey, pending: false, promise: null };
    work.promise = Promise.all([loadPage({ force: true }), loadAnalytics({ force: true }), loadActors({ force: true })])
      .then(results => {
        // Only a complete fresh read can clear a prior permission failure.
        if (results.every(Boolean) && authorizationFailureRef.current?.adminId === adminId) {
          authorizationFailureRef.current = null;
          setAuthorizationFailure(null);
        }
      })
      .finally(() => {
        if (refreshInFlightRef.current !== work) return;
        refreshInFlightRef.current = null;
        if (work.pending) void refreshAudit();
      });
    refreshInFlightRef.current = work;
    return work.promise;
  }, [adminId, loadActors, loadAnalytics, loadPage, pageStateKey]);

  useEffect(() => {
    if (!enabled || !adminId) return undefined;
    let active = true;
    let timer;
    const queueRefresh = () => {
      if (!active || document.visibilityState === "hidden") return;
      // Keep an older page still while it is being read. Refresh is explicit there.
      if (page > 1) { setUpdatesAvailable(true); return; }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { if (active) void refresh(); }, 200);
    };
    const channel = supabase.channel("admin:audit-logs", { config: { private: true } })
      .on("broadcast", { event: "audit_log_changed" }, queueRefresh)
      .subscribe(status => {
        if (!active) return;
        if (status === "SUBSCRIBED") { setRealtimeError(""); queueRefresh(); }
        else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
          setRealtimeError("Live audit updates are unavailable. Refresh to check for new activity.");
        }
      });
    window.addEventListener("focus", queueRefresh);
    window.addEventListener("online", queueRefresh);
    document.addEventListener("visibilitychange", queueRefresh);
    return () => {
      active = false;
      window.clearTimeout(timer);
      refreshInFlightRef.current = null;
      window.removeEventListener("focus", queueRefresh);
      window.removeEventListener("online", queueRefresh);
      document.removeEventListener("visibilitychange", queueRefresh);
      void supabase.removeChannel(channel);
    };
  }, [adminId, enabled, page, refresh]);

  const renderPageSnapshot = getAdminWorkspaceSnapshot(
    auditPageSnapshotNamespace,
    adminId,
    pageSnapshotKey
  );
  const renderAnalyticsSnapshot = getAdminWorkspaceSnapshot(
    auditAnalyticsSnapshotNamespace,
    adminId,
    filterKey
  );
  const renderActorSnapshot = getAdminWorkspaceSnapshot(
    auditActorsSnapshotNamespace,
    adminId,
    actorSnapshotKey
  );
  const visiblePageState = pageState.snapshotKey === pageStateKey
    ? pageState
    : createQueryState({
        rows: renderPageSnapshot?.rows || [],
        count: renderPageSnapshot?.count || 0,
        filterKey: renderPageSnapshot ? filterKey : "",
        snapshotKey: pageStateKey,
        loading: Boolean(enabled && adminId && !renderPageSnapshot),
        stale: Boolean(renderPageSnapshot),
        hasSnapshot: Boolean(renderPageSnapshot),
      });
  const visibleAnalyticsState = analyticsState.snapshotKey === analyticsStateKey
    ? analyticsState
    : createQueryState({
        rows: renderAnalyticsSnapshot?.rows || [],
        filterKey: renderAnalyticsSnapshot ? filterKey : "",
        snapshotKey: analyticsStateKey,
        loading: Boolean(enabled && adminId && !renderAnalyticsSnapshot),
        stale: Boolean(renderAnalyticsSnapshot),
        hasSnapshot: Boolean(renderAnalyticsSnapshot),
      });
  const visibleActorState = actorState.snapshotKey === actorStateKey
    ? actorState
    : createQueryState({
        rows: renderActorSnapshot?.rows || [],
        snapshotKey: actorStateKey,
        loading: Boolean(enabled && adminId && !renderActorSnapshot),
        stale: Boolean(renderActorSnapshot),
        hasSnapshot: Boolean(renderActorSnapshot),
      });
  const blockedError = authorizationFailure?.adminId === adminId ? authorizationFailure.error : null;
  const error = blockedError || visiblePageState.error
    || visibleAnalyticsState.error
    || visibleActorState.error;
  const accessDenied = [blockedError, visiblePageState.error, visibleAnalyticsState.error, visibleActorState.error]
    .some(value => ["42501", "PGRST301", "PGRST302", "PGRST303"].includes(value?.code));
  const migrationRequired = visiblePageState.migrationRequired
    || visibleAnalyticsState.migrationRequired
    || visibleActorState.migrationRequired;
  const analyticsMatchesPage = visiblePageState.filterKey === filterKey
    && visibleAnalyticsState.filterKey === filterKey;

  return {
    rows: enabled && !accessDenied ? visiblePageState.rows : [],
    analyticsRows: enabled && !accessDenied ? visibleAnalyticsState.rows : [],
    actorRows: enabled && !accessDenied ? visibleActorState.rows : [],
    count: enabled && !accessDenied ? visiblePageState.count : 0,
    canDisplay: enabled && !accessDenied && visiblePageState.hasSnapshot,
    stale: visiblePageState.stale || visibleAnalyticsState.stale || visibleActorState.stale,
    refreshing: visiblePageState.refreshing || visibleAnalyticsState.refreshing || visibleActorState.refreshing,
    updatesAvailable,
    realtimeError,
    actorTruncated: visibleActorState.count > visibleActorState.rows.length,
    pageLoading: visiblePageState.loading,
    analyticsLoading: visibleAnalyticsState.loading,
    error,
    migrationRequired,
    truncated: analyticsMatchesPage
      && visiblePageState.count > visibleAnalyticsState.rows.length,
    refresh,
    pageSize: PAGE_SIZE,
  };
}
