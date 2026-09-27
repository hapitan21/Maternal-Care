import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
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
  "id, actor_user_id, actor_name, actor_role, module, action, status, entity_type, entity_id, description, ip_address, created_at";

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
  if (filters.module !== "all") next = next.eq("module", filters.module);
  if (filters.action !== "all") next = next.eq("action", filters.action);
  return next;
}

function createQueryState(extra = {}) {
  return {
    loading: false,
    error: null,
    migrationRequired: false,
    ...extra,
  };
}

export function useAdminAuditLogs(filters, enabled, adminId = "") {
  const { startIso, endIso, user, module, action, page } = filters;
  const pageRequestIdRef = useRef(0);
  const analyticsRequestIdRef = useRef(0);
  const actorRequestIdRef = useRef(0);
  const pageMissingRef = useRef(false);
  const analyticsMissingRef = useRef(false);
  const actorMissingRef = useRef(false);
  const lastLoggedErrorRef = useRef("");

  const filterKey = useMemo(
    () => [startIso, endIso, user, module, action].join("|"),
    [action, endIso, module, startIso, user]
  );
  const analyticsFilters = useMemo(() => ({ startIso, endIso, user, module, action }), [
    action,
    endIso,
    module,
    startIso,
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
  }));
  const [analyticsState, setAnalyticsState] = useState(() => createQueryState({
    rows: initialAnalyticsSnapshot?.rows || [],
    filterKey: initialAnalyticsSnapshot ? filterKey : "",
    snapshotKey: analyticsStateKey,
    loading: Boolean(enabled && adminId && !initialAnalyticsSnapshot),
  }));
  const [actorState, setActorState] = useState(() => createQueryState({
    rows: initialActorSnapshot?.rows || [],
    snapshotKey: actorStateKey,
    loading: Boolean(enabled && adminId && !initialActorSnapshot),
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
    }));

    const offset = (page - 1) * PAGE_SIZE;
    const query = applyFilters(
      supabase
        .from("audit_logs")
        .select(pageColumns, { count: "exact" })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1),
      analyticsFilters
    );

    try {
      const { data, count, error } = await query;
      if (error) throw error;
      if (pageRequestIdRef.current !== requestId) return;

      pageMissingRef.current = false;
      lastLoggedErrorRef.current = "";
      const nextSnapshot = { rows: data || [], count: count || 0 };
      setAdminWorkspaceSnapshot(
        auditPageSnapshotNamespace,
        adminId,
        pageSnapshotKey,
        nextSnapshot
      );
      setPageState(createQueryState({
        ...nextSnapshot,
        filterKey,
        snapshotKey: pageStateKey,
      }));
    } catch (error) {
      if (pageRequestIdRef.current !== requestId) return;
      const migrationRequired = isMissingAuditInfrastructure(error);
      pageMissingRef.current = migrationRequired;
      logLoadError(error, lastLoggedErrorRef);
      setPageState(cachedSnapshot
        ? createQueryState({
            ...cachedSnapshot,
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
      setAdminWorkspaceSnapshot(
        auditAnalyticsSnapshotNamespace,
        adminId,
        filterKey,
        nextSnapshot
      );
      setAnalyticsState(createQueryState({
        ...nextSnapshot,
        filterKey,
        snapshotKey: analyticsStateKey,
      }));
    } catch (error) {
      if (analyticsRequestIdRef.current !== requestId) return;
      const migrationRequired = isMissingAuditInfrastructure(error);
      analyticsMissingRef.current = migrationRequired;
      logLoadError(error, lastLoggedErrorRef);
      setAnalyticsState(cachedSnapshot
        ? createQueryState({
            ...cachedSnapshot,
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
    }));

    try {
      const { data, error } = await supabase
        .from("audit_logs")
        .select("actor_user_id, actor_name, actor_role")
        .gte("created_at", startIso)
        .lt("created_at", endIso)
        .not("actor_user_id", "is", null)
        .order("actor_name", { ascending: true })
        .limit(ANALYTICS_LIMIT);
      if (error) throw error;
      if (actorRequestIdRef.current !== requestId) return;

      actorMissingRef.current = false;
      lastLoggedErrorRef.current = "";
      const nextSnapshot = { rows: data || [] };
      setAdminWorkspaceSnapshot(
        auditActorsSnapshotNamespace,
        adminId,
        actorSnapshotKey,
        nextSnapshot
      );
      setActorState(createQueryState({
        ...nextSnapshot,
        snapshotKey: actorStateKey,
      }));
    } catch (error) {
      if (actorRequestIdRef.current !== requestId) return;
      const migrationRequired = isMissingAuditInfrastructure(error);
      actorMissingRef.current = migrationRequired;
      logLoadError(error, lastLoggedErrorRef);
      setActorState(cachedSnapshot
        ? createQueryState({
            ...cachedSnapshot,
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

  const refresh = useCallback(() => Promise.all([
    loadPage({ force: true }),
    loadAnalytics({ force: true }),
    loadActors({ force: true }),
  ]), [loadActors, loadAnalytics, loadPage]);

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
      });
  const visibleAnalyticsState = analyticsState.snapshotKey === analyticsStateKey
    ? analyticsState
    : createQueryState({
        rows: renderAnalyticsSnapshot?.rows || [],
        filterKey: renderAnalyticsSnapshot ? filterKey : "",
        snapshotKey: analyticsStateKey,
        loading: Boolean(enabled && adminId && !renderAnalyticsSnapshot),
      });
  const visibleActorState = actorState.snapshotKey === actorStateKey
    ? actorState
    : createQueryState({
        rows: renderActorSnapshot?.rows || [],
        snapshotKey: actorStateKey,
        loading: Boolean(enabled && adminId && !renderActorSnapshot),
      });
  const error = visiblePageState.error
    || visibleAnalyticsState.error
    || visibleActorState.error;
  const migrationRequired = visiblePageState.migrationRequired
    || visibleAnalyticsState.migrationRequired
    || visibleActorState.migrationRequired;
  const analyticsMatchesPage = visiblePageState.filterKey === filterKey
    && visibleAnalyticsState.filterKey === filterKey;

  return {
    rows: visiblePageState.rows,
    analyticsRows: visibleAnalyticsState.rows,
    actorRows: visibleActorState.rows,
    count: visiblePageState.count,
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
