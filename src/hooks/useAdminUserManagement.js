import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";

const PAGE_SIZES = [5, 10, 20];
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

export function useAdminUserManagement({ enabled = true, activeTab = "patients" } = {}) {
  const pageRequestRef = useRef(0);
  const summaryRequestRef = useRef(0);
  const [rows, setRows] = useState({ patients: [], doctors: [], staff: [] });
  const [totals, setTotals] = useState({ patients: 0, doctors: 0, staff: 0 });
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [filterOptions, setFilterOptions] = useState({ doctors: [], staff: [] });
  const [loading, setLoading] = useState(Boolean(enabled));
  const [summaryLoading, setSummaryLoading] = useState(Boolean(enabled));
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

  const loadSummary = useCallback(async () => {
    if (!enabled) {
      setSummaryLoading(false);
      return;
    }
    const requestId = ++summaryRequestRef.current;
    setSummaryLoading(true);
    const { data, error: rpcError } = await supabase.rpc(
      "admin_get_user_management_summary"
    );
    if (requestId !== summaryRequestRef.current) return;
    if (rpcError) {
      setError((current) => current || getFriendlyError(rpcError, "Unable to load User Management totals."));
      setSummaryLoading(false);
      return;
    }
    const payload = normalizeRpcPayload(data);
    setSummary({
      patients: { ...EMPTY_SUMMARY.patients, ...(payload.patients || {}) },
      doctors: { ...EMPTY_SUMMARY.doctors, ...(payload.doctors || {}) },
      staff: { ...EMPTY_SUMMARY.staff, ...(payload.staff || {}) },
    });
    setSummaryLoading(false);
  }, [enabled]);

  const loadPage = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const requestId = ++pageRequestRef.current;
    setLoading(true);
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
      setRows((current) => ({ ...current, [activeTab]: [] }));
      setError(getFriendlyError(rpcError, `Unable to load ${activeTab}.`));
      setLoading(false);
      return;
    }

    const payload = normalizeRpcPayload(data);
    const nextRows = Array.isArray(payload.rows)
      ? payload.rows.filter((row) => row?.id).map((row) => mapRow(row, activeTab.slice(0, -1)))
      : [];
    setRows((current) => ({ ...current, [activeTab]: nextRows }));
    setTotals((current) => ({ ...current, [activeTab]: Number(payload.total) || 0 }));
    if (activeTab !== "patients") {
      setFilterOptions((current) => ({
        ...current,
        [activeTab]: Array.isArray(payload.filter_options) ? payload.filter_options.filter(Boolean) : [],
      }));
    }
    const returnedPage = Number(payload.page) || 1;
    if (activeTab === "patients" && returnedPage !== page) setPage(returnedPage);
    if (activeTab === "doctors" && returnedPage !== doctorPage) setDoctorPage(returnedPage);
    if (activeTab === "staff" && returnedPage !== staffPage) setStaffPage(returnedPage);
    setLoading(false);
  }, [activeQuery, activeTab, doctorPage, enabled, page, staffPage]);

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

    await Promise.all([loadSummary(), loadPage()]);
    const verb = action === "deactivate" ? "deactivated" : action === "activate" ? "activated" : "reactivated";
    setNotice(`${account.name} was ${verb}.`);
    setSaving(false);
    return { ok: true };
  }, [loadPage, loadSummary, saving]);

  const resetPageForTab = useCallback((tab) => {
    if (tab === "doctors") setDoctorPage(1);
    else if (tab === "staff") setStaffPage(1);
    else setPage(1);
  }, []);

  const bindReset = (setter, reset) => (value) => {
    setter(value);
    reset(1);
  };

  const patientTotalPages = Math.max(1, Math.ceil(totals.patients / pageSize));
  const doctorTotalPages = Math.max(1, Math.ceil(totals.doctors / doctorPageSize));
  const staffTotalPages = Math.max(1, Math.ceil(totals.staff / staffPageSize));

  return {
    patients: rows.patients,
    doctors: rows.doctors,
    staff: rows.staff,
    summary,
    summaryLoading,
    totals,
    loading,
    error,
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
    totalFilteredPatients: totals.patients,
    pageStart: totals.patients ? (page - 1) * pageSize : 0,
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
    totalFilteredDoctors: totals.doctors,
    doctorPageStart: totals.doctors ? (doctorPage - 1) * doctorPageSize : 0,
    doctorSpecialtyOptions: filterOptions.doctors,
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
    totalFilteredStaff: totals.staff,
    staffPageStart: totals.staff ? (staffPage - 1) * staffPageSize : 0,
    staffPositionOptions: filterOptions.staff,
  };
}
