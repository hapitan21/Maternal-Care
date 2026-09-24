import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  maskPhoneNumber,
  normalizePhilippinePhoneNumber,
  parseSemaphoreResponse,
  type ParsedSemaphoreResponse,
  SEMAPHORE_MESSAGES_ENDPOINT,
  SemaphoreResponseError,
} from "../_shared/semaphoreSms.ts";
import {
  buildSmsDispatchFailureUpdate,
  buildSmsDispatchSuccessUpdate,
  executeWithSmsTransportReservation,
  mayContactSemaphore,
  reserveSmsTransport,
  type SmsDispatchRow,
  SmsTransportReservationError,
} from "../_shared/smsTransportReservation.ts";
import {
  executeWithSupabaseSecretAuthentication,
  SupabaseSecretConfigurationError,
} from "../_shared/supabaseSecretAuth.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_PROVIDER_RESPONSE_LENGTH = 100_000;
const PROVIDER_TIMEOUT_MS = 12_000;
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

type JsonObject = Record<string, unknown>;

type PatientPhoneRow = {
  id: string;
  contact_number: string | null;
};

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
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getRequiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new RequestFailure(500, "server_configuration_error");
  return value;
}

function getOptionalSenderName(): string | null {
  const senderName = Deno.env.get("SEMAPHORE_SENDER_NAME")?.trim() || "";
  if (!senderName) return null;

  if (!/^[a-z0-9]{1,11}$/i.test(senderName)) {
    throw new RequestFailure(500, "invalid_sender_configuration");
  }

  return senderName;
}

function getDispatchRequest(payload: unknown): {
  dispatchId: string;
  messageValue: unknown;
} {
  if (!isJsonObject(payload)) {
    throw new RequestFailure(400, "invalid_request_body");
  }

  const dispatchId = typeof payload.dispatch_id === "string"
    ? payload.dispatch_id.trim()
    : "";

  if (!dispatchId) throw new RequestFailure(400, "missing_dispatch_id");
  if (!UUID_PATTERN.test(dispatchId)) {
    throw new RequestFailure(400, "invalid_dispatch_id");
  }

  return { dispatchId, messageValue: payload.message };
}

function getValidatedMessage(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RequestFailure(400, "empty_message");
  }

  const message = value.trim();
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new RequestFailure(400, "message_too_long");
  }

  return message;
}

async function markDispatchFailed(
  supabase: SupabaseClient,
  dispatchId: string,
  safeError: string,
): Promise<void> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("notification_dispatches")
    .update(buildSmsDispatchFailureUpdate(safeError, now))
    .eq("id", dispatchId)
    .eq("channel", "sms")
    .eq("status", "processing")
    .eq("provider", "semaphore")
    .select("id")
    .maybeSingle();

  if (error) throw new DatabaseFailure("record_dispatch_failure");
  if (!data) throw new DatabaseFailure("dispatch_state_changed");
}

async function markDispatchSent(
  supabase: SupabaseClient,
  dispatchId: string,
  providerMessageId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("notification_dispatches")
    .update(buildSmsDispatchSuccessUpdate(providerMessageId, now))
    .eq("id", dispatchId)
    .eq("channel", "sms")
    .eq("status", "processing")
    .eq("provider", "semaphore")
    .select("id")
    .maybeSingle();

  if (error) throw new DatabaseFailure("record_dispatch_success");
  if (!data) throw new DatabaseFailure("dispatch_state_changed");
}

async function reserveDispatchTransport(
  supabase: SupabaseClient,
  dispatchId: string,
) {
  try {
    return await reserveSmsTransport(
      {
        tryReserve: async (id, updatedAt) => {
          const { data, error } = await supabase
            .from("notification_dispatches")
            .update({ provider: "semaphore", updated_at: updatedAt })
            .eq("id", id)
            .eq("channel", "sms")
            .eq("status", "processing")
            .is("provider", null)
            .select("id, patient_id, channel, status, provider")
            .maybeSingle();

          return { data: data as SmsDispatchRow | null, error };
        },
        load: async (id) => {
          const { data, error } = await supabase
            .from("notification_dispatches")
            .select("id, patient_id, channel, status, provider")
            .eq("id", id)
            .maybeSingle();

          return { data: data as SmsDispatchRow | null, error };
        },
      },
      dispatchId,
    );
  } catch (error) {
    if (error instanceof SmsTransportReservationError) {
      throw new DatabaseFailure(error.operation);
    }
    throw error;
  }
}

async function failDispatchResponse(
  supabase: SupabaseClient,
  dispatchId: string,
  safeError: string,
  publicError: string,
  status: number,
): Promise<Response> {
  await markDispatchFailed(supabase, dispatchId, safeError);
  return jsonResponse({ ok: false, sent: false, error: publicError }, status);
}

async function handleAuthenticatedSmsRequest(
  request: Request,
  serviceSecretKey: string,
): Promise<Response> {
  const executionId = crypto.randomUUID();
  let reservedDispatch:
    | { supabase: SupabaseClient; dispatchId: string }
    | null = null;
  let providerAcceptanceConfirmed = false;

  try {
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      throw new RequestFailure(400, "invalid_json");
    }

    const { dispatchId, messageValue } = getDispatchRequest(payload);
    const message = getValidatedMessage(messageValue);
    const supabase = createClient(
      getRequiredEnvironment("SUPABASE_URL"),
      serviceSecretKey,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const { data: dispatchData, error: dispatchError } = await supabase
      .from("notification_dispatches")
      .select("id, patient_id, channel, status, provider")
      .eq("id", dispatchId)
      .maybeSingle();

    if (dispatchError) throw new DatabaseFailure("load_dispatch");
    if (!dispatchData) throw new RequestFailure(404, "dispatch_not_found");

    const loadedDispatch = dispatchData as SmsDispatchRow;
    if (loadedDispatch.channel !== "sms") {
      throw new RequestFailure(409, "dispatch_channel_not_sms");
    }

    if (
      loadedDispatch.status === "sent" || loadedDispatch.status === "delivered"
    ) {
      return jsonResponse({
        ok: true,
        sent: false,
        idempotent: true,
        may_send: false,
        dispatch_id: loadedDispatch.id,
        status: loadedDispatch.status,
      });
    }

    if (loadedDispatch.status !== "processing") {
      return jsonResponse(
        {
          ok: false,
          sent: false,
          may_send: false,
          error: "dispatch_not_sendable",
          dispatch_id: loadedDispatch.id,
          status: loadedDispatch.status,
          retry_eligible: loadedDispatch.status === "failed",
        },
        409,
      );
    }

    const reservation = await reserveDispatchTransport(
      supabase,
      loadedDispatch.id,
    );

    if (!mayContactSemaphore(reservation)) {
      if (reservation.outcome === "not_found") {
        throw new RequestFailure(404, "dispatch_not_found");
      }

      const currentDispatch = reservation.dispatch;
      if (reservation.outcome === "idempotent") {
        return jsonResponse({
          ok: true,
          sent: false,
          idempotent: true,
          may_send: false,
          dispatch_id: currentDispatch.id,
          status: currentDispatch.status,
        });
      }

      if (reservation.outcome === "already_started") {
        return jsonResponse(
          {
            ok: false,
            sent: false,
            may_send: false,
            error: "transport_already_started",
            dispatch_id: currentDispatch.id,
            status: currentDispatch.status,
            provider: "semaphore",
          },
          409,
        );
      }

      return jsonResponse(
        {
          ok: false,
          sent: false,
          may_send: false,
          error: currentDispatch.channel === "sms"
            ? "dispatch_not_sendable"
            : "dispatch_channel_not_sms",
          dispatch_id: currentDispatch.id,
          status: currentDispatch.status,
          retry_eligible: currentDispatch.status === "failed",
        },
        409,
      );
    }

    const dispatch = reservation.dispatch;
    reservedDispatch = { supabase, dispatchId: dispatch.id };

    const { data: patientData, error: patientError } = await supabase
      .from("patients")
      .select("id, contact_number")
      .eq("id", dispatch.patient_id)
      .maybeSingle();

    if (patientError) {
      return await failDispatchResponse(
        supabase,
        dispatch.id,
        "patient_lookup_failed",
        "database_error",
        500,
      );
    }
    if (!patientData) {
      return await failDispatchResponse(
        supabase,
        dispatch.id,
        "patient_not_found",
        "patient_not_found",
        404,
      );
    }

    const patient = patientData as PatientPhoneRow;
    if (!patient.contact_number?.trim()) {
      return await failDispatchResponse(
        supabase,
        dispatch.id,
        "patient_phone_missing",
        "patient_phone_missing",
        422,
      );
    }

    const normalizedPhone = normalizePhilippinePhoneNumber(
      patient.contact_number,
    );
    if (!normalizedPhone) {
      return await failDispatchResponse(
        supabase,
        dispatch.id,
        "patient_phone_invalid",
        "patient_phone_invalid",
        422,
      );
    }

    const semaphoreApiKey = Deno.env.get("SEMAPHORE_API_KEY")?.trim() || "";
    if (!semaphoreApiKey) {
      return await failDispatchResponse(
        supabase,
        dispatch.id,
        "semaphore_api_key_missing",
        "server_configuration_error",
        500,
      );
    }

    let senderName: string | null;
    try {
      senderName = getOptionalSenderName();
    } catch (error) {
      if (error instanceof RequestFailure) {
        return await failDispatchResponse(
          supabase,
          dispatch.id,
          error.publicCode,
          "server_configuration_error",
          error.status,
        );
      }
      throw error;
    }

    const providerParameters = new URLSearchParams({
      apikey: semaphoreApiKey,
      number: normalizedPhone,
      message,
    });
    if (senderName) providerParameters.set("sendername", senderName);

    console.info("Semaphore SMS dispatch started", {
      executionId,
      dispatchId: dispatch.id,
      patientId: dispatch.patient_id,
      phone: maskPhoneNumber(normalizedPhone),
    });

    const abortController = new AbortController();
    const timeoutId = setTimeout(
      () => abortController.abort(),
      PROVIDER_TIMEOUT_MS,
    );

    let providerResponse: Response | null = null;
    try {
      const transportExecution = await executeWithSmsTransportReservation(
        reservation,
        () =>
          fetch(SEMAPHORE_MESSAGES_ENDPOINT, {
            method: "POST",
            headers: {
              "content-type":
                "application/x-www-form-urlencoded;charset=UTF-8",
            },
            body: providerParameters.toString(),
            signal: abortController.signal,
          }),
      );
      if (transportExecution.executed) {
        providerResponse = transportExecution.value;
      }
    } catch {
      const timedOut = abortController.signal.aborted;
      return await failDispatchResponse(
        supabase,
        dispatch.id,
        timedOut ? "semaphore_timeout" : "semaphore_network_error",
        timedOut ? "provider_timeout" : "provider_unavailable",
        502,
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (!providerResponse) {
      return jsonResponse(
        {
          ok: false,
          sent: false,
          may_send: false,
          error: "transport_already_started",
          dispatch_id: dispatch.id,
          status: "processing",
          provider: "semaphore",
        },
        409,
      );
    }

    if (!providerResponse.ok) {
      return await failDispatchResponse(
        supabase,
        dispatch.id,
        `semaphore_http_${providerResponse.status}`,
        "provider_rejected_request",
        502,
      );
    }

    let providerResponseText: string;
    try {
      providerResponseText = await providerResponse.text();
    } catch {
      return await failDispatchResponse(
        supabase,
        dispatch.id,
        "semaphore_response_read_failed",
        "provider_invalid_response",
        502,
      );
    }
    if (
      !providerResponseText ||
      providerResponseText.length > MAX_PROVIDER_RESPONSE_LENGTH
    ) {
      return await failDispatchResponse(
        supabase,
        dispatch.id,
        "semaphore_invalid_response",
        "provider_invalid_response",
        502,
      );
    }

    let providerPayload: unknown;
    try {
      providerPayload = JSON.parse(providerResponseText);
    } catch {
      return await failDispatchResponse(
        supabase,
        dispatch.id,
        "semaphore_invalid_json",
        "provider_invalid_response",
        502,
      );
    }

    let parsedProviderResponse: ParsedSemaphoreResponse;
    try {
      parsedProviderResponse = parseSemaphoreResponse(providerPayload);
    } catch (error) {
      const safeError = error instanceof SemaphoreResponseError
        ? error.publicCode
        : "semaphore_invalid_response";
      return await failDispatchResponse(
        supabase,
        dispatch.id,
        safeError,
        "provider_invalid_response",
        502,
      );
    }

    if (parsedProviderResponse.dispatchStatus === "failed") {
      return await failDispatchResponse(
        supabase,
        dispatch.id,
        `semaphore_status_${parsedProviderResponse.providerStatus}`,
        "provider_rejected_message",
        502,
      );
    }

    // Once Semaphore has accepted the request, a database-write failure leaves
    // the reservation in its uncertain processing state for later reconciliation.
    providerAcceptanceConfirmed = true;
    await markDispatchSent(
      supabase,
      dispatch.id,
      parsedProviderResponse.messageId,
    );

    console.info("Semaphore SMS dispatch accepted", {
      executionId,
      dispatchId: dispatch.id,
      providerStatus: parsedProviderResponse.providerStatus,
    });

    return jsonResponse({
      ok: true,
      sent: true,
      dispatch_id: dispatch.id,
      status: "sent",
      provider: "semaphore",
      provider_message_id: parsedProviderResponse.messageId,
      provider_status: parsedProviderResponse.providerStatus,
    });
  } catch (error) {
    const reservationToFail = reservedDispatch;
    if (
      reservationToFail &&
      !providerAcceptanceConfirmed &&
      !(error instanceof DatabaseFailure)
    ) {
      try {
        await markDispatchFailed(
          reservationToFail.supabase,
          reservationToFail.dispatchId,
          "unexpected_transport_error",
        );
      } catch {
        console.error("Semaphore SMS unexpected failure could not be recorded", {
          executionId,
          dispatchId: reservationToFail.dispatchId,
        });
      }
    }

    if (error instanceof RequestFailure) {
      return jsonResponse(
        { ok: false, sent: false, error: error.publicCode },
        error.status,
      );
    }

    if (error instanceof DatabaseFailure) {
      console.error("Semaphore SMS database operation failed", {
        executionId,
        operation: error.operation,
      });
    } else {
      console.error("Semaphore SMS request failed", {
        executionId,
        error: "internal_error",
      });
    }

    return jsonResponse(
      { ok: false, sent: false, error: "internal_error", executionId },
      500,
    );
  }
}

Deno.serve(async (request: Request): Promise<Response> => {
  try {
    const authentication = await executeWithSupabaseSecretAuthentication(
      request,
      (name) => Deno.env.get(name),
      (secretKey) => handleAuthenticatedSmsRequest(request, secretKey),
    );

    if (!authentication.authenticated) {
      return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    }

    return authentication.value;
  } catch (error) {
    if (error instanceof SupabaseSecretConfigurationError) {
      return jsonResponse(
        { ok: false, error: "server_configuration_error" },
        500,
      );
    }

    console.error("Semaphore SMS authentication failed", {
      error: "internal_error",
    });
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }
});
