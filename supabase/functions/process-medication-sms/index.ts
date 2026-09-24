import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  type MedicationNotificationRow,
  type MedicationOccurrenceRow,
  type MedicationPatientRow,
  type MedicationReminderRow,
  type MedicationSmsPlan,
  orchestrateMedicationSms,
  parseMedicationSmsRequest,
} from "../_shared/medicationSms.ts";
import {
  executeWithSupabaseSecretAuthentication,
  SupabaseSecretConfigurationError,
} from "../_shared/supabaseSecretAuth.ts";

const TRANSPORT_TIMEOUT_MS = 20_000;
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

type JsonObject = Record<string, unknown>;

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

async function claimDispatch(
  supabaseAdmin: SupabaseClient,
  plan: MedicationSmsPlan,
) {
  const { data, error } = await supabaseAdmin.rpc(
    "claim_notification_dispatch",
    {
      p_dispatch_key: plan.dispatchKey,
      p_patient_id: plan.patientId,
      p_channel: "sms",
      p_notification_type: plan.notificationType,
      p_related_notification_id: plan.relatedNotificationId,
      p_related_schedule_id: null,
      p_related_medication_reminder_id: plan.medicationReminderId,
      p_related_medication_occurrence_id: plan.medicationOccurrenceId,
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

async function handleAuthenticatedMedicationRequest(
  request: Request,
  serviceSecretKey: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    throw new RequestFailure(400, "invalid_json");
  }

  const parsedRequest = parseMedicationSmsRequest(payload);
  if (!parsedRequest.ok) {
    throw new RequestFailure(400, parsedRequest.error);
  }

  const supabaseUrl = getRequiredEnvironment("SUPABASE_URL");
  const supabaseAdmin = createClient(supabaseUrl, serviceSecretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: occurrenceData, error: occurrenceError } = await supabaseAdmin
    .from("medication_reminder_occurrences")
    .select(
      "id, medication_reminder_id, patient_id, scheduled_for, status, notification_id, notified_at, action_at, missed_at",
    )
    .eq("id", parsedRequest.request.medicationOccurrenceId)
    .maybeSingle();

  if (occurrenceError) throw new DatabaseFailure("load_medication_occurrence");
  if (!occurrenceData) {
    throw new RequestFailure(404, "medication_occurrence_not_found");
  }
  const occurrence = occurrenceData as MedicationOccurrenceRow;

  const [reminderResult, patientResult, notificationResult] = await Promise.all([
    supabaseAdmin
      .from("medication_reminders")
      .select("id, patient_id, status, start_date, end_date")
      .eq("id", occurrence.medication_reminder_id)
      .maybeSingle(),
    supabaseAdmin
      .from("patients")
      .select("id, user_id, status, account_status, archived_at")
      .eq("id", occurrence.patient_id)
      .maybeSingle(),
    occurrence.notification_id
      ? supabaseAdmin
        .from("patient_notifications")
        .select("id, patient_id, user_id, type")
        .eq("id", occurrence.notification_id)
        .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (reminderResult.error) {
    throw new DatabaseFailure("load_medication_reminder");
  }
  if (patientResult.error) {
    throw new DatabaseFailure("load_medication_patient");
  }
  if (notificationResult.error) {
    throw new DatabaseFailure("load_medication_notification");
  }

  const result = await orchestrateMedicationSms(
    {
      occurrence,
      reminder: reminderResult.data as MedicationReminderRow | null,
      patient: patientResult.data as MedicationPatientRow | null,
      notification: notificationResult.data as MedicationNotificationRow | null,
    },
    {
      claimDispatch: (plan) => claimDispatch(supabaseAdmin, plan),
      invokeTransport: (transportRequest) =>
        invokeSmsTransport(supabaseUrl, serviceSecretKey, transportRequest),
    },
  );

  return jsonResponse(result, result.ok ? 200 : 502);
}

Deno.serve(async (request: Request): Promise<Response> => {
  const executionId = crypto.randomUUID();

  try {
    const authentication = await executeWithSupabaseSecretAuthentication(
      request,
      (name) => Deno.env.get(name),
      (secretKey) =>
        handleAuthenticatedMedicationRequest(request, secretKey),
    );

    if (!authentication.authenticated) {
      return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    }

    return authentication.value;
  } catch (error) {
    if (
      error instanceof RequestFailure ||
      error instanceof SupabaseSecretConfigurationError
    ) {
      return jsonResponse(
        {
          ok: false,
          sent: false,
          error: error instanceof RequestFailure
            ? error.publicCode
            : "server_configuration_error",
        },
        error instanceof RequestFailure ? error.status : 500,
      );
    }

    if (error instanceof DatabaseFailure) {
      console.error("Medication SMS database operation failed", {
        executionId,
        operation: error.operation,
      });
    } else {
      console.error("Medication SMS orchestration failed", {
        executionId,
        error: "internal_error",
      });
    }

    return jsonResponse(
      { ok: false, sent: false, error: "internal_error", executionId },
      500,
    );
  }
});
