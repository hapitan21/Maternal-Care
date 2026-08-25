import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "@iconify/react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import {
  DOCTOR_NOTIFICATION_LIMIT,
  getDoctorUnreadDisplay,
  getSafeDoctorNotificationTarget,
} from "../../lib/doctorNotifications";
import DoctorNotificationPanel from "./DoctorNotificationPanel";
import "../../styles/doctor-notifications.css";

const panelId = "doctor-notification-panel";

function sortNotifications(rows) {
  return [...(rows || [])].sort((left, right) => {
    const timeDifference =
      new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
    return timeDifference || String(right.id || "").localeCompare(String(left.id || ""));
  });
}

export default function DoctorNotificationBell({ doctorId }) {
  const navigate = useNavigate();
  const wrapperRef = useRef(null);
  const bellRef = useRef(null);
  const panelRef = useRef(null);
  const mountedRef = useRef(true);
  const loadedRef = useRef(false);
  const requestInFlightRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loadedDoctorId, setLoadedDoctorId] = useState("");
  const [loading, setLoading] = useState(Boolean(doctorId));
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!doctorId || requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    if (!loadedRef.current) setLoading(true);

    const { data, error: rpcError } = await supabase.rpc(
      "get_doctor_notifications",
      { p_limit: DOCTOR_NOTIFICATION_LIMIT }
    );

    requestInFlightRef.current = false;
    if (!mountedRef.current) return;

    if (rpcError) {
      setError("Doctor notifications could not be loaded.");
      setLoading(false);
      return;
    }

    const rows = sortNotifications(data || []).slice(0, DOCTOR_NOTIFICATION_LIMIT);
    setNotifications(rows);
    setUnreadCount(Math.max(0, Number(rows[0]?.unread_count) || 0));
    setLoadedDoctorId(doctorId);
    setError("");
    setLoading(false);
    loadedRef.current = true;
  }, [doctorId]);

  useEffect(() => {
    mountedRef.current = true;
    loadedRef.current = false;
    requestInFlightRef.current = false;

    if (!doctorId) return undefined;

    const refreshTimer = window.setTimeout(refresh, 0);
    const pollTimer = window.setInterval(refresh, 60_000);
    const handleFocus = () => refresh();
    const handleOnline = () => refresh();
    const handleOffline = () => {
      setError("You are offline. Previously loaded notifications remain available.");
    };
    const channel = supabase
      .channel(`doctor-notifications:${doctorId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "doctor_notifications",
          filter: `doctor_id=eq.${doctorId}`,
        },
        () => refresh()
      )
      .subscribe((status) => {
        if (!mountedRef.current) return;
        if (status === "SUBSCRIBED") {
          refresh();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setError("Live notification updates are temporarily unavailable.");
        }
      });

    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      mountedRef.current = false;
      requestInFlightRef.current = false;
      window.clearTimeout(refreshTimer);
      window.clearInterval(pollTimer);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      supabase.removeChannel(channel);
    };
  }, [doctorId, refresh]);

  const closePanel = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => bellRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (!open) return undefined;

    const focusTimer = window.setTimeout(() => {
      panelRef.current?.querySelector("button:not([disabled])")?.focus();
    }, 0);
    const handlePointerDown = (event) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        closePanel(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePanel(true);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closePanel, open]);

  const markAsRead = useCallback(async (notificationId) => {
    if (!notificationId || updating) return false;
    setUpdating(true);
    setError("");

    const { data, error: rpcError } = await supabase.rpc(
      "mark_doctor_notification_read",
      { p_notification_id: notificationId }
    );

    if (!mountedRef.current) return false;
    setUpdating(false);
    if (rpcError) {
      setError("The notification could not be marked as read.");
      return false;
    }

    const updated = Array.isArray(data) ? data[0] : data;
    setNotifications((current) =>
      current.map((notification) =>
        notification.id === notificationId
          ? { ...notification, read_at: updated?.read_at || new Date().toISOString() }
          : notification
      )
    );
    setUnreadCount((current) => Math.max(0, current - 1));
    return true;
  }, [updating]);

  const markAllAsRead = useCallback(async () => {
    if (!unreadCount || updating) return;
    setUpdating(true);
    setError("");

    const { error: rpcError } = await supabase.rpc(
      "mark_all_doctor_notifications_read"
    );

    if (!mountedRef.current) return;
    setUpdating(false);
    if (rpcError) {
      setError("Notifications could not be marked as read.");
      return;
    }

    const readAt = new Date().toISOString();
    setNotifications((current) =>
      current.map((notification) =>
        notification.read_at ? notification : { ...notification, read_at: readAt }
      )
    );
    setUnreadCount(0);
    await refresh();
  }, [refresh, unreadCount, updating]);

  const handleSelect = useCallback(async (notification) => {
    if (!notification?.id || updating) return;
    if (!notification.read_at) {
      const marked = await markAsRead(notification.id);
      if (!marked) return;
    }

    setOpen(false);
    navigate(getSafeDoctorNotificationTarget(notification.target_path));
    void refresh();
  }, [markAsRead, navigate, refresh, updating]);

  const badgeLabel = useMemo(
    () => getDoctorUnreadDisplay(loadedDoctorId === doctorId ? unreadCount : 0),
    [doctorId, loadedDoctorId, unreadCount]
  );
  const visibleNotifications =
    loadedDoctorId === doctorId ? notifications : [];
  const visibleUnreadCount = loadedDoctorId === doctorId ? unreadCount : 0;

  return (
    <div
      className={`doctor-notification-center${open ? " is-open" : ""}`}
      ref={wrapperRef}
    >
      <button
        ref={bellRef}
        type="button"
        className="doctor-notification-bell"
        onClick={() => {
          window.dispatchEvent(new CustomEvent("doctor:close-profile-menu"));
          setOpen((current) => !current);
        }}
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        aria-label={`Doctor notifications, ${visibleUnreadCount} unread`}
        title="Doctor notifications"
      >
        <Icon
          icon={visibleUnreadCount ? "solar:bell-bing-bold" : "solar:bell-linear"}
          aria-hidden="true"
        />
        {visibleUnreadCount ? (
          <span className="doctor-notification-badge" aria-hidden="true">
            {badgeLabel}
          </span>
        ) : null}
      </button>

      <span className="doctor-notification-live" role="status" aria-live="polite">
        {loadedDoctorId === doctorId
          ? `${visibleUnreadCount} unread Doctor notifications.`
          : ""}
      </span>

      {open ? (
        <DoctorNotificationPanel
          ref={panelRef}
          id={panelId}
          notifications={visibleNotifications}
          unreadCount={visibleUnreadCount}
          loading={loading}
          updating={updating}
          error={error}
          onRetry={refresh}
          onClose={() => closePanel(true)}
          onMarkAllAsRead={markAllAsRead}
          onSelect={handleSelect}
        />
      ) : null}
    </div>
  );
}
