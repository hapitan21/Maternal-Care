import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isMissingAuditInfrastructure } from "../lib/auditLog";
import { supabase } from "../lib/supabaseClient";

const PAGE_SIZE = 10;
const ANALYTICS_LIMIT = 5000;
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

export function useAdminAuditLogs(filters, enabled) {
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

  const [pageState, setPageState] = useState(() => createQueryState({
    rows: [],
    count: 0,
    filterKey: "",
  }));
  const [analyticsState, setAnalyticsState] = useState(() => createQueryState({
    rows: [],
    filterKey: "",
  }));
  const [actorState, setActorState] = useState(() => createQueryState({ rows: [] }));

  const loadPage = useCallback(async ({ force = false } = {}) => {
    if (!enabled || !startIso || !endIso) return;
    if (pageMissingRef.current && !force) return;

    const requestId = pageRequestIdRef.current + 1;
    pageRequestIdRef.current = requestId;
    setPageState((current) => ({ ...current, loading: true, error: null }));

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
      setPageState(createQueryState({
        rows: data || [],
        count: count || 0,
        filterKey,
      }));
    } catch (error) {
      if (pageRequestIdRef.current !== requestId) return;
      const migrationRequired = isMissingAuditInfrastructure(error);
      pageMissingRef.current = migrationRequired;
      logLoadError(error, lastLoggedErrorRef);
      setPageState(createQueryState({
        rows: [],
        count: 0,
        filterKey,
        error,
        migrationRequired,
      }));
    }
  }, [analyticsFilters, enabled, endIso, filterKey, page, startIso]);

  const loadAnalytics = useCallback(async ({ force = false } = {}) => {
    if (!enabled || !startIso || !endIso) return;
    if (analyticsMissingRef.current && !force) return;

    const requestId = analyticsRequestIdRef.current + 1;
    analyticsRequestIdRef.current = requestId;
    setAnalyticsState((current) => ({ ...current, loading: true, error: null }));

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
      setAnalyticsState(createQueryState({ rows: data || [], filterKey }));
    } catch (error) {
      if (analyticsRequestIdRef.current !== requestId) return;
      const migrationRequired = isMissingAuditInfrastructure(error);
      analyticsMissingRef.current = migrationRequired;
      logLoadError(error, lastLoggedErrorRef);
      setAnalyticsState(createQueryState({
        rows: [],
        filterKey,
        error,
        migrationRequired,
      }));
    }
  }, [analyticsFilters, enabled, endIso, filterKey, startIso]);

  const loadActors = useCallback(async ({ force = false } = {}) => {
    if (!enabled || !startIso || !endIso) return;
    if (actorMissingRef.current && !force) return;

    const requestId = actorRequestIdRef.current + 1;
    actorRequestIdRef.current = requestId;
    setActorState((current) => ({ ...current, loading: true, error: null }));

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
      setActorState(createQueryState({ rows: data || [] }));
    } catch (error) {
      if (actorRequestIdRef.current !== requestId) return;
      const migrationRequired = isMissingAuditInfrastructure(error);
      actorMissingRef.current = migrationRequired;
      logLoadError(error, lastLoggedErrorRef);
      setActorState(createQueryState({
        rows: [],
        error,
        migrationRequired,
      }));
    }
  }, [enabled, endIso, startIso]);

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

  const error = pageState.error || analyticsState.error || actorState.error;
  const migrationRequired = pageState.migrationRequired
    || analyticsState.migrationRequired
    || actorState.migrationRequired;
  const analyticsMatchesPage = pageState.filterKey === filterKey
    && analyticsState.filterKey === filterKey;

  return {
    rows: pageState.rows,
    analyticsRows: analyticsState.rows,
    actorRows: actorState.rows,
    count: pageState.count,
    pageLoading: pageState.loading,
    analyticsLoading: analyticsState.loading,
    error,
    migrationRequired,
    truncated: analyticsMatchesPage && pageState.count > analyticsState.rows.length,
    refresh,
    pageSize: PAGE_SIZE,
  };
}
