import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";

const patientAppointmentColumns =
  "id, maternal_appointment_id, patient_id, doctor_id, patient_name, doctor_name, title, description, start_time, end_time, status";

export function usePatientAppointments(patientId, { enabled = true } = {}) {
  const requestIdRef = useRef(0);
  const [loadedPatientId, setLoadedPatientId] = useState("");
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(Boolean(patientId));
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;

    if (!patientId || !enabled) {
      setLoadedPatientId("");
      setAppointments([]);
      setLoading(false);
      setError(null);
      return [];
    }

    setLoading(true);
    setError(null);

    const { data, error: scheduleError } = await supabase
      .from("schedule")
      .select(patientAppointmentColumns)
      .eq("patient_id", patientId)
      .order("start_time", { ascending: true });

    if (requestId !== requestIdRef.current) return [];

    if (scheduleError) {
      setAppointments([]);
      setLoading(false);
      setError(scheduleError);
      setLoadedPatientId(patientId);
      return [];
    }

    const rows = data || [];
    setAppointments(rows);
    setLoadedPatientId(patientId);
    setLoading(false);
    return rows;
  }, [enabled, patientId]);

  useEffect(() => {
    const timer = enabled ? window.setTimeout(refresh, 0) : null;
    const channel = patientId && enabled
      ? supabase
          .channel(`patient-appointments-${patientId}`)
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "schedule",
              filter: `patient_id=eq.${patientId}`,
            },
            refresh
          )
          .subscribe()
      : null;

    return () => {
      requestIdRef.current += 1;
      window.clearTimeout(timer);
      if (channel) supabase.removeChannel(channel);
    };
  }, [enabled, patientId, refresh]);

  const isShowingSelectedPatient = Boolean(patientId && loadedPatientId === patientId);

  return useMemo(
    () => ({
      appointments: isShowingSelectedPatient ? appointments : [],
      loading: Boolean(patientId && enabled) && (loading || !isShowingSelectedPatient),
      error: isShowingSelectedPatient ? error : null,
      refresh,
    }),
    [appointments, enabled, error, isShowingSelectedPatient, loading, patientId, refresh]
  );
}
