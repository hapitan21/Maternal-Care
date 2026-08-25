import { supabase } from "./supabaseClient";
import {
  MEDICATION_ADHERENCE_ACTIVE_FOLLOWUP_STATUSES,
  buildMedicationAdherenceFollowupSnapshot,
} from "./medicationAdherenceFollowups";
import {
  MEDICATION_FOLLOWUP_CONTROL_EVENT_LIMIT,
  MEDICATION_FOLLOWUP_CONTROL_EVENT_TYPES,
  MEDICATION_FOLLOWUP_QUEUE_MAX_CASES,
} from "./medicationFollowupQueue";

const followupColumns = `
  id,
  patient_id,
  assigned_doctor_id,
  status,
  severity_snapshot,
  adherence_rate_snapshot,
  total_outcomes_snapshot,
  taken_count_snapshot,
  skipped_count_snapshot,
  missed_count_snapshot,
  maximum_missed_streak_snapshot,
  analysis_window_start,
  analysis_window_end,
  latest_completed_dose_at,
  last_contacted_at,
  next_follow_up_at,
  resolution_summary,
  resolved_at,
  created_at,
  updated_at,
  assigned_doctor:profiles!medication_adherence_followups_assigned_doctor_id_fkey(
    id,
    full_name
  )
`;

function getFollowupErrorMessage(error) {
  const message = String(error?.message || "").toLowerCase();
  if (message.includes("schema cache") || error?.code === "PGRST202") {
    return "Medication adherence follow-up is not available yet.";
  }
  if (message.includes("authorized") || message.includes("permission")) {
    return "Your account is not authorized to manage this follow-up.";
  }
  if (message.includes("transition")) {
    return "This follow-up status change is not allowed.";
  }
  if (message.includes("resolution summary")) {
    return "A resolution summary is required.";
  }
  if (message.includes("active and linked")) {
    return "This Patient account is not eligible for a follow-up.";
  }
  if (message.includes("assigned follow-up")) {
    return "You can only update medication follow-ups assigned to you.";
  }
  if (message.includes("snooze expiration")) {
    return "Choose a future date and time for the alert snooze.";
  }
  return "The follow-up action could not be saved. Please try again.";
}

function throwSafeFollowupError(error) {
  console.error("Medication adherence follow-up request failed.", {
    code: error?.code || "unknown",
  });
  throw new Error(getFollowupErrorMessage(error));
}

export async function loadActiveMedicationAdherenceFollowups(patientIds) {
  const ids = Array.from(new Set((patientIds || []).filter(Boolean)));
  if (!ids.length) return [];

  const { data, error } = await supabase
    .from("medication_adherence_followups")
    .select(followupColumns)
    .in("patient_id", ids)
    .in("status", MEDICATION_ADHERENCE_ACTIVE_FOLLOWUP_STATUSES)
    .order("created_at", { ascending: false });

  if (error) throwSafeFollowupError(error);
  return data || [];
}

export async function loadPatientMedicationAdherenceFollowups(patientId) {
  if (!patientId) return [];

  const { data, error } = await supabase
    .from("medication_adherence_followups")
    .select(followupColumns)
    .eq("patient_id", patientId)
    .order("created_at", { ascending: false })
    .limit(6);

  if (error) throwSafeFollowupError(error);
  return data || [];
}

export async function loadAssignedMedicationAdherenceFollowupQueue(
  doctorId,
  { limit = MEDICATION_FOLLOWUP_QUEUE_MAX_CASES } = {}
) {
  if (!doctorId) {
    return {
      followups: [],
      patients: [],
      events: [],
      controlEventsLimited: false,
      generatedAt: new Date().toISOString(),
    };
  }

  const boundedLimit = Math.min(
    MEDICATION_FOLLOWUP_QUEUE_MAX_CASES,
    Math.max(
      1,
      Math.floor(Number(limit)) || MEDICATION_FOLLOWUP_QUEUE_MAX_CASES
    )
  );
  const { data, error } = await supabase
    .from("medication_adherence_followups")
    .select(followupColumns)
    .eq("assigned_doctor_id", doctorId)
    .in("status", MEDICATION_ADHERENCE_ACTIVE_FOLLOWUP_STATUSES)
    .order("next_follow_up_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(boundedLimit);

  if (error) throwSafeFollowupError(error);

  const followupsById = new Map();
  (data || []).forEach((followup) => {
    if (followup?.id) followupsById.set(followup.id, followup);
  });
  const followups = Array.from(followupsById.values());
  const patientIds = Array.from(
    new Set(followups.map((followup) => followup.patient_id).filter(Boolean))
  );

  const followupIds = followups.map((followup) => followup.id);
  const [patientResult, eventResult] = await Promise.all([
    patientIds.length
      ? supabase
          .rpc("get_doctor_patient_directory")
          .select("id, patient_id, full_name, status, account_status, archived_at")
          .in("id", patientIds)
      : Promise.resolve({ data: [], error: null }),
    followupIds.length
      ? supabase
          .from("medication_adherence_followup_events")
          .select(`
            id,
            followup_id,
            event_type,
            note,
            next_follow_up_at,
            created_by,
            created_at,
            created_by_profile:profiles!medication_adherence_followup_events_created_by_fkey(
              id,
              full_name
            )
          `)
          .in("followup_id", followupIds)
          .in("event_type", MEDICATION_FOLLOWUP_CONTROL_EVENT_TYPES)
          .order("created_at", { ascending: false })
          .limit(MEDICATION_FOLLOWUP_CONTROL_EVENT_LIMIT)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (patientResult.error) throwSafeFollowupError(patientResult.error);
  if (eventResult.error) throwSafeFollowupError(eventResult.error);

  const patientsById = new Map();
  (patientResult.data || []).forEach((patient) => {
    if (patient?.id) patientsById.set(patient.id, patient);
  });
  const eventsById = new Map();
  (eventResult.data || []).forEach((event) => {
    if (event?.id) eventsById.set(event.id, event);
  });

  return {
    followups,
    patients: Array.from(patientsById.values()),
    events: Array.from(eventsById.values()),
    controlEventsLimited:
      (eventResult.data || []).length >= MEDICATION_FOLLOWUP_CONTROL_EVENT_LIMIT,
    generatedAt: new Date().toISOString(),
  };
}

export async function loadMedicationAdherenceFollowup(followupId) {
  if (!followupId) return null;

  const { data, error } = await supabase
    .from("medication_adherence_followups")
    .select(followupColumns)
    .eq("id", followupId)
    .maybeSingle();

  if (error) throwSafeFollowupError(error);
  return data || null;
}

export async function loadMedicationAdherenceFollowupEvents(followupId) {
  if (!followupId) return [];

  const { data, error } = await supabase
    .from("medication_adherence_followup_events")
    .select(`
      id,
      followup_id,
      event_type,
      from_status,
      to_status,
      contact_method,
      note,
      resolution_summary,
      next_follow_up_at,
      related_notification_id,
      created_by,
      created_at,
      created_by_profile:profiles!medication_adherence_followup_events_created_by_fkey(
        id,
        full_name
      )
    `)
    .eq("followup_id", followupId)
    .order("created_at", { ascending: false });

  if (error) throwSafeFollowupError(error);
  return data || [];
}

export async function startMedicationAdherenceFollowup({
  patientId,
  alert,
  dateRange,
  initialNote,
  nextFollowUpAt,
}) {
  const snapshot = buildMedicationAdherenceFollowupSnapshot(alert, dateRange);
  const { data, error } = await supabase.rpc(
    "start_medication_adherence_followup",
    {
      p_patient_id: patientId,
      p_severity_snapshot: snapshot.severity,
      p_adherence_rate_snapshot: snapshot.adherenceRate,
      p_total_outcomes_snapshot: snapshot.totalCompletedOutcomes,
      p_taken_count_snapshot: snapshot.takenCount,
      p_skipped_count_snapshot: snapshot.skippedCount,
      p_missed_count_snapshot: snapshot.missedCount,
      p_maximum_missed_streak_snapshot: snapshot.maximumMissedStreak,
      p_analysis_window_start: snapshot.analysisWindowStart,
      p_analysis_window_end: snapshot.analysisWindowEnd,
      p_latest_completed_dose_at: snapshot.latestCompletedDoseAt,
      p_initial_note: String(initialNote || "").trim() || null,
      p_next_follow_up_at: nextFollowUpAt,
    }
  );

  if (error) throwSafeFollowupError(error);
  return Array.isArray(data) ? data[0] : data;
}

export async function addMedicationAdherenceFollowupEvent({
  followupId,
  eventType,
  contactMethod = null,
  note = null,
  nextFollowUpAt = null,
  relatedNotificationId = null,
}) {
  const { data, error } = await supabase.rpc(
    "add_medication_adherence_followup_event",
    {
      p_followup_id: followupId,
      p_event_type: eventType,
      p_contact_method: contactMethod,
      p_note: String(note || "").trim() || null,
      p_next_follow_up_at: nextFollowUpAt,
      p_related_notification_id: relatedNotificationId,
    }
  );

  if (error) throwSafeFollowupError(error);
  return Array.isArray(data) ? data[0] : data;
}

export async function addMedicationFollowupAttentionControl({
  followupId,
  eventType,
  note = null,
  snoozedUntil = null,
}) {
  if (!["attention_acknowledged", "attention_snoozed"].includes(eventType)) {
    throw new Error("Select a supported follow-up attention action.");
  }

  const normalizedNote = String(note || "").trim();
  if (normalizedNote.length > 1000) {
    throw new Error("Attention notes must not exceed 1,000 characters.");
  }

  if (eventType === "attention_snoozed") {
    const snoozeTime = new Date(snoozedUntil || "").getTime();
    if (!Number.isFinite(snoozeTime) || snoozeTime <= Date.now()) {
      throw new Error("Choose a future date and time for the alert snooze.");
    }
  }

  return addMedicationAdherenceFollowupEvent({
    followupId,
    eventType,
    note: normalizedNote || null,
    nextFollowUpAt:
      eventType === "attention_snoozed" ? snoozedUntil : null,
  });
}

export async function updateMedicationAdherenceFollowupStatus({
  followupId,
  status,
  contactMethod = null,
  note = null,
  nextFollowUpAt = null,
  resolutionSummary = null,
}) {
  const { data, error } = await supabase.rpc(
    "update_medication_adherence_followup_status",
    {
      p_followup_id: followupId,
      p_status: status,
      p_contact_method: contactMethod,
      p_note: String(note || "").trim() || null,
      p_next_follow_up_at: nextFollowUpAt,
      p_resolution_summary: String(resolutionSummary || "").trim() || null,
    }
  );

  if (error) throwSafeFollowupError(error);
  return Array.isArray(data) ? data[0] : data;
}
