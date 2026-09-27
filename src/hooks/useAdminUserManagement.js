import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearAdminWorkspaceSnapshots,
  getAdminWorkspaceSnapshot,
  setAdminWorkspaceSnapshot,
} from "../lib/adminWorkspaceSnapshots";
import { supabase } from "../lib/supabaseClient";

const PAGE_SIZES = [5, 10, 20];
const userPageSnapshotNamespace = "user-management-page";
const userSummarySnapshotNamespace = "user-management-summary";
const EMPTY_SUMMARY = {
  patients: { total: 0, active: 0, inactive: 0, not_linked: 0 },
  doctors: { total: 0, active: 0, inactive: 0 },
  staff: { total: 0, active: 0, inactive: 0 },
};

function cleanText(value) {
  return String(value ?? "").trim();
}

function normalizeStatus(value) {
  const status = cleanText(value).toLowerCase();
  return status || "unknown";
}

function useDebouncedValue(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);

  return debounced;
}

function mapRow(row, type) {
  const profileAccountStatus = normalizeStatus(row?.account_status);
  const patientRecordAccountStatus = normalizeStatus(
    row?.patient_record_account_status
  );

  // Patients use public.patients.account_status as the canonical access state.
  // Doctor/Staff accounts continue to use public.profiles.account_status.
  const accountStatus =
    type === "patient" && patientRecordAccountStatus !== "unknown"
      ? patientRecordAccountStatus
      : profileAccountStatus;

  return {
    ...row,
    id: row?.id,
    type,
    name: cleanText(row?.full_name) || `Unnamed ${type}`,
    displayId: cleanText(row?.display_id) || cleanText(row?.id).slice(0, 8),
    email: cleanText(row?.email || row?.linked_email),
    contact: cleanText(row?.contact_number),
    accountStatus,
    profileAccountStatus,
    patientRecordAccountStatus,
    linkStatus: normalizeStatus(row?.link_status),
    recordStatus: normalizeStatus(row?.record_status),
    secondaryText: cleanText(row?.secondary_text),
    createdAt: row?.created_at || null,
    archivedAt: row?.archived_at || null,
  };
}

function normalizeRpcPayload(data) {
  if (data && typeof data === "object") return data;
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      return {};
    }
  }
  return {};
}

function getFriendlyError(error, fallback) {
  if (error?.code === "PGRST202") {
    return "The reviewed Admin User Management SQL must be installed before this control is available.";
  }
  return cleanText(error?.message) || fallback;
}

function getDefaultQuery(tab) {
  return {
    search: "",
    status: "all",
    secondary: "all",
    sort: "date",
    page: 1,
    pageSize: PAGE_SIZES[1],
    tab,
  };
}

function getPageSnapshotKey(tab, query) {
  return JSON.stringify([
    tab,
    query.search,
    query.status,
    query.secondary,
    query.sort,
    query.page,
    query.pageSize,
  ]);
}

export function useAdminUserManagement({
  enabled = true,
  activeTab = "patients",
  adminId = "",
} = {}) {
  const pageRequestRef = useRef(0);
  const summaryRequestRef = useRef(0);
  const initialPageSnapshotKey = getPageSnapshotKey(
    activeTab,
    getDefaultQuery(activeTab)
  );
  const initialPageSnapshot = getAdminWorkspaceSnapshot(
    userPageSnapshotNamespace,
    adminId,
    initialPageSnapshotKey
  );
  const initialSummarySnapshot = getAdminWorkspaceSnapshot(
    userSummarySnapshotNamespace,
    adminId,
    "summary"
  );
  const [rows, setRows] = useState(() => ({
    patients: activeTab === "patients" ? initialPageSnapshot?.rows || [] : [],
    doctors: activeTab === "doctors" ? initialPageSnapshot?.rows || [] : [],
    staff: activeTab === "staff" ? initialPageSnapshot?.rows || [] : [],
  }));
  const [totals, setTotals] = useState(() => ({
    patients: activeTab === "patients" ? initialPageSnapshot?.total || 0 : 0,
    doctors: activeTab === "doctors" ? initialPageSnapshot?.total || 0 : 0,
    staff: activeTab === "staff" ? initialPageSnapshot?.total || 0 : 0,
  }));
  const [summary, setSummary] = useState(
    () => initialSummarySnapshot?.summary || EMPTY_SUMMARY
  );
  const [filterOptions, setFilterOptions] = useState(() => ({
    doctors: activeTab === "doctors" ? initialPageSnapshot?.filterOptions || [] : [],
    staff: activeTab === "staff" ? initialPageSnapshot?.filterOptions || [] : [],
  }));
  const [loadedPageKey, setLoadedPageKey] = useState(
    `${adminId}:${initialPageSnapshotKey}`
  );
  const [loadedSummaryAdminId, setLoadedSummaryAdminId] = useState(adminId);
  const [loading, setLoading] = useState(
    () => Boolean(enabled && adminId && !initialPageSnapshot)
  );
  const [summaryLoading, setSummaryLoading] = useState(
    () => Boolean(enabled && adminId && !initialSummarySnapshot)
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  const [search, setSearchState] = useState("");
  const [statusFilter, setStatusFilterState] = useState("all");
  const [sortBy, setSortByState] = useState("date");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(PAGE_SIZES[1]);

  const [doctorSearch, setDoctorSearchState] = useState("");
  const [doctorStatusFilter, setDoctorStatusFilterState] = useState("all");
  const [doctorSpecialtyFilter, setDoctorSpecialtyFilterState] = useState("all");
  const [doctorSortBy, setDoctorSortByState] = useState("date");
  const [doctorPage, setDoctorPage] = useState(1);
  const [doctorPageSize, setDoctorPageSizeState] = useState(PAGE_SIZES[1]);

  const [staffSearch, setStaffSearchState] = useState("");
  const [staffStatusFilter, setStaffStatusFilterState] = useState("all");
  const [staffPositionFilter, setStaffPositionFilterState] = useState("all");
  const [staffSortBy, setStaffSortByState] = useState("date");
  const [staffPage, setStaffPage] = useState(1);
  const [staffPageSize, setStaffPageSizeState] = useState(PAGE_SIZES[1]);

  const debouncedPatientSearch = useDebouncedValue(search);
  const debouncedDoctorSearch = useDebouncedValue(doctorSearch);
  const debouncedStaffSearch = useDebouncedValue(staffSearch);

  const activeQuery = useMemo(() => {
    if (activeTab === "doctors") {
      return {
        search: debouncedDoctorSearch,
        status: doctorStatusFilter,
        secondary: doctorSpecialtyFilter,
        sort: doctorSortBy,
        page: doctorPage,
        pageSize: doctorPageSize,
      };
    }
    if (activeTab === "staff") {
      return {
        search: debouncedStaffSearch,
        status: staffStatusFilter,
        secondary: staffPositionFilter,
        sort: staffSortBy,
        page: staffPage,
        pageSize: staffPageSize,
      };
    }
    return {
      search: debouncedPatientSearch,
      status: statusFilter,
      secondary: "all",
      sort: sortBy,
      page,
      pageSize,
    };
  }, [
    activeTab,
    debouncedDoctorSearch,
    debouncedPatientSearch,
    debouncedStaffSearch,
    doctorPage,
    doctorPageSize,
    doctorSortBy,
    doctorSpecialtyFilter,
    doctorStatusFilter,
    page,
    pageSize,
    sortBy,
    staffPage,
    staffPageSize,
    staffPositionFilter,
    staffSortBy,
    staffStatusFilter,
    statusFilter,
  ]);
  const pageSnapshotKey = getPageSnapshotKey(activeTab, activeQuery);
  const pageStateKey = `${adminId}:${pageSnapshotKey}`;

  const loadSummary = useCallback(async () => {
    if (!enabled || !adminId) {
      setSummaryLoading(false);
      return;
    }
    const requestId = ++summaryRequestRef.current;
    setLoadedSummaryAdminId(adminId);
    const cachedSnapshot = getAdminWorkspaceSnapshot(
      userSummarySnapshotNamespace,
      adminId,
      "summary"
    );
    if (cachedSnapshot) setSummary(cachedSnapshot.summary);
    setSummaryLoading(!cachedSnapshot);
    const { data, error: rpcError } = await supabase.rpc(
      "admin_get_user_management_summary"
    );
    if (requestId !== summaryRequestRef.current) return;
    if (rpcError) {
      if (!cachedSnapshot) {
        setError((current) => current || getFriendlyError(
          rpcError,
          "Unable to load User Management totals."
        ));
      }
      setSummaryLoading(false);
      return;
    }
    const payload = normalizeRpcPayload(data);
    const nextSummary = {
      patients: { ...EMPTY_SUMMARY.patients, ...(payload.patients || {}) },
      doctors: { ...EMPTY_SUMMARY.doctors, ...(payload.doctors || {}) },
      staff: { ...EMPTY_SUMMARY.staff, ...(payload.staff || {}) },
    };
    setSummary(nextSummary);
    setAdminWorkspaceSnapshot(
      userSummarySnapshotNamespace,
      adminId,
      "summary",
      { summary: nextSummary }
    );
    setSummaryLoading(false);
  }, [adminId, enabled]);

  const loadPage = useCallback(async () => {
    if (!enabled || !adminId) {
      setLoading(false);
      return;
    }
    const requestId = ++pageRequestRef.current;
    const cachedSnapshot = getAdminWorkspaceSnapshot(
      userPageSnapshotNamespace,
      adminId,
      pageSnapshotKey
    );
    setLoadedPageKey(pageStateKey);
    if (cachedSnapshot) {
      setRows((current) => ({ ...current, [activeTab]: cachedSnapshot.rows }));
      setTotals((current) => ({ ...current, [activeTab]: cachedSnapshot.total }));
      if (activeTab !== "patients") {
        setFilterOptions((current) => ({
          ...current,
          [activeTab]: cachedSnapshot.filterOptions,
        }));
      }
    } else {
      setRows((current) => ({ ...current, [activeTab]: [] }));
      setTotals((current) => ({ ...current, [activeTab]: 0 }));
      if (activeTab !== "patients") {
        setFilterOptions((current) => ({ ...current, [activeTab]: [] }));
      }
    }
    setLoading(!cachedSnapshot);
    setError("");
    const { data, error: rpcError } = await supabase.rpc(
      "admin_get_user_management_page",
      {
        p_user_type: activeTab,
        p_search: activeQuery.search,
        p_status: activeQuery.status,
        p_secondary_filter: activeQuery.secondary,
        p_sort: activeQuery.sort,
        p_page: activeQuery.page,
        p_page_size: activeQuery.pageSize,
      }
    );
    if (requestId !== pageRequestRef.current) return;
    if (rpcError) {
      if (!cachedSnapshot) {
        setRows((current) => ({ ...current, [activeTab]: [] }));
        setError(getFriendlyError(rpcError, `Unable to load ${activeTab}.`));
      }
      setLoading(false);
      return;
    }

    const payload = normalizeRpcPayload(data);
    const nextRows = Array.isArray(payload.rows)
      ? payload.rows.filter((row) => row?.id).map((row) => mapRow(row, activeTab.slice(0, -1)))
      : [];
    const nextTotal = Number(payload.total) || 0;
    const nextFilterOptions = activeTab !== "patients"
      && Array.isArray(payload.filter_options)
      ? payload.filter_options.filter(Boolean)
      : [];
    setRows((current) => ({ ...current, [activeTab]: nextRows }));
    setTotals((current) => ({ ...current, [activeTab]: nextTotal }));
    if (activeTab !== "patients") {
      setFilterOptions((current) => ({
        ...current,
        [activeTab]: nextFilterOptions,
      }));
    }
    const returnedPage = Number(payload.page) || 1;
    const returnedSnapshotKey = getPageSnapshotKey(activeTab, {
      ...activeQuery,
      page: returnedPage,
    });
    setAdminWorkspaceSnapshot(
      userPageSnapshotNamespace,
      adminId,
      returnedSnapshotKey,
      {
        rows: nextRows,
        total: nextTotal,
        filterOptions: nextFilterOptions,
      }
    );
    if (activeTab === "patients" && returnedPage !== page) setPage(returnedPage);
    if (activeTab === "doctors" && returnedPage !== doctorPage) setDoctorPage(returnedPage);
    if (activeTab === "staff" && returnedPage !== staffPage) setStaffPage(returnedPage);
    setLoading(false);
  }, [activeQuery, activeTab, adminId, doctorPage, enabled, page, pageSnapshotKey, pageStateKey, staffPage]);

  useEffect(() => {
    const timer = window.setTimeout(loadSummary, 0);
    return () => {
      summaryRequestRef.current += 1;
      window.clearTimeout(timer);
    };
  }, [loadSummary]);

  useEffect(() => {
    const timer = window.setTimeout(loadPage, 0);
    return () => {
      pageRequestRef.current += 1;
      window.clearTimeout(timer);
    };
  }, [loadPage]);

  const refresh = useCallback(async () => {
    await Promise.all([loadSummary(), loadPage()]);
  }, [loadPage, loadSummary]);

  const loadDetails = useCallback(async (type, id) => {
    const { data, error: rpcError } = await supabase.rpc(
      "admin_get_user_management_detail",
      { p_user_type: type, p_target_id: id }
    );
    if (rpcError) {
      return {
        ok: false,
        error: getFriendlyError(rpcError, "Unable to load account details."),
      };
    }

    const detail = normalizeRpcPayload(data);

    if (type === "patient") {
      const profileAccountStatus = normalizeStatus(detail?.account_status);
      const patientRecordAccountStatus = normalizeStatus(
        detail?.patient_record_account_status
      );

      return {
        ok: true,
        detail: {
          ...detail,
          profile_account_status: profileAccountStatus,
          account_status:
            patientRecordAccountStatus !== "unknown"
              ? patientRecordAccountStatus
              : profileAccountStatus,
        },
      };
    }

    return { ok: true, detail };
  }, []);

  const updateAccountStatus = useCallback(async (type, account, action) => {
    if (!account?.id || saving) return { ok: false, error: "No account was selected." };
    if (type === "patient" && account.linkStatus !== "linked") {
      return { ok: false, error: "This Patient does not have a linked login account." };
    }

    const rpcName = {
      patient: "admin_set_patient_account_status",
      doctor: "admin_set_doctor_account_status",
      staff: "admin_set_staff_account_status",
    }[type];
    const idArgument = type === "patient" ? "p_patient_id" : "p_profile_id";
    setSaving(true);
    setNotice("");
    const { error: rpcError } = await supabase.rpc(rpcName, {
      [idArgument]: account.id,
      p_action: action,
    });
    if (rpcError) {
      setSaving(false);
      return { ok: false, error: getFriendlyError(rpcError, "Unable to change account access.") };
    }

    clearAdminWorkspaceSnapshots(userSummarySnapshotNamespace, adminId);
    clearAdminWorkspaceSnapshots(userPageSnapshotNamespace, adminId);
    await Promise.all([loadSummary(), loadPage()]);
    const verb = action === "deactivate" ? "deactivated" : action === "activate" ? "activated" : "reactivated";
    setNotice(`${account.name} was ${verb}.`);
    setSaving(false);
    return { ok: true };
  }, [adminId, loadPage, loadSummary, saving]);

  const resetPageForTab = useCallback((tab) => {
    if (tab === "doctors") setDoctorPage(1);
    else if (tab === "staff") setStaffPage(1);
    else setPage(1);
  }, []);

  const bindReset = (setter, reset) => (value) => {
    setter(value);
    reset(1);
  };

  const renderPageSnapshot = getAdminWorkspaceSnapshot(
    userPageSnapshotNamespace,
    adminId,
    pageSnapshotKey
  );
  const pageStateMatches = loadedPageKey === pageStateKey;
  const visibleRows = pageStateMatches
    ? rows[activeTab]
    : renderPageSnapshot?.rows || [];
  const visibleTotal = pageStateMatches
    ? totals[activeTab]
    : renderPageSnapshot?.total || 0;
  const visibleFilterOptions = pageStateMatches
    ? filterOptions[activeTab] || []
    : renderPageSnapshot?.filterOptions || [];
  const visibleLoading = pageStateMatches
    ? loading
    : Boolean(enabled && adminId && !renderPageSnapshot);
  const renderSummarySnapshot = getAdminWorkspaceSnapshot(
    userSummarySnapshotNamespace,
    adminId,
    "summary"
  );
  const summaryStateMatches = loadedSummaryAdminId === adminId;
  const visibleSummary = summaryStateMatches
    ? summary
    : renderSummarySnapshot?.summary || EMPTY_SUMMARY;
  const visibleSummaryLoading = summaryStateMatches
    ? summaryLoading
    : Boolean(enabled && adminId && !renderSummarySnapshot);
  const visibleError = pageStateMatches && summaryStateMatches ? error : "";
  const visiblePatientTotal = activeTab === "patients" ? visibleTotal : totals.patients;
  const visibleDoctorTotal = activeTab === "doctors" ? visibleTotal : totals.doctors;
  const visibleStaffTotal = activeTab === "staff" ? visibleTotal : totals.staff;
  const patientTotalPages = Math.max(1, Math.ceil(visiblePatientTotal / pageSize));
  const doctorTotalPages = Math.max(1, Math.ceil(visibleDoctorTotal / doctorPageSize));
  const staffTotalPages = Math.max(1, Math.ceil(visibleStaffTotal / staffPageSize));

  return {
    patients: activeTab === "patients" ? visibleRows : rows.patients,
    doctors: activeTab === "doctors" ? visibleRows : rows.doctors,
    staff: activeTab === "staff" ? visibleRows : rows.staff,
    summary: visibleSummary,
    summaryLoading: visibleSummaryLoading,
    totals: { ...totals, [activeTab]: visibleTotal },
    loading: visibleLoading,
    error: visibleError,
    notice,
    setNotice,
    saving,
    refresh,
    loadDetails,
    updateAccountStatus,
    resetPageForTab,
    pageSizeOptions: PAGE_SIZES,
    search,
    setSearch: bindReset(setSearchState, setPage),
    statusFilter,
    setStatusFilter: bindReset(setStatusFilterState, setPage),
    sortBy,
    setSortBy: bindReset(setSortByState, setPage),
    page,
    setPage,
    pageSize,
    setPageSize: bindReset(setPageSizeState, setPage),
    totalPages: patientTotalPages,
    totalFilteredPatients: visiblePatientTotal,
    pageStart: visiblePatientTotal
      ? (page - 1) * pageSize
      : 0,
    doctorSearch,
    setDoctorSearch: bindReset(setDoctorSearchState, setDoctorPage),
    doctorStatusFilter,
    setDoctorStatusFilter: bindReset(setDoctorStatusFilterState, setDoctorPage),
    doctorSpecialtyFilter,
    setDoctorSpecialtyFilter: bindReset(setDoctorSpecialtyFilterState, setDoctorPage),
    doctorSortBy,
    setDoctorSortBy: bindReset(setDoctorSortByState, setDoctorPage),
    doctorPage,
    setDoctorPage,
    doctorPageSize,
    setDoctorPageSize: bindReset(setDoctorPageSizeState, setDoctorPage),
    doctorTotalPages,
    totalFilteredDoctors: visibleDoctorTotal,
    doctorPageStart: visibleDoctorTotal
      ? (doctorPage - 1) * doctorPageSize
      : 0,
    doctorSpecialtyOptions: activeTab === "doctors"
      ? visibleFilterOptions
      : filterOptions.doctors,
    staffSearch,
    setStaffSearch: bindReset(setStaffSearchState, setStaffPage),
    staffStatusFilter,
    setStaffStatusFilter: bindReset(setStaffStatusFilterState, setStaffPage),
    staffPositionFilter,
    setStaffPositionFilter: bindReset(setStaffPositionFilterState, setStaffPage),
    staffSortBy,
    setStaffSortBy: bindReset(setStaffSortByState, setStaffPage),
    staffPage,
    setStaffPage,
    staffPageSize,
    setStaffPageSize: bindReset(setStaffPageSizeState, setStaffPage),
    staffTotalPages,
    totalFilteredStaff: visibleStaffTotal,
    staffPageStart: visibleStaffTotal
      ? (staffPage - 1) * staffPageSize
      : 0,
    staffPositionOptions: activeTab === "staff"
      ? visibleFilterOptions
      : filterOptions.staff,
  };
}
