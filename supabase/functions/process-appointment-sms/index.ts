import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  appointmentSmsEvents,
  type AppointmentEventRow,
  type AppointmentReminderOccurrence,
  type AppointmentReminderRow,
  type AppointmentSmsEvent,
  type AppointmentSmsPlan,
  type AppointmentSmsRow,
  orchestrateAppointmentSms,
} from "../_shared/appointmentSms.ts";
import {
  authenticateSupabaseSecretRequest,
  SupabaseSecretConfigurationError,
} from "../_shared/supabaseSecretAuth.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_ACCOUNT_ROLES = new Set(["doctor", "staff", "admin"]);
const INACTIVE_ACCOUNT_STATUSES = new Set([
  "inactive",
  "deactivated",
  "disabled",
  "suspended",
  "archived",
  "deleted",
]);
const TRANSPORT_TIMEOUT_MS = 20_000;
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

type JsonObject = Record<string, unknown>;

type AppointmentReminderDispatchRow = {
  id: string;
  schedule_id: string;
  patient_id: string;
  reminder_id: string | null;
  scheduled_for: string;
  reminder_offset_minutes: number | null;
  status: string;
};

type AuthenticatedActor =
  | { kind: "server" }
  | { kind: "user"; userId: string; role: string };

class RequestFailure extends Error {
  status: number;
  publicCode: string;

  constructor(status: number, publicCode: string) {
    super(publicCode);
    this.name = "RequestFailure";
    this.status = status;
    this.publicCode = publicCode;
  }
}

class DatabaseFailure extends Error {
  operation: string;

  constructor(operation: string) {
    super("database_error");
    this.name = "DatabaseFailure";
    this.operation = operation;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getRequiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new RequestFailure(500, "server_configuration_error");
  return value;
}

function getDefaultSupabaseSecretKey(): string {
  const secretKeysJson = Deno.env.get("SUPABASE_SECRET_KEYS")?.trim();

  if (secretKeysJson) {
    try {
      const parsed = JSON.parse(secretKeysJson);
      if (
        isJsonObject(parsed) &&
        typeof parsed.default === "string" &&
        parsed.default.trim().startsWith("sb_secret_")
      ) {
        return parsed.default.trim();
      }
    } catch {
      throw new RequestFailure(500, "server_configuration_error");
    }

    throw new RequestFailure(500, "server_configuration_error");
  }

  const singleSecretKey = Deno.env.get("SUPABASE_SECRET_KEY")?.trim();
  if (singleSecretKey?.startsWith("sb_secret_")) return singleSecretKey;

  throw new RequestFailure(500, "server_configuration_error");
}

function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim() || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function normalizeRole(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

async function authenticateActor(
  request: Request,
  supabaseAdmin: SupabaseClient,
): Promise<AuthenticatedActor> {
  const suppliedApiKey = request.headers.get("apikey")?.trim() || "";
  if (suppliedApiKey.startsWith("sb_secret_")) {
    const matchedSecret = await authenticateSupabaseSecretRequest(
      request,
      (name) => Deno.env.get(name),
    );
    if (!matchedSecret) throw new RequestFailure(401, "unauthorized");
    return { kind: "server" };
  }

  const bearerToken = getBearerToken(request);
  if (!bearerToken) throw new RequestFailure(401, "unauthorized");

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(
    bearerToken,
  );
  if (userError || !userData.user?.id) {
    throw new RequestFailure(401, "unauthorized");
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("id, role, account_status")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (profileError) throw new DatabaseFailure("load_actor_profile");
  const role = normalizeRole(profile?.role);
  const accountStatus = normalizeRole(profile?.account_status || "active");
  if (
    !profile ||
    !ACTIVE_ACCOUNT_ROLES.has(role) ||
    INACTIVE_ACCOUNT_STATUSES.has(accountStatus)
  ) {
    throw new RequestFailure(403, "appointment_sms_forbidden");
  }

  return { kind: "user", userId: userData.user.id, role };
}

function parseRequestBody(payload: unknown): {
  event: AppointmentSmsEvent;
  scheduleId: string;
  appointmentEventId: string | null;
  reminderId: string | null;
  scheduledFor: string | null;
  reminderOffsetMinutes: number | null;
} {
  if (!isJsonObject(payload)) {
    throw new RequestFailure(400, "invalid_request_body");
  }

  const supportedEvents = new Set<unknown>(Object.values(appointmentSmsEvents));
  const event = typeof payload.event === "string" ? payload.event.trim() : "";
  const scheduleId = typeof payload.schedule_id === "string"
    ? payload.schedule_id.trim()
    : "";
  const reminderId = typeof payload.reminder_id === "string"
    ? payload.reminder_id.trim()
    : null;
  const appointmentEventId = typeof payload.appointment_event_id === "string"
    ? payload.appointment_event_id.trim()
    : null;
  const scheduledForValue = typeof payload.scheduled_for === "string"
    ? payload.scheduled_for.trim()
    : "";
  const parsedScheduledFor = scheduledForValue
    ? new Date(scheduledForValue)
    : null;
  const scheduledFor = parsedScheduledFor &&
      !Number.isNaN(parsedScheduledFor.getTime())
    ? parsedScheduledFor.toISOString()
    : null;
  const reminderOffsetMinutes = typeof payload.reminder_offset_minutes ===
      "number" && Number.isInteger(payload.reminder_offset_minutes)
    ? payload.reminder_offset_minutes
    : null;

  if (!supportedEvents.has(event)) {
    throw new RequestFailure(400, "unsupported_appointment_event");
  }
  if (!UUID_PATTERN.test(scheduleId)) {
    throw new RequestFailure(400, "invalid_schedule_id");
  }
  if (
    event === appointmentSmsEvents.rescheduled &&
    !UUID_PATTERN.test(appointmentEventId || "")
  ) {
    throw new RequestFailure(400, "invalid_appointment_event_id");
  }
  if (event === appointmentSmsEvents.reminder) {
    if (!scheduledFor) {
      throw new RequestFailure(400, "invalid_scheduled_for");
    }

    const isConfiguredOccurrence = UUID_PATTERN.test(reminderId || "") &&
      reminderOffsetMinutes === null;
    const isFallbackOccurrence = reminderId === null &&
      (reminderOffsetMinutes === 1440 || reminderOffsetMinutes === 120);
    if (!isConfiguredOccurrence && !isFallbackOccurrence) {
      throw new RequestFailure(400, "invalid_reminder_occurrence");
    }
  }

  return {
    event: event as AppointmentSmsEvent,
    scheduleId,
    appointmentEventId,
    reminderId,
    scheduledFor,
    reminderOffsetMinutes,
  };
}

function authorizeEvent(
  actor: AuthenticatedActor,
  event: AppointmentSmsEvent,
  appointment: AppointmentSmsRow,
): void {
  if (actor.kind === "server") {
    if (event !== appointmentSmsEvents.reminder) {
      throw new RequestFailure(403, "server_event_not_allowed");
    }
    return;
  }

  if (event === appointmentSmsEvents.reminder) {
    throw new RequestFailure(403, "reminder_requires_server_auth");
  }
  if (
    actor.role === "doctor" &&
    appointment.doctor_id !== actor.userId
  ) {
    throw new RequestFailure(403, "appointment_not_assigned_to_doctor");
  }
}

async function claimDispatch(
  supabaseAdmin: SupabaseClient,
  plan: AppointmentSmsPlan,
) {
  const { data, error } = await supabaseAdmin.rpc(
    "claim_notification_dispatch",
    {
      p_dispatch_key: plan.dispatchKey,
      p_patient_id: plan.patientId,
      p_channel: "sms",
      p_notification_type: plan.notificationType,
      p_related_notification_id: null,
      p_related_schedule_id: plan.scheduleId,
      p_related_medication_reminder_id: null,
      p_related_medication_occurrence_id: null,
      p_scheduled_for: plan.scheduledFor,
    },
  );

  if (error) throw new DatabaseFailure("claim_notification_dispatch");
  const claim = Array.isArray(data) ? data[0] : data;
  if (!claim?.dispatch_id) throw new DatabaseFailure("claim_result_missing");
  return claim;
}

async function invokeSmsTransport(
  supabaseUrl: string,
  serviceSecretKey: string,
  request: { dispatchId: string; message: string },
) {
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    TRANSPORT_TIMEOUT_MS,
  );

  try {
    const response = await fetch(
      `${supabaseUrl.replace(/\/$/, "")}/functions/v1/send-notification-sms`,
      {
        method: "POST",
        headers: {
          apikey: serviceSecretKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          dispatch_id: request.dispatchId,
          message: request.message,
        }),
        signal: abortController.signal,
      },
    );

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok || !isJsonObject(payload)) {
      return { ok: false, sent: false, status: "failed" };
    }

    return payload;
  } catch {
    return { ok: false, sent: false, status: "failed" };
  } finally {
    clearTimeout(timeoutId);
  }
}

Deno.serve(async (request: Request): Promise<Response> => {
  const executionId = crypto.randomUUID();

  try {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    }

    const supabaseUrl = getRequiredEnvironment("SUPABASE_URL");
    const serviceSecretKey = getDefaultSupabaseSecretKey();
    const supabaseAdmin = createClient(supabaseUrl, serviceSecretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const actor = await authenticateActor(request, supabaseAdmin);

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      throw new RequestFailure(400, "invalid_json");
    }
    const {
      event,
      scheduleId,
      appointmentEventId,
      reminderId,
      scheduledFor,
      reminderOffsetMinutes,
    } = parseRequestBody(payload);

    const { data: appointmentData, error: appointmentError } = await supabaseAdmin
      .from("schedule")
      .select(
        "id, patient_id, doctor_id, title, description, start_time, end_time, status, created_at, updated_at",
      )
      .eq("id", scheduleId)
      .maybeSingle();

    if (appointmentError) throw new DatabaseFailure("load_appointment");
    if (!appointmentData) throw new RequestFailure(404, "appointment_not_found");
    const appointment = appointmentData as AppointmentSmsRow;
    authorizeEvent(actor, event, appointment);

    let appointmentEvent: AppointmentEventRow | null = null;
    if (event === appointmentSmsEvents.rescheduled && appointmentEventId) {
      const { data: eventData, error: eventError } = await supabaseAdmin
        .from("appointment_events")
        .select(
          "id, schedule_id, patient_id, event_type, previous_start_time, previous_end_time, new_start_time, new_end_time, created_at",
        )
        .eq("id", appointmentEventId)
        .maybeSingle();

      if (eventError) throw new DatabaseFailure("load_appointment_event");
      if (!eventData) throw new RequestFailure(404, "appointment_event_not_found");
      appointmentEvent = eventData as AppointmentEventRow;
    }

    let reminder: AppointmentReminderRow | null = null;
    if (event === appointmentSmsEvents.reminder && reminderId) {
      const { data: reminderData, error: reminderError } = await supabaseAdmin
        .from("reminders")
        .select(
          "id, patient_id, schedule_id, reminder_type, remind_at, next_trigger_at, status",
        )
        .eq("id", reminderId)
        .maybeSingle();

      if (reminderError) throw new DatabaseFailure("load_appointment_reminder");
      if (!reminderData) throw new RequestFailure(404, "appointment_reminder_not_found");
      reminder = reminderData as AppointmentReminderRow;
    }

    let reminderOccurrence: AppointmentReminderOccurrence | null = null;
    if (event === appointmentSmsEvents.reminder && scheduledFor) {
      let occurrenceQuery = supabaseAdmin
        .from("appointment_reminder_dispatches")
        .select(
          "id, schedule_id, patient_id, reminder_id, scheduled_for, reminder_offset_minutes, status",
        )
        .eq("schedule_id", scheduleId)
        .eq("patient_id", appointment.patient_id)
        .eq("scheduled_for", scheduledFor)
        .eq("status", "created");

      occurrenceQuery = reminderId
        ? occurrenceQuery.eq("reminder_id", reminderId)
        : occurrenceQuery
          .is("reminder_id", null)
          .eq("reminder_offset_minutes", reminderOffsetMinutes);

      const { data: occurrenceData, error: occurrenceError } =
        await occurrenceQuery.maybeSingle();
      if (occurrenceError) {
        throw new DatabaseFailure("load_appointment_reminder_occurrence");
      }
      if (!occurrenceData) {
        throw new RequestFailure(
          409,
          "appointment_reminder_occurrence_not_claimed",
        );
      }

      const occurrence = occurrenceData as AppointmentReminderDispatchRow;
      reminderOccurrence = {
        source: reminderId ? "configured" : "fallback",
        scheduled_for: occurrence.scheduled_for,
        reminder_id: occurrence.reminder_id,
        reminder_offset_minutes: occurrence.reminder_offset_minutes,
      };
    }

    const result = await orchestrateAppointmentSms(
      {
        event,
        appointment,
        appointmentEvent,
        reminder,
        reminderOccurrence,
      },
      {
        claimDispatch: (plan) => claimDispatch(supabaseAdmin, plan),
        invokeTransport: (transportRequest) =>
          invokeSmsTransport(supabaseUrl, serviceSecretKey, transportRequest),
      },
    );

    return jsonResponse(result, result.ok ? 200 : 502);
  } catch (error) {
    if (
      error instanceof RequestFailure ||
      error instanceof SupabaseSecretConfigurationError
    ) {
      return jsonResponse(
        {
          ok: false,
          error: error instanceof RequestFailure
            ? error.publicCode
            : "server_configuration_error",
        },
        error instanceof RequestFailure ? error.status : 500,
      );
    }

    if (error instanceof DatabaseFailure) {
      console.error("Appointment SMS database operation failed", {
        executionId,
        operation: error.operation,
      });
    } else {
      console.error("Appointment SMS orchestration failed", {
        executionId,
        error: "internal_error",
      });
    }

    return jsonResponse(
      { ok: false, error: "internal_error", executionId },
      500,
    );
  }
});
