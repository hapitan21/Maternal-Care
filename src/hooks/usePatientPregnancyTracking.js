import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { resolvePregnancyTracking } from "../lib/pregnancyTracking";
import {
  isCompletedClinicalVisitRecord,
  normalizeClinicalVisitFormData,
} from "../lib/clinicalVisitData";

const initialState = {
  status: "loading",
  tracking: null,
  error: "",
};

function getFormData(record) {
  return normalizeClinicalVisitFormData(record);
}

function getClinicalGestationalAge(record) {
  const formData = getFormData(record);
  return formData.gestationalAge || "";
}

function getRecordTimestamp(record) {
  const formData = getFormData(record);
  const visitInformation =
    formData.visitInformation || formData.visit_information || {};

  const candidates = [
    formData.visitDate,
    formData.visit_date,
    visitInformation.visitDate,
    visitInformation.visit_date,
    formData.appointmentDate,
    formData.appointment_date,
    record?.uploaded_at,
    record?.created_at,
  ];

  for (const value of candidates) {
    const date = value ? new Date(value) : null;

    if (date && !Number.isNaN(date.getTime())) {
      return date.getTime();
    }
  }

  return 0;
}

function getLatestClinicalGestationalAge(records) {
  const latestRecord = records
    .filter(isCompletedClinicalVisitRecord)
    .sort(
      (first, second) =>
        getRecordTimestamp(second) - getRecordTimestamp(first)
    )[0];

  return latestRecord
    ? getClinicalGestationalAge(latestRecord)
    : "";
}

export function usePatientPregnancyTracking(patientId) {
  const [state, setState] = useState(initialState);
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
      if (showLoading && active) {
        setState(initialState);
      }

      const { data: patient, error: patientError } =
        await supabase
          .rpc("get_patient_own_record")
          .limit(1)
          .maybeSingle();

      if (!active) return;

      if (
        patientError ||
        !patient ||
        patient.id !== patientId
      ) {
        setState({
          status: "error",
          tracking: null,
          error:
            patientError?.message ||
            "The authenticated patient record could not be verified.",
        });

        return;
      }

      const [obstetricResult, medicalRecordsResult] =
        await Promise.all([
          supabase
            .from("patient_obstetric_history")
            .select(
              `
                id,
                patient_id,
                gravida,
                para,
                last_menstrual_period,
                expected_delivery_date,
                updated_at
              `
            )
            .eq("patient_id", patient.id)
            .limit(1)
            .maybeSingle(),

          supabase
            .from("medical_records")
            .select(
              `
                id,
                patient_id,
                form_data,
                uploaded_at,
                created_at
              `
            )
            .eq("patient_id", patient.id)
            .order("uploaded_at", {
              ascending: false,
            }),
        ]);

      if (!active) return;

      const clinicalReadError =
        obstetricResult.error ||
        medicalRecordsResult.error;

      const tracking = resolvePregnancyTracking({
        patient,
        obstetric: obstetricResult.error
          ? {}
          : obstetricResult.data || {},
        clinicalGestationalAge:
          medicalRecordsResult.error
            ? ""
            : getLatestClinicalGestationalAge(
                medicalRecordsResult.data || []
              ),
      });

      if (
        !tracking.hasCurrentPregnancy &&
        clinicalReadError
      ) {
        setState({
          status: "error",
          tracking: null,
          error: clinicalReadError.message,
        });

        return;
      }

      if (!active) return;

      setState({
        status: tracking.hasCurrentPregnancy
          ? "ready"
          : "empty",
        tracking,
        error: "",
      });
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

      /*
       * Initial fetch still happens independently
       * from Realtime.
       */
      await loadPregnancyTracking({
        showLoading: true,
      });

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