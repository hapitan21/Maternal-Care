import { useCallback, useEffect, useRef, useState } from "react";

import {
  appointmentOverviewStatuses,
  formatAppointmentDate,
  formatAppointmentTime,
  getManilaDateKey,
  getManilaTimeKey,
  normalizeAppointmentOverviewStatus,
  toManilaISOString,
} from "../lib/appointmentDate";

import {
  getAdminWorkspaceSnapshot,
  setAdminWorkspaceSnapshot,
} from "../lib/adminWorkspaceSnapshots";

import {
  isUnresolvedOverdueAppointment,
  queryAdminOverdueScheduleRows,
} from "../lib/adminAppointmentOverdue";

import { supabase } from "../lib/supabaseClient";

const appointmentOverviewSnapshotNamespace = "appointment-overview";

const scheduleColumns =
  "id, maternal_appointment_id, patient_id, doctor_id, patient_name, doctor_name, title, start_time, end_time, status";

const patientColumns = "id, full_name, patient_id, control_number";

const doctorProfileColumns = "id, full_name, role";

const doctorProfessionalColumns =
  "auth_user_id, board_certification, clinic_hospital_name";

function cleanText(value) {
  return String(value || "").trim();
}

function lowerText(value) {
  return cleanText(value).toLowerCase();
}

function uniqueValues(values) {
  return Array.from(
    new Set(values.map(cleanText).filter(Boolean))
  );
}

function formatAppointmentType(value) {
  const cleanValue = cleanText(value) || "Appointment";

  if (
    cleanValue !== cleanValue.toLowerCase() &&
    cleanValue !== cleanValue.toUpperCase()
  ) {
    return cleanValue;
  }

  return cleanValue
    .toLowerCase()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function getStatusLabel(status) {
  return (
    {
      [appointmentOverviewStatuses.completed]: "Completed",
      [appointmentOverviewStatuses.upcoming]: "Upcoming",
      [appointmentOverviewStatuses.overdue]: "Overdue",
      [appointmentOverviewStatuses.canceled]: "Canceled",
      [appointmentOverviewStatuses.missed]: "Missed",
    }[status] || "Upcoming"
  );
}

function mapAppointmentRow(
  row,
  patientById,
  doctorById,
  professionalByUserId
) {
  if (!row?.id || !row.start_time) return null;

  const normalizedStatus = normalizeAppointmentOverviewStatus(row.status);

  if (normalizedStatus === appointmentOverviewStatuses.excluded) {
    return null;
  }

  const status = isUnresolvedOverdueAppointment(row)
    ? appointmentOverviewStatuses.overdue
    : normalizedStatus;

  const patient =
    patientById.get(cleanText(row.patient_id)) || null;

  const doctor =
    doctorById.get(cleanText(row.doctor_id)) || null;

  const professional =
    professionalByUserId.get(cleanText(row.doctor_id)) || null;

  const patientName =
    cleanText(patient?.full_name) ||
    cleanText(row.patient_name) ||
    "Patient";

  const patientDisplayId =
    cleanText(patient?.patient_id) || "—";

  const doctorName =
    cleanText(doctor?.full_name) ||
    cleanText(row.doctor_name) ||
    "Unassigned";

  const doctorSpecialization =
    cleanText(professional?.board_certification) ||
    cleanText(professional?.clinic_hospital_name) ||
    "Doctor";

  const appointmentDisplayId = cleanText(
    row.maternal_appointment_id
  );

  const doctorFilterKey =
    cleanText(row.doctor_id) ||
    `name:${lowerText(doctorName)}`;

  return {
    ...row,

    patientName,
    patientDisplayId,

    patientInternalId: cleanText(
      patient?.id || row.patient_id
    ),

    controlNumber: cleanText(
      patient?.control_number
    ),

    doctorName,
    doctorSpecialization,
    doctorFilterKey,
    appointmentDisplayId,

    appointmentType:
      formatAppointmentType(row.title),

    status,
    statusLabel: getStatusLabel(status),

    dateKey:
      getManilaDateKey(row.start_time),

    dateLabel:
      formatAppointmentDate(row.start_time),

    timeKey:
      getManilaTimeKey(row.start_time),

    timeLabel:
      formatAppointmentTime(
        row.start_time,
        { hour: "2-digit" }
      ),

    searchText: [
      patientName,
      patientDisplayId,
      patient?.id,
      row.patient_id,
      patient?.control_number,
      appointmentDisplayId,
      row.id,
      doctorName,
      professional?.board_certification,
    ]
      .map(lowerText)
      .filter(Boolean)
      .join(" "),
  };
}

async function loadRelatedRows(scheduleRows) {
  const patientIds = uniqueValues(
    scheduleRows.map((row) => row.patient_id)
  );

  const doctorIds = uniqueValues(
    scheduleRows.map((row) => row.doctor_id)
  );

  const [
    patientResult,
    doctorResult,
    professionalResult,
  ] = await Promise.all([
    patientIds.length
      ? supabase
          .rpc("get_admin_patient_directory")
          .select(patientColumns)
          .in("id", patientIds)
      : Promise.resolve({
          data: [],
          error: null,
        }),

    doctorIds.length
      ? supabase
          .from("profiles")
          .select(doctorProfileColumns)
          .in("id", doctorIds)
      : Promise.resolve({
          data: [],
          error: null,
        }),

    doctorIds.length
      ? supabase
          .from("doctor_professional_information")
          .select(doctorProfessionalColumns)
          .in("auth_user_id", doctorIds)
      : Promise.resolve({
          data: [],
          error: null,
        }),
  ]);

  const relatedError =
    patientResult.error ||
    doctorResult.error ||
    professionalResult.error;

  if (relatedError) {
    throw relatedError;
  }

  return {
    patientById: new Map(
      (patientResult.data || []).map((row) => [
        cleanText(row.id),
        row,
      ])
    ),

    doctorById: new Map(
      (doctorResult.data || []).map((row) => [
        cleanText(row.id),
        row,
      ])
    ),

    professionalByUserId: new Map(
      (professionalResult.data || []).map((row) => [
        cleanText(row.auth_user_id),
        row,
      ])
    ),
  };
}

function logOverviewError(error) {
  if (!import.meta.env.DEV) return;

  console.error(
    "Admin Appointment Overview load failed:",
    {
      code: error?.code || null,
      message: error?.message || null,
      details: error?.details || null,
      hint: error?.hint || null,
    }
  );
}

export function useAdminAppointmentOverview(
  selectedDateKey,
  enabled = true,
  adminId = "",
  overdueOnly = false
) {
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const pendingRequestRef = useRef(null);

  const snapshotKey = overdueOnly
    ? appointmentOverviewStatuses.overdue
    : selectedDateKey || "no-date";

  const stateKey =
    `${adminId}:${snapshotKey}`;

  const initialSnapshot =
    getAdminWorkspaceSnapshot(
      appointmentOverviewSnapshotNamespace,
      adminId,
      snapshotKey
    );

  const [state, setState] = useState(() => ({
    appointments:
      initialSnapshot?.appointments || [],

    snapshotKey: stateKey,

    loading: Boolean(
      enabled &&
        adminId &&
        !initialSnapshot
    ),

    error: null,
  }));

  const refresh = useCallback(() => {
    if (
      !enabled ||
      !adminId ||
      (!selectedDateKey && !overdueOnly)
    ) {
      setState({
        appointments: [],
        snapshotKey: stateKey,
        loading: false,
        error: null,
      });

      return Promise.resolve({
        ok: true,
        rows: [],
      });
    }

    const requestKey =
      `${adminId}:${snapshotKey}`;

    if (
      pendingRequestRef.current?.key ===
      requestKey
    ) {
      return pendingRequestRef.current.promise;
    }

    const requestId =
      requestIdRef.current + 1;

    requestIdRef.current = requestId;

    const cachedSnapshot =
      getAdminWorkspaceSnapshot(
        appointmentOverviewSnapshotNamespace,
        adminId,
        snapshotKey
      );

    setState({
      appointments:
        cachedSnapshot?.appointments || [],

      snapshotKey: stateKey,

      loading:
        !cachedSnapshot,

      error: null,
    });

    const promise = (async () => {
      try {
        let scheduleRows;
        let scheduleError;

        if (overdueOnly) {
          const overdueResult =
            await queryAdminOverdueScheduleRows();

          scheduleRows = overdueResult.data;
          scheduleError = overdueResult.error;
        } else {
          const startIso =
            toManilaISOString(
              selectedDateKey,
              "00:00"
            );

          const start =
            new Date(startIso);

          if (
            !startIso ||
            Number.isNaN(start.getTime())
          ) {
            throw new Error(
              "The selected appointment date is invalid."
            );
          }

          const endIso =
            new Date(
              start.getTime() +
                24 * 60 * 60 * 1000
            ).toISOString();

          const scheduleResult = await supabase
            .from("schedule")
            .select(scheduleColumns)
            .gte("start_time", startIso)
            .lt("start_time", endIso)
            .order(
              "start_time",
              { ascending: true }
            );

          scheduleRows = scheduleResult.data;
          scheduleError = scheduleResult.error;
        }

        if (scheduleError) {
          throw scheduleError;
        }

        const safeScheduleRows =
          (scheduleRows || []).filter(Boolean);

        const relatedRows =
          await loadRelatedRows(
            safeScheduleRows
          );

        const mappedRows =
          safeScheduleRows
            .map((row) =>
              mapAppointmentRow(
                row,
                relatedRows.patientById,
                relatedRows.doctorById,
                relatedRows.professionalByUserId
              )
            )
            .filter(Boolean)
            .sort(
              (first, second) =>
                new Date(first.start_time) -
                new Date(second.start_time)
            );

        if (
          mountedRef.current &&
          requestIdRef.current === requestId
        ) {
          setAdminWorkspaceSnapshot(
            appointmentOverviewSnapshotNamespace,
            adminId,
            snapshotKey,
            {
              appointments: mappedRows,
            }
          );

          setState({
            appointments: mappedRows,
            snapshotKey: stateKey,
            loading: false,
            error: null,
          });
        }

        return {
          ok: true,
          rows: mappedRows,
        };
      } catch (nextError) {
        logOverviewError(nextError);

        if (
          mountedRef.current &&
          requestIdRef.current === requestId
        ) {
          setState({
            appointments:
              cachedSnapshot?.appointments || [],

            snapshotKey: stateKey,

            loading: false,

            error:
              cachedSnapshot
                ? null
                : nextError,
          });
        }

        return {
          ok: false,
          rows: [],
          error: nextError,
        };
      }
    })();

    pendingRequestRef.current = {
      key: requestKey,
      promise,
    };

    promise.finally(() => {
      if (
        pendingRequestRef.current?.promise ===
        promise
      ) {
        pendingRequestRef.current = null;
      }
    });

    return promise;
  }, [
    adminId,
    enabled,
    selectedDateKey,
    snapshotKey,
    stateKey,
    overdueOnly,
  ]);

  useEffect(() => {
    mountedRef.current = true;

    const timer =
      window.setTimeout(
        refresh,
        0
      );

    const channel =
      enabled && adminId
        ? supabase
            .channel(
              `admin-appointment-overview-${snapshotKey}`
            )
            .on(
              "postgres_changes",
              {
                event: "*",
                schema: "public",
                table: "schedule",
              },
              (payload) => {
                const affectedDates = [
                  payload.new?.start_time,
                  payload.old?.start_time,
                ]
                  .map((value) =>
                    getManilaDateKey(value)
                  )
                  .filter(Boolean);

                if (
                  overdueOnly ||
                  affectedDates.includes(
                    selectedDateKey
                  )
                ) {
                  refresh();
                }
              }
            )
            .subscribe()
        : null;

    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;

      window.clearTimeout(timer);

      if (channel) {
        supabase.removeChannel(channel);
      }
    };
  }, [
    adminId,
    enabled,
    refresh,
    selectedDateKey,
    snapshotKey,
    overdueOnly,
  ]);

  const renderSnapshot =
    getAdminWorkspaceSnapshot(
      appointmentOverviewSnapshotNamespace,
      adminId,
      snapshotKey
    );

  const stateMatches =
    state.snapshotKey === stateKey;

  return {
    appointments:
      stateMatches
        ? state.appointments
        : renderSnapshot?.appointments || [],

    loading:
      stateMatches
        ? state.loading
        : Boolean(
            enabled &&
              adminId &&
              !renderSnapshot
          ),

    error:
      stateMatches
        ? state.error
        : null,

    refresh,
  };
}
