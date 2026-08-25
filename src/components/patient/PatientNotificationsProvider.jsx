import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { supabase } from "../../lib/supabaseClient";
import { PatientNotificationsContext } from "../../hooks/patientNotificationsContext";

const notificationLimit = 30;
const notificationColumns = `
  id,
  patient_id,
  user_id,
  created_by,
  created_by_role,
  type,
  title,
  message,
  target_path,
  related_appointment_id,
  related_medical_record_id,
  related_reminder_id,
  priority,
  read_at,
  created_at,
  updated_at
`;

function sortNotifications(rows) {
  return [...rows].sort(
    (left, right) =>
      new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
  );
}

function mergeNotification(rows, nextRow) {
  const remainingRows = rows.filter((row) => row.id !== nextRow.id);
  return sortNotifications([nextRow, ...remainingRows]).slice(0, notificationLimit);
}

export default function PatientNotificationsProvider({ patientId, children }) {
  const [notifications, setNotifications] = useState([]);
  const [loadedPatientId, setLoadedPatientId] = useState("");
  const [loading, setLoading] = useState(Boolean(patientId));
  const [error, setError] = useState("");
  const [realtimeError, setRealtimeError] = useState("");
  const [updating, setUpdating] = useState(false);
  const requestSequence = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = requestSequence.current + 1;
    requestSequence.current = requestId;

    if (!patientId) {
      setNotifications([]);
      setLoading(false);
      setError("The authenticated Patient record is unavailable.");
      return;
    }

    setLoading(true);
    setError("");

    const { data, error: queryError } = await supabase
      .from("patient_notifications")
      .select(notificationColumns)
      .eq("patient_id", patientId)
      .order("created_at", { ascending: false })
      .limit(notificationLimit);

    if (requestSequence.current !== requestId) return;

    if (queryError) {
      setNotifications([]);
      setLoadedPatientId(patientId);
      setError(queryError.message || "Unable to load notifications.");
      setLoading(false);
      return;
    }

    setNotifications(sortNotifications(data || []));
    setLoadedPatientId(patientId);
    setLoading(false);
  }, [patientId]);

  useEffect(() => {
    if (!patientId) {
      return undefined;
    }

    let active = true;
    const patientFilter = `patient_id=eq.${patientId}`;
    const channel = supabase
      .channel(`patient-notifications:${patientId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "patient_notifications",
          filter: patientFilter,
        },
        (payload) => {
          if (!active || !payload.new?.id) return;
          setNotifications((current) => mergeNotification(current, payload.new));
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "patient_notifications",
          filter: patientFilter,
        },
        (payload) => {
          if (!active || !payload.new?.id) return;
          setNotifications((current) => mergeNotification(current, payload.new));
        }
      )
      .subscribe((status) => {
        if (!active) return;

        if (status === "SUBSCRIBED") {
          setRealtimeError("");
          refresh();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setRealtimeError(
            "Live notification updates are temporarily unavailable. Refresh to check for new items."
          );
        }
      });

    const refreshTimer = window.setTimeout(() => {
      if (active) refresh();
    }, 0);

    const handleOffline = () => {
      setRealtimeError("You are offline. Previously loaded notifications remain available.");
    };
    const handleOnline = () => {
      setRealtimeError("");
      refresh();
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    return () => {
      active = false;
      requestSequence.current += 1;
      window.clearTimeout(refreshTimer);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      supabase.removeChannel(channel);
    };
  }, [patientId, refresh]);

  const markAsRead = useCallback(async (notificationId) => {
    if (!notificationId) return false;

    setUpdating(true);
    setError("");

    const { data, error: rpcError } = await supabase.rpc(
      "mark_patient_notification_read",
      { p_notification_id: notificationId }
    );

    setUpdating(false);

    if (rpcError) {
      setError(rpcError.message || "Unable to mark the notification as read.");
      return false;
    }

    const updatedRow = Array.isArray(data) ? data[0] : data;
    if (updatedRow?.id) {
      setNotifications((current) => mergeNotification(current, updatedRow));
    } else {
      const readAt = new Date().toISOString();
      setNotifications((current) =>
        current.map((row) =>
          row.id === notificationId ? { ...row, read_at: readAt } : row
        )
      );
    }

    return true;
  }, []);

  const markAllAsRead = useCallback(async () => {
    setUpdating(true);
    setError("");

    const { error: rpcError } = await supabase.rpc(
      "mark_all_patient_notifications_read"
    );

    setUpdating(false);

    if (rpcError) {
      setError(rpcError.message || "Unable to mark all notifications as read.");
      return false;
    }

    const readAt = new Date().toISOString();
    setNotifications((current) =>
      current.map((row) => (row.read_at ? row : { ...row, read_at: readAt }))
    );
    return true;
  }, []);

  const visibleNotifications = useMemo(
    () => (loadedPatientId === patientId ? notifications : []),
    [loadedPatientId, notifications, patientId]
  );

  const unreadCount = useMemo(
    () =>
      visibleNotifications.reduce(
        (count, row) => count + (row.read_at ? 0 : 1),
        0
      ),
    [visibleNotifications]
  );

  const value = useMemo(
    () => ({
      notifications: visibleNotifications,
      unreadCount,
      loading,
      updating,
      error: error || realtimeError,
      refresh,
      markAsRead,
      markAllAsRead,
    }),
    [
      error,
      loading,
      markAllAsRead,
      markAsRead,
      visibleNotifications,
      realtimeError,
      refresh,
      unreadCount,
      updating,
    ]
  );

  return (
    <PatientNotificationsContext.Provider value={value}>
      {children}
    </PatientNotificationsContext.Provider>
  );
}
