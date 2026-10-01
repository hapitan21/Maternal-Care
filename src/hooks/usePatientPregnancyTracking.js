import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { loadPatientProfileSummary } from "../lib/patientProfile";
import {
  getPatientPwaSessionCache,
  setPatientPwaSessionCache,
} from "../lib/patientPwaSessionCache";

const initialState = {
  status: "loading",
  tracking: null,
  error: "",
};
const freshTrackingCacheMs = 30_000;

export function usePatientPregnancyTracking(patientId) {
  const [initialCache] = useState(() =>
    getPatientPwaSessionCache(patientId, "pregnancy-tracking")
  );
  const initialCacheRef = useRef(initialCache);
  const [state, setState] = useState(() => initialCache || initialState);
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback(() => {
    setReloadToken((current) => current + 1);
  }, []);

  useEffect(() => {
    let active = true;
    let channel = null;
    let refreshTimer = null;

    if (!patientId) {
      return undefined;
    }

    const loadPregnancyTracking = async ({
      showLoading = false,
    } = {}) => {
      if (showLoading && active && !initialCacheRef.current) {
        setState(initialState);
      }

      try {
        const summary = await loadPatientProfileSummary(patientId);
        if (!active) return;

        if (summary.patient.id !== patientId) {
          throw new Error("The authenticated patient record could not be verified.");
        }

        const nextState = {
          status: summary.tracking.hasCurrentPregnancy ? "ready" : "empty",
          tracking: summary.tracking,
          error: "",
          cachedAt: Date.now(),
        };
        initialCacheRef.current = nextState;
        setPatientPwaSessionCache(patientId, "pregnancy-tracking", nextState);
        setState(nextState);
      } catch (error) {
        if (!active) return;
        setState({
          status: "error",
          tracking: null,
          error: error?.message || "The pregnancy information could not be loaded.",
        });
      }
    };

    const queueRealtimeRefresh = (payload) => {
      if (!active) return;

      console.log(
        "[Pregnancy Realtime] Change received:",
        payload?.table,
        payload?.eventType
      );

      window.clearTimeout(refreshTimer);

      refreshTimer = window.setTimeout(() => {
        if (active) {
          loadPregnancyTracking();
        }
      }, 120);
    };

    const initialize = async () => {
      /*
       * Make sure Realtime is using the authenticated
       * Patient JWT before joining the channel.
       */
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (!active) return;

      if (sessionError) {
        console.error(
          "[Pregnancy Realtime] Session error:",
          sessionError
        );
      }

      if (session?.access_token) {
        await supabase.realtime.setAuth(
          session.access_token
        );
      }

      if (!active) return;

      /* Keep a fresh shell result visible while reconciling it with the server. */
      const initialCacheAge = Date.now() - Number(initialCacheRef.current?.cachedAt || 0);
      if (!initialCacheRef.current || initialCacheAge >= freshTrackingCacheMs) {
        await loadPregnancyTracking({
          showLoading: true,
        });
      } else {
        await loadPregnancyTracking();
      }

      if (!active) return;

      const channelName =
        `patient-pregnancy-dashboard-${patientId}`;

      channel = supabase
        .channel(channelName)

        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "patients",
            filter: `id=eq.${patientId}`,
          },
          queueRealtimeRefresh
        )

        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "patient_obstetric_history",
            filter: `patient_id=eq.${patientId}`,
          },
          queueRealtimeRefresh
        )

        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "medical_records",
            filter: `patient_id=eq.${patientId}`,
          },
          queueRealtimeRefresh
        )

        .subscribe((status, error) => {
          console.log(
            "[Pregnancy Realtime] Channel status:",
            status
          );

          if (error) {
            console.error(
              "[Pregnancy Realtime] Channel error:",
              error
            );
          }
        });
    };

    initialize();

    return () => {
      active = false;

      window.clearTimeout(refreshTimer);

      if (channel) {
        supabase.removeChannel(channel);
      }
    };
  }, [patientId, reloadToken]);

  return {
    ...(patientId
      ? state
      : {
          status: "empty",
          tracking: null,
          error: "",
        }),
    refresh,
  };
}
